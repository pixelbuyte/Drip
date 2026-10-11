import Foundation
import Observation
import DripModels
import Networking
import Authentication
import Analytics
import Commerce
import Discover
import Explore
import Creators
import Profile

/// The dependency container. Built once at launch from `AppConfiguration`;
/// every screen receives what it needs from here, never a singleton.
@MainActor
@Observable
public final class AppEnvironment {
    public let config: AppConfiguration
    public let api: APIClient
    public let session: SessionStore
    public let viewer: ViewerIdentityStore
    public let tracker: EventTracker
    public let commerce: CommerceContext
    public let router: AppRouter

    public let homeFeed: FeedModel
    public let followingFeed: FeedModel
    public let explore: ExploreModel
    public let studio: StudioModel
    public let profile: ProfileModel

    /// Email of the signed-in user, kept in step with the session for
    /// prefilling checkout.
    public private(set) var signedInEmail: String?
    public private(set) var isSignedIn = false

    public init(config: AppConfiguration, payments: any PaymentPresenting,
                secureStore: any SecureStore, transport: any HTTPTransport = URLSessionTransport(),
                bag: BagStore = BagStore()) {
        self.config = config
        self.router = AppRouter()
        let auth = SupabaseAuthClient(projectURL: config.supabaseURL, anonKey: config.supabaseAnonKey,
                                      transport: transport)
        let session = SessionStore(client: auth, store: secureStore)
        let viewer = ViewerIdentityStore(baseURL: config.apiBaseURL, transport: transport, store: secureStore)
        let api = APIClient(baseURL: config.apiBaseURL, transport: transport, tokens: session, viewer: viewer,
                            userAgent: "DripiOS/\(config.environmentName)")
        let tracker = EventTracker(api: api)
        self.session = session
        self.viewer = viewer
        self.api = api
        self.tracker = tracker
        self.commerce = CommerceContext(api: api, payments: payments, tracker: tracker, bag: bag)
        self.homeFeed = FeedModel(source: .feed(.forYou), api: api, tracker: tracker)
        self.followingFeed = FeedModel(source: .feed(.following), api: api, tracker: tracker)
        self.explore = ExploreModel(api: api)
        self.studio = StudioModel(api: api)
        self.profile = ProfileModel(session: session, api: api)
        commerce.emailProvider = { [weak self] in self?.signedInEmail }
    }

    /// Long-lived observation of the session for the email prefill and the
    /// Drop tab's sign-in gate.
    public func observeSession() async {
        for await state in await session.states() {
            switch state {
            case .signedIn(let user):
                signedInEmail = user.email
                isSignedIn = true
            case .signedOut:
                signedInEmail = nil
                isSignedIn = false
            }
        }
    }

    public func signInModel() -> SignInModel {
        SignInModel(session: session, api: api, redirectURL: config.authCallbackURL)
    }

    public func creatorModel(_ seller: Seller) -> CreatorProfileModel {
        CreatorProfileModel(seller: seller, api: api, tracker: tracker)
    }

    public func seededFeed(_ seed: FeedSeed) -> FeedModel {
        let source: FeedModel.Source
        switch seed.source {
        case .search(let q): source = .search(q)
        case .creator(let handle): source = .feed(.sellerProfile, seller: handle)
        case .saved: source = .feed(.forYou)
        }
        return FeedModel(source: source, api: api, tracker: tracker)
    }

    /// App going to background: deliver what's buffered.
    public func flushTelemetry() async {
        await tracker.flush()
    }
}
