import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum HTTPMethod: String, Sendable {
    case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE"
}

public struct HTTPRequest: Sendable, Equatable {
    public var method: HTTPMethod
    public var url: URL
    public var headers: [String: String]
    public var body: Data?
    public var timeout: TimeInterval

    public init(method: HTTPMethod, url: URL, headers: [String: String] = [:],
                body: Data? = nil, timeout: TimeInterval = 20) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
        self.timeout = timeout
    }

    public var urlRequest: URLRequest {
        var r = URLRequest(url: url, timeoutInterval: timeout)
        r.httpMethod = method.rawValue
        r.httpBody = body
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        return r
    }
}

public struct HTTPResponse: Sendable, Equatable {
    public var status: Int
    public var headers: [String: String]
    public var body: Data

    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status
        self.headers = headers
        self.body = body
    }
}

/// The one seam between the app and the network. Tests substitute a stub.
public protocol HTTPTransport: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = URLSessionTransport.makeSession()) {
        self.session = session
    }

    /// Cookie-less on purpose. Identity travels in headers only: the proxy
    /// sets a `drip_aid` cookie on /api/feed responses, and the server checks
    /// that cookie BEFORE `x-drip-anon-token` — a cookie jar would quietly
    /// split one device into two viewers.
    public static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request.urlRequest)
        } catch let error as URLError {
            throw APIError.transport(code: error.code.rawValue, message: error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport(code: -1, message: "Not an HTTP response")
        }
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
            if let k = k as? String, let v = v as? String { headers[k.lowercased()] = v }
        }
        return HTTPResponse(status: http.statusCode, headers: headers, body: data)
    }
}
