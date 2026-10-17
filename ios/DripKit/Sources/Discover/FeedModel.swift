import Foundation
import Observation
import DripModels
import Networking
import Analytics
import Media

/// The vertical feed's state machine, shared by Home (For you), Following,
/// a creator's videos, a category and search results. UI-free and fully
/// unit-tested; the SwiftUI pager only renders it and reports which page
/// committed.
///
/// Behaviour mirrors the web shell (src/components/feed/feed-shell.tsx) so
/// both clients feed the ranker identical signals.
@MainActor
@Observable
public final class FeedModel {
    public enum Source: Sendable, Equatable {
        case feed(FeedSurface, category: String? = nil, seller: String? = nil)
        case search(String)

        var surface: FeedSurface {
            switch self {
            case .feed(let s, _, _): return s
            case .search: return .search
            }
        }
    }

    public enum Phase: Sendable, Equatable {
        case idle, loading, loaded, empty, failed(String)
    }

    /// Fetch the next slice when the committed page is this close to the end
    /// (the web's `items.length - (20 - FEED_PREFETCH_AT)`).
    public static let prefetchDistance = FeedConstants.sliceSize - FeedConstants.prefetchAt

    public let source: Source
    public let sessionId: String
    public private(set) var items: [FeedItem] = []
    public private(set) var phase: Phase = .idle
    public private(set) var activeIndex: Int = 0
    public private(set) var exhausted = false
    public private(set) var isLoadingMore = false
    public private(set) var liked: Set<String> = []
    public private(set) var saved: Set<String> = []
    public private(set) var following: Set<String> = []

    private let api: APIClient
    private let tracker: any EventTracking
    private var cursor: String?
    private var impressed: Set<String> = []
    private var watch: WatchSession?
    private var hasCommitted = false

    public init(source: Source, api: APIClient, tracker: any EventTracking,
                sessionId: String = UUID().uuidString.lowercased()) {
        self.source = source
        self.api = api
        self.tracker = tracker
        // The routes match lowercase uuids only.
        self.sessionId = sessionId.lowercased()
    }

    public var surface: FeedSurface { source.surface }
    public var activeItem: FeedItem? { items.indices.contains(activeIndex) ? items[activeIndex] : nil }

    // MARK: Loading

    public func loadInitial() async {
        guard phase == .idle || phase.isFailed else { return }
        await reload()
    }

    /// Pull-to-refresh / retry: a fresh first page.
    public func reload() async {
        phase = .loading
        cursor = nil
        exhausted = false
        do {
            let page = try await fetch(excluding: [], offset: 0)
            items = page.items
            cursor = page.nextBefore
            exhausted = page.exhausted || (page.items.isEmpty && page.nextBefore == nil)
            activeIndex = 0
            hasCommitted = false
            watch = nil
            phase = items.isEmpty ? .empty : .loaded
            if !items.isEmpty { await commit(index: 0) }
            await hydrateReactions(for: items)
        } catch let error as APIError {
            phase = .failed(error.userMessage)
        } catch {
            phase = .failed("Could not load the feed.")
        }
    }

    /// Opens on items another screen already loaded (a search grid, a
    /// creator's videos), starting at the one tapped. Paging continues from
    /// the server as usual.
    public func seed(items seeded: [FeedItem], startAt index: Int, exhausted seededExhausted: Bool = false) async {
        guard !seeded.isEmpty else { return }
        items = seeded
        exhausted = seededExhausted
        phase = .loaded
        hasCommitted = false
        await commit(index: min(max(0, index), seeded.count - 1))
        await hydrateReactions(for: seeded)
    }

    public func loadMoreIfNeeded() async {
        guard !exhausted, !isLoadingMore, phase == .loaded,
              activeIndex >= items.count - Self.prefetchDistance else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let exclude = Array(items.map(\.videoId).suffix(FeedConstants.maxExcludeIds))
            let page = try await fetch(excluding: exclude, offset: items.count)
            cursor = page.nextBefore
            let have = Set(items.map(\.videoId))
            let fresh = page.items.filter { !have.contains($0.videoId) }
            if fresh.isEmpty && page.nextBefore == nil {
                exhausted = true
            } else if !fresh.isEmpty {
                items.append(contentsOf: fresh)
                await hydrateReactions(for: fresh)
            }
            if page.exhausted && fresh.isEmpty { exhausted = true }
        } catch {
            // Keep what we have; mid-scroll errors are silent, like the web.
        }
    }

    private func fetch(excluding exclude: [String], offset: Int) async throws -> FeedResponse {
        switch source {
        case .feed(let surface, let category, let seller):
            return try await api.send(DripAPI.feed(.init(
                sessionId: sessionId, surface: surface, excludeIds: exclude,
                category: category, seller: seller, before: cursor, offset: offset)))
        case .search(let q):
            return try await api.send(DripAPI.search(sessionId: sessionId, query: q, excludeIds: exclude))
        }
    }

    private func hydrateReactions(for batch: [FeedItem]) async {
        guard !batch.isEmpty else { return }
        let videoIds = batch.map(\.videoId)
        let sellerIds = Array(Set(batch.map(\.seller.id)))
        do {
            let r = try await api.send(DripAPI.reactions(videoIds: videoIds, sellerIds: sellerIds))
            liked.formUnion(r.liked)
            saved.formUnion(r.saved)
            following.formUnion(r.following)
        } catch {
            // Reaction state is decoration; the feed works without it.
        }
    }

    // MARK: Paging

    /// The pager settled on `index`. Emits the outgoing video's skip (with
    /// cumulative watch time) and the incoming impression, then prefetches.
    public func commit(index: Int) async {
        guard items.indices.contains(index) else { return }
        if hasCommitted, index == activeIndex { return }

        if hasCommitted, let w = watch, items.indices.contains(activeIndex) {
            await emit(FeedEvent(.skip, videoId: w.videoId, position: activeIndex,
                                 watchedMs: w.cumulativeWatchedMs, durationMs: w.durationMs, loopCount: w.loops))
        }

        activeIndex = index
        hasCommitted = true
        let item = items[index]
        watch = WatchSession(videoId: item.videoId, durationSeconds: item.durationSeconds)

        if impressed.insert(item.videoId).inserted {
            await emit(FeedEvent(.impression, videoId: item.videoId, position: index))
        }
        await loadMoreIfNeeded()
    }

    /// Periodic playhead updates from the player for the active video.
    public func playbackProgress(videoId: String, position: Double) async {
        guard var w = watch, w.videoId == videoId else { return }
        let crossed = w.observe(position: position)
        watch = w
        for p in crossed {
            var e = FeedEvent(.watchProgress, videoId: videoId, position: activeIndex,
                              watchedMs: p.watchedMs, durationMs: w.durationMs, loopCount: p.loops)
            e.b = String(p.bucket)
            await emit(e)
        }
    }

    public func playbackFailed(videoId: String) async {
        let pos = items.firstIndex { $0.videoId == videoId }
        await emit(FeedEvent(.videoError, videoId: videoId, position: pos))
    }

    // MARK: Engagement

    public func toggleLike(_ item: FeedItem) async {
        let on = !liked.contains(item.videoId)
        if on { liked.insert(item.videoId) } else { liked.remove(item.videoId) }
        await emit(FeedEvent(on ? .like : .unlike, videoId: item.videoId, position: position(of: item)))
    }

    /// Double-tap: like only, never unlike (the design's heart burst).
    public func likeFromDoubleTap(_ item: FeedItem) async {
        guard !liked.contains(item.videoId) else { return }
        await toggleLike(item)
    }

    public func toggleSave(_ item: FeedItem) async {
        let on = !saved.contains(item.videoId)
        if on { saved.insert(item.videoId) } else { saved.remove(item.videoId) }
        await emit(FeedEvent(on ? .save : .unsave, videoId: item.videoId, position: position(of: item)))
    }

    public func toggleFollow(_ item: FeedItem) async {
        let id = item.seller.id
        let on = !following.contains(id)
        if on { following.insert(id) } else { following.remove(id) }
        await emit(FeedEvent(on ? .follow : .unfollow, videoId: item.videoId, position: position(of: item)))
    }

    public func shared(_ item: FeedItem) async {
        await emit(FeedEvent(.share, videoId: item.videoId, position: position(of: item)))
    }

    public func productTapped(_ item: FeedItem, product: FeedProduct) async {
        await emit(FeedEvent(.productTap, videoId: item.videoId, productId: product.id, position: position(of: item)))
    }

    public func variantSelected(_ item: FeedItem, product: FeedProduct, optionId: String) async {
        await emit(FeedEvent(.variantSelect, videoId: item.videoId, productId: product.id,
                             position: position(of: item), meta: ["option": optionId]))
    }

    public func addedToBag(_ item: FeedItem, product: FeedProduct) async {
        await emit(FeedEvent(.addToCart, videoId: item.videoId, productId: product.id, position: position(of: item)))
    }

    public func sellerProfileTapped(_ item: FeedItem) async {
        await emit(FeedEvent(.sellerProfileTap, videoId: item.videoId, position: position(of: item)))
    }

    /// Hides the video now; the server blocks it permanently and the seller
    /// for 30 days (ingest_feed_events).
    public func notInterested(_ item: FeedItem) async {
        await emit(FeedEvent(.notInterested, videoId: item.videoId, position: position(of: item)))
        remove(videoId: item.videoId)
    }

    public func report(_ item: FeedItem, reason: String) async {
        await emit(FeedEvent(.report, videoId: item.videoId, position: position(of: item), meta: ["reason": reason]))
        remove(videoId: item.videoId)
    }

    private func remove(videoId: String) {
        guard let i = items.firstIndex(where: { $0.videoId == videoId }) else { return }
        items.remove(at: i)
        if items.isEmpty {
            phase = .empty
            watch = nil
            return
        }
        if i < activeIndex { activeIndex -= 1 }
        activeIndex = min(activeIndex, items.count - 1)
        let next = items[activeIndex]
        watch = WatchSession(videoId: next.videoId, durationSeconds: next.durationSeconds)
        if impressed.insert(next.videoId).inserted {
            Task { await emit(FeedEvent(.impression, videoId: next.videoId, position: activeIndex)) }
        }
    }

    private func position(of item: FeedItem) -> Int? {
        items.firstIndex { $0.videoId == item.videoId }
    }

    private func emit(_ event: FeedEvent) async {
        await tracker.track(event, sessionId: sessionId, surface: surface)
    }

    // MARK: Player plumbing

    /// Playable sources aligned with `items`, for `PlayerPool.update`.
    public var playbackURLs: [(videoId: String, url: URL)?] {
        items.map { item in
            guard let pid = item.playbackId, let url = MuxURLs.hls(playbackId: pid) else { return nil }
            return (item.videoId, url)
        }
    }
}

extension FeedModel.Phase {
    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }
}
