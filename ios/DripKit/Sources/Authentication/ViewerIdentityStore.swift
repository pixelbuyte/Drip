import Foundation
import DripModels
import Networking

/// The device's signed viewer identity — the native twin of the web's
/// `drip_aid` cookie. Minted once, kept in the Keychain, reused forever, so
/// likes, saves, follows and feed affinity survive relaunches exactly like
/// the browser's 2-year cookie.
public actor ViewerIdentityStore: ViewerIdentityProvider {
    static let storageKey = "drip.viewer.identity"

    private let baseURL: URL
    private let transport: any HTTPTransport
    private let store: any SecureStore
    private var cached: AnonIdentity?
    private var inFlight: Task<AnonIdentity, any Error>?

    public init(baseURL: URL, transport: any HTTPTransport, store: any SecureStore) {
        self.baseURL = baseURL
        self.transport = transport
        self.store = store
        self.cached = store.value(AnonIdentity.self, for: Self.storageKey)
    }

    public func identity() async throws -> AnonIdentity {
        if let cached { return cached }
        if let inFlight { return try await inFlight.value }

        // A plain client: minting must not itself require an identity.
        let api = APIClient(baseURL: baseURL, transport: transport)
        let task = Task { try await api.send(DripAPI.mintViewerIdentity(existingToken: nil)) }
        inFlight = task
        defer { inFlight = nil }
        let minted = try await task.value
        cached = minted
        try? store.setValue(minted, for: Self.storageKey)
        return minted
    }

    /// Only for a server that rejected the stored token (secret rotated).
    public func reset() {
        cached = nil
        try? store.remove(Self.storageKey)
    }
}
