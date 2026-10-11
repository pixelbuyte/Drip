import Foundation

// Request/response bodies for the non-feed routes the app calls. Field names
// are the server's (several routes use snake_case request bodies).

/// POST /api/session/anon → the signed viewer identity for `x-drip-anon-token`.
public struct AnonIdentity: Codable, Sendable, Equatable {
    public var anonId: String
    public var token: String
    public init(anonId: String, token: String) {
        self.anonId = anonId
        self.token = token
    }
}

/// GET /api/me/reactions
public struct ReactionsResponse: Codable, Sendable, Equatable {
    public var liked: [String]
    public var saved: [String]
    public var following: [String]
    public init(liked: [String] = [], saved: [String] = [], following: [String] = []) {
        self.liked = liked
        self.saved = saved
        self.following = following
    }
}

/// POST /api/session/link
public struct LinkResponse: Codable, Sendable, Equatable {
    public var linked: Bool
}

/// POST /api/checkout/intent — src/app/api/checkout/intent/route.ts.
public struct PaymentIntentRequest: Codable, Sendable, Equatable {
    public var videoId: String
    public var productId: String
    public var quantity: Int
    /// Variant group *name* → chosen option *value*, the shape the server
    /// resolves price deltas from.
    public var selection: [String: String]?
    public var idempotencyKey: String
    public var email: String?

    public init(videoId: String, productId: String, quantity: Int,
                selection: [String: String]?, idempotencyKey: String, email: String?) {
        self.videoId = videoId
        self.productId = productId
        self.quantity = quantity
        self.selection = selection
        self.idempotencyKey = idempotencyKey
        self.email = email
    }

    enum CodingKeys: String, CodingKey {
        case videoId = "video_id"
        case productId = "product_id"
        case quantity, selection
        case idempotencyKey = "idempotency_key"
        case email
    }
}

public struct PaymentIntentResponse: Codable, Sendable, Equatable {
    public var clientSecret: String
    public var paymentIntentId: String
    public var subtotalCents: Int
    public var shippingCents: Int
    public var totalCents: Int
    public var title: String
    public var sellerHandle: String

    public init(clientSecret: String, paymentIntentId: String, subtotalCents: Int,
                shippingCents: Int, totalCents: Int, title: String, sellerHandle: String) {
        self.clientSecret = clientSecret
        self.paymentIntentId = paymentIntentId
        self.subtotalCents = subtotalCents
        self.shippingCents = shippingCents
        self.totalCents = totalCents
        self.title = title
        self.sellerHandle = sellerHandle
    }
}

/// POST /api/drops — src/lib/validation.ts `createDropSchema`.
/// The fixed category list seeded by 00007_feed_content_model.sql
/// (src/lib/listings.ts CATEGORY_SLUGS).
public enum ListingCategory: String, Codable, Sendable, CaseIterable, Identifiable {
    case apparel, footwear
    case jewelryAccessories = "jewelry-accessories"
    case beauty
    case homeDecor = "home-decor"
    case vintageThrift = "vintage-thrift"
    case collectibles
    case handmadeCraft = "handmade-craft"
    case techGadgets = "tech-gadgets"
    case pet, fitness, other

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .apparel: return "Apparel"
        case .footwear: return "Footwear"
        case .jewelryAccessories: return "Jewelry & Accessories"
        case .beauty: return "Beauty"
        case .homeDecor: return "Home & Decor"
        case .vintageThrift: return "Vintage & Thrift"
        case .collectibles: return "Collectibles"
        case .handmadeCraft: return "Handmade & Craft"
        case .techGadgets: return "Tech & Gadgets"
        case .pet: return "Pet"
        case .fitness: return "Fitness"
        case .other: return "Other"
        }
    }
}

/// POST /api/videos body (src/lib/listings.ts createListingSchema).
public struct CreateListingRequest: Codable, Sendable, Equatable {
    public struct Dimensions: Codable, Sendable, Equatable {
        public var lengthIn: Double
        public var widthIn: Double
        public var heightIn: Double
        public init(lengthIn: Double, widthIn: Double, heightIn: Double) {
            self.lengthIn = lengthIn
            self.widthIn = widthIn
            self.heightIn = heightIn
        }
        enum CodingKeys: String, CodingKey {
            case lengthIn = "length_in", widthIn = "width_in", heightIn = "height_in"
        }
    }

    public struct VariantDimension: Codable, Sendable, Equatable {
        public var name: String
        public var options: [String]
        public init(name: String, options: [String]) {
            self.name = name
            self.options = options
        }
    }

    public var title: String
    public var description: String?
    public var priceCents: Int
    public var compareAtPriceCents: Int?
    public var inventory: Int
    public var weightOz: Double
    public var dimensions: Dimensions
    public var variants: [VariantDimension]?
    public var caption: String?
    public var hashtags: [String]?
    public var category: ListingCategory

    public init(title: String, description: String?, priceCents: Int, compareAtPriceCents: Int? = nil,
                inventory: Int, weightOz: Double, dimensions: Dimensions, variants: [VariantDimension]?,
                caption: String? = nil, hashtags: [String]? = nil, category: ListingCategory = .other) {
        self.title = title
        self.description = description
        self.priceCents = priceCents
        self.compareAtPriceCents = compareAtPriceCents
        self.inventory = inventory
        self.weightOz = weightOz
        self.dimensions = dimensions
        self.variants = variants
        self.caption = caption
        self.hashtags = hashtags
        self.category = category
    }

    enum CodingKeys: String, CodingKey {
        case title, description
        case priceCents = "price_cents"
        case compareAtPriceCents = "compare_at_price_cents"
        case inventory
        case weightOz = "weight_oz"
        case dimensions, variants, caption, hashtags
        case category = "category_slug"
    }

    /// The server's zod rules, checked before a network round trip. The server
    /// re-validates; this only spares the creator a slow error.
    public func validationErrors() -> [String] {
        var errors: [String] = []
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { errors.append("Title is required") }
        if trimmed.count > 100 { errors.append("Title must be 100 characters or less") }
        if (description ?? "").count > 1000 { errors.append("Description must be 1000 characters or less") }
        if priceCents < 100 { errors.append("Minimum price is $1.00") }
        if priceCents > 99_999_900 { errors.append("Price too high") }
        if let was = compareAtPriceCents, was <= priceCents {
            errors.append("The \u{201C}was\u{201D} price must be higher than the price")
        }
        if inventory < 1 { errors.append("Inventory must be at least 1") }
        if inventory > 100_000 { errors.append("Inventory too high") }
        if weightOz < 0.1 || weightOz > 1120 { errors.append("Weight is required for shipping") }
        for d in [dimensions.lengthIn, dimensions.widthIn, dimensions.heightIn] where d < 0.1 || d > 108 {
            errors.append("Package dimensions must be between 0.1 and 108 inches")
            break
        }
        if let variants {
            if variants.count > 2 { errors.append("Max 2 variant dimensions") }
            for v in variants {
                if v.name.trimmingCharacters(in: .whitespaces).isEmpty { errors.append("Variant name is required") }
                if v.options.isEmpty { errors.append("At least one option required") }
                if v.options.count > 5 { errors.append("Max 5 options per variant") }
            }
        }
        if (caption ?? "").count > 500 { errors.append("Caption must be 500 characters or less") }
        if let hashtags {
            if hashtags.count > 10 { errors.append("Max 10 hashtags") }
            if hashtags.contains(where: { $0.isEmpty || $0.count > 30 }) { errors.append("Hashtags are 1 to 30 characters") }
        }
        return errors
    }

    /// "#tote, everyday rotation" → ["tote", "everydayrotation"]. The database
    /// normalises again (normalize_video_hashtags); this keeps the count honest.
    public static func hashtags(from text: String) -> [String] {
        var seen = Set<String>()
        return text.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" })
            .map { $0.lowercased().filter { $0.isLetter || $0.isNumber || $0 == "_" } }
            .map { String($0.prefix(30)) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}

public struct CreateListingResponse: Codable, Sendable, Equatable {
    public struct Video: Codable, Sendable, Equatable { public var id: String }
    public struct Product: Codable, Sendable, Equatable {
        public var id: String
        public var slug: String
    }
    public var video: Video
    public var product: Product
    public var uploadUrl: String

    enum CodingKeys: String, CodingKey {
        case video, product
        case uploadUrl = "upload_url"
    }
}

/// The `{ error, code? }` body every route returns on failure.
public struct ServerErrorBody: Codable, Sendable, Equatable {
    public var error: String
    public var code: String?
    public var available: Int?
}
