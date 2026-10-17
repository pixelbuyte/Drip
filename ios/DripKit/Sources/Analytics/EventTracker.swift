import Foundation
import DripModels
import Networking

/// Anything that records engagement. Views and models depend on this, not on
/// the batching implementation, so previews and tests use a recorder.
public protocol EventTracking: Sendable {
    func track(_ event: FeedEvent, sessionId: String, surface: FeedSurface) async
    func flush() async
}

/// Batches events per (session, surface) and posts them to /api/events.
///
/// Mirrors the server's posture: events are not precious. A failed batch is
/// dropped, never retried in a loop (route.ts: "the client must never retry
/// into a loop"), except one re-queue on a pure connectivity failure.
public actor EventTracker: EventTracking {
    public static let maxBatch = 50
    static let maxBodyBytes = 32 * 1024
    static let maxBuffered = 500

    private struct Key: Hashable {
        let sessionId: String
        let surface: FeedSurface
    }

    private let api: APIClient
    private let flushInterval: Duration
    private let now: @Sendable () -> Date
    private var buffers: [Key: [FeedEvent]] = [:]
    private var order: [Key] = []
    private var timer: Task<Void, Never>?
    private var requeued: Set<Key> = []

    public init(api: APIClient, flushInterval: Duration = .seconds(5),
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.api = api
        self.flushInterval = flushInterval
        self.now = now
    }

    public func track(_ event: FeedEvent, sessionId: String, surface: FeedSurface) async {
        let key = Key(sessionId: sessionId, surface: surface)
        if buffers[key] == nil { order.append(key) }
        buffers[key, default: []].append(event)

        // Bound memory if the network is down for a long session.
        let total = buffers.values.reduce(0) { $0 + $1.count }
        if total > Self.maxBuffered, let oldest = order.first {
            buffers[oldest]?.removeFirst(min(Self.maxBatch, buffers[oldest]?.count ?? 0))
            if buffers[oldest]?.isEmpty == true { buffers[oldest] = nil; order.removeFirst() }
        }

        if (buffers[key]?.count ?? 0) >= Self.maxBatch {
            await flush(key)
        } else {
            scheduleTimer()
        }
    }

    public func flush() async {
        for key in order { await flush(key) }
    }

    public var pendingCount: Int { buffers.values.reduce(0) { $0 + $1.count } }

    private func scheduleTimer() {
        guard timer == nil else { return }
        let interval = flushInterval
        timer = Task { [weak self] in
            try? await Task.sleep(for: interval)
            await self?.timerFired()
        }
    }

    private func timerFired() async {
        timer = nil
        await flush()
    }

    private func flush(_ key: Key) async {
        guard var events = buffers[key], !events.isEmpty else { return }
        let batch = Array(events.prefix(Self.maxBatch))
        events.removeFirst(batch.count)
        buffers[key] = events.isEmpty ? nil : events
        if events.isEmpty { order.removeAll { $0 == key } }

        for chunk in Self.chunks(batch) {
            let body = EventBatch(sid: key.sessionId, sf: key.surface,
                                  sent_at: Int(now().timeIntervalSince1970 * 1000), e: chunk)
            guard let data = try? JSONEncoder.drip.encode(body) else { continue }
            let endpoint = Endpoint<EmptyResponse>(.post, "/api/events", body: data, sendsViewerIdentity: true)
            do {
                _ = try await api.perform(endpoint)
                requeued.remove(key)
            } catch APIError.transport {
                // One second chance for connectivity blips, then let it go.
                if !requeued.contains(key) {
                    requeued.insert(key)
                    if buffers[key] == nil { order.append(key) }
                    buffers[key, default: []].insert(contentsOf: chunk, at: 0)
                }
            } catch {
                // 4xx/5xx: drop. Telemetry must never block or loop.
            }
        }
        if buffers[key] != nil { scheduleTimer() }
    }

    /// Splits so no request exceeds the server's 32KB body cap.
    static func chunks(_ events: [FeedEvent]) -> [[FeedEvent]] {
        var out: [[FeedEvent]] = []
        var current: [FeedEvent] = []
        var size = 64
        for e in events {
            let s = (try? JSONEncoder.drip.encode(e).count) ?? 200
            if !current.isEmpty, size + s + 1 > maxBodyBytes - 256 {
                out.append(current)
                current = []
                size = 64
            }
            current.append(e)
            size += s + 1
        }
        if !current.isEmpty { out.append(current) }
        return out
    }
}

/// Records instead of sending — previews and tests.
public actor RecordingTracker: EventTracking {
    public private(set) var events: [(FeedEvent, String, FeedSurface)] = []
    public init() {}
    public func track(_ event: FeedEvent, sessionId: String, surface: FeedSurface) async {
        events.append((event, sessionId, surface))
    }
    public func flush() async {}
    public var kinds: [FeedEvent.Kind] { events.map(\.0.t) }
}
