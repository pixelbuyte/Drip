#if canImport(AVFoundation) && canImport(UIKit)
import AVFoundation
import UIKit
import SwiftUI
import Observation

/// Owns every AVPlayer the feed uses and executes `PreloadPlanner` plans.
///
/// - Players are recycled, never created per page: a pool of `capacity`
///   AVQueuePlayers, each re-pointed at a new item as the window slides.
/// - Exactly one player is ever playing (the active page). Offscreen pages
///   are paused the moment they stop being active.
/// - A memory warning shrinks the window to `PreloadPlanner.constrained`
///   and releases everything outside it.
@MainActor
@Observable
public final class PlayerPool {
    public struct Source: Hashable, Sendable {
        public let videoId: String
        public let url: URL
        public init(videoId: String, url: URL) {
            self.videoId = videoId
            self.url = url
        }
    }

    final class Slot {
        let player = AVQueuePlayer()
        var looper: AVPlayerLooper?
        var source: Source?
        var timeObserver: Any?
        var statusObservation: NSKeyValueObservation?
        var lastUsed = Date.distantPast

        init() {
            player.automaticallyWaitsToMinimizeStalling = true
            player.preventsDisplaySleepDuringVideoPlayback = true
        }
    }

    public private(set) var isMuted: Bool = false
    public private(set) var activeVideoId: String?
    /// Playback failures by video id, for the error overlay + video_error event.
    public private(set) var failures: Set<String> = []

    private var planner: PreloadPlanner
    private let normalPlanner: PreloadPlanner
    private var slots: [Slot] = []
    private var assignment: [String: Slot] = [:]
    @ObservationIgnored private var memoryObserver: (any NSObjectProtocol)?
    @ObservationIgnored public var onProgress: ((String, Double) -> Void)?
    @ObservationIgnored public var onFailure: ((String) -> Void)?

    public init(planner: PreloadPlanner = PreloadPlanner()) {
        self.planner = planner
        self.normalPlanner = planner
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, options: [])
        memoryObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.handleMemoryWarning() }
        }
    }

    /// Applies the plan for `active` over `sources` (nil = no playable stream).
    public func update(sources: [Source?], active: Int) {
        let plan = planner.plan(active: active, count: sources.count)
        var wanted: [String: (Source, PreloadPlanner.Role)] = [:]
        for (index, role) in plan {
            if let s = sources[index] { wanted[s.videoId] = (s, role) }
        }

        // Release slots whose video left the window.
        for (videoId, slot) in assignment where wanted[videoId] == nil {
            release(slot)
            assignment[videoId] = nil
        }

        for (videoId, (source, role)) in wanted {
            let slot = assignment[videoId] ?? claimSlot(for: source)
            assignment[videoId] = slot
            slot.lastUsed = Date()
            apply(role, to: slot)
        }

        activeVideoId = plan.first(where: { $0.value == .active }).flatMap { sources[$0.key]?.videoId }
    }

    public func player(for videoId: String) -> AVPlayer? {
        assignment[videoId]?.player
    }

    public func setMuted(_ muted: Bool) {
        isMuted = muted
        for slot in slots { slot.player.isMuted = muted }
    }

    /// App backgrounded, a full-screen sheet, or user pause.
    public func pauseAll() {
        for slot in slots { slot.player.pause() }
    }

    public func resumeActive() {
        guard let id = activeVideoId, let slot = assignment[id] else { return }
        slot.player.play()
    }

    public func togglePlayback() {
        guard let id = activeVideoId, let slot = assignment[id] else { return }
        if slot.player.timeControlStatus == .playing { slot.player.pause() } else { slot.player.play() }
    }

    public func clearFailure(_ videoId: String) {
        failures.remove(videoId)
    }

    // MARK: Internals

    private func claimSlot(for source: Source) -> Slot {
        let slot: Slot
        if slots.count < planner.capacity + 1 {
            slot = Slot()
            slots.append(slot)
        } else if let free = slots.first(where: { $0.source == nil }) {
            slot = free
        } else {
            // Evict the least recently used slot outside the window.
            let inUse = Set(assignment.values.map(ObjectIdentifier.init))
            slot = slots.filter { !inUse.contains(ObjectIdentifier($0)) }.min { $0.lastUsed < $1.lastUsed }
                ?? slots.min { $0.lastUsed < $1.lastUsed }!
            if let old = slot.source { assignment[old.videoId] = nil }
            release(slot)
        }
        load(source, into: slot)
        return slot
    }

    private func load(_ source: Source, into slot: Slot) {
        slot.source = source
        let item = AVPlayerItem(url: source.url)
        item.preferredForwardBufferDuration = 4
        slot.player.isMuted = isMuted
        slot.looper = AVPlayerLooper(player: slot.player, templateItem: item)
        let videoId = source.videoId
        slot.timeObserver = slot.player.addPeriodicTimeObserver(
            forInterval: CMTime(value: 1, timescale: 4), queue: .main
        ) { [weak self] time in
            MainActor.assumeIsolated {
                guard let self, self.activeVideoId == videoId else { return }
                self.onProgress?(videoId, time.seconds)
            }
        }
        // AVPlayerLooper reports an unplayable stream (404, bad manifest,
        // unsupported codec) through its own status.
        slot.statusObservation = slot.looper?.observe(\.status, options: [.initial, .new]) { [weak self] looper, _ in
            guard looper.status == .failed else { return }
            Task { @MainActor in self?.markFailed(videoId) }
        }
    }

    private func markFailed(_ videoId: String) {
        guard !failures.contains(videoId) else { return }
        failures.insert(videoId)
        onFailure?(videoId)
    }

    private func apply(_ role: PreloadPlanner.Role, to slot: Slot) {
        switch role {
        case .active:
            slot.player.play()
        case .preroll:
            slot.player.pause()
            if slot.player.currentTime() != .zero {
                slot.player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero)
            }
            slot.player.currentItem?.preferredForwardBufferDuration = 3
        case .warm:
            slot.player.pause()
            slot.player.currentItem?.preferredForwardBufferDuration = 1
        case .retain:
            slot.player.pause()
        }
    }

    private func release(_ slot: Slot) {
        slot.player.pause()
        if let obs = slot.timeObserver { slot.player.removeTimeObserver(obs) }
        slot.timeObserver = nil
        slot.statusObservation?.invalidate()
        slot.statusObservation = nil
        slot.looper?.disableLooping()
        slot.looper = nil
        slot.player.removeAllItems()
        slot.source = nil
    }

    private func handleMemoryWarning() {
        planner = .constrained
        let keep = activeVideoId
        for (videoId, slot) in assignment where videoId != keep {
            release(slot)
            assignment[videoId] = nil
        }
        slots.removeAll { $0.source == nil }
    }

    /// Called when the system pressure has passed (e.g. app foregrounded).
    public func restoreNormalWindow() {
        planner = normalPlanner
    }
}

/// AVPlayerLayer host. `videoGravity` fills the page for vertical video.
public struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer?
    let gravity: AVLayerVideoGravity

    public init(player: AVPlayer?, gravity: AVLayerVideoGravity = .resizeAspectFill) {
        self.player = player
        self.gravity = gravity
    }

    public func makeUIView(context: Context) -> PlayerContainer {
        let v = PlayerContainer()
        v.playerLayer.videoGravity = gravity
        v.playerLayer.player = player
        v.isAccessibilityElement = false
        return v
    }

    public func updateUIView(_ view: PlayerContainer, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
        view.playerLayer.videoGravity = gravity
    }

    public final class PlayerContainer: UIView {
        public override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}
#endif
