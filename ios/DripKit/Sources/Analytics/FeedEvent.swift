import Foundation
import DripModels

/// The /api/events wire event (src/app/api/events/route.ts `eventSchema`).
/// Short keys are the server's — the payload is sent every few seconds.
public struct FeedEvent: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable, CaseIterable {
        case impression, skip, replay
        case watchProgress = "watch_progress"
        case productTap = "product_tap"
        case variantSelect = "variant_select"
        case addToCart = "add_to_cart"
        case checkoutOpen = "checkout_open"
        case checkoutAbandon = "checkout_abandon"
        case purchase, like, unlike, save, unsave, share
        case sellerProfileTap = "seller_profile_tap"
        case follow, unfollow
        case notInterested = "not_interested"
        case report
        case videoError = "video_error"
    }

    public var t: Kind
    /// video id
    public var v: String
    /// product id
    public var p: String?
    /// client timestamp, ms since epoch (the server clamps skew)
    public var ts: Int?
    /// position in feed
    public var pos: Int?
    /// watched ms
    public var wm: Int?
    /// video duration ms
    public var dm: Int?
    /// loop count
    public var lc: Int?
    /// bucket
    public var b: String?
    public var meta: [String: String]?

    public init(_ kind: Kind, videoId: String, productId: String? = nil, at date: Date = Date(),
                position: Int? = nil, watchedMs: Int? = nil, durationMs: Int? = nil,
                loopCount: Int? = nil, meta: [String: String]? = nil) {
        self.t = kind
        self.v = videoId
        self.p = productId
        self.ts = Int(date.timeIntervalSince1970 * 1000)
        self.pos = position.map { min(max($0, 0), 5000) }
        self.wm = watchedMs.map { min(max($0, 0), 86_400_000) }
        self.dm = durationMs.map { min(max($0, 0), 3_600_000) }
        // The server rejects > 500; clamp rather than lose the event.
        self.lc = loopCount.map { min(max($0, 0), 500) }
        self.meta = meta
    }
}

public struct EventBatch: Codable, Sendable, Equatable {
    public var sid: String
    public var sf: FeedSurface
    public var sent_at: Int
    public var e: [FeedEvent]
}
