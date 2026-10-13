import Foundation

/// Compact social counts with one truncated decimal below 100K/1M.
/// Examples: 12_400 → "12.4K", 12_490 → "12.4K", 250_000 → "250K".
public enum CountFormat {
    public static func compact(_ count: Int) -> String {
        let count = max(0, count)
        switch count {
        case ..<1_000:
            return "\(count)"
        case ..<1_000_000:
            return scaled(count, divisor: 1_000, suffix: "K")
        default:
            return scaled(count, divisor: 1_000_000, suffix: "M")
        }
    }

    private static func scaled(_ count: Int, divisor: Int, suffix: String) -> String {
        let tenths = count / (divisor / 10)
        let whole = tenths / 10
        let fraction = tenths % 10
        return fraction == 0 ? "\(whole)\(suffix)" : "\(whole).\(fraction)\(suffix)"
    }
}
