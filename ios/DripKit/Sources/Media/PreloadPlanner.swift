import Foundation

/// Decides, for the current page, what every nearby page should be doing.
/// Pure so it can be tested exhaustively; `PlayerPool` executes the plan.
///
/// The window matches the web shell (one back, two ahead): the previous page
/// stays warm for an immediate swipe back, the next page is prerolled so it
/// starts on the first frame, and the one after only begins loading its
/// asset. Everything else is released — players are the dominant memory cost.
public struct PreloadPlanner: Sendable, Equatable {
    public enum Role: Equatable, Sendable {
        /// Visible: play.
        case active
        /// Buffer and preroll, paused at 0.
        case preroll
        /// Create the item so the asset/manifest loads; don't buffer media.
        case warm
        /// Keep paused where it is (a swipe back resumes in place).
        case retain
    }

    public var behind: Int
    public var ahead: Int

    public init(behind: Int = 1, ahead: Int = 2) {
        self.behind = behind
        self.ahead = ahead
    }

    /// Low-memory mode: only the active page and the next one.
    public static let constrained = PreloadPlanner(behind: 0, ahead: 1)

    public func plan(active: Int, count: Int) -> [Int: Role] {
        guard count > 0, (0..<count).contains(active) else { return [:] }
        var out: [Int: Role] = [active: .active]
        for d in 1...max(ahead, 1) where ahead >= d {
            let i = active + d
            guard i < count else { break }
            out[i] = d == 1 ? .preroll : .warm
        }
        if behind > 0 {
            for d in 1...behind {
                let i = active - d
                guard i >= 0 else { break }
                out[i] = .retain
            }
        }
        return out
    }

    /// Maximum simultaneous players this plan can need.
    public var capacity: Int { 1 + behind + ahead }
}

/// Watch accounting for one video while it is the active page, fed by the
/// player's periodic time observer. Mirrors the web shell's semantics
/// (src/components/feed/feed-video.tsx, feed-shell.tsx):
///   - progress buckets 25/50/75/95 fire once per pass and re-arm each loop;
///   - a loop is the playhead jumping back to the start, since looping
///     playback never "ends";
///   - leaving the page reports cumulative watch time = playhead + loops x
///     duration, so five full loops is never mistaken for a short skip.
public struct WatchSession: Sendable, Equatable {
    public static let buckets = [25, 50, 75, 95]

    public let videoId: String
    public let durationMs: Int
    public private(set) var loops: Int = 0
    public private(set) var positionMs: Int = 0
    private var firedThisPass: Set<Int> = []
    private var lastPosition: Double = 0

    public init(videoId: String, durationSeconds: Double) {
        self.videoId = videoId
        self.durationMs = max(0, Int((durationSeconds * 1000).rounded()))
    }

    public struct Progress: Equatable, Sendable {
        public let bucket: Int
        public let watchedMs: Int
        public let loops: Int
    }

    /// Feed each observed playhead position (seconds). Returns the progress
    /// buckets crossed by this observation, in order.
    public mutating func observe(position: Double) -> [Progress] {
        let durationSec = Double(durationMs) / 1000
        if durationSec > 0, lastPosition > durationSec * 0.5, position + 1 < lastPosition {
            loops += 1
            firedThisPass.removeAll()
        }
        lastPosition = position
        positionMs = Int((position * 1000).rounded())
        guard durationMs > 0 else { return [] }

        let pct = position / durationSec * 100
        var crossed: [Progress] = []
        for b in Self.buckets where pct >= Double(b) && !firedThisPass.contains(b) {
            firedThisPass.insert(b)
            crossed.append(Progress(bucket: b, watchedMs: positionMs, loops: loops))
        }
        return crossed
    }

    /// Cumulative watch time for the outgoing `skip` event.
    public var cumulativeWatchedMs: Int { positionMs + loops * durationMs }

    /// The page left and returned: playback restarts from zero.
    public mutating func reset() {
        loops = 0
        positionMs = 0
        lastPosition = 0
        firedThisPass.removeAll()
    }
}
