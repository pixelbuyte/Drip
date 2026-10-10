import Foundation
import Observation
import DripModels
import Networking

/// Search: debounced queries against /api/search (which returns the feed
/// shape, ranked by search_feed_videos). Stale responses never overwrite a
/// newer query's results.
@MainActor
@Observable
public final class ExploreModel {
    public static let debounce: Duration = .milliseconds(350)
    public static let minLength = 2

    public var query: String = "" {
        didSet { if query != oldValue { schedule() } }
    }
    public private(set) var results: Loadable<[FeedItem]> = .idle
    public private(set) var exhausted = false
    public let sessionId: String

    private let api: APIClient
    private var pending: Task<Void, Never>?
    private var generation = 0

    public init(api: APIClient, sessionId: String = UUID().uuidString.lowercased()) {
        self.api = api
        self.sessionId = sessionId
    }

    public var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Runs now (keyboard "Search", a chip tap) instead of after the debounce.
    public func submit() async {
        pending?.cancel()
        await run(trimmedQuery)
    }

    public func clear() {
        pending?.cancel()
        query = ""
        results = .idle
    }

    private func schedule() {
        pending?.cancel()
        let q = trimmedQuery
        guard q.count >= Self.minLength else {
            results = .idle
            return
        }
        pending = Task { [weak self] in
            try? await Task.sleep(for: Self.debounce)
            guard !Task.isCancelled else { return }
            await self?.run(q)
        }
    }

    private func run(_ q: String) async {
        guard q.count >= Self.minLength else { return }
        generation += 1
        let mine = generation
        results = .loading
        do {
            let page = try await api.send(DripAPI.search(sessionId: sessionId, query: q))
            guard mine == generation else { return }
            results = page.items.isEmpty ? .empty : .loaded(page.items)
            exhausted = page.exhausted
        } catch let error as APIError {
            guard mine == generation else { return }
            results = .failed(message: error.userMessage)
        } catch {
            guard mine == generation else { return }
            results = .failed(message: "Search is unavailable right now.")
        }
    }
}
