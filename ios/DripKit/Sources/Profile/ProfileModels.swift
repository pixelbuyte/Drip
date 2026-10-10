import Foundation
import Observation
import DripModels
import Networking
import Authentication

/// Sign-in screen state. Every path ends in `SessionStore`, which persists
/// the session in the Keychain; on success the device's viewer identity is
/// linked to the account (claim_anon_identity — it refuses to merge another
/// account's history, which is a normal outcome, not an error).
@MainActor
@Observable
public final class SignInModel {
    public enum Mode: Equatable, Sendable { case signIn, signUp, emailCode }
    public enum Status: Equatable, Sendable {
        case idle, working
        case codeSent(email: String)
        case confirmEmail(email: String)
        case failed(String)
        case signedIn
    }

    public var mode: Mode = .signIn
    public var email = ""
    public var password = ""
    public var code = ""
    public private(set) var status: Status = .idle

    private let session: SessionStore
    private let api: APIClient
    private let redirectURL: URL

    public init(session: SessionStore, api: APIClient, redirectURL: URL) {
        self.session = session
        self.api = api
        self.redirectURL = redirectURL
    }

    public var canSubmit: Bool {
        let e = email.trimmingCharacters(in: .whitespaces)
        guard e.contains("@"), e.contains(".") else { return false }
        switch mode {
        case .signIn: return !password.isEmpty
        case .signUp: return password.count >= 8
        case .emailCode:
            if case .codeSent = status { return code.count >= 6 }
            return true
        }
    }

    public func submit() async {
        let e = email.trimmingCharacters(in: .whitespaces).lowercased()
        status = .working
        do {
            switch mode {
            case .signIn:
                try await session.signIn(email: e, password: password)
            case .signUp:
                try await session.signUp(email: e, password: password, redirectTo: redirectURL)
            case .emailCode:
                if case .codeSent = status {
                    try await session.verifyEmailCode(email: e, code: code.trimmingCharacters(in: .whitespaces))
                } else {
                    try await session.sendEmailCode(email: e)
                    status = .codeSent(email: e)
                    return
                }
            }
            await didSignIn()
        } catch AuthError.emailConfirmationRequired(let address) {
            status = .confirmEmail(email: address)
        } catch let error as AuthError {
            status = .failed(error.userMessage)
        } catch {
            status = .failed("Sign-in failed. Try again.")
        }
    }

    /// Re-entrant guard for "codeSent" when the user edits the address.
    public func resetCode() {
        code = ""
        status = .idle
    }

    public func signInWithApple(idToken: String, rawNonce: String) async {
        status = .working
        do {
            try await session.signInWithApple(idToken: idToken, rawNonce: rawNonce)
            await didSignIn()
        } catch let error as AuthError {
            status = .failed(error.userMessage)
        } catch {
            status = .failed("Sign in with Apple failed.")
        }
    }

    public func completeOAuth(callback: URL, verifier: String) async {
        status = .working
        do {
            try await session.completeOAuth(callback: callback, verifier: verifier)
            await didSignIn()
        } catch AuthError.cancelled {
            status = .idle
        } catch let error as AuthError {
            status = .failed(error.userMessage)
        } catch {
            status = .failed("Sign-in failed.")
        }
    }

    public func oauthURL(provider: String, pkce: PKCE) async -> URL {
        await session.oauthURL(provider: provider, redirectTo: redirectURL, pkce: pkce)
    }

    public func cancelled() { status = .idle }

    private func didSignIn() async {
        status = .signedIn
        // Best-effort: carry this device's likes/saves/follows to the account.
        _ = try? await api.send(DripAPI.linkViewerIdentity())
    }
}

/// Profile tab: account + saved items.
@MainActor
@Observable
public final class ProfileModel {
    public private(set) var user: AuthUser?
    public private(set) var saved: Loadable<[FeedItem]> = .idle

    private let session: SessionStore
    private let api: APIClient

    public init(session: SessionStore, api: APIClient) {
        self.session = session
        self.api = api
    }

    public func observeSession() async {
        for await state in await session.states() {
            switch state {
            case .signedIn(let u): user = u
            case .signedOut: user = nil
            }
        }
    }

    public func loadSaved() async {
        saved = .loading
        do {
            let r = try await api.send(DripAPI.savedItems())
            saved = r.items.isEmpty ? .empty : .loaded(r.items)
        } catch let e as APIError {
            saved = .failed(message: e.userMessage)
        } catch {
            saved = .failed(message: "Could not load your saved finds.")
        }
    }

    public func signOut() async {
        await session.signOut()
    }
}
