#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import DripModels

/// "drip" + coral dot. Text, not an image, so it scales and stays crisp;
/// swap for the brand asset when one exists.
public struct DripWordmark: View {
    public init() {}
    public var body: some View {
        HStack(alignment: .lastTextBaseline, spacing: 0) {
            Text("drip").font(.custom("DMSans-Bold", size: 26, relativeTo: .title2)).tracking(-1)
            Circle().fill(DripColor.coral).frame(width: 7, height: 7).offset(y: -2)
        }
        .foregroundStyle(DripColor.ink)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Drip")
        .accessibilityAddTraits(.isHeader)
    }
}

/// Current price bold; an earlier price struck through in muted; optional
/// sale badge. Always tabular digits.
public struct PriceTag: View {
    let price: Money
    let compareAt: Money?
    let showsSaleBadge: Bool

    public init(price: Money, compareAt: Money? = nil, showsSaleBadge: Bool = false) {
        self.price = price
        self.compareAt = compareAt
        self.showsSaleBadge = showsSaleBadge
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DripSpace.xs) {
            Text(price.formatted).dripText(.price).foregroundStyle(DripColor.ink)
            if let compareAt, compareAt > price {
                Text(compareAt.formatted).dripText(.meta).strikethrough().foregroundStyle(DripColor.muted)
                if showsSaleBadge, let pct = price.percentOff(from: compareAt) {
                    DripBadge("−\(pct)%", style: .sale)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        if let compareAt, compareAt > price {
            return "\(price.formatted), was \(compareAt.formatted)"
        }
        return price.formatted
    }
}

public struct DripBadge: View {
    public enum Style: Sendable { case new, sale, success, neutral }
    let text: String
    let style: Style

    public init(_ text: String, style: Style = .new) {
        self.text = text
        self.style = style
    }

    public var body: some View {
        Text(text)
            .dripText(.eyebrow)
            .foregroundStyle(foreground)
            .padding(.horizontal, DripSpace.xs)
            .padding(.vertical, 4)
            .background(background, in: Capsule())
    }

    private var foreground: Color {
        switch style {
        case .new: return DripColor.ink
        case .sale: return DripColor.saleText
        case .success: return DripColor.successText
        case .neutral: return DripColor.ink
        }
    }

    private var background: Color {
        switch style {
        case .new: return DripColor.lime
        case .sale: return DripColor.peach
        case .success: return DripColor.mint
        case .neutral: return DripColor.cream
        }
    }
}

/// Async image with a token-coloured placeholder; never a blank hole.
public struct RemoteImage: View {
    let url: URL?
    let contentMode: ContentMode

    public init(_ string: String?, contentMode: ContentMode = .fill) {
        self.url = string.flatMap(URL.init(string:))
        self.contentMode = contentMode
    }

    public var body: some View {
        AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.15))) { phase in
            switch phase {
            case .success(let image):
                image.resizable().aspectRatio(contentMode: contentMode)
            case .failure:
                ZStack {
                    DripColor.peach
                    Image(systemName: "photo").foregroundStyle(DripColor.muted)
                }
            default:
                DripColor.peach.opacity(0.6)
            }
        }
        .clipped()
        .accessibilityHidden(true)
    }
}

public struct CreatorAvatar: View {
    let url: String?
    let name: String
    let size: Double
    let ringed: Bool

    public init(url: String?, name: String, size: Double = DripSize.avatarMedium, ringed: Bool = false) {
        self.url = url
        self.name = name
        self.size = size
        self.ringed = ringed
    }

    public var body: some View {
        ZStack {
            if url != nil {
                RemoteImage(url)
            } else {
                DripColor.lavender
                Text(String(name.prefix(1)).uppercased())
                    .font(.custom("DMSans-SemiBold", size: size * 0.42))
                    .foregroundStyle(DripColor.ink)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(.white, lineWidth: ringed ? 2 : 0))
        .accessibilityLabel(name)
    }
}

/// Follow → ✓ Following (mint). Optimistic: the parent flips state at once
/// and rolls back on failure.
public struct FollowButton: View {
    let isFollowing: Bool
    let onMedia: Bool
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(isFollowing: Bool, onMedia: Bool = false, action: @escaping () -> Void) {
        self.isFollowing = isFollowing
        self.onMedia = onMedia
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: isFollowing ? "checkmark" : "person.badge.plus")
                Text(isFollowing ? "Following" : "Follow")
            }
            .font(.drip(.meta).weight(.semibold))
            .foregroundStyle(isFollowing ? DripColor.successText : (onMedia ? .white : DripColor.ink))
            .padding(.horizontal, DripSpace.s)
            .frame(minHeight: 32)
            .background(isFollowing ? DripColor.mint : .clear, in: Capsule())
            .overlay(Capsule().strokeBorder(isFollowing ? .clear : (onMedia ? .white : DripColor.ink), lineWidth: 1.5))
            .frame(minHeight: DripSize.minHit)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
        .animation(DripMotion.standard(DripMotionSpec.followMs, reduceMotion: reduceMotion), value: isFollowing)
        .sensoryFeedback(.selection, trigger: isFollowing)
        .accessibilityLabel(isFollowing ? "Following" : "Follow")
        .accessibilityHint(isFollowing ? "Double tap to unfollow" : "")
    }
}

/// One horizontal social action (heart, comment, bookmark, share): icon plus
/// an optional count, a full 44pt target each (frame 40's social row).
public struct SocialActionButton: View {
    public enum Kind: Sendable { case like, comment, save, share }
    let kind: Kind
    let isActive: Bool
    let count: Int?
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ kind: Kind, isActive: Bool = false, count: Int? = nil, action: @escaping () -> Void) {
        self.kind = kind
        self.isActive = isActive
        self.count = count
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: symbol)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(tint)
                    .symbolEffect(.bounce, value: reduceMotion ? false : isActive)
                if let count {
                    Text(Self.compact(count)).dripText(.meta).foregroundStyle(.white)
                }
            }
            .frame(minWidth: DripSize.minHit, minHeight: DripSize.minHit)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
        .sensoryFeedback(.impact(weight: .light), trigger: isActive)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    private var symbol: String {
        switch kind {
        case .like: return isActive ? "heart.fill" : "heart"
        case .comment: return "bubble.right"
        case .save: return isActive ? "bookmark.fill" : "bookmark"
        case .share: return "square.and.arrow.up"
        }
    }

    private var tint: Color {
        switch kind {
        case .like where isActive: return DripColor.coral
        default: return .white
        }
    }

    private var label: String {
        switch kind {
        case .like: return isActive ? "Liked" : "Like"
        case .comment: return "Comments"
        case .save: return isActive ? "Saved" : "Save"
        case .share: return "Share"
        }
    }

    /// 12400 → "12.4K" (see `CountFormat`).
    public static func compact(_ n: Int) -> String { CountFormat.compact(n) }
}

public struct DripChip: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    public init(_ title: String, isSelected: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.isSelected = isSelected
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Text(title)
                .font(.drip(.meta).weight(.medium))
                .foregroundStyle(isSelected ? DripColor.cream : DripColor.ink)
                .padding(.horizontal, DripSpace.m)
                .frame(minHeight: DripSize.chipVisual)
                .background(isSelected ? DripColor.ink : DripColor.peach.opacity(0.7), in: Capsule())
                .frame(minHeight: DripSize.minHit)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

public struct SectionHeader: View {
    let title: String
    let actionTitle: String?
    let action: (() -> Void)?

    public init(_ title: String, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.title = title
        self.actionTitle = actionTitle
        self.action = action
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).dripText(.section).foregroundStyle(DripColor.ink).accessibilityAddTraits(.isHeader)
            Spacer()
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.drip(.meta).weight(.semibold))
                    .foregroundStyle(DripColor.coralText)
                    .frame(minHeight: DripSize.minHit)
            }
        }
    }
}

public struct InfoRow: View {
    let systemImage: String
    let text: String

    public init(systemImage: String, text: String) {
        self.systemImage = systemImage
        self.text = text
    }

    public var body: some View {
        HStack(spacing: DripSpace.s) {
            Image(systemName: systemImage).foregroundStyle(DripColor.ink)
            Text(text).dripText(.meta).foregroundStyle(DripColor.ink)
            Spacer(minLength: 0)
        }
        .padding(DripSpace.s)
        .background(DripColor.peach.opacity(0.55), in: RoundedRectangle(cornerRadius: DripRadius.field, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

public struct QuantityStepper: View {
    @Binding var value: Int
    let range: ClosedRange<Int>

    public init(value: Binding<Int>, range: ClosedRange<Int>) {
        self._value = value
        self.range = range
    }

    public var body: some View {
        HStack(spacing: 0) {
            stepButton("minus", enabled: value > range.lowerBound) { value -= 1 }
            Text("\(value)").dripText(.product).frame(minWidth: 32)
                .accessibilityHidden(true)
            stepButton("plus", enabled: value < range.upperBound) { value += 1 }
        }
        .foregroundStyle(DripColor.ink)
        .overlay(Capsule().strokeBorder(DripColor.hairlineStrong, lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Quantity")
        .accessibilityValue("\(value)")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: if value < range.upperBound { value += 1 }
            case .decrement: if value > range.lowerBound { value -= 1 }
            @unknown default: break
            }
        }
    }

    private func stepButton(_ symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).frame(width: DripSize.minHit, height: DripSize.minHit)
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
    }
}

/// Sheet title row with a 44pt close button.
public struct SheetHeader: View {
    let title: String
    let onClose: () -> Void

    public init(_ title: String, onClose: @escaping () -> Void) {
        self.title = title
        self.onClose = onClose
    }

    public var body: some View {
        HStack {
            Text(title).dripText(.section).foregroundStyle(DripColor.ink).accessibilityAddTraits(.isHeader)
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(DripColor.ink)
                    .frame(width: DripSize.minHit, height: DripSize.minHit)
            }
            .accessibilityLabel("Close")
        }
    }
}
#endif
