#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import DripModels
import DesignSystem
import Products

/// Frame 42 "Make it yours." → frame 24 "It's yours."
public struct CheckoutSheet: View {
    @Bindable var model: CheckoutModel
    let onDone: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var emailFocused: Bool

    public init(model: CheckoutModel, onDone: @escaping () -> Void) {
        self.model = model
        self.onDone = onDone
    }

    public var body: some View {
        Group {
            if case .succeeded(let intent) = model.phase {
                success(intent)
            } else {
                form
            }
        }
        .background(DripColor.cream)
        .task { await model.open() }
        .animation(DripMotion.sheet(reduceMotion: reduceMotion), value: model.phase)
    }

    private var form: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: DripSpace.l) {
                    SheetHeader("Make it yours.") { Task { await model.close(); onDone() } }
                    lineItem
                    VStack(alignment: .leading, spacing: DripSpace.xs) {
                        Text("Email for receipt & tracking").dripText(.meta).foregroundStyle(DripColor.muted)
                        TextField("you@example.com", text: $model.email)
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($emailFocused)
                            .submitLabel(.continue)
                            .onSubmit { Task { await model.quote() } }
                            .dripText(.body)
                            .padding(DripSpace.s)
                            .frame(minHeight: DripSize.preferredHit)
                            .background(DripColor.surface, in: RoundedRectangle(cornerRadius: DripRadius.field, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: DripRadius.field, style: .continuous)
                                .strokeBorder(DripColor.hairlineStrong))
                    }
                    summary
                    statusMessage
                }
                .padding(.horizontal, DripSpace.inset)
                .padding(.top, DripSpace.s)
            }
            actionBar
        }
    }

    private var lineItem: some View {
        HStack(spacing: DripSpace.s) {
            RemoteImage(model.selection.product.images.first)
                .frame(width: DripSize.shelfThumb, height: DripSize.shelfThumb)
                .clipShape(RoundedRectangle(cornerRadius: DripRadius.thumbnail, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(model.selection.product.title).dripText(.product).foregroundStyle(DripColor.ink)
                Text([model.selection.summary, "Qty \(model.selection.quantity)"].filter { !$0.isEmpty }.joined(separator: " · "))
                    .dripText(.meta).foregroundStyle(DripColor.muted)
            }
            Spacer()
            Text(model.selection.subtotal.formatted).dripText(.price)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var summary: some View {
        if let intent = currentIntent {
            VStack(spacing: DripSpace.xs) {
                row("Subtotal", Money(cents: intent.subtotalCents).formatted)
                row("Shipping", intent.shippingCents == 0 ? "Free" : Money(cents: intent.shippingCents).formatted)
                Divider().overlay(DripColor.hairlineStrong)
                row("Total", Money(cents: intent.totalCents).formatted, bold: true)
            }
            .accessibilityElement(children: .combine)
        } else {
            InfoRow(systemImage: "shippingbox", text: "Shipping is calculated from the seller's address.")
        }
    }

    private func row(_ label: String, _ value: String, bold: Bool = false) -> some View {
        HStack {
            Text(label).dripText(bold ? .product : .body)
            Spacer()
            Text(value).dripText(bold ? .price : .body)
        }
        .foregroundStyle(DripColor.ink)
    }

    @ViewBuilder private var statusMessage: some View {
        switch model.phase {
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.circle")
                .dripText(.meta).foregroundStyle(DripColor.saleText)
        case .soldOut(let available):
            Label(available.map { $0 > 0 ? "Only \($0) left — lower the quantity." : "Sold out." } ?? "Sold out.",
                  systemImage: "xmark.circle")
                .dripText(.meta).foregroundStyle(DripColor.saleText)
        default:
            EmptyView()
        }
    }

    private var actionBar: some View {
        VStack(spacing: DripSpace.xs) {
            switch model.phase {
            case .ready(let intent):
                Button("Buy now · \(Money(cents: intent.totalCents).formatted)") { Task { await model.pay() } }
                    .buttonStyle(.drip(.primary))
            case .quoting, .paying:
                Button { } label: { ProgressView().tint(DripColor.ink) }
                    .buttonStyle(.drip(.primary)).disabled(true)
                    .accessibilityLabel("Working")
            case .soldOut:
                Button("Close") { Task { await model.close(); onDone() } }.buttonStyle(.drip(.secondary))
            default:
                Button("Continue to payment") { emailFocused = false; Task { await model.quote() } }
                    .buttonStyle(.drip(.primary))
                    .disabled(!model.isEmailValid)
            }
            Label("Secure checkout by Stripe · You won't be charged until you confirm.", systemImage: "lock.fill")
                .dripText(.meta).foregroundStyle(DripColor.muted)
        }
        .padding(.horizontal, DripSpace.inset)
        .padding(.vertical, DripSpace.s)
    }

    private var currentIntent: PaymentIntentResponse? {
        switch model.phase {
        case .ready(let i), .paying(let i), .succeeded(let i): return i
        default: return nil
        }
    }

    private func success(_ intent: PaymentIntentResponse) -> some View {
        VStack(spacing: DripSpace.l) {
            Spacer()
            Image(systemName: "checkmark")
                .font(.system(size: 34, weight: .bold))
                .foregroundStyle(DripColor.ink)
                .frame(width: 88, height: 88)
                .background(DripColor.coral, in: Circle())
                .accessibilityHidden(true)
            Text("It's yours.").dripText(.display).foregroundStyle(DripColor.ink)
            Text("\(intent.title) from @\(intent.sellerHandle). A receipt is on its way to \(model.email), and tracking follows when it ships.")
                .dripText(.body).foregroundStyle(DripColor.muted).multilineTextAlignment(.center)
            Spacer()
            Button("Back to your feed", action: onDone).buttonStyle(.drip(.primary))
        }
        .padding(DripSpace.inset)
        .sensoryFeedback(.success, trigger: true)
    }
}

/// The bag: each line checks out on its own (one PaymentIntent per product).
public struct BagView: View {
    @Bindable var bag: BagStore
    let onCheckout: (BagLine) -> Void
    let onClose: () -> Void

    public init(bag: BagStore, onCheckout: @escaping (BagLine) -> Void, onClose: @escaping () -> Void) {
        self.bag = bag
        self.onCheckout = onCheckout
        self.onClose = onClose
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetHeader("Your bag") { onClose() }
                .padding(.horizontal, DripSpace.inset)
            if bag.lines.isEmpty {
                EmptyStateView("Nothing here yet.", message: "Tap Peek on anything in your feed to add it.",
                               systemImage: "bag")
            } else {
                List {
                    ForEach(bag.lines) { line in
                        BagLineRow(line: line,
                                   onQuantity: { bag.setQuantity($0, for: line.id) },
                                   onCheckout: { onCheckout(line) })
                            .listRowBackground(DripColor.cream)
                    }
                    .onDelete { offsets in
                        let ids = offsets.map { bag.lines[$0].id }
                        for id in ids { bag.remove(id) }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                Text("Each item is sold and shipped by its creator, so each checks out separately. Prices are confirmed at checkout.")
                    .dripText(.meta).foregroundStyle(DripColor.muted)
                    .padding(DripSpace.inset)
            }
        }
        .background(DripColor.cream)
    }
}

struct BagLineRow: View {
    let line: BagLine
    let onQuantity: (Int) -> Void
    let onCheckout: () -> Void

    var body: some View {
        let selection = line.selection
        VStack(alignment: .leading, spacing: DripSpace.s) {
            HStack(spacing: DripSpace.s) {
                RemoteImage(line.product.images.first)
                    .frame(width: 64, height: 64)
                    .clipShape(RoundedRectangle(cornerRadius: DripRadius.thumbnail, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(line.product.title).dripText(.product)
                    Text(["@\(line.sellerHandle)", selection.summary].filter { !$0.isEmpty }.joined(separator: " · "))
                        .dripText(.meta).foregroundStyle(DripColor.muted)
                    Text(selection.subtotal.formatted).dripText(.price)
                }
            }
            HStack {
                QuantityStepper(value: Binding(get: { line.quantity }, set: onQuantity),
                                range: 1...selection.maxSelectableQuantity)
                Spacer()
                Button("Checkout", action: onCheckout)
                    .buttonStyle(PillButtonStyle())
                    .disabled(!selection.isPurchasable)
            }
        }
        .padding(.vertical, DripSpace.xs)
    }
}
#endif
