import Foundation

// Public catalog reads: GET /api/categories and GET /api/creators/{handle}
// (src/lib/categories.ts, src/lib/creators.ts). Neither needs a viewer
// identity or a session; both are CDN-cached server-side.

/// One Explore tile. Named `CatalogCategory`, not `Category`: on Apple
/// platforms the ObjectiveC module already exports a `Category` type, and the
/// clash only surfaces on an iOS build.
public struct CatalogCategory: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var slug: String
    public var name: String

    public var id: String { slug }

    public init(slug: String, name: String) {
        self.slug = slug
        self.name = name
    }
}

/// GET /api/categories → active categories in the server's sort order.
public struct CategoriesResponse: Codable, Sendable, Equatable {
    public var categories: [CatalogCategory]
    public init(categories: [CatalogCategory]) { self.categories = categories }
}

/// GET /api/creators/{handle} → a creator's public header.
public struct CreatorProfile: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var handle: String
    public var displayName: String
    public var avatarUrl: String?
    /// Not served yet (profiles has no bio column); decoded if it ever is.
    public var bio: String?
    public var followerCount: Int
    /// Live videos the seller-profile feed can serve. The server reports 0
    /// while the seller's payouts are not set up, matching what the feed shows.
    public var liveVideoCount: Int

    public init(id: String, handle: String, displayName: String, avatarUrl: String? = nil,
                bio: String? = nil, followerCount: Int = 0, liveVideoCount: Int = 0) {
        self.id = id
        self.handle = handle
        self.displayName = displayName
        self.avatarUrl = avatarUrl
        self.bio = bio
        self.followerCount = followerCount
        self.liveVideoCount = liveVideoCount
    }

    /// The identity part, in the shape the feed uses for a video's seller.
    public var seller: Seller {
        Seller(id: id, handle: handle, displayName: displayName, avatarUrl: avatarUrl)
    }
}

public struct CreatorResponse: Codable, Sendable, Equatable {
    public var creator: CreatorProfile
    public init(creator: CreatorProfile) { self.creator = creator }
}

/// The database's handle rule, `CHECK (handle ~ '^[a-z0-9_]{3,30}$')`
/// (00006_reconcile_forked_schema.sql), applied the way the server applies
/// it to /api/creators/{handle}: trimmed, one leading "@" dropped, lowercased.
public enum CreatorHandle {
    public static func normalize(_ raw: String) -> String? {
        var s = Substring(raw.trimmingCharacters(in: .whitespacesAndNewlines))
        if s.hasPrefix("@") { s = s.dropFirst() }
        let handle = s.lowercased()
        guard (3...30).contains(handle.count),
              handle.unicodeScalars.allSatisfy({
                  ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "_"
              })
        else { return nil }
        return handle
    }
}
