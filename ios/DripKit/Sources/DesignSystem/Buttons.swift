#if canImport(SwiftUI)
import SwiftUI

public enum DripButtonKind: Sendable {
    /// Coral, ink label — purchase and the single primary action.
    case primary
    /// Cream with an ink border.
    case secondary
    /// Ink fill, cream label.
    case ink
    /// Peach fill, ink label.
    case tonal
    /// White outline on video.
    case onMedia
}

/// Capsule, 52pt, DM Sans semibold 16. Coral never carries a white label
/// (ink/coral is 5.16:1; white/coral fails AA).
public struct DripButtonStyle: ButtonStyle {
    let kind: DripButtonKind
    let fullWidth: Bool
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ kind: DripButtonKind = .primary, fullWidth: Bool = true) {
        self.kind = kind
        self.fullWidth = fullWidth
    }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .dripText(.button)
            .foregroundStyle(foreground)
            .padding(.horizontal, DripSpace.xl)
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: DripSize.button)
            .background(background, in: Capsule())
            .overlay(Capsule().strokeBorder(border, lineWidth: kind == .secondary || kind == .onMedia ? 1.5 : 0))
            .opacity(isEnabled ? 1 : 0.45)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(DripMotion.standard(configuration.isPressed ? DripMotionSpec.pressMs : DripMotionSpec.releaseMs,
                                           reduceMotion: reduceMotion),
                       value: configuration.isPressed)
            .contentShape(Capsule())
    }

    private var foreground: Color {
        switch kind {
        case .primary, .secondary, .tonal: return DripColor.ink
        case .ink: return DripColor.cream
        case .onMedia: return .white
        }
    }

    private var background: Color {
        switch kind {
        case .primary: return DripColor.coral
        case .secondary: return DripColor.cream
        case .ink: return DripColor.ink
        case .tonal: return DripColor.peach
        case .onMedia: return Color.black.opacity(0.18)
        }
    }

    private var border: Color {
        switch kind {
        case .secondary: return DripColor.ink
        case .onMedia: return .white
        default: return .clear
        }
    }
}

public extension ButtonStyle where Self == DripButtonStyle {
    static func drip(_ kind: DripButtonKind = .primary, fullWidth: Bool = true) -> DripButtonStyle {
        DripButtonStyle(kind, fullWidth: fullWidth)
    }
}

/// Small pill used on the shelf ("Peek", "Shop") and as follow chips.
public struct PillButtonStyle: ButtonStyle {
    let fill: Color
    let foreground: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(fill: Color = DripColor.coral, foreground: Color = DripColor.ink) {
        self.fill = fill
        self.foreground = foreground
    }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.drip(.button))
            .foregroundStyle(foreground)
            .padding(.horizontal, DripSpace.m)
            .frame(minHeight: 36)
            .background(fill, in: Capsule())
            .frame(minWidth: DripSize.minHit, minHeight: DripSize.minHit)
            .contentShape(Rectangle())
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .animation(DripMotion.standard(DripMotionSpec.pressMs, reduceMotion: reduceMotion),
                       value: configuration.isPressed)
    }
}

/// Removes the default highlight and adds the press scale — for icon buttons.
public struct PressableStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.92 : 1)
            .animation(DripMotion.standard(DripMotionSpec.pressMs, reduceMotion: reduceMotion),
                       value: configuration.isPressed)
    }
}
#endif
