#if canImport(AuthenticationServices) && canImport(UIKit)
import AuthenticationServices
import UIKit

/// ASWebAuthenticationSession as async/await. Used for Google sign-in (PKCE)
/// and hosted Stripe Connect onboarding — both are web flows that must not
/// run inside an embedded web view.
@MainActor
public final class WebAuthenticator: NSObject, ASWebAuthenticationPresentationContextProviding {
    public override init() {}

    public func start(url: URL, callbackScheme: String, ephemeral: Bool = false) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(throwing: AuthError.cancelled)
                } else {
                    continuation.resume(throwing: AuthError.server(message: error?.localizedDescription ?? "Sign-in failed."))
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = ephemeral
            if !session.start() {
                continuation.resume(throwing: AuthError.misconfigured(message: "Could not open the sign-in page."))
            }
        }
    }

    public nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        }
    }
}
#endif
