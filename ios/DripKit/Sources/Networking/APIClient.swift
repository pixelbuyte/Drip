import Foundation
import DripModels

/// Supplies the signed-in user's access token, refreshing it when asked.
/// Implemented by Authentication's `SessionStore`; Networking only sees this.
public protocol AccessTokenProvider: Sendable {
    /// A currently-valid access token, or nil when signed out.
    func accessToken() async -> String?
    /// Called once after a 401. Returns a new token, or nil if the session is gone.
    func refreshAfterUnauthorized() async -> String?
}

/// Supplies the signed viewer identity sent as `x-drip-anon-token`.
public protocol ViewerIdentityProvider: Sendable {
    func identity() async throws -> AnonIdentity
}

public enum AuthRequirement: Sendable, Equatable {
    /// No Authorization header.
    case none
    /// Send the token when signed in; the route works for guests too.
    case optional
    /// Fail fast with `.unauthorized` when signed out.
    case required
}

/// A typed call against the Drip backend.
public struct Endpoint<Response: Decodable & Sendable>: Sendable {
    public var method: HTTPMethod
    public var path: String
    public var query: [URLQueryItem]
    public var body: Data?
    public var auth: AuthRequirement
    public var sendsViewerIdentity: Bool
    public var timeout: TimeInterval

    public init(_ method: HTTPMethod, _ path: String, query: [URLQueryItem] = [], body: Data? = nil,
                auth: AuthRequirement = .none, sendsViewerIdentity: Bool = false,
                timeout: TimeInterval = 20) {
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.auth = auth
        self.sendsViewerIdentity = sendsViewerIdentity
        self.timeout = timeout
    }
}

/// Used by endpoints whose success body the app ignores (202 Accepted etc).
public struct EmptyResponse: Decodable, Sendable, Equatable {
    public init() {}
}

public final class APIClient: Sendable {
    public static let anonTokenHeader = "x-drip-anon-token"

    public let baseURL: URL
    private let transport: any HTTPTransport
    private let tokens: (any AccessTokenProvider)?
    private let viewer: (any ViewerIdentityProvider)?
    private let userAgent: String

    public init(baseURL: URL, transport: any HTTPTransport,
                tokens: (any AccessTokenProvider)? = nil,
                viewer: (any ViewerIdentityProvider)? = nil,
                userAgent: String = "DripiOS") {
        self.baseURL = baseURL
        self.transport = transport
        self.tokens = tokens
        self.viewer = viewer
        self.userAgent = userAgent
    }

    public func send<R>(_ endpoint: Endpoint<R>) async throws -> R {
        let response = try await perform(endpoint)
        return try decode(R.self, from: response)
    }

    /// Exposed for endpoints that need the raw status (e.g. events' 202).
    public func perform<R>(_ endpoint: Endpoint<R>) async throws -> HTTPResponse {
        var token: String? = nil
        if endpoint.auth != .none {
            token = await tokens?.accessToken()
            if token == nil, endpoint.auth == .required {
                throw APIError.unauthorized(message: "Please sign in.")
            }
        }

        var request = try makeRequest(endpoint, token: token)
        if endpoint.sendsViewerIdentity, let viewer {
            request.headers[Self.anonTokenHeader] = try await viewer.identity().token
        }

        var response = try await transport.send(request)

        // One refresh-and-retry on 401. Never more: a second 401 means the
        // session is genuinely gone, and looping would hammer the auth server.
        if response.status == 401, token != nil, let tokens,
           let fresh = await tokens.refreshAfterUnauthorized() {
            request.headers["Authorization"] = "Bearer \(fresh)"
            response = try await transport.send(request)
        }

        guard (200..<300).contains(response.status) else {
            throw APIError.from(status: response.status, body: response.body)
        }
        return response
    }

    func makeRequest<R>(_ endpoint: Endpoint<R>, token: String?) throws -> HTTPRequest {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.configuration(message: "Bad base URL")
        }
        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = basePath + (endpoint.path.hasPrefix("/") ? endpoint.path : "/" + endpoint.path)
        if !endpoint.query.isEmpty { components.queryItems = endpoint.query }
        guard let url = components.url else {
            throw APIError.configuration(message: "Bad endpoint path \(endpoint.path)")
        }
        var headers = ["Accept": "application/json", "User-Agent": userAgent]
        if endpoint.body != nil { headers["Content-Type"] = "application/json" }
        if let token { headers["Authorization"] = "Bearer \(token)" }
        return HTTPRequest(method: endpoint.method, url: url, headers: headers,
                           body: endpoint.body, timeout: endpoint.timeout)
    }

    func decode<R: Decodable>(_ type: R.Type, from response: HTTPResponse) throws -> R {
        if R.self == EmptyResponse.self { return EmptyResponse() as! R }
        do {
            return try JSONDecoder().decode(R.self, from: response.body)
        } catch {
            throw APIError.decoding(message: String(describing: error))
        }
    }
}

public extension JSONEncoder {
    static let drip: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }()
}
