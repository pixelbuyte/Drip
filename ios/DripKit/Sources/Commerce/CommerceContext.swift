import Foundation
import Observation
import DripModels
import Networking
import Analytics
import Products

/// What any screen needs to sell something: shared by the feed, search,
/// creator pages and the bag so every purchase takes the same path.
@MainActor
public final class CommerceContext {
    public let api: APIClient
    public let payments: any PaymentPresenting
    public let tracker: any EventTracking
    public let bag: BagStore
    /// The signed-in user's email, to prefill the receipt address.
    public var emailProvider: () -> String?

    public init(api: APIClient, payments: any PaymentPresenting, tracker: any EventTracking,
                bag: BagStore, emailProvider: @escaping () -> String? = { nil }) {
        self.api = api
        self.payments = payments
        self.tracker = tracker
        self.bag = bag
        self.emailProvider = emailProvider
    }

    public func checkout(videoId: String, selection: ProductSelection, sellerHandle: String,
                         sessionId: String, surface: FeedSurface) -> CheckoutModel {
        CheckoutModel(videoId: videoId, selection: selection, sellerHandle: sellerHandle,
                      email: emailProvider(), api: api, payments: payments, tracker: tracker,
                      sessionId: sessionId, surface: surface)
    }
}
