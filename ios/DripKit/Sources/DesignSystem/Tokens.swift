import Foundation

// Canonical source: docs/product-design/tokens.json (+ SPECIFICATION.md for
// what tokens.json leaves out). Pure values, no SwiftUI, so the contrast
// guarantees the design package claims are unit-tested on every platform.

public struct RGB: Sendable, Hashable {
    public let r: Double, g: Double, b: Double

    public init(hex: UInt32) {
        r = Double((hex >> 16) & 0xff) / 255
        g = Double((hex >> 8) & 0xff) / 255
        b = Double(hex & 0xff) / 255
    }

    /// WCAG 2.x relative luminance.
    public var luminance: Double {
        func channel(_ c: Double) -> Double {
            c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }

    public func contrast(with other: RGB) -> Double {
        let (a, b) = (luminance, other.luminance)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }
}

public enum DripPalette {
    public static let cream = RGB(hex: 0xFFF9F2)
    public static let ink = RGB(hex: 0x201A17)
    public static let muted = RGB(hex: 0x6E6259)
    public static let coral = RGB(hex: 0xFF4B2E)
    public static let coralText = RGB(hex: 0xC2410C)
    public static let lime = RGB(hex: 0xC7F03C)
    public static let lavender = RGB(hex: 0xE9DDFC)
    public static let pink = RGB(hex: 0xFADDE5)
    public static let peach = RGB(hex: 0xFFE0CC)
    public static let mint = RGB(hex: 0xDCEADB)
    public static let saleText = RGB(hex: 0xB52E18)
    public static let successText = RGB(hex: 0x245534)
    /// Not in tokens.json: rating stars (web --color-amber), ink text on fills only.
    public static let amber = RGB(hex: 0xFFB01F)
    public static let white = RGB(hex: 0xFFFFFF)
}

public enum DripSpace {
    public static let xxs: Double = 4
    public static let xs: Double = 8
    public static let s: Double = 12
    public static let m: Double = 16
    public static let l: Double = 20
    public static let xl: Double = 24
    public static let xxl: Double = 32
    public static let xxxl: Double = 40
    public static let huge: Double = 48
    /// Screen edge inset.
    public static let inset: Double = 20
    public static let insetCompact: Double = 16
}

public enum DripRadius {
    public static let thumbnail: Double = 8
    public static let field: Double = 12
    public static let tile: Double = 16
    public static let media: Double = 24
    public static let sheet: Double = 28
    public static let pill: Double = 999
}

public enum DripSize {
    public static let minHit: Double = 44
    public static let preferredHit: Double = 48
    public static let button: Double = 52
    public static let chipVisual: Double = 40
    public static let avatarSmall: Double = 32
    public static let avatarMedium: Double = 40
    public static let avatarLarge: Double = 56
    public static let avatarHero: Double = 88
    public static let shelfThumb: Double = 56
    public static let tabBar: Double = 64
    public static let dropButton: Double = 48
    public static let likeBurstMax: Double = 52
}

public struct TypeSpec: Sendable, Hashable {
    public let size: Double
    public let lineHeight: Double
}

public enum DripTypeScale {
    public static let display = TypeSpec(size: 48, lineHeight: 50)
    public static let title = TypeSpec(size: 32, lineHeight: 36)
    public static let section = TypeSpec(size: 24, lineHeight: 28)
    public static let product = TypeSpec(size: 18, lineHeight: 24)
    public static let body = TypeSpec(size: 16, lineHeight: 24)
    public static let meta = TypeSpec(size: 14, lineHeight: 20)
    public static let nav = TypeSpec(size: 13, lineHeight: 16)
}

public enum DripMotionSpec {
    public static let pressMs = 80.0
    public static let releaseMs = 120.0
    public static let likeMs = 260.0
    public static let followMs = 180.0
    public static let saveMs = 200.0
    public static let peekMs = 320.0
    public static let commentsMs = 300.0
    public static let checkoutMs = 300.0
    public static let tabMs = 180.0
    public static let successMs = 360.0
    /// Reduce Motion: nothing longer than this, and no transforms.
    public static let reducedMotionMaxMs = 100.0
    /// cubic-bezier(.2,.8,.2,1)
    public static let standardCurve = (x1: 0.2, y1: 0.8, x2: 0.2, y2: 1.0)
    public static let commentsDetents: [Double] = [0.25, 0.6, 0.9]
    public static let peekDetent = 0.65
    public static let doubleTapWindow = 0.28

    /// Duration to actually use, honouring Reduce Motion.
    public static func duration(_ ms: Double, reduceMotion: Bool) -> Double {
        (reduceMotion ? min(ms, reducedMotionMaxMs) : ms) / 1000
    }
}
