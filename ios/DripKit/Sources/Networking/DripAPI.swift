import Foundation
import DripModels

/// Every backend route the app calls, typed. Paths and parameter names are
/// the server's; see docs/DRIP_BACKEND_INTEGRATION.md for each route's source.
public enum DripAPI {
    // MARK: Identity

    /// POST /api/session/anon — src/app/api/session/anon/route.ts
    public static func mintViewerIdentity(existingToken: String?) -> Endpoint<AnonIdentity> {
        var e = Endpoint<AnonIdentity>(.post, "/api/session/anon")
        if existingToken != nil { e.sendsViewerIdentity = true }
        return e
    }

    /// POST /api/session/link — claims the device identity for the signed-in
    /// account (claim_anon_identity; refuses to graft another account's history).
    public static func linkViewerIdentity() -> Endpoint<LinkResponse> {
        Endpoint(.post, "/api/session/link", auth: .required, sendsViewerIdentity: true)
    }

    // MARK: Feed & search

    public struct FeedQuery: Sendable, Equatable {
        public var sessionId: String
        public var surface: FeedSurface
        public var excludeIds: [String]
        public var category: String?
        public var seller: String?
        public var before: String?
        public var offset: Int

        public init(sessionId: String, surface: FeedSurface = .forYou, excludeIds: [String] = [],
                    category: String? = nil, seller: String? = nil, before: String? = nil, offset: Int = 0) {
            self.sessionId = sessionId
            self.surface = surface
            self.excludeIds = excludeIds
            self.category = category
            self.seller = seller
            self.before = before
            self.offset = offset
        }
    }

    /// GET /api/feed — src/app/api/feed/route.ts
    public static func feed(_ q: FeedQuery) -> Endpoint<FeedResponse> {
        var items = [
            URLQueryItem(name: "session_id", value: q.sessionId),
            URLQueryItem(name: "surface", value: q.surface.rawValue),
        ]
        let exclude = q.excludeIds.suffix(FeedConstants.maxExcludeIds)
        if !exclude.isEmpty { items.append(URLQueryItem(name: "exclude_ids", value: exclude.joined(separator: ","))) }
        if let c = q.category { items.append(URLQueryItem(name: "category", value: c)) }
        if let s = q.seller { items.append(URLQueryItem(name: "seller", value: s)) }
        if let b = q.before { items.append(URLQueryItem(name: "before", value: b)) }
        if q.offset > 0 { items.append(URLQueryItem(name: "offset", value: String(q.offset))) }
        return Endpoint(.get, "/api/feed", query: items, sendsViewerIdentity: true)
    }

    /// GET /api/search — src/app/api/search/route.ts. Returns the feed shape.
    public static func search(sessionId: String, query: String, excludeIds: [String] = [],
                              category: String? = nil, seller: String? = nil) -> Endpoint<FeedResponse> {
        var items = [
            URLQueryItem(name: "session_id", value: sessionId),
            URLQueryItem(name: "q", value: String(query.prefix(200))),
        ]
        let exclude = excludeIds.suffix(FeedConstants.maxExcludeIds)
        if !exclude.isEmpty { items.append(URLQueryItem(name: "exclude_ids", value: exclude.joined(separator: ","))) }
        if let c = category { items.append(URLQueryItem(name: "category", value: c)) }
        if let s = seller { items.append(URLQueryItem(name: "seller", value: s)) }
        return Endpoint(.get, "/api/search", query: items, sendsViewerIdentity: true)
    }

    /// GET /api/me/reactions — src/app/api/me/reactions/route.ts
    public static func reactions(videoIds: [String], sellerIds: [String]) -> Endpoint<ReactionsResponse> {
        var items: [URLQueryItem] = []
        if !videoIds.isEmpty { items.append(URLQueryItem(name: "video_ids", value: videoIds.prefix(50).joined(separator: ","))) }
        if !sellerIds.isEmpty { items.append(URLQueryItem(name: "seller_ids", value: sellerIds.prefix(50).joined(separator: ","))) }
        return Endpoint(.get, "/api/me/reactions", query: items, sendsViewerIdentity: true)
    }

    /// GET /api/me/saved — src/app/api/me/saved/route.ts
    public static func savedItems() -> Endpoint<SavedItemsResponse> {
        Endpoint(.get, "/api/me/saved", sendsViewerIdentity: true)
    }

    /// DELETE /api/me — deletes the signed-in account (App Store 5.1.1(v)).
    /// 409 `seller_has_orders`: a creator with buyer orders is closed by support.
    public static func deleteAccount() -> Endpoint<AccountDeletedResponse> {
        Endpoint(.delete, "/api/me", body: Data(#"{"confirm":"DELETE"}"#.utf8), auth: .required)
    }

    // MARK: Commerce

    /// POST /api/checkout/intent — price, shipping, inventory and the Stripe
    /// destination charge are all decided server-side.
    public static func createPaymentIntent(_ body: PaymentIntentRequest) throws -> Endpoint<PaymentIntentResponse> {
        Endpoint(.post, "/api/checkout/intent", body: try JSONEncoder.drip.encode(body),
                 auth: .optional, sendsViewerIdentity: true, timeout: 30)
    }

    // MARK: Creators

    /// POST /api/drops — creates the listing and a Mux direct-upload URL.
    public static func createDrop(_ body: CreateDropRequest) throws -> Endpoint<CreateDropResponse> {
        Endpoint(.post, "/api/drops", body: try JSONEncoder.drip.encode(body), auth: .required, timeout: 30)
    }

    /// GET /api/stripe/onboarding/status
    public static func onboardingStatus() -> Endpoint<OnboardingStatus> {
        Endpoint(.get, "/api/stripe/onboarding/status", auth: .required)
    }

    /// POST /api/stripe/onboarding/start → hosted Stripe Connect onboarding URL.
    public static func startOnboarding() -> Endpoint<OnboardingLink> {
        Endpoint(.post, "/api/stripe/onboarding/start", auth: .required)
    }
}

public struct AccountDeletedResponse: Codable, Sendable, Equatable {
    public var deleted: Bool
    public init(deleted: Bool) { self.deleted = deleted }
}

public struct SavedItemsResponse: Codable, Sendable, Equatable {
    public var items: [FeedItem]
    public init(items: [FeedItem]) { self.items = items }
}

public struct OnboardingStatus: Codable, Sendable, Equatable {
    public var connected: Bool?
    public var chargesEnabled: Bool
    public var payoutsEnabled: Bool?

    enum CodingKeys: String, CodingKey {
        case connected
        case chargesEnabled = "charges_enabled"
        case payoutsEnabled = "payouts_enabled"
    }
}

public struct OnboardingLink: Codable, Sendable, Equatable {
    public var url: String
}
