import Foundation
import DripModels

/// Every failure the network layer can produce, already classified for the UI.
/// Server messages are shown verbatim: the routes write them for buyers
/// ("Sold out", "You have not been charged").
public enum APIError: Error, Sendable, Equatable {
    /// No connection, timeout, DNS — retryable by the user.
    case transport(code: Int, message: String)
    /// 401: the session is missing or expired after a refresh attempt.
    case unauthorized(message: String)
    /// 403
    case forbidden(message: String)
    /// 404
    case notFound(message: String)
    /// 409 — includes `code: "sold_out"` from checkout.
    case conflict(message: String, code: String?, available: Int?)
    /// 400 / 422
    case invalidRequest(message: String)
    /// 429
    case rateLimited(message: String)
    /// 5xx
    case server(status: Int, message: String)
    /// The body did not match the expected contract.
    case decoding(message: String)
    /// Client misconfiguration (missing base URL, bad endpoint path).
    case configuration(message: String)

    public static func from(status: Int, body: Data) -> APIError {
        let parsed = try? JSONDecoder().decode(ServerErrorBody.self, from: body)
        let message = parsed?.error ?? HTTPStatusText.text(for: status)
        switch status {
        case 401: return .unauthorized(message: message)
        case 403: return .forbidden(message: message)
        case 404: return .notFound(message: message)
        case 409: return .conflict(message: message, code: parsed?.code, available: parsed?.available)
        case 400, 413, 422: return .invalidRequest(message: message)
        case 429: return .rateLimited(message: parsed?.error ?? "Slow down a moment.")
        default: return .server(status: status, message: message)
        }
    }

    /// Copy suitable for an inline error state.
    public var userMessage: String {
        switch self {
        case .transport: return "You're offline. Check your connection and try again."
        case .unauthorized: return "Please sign in again."
        case .forbidden(let m), .notFound(let m), .invalidRequest(let m), .rateLimited(let m):
            return m
        case .conflict(let m, _, _): return m
        case .server(_, let m): return m.isEmpty ? "Something went wrong on our side." : m
        case .decoding: return "Something went wrong on our side."
        case .configuration: return "The app is misconfigured."
        }
    }

    public var isRetryable: Bool {
        switch self {
        case .transport, .rateLimited: return true
        case .server(let s, _): return s >= 500
        default: return false
        }
    }
}

enum HTTPStatusText {
    static func text(for status: Int) -> String {
        switch status {
        case 400: return "Invalid request"
        case 401: return "Not signed in"
        case 403: return "Not allowed"
        case 404: return "Not found"
        case 409: return "That is no longer available"
        case 429: return "Slow down a moment."
        default: return "Something went wrong on our side."
        }
    }
}
