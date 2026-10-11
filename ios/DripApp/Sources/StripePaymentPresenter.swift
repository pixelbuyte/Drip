import UIKit
import Commerce
import StripePaymentSheet

/// Stripe PaymentSheet behind DripKit's `PaymentPresenting`.
///
/// Flow: collect the shipping address (Stripe's AddressViewController — the
/// label is bought for this address when the Stripe webhook creates the
/// order), then PaymentSheet with Apple Pay and cards. PaymentSheet confirms
/// the server-created PaymentIntent with that shipping attached. Card data
/// never touches Drip's code or servers.
///
/// Only the publishable key is configured here; the secret key exists only
/// on the server.
@MainActor
final class StripePaymentPresenter: NSObject, PaymentPresenting {
    private let merchantId: String?
    private let returnURL: String
    private var addressContinuation: CheckedContinuation<AddressViewController.AddressDetails?, Never>?

    init(publishableKey: String, merchantId: String?, returnURL: String) {
        self.merchantId = merchantId
        self.returnURL = returnURL
        super.init()
        StripeAPI.defaultPublishableKey = publishableKey
    }

    func present(_ presentation: PaymentPresentation) async -> PaymentOutcome {
        guard let presenter = Self.topViewController() else {
            return .failed(message: "Could not open checkout.")
        }

        guard let shipping = await collectAddress(from: presenter, email: presentation.email) else {
            return .canceled
        }

        var config = PaymentSheet.Configuration()
        config.merchantDisplayName = presentation.merchantDisplayName
        config.returnURL = returnURL
        config.allowsDelayedPaymentMethods = false
        config.defaultBillingDetails.email = presentation.email
        config.shippingDetails = { shipping }
        if let merchantId {
            config.applePay = .init(merchantId: merchantId, merchantCountryCode: "US")
        }
        config.appearance = Self.appearance

        let sheet = PaymentSheet(paymentIntentClientSecret: presentation.clientSecret, configuration: config)
        guard let top = Self.topViewController() else { return .failed(message: "Could not open checkout.") }
        return await withCheckedContinuation { continuation in
            sheet.present(from: top) { result in
                switch result {
                case .completed: continuation.resume(returning: .completed)
                case .canceled: continuation.resume(returning: .canceled)
                case .failed(let error): continuation.resume(returning: .failed(message: error.localizedDescription))
                }
            }
        }
    }

    private func collectAddress(from presenter: UIViewController, email: String?) async -> AddressViewController.AddressDetails? {
        var config = AddressViewController.Configuration()
        config.title = "Where should it ship?"
        config.allowedCountries = ["US"]   // labels are bought with US-only EasyPost rates
        config.additionalFields = .init(phone: .optional)
        config.buttonTitle = "Continue to payment"
        config.appearance = Self.appearance
        let controller = AddressViewController(configuration: config, delegate: self)
        let nav = UINavigationController(rootViewController: controller)
        return await withCheckedContinuation { continuation in
            addressContinuation = continuation
            presenter.present(nav, animated: true)
        }
    }

    /// Cream / ink / coral with an ink primary label — the Drip tokens.
    private static var appearance: PaymentSheet.Appearance {
        var a = PaymentSheet.Appearance()
        let cream = UIColor(red: 1, green: 0.976, blue: 0.949, alpha: 1)
        let ink = UIColor(red: 0.125, green: 0.102, blue: 0.09, alpha: 1)
        let coral = UIColor(red: 1, green: 0.294, blue: 0.18, alpha: 1)
        a.colors.background = cream
        a.colors.componentBackground = .white
        a.colors.text = ink
        a.colors.textSecondary = UIColor(red: 0.431, green: 0.384, blue: 0.349, alpha: 1)
        a.colors.primary = coral
        a.primaryButton.backgroundColor = coral
        a.primaryButton.textColor = ink
        a.cornerRadius = 12
        if let font = UIFont(name: "DMSans-Regular", size: 16) { a.font.base = font }
        return a
    }

    private static func topViewController() -> UIViewController? {
        let root = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?.rootViewController
        var top = root
        while let next = top?.presentedViewController { top = next }
        return top
    }
}

extension StripePaymentPresenter: AddressViewControllerDelegate {
    nonisolated func addressViewControllerDidFinish(_ addressViewController: AddressViewController,
                                                    with address: AddressViewController.AddressDetails?) {
        MainActor.assumeIsolated {
            addressViewController.dismiss(animated: true) { [weak self] in
                MainActor.assumeIsolated {
                    self?.addressContinuation?.resume(returning: address)
                    self?.addressContinuation = nil
                }
            }
        }
    }
}
