#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import DripModels
import DesignSystem
import Media
import Products
import Commerce

/// Full-screen vertical feed. Native paging (no artificial delayed lock),
/// one playing video, nearby pages preloaded by `PlayerPool`.
public struct FeedView: View {
    @Bindable var model: FeedModel
    let commerce: CommerceContext
    let shareBaseURL: URL
    let onOpenCreator: (Seller) -> Void
    let emptyTitle: String
    let emptyMessage: String

    @State private var pool = PlayerPool()
    @State private var scrolledID: String?
    @State private var peek: PeekState?
    @State private var checkout: CheckoutModel?
    @State private var reportTarget: FeedItem?
    @AppStorage("drip.feed.muted") private var muted = false
    @Environment(\.scenePhase) private var scenePhase

    struct PeekState: Identifiable {
        let item: FeedItem
        let product: FeedProduct
        var id: String { item.videoId + product.id }
    }

    public init(model: FeedModel, commerce: CommerceContext, shareBaseURL: URL,
                emptyTitle: String = "You're all caught up.",
                emptyMessage: String = "New drops land all day. Check back soon.",
                onOpenCreator: @escaping (Seller) -> Void) {
        self.model = model
        self.commerce = commerce
        self.shareBaseURL = shareBaseURL
        self.emptyTitle = emptyTitle
        self.emptyMessage = emptyMessage
        self.onOpenCreator = onOpenCreator
    }

    public var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            switch model.phase {
            case .idle, .loading:
                LoadingStateView("Finding good things").environment(\.colorScheme, .dark)
            case .empty:
                EmptyStateView(emptyTitle, message: emptyMessage, actionTitle: "Refresh") {
                    Task { await model.reload() }
                }
                .background(DripColor.cream)
            case .failed(let message):
                ErrorStateView(message: message) { Task { await model.reload() } }
                    .background(DripColor.cream)
            case .loaded:
                pager
            }
        }
        .task { await model.loadInitial() }
        .onAppear {
            pool.setMuted(muted)
            pool.onProgress = { id, t in Task { await model.playbackProgress(videoId: id, position: t) } }
            pool.onFailure = { id in Task { await model.playbackFailed(videoId: id) } }
            syncPlayers()
        }
        .onDisappear { pool.pauseAll() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, checkout == nil { pool.resumeActive() } else { pool.pauseAll() }
        }
        .onChange(of: model.items.map(\.videoId)) { _, _ in syncPlayers() }
        .onChange(of: model.activeIndex) { _, _ in syncPlayers() }
        .sheet(item: $peek) { state in
            ProductPeekSheet(
                product: state.product, sellerName: state.item.seller.displayName,
                onBuy: { selection in
                    peek = nil
                    startCheckout(item: state.item, selection: selection)
                },
                onAddToBag: { selection in
                    commerce.bag.add(selection, videoId: state.item.videoId, sellerHandle: state.item.seller.handle)
                    Task { await model.addedToBag(state.item, product: state.product) }
                    peek = nil
                },
                onVariantSelected: { optionId in
                    Task { await model.variantSelected(state.item, product: state.product, optionId: optionId) }
                },
                onClose: { peek = nil })
            .presentationDetents([DripMotion.peekDetent, .large])
            .presentationCornerRadius(DripRadius.sheet)
            .presentationBackgroundInteraction(.enabled(upThrough: DripMotion.peekDetent))
        }
        .sheet(item: Binding(get: { checkout.map(IdentifiedCheckout.init) },
                             set: { if $0 == nil { finishCheckout() } })) { wrapped in
            CheckoutSheet(model: wrapped.model) { finishCheckout() }
                .presentationDetents([.large])
                .presentationCornerRadius(DripRadius.sheet)
                .interactiveDismissDisabled(wrapped.model.phase.isBusy)
        }
        .confirmationDialog("Report this video", isPresented: Binding(get: { reportTarget != nil },
                                                                       set: { if !$0 { reportTarget = nil } }),
                            titleVisibility: .visible) {
            ForEach(["Prohibited item", "Misleading", "Inappropriate", "Spam"], id: \.self) { reason in
                Button(reason, role: .destructive) {
                    if let item = reportTarget { Task { await model.report(item, reason: reason) } }
                }
            }
        }
    }

    private var pager: some View {
        ScrollView(.vertical) {
            LazyVStack(spacing: 0) {
                ForEach(Array(model.items.enumerated()), id: \.element.videoId) { index, item in
                    FeedPage(item: item,
                             player: pool.player(for: item.videoId),
                             isActive: index == model.activeIndex,
                             failed: pool.failures.contains(item.videoId),
                             isLiked: model.liked.contains(item.videoId),
                             isSaved: model.saved.contains(item.videoId),
                             isFollowing: model.following.contains(item.seller.id),
                             muted: muted,
                             shareURL: shareURL(for: item),
                             actions: actions(for: item))
                        .containerRelativeFrame([.horizontal, .vertical])
                        .id(item.videoId)
                }
                if model.isLoadingMore {
                    ProgressView().tint(.white).frame(height: 80)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollPosition(id: $scrolledID)
        .scrollIndicators(.hidden)
        .ignoresSafeArea()
        .onChange(of: scrolledID) { _, id in
            guard let id, let index = model.items.firstIndex(where: { $0.videoId == id }) else { return }
            Task { await model.commit(index: index) }
        }
        .refreshable { await model.reload() }
        .accessibilityScrollAction { edge in
            let target = edge == .bottom ? model.activeIndex + 1 : model.activeIndex - 1
            if model.items.indices.contains(target) { scrolledID = model.items[target].videoId }
        }
    }

    private func actions(for item: FeedItem) -> FeedPage.Actions {
        FeedPage.Actions(
            like: { Task { await model.toggleLike(item) } },
            doubleTapLike: { Task { await model.likeFromDoubleTap(item) } },
            save: { Task { await model.toggleSave(item) } },
            follow: { Task { await model.toggleFollow(item) } },
            shared: { Task { await model.shared(item) } },
            openCreator: {
                Task { await model.sellerProfileTapped(item) }
                pool.pauseAll()
                onOpenCreator(item.seller)
            },
            peek: { product in
                Task { await model.productTapped(item, product: product) }
                peek = PeekState(item: item, product: product)
            },
            toggleMute: {
                muted.toggle()
                pool.setMuted(muted)
            },
            togglePlayback: { pool.togglePlayback() },
            retry: {
                pool.clearFailure(item.videoId)
                syncPlayers()
            },
            notInterested: { Task { await model.notInterested(item) } },
            report: { reportTarget = item })
    }

    /// `<site>/v/<videoId>`: the public per-video page, which unfurls with the
    /// poster and opens the app at this video where universal links are set up.
    private func shareURL(for item: FeedItem) -> URL {
        ShareLinks.videoURL(base: shareBaseURL, videoId: item.videoId)
    }

    private func syncPlayers() {
        let sources = model.playbackURLs.map { $0.map { PlayerPool.Source(videoId: $0.videoId, url: $0.url) } }
        pool.update(sources: sources, active: model.activeIndex)
        if checkout != nil || scenePhase != .active { pool.pauseAll() }
        if scrolledID == nil { scrolledID = model.activeItem?.videoId }
    }

    private func startCheckout(item: FeedItem, selection: ProductSelection) {
        pool.pauseAll()
        checkout = commerce.checkout(videoId: item.videoId, selection: selection,
                                     sellerHandle: item.seller.handle,
                                     sessionId: model.sessionId, surface: model.surface)
    }

    private func finishCheckout() {
        if let c = checkout { Task { await c.close() } }
        checkout = nil
        pool.resumeActive()
    }
}

struct IdentifiedCheckout: Identifiable {
    let model: CheckoutModel
    var id: ObjectIdentifier { ObjectIdentifier(model) }
}

extension CheckoutModel.Phase {
    var isBusy: Bool {
        switch self {
        case .quoting, .paying: return true
        default: return false
        }
    }
}
#endif
