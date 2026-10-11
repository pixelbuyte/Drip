#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import DripModels
import DesignSystem
import Media
import Discover

/// Frames 10–12: serif "Find your next thing.", pill search field, results
/// as a 2-up grid of video tiles. A tile opens the vertical feed there.
public struct ExploreView: View {
    @Bindable var model: ExploreModel
    let suggestions: [String]
    let onOpen: (_ items: [FeedItem], _ index: Int, _ query: String) -> Void
    @FocusState private var focused: Bool

    public init(model: ExploreModel, suggestions: [String] = ["Vintage", "Ceramics", "Denim", "Jewelry", "Skincare", "Home"],
                onOpen: @escaping ([FeedItem], Int, String) -> Void) {
        self.model = model
        self.suggestions = suggestions
        self.onOpen = onOpen
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DripSpace.l) {
                Text("Find your next thing.").dripText(.title).foregroundStyle(DripColor.ink)
                    .accessibilityAddTraits(.isHeader)
                searchField
                content
            }
            .padding(.horizontal, DripSpace.inset)
            .padding(.top, DripSpace.s)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(DripColor.cream)
    }

    private var searchField: some View {
        HStack(spacing: DripSpace.xs) {
            Image(systemName: "magnifyingglass").foregroundStyle(DripColor.muted)
            TextField("Search creators, finds, styles", text: $model.query)
                .focused($focused)
                .submitLabel(.search)
                .onSubmit { Task { await model.submit() } }
                .autocorrectionDisabled()
                .dripText(.body)
            if !model.query.isEmpty {
                Button { model.clear() } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(DripColor.muted)
                        .frame(width: DripSize.minHit, height: DripSize.minHit)
                }
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, DripSpace.m)
        .frame(minHeight: DripSize.preferredHit)
        .background(DripColor.peach.opacity(0.55), in: Capsule())
    }

    @ViewBuilder private var content: some View {
        switch model.results {
        case .idle:
            VStack(alignment: .leading, spacing: DripSpace.s) {
                Text("Trending").dripText(.eyebrow).foregroundStyle(DripColor.muted)
                FlowChips(items: suggestions) { s in
                    model.query = s
                    Task { await model.submit() }
                }
            }
        case .loading:
            LoadingStateView("Searching").frame(height: 240)
        case .empty:
            EmptyStateView("Nothing matched.", message: "Try a broader word, or a creator's name.",
                           systemImage: "magnifyingglass").frame(height: 320)
        case .failed(let message):
            ErrorStateView(message: message) { Task { await model.submit() } }.frame(height: 320)
        case .loaded(let items):
            LazyVGrid(columns: [GridItem(.flexible(), spacing: DripSpace.s), GridItem(.flexible())],
                      spacing: DripSpace.s) {
                ForEach(Array(items.enumerated()), id: \.element.videoId) { index, item in
                    Button { onOpen(items, index, model.trimmedQuery) } label: { VideoTile(item: item) }
                        .buttonStyle(PressableStyle())
                }
            }
        }
    }
}

/// Wrapping chip row.
struct FlowChips: View {
    let items: [String]
    let onTap: (String) -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: DripSpace.xs) { chips }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: DripSpace.xs) { chips }
            }
        }
    }

    private var chips: some View {
        ForEach(items, id: \.self) { s in DripChip(s) { onTap(s) } }
    }
}
#endif
