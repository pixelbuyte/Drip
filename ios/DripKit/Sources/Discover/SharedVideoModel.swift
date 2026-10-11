import Foundation
import Observation
import DripModels
import Networking
import Analytics

/// Opens a shared link (`drip://v/<id>`, `https://<site>/v/<id>`): fetches
/// the one video, then hands it to a feed seeded on it, the same way search
/// results and saved items open the feed at an item. Paging continues from
/// `/api/feed` on the `shared_link` surface, so the ranker and the creator's
/// stats see these views as arriving from a shared link.
///
/// UI-free; `SharedVideoScreen` (AppCore/RootView.swift) only renders it.
@MainActor
@Observable
public final class SharedVideoModel {
    public enum Phase: Sendable, Equatable {
        case idle, loading, loaded
        /// Not live any more, never existed, or nothing left to buy (404).
        case unavailable
        /// Could not look (offline, 5xx); retryable.
        case failed(String)
    }

    public let videoId: String
    public private(set) var phase: Phase = .idle
    public private(set) var feed: FeedModel?

    private let api: APIClient
    private let tracker: any EventTracking

    /// `videoId` should come from `DeepLink.parse`, which already normalized
    /// it; anything else reads as unavailable without a request.
    public init(videoId: String, api: APIClient, tracker: any EventTracking) {
        self.videoId = ShareLinks.normalizedVideoId(videoId) ?? ""
        self.api = api
        self.tracker = tracker
    }

    public func load() async {
        guard phase == .idle || phase.isFailed else { return }
        guard !videoId.isEmpty else {
            phase = .unavailable
            return
        }
        phase = .loading
        do {
            let response = try await api.send(DripAPI.video(id: videoId))
            let model = FeedModel(source: .feed(.sharedLink), api: api, tracker: tracker)
            await model.seed(items: [response.item], startAt: 0)
            feed = model
            phase = .loaded
        } catch APIError.notFound {
            phase = .unavailable
        } catch let error as APIError {
            phase = .failed(error.userMessage)
        } catch {
            phase = .failed("Could not load this video.")
        }
    }
}

extension SharedVideoModel.Phase {
    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }
}
