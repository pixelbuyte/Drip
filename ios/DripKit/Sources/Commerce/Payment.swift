import Foundation
import DripModels

/// What the payment UI needs. Only the PaymentIntent *client secret* — a
/// one-purchase capability — ever reaches the device; amount, fee, seller
/// destination and inventory were fixed server-side when it was created.
public struct PaymentPresentation: Sendable, Equatable {
    public var clientSecret: String
    public var merchantDisplayName: String
    public var email: String?
    public var totalCents: Int
    public var title: String

    public init(clientSecret: String, merchantDisplayName: String, email: String?,
                totalCents: Int, title: String) {
        self.clientSecret = clientSecret
        self.merchantDisplayName = merchantDisplayName
        self.email = email
        self.totalCents = totalCents
        self.title = title
    }
}

public enum PaymentOutcome: Sendable, Equatable {
    case completed
    case canceled
    case failed(message: String)
}

/// Implemented in the app target with Stripe PaymentSheet (+ Apple Pay and
/// the address element for the shipping address the label is bought for).
/// Physical goods shipped to the buyer: App Store guideline 3.1.3(e) — not
/// in-app purchase.
@MainActor
public protocol PaymentPresenting: AnyObject {
    func present(_ presentation: PaymentPresentation) async -> PaymentOutcome
}

/// Previews/tests: completes, cancels or fails on demand.
@MainActor
public final class ScriptedPaymentPresenter: PaymentPresenting {
    public var outcome: PaymentOutcome
    public private(set) var presented: [PaymentPresentation] = []
    public init(outcome: PaymentOutcome = .completed) { self.outcome = outcome }
    public func present(_ presentation: PaymentPresentation) async -> PaymentOutcome {
        presented.append(presentation)
        return outcome
    }
}
