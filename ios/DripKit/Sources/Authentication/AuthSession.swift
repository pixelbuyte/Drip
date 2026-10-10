import Foundation

/// A Supabase Auth session as returned by `/auth/v1/token`. The same user ids
/// the web app's cookies carry — native sign-in reuses existing accounts.
public struct AuthSession: Codable, Sendable, Equatable {
    public var accessToken: String
    public var refreshToken: String
    public var expiresAt: Date
    public var user: AuthUser

    public init(accessToken: String, refreshToken: String, expiresAt: Date, user: AuthUser) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.user = user
    }

    /// Refresh this long before expiry so a request never leaves with a token
    /// that dies in flight.
    public static let refreshMargin: TimeInterval = 60

    public func needsRefresh(now: Date = Date()) -> Bool {
        expiresAt.timeIntervalSince(now) < Self.refreshMargin
    }
}

public struct AuthUser: Codable, Sendable, Equatable {
    public var id: String
    public var email: String?

    public init(id: String, email: String?) {
        self.id = id
        self.email = email
    }
}

/// The token endpoint's raw body.
struct TokenResponse: Decodable {
    var access_token: String
    var refresh_token: String
    var expires_in: Double?
    var expires_at: Double?
    var user: UserBody

    struct UserBody: Decodable {
        var id: String
        var email: String?
    }

    func session(now: Date) -> AuthSession {
        let expiry: Date
        if let at = expires_at {
            expiry = Date(timeIntervalSince1970: at)
        } else {
            expiry = now.addingTimeInterval(expires_in ?? 3600)
        }
        return AuthSession(accessToken: access_token, refreshToken: refresh_token,
                           expiresAt: expiry, user: AuthUser(id: user.id, email: user.email))
    }
}

/// /auth/v1/signup returns either a session (email confirmation off) or just
/// the user (confirmation on). Both shapes decode here.
struct SignUpResponse: Decodable {
    var access_token: String?
    var refresh_token: String?
    var expires_in: Double?
    var expires_at: Double?
    var user: TokenResponse.UserBody?
    var id: String?
    var email: String?
}

public enum AuthError: Error, Sendable, Equatable {
    case invalidCredentials(message: String)
    case emailConfirmationRequired(email: String)
    case network(message: String)
    case server(message: String)
    case cancelled
    case misconfigured(message: String)

    public var userMessage: String {
        switch self {
        case .invalidCredentials(let m): return m
        case .emailConfirmationRequired(let e): return "Check \(e) for a link to confirm your account."
        case .network: return "You're offline. Check your connection and try again."
        case .server(let m): return m
        case .cancelled: return "Sign-in was cancelled."
        case .misconfigured(let m): return m
        }
    }
}
