import Foundation
import Observation
import DripModels
import Networking
import Analytics
import Discover
import Media

/// A creator's storefront: the public header (/api/creators/{handle}), their
/// videos (the feed route's `seller_profile` surface) and the viewer's
/// follow state.
@MainActor
@Observable
public final class CreatorProfileModel {
    /// From a deep link only the handle is known; the full record (id,
    /// name, avatar) is adopted from the creator header, or from the first
    /// loaded video if the header is unavailable.
    public private(set) var seller: Seller
    /// The header: follower and live-video counts. `.empty` means the server
    /// has no creator with this handle; `.failed` only costs the counts.
    public private(set) var profile: Loadable<CreatorProfile> = .idle
    public let feed: FeedModel

    private let api: APIClient

    public init(seller: Seller, api: APIClient, tracker: any EventTracking) {
        self.seller = seller
        self.api = api
        self.feed = FeedModel(source: .feed(.sellerProfile, seller: seller.handle), api: api, tracker: tracker)
    }

    public var isFollowing: Bool { feed.following.contains(seller.id) }

    public var followerCount: Int? { profile.value?.followerCount }
    public var liveVideoCount: Int? { profile.value?.liveVideoCount }

    /// The handle resolves to no creator at all (404), as opposed to a
    /// creator with nothing posted yet.
    public var isUnknownCreator: Bool {
        if case .empty = profile { return true }
        return false
    }

    /// Header and videos load concurrently; neither blocks or fails the other.
    public func load() async {
        async let header: Void = loadProfileIfNeeded()
        await feed.loadInitial()
        adoptSellerFromFeed()
        await header
    }

    /// Retry / pull-to-refresh: both halves again.
    public func reload() async {
        async let header: Void = loadProfile()
        await feed.reload()
        adoptSellerFromFeed()
        await header
    }

    private func loadProfileIfNeeded() async {
        switch profile {
        case .idle, .failed: await loadProfile()
        case .loading, .loaded, .empty: return
        }
    }

    private func loadProfile() async {
        let handle = seller.handle
        guard CreatorHandle.normalize(handle) != nil else {
            profile = .empty
            return
        }
        profile = .loading
        do {
            let creator = try await api.send(DripAPI.creator(handle: handle)).creator
            profile = .loaded(creator)
            // The server's record is authoritative for identity.
            if creator.handle.lowercased() == seller.handle.lowercased() {
                seller = creator.seller
            }
        } catch APIError.notFound {
            profile = .empty
        } catch let error as APIError {
            profile = .failed(message: error.userMessage)
        } catch {
            profile = .failed(message: "Could not load this creator.")
        }
    }

    /// Pre-header behaviour, kept as the fallback: a deep-linked seller
    /// (handle only) picks up id, name and avatar from their first video.
    private func adoptSellerFromFeed() {
        guard profile.value == nil,
              let s = feed.items.first?.seller,
              s.handle.lowercased() == seller.handle.lowercased() else { return }
        seller = s
    }

    /// Follow events are keyed to a video (the event schema requires one);
    /// use the creator's latest. With no videos there is nothing to follow from.
    public var canFollow: Bool { !feed.items.isEmpty }

    public func toggleFollow() async {
        guard let first = feed.items.first else { return }
        await feed.toggleFollow(first)
    }
}

/// Seller tooling: Stripe Connect onboarding state and drop creation.
@MainActor
@Observable
public final class StudioModel {
    public enum Onboarding: Equatable, Sendable {
        case unknown, checking, notStarted, incomplete, ready
        case failed(String)
    }

    public enum Publish: Equatable, Sendable {
        case editing
        case creating
        case uploading(Double)
        case done(slug: String)
        case failed(String)
    }

    public private(set) var onboarding: Onboarding = .unknown
    public private(set) var publish: Publish = .editing

    public var title = ""
    public var details = ""
    public var priceText = ""
    public var inventory = 1
    public var weightOz = 8.0
    public var lengthIn = 9.0
    public var widthIn = 6.0
    public var heightIn = 2.0
    public var variantName = ""
    public var variantOptions = ""
    public var caption = ""
    public var hashtagsText = ""
    public var category: ListingCategory = .other
    public var wasPriceText = ""
    public var videoFile: URL?

    private let api: APIClient
    #if canImport(Darwin)
    private let uploader = UploadCoordinator()
    #endif

    public init(api: APIClient) {
        self.api = api
    }

    public func refreshOnboarding() async {
        onboarding = .checking
        do {
            let s = try await api.send(DripAPI.onboardingStatus())
            if s.chargesEnabled { onboarding = .ready }
            else if s.connected == true { onboarding = .incomplete }
            else { onboarding = .notStarted }
        } catch let e as APIError {
            onboarding = .failed(e.userMessage)
        } catch {
            onboarding = .failed("Could not check your payout setup.")
        }
    }

    /// Hosted Stripe Connect onboarding URL, opened in a web auth session.
    public func onboardingURL() async -> URL? {
        guard let link = try? await api.send(DripAPI.startOnboarding()) else { return nil }
        return URL(string: link.url)
    }

    /// Dollars as typed → integer cents, rejecting anything ambiguous.
    public static func cents(from text: String) -> Int? {
        let cleaned = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
        guard !cleaned.isEmpty, let d = Decimal(string: cleaned, locale: Locale(identifier: "en_US")),
              d >= 0 else { return nil }
        let parts = cleaned.split(separator: ".")
        if parts.count == 2, parts[1].count > 2 { return nil }
        var value = d * 100
        var rounded = Decimal()
        NSDecimalRound(&rounded, &value, 0, .plain)
        return NSDecimalNumber(decimal: rounded).intValue
    }

    public var request: CreateListingRequest? {
        guard let cents = Self.cents(from: priceText) else { return nil }
        let options = variantOptions.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let variants: [CreateListingRequest.VariantDimension]? =
            variantName.trimmingCharacters(in: .whitespaces).isEmpty || options.isEmpty
            ? nil : [.init(name: variantName.trimmingCharacters(in: .whitespaces), options: options)]
        let was = wasPriceText.trimmingCharacters(in: .whitespaces)
        let tags = CreateListingRequest.hashtags(from: hashtagsText)
        let captionText = caption.trimmingCharacters(in: .whitespacesAndNewlines)
        return CreateListingRequest(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: details.isEmpty ? nil : details,
            priceCents: cents,
            compareAtPriceCents: was.isEmpty ? nil : Self.cents(from: was),
            inventory: inventory, weightOz: weightOz,
            dimensions: .init(lengthIn: lengthIn, widthIn: widthIn, heightIn: heightIn),
            variants: variants,
            caption: captionText.isEmpty ? nil : captionText,
            hashtags: tags.isEmpty ? nil : tags,
            category: category)
    }

    public var validationErrors: [String] {
        var errors: [String] = []
        if Self.cents(from: priceText) == nil { errors.append("Enter a price like 24 or 24.50") }
        let was = wasPriceText.trimmingCharacters(in: .whitespaces)
        if !was.isEmpty, Self.cents(from: was) == nil { errors.append("Enter the \u{201C}was\u{201D} price like 98") }
        if let r = request { errors += r.validationErrors() }
        if videoFile == nil { errors.append("Choose a video") }
        return errors
    }

    public func publishListing() async {
        guard validationErrors.isEmpty, let request, let file = videoFile else {
            publish = .failed(validationErrors.first ?? "Check the form")
            return
        }
        publish = .creating
        do {
            let created = try await api.send(DripAPI.createListing(request))
            guard let uploadURL = URL(string: created.uploadUrl) else {
                publish = .failed("The upload link was invalid.")
                return
            }
            #if canImport(Darwin)
            publish = .uploading(0)
            try await uploader.upload(file: file, to: uploadURL) { [weak self] p in
                Task { @MainActor in self?.publish = .uploading(p.fraction) }
            }
            #endif
            publish = .done(slug: created.product.slug)
        } catch let e as APIError {
            publish = .failed(e.userMessage)
        } catch UploadError.tooLarge {
            publish = .failed("That video is over 1 GB. Trim it and try again.")
        } catch {
            publish = .failed("The upload didn't finish. Check your connection and try again.")
        }
    }

    public func resetForm() {
        title = ""; details = ""; priceText = ""; inventory = 1
        variantName = ""; variantOptions = ""; videoFile = nil
        caption = ""; hashtagsText = ""; category = .other; wasPriceText = ""
        publish = .editing
    }
}
