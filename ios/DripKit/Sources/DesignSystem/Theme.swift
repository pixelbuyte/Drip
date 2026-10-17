#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
#if canImport(CoreText)
import CoreText
#endif

public extension Color {
    init(_ rgb: RGB, opacity: Double = 1) {
        self.init(.sRGB, red: rgb.r, green: rgb.g, blue: rgb.b, opacity: opacity)
    }
}

/// Light-only for v1: tokens.json defines no dark palette and every frame is
/// cream. Media surfaces use white-on-scrim regardless of system appearance.
public enum DripColor {
    public static let cream = Color(DripPalette.cream)
    public static let ink = Color(DripPalette.ink)
    public static let muted = Color(DripPalette.muted)
    public static let coral = Color(DripPalette.coral)
    public static let coralText = Color(DripPalette.coralText)
    public static let lime = Color(DripPalette.lime)
    public static let lavender = Color(DripPalette.lavender)
    public static let pink = Color(DripPalette.pink)
    public static let peach = Color(DripPalette.peach)
    public static let mint = Color(DripPalette.mint)
    public static let saleText = Color(DripPalette.saleText)
    public static let successText = Color(DripPalette.successText)
    public static let amber = Color(DripPalette.amber)
    public static let surface = Color.white
    public static let hairline = Color(DripPalette.ink, opacity: 0.06)
    public static let hairlineStrong = Color(DripPalette.ink, opacity: 0.12)
    public static let scrim = Color.black.opacity(0.45)
}

// MARK: - Typography

public enum DripTextStyle: Sendable {
    case display, title, titleSans, section, product, body, button, meta, nav, eyebrow, price

    var spec: TypeSpec {
        switch self {
        case .display: return DripTypeScale.display
        case .title, .titleSans: return DripTypeScale.title
        case .section: return DripTypeScale.section
        case .product, .price: return DripTypeScale.product
        case .body, .button: return DripTypeScale.body
        case .meta: return DripTypeScale.meta
        case .nav: return DripTypeScale.nav
        case .eyebrow: return TypeSpec(size: 12, lineHeight: 16)
        }
    }

    var fontName: String {
        switch self {
        case .display, .title, .section: return "InstrumentSerif-Regular"
        case .product, .button, .eyebrow: return "DMSans-SemiBold"
        case .titleSans, .price: return "DMSans-Bold"
        case .nav: return "DMSans-Medium"
        case .body, .meta: return "DMSans-Regular"
        }
    }

    var relativeTo: Font.TextStyle {
        switch self {
        case .display: return .largeTitle
        case .title, .titleSans: return .title
        case .section: return .title2
        case .product, .price: return .headline
        case .body, .button: return .body
        case .meta: return .subheadline
        case .nav: return .caption
        case .eyebrow: return .caption2
        }
    }
}

public extension Font {
    /// Scales with Dynamic Type relative to the matching system style.
    static func drip(_ style: DripTextStyle) -> Font {
        .custom(style.fontName, size: style.spec.size, relativeTo: style.relativeTo)
    }
}

public extension View {
    /// Font + the token's line height + per-style tracking/numerics.
    func dripText(_ style: DripTextStyle) -> some View {
        let spec = style.spec
        return self
            .font(.drip(style))
            .lineSpacing(max(0, spec.lineHeight - spec.size * 1.2))
            .tracking(style == .eyebrow ? 1.6 : (style == .display ? -0.5 : 0))
            .textCase(style == .eyebrow ? .uppercase : nil)
            .monospacedDigit()
    }
}

public enum DripFonts {
    static let files = [
        "InstrumentSerif-Regular", "InstrumentSerif-Italic",
        "DMSans-Regular", "DMSans-Medium", "DMSans-SemiBold", "DMSans-Bold",
    ]

    /// Registers the bundled OFL fonts. Call once at launch with the bundle
    /// that holds them (the app bundle). Safe to call repeatedly.
    public static func register(in bundle: Bundle) {
        #if canImport(CoreText)
        for name in files {
            guard let url = bundle.url(forResource: name, withExtension: "ttf") else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
        #endif
    }
}

// MARK: - Motion

public enum DripMotion {
    public static func standard(_ ms: Double, reduceMotion: Bool = false) -> Animation {
        if reduceMotion { return .easeOut(duration: DripMotionSpec.duration(ms, reduceMotion: true)) }
        let c = DripMotionSpec.standardCurve
        return .timingCurve(c.x1, c.y1, c.x2, c.y2, duration: ms / 1000)
    }

    public static func sheet(reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeOut(duration: 0.1) : .spring(duration: 0.3, bounce: 0)
    }

    public static let commentsDetents: Set<PresentationDetent> =
        Set(DripMotionSpec.commentsDetents.map { .fraction($0) })
    public static let peekDetent = PresentationDetent.fraction(DripMotionSpec.peekDetent)
}

// MARK: - Elevation

public enum DripElevation {
    case card, floatingShelf, sheet
}

public extension View {
    func dripShadow(_ e: DripElevation) -> some View {
        switch e {
        case .card: return shadow(color: DripColor.ink.opacity(0.06), radius: 8, y: 4)
        case .floatingShelf: return shadow(color: DripColor.ink.opacity(0.12), radius: 14, y: 8)
        case .sheet: return shadow(color: DripColor.ink.opacity(0.14), radius: 16, y: -8)
        }
    }
}
#endif
