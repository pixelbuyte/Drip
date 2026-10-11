import Foundation
import Observation
import DripModels

public enum AppTab: String, CaseIterable, Sendable, Hashable {
    case home, discover, drop, following, profile

    public var title: String {
        switch self {
        case .home: return "Home"
        case .discover: return "Discover"
        case .drop: return "Drop"
        case .following: return "Following"
        case .profile: return "Profile"
        }
    }

    public var symbol: String {
        switch self {
        case .home: return "house"
        case .discover: return "magnifyingglass"
        case .drop: return "plus"
        case .following: return "person.2"
        case .profile: return "person"
        }
    }
}

/// Pushed destinations, per tab stack.
public enum AppRoute: Hashable, Sendable {
    case creator(Seller)
    /// A vertical feed opened on items another screen already holds.
    case feed(FeedSeed)
}

public struct FeedSeed: Hashable, Sendable {
    public let id: UUID
    public let items: [FeedItem]
    public let startIndex: Int
    public let source: SeedSource

    public enum SeedSource: Hashable, Sendable {
        case search(String)
        case creator(handle: String)
        case saved
    }

    public init(items: [FeedItem], startIndex: Int, source: SeedSource) {
        self.id = UUID()
        self.items = items
        self.startIndex = startIndex
        self.source = source
    }
}

public enum AppSheet: Identifiable, Hashable, Sendable {
    case signIn
    case bag

    public var id: String {
        switch self {
        case .signIn: return "signIn"
        case .bag: return "bag"
        }
    }
}

/// Owns navigation state: selected tab, one stack per tab, the modal sheet.
@MainActor
@Observable
public final class AppRouter {
    public var selectedTab: AppTab = .home
    public var paths: [AppTab: [AppRoute]] = [:]
    public var sheet: AppSheet?

    public init() {}

    public func push(_ route: AppRoute) {
        paths[selectedTab, default: []].append(route)
    }

    public func popToRoot(_ tab: AppTab) {
        paths[tab] = []
    }

    /// Re-tapping the selected tab returns to its root, the iOS convention.
    public func select(_ tab: AppTab) {
        if tab == selectedTab { popToRoot(tab) } else { selectedTab = tab }
    }

    /// Handles drip:// and https://<site>/ links. Returns false if unknown.
    @discardableResult
    public func handle(_ link: DeepLink) -> Bool {
        switch link {
        case .tab(let t):
            selectedTab = t
        case .creator(let handle):
            selectedTab = .discover
            paths[.discover] = [.creator(Seller(id: "", handle: handle, displayName: "@\(handle)"))]
        case .search:
            selectedTab = .discover
        case .bag:
            sheet = .bag
        case .authCallback:
            // Consumed by ASWebAuthenticationSession; nothing to route.
            break
        }
        return true
    }
}

public enum DeepLink: Equatable, Sendable {
    case tab(AppTab)
    case creator(handle: String)
    case search(String)
    case bag
    case authCallback

    /// drip://home, drip://bag, drip://search?q=..., drip://creator/<handle>,
    /// and the website's /search?q=... URLs (universal links, once the
    /// apple-app-site-association file is served).
    public static func parse(_ url: URL, scheme: String = "drip") -> DeepLink? {
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let query = comps?.queryItems ?? []
        var parts: [String]
        if url.scheme == scheme {
            parts = ([url.host].compactMap { $0 } + url.pathComponents.filter { $0 != "/" })
        } else if url.scheme == "https" {
            parts = url.pathComponents.filter { $0 != "/" }
        } else {
            return nil
        }
        guard let first = parts.first?.lowercased() else { return .tab(.home) }
        parts.removeFirst()
        switch first {
        case "auth-callback": return .authCallback
        case "bag": return .bag
        case "feed", "home": return .tab(.home)
        case "discover": return .tab(.discover)
        case "following": return .tab(.following)
        case "profile": return .tab(.profile)
        case "search":
            let q = query.first { $0.name == "q" }?.value ?? ""
            return .search(q)
        case "creator":
            guard let handle = parts.first, Self.isHandle(handle) else { return nil }
            return .creator(handle: handle)
        default:
            return nil
        }
    }

    static func isHandle(_ s: String) -> Bool {
        (1...40).contains(s.count) && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" || $0 == ".") }
    }
}
