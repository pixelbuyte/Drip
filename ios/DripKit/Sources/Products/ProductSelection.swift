import Foundation
import DripModels

/// The buyer's choices for one product. Prices shown here are previews: the
/// server recomputes the charge from the stored product (checkout/intent
/// route) and the client never sends an amount.
public struct ProductSelection: Sendable, Equatable {
    /// The server's cap (`quantity: z.number().int().min(1).max(10)`).
    public static let maxQuantity = 10

    public let product: FeedProduct
    /// Group id → option id.
    public private(set) var chosen: [String: String] = [:]
    public var quantity: Int = 1 {
        didSet { quantity = min(max(1, quantity), maxSelectableQuantity) }
    }

    public init(product: FeedProduct) {
        self.product = product
        // A group with exactly one in-stock option is not a choice.
        for group in product.variants {
            let available = group.options.filter { $0.inventoryCount > 0 }
            if available.count == 1 { chosen[group.id] = available[0].id }
        }
    }

    public mutating func choose(optionId: String, in groupId: String) {
        guard let group = product.variants.first(where: { $0.id == groupId }),
              let option = group.options.first(where: { $0.id == optionId }),
              option.inventoryCount > 0 else { return }
        chosen[groupId] = optionId
        quantity = min(quantity, maxSelectableQuantity)
    }

    public func selectedOption(in group: VariantGroup) -> VariantOption? {
        chosen[group.id].flatMap { id in group.options.first { $0.id == id } }
    }

    public func isAvailable(_ option: VariantOption) -> Bool { option.inventoryCount > 0 }

    /// Groups still needing a choice, in display order.
    public var missingGroups: [VariantGroup] {
        product.variants.filter { chosen[$0.id] == nil }
    }

    public var isComplete: Bool { missingGroups.isEmpty }

    public var unitPrice: Money {
        let delta = product.variants.compactMap { selectedOption(in: $0)?.priceDeltaCents }.reduce(0, +)
        return Money(cents: product.priceCents + delta)
    }

    public var subtotal: Money { unitPrice * quantity }

    public var maxSelectableQuantity: Int {
        var cap = min(Self.maxQuantity, max(product.inventoryCount, 0))
        for group in product.variants {
            if let o = selectedOption(in: group) { cap = min(cap, o.inventoryCount) }
        }
        return max(cap, 1)
    }

    public var isPurchasable: Bool {
        !product.isSoldOut && isComplete && maxSelectableQuantity >= quantity
    }

    /// The checkout route's `selection`: group *name* → option *value*.
    public var serverSelection: [String: String]? {
        var out: [String: String] = [:]
        for group in product.variants {
            if let o = selectedOption(in: group) { out[group.name] = o.value }
        }
        return out.isEmpty ? nil : out
    }

    /// "Chocolate · M" for line items.
    public var summary: String {
        product.variants.compactMap { selectedOption(in: $0)?.value }.joined(separator: " · ")
    }

    /// Why the Buy button is disabled, for its accessibility hint and label.
    public var blockingReason: String? {
        if product.isSoldOut { return "Sold out" }
        if let g = missingGroups.first { return "Choose a \(g.name.lowercased())" }
        return nil
    }
}
