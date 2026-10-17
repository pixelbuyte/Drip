import Foundation

/// Integer minor units, exactly as the backend stores and charges them
/// (`price_cents`, PaymentIntent `amount`). Never a floating-point price.
public struct Money: Sendable, Hashable, Comparable, Codable {
    public var cents: Int
    public var currencyCode: String

    public init(cents: Int, currencyCode: String = "USD") {
        self.cents = cents
        self.currencyCode = currencyCode
    }

    public static func < (lhs: Money, rhs: Money) -> Bool { lhs.cents < rhs.cents }

    public static func + (lhs: Money, rhs: Money) -> Money {
        Money(cents: lhs.cents + rhs.cents, currencyCode: lhs.currencyCode)
    }

    public static func * (lhs: Money, rhs: Int) -> Money {
        Money(cents: lhs.cents * rhs, currencyCode: lhs.currencyCode)
    }

    /// "$24" for whole amounts, "$24.50" otherwise — how the web shelf prints.
    public var formatted: String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.locale = Locale(identifier: "en_US")
        let whole = cents % 100 == 0
        formatter.minimumFractionDigits = whole ? 0 : 2
        formatter.maximumFractionDigits = whole ? 0 : 2
        let value = NSDecimalNumber(value: cents).dividing(by: 100)
        return formatter.string(from: value) ?? "$\(cents / 100)"
    }

    /// Percent off relative to a higher reference price, rounded down.
    public func percentOff(from reference: Money) -> Int? {
        guard reference.cents > cents, reference.cents > 0 else { return nil }
        return (reference.cents - cents) * 100 / reference.cents
    }
}
