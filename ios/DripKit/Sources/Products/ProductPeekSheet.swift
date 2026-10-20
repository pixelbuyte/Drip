#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import DripModels
import DesignSystem

/// Frame 41 "Choose your shade": cream sheet at ~65% that grows from the
/// shelf while the video keeps playing above it. Image pager, serif title,
/// price, variant pickers (name + check, never colour alone), quantity,
/// shipping info, and the coral "Buy now · $X" with an ink label.
public struct ProductPeekSheet: View {
    @State private var selection: ProductSelection
    let sellerName: String
    let onBuy: (ProductSelection) -> Void
    let onAddToBag: ((ProductSelection) -> Void)?
    let onClose: () -> Void
    let onVariantSelected: (String) -> Void

    public init(product: FeedProduct, sellerName: String,
                onBuy: @escaping (ProductSelection) -> Void,
                onAddToBag: ((ProductSelection) -> Void)? = nil,
                onVariantSelected: @escaping (String) -> Void = { _ in },
                onClose: @escaping () -> Void) {
        self._selection = State(initialValue: ProductSelection(product: product))
        self.sellerName = sellerName
        self.onBuy = onBuy
        self.onAddToBag = onAddToBag
        self.onVariantSelected = onVariantSelected
        self.onClose = onClose
    }

    private var product: FeedProduct { selection.product }

    public var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: DripSpace.l) {
                    SheetHeader("", onClose: onClose)
                        .padding(.bottom, -DripSpace.l)
                    gallery
                    VStack(alignment: .leading, spacing: DripSpace.xs) {
                        Text(product.title).dripText(.title).foregroundStyle(DripColor.ink)
                            .accessibilityAddTraits(.isHeader)
                        PriceTag(price: selection.unitPrice, compareAt: product.compareAtPrice, showsSaleBadge: true)
                        stockLine
                    }
                    ForEach(product.variants) { group in
                        VariantPicker(group: group,
                                      selected: selection.selectedOption(in: group)?.id) { optionId in
                            selection.choose(optionId: optionId, in: group.id)
                            onVariantSelected(optionId)
                        }
                    }
                    HStack {
                        Text("Quantity").dripText(.product)
                        Spacer()
                        QuantityStepper(value: $selection.quantity, range: 1...selection.maxSelectableQuantity)
                    }
                    InfoRow(systemImage: "shippingbox", text: "Ships from \(sellerName) · Tracking by email")
                    Text("Sold and shipped by \(sellerName). Payment is processed securely by Stripe.")
                        .dripText(.meta).foregroundStyle(DripColor.muted)
                }
                .padding(.horizontal, DripSpace.inset)
                .padding(.top, DripSpace.xs)
            }
            buyBar
        }
        .background(DripColor.cream)
    }

    private var gallery: some View {
        TabView {
            if product.images.isEmpty {
                ZStack {
                    DripColor.peach
                    Image(systemName: "bag").font(.largeTitle).foregroundStyle(DripColor.muted)
                }
            } else {
                ForEach(product.images, id: \.self) { url in
                    RemoteImage(url)
                }
            }
        }
        .tabViewStyle(.page(indexDisplayMode: product.images.count > 1 ? .automatic : .never))
        .frame(height: 280)
        .clipShape(RoundedRectangle(cornerRadius: DripRadius.tile, style: .continuous))
        .accessibilityLabel("Photos of \(product.title)")
    }

    @ViewBuilder private var stockLine: some View {
        if product.isSoldOut {
            DripBadge("Sold out", style: .neutral)
        } else if product.isLowStock {
            Text("Only \(product.inventoryCount) left").dripText(.meta).foregroundStyle(DripColor.saleText)
        }
    }

    private var buyBar: some View {
        VStack(spacing: DripSpace.xs) {
            Button {
                onBuy(selection)
            } label: {
                Text(selection.isPurchasable ? "Buy now · \(selection.subtotal.formatted)" : (selection.blockingReason ?? "Unavailable"))
            }
            .buttonStyle(.drip(.primary))
            .disabled(!selection.isPurchasable)
            .accessibilityHint(selection.blockingReason ?? "Opens secure checkout")
            if let onAddToBag {
                Button("Add to bag") { onAddToBag(selection) }
                    .buttonStyle(.drip(.secondary))
                    .disabled(!selection.isPurchasable)
            }
        }
        .padding(.horizontal, DripSpace.inset)
        .padding(.vertical, DripSpace.s)
        .background(DripColor.cream.shadow(.drop(color: DripColor.ink.opacity(0.06), radius: 8, y: -4)))
    }
}

/// Option tiles: name always shown, coral border + ink check when selected,
/// struck and disabled when out of stock.
struct VariantPicker: View {
    let group: VariantGroup
    let selected: String?
    let onSelect: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DripSpace.xs) {
            HStack(spacing: 4) {
                Text(group.name).dripText(.product)
                if let s = group.options.first(where: { $0.id == selected }) {
                    Text("· \(s.value)").dripText(.meta).foregroundStyle(DripColor.muted)
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: DripSpace.xs) {
                    ForEach(group.options) { option in
                        let isOn = option.id == selected
                        let inStock = option.inventoryCount > 0
                        Button { onSelect(option.id) } label: {
                            HStack(spacing: 4) {
                                if isOn { Image(systemName: "checkmark").font(.caption.weight(.bold)) }
                                Text(option.value).strikethrough(!inStock)
                                if option.priceDeltaCents != 0 {
                                    Text((option.priceDeltaCents > 0 ? "+" : "−") + Money(cents: abs(option.priceDeltaCents)).formatted)
                                        .foregroundStyle(DripColor.muted)
                                }
                            }
                            .font(.drip(.meta).weight(.medium))
                            .foregroundStyle(inStock ? DripColor.ink : DripColor.muted)
                            .padding(.horizontal, DripSpace.m)
                            .frame(minHeight: DripSize.minHit)
                            .background(isOn ? DripColor.peach : DripColor.surface,
                                        in: RoundedRectangle(cornerRadius: DripRadius.field, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: DripRadius.field, style: .continuous)
                                .strokeBorder(isOn ? DripColor.coral : DripColor.hairlineStrong, lineWidth: isOn ? 2 : 1))
                        }
                        .buttonStyle(PressableStyle())
                        .disabled(!inStock)
                        .accessibilityLabel("\(group.name) \(option.value)\(inStock ? "" : ", sold out")")
                        .accessibilityAddTraits(isOn ? .isSelected : [])
                    }
                }
            }
        }
    }
}
#endif
