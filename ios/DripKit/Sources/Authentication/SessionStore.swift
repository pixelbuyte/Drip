import Foundation
import Networking

/// Owns the signed-in session: persistence, proactive refresh, and a single
/// in-flight refresh shared by every caller (Supabase refresh tokens rotate —
/// two concurrent refreshes with the same token would sign the user out).
public actor SessionStore: AccessTokenProvider {
    public enum State: Sendable, Equatable {
        case signedOut
        case signedIn(AuthUser)
    }

    static let storageKey = "drip.auth.session"

    private let client: SupabaseAuthClient
    private let store: any SecureStore
    private let now: @Sendable () -> Date
    private var session: AuthSession?
    private var refreshTask: Task<RefreshOutcome, Never>?
    private var continuations: [UUID: AsyncStream<State>.Continuation] = [:]

    public init(client: SupabaseAuthClient, store: any SecureStore,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.client = client
        self.store = store
        self.now = now
        self.session = store.value(AuthSession.self, for: Self.storageKey)
    }

    public var state: State {
        session.map { .signedIn($0.user) } ?? .signedOut
    }

    public var currentUser: AuthUser? { session?.user }

    /// Emits the current state immediately, then every change.
    public func states() -> AsyncStream<State> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<State>.makeStream()
        continuation.yield(state)
        continuations[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeContinuation(id) }
        }
        return stream
    }

    private func removeContinuation(_ id: UUID) {
        continuations[id] = nil
    }

    // MARK: Sign-in flows

    public func signIn(email: String, password: String) async throws {
        try adopt(await client.signIn(email: email, password: password))
    }

    public func signUp(email: String, password: String, redirectTo: URL?) async throws {
        try adopt(await client.signUp(email: email, password: password, redirectTo: redirectTo))
    }

    public func sendEmailCode(email: String) async throws {
        try await client.sendEmailCode(email: email)
    }

    public func verifyEmailCode(email: String, code: String) async throws {
        try adopt(await client.verifyEmailCode(email: email, code: code))
    }

    public func signInWithApple(idToken: String, rawNonce: String) async throws {
        try adopt(await client.signInWithApple(idToken: idToken, rawNonce: rawNonce))
    }

    public func completeOAuth(callback: URL, verifier: String) async throws {
        let code = try SupabaseAuthClient.authCode(fromCallback: callback)
        try adopt(await client.exchangeCode(code, verifier: verifier))
    }

    public func oauthURL(provider: String, redirectTo: URL, pkce: PKCE) -> URL {
        client.authorizeURL(provider: provider, redirectTo: redirectTo, challenge: pkce.challenge)
    }

    public func signOut() async {
        let token = session?.accessToken
        clear()
        if let token { await client.signOut(accessToken: token) }
    }

    // MARK: AccessTokenProvider

    public func accessToken() async -> String? {
        guard let session else { return nil }
        if session.needsRefresh(now: now()) {
            return await refreshShared()?.accessToken
        }
        return session.accessToken
    }

    public func refreshAfterUnauthorized() async -> String? {
        await refreshShared()?.accessToken
    }

    // MARK: Internals

    private enum RefreshOutcome: Sendable {
        case refreshed(AuthSession)
        /// Offline or 5xx: keep the session; the request fails and can be retried.
        case unavailable
        /// The server rejected the refresh token: the session is over.
        case revoked
    }

    private func refreshShared() async -> AuthSession? {
        let outcome: RefreshOutcome
        if let refreshTask {
            outcome = await refreshTask.value
        } else {
            guard let refreshToken = session?.refreshToken else { return nil }
            let client = self.client
            let task = Task<RefreshOutcome, Never> {
                do {
                    return .refreshed(try await client.refresh(refreshToken: refreshToken))
                } catch AuthError.invalidCredentials {
                    return .revoked
                } catch {
                    return .unavailable
                }
            }
            refreshTask = task
            outcome = await task.value
            refreshTask = nil
            switch outcome {
            case .refreshed(let s): try? adopt(s)
            case .revoked: if session?.refreshToken == refreshToken { clear() }
            case .unavailable: break
            }
        }
        if case .refreshed(let s) = outcome { return s }
        return nil
    }

    private func adopt(_ new: AuthSession) throws {
        session = new
        try store.setValue(new, for: Self.storageKey)
        broadcast()
    }

    private func clear() {
        session = nil
        try? store.remove(Self.storageKey)
        broadcast()
    }

    private func broadcast() {
        let s = state
        for c in continuations.values { c.yield(s) }
    }
}
