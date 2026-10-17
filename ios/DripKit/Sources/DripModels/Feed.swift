import Foundation

// Mirrors of the /api/feed wire contract — src/lib/feed/types.ts. Field names
// match the JSON (camelCase on this route), so Codable needs no key mapping.
// Unknown enum values decode to `.unknown` instead of failing the whole
// slice: the server adds lanes and surfaces over time, and one new string
// must never blank the feed of an older app build.

public struct FeedResponse: Codable, Sendable, Equatable {
    public var items: [FeedItem]
    public var sessionId: String
    public var surface: FeedSurface
    public var exhausted: Bool
    public var mode: FeedMode
    public var nextBefore: String?

    public init(items: [FeedItem], sessionId: String, surface: FeedSurface,
                exhausted: Bool, mode: FeedMode = .default, nextBefore: String? = nil) {
        self.items = items
        self.sessionId = sessionId
        self.surface = surface
        self.exhausted = exhausted
        self.mode = mode
        self.nextBefore = nextBefore
    }
}

public struct FeedItem: Codable, Sendable, Equatable, Identifiable, Hashable {
    public var videoId: String
    public var playbackId: String?
    public var durationSeconds: Double
    public var aspectRatio: String?
    public var thumbnailUrl: String?
    public var caption: String?
    public var hashtags: [String]
    public var categorySlug: String?
    public var seller: Seller
    public var products: [FeedProduct]
    public var lane: FeedLane
    public var position: Int

    public var id: String { videoId }

    public init(videoId: String, playbackId: String?, durationSeconds: Double,
                aspectRatio: String? = nil, thumbnailUrl: String? = nil, caption: String? = nil,
                hashtags: [String] = [], categorySlug: String? = nil, seller: Seller,
                products: [FeedProduct], lane: FeedLane = .chrono, position: Int = 0) {
        self.videoId = videoId
        self.playbackId = playbackId
        self.durationSeconds = durationSeconds
        self.aspectRatio = aspectRatio
        self.thumbnailUrl = thumbnailUrl
        self.caption = caption
        self.hashtags = hashtags
        self.categorySlug = categorySlug
        self.seller = seller
        self.products = products
        self.lane = lane
        self.position = position
    }

    /// "9:16" → 0.5625 (width / height). Nil when absent or malformed; the
    /// player then fills the page, which is right for vertical video.
    public var aspectRatioValue: Double? {
        guard let aspectRatio else { return nil }
        let parts = aspectRatio.split(separator: ":").compactMap { Double($0) }
        guard parts.count == 2, parts[0] > 0, parts[1] > 0 else { return nil }
        return parts[0] / parts[1]
    }

    /// The product pinned for this moment of playback, else the first one.
    public func featuredProduct(atSecond second: Double) -> FeedProduct? {
        let pinned = products
            .filter { ($0.pinnedAtSecond ?? .infinity) <= second }
            .max { ($0.pinnedAtSecond ?? 0) < ($1.pinnedAtSecond ?? 0) }
        return pinned ?? products.min { $0.position < $1.position }
    }
}

public struct Seller: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var handle: String
    public var displayName: String
    public var avatarUrl: String?

    public init(id: String, handle: String, displayName: String, avatarUrl: String? = nil) {
        self.id = id
        self.handle = handle
        self.displayName = displayName
        self.avatarUrl = avatarUrl
    }
}

public struct FeedProduct: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var priceCents: Int
    public var compareAtPriceCents: Int?
    public var inventoryCount: Int
    public var lowStockThreshold: Int
    public var images: [String]
    public var variants: [VariantGroup]
    public var position: Int
    public var pinnedAtSecond: Double?

    public init(id: String, title: String, priceCents: Int, compareAtPriceCents: Int? = nil,
                inventoryCount: Int, lowStockThreshold: Int = 3, images: [String] = [],
                variants: [VariantGroup] = [], position: Int = 0, pinnedAtSecond: Double? = nil) {
        self.id = id
        self.title = title
        self.priceCents = priceCents
        self.compareAtPriceCents = compareAtPriceCents
        self.inventoryCount = inventoryCount
        self.lowStockThreshold = lowStockThreshold
        self.images = images
        self.variants = variants
        self.position = position
        self.pinnedAtSecond = pinnedAtSecond
    }

    public var price: Money { Money(cents: priceCents) }
    public var compareAtPrice: Money? {
        guard let c = compareAtPriceCents, c > priceCents else { return nil }
        return Money(cents: c)
    }
    public var isSoldOut: Bool { inventoryCount <= 0 }
    public var isLowStock: Bool { !isSoldOut && inventoryCount <= lowStockThreshold }
}

public struct VariantGroup: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var options: [VariantOption]

    public init(id: String, name: String, options: [VariantOption]) {
        self.id = id
        self.name = name
        self.options = options
    }
}

public struct VariantOption: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var value: String
    public var priceDeltaCents: Int
    public var inventoryCount: Int
    public var sku: String?

    public init(id: String, value: String, priceDeltaCents: Int = 0, inventoryCount: Int, sku: String? = nil) {
        self.id = id
        self.value = value
        self.priceDeltaCents = priceDeltaCents
        self.inventoryCount = inventoryCount
        self.sku = sku
    }
}

public enum FeedLane: String, Codable, Sendable, Hashable {
    case chrono, affinity, trending, fresh, social, random, unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = FeedLane(rawValue: raw) ?? .unknown
    }
}

public enum FeedSurface: String, Codable, Sendable, Hashable, CaseIterable {
    case forYou = "for_you"
    case following
    case category
    case sellerProfile = "seller_profile"
    case search
    case sharedLink = "shared_link"
}

public enum FeedMode: String, Codable, Sendable, Hashable {
    case `default`, diversify
}

/// Server constants (src/lib/feed/types.ts) the client paging depends on.
public enum FeedConstants {
    public static let sliceSize = 20
    /// Request the next slice when the viewer reaches this index of a slice.
    public static let prefetchAt = 15
    /// `exclude_ids` is capped at 8,000 chars (216 uuids + commas); past
    /// that the route answers 400 and the feed reads as ended. Same cap as
    /// the web shell (feed-shell.tsx).
    public static let maxExcludeIds = 200
}
