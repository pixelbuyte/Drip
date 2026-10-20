import Foundation
import Observation
import DripModels
import Networking
import Analytics
import Products

/// One purchase: quote (server-priced PaymentIntent) → pay → confirmation.
@MainActor
@Observable
public final class CheckoutModel {
    public enum Phase: Equatable, Sendable {
        case collectingDetails
        case quoting
        case ready(PaymentIntentResponse)
        case paying(PaymentIntentResponse)
        case succeeded(PaymentIntentResponse)
        case soldOut(available: Int?)
        case failed(message: String)
    }

    public let videoId: String
    public let selection: ProductSelection
    public let sellerHandle: String
    public var email: String
    public private(set) var phase: Phase = .collectingDetails

    /// Generated when checkout opens, so a double tap or a retried request
    /// returns the same PaymentIntent instead of a second charge (the route
    /// prefixes it into Stripe's idempotency key).
    public let idempotencyKey: String

    private let api: APIClient
    private let payments: any PaymentPresenting
    private let tracker: any EventTracking
    private let sessionId: String
    private let surface: FeedSurface
    private let merchantName: String
    private var opened = false
    private var finished = false

    public init(videoId: String, selection: ProductSelection, sellerHandle: String, email: String?,
                api: APIClient, payments: any PaymentPresenting, tracker: any EventTracking,
                sessionId: String, surface: FeedSurface, merchantName: String = "Drip",
                idempotencyKey: String = UUID().uuidString.lowercased()) {
        self.videoId = videoId
        self.selection = selection
        self.sellerHandle = sellerHandle
        self.email = email ?? ""
        self.api = api
        self.payments = payments
        self.tracker = tracker
        self.sessionId = sessionId
        self.surface = surface
        self.merchantName = merchantName
        self.idempotencyKey = idempotencyKey
    }

    public var isEmailValid: Bool { Self.isPlausibleEmail(email) }

    public func open() async {
        guard !opened else { return }
        opened = true
        await tracker.track(FeedEvent(.checkoutOpen, videoId: videoId, productId: selection.product.id),
                            sessionId: sessionId, surface: surface)
    }

    /// Server-side quote: price, shipping and total come back from the route.
    public func quote() async {
        guard isEmailValid else {
            phase = .failed(message: "Enter an email for your receipt and tracking.")
            return
        }
        phase = .quoting
        do {
            let body = PaymentIntentRequest(videoId: videoId, productId: selection.product.id,
                                            quantity: selection.quantity,
                                            selection: selection.serverSelection,
                                            idempotencyKey: idempotencyKey,
                                            email: email.trimmingCharacters(in: .whitespaces))
            let intent = try await api.send(DripAPI.createPaymentIntent(body))
            phase = .ready(intent)
        } catch let APIError.conflict(message, code, available) {
            phase = code == "sold_out" ? .soldOut(available: available) : .failed(message: message)
        } catch let error as APIError {
            phase = .failed(message: error.userMessage)
        } catch {
            phase = .failed(message: "Something went wrong on our side. You have not been charged.")
        }
    }

    public func pay() async {
        guard case .ready(let intent) = phase else { return }
        phase = .paying(intent)
        let outcome = await payments.present(PaymentPresentation(
            clientSecret: intent.clientSecret, merchantDisplayName: merchantName,
            email: email, totalCents: intent.totalCents, title: intent.title))
        switch outcome {
        case .completed:
            phase = .succeeded(intent)
            finished = true
            // Deliberately no `purchase` event: a client-asserted purchase is
            // forgeable and inflates ranking signals. The Stripe webhook is
            // the only authority that a purchase happened.
        case .canceled:
            phase = .ready(intent)
        case .failed(let message):
            phase = .failed(message: message)
        }
    }

    /// Sheet dismissed. Reports an abandon unless the purchase completed.
    public func close() async {
        guard opened, !finished else { return }
        finished = true
        await tracker.track(FeedEvent(.checkoutAbandon, videoId: videoId, productId: selection.product.id),
                            sessionId: sessionId, surface: surface)
    }

    static func isPlausibleEmail(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard t.count <= 120, let at = t.firstIndex(of: "@") else { return false }
        let local = t[..<at], domain = t[t.index(after: at)...]
        return !local.isEmpty && domain.contains(".") && !domain.hasPrefix(".") && !domain.hasSuffix(".")
            && !t.contains(" ")
    }
}
