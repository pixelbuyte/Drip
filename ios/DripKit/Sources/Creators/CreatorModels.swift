import Foundation
import Observation
import DripModels
import Networking
import Analytics
import Discover
import Media

/// A creator's storefront: their videos (the feed route's `seller_profile`
/// surface) and the viewer's follow state.
@MainActor
@Observable
public final class CreatorProfileModel {
    /// From a deep link only the handle is known; the full record (id,
    /// name, avatar) is adopted from the first loaded video.
    public private(set) var seller: Seller
    public let feed: FeedModel

    public init(seller: Seller, api: APIClient, tracker: any EventTracking) {
        self.seller = seller
        self.feed = FeedModel(source: .feed(.sellerProfile, seller: seller.handle), api: api, tracker: tracker)
    }

    public var isFollowing: Bool { feed.following.contains(seller.id) }

    public func load() async {
        await feed.loadInitial()
        if let s = feed.items.first?.seller, s.handle.lowercased() == seller.handle.lowercased() {
            seller = s
        }
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

    public var request: CreateDropRequest? {
        guard let cents = Self.cents(from: priceText) else { return nil }
        let options = variantOptions.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let variants: [CreateDropRequest.VariantDimension]? =
            variantName.trimmingCharacters(in: .whitespaces).isEmpty || options.isEmpty
            ? nil : [.init(name: variantName.trimmingCharacters(in: .whitespaces), options: options)]
        return CreateDropRequest(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: details.isEmpty ? nil : details,
            priceCents: cents, inventory: inventory, weightOz: weightOz,
            dimensions: .init(lengthIn: lengthIn, widthIn: widthIn, heightIn: heightIn),
            variants: variants)
    }

    public var validationErrors: [String] {
        var errors: [String] = []
        if Self.cents(from: priceText) == nil { errors.append("Enter a price like 24 or 24.50") }
        if let r = request { errors += r.validationErrors() }
        if videoFile == nil { errors.append("Choose a video") }
        return errors
    }

    public func publishDrop() async {
        guard validationErrors.isEmpty, let request, let file = videoFile else {
            publish = .failed(validationErrors.first ?? "Check the form")
            return
        }
        publish = .creating
        do {
            let created = try await api.send(DripAPI.createDrop(request))
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
            publish = .done(slug: created.drop.slug)
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
        publish = .editing
    }
}
