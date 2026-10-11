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
    let onOpenCategory: (CatalogCategory) -> Void
    let onOpen: (_ items: [FeedItem], _ index: Int, _ query: String) -> Void
    @FocusState private var focused: Bool

    public init(model: ExploreModel, suggestions: [String] = ["Vintage", "Ceramics", "Denim", "Jewelry", "Skincare", "Home"],
                onOpenCategory: @escaping (CatalogCategory) -> Void = { _ in },
                onOpen: @escaping ([FeedItem], Int, String) -> Void) {
        self.model = model
        self.suggestions = suggestions
        self.onOpenCategory = onOpenCategory
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
        .task { await model.loadCategories() }
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
            categoriesSection
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

    /// Browse by category: 2-up pastel tiles from /api/categories. Failure
    /// is inline and small; search still works without it.
    @ViewBuilder private var categoriesSection: some View {
        switch model.categories {
        case .idle, .empty:
            EmptyView()
        case .loading:
            VStack(alignment: .leading, spacing: DripSpace.s) {
                Text("Categories").dripText(.eyebrow).foregroundStyle(DripColor.muted)
                LoadingStateView().frame(height: 120)
            }
        case .failed(let message):
            VStack(alignment: .leading, spacing: DripSpace.s) {
                Text("Categories").dripText(.eyebrow).foregroundStyle(DripColor.muted)
                ErrorStateView(message: message) { Task { await model.reloadCategories() } }
                    .frame(height: 200)
            }
        case .loaded(let categories):
            VStack(alignment: .leading, spacing: DripSpace.s) {
                Text("Categories").dripText(.eyebrow).foregroundStyle(DripColor.muted)
                    .accessibilityAddTraits(.isHeader)
                LazyVGrid(columns: [GridItem(.flexible(), spacing: DripSpace.s), GridItem(.flexible())],
                          spacing: DripSpace.s) {
                    ForEach(Array(categories.enumerated()), id: \.element.id) { index, category in
                        Button { onOpenCategory(category) } label: {
                            CategoryTile(name: category.name, tint: CategoryTile.tint(at: index))
                        }
                        .buttonStyle(PressableStyle())
                        .accessibilityLabel(category.name)
                        .accessibilityHint("Opens the \(category.name) feed")
                    }
                }
            }
        }
    }
}

/// One category: name in the lower-left of a rounded pastel block.
struct CategoryTile: View {
    let name: String
    let tint: Color

    /// The pastel set, cycled in server order so neighbours differ.
    static func tint(at index: Int) -> Color {
        let tints = [DripColor.peach, DripColor.lavender, DripColor.mint, DripColor.pink, DripColor.lime]
        return tints[index % tints.count]
    }

    var body: some View {
        Text(name)
            .dripText(.product)
            .foregroundStyle(DripColor.ink)
            .multilineTextAlignment(.leading)
            .lineLimit(2)
            .frame(maxWidth: .infinity, minHeight: 84, alignment: .bottomLeading)
            .padding(DripSpace.m)
            .background(tint, in: RoundedRectangle(cornerRadius: DripRadius.tile, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: DripRadius.tile, style: .continuous))
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
