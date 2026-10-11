#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import DripModels
import DesignSystem
import Discover

/// Frame 16: creator storefront — avatar, serif name, follow, video grid.
public struct CreatorProfileView: View {
    @Bindable var model: CreatorProfileModel
    let onOpenVideo: ([FeedItem], Int) -> Void

    public init(model: CreatorProfileModel, onOpenVideo: @escaping ([FeedItem], Int) -> Void) {
        self.model = model
        self.onOpenVideo = onOpenVideo
    }

    public var body: some View {
        ScrollView {
            VStack(spacing: DripSpace.l) {
                header
                switch model.feed.phase {
                case .idle, .loading:
                    LoadingStateView().frame(height: 240)
                case .empty:
                    EmptyStateView("No drops yet.", message: "When @\(model.seller.handle) posts, it lands here.",
                                   systemImage: "video").frame(height: 300)
                case .failed(let m):
                    ErrorStateView(message: m) { Task { await model.feed.reload() } }.frame(height: 300)
                case .loaded:
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: DripSpace.xs), count: 3),
                              spacing: DripSpace.xs) {
                        ForEach(Array(model.feed.items.enumerated()), id: \.element.videoId) { i, item in
                            Button { onOpenVideo(model.feed.items, i) } label: { VideoTile(item: item) }
                                .buttonStyle(PressableStyle())
                        }
                    }
                }
            }
            .padding(.horizontal, DripSpace.insetCompact)
        }
        .background(DripColor.cream)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
    }

    private var header: some View {
        VStack(spacing: DripSpace.s) {
            CreatorAvatar(url: model.seller.avatarUrl, name: model.seller.displayName, size: DripSize.avatarHero)
            Text(model.seller.displayName).dripText(.title).foregroundStyle(DripColor.ink)
                .accessibilityAddTraits(.isHeader)
            Text("@\(model.seller.handle)").dripText(.meta).foregroundStyle(DripColor.muted)
            if model.canFollow {
                FollowButton(isFollowing: model.isFollowing) { Task { await model.toggleFollow() } }
            }
        }
        .padding(.top, DripSpace.l)
    }
}

/// A picked video copied into the app's temporary directory for upload.
struct PickedMovie: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let dest = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension)
            try FileManager.default.copyItem(at: received.file, to: dest)
            return PickedMovie(url: dest)
        }
    }
}

/// Seller tools: payouts gate, then "Create a drop" (frame 29).
public struct StudioView: View {
    @Bindable var model: StudioModel
    let openURL: (URL) -> Void
    @State private var pickerItem: PhotosPickerItem?
    @State private var loadingVideo = false

    public init(model: StudioModel, openURL: @escaping (URL) -> Void) {
        self.model = model
        self.openURL = openURL
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DripSpace.l) {
                Text("Create a drop.").dripText(.title).foregroundStyle(DripColor.ink)
                    .accessibilityAddTraits(.isHeader)
                switch model.onboarding {
                case .ready:
                    form
                case .unknown, .checking:
                    LoadingStateView("Checking payouts").frame(height: 200)
                case .notStarted, .incomplete:
                    payoutsGate
                case .failed(let m):
                    ErrorStateView(message: m) { Task { await model.refreshOnboarding() } }.frame(height: 300)
                }
            }
            .padding(DripSpace.inset)
        }
        .background(DripColor.cream)
        .task { if model.onboarding == .unknown { await model.refreshOnboarding() } }
        .onChange(of: pickerItem) { _, item in
            guard let item else { return }
            loadingVideo = true
            Task {
                defer { loadingVideo = false }
                if let movie = try? await item.loadTransferable(type: PickedMovie.self) {
                    model.videoFile = movie.url
                }
            }
        }
    }

    private var payoutsGate: some View {
        VStack(alignment: .leading, spacing: DripSpace.m) {
            InfoRow(systemImage: "banknote", text: "Set up payouts with Stripe before your first drop. Drip never sees your bank details.")
            Button(model.onboarding == .incomplete ? "Finish payout setup" : "Set up payouts") {
                Task { if let url = await model.onboardingURL() { openURL(url) } }
            }
            .buttonStyle(.drip(.primary))
            Button("I've finished — check again") { Task { await model.refreshOnboarding() } }
                .buttonStyle(.drip(.secondary))
        }
    }

    @ViewBuilder private var form: some View {
        switch model.publish {
        case .done:
            VStack(spacing: DripSpace.m) {
                EmptyStateView("Uploaded.", message: "Mux is processing your video. That usually takes a minute or two.",
                               systemImage: "checkmark", actionTitle: "Create another") { model.resetForm() }
            }
            .frame(height: 360)
        default:
            VStack(alignment: .leading, spacing: DripSpace.m) {
                PhotosPicker(selection: $pickerItem, matching: .videos) {
                    HStack {
                        Image(systemName: model.videoFile == nil ? "video.badge.plus" : "checkmark.circle.fill")
                        Text(model.videoFile == nil ? "Choose a video" : "Video ready · Replace")
                        Spacer()
                        if loadingVideo { ProgressView() }
                    }
                    .dripText(.product)
                    .foregroundStyle(DripColor.ink)
                    .padding(DripSpace.m)
                    .frame(minHeight: 72)
                    .background(DripColor.peach.opacity(0.55), in: RoundedRectangle(cornerRadius: DripRadius.tile, style: .continuous))
                }
                field("Caption", text: $model.caption, prompt: "What's the story? Up to 500 characters", axis: .vertical)
                field("Hashtags", text: $model.hashtagsText, prompt: "tote, everyday")
                field("Title", text: $model.title, prompt: "The Studio Tote")
                field("Description", text: $model.details, prompt: "Up to 1000 characters", axis: .vertical)
                field("Price (USD)", text: $model.priceText, prompt: "78", keyboard: .decimalPad)
                field("Was (optional)", text: $model.wasPriceText, prompt: "98", keyboard: .decimalPad)
                Picker("Category", selection: $model.category) {
                    ForEach(ListingCategory.allCases) { c in Text(c.displayName).tag(c) }
                }
                .dripText(.body).tint(DripColor.ink)
                Stepper("Inventory: \(model.inventory)", value: $model.inventory, in: 1...100_000)
                    .dripText(.body)
                DisclosureGroup("Shipping package") {
                    numberRow("Weight (oz)", value: $model.weightOz)
                    numberRow("Length (in)", value: $model.lengthIn)
                    numberRow("Width (in)", value: $model.widthIn)
                    numberRow("Height (in)", value: $model.heightIn)
                }
                .dripText(.body).tint(DripColor.ink)
                DisclosureGroup("Options (optional)") {
                    field("Option name", text: $model.variantName, prompt: "Color")
                    field("Choices, comma separated", text: $model.variantOptions, prompt: "Sand, Chocolate")
                }
                .dripText(.body).tint(DripColor.ink)

                if case .failed(let m) = model.publish {
                    Label(m, systemImage: "exclamationmark.circle").dripText(.meta).foregroundStyle(DripColor.saleText)
                }
                publishButton
            }
        }
    }

    @ViewBuilder private var publishButton: some View {
        switch model.publish {
        case .creating:
            ProgressView("Creating your listing…").frame(maxWidth: .infinity)
        case .uploading(let f):
            VStack(alignment: .leading) {
                ProgressView(value: f).tint(DripColor.coral)
                Text("Uploading \(Int(f * 100))%").dripText(.meta).foregroundStyle(DripColor.muted)
            }
        default:
            Button("Publish") { Task { await model.publishListing() } }
                .buttonStyle(.drip(.primary))
                .disabled(!model.validationErrors.isEmpty)
                .accessibilityHint(model.validationErrors.first ?? "")
        }
    }

    private func field(_ label: String, text: Binding<String>, prompt: String,
                       axis: Axis = .horizontal, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).dripText(.meta).foregroundStyle(DripColor.muted)
            TextField(prompt, text: text, axis: axis)
                .keyboardType(keyboard)
                .dripText(.body)
                .padding(DripSpace.s)
                .frame(minHeight: DripSize.preferredHit)
                .background(DripColor.surface, in: RoundedRectangle(cornerRadius: DripRadius.field, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: DripRadius.field, style: .continuous).strokeBorder(DripColor.hairlineStrong))
        }
    }

    private func numberRow(_ label: String, value: Binding<Double>) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField(label, value: value, format: .number.precision(.fractionLength(0...1)))
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
                .frame(width: 80)
        }
        .frame(minHeight: DripSize.minHit)
    }
}
#endif
