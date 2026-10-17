import Foundation

/// GET /api/me/orders — src/lib/buyer-orders.ts (`BuyerOrder`).
public struct BuyerOrdersResponse: Codable, Sendable, Equatable {
    public var orders: [BuyerOrder]
    public init(orders: [BuyerOrder]) { self.orders = orders }
}

public struct BuyerOrder: Codable, Sendable, Equatable, Identifiable {
    public struct Seller: Codable, Sendable, Equatable {
        public var handle: String?
        public var displayName: String?
    }

    public struct Item: Codable, Sendable, Equatable {
        public var title: String
        public var variant: String?
        public var quantity: Int
        public var unitPriceCents: Int
        public var imageUrl: String?
    }

    public var id: String
    public var createdAt: String
    public var status: String
    public var totalCents: Int
    public var shippingCents: Int
    public var trackingCode: String?
    public var seller: Seller
    public var items: [Item]

    public var total: Money { Money(cents: totalCents) }

    /// Buyer-facing wording for `orders.status` (00007 status vocabulary).
    public var statusLabel: String {
        switch status {
        case "paid": return "Paid · getting ready"
        case "label_created": return "Packed · label printed"
        case "shipped": return "On its way"
        case "delivered": return "Delivered"
        case "refunded": return "Refunded"
        case "canceled": return "Canceled"
        case "disputed": return "Under review"
        default: return status.capitalized
        }
    }

    /// One line for a list row: "The Studio Tote" or "The Studio Tote + 2 more".
    public var summary: String {
        guard let first = items.first else { return "Order" }
        return items.count > 1 ? "\(first.title) + \(items.count - 1) more" : first.title
    }

    public var sellerName: String {
        seller.displayName ?? seller.handle.map { "@\($0)" } ?? "Drip seller"
    }
}
