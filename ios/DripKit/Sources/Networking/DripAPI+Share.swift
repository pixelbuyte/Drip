import Foundation
import DripModels

extension DripAPI {
    /// GET /api/videos/[id] — src/app/api/videos/[id]/route.ts. One live
    /// video in the feed's item shape, for opening a shared link. Public; 404
    /// when the video is not live or has nothing left to sell, 503 when the
    /// server could not look. `id` must already be a normalized uuid
    /// (`ShareLinks.normalizedVideoId`).
    public static func video(id: String) -> Endpoint<VideoResponse> {
        Endpoint(.get, "/api/videos/\(id)")
    }
}

public struct VideoResponse: Codable, Sendable, Equatable {
    public var item: FeedItem
    public init(item: FeedItem) { self.item = item }
}
