import Foundation
import DripModels
import Networking

/// A scripted HTTP transport: routes by path, records every request.
public final class StubTransport: HTTPTransport, @unchecked Sendable {
    public typealias Handler = @Sendable (HTTPRequest) throws -> HTTPResponse

    private let lock = NSLock()
    private var handlers: [(match: @Sendable (HTTPRequest) -> Bool, handler: Handler)] = []
    private var _requests: [HTTPRequest] = []

    public init() {}

    public var requests: [HTTPRequest] {
        lock.lock(); defer { lock.unlock() }
        return _requests
    }

    public func requests(to path: String) -> [HTTPRequest] {
        requests.filter { $0.url.path == path }
    }

    /// Later registrations win, so a test can override a default.
    public func on(_ path: String, method: HTTPMethod? = nil, _ handler: @escaping Handler) {
        lock.lock(); defer { lock.unlock() }
        handlers.insert(({ req in req.url.path == path && (method == nil || req.method == method!) }, handler), at: 0)
    }

    public func onJSON(_ path: String, method: HTTPMethod? = nil, status: Int = 200, _ json: String) {
        on(path, method: method) { _ in HTTPResponse(status: status, body: Data(json.utf8)) }
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let handler: Handler? = {
            lock.lock(); defer { lock.unlock() }
            _requests.append(request)
            return handlers.first { $0.match(request) }?.handler
        }()
        guard let handler else {
            return HTTPResponse(status: 404, body: Data(#"{"error":"no stub for \#(request.url.path)"}"#.utf8))
        }
        return try handler(request)
    }
}

public extension HTTPRequest {
    var queryItems: [String: String] {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        return Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
    }

    var jsonBody: [String: Any] {
        guard let body, let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return [:] }
        return obj
    }
}

/// A fixed identity provider so tests don't need the mint endpoint.
public struct FixedViewer: ViewerIdentityProvider {
    public let token: String
    public init(token: String = "v1.11111111-1111-4111-8111-111111111111.sig") { self.token = token }
    public func identity() async throws -> AnonIdentity {
        AnonIdentity(anonId: "11111111-1111-4111-8111-111111111111", token: token)
    }
}


/// Tokens on demand, counting refreshes.
public actor FakeTokens: AccessTokenProvider {
    public var token: String?
    public var refreshed: String?
    public private(set) var refreshCount = 0

    public init(token: String?, refreshed: String? = nil) {
        self.token = token
        self.refreshed = refreshed
    }

    public func accessToken() async -> String? { token }

    public func refreshAfterUnauthorized() async -> String? {
        refreshCount += 1
        token = refreshed
        return refreshed
    }
}

public enum Fixtures {
    public static let videoA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    public static let videoB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    public static let seller = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    public static let product = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

    /// A FeedItem as /api/feed serializes it (src/lib/feed/types.ts).
    public static func itemJSON(_ videoId: String, position: Int = 0, lane: String = "chrono") -> String {
        """
        {"videoId":"\(videoId)","playbackId":"pb\(position)","durationSeconds":20,"aspectRatio":"9:16",
         "thumbnailUrl":null,"caption":"The everyday rotation.","hashtags":["tote"],"categorySlug":"bags",
         "seller":{"id":"\(seller)","handle":"maya","displayName":"Maya Chen","avatarUrl":null},
         "products":[{"id":"\(product)","title":"The Studio Tote","priceCents":7800,"compareAtPriceCents":9800,
           "inventoryCount":5,"lowStockThreshold":3,"images":["https://img.test/a.jpg"],
           "variants":[{"id":"g1","name":"Color","options":[
              {"id":"o1","value":"Chocolate","priceDeltaCents":0,"inventoryCount":3,"sku":null},
              {"id":"o2","value":"Sand","priceDeltaCents":500,"inventoryCount":0,"sku":"S-1"}]}],
           "position":0,"pinnedAtSecond":null}],
         "lane":"\(lane)","position":\(position)}
        """
    }

    public static func feedJSON(_ ids: [String], nextBefore: String? = nil, exhausted: Bool = false,
                                session: String = "s") -> String {
        let items = ids.enumerated().map { itemJSON($1, position: $0) }.joined(separator: ",")
        let nb = nextBefore.map { "\"\($0)\"" } ?? "null"
        return #"{"items":[\#(items)],"sessionId":"\#(session)","surface":"for_you","exhausted":\#(exhausted),"mode":"default","nextBefore":\#(nb)}"#
    }

    public static func uuid(_ n: Int) -> String {
        String(format: "%08x-0000-4000-8000-%012x", n, n)
    }
}
