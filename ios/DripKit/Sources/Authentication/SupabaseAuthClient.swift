import Foundation
import Networking

/// Minimal Supabase Auth (GoTrue) REST client. Only the anon (publishable)
/// key is ever used — it is public by design and is already shipped to every
/// browser. The service-role key never exists in the app.
public struct SupabaseAuthClient: Sendable {
    public let projectURL: URL
    private let anonKey: String
    private let transport: any HTTPTransport
    private let now: @Sendable () -> Date

    public init(projectURL: URL, anonKey: String, transport: any HTTPTransport,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.projectURL = projectURL
        self.anonKey = anonKey
        self.transport = transport
        self.now = now
    }

    // MARK: Password

    public func signIn(email: String, password: String) async throws -> AuthSession {
        try await token(grant: "password", body: ["email": email, "password": password])
    }

    public func signUp(email: String, password: String, redirectTo: URL?) async throws -> AuthSession {
        var query: [URLQueryItem] = []
        if let redirectTo { query.append(URLQueryItem(name: "redirect_to", value: redirectTo.absoluteString)) }
        let response = try await post("/auth/v1/signup", query: query,
                                      body: ["email": email, "password": password])
        let decoded = try decode(SignUpResponse.self, response)
        if let access = decoded.access_token, let refresh = decoded.refresh_token, let user = decoded.user {
            let body = TokenResponse(access_token: access, refresh_token: refresh,
                                     expires_in: decoded.expires_in, expires_at: decoded.expires_at, user: user)
            return body.session(now: now())
        }
        throw AuthError.emailConfirmationRequired(email: email)
    }

    // MARK: Email one-time code

    /// Sends a 6-digit code (and magic link) to the address.
    public func sendEmailCode(email: String, createUser: Bool = true) async throws {
        _ = try await post("/auth/v1/otp", body: ["email": email, "create_user": createUser])
    }

    public func verifyEmailCode(email: String, code: String) async throws -> AuthSession {
        let response = try await post("/auth/v1/verify",
                                      body: ["type": "email", "email": email, "token": code])
        return try decode(TokenResponse.self, response).session(now: now())
    }

    // MARK: Sign in with Apple

    /// Exchanges Apple's identity token. `rawNonce` is the unhashed nonce whose
    /// SHA-256 was given to ASAuthorizationAppleIDRequest.
    public func signInWithApple(idToken: String, rawNonce: String) async throws -> AuthSession {
        try await token(grant: "id_token",
                        body: ["provider": "apple", "id_token": idToken, "nonce": rawNonce])
    }

    // MARK: OAuth (PKCE)

    /// URL to open in ASWebAuthenticationSession. Keep `verifier` for exchange.
    public func authorizeURL(provider: String, redirectTo: URL, challenge: String) -> URL {
        var c = URLComponents(url: projectURL.appendingPathComponent("auth/v1/authorize"),
                              resolvingAgainstBaseURL: false)!
        c.queryItems = [
            URLQueryItem(name: "provider", value: provider),
            URLQueryItem(name: "redirect_to", value: redirectTo.absoluteString),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "s256"),
        ]
        return c.url!
    }

    /// The `code` query item from the callback URL, or the provider's error.
    public static func authCode(fromCallback url: URL) throws -> String {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty { return code }
        let reason = items.first(where: { $0.name == "error_description" })?.value
            ?? items.first(where: { $0.name == "error" })?.value
            ?? "Sign-in did not complete."
        throw AuthError.server(message: reason)
    }

    public func exchangeCode(_ code: String, verifier: String) async throws -> AuthSession {
        try await token(grant: "pkce", body: ["auth_code": code, "code_verifier": verifier])
    }

    // MARK: Session lifecycle

    public func refresh(refreshToken: String) async throws -> AuthSession {
        try await token(grant: "refresh_token", body: ["refresh_token": refreshToken])
    }

    /// Revokes the refresh token server-side. Local sign-out proceeds even if
    /// this fails (offline), so it never strands a user signed in.
    public func signOut(accessToken: String) async {
        let req = HTTPRequest(method: .post, url: url("/auth/v1/logout", query: []),
                              headers: headers(bearer: accessToken))
        _ = try? await transport.send(req)
    }

    // MARK: Plumbing

    private func token(grant: String, body: [String: any Sendable]) async throws -> AuthSession {
        let response = try await post("/auth/v1/token",
                                      query: [URLQueryItem(name: "grant_type", value: grant)], body: body)
        return try decode(TokenResponse.self, response).session(now: now())
    }

    private func post(_ path: String, query: [URLQueryItem] = [], body: [String: any Sendable]) async throws -> HTTPResponse {
        let data: Data
        do {
            data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        } catch {
            throw AuthError.misconfigured(message: "Could not encode request")
        }
        var h = headers(bearer: nil)
        h["Content-Type"] = "application/json"
        let req = HTTPRequest(method: .post, url: url(path, query: query), headers: h, body: data)
        let response: HTTPResponse
        do {
            response = try await transport.send(req)
        } catch {
            throw AuthError.network(message: String(describing: error))
        }
        guard (200..<300).contains(response.status) else {
            throw Self.error(status: response.status, body: response.body)
        }
        return response
    }

    private func headers(bearer: String?) -> [String: String] {
        var h = ["apikey": anonKey, "Accept": "application/json", "X-Client-Info": "drip-ios"]
        h["Authorization"] = "Bearer \(bearer ?? anonKey)"
        return h
    }

    private func url(_ path: String, query: [URLQueryItem]) -> URL {
        var c = URLComponents(url: projectURL, resolvingAgainstBaseURL: false)!
        c.path = (c.path.hasSuffix("/") ? String(c.path.dropLast()) : c.path) + path
        if !query.isEmpty { c.queryItems = query }
        return c.url!
    }

    private func decode<T: Decodable>(_ type: T.Type, _ response: HTTPResponse) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: response.body)
        } catch {
            throw AuthError.server(message: "Unexpected response from sign-in.")
        }
    }

    /// GoTrue's error bodies vary by version: `error_description`, `msg`,
    /// `message` or `error`. Take the first present.
    static func error(status: Int, body: Data) -> AuthError {
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        let message = ["error_description", "msg", "message", "error"]
            .compactMap { json[$0] as? String }.first ?? "Sign-in failed."
        if status == 400 || status == 401 || status == 422 {
            return .invalidCredentials(message: message)
        }
        return .server(message: message)
    }
}
