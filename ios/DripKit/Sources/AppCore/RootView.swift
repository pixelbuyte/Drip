#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import DripModels
import DesignSystem
import Authentication
import Commerce
import Discover
import Explore
import Creators
import Profile

/// The app shell: five-zone cream dock (Home, Discover, Drop, Following,
/// Profile — board 14, navigation study 1), Home header with the bag, one
/// navigation stack per tab, and the app-level sheets.
public struct RootView: View {
    @Bindable var env: AppEnvironment
    @Bindable var router: AppRouter
    @State private var bagCheckout: CheckoutModel?
    @State private var webAuth = WebAuthenticator()
    @Environment(\.scenePhase) private var scenePhase

    public init(env: AppEnvironment) {
        self.env = env
        self.router = env.router
    }

    public var body: some View {
        ZStack(alignment: .bottom) {
            tabContent
            DripTabBar(selected: router.selectedTab) { router.select($0) }
        }
        .ignoresSafeArea(.keyboard)
        .background(DripColor.cream)
        .preferredColorScheme(.light)
        .task { await env.observeSession() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { Task { await env.flushTelemetry() } }
        }
        // Custom-scheme links, and universal links when SwiftUI delivers them
        // as a URL. Both paths route through AppRouter.open, and routing a
        // shared video replaces Home's stack, so a link seen by both
        // handlers still opens one screen.
        .onOpenURL { url in _ = env.open(url) }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            if let url = activity.webpageURL { _ = env.open(url) }
        }
        .sheet(item: $router.sheet) { sheet in
            switch sheet {
            case .signIn:
                SignInSheet(env: env) { router.sheet = nil }
            case .bag:
                BagView(bag: env.commerce.bag, onCheckout: { line in
                    router.sheet = nil
                    bagCheckout = env.commerce.checkout(videoId: line.videoId, selection: line.selection,
                                                        sellerHandle: line.sellerHandle,
                                                        sessionId: env.homeFeed.sessionId, surface: .forYou)
                }, onClose: { router.sheet = nil })
                .presentationDetents([.medium, .large])
                .presentationCornerRadius(DripRadius.sheet)
            }
        }
        .sheet(item: Binding(get: { bagCheckout.map(IdentifiedCheckout.init) },
                             set: { if $0 == nil { bagCheckout = nil } })) { wrapped in
            CheckoutSheet(model: wrapped.model) {
                if case .succeeded = wrapped.model.phase,
                   let line = env.commerce.bag.lines.first(where: { $0.product.id == wrapped.model.selection.product.id }) {
                    env.commerce.bag.remove(line.id)
                }
                bagCheckout = nil
            }
            .presentationCornerRadius(DripRadius.sheet)
        }
    }

    @ViewBuilder private var tabContent: some View {
        switch router.selectedTab {
        case .home:
            stack(.home) {
                FeedView(model: env.homeFeed, commerce: env.commerce, shareBaseURL: env.config.apiBaseURL,
                         onOpenCreator: { router.push(.creator($0)) })
                    .overlay(alignment: .top) { HomeHeader(bagCount: env.commerce.bag.count) { router.sheet = .bag } }
            }
        case .discover:
            stack(.discover) {
                ExploreView(model: env.explore,
                            onOpenCategory: { router.push(.category($0)) }) { items, index, q in
                    router.push(.feed(FeedSeed(items: items, startIndex: index, source: .search(q))))
                }
                .safeAreaPadding(.bottom, DripSize.tabBar)
            }
        case .drop:
            stack(.drop) {
                if env.isSignedIn {
                    StudioView(model: env.studio) { url in
                        // Stripe's return_url is the website (start/route.ts),
                        // so the session ends when the seller closes it; only
                        // then is the account state worth re-reading.
                        Task {
                            _ = try? await webAuth.start(url: url, callbackScheme: env.config.urlScheme)
                            await env.studio.refreshOnboarding()
                        }
                    }
                    .safeAreaPadding(.bottom, DripSize.tabBar)
                } else {
                    EmptyStateView("Sell what you love.", message: "Sign in to post drops and get paid through Stripe.",
                                   systemImage: "plus.circle", actionTitle: "Sign in") { router.sheet = .signIn }
                        .background(DripColor.cream)
                }
            }
        case .following:
            stack(.following) {
                FeedView(model: env.followingFeed, commerce: env.commerce, shareBaseURL: env.config.apiBaseURL,
                         emptyTitle: "Your people. Their latest.",
                         emptyMessage: "Follow creators from the feed and their new drops land here.",
                         onOpenCreator: { router.push(.creator($0)) })
            }
        case .profile:
            stack(.profile) {
                ProfileView(model: env.profile, legalBaseURL: env.config.apiBaseURL,
                            onSignIn: { router.sheet = .signIn },
                            onOpenSaved: { items, i in
                                router.push(.feed(FeedSeed(items: items, startIndex: i, source: .saved)))
                            })
                .safeAreaPadding(.bottom, DripSize.tabBar)
            }
        }
    }

    private func stack<Content: View>(_ tab: AppTab, @ViewBuilder root: () -> Content) -> some View {
        NavigationStack(path: Binding(get: { router.paths[tab] ?? [] }, set: { router.paths[tab] = $0 })) {
            root()
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: AppRoute.self) { route in
                    destination(route)
                }
        }
    }

    @ViewBuilder private func destination(_ route: AppRoute) -> some View {
        switch route {
        case .creator(let seller):
            CreatorProfileView(model: env.creatorModel(seller)) { items, i in
                router.push(.feed(FeedSeed(items: items, startIndex: i, source: .creator(handle: seller.handle))))
            }
            .safeAreaPadding(.bottom, DripSize.tabBar)
        case .feed(let seed):
            SeededFeedScreen(env: env, seed: seed)
        case .category(let category):
            CategoryFeedScreen(env: env, category: category)
        case .sharedVideo(let videoId):
            SharedVideoScreen(env: env, videoId: videoId)
        }
    }
}

/// Owns one SignInModel for the life of the sheet.
struct SignInSheet: View {
    let env: AppEnvironment
    let onClose: () -> Void
    @State private var model: SignInModel

    init(env: AppEnvironment, onClose: @escaping () -> Void) {
        self.env = env
        self.onClose = onClose
        self._model = State(initialValue: env.signInModel())
    }

    var body: some View {
        SignInView(model: model, callbackScheme: env.config.urlScheme, onClose: onClose)
    }
}

/// A feed opened on already-loaded items (search grid, creator, saved).
struct SeededFeedScreen: View {
    let env: AppEnvironment
    let seed: FeedSeed
    @State private var model: FeedModel?

    var body: some View {
        Group {
            if let model {
                FeedView(model: model, commerce: env.commerce, shareBaseURL: env.config.apiBaseURL,
                         onOpenCreator: { env.router.push(.creator($0)) })
            } else {
                Color.black
            }
        }
        .ignoresSafeArea()
        .toolbarBackground(.hidden, for: .navigationBar)
        .task {
            guard model == nil else { return }
            let m = env.seededFeed(seed)
            await m.seed(items: seed.items, startAt: seed.startIndex, exhausted: seed.source == .saved)
            model = m
        }
    }
}

/// A category's feed (Explore tile). FeedView's own `.task` loads it.
struct CategoryFeedScreen: View {
    let env: AppEnvironment
    let category: CatalogCategory
    @State private var model: FeedModel

    init(env: AppEnvironment, category: CatalogCategory) {
        self.env = env
        self.category = category
        self._model = State(initialValue: env.categoryFeed(category))
    }

    var body: some View {
        FeedView(model: model, commerce: env.commerce, shareBaseURL: env.config.apiBaseURL,
                 emptyTitle: "Nothing in \(category.name) yet.",
                 emptyMessage: "New drops land all day. Check back soon.",
                 onOpenCreator: { env.router.push(.creator($0)) })
            .ignoresSafeArea()
            .navigationTitle(category.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
    }
}

/// A feed opened on one shared video (drip://v/<id>, https://<site>/v/<id>):
/// loads it by id, then renders the seeded feed like SeededFeedScreen.
struct SharedVideoScreen: View {
    let env: AppEnvironment
    @State private var model: SharedVideoModel

    init(env: AppEnvironment, videoId: String) {
        self.env = env
        self._model = State(initialValue: env.sharedVideoModel(videoId))
    }

    var body: some View {
        Group {
            switch model.phase {
            case .idle, .loading:
                LoadingStateView("Opening the video").environment(\.colorScheme, .dark)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.black)
            case .loaded:
                if let feed = model.feed {
                    FeedView(model: feed, commerce: env.commerce, shareBaseURL: env.config.apiBaseURL,
                             onOpenCreator: { env.router.push(.creator($0)) })
                }
            case .unavailable:
                EmptyStateView("This one's gone.",
                               message: "It may have sold out or been taken down. There's plenty more in your feed.",
                               systemImage: "play.slash", actionTitle: "Back to the feed") {
                    env.router.popToRoot(.home)
                }
                .background(DripColor.cream)
            case .failed(let message):
                ErrorStateView(message: message) { Task { await model.load() } }
                    .background(DripColor.cream)
            }
        }
        .ignoresSafeArea()
        .toolbarBackground(.hidden, for: .navigationBar)
        .task { await model.load() }
    }
}

/// Home header over the video: wordmark, bag with count.
struct HomeHeader: View {
    let bagCount: Int
    let openBag: () -> Void

    var body: some View {
        HStack {
            HStack(alignment: .lastTextBaseline, spacing: 0) {
                Text("drip").font(.custom("DMSans-Bold", size: 26, relativeTo: .title2)).tracking(-1)
                Circle().fill(DripColor.coral).frame(width: 7, height: 7).offset(y: -2)
            }
            .foregroundStyle(.white)
            .shadow(color: .black.opacity(0.3), radius: 4)
            .accessibilityLabel("Drip")
            Spacer()
            Button(action: openBag) {
                Image(systemName: "bag")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: DripSize.minHit, height: DripSize.minHit)
                    .overlay(alignment: .topTrailing) {
                        if bagCount > 0 {
                            Text("\(bagCount)").font(.caption2.bold()).foregroundStyle(DripColor.ink)
                                .padding(4).background(DripColor.coral, in: Circle())
                        }
                    }
            }
            .accessibilityLabel(bagCount > 0 ? "Bag, \(bagCount) items" : "Bag")
        }
        .padding(.horizontal, DripSpace.insetCompact)
    }
}

/// Cream labeled dock; Drop is a coral circle with an ink plus; the
/// selected tab gets a filled ink icon, semibold label and a coral dot.
struct DripTabBar: View {
    let selected: AppTab
    let onSelect: (AppTab) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 0) {
            ForEach(AppTab.allCases, id: \.self) { tab in
                Button { onSelect(tab) } label: { item(tab) }
                    .buttonStyle(PressableStyle())
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel(tab.title)
                    .accessibilityAddTraits(tab == selected ? [.isSelected, .isButton] : .isButton)
            }
        }
        .frame(height: DripSize.tabBar)
        .background(DripColor.cream.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(DripColor.hairlineStrong).frame(height: 1) }
        .animation(DripMotion.standard(DripMotionSpec.tabMs, reduceMotion: reduceMotion), value: selected)
    }

    @ViewBuilder private func item(_ tab: AppTab) -> some View {
        if tab == .drop {
            Image(systemName: "plus")
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(DripColor.ink)
                .frame(width: DripSize.dropButton, height: DripSize.dropButton)
                .background(DripColor.coral, in: Circle())
                .frame(minWidth: 56, minHeight: 56)
        } else {
            let isOn = tab == selected
            VStack(spacing: 3) {
                Image(systemName: isOn ? tab.selectedSymbol : tab.symbol)
                    .font(.system(size: 20, weight: isOn ? .semibold : .regular))
                Text(tab.title).font(.custom(isOn ? "DMSans-SemiBold" : "DMSans-Medium", size: 11, relativeTo: .caption2))
                Circle().fill(isOn ? DripColor.coral : .clear).frame(width: 4, height: 4)
            }
            .foregroundStyle(isOn ? DripColor.ink : DripColor.muted)
            .frame(minWidth: DripSize.minHit, minHeight: DripSize.minHit)
        }
    }
}

/// Same wrapper Discover uses, for the bag's checkout sheet.
struct IdentifiedCheckout: Identifiable {
    let model: CheckoutModel
    var id: ObjectIdentifier { ObjectIdentifier(model) }
}
#endif
