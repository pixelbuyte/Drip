import Foundation
import Observation
import DripModels
import Products

/// One line in the bag: the product as last seen, where it was seen, and the
/// buyer's choices. Prices are re-quoted by the server at checkout.
public struct BagLine: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var videoId: String
    public var sellerHandle: String
    public var product: FeedProduct
    /// Group id → option id.
    public var chosen: [String: String]
    public var quantity: Int
    public var addedAt: Date

    public var selection: ProductSelection {
        var s = ProductSelection(product: product)
        for (g, o) in chosen { s.choose(optionId: o, in: g) }
        s.quantity = quantity
        return s
    }
}

/// On-device bag. The backend charges one product per PaymentIntent
/// (checkout/intent), so each line checks out on its own; a combined
/// multi-seller checkout needs a server cart (docs/DRIP_IOS_ROADMAP.md).
@MainActor
@Observable
public final class BagStore {
    public private(set) var lines: [BagLine] = []
    private let fileURL: URL?

    public init(fileURL: URL? = BagStore.defaultURL) {
        self.fileURL = fileURL
        if let fileURL, let data = try? Data(contentsOf: fileURL),
           let saved = try? JSONDecoder().decode([BagLine].self, from: data) {
            lines = saved
        }
    }

    public nonisolated static var defaultURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("bag.json")
    }

    public var count: Int { lines.reduce(0) { $0 + $1.quantity } }

    public var estimatedSubtotal: Money {
        lines.reduce(Money(cents: 0)) { $0 + $1.selection.subtotal }
    }

    public func add(_ selection: ProductSelection, videoId: String, sellerHandle: String) {
        let key = Self.lineId(productId: selection.product.id, chosen: selection.chosen)
        if let i = lines.firstIndex(where: { $0.id == key }) {
            lines[i].quantity = min(lines[i].quantity + selection.quantity, ProductSelection.maxQuantity)
        } else {
            lines.insert(BagLine(id: key, videoId: videoId, sellerHandle: sellerHandle,
                                 product: selection.product, chosen: selection.chosen,
                                 quantity: selection.quantity, addedAt: Date()), at: 0)
        }
        persist()
    }

    public func setQuantity(_ quantity: Int, for id: String) {
        guard let i = lines.firstIndex(where: { $0.id == id }) else { return }
        lines[i].quantity = min(max(1, quantity), ProductSelection.maxQuantity)
        persist()
    }

    public func remove(_ id: String) {
        lines.removeAll { $0.id == id }
        persist()
    }

    static func lineId(productId: String, chosen: [String: String]) -> String {
        ([productId] + chosen.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }).joined(separator: "|")
    }

    private func persist() {
        guard let fileURL else { return }
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? JSONEncoder().encode(lines).write(to: fileURL, options: [.atomic])
    }
}
