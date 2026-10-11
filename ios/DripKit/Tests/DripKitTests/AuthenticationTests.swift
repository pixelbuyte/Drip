import XCTest
import DripModels
import Networking
import Authentication
import TestSupport

final class CryptoTests: XCTestCase {
    func hex(_ b: [UInt8]) -> String { b.map { String(format: "%02x", $0) }.joined() }

    func testSHA256KnownVectors() {
        XCTAssertEqual(hex(SHA256Digest.hash([])),
                       "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(hex(SHA256Digest.hash(Array("abc".utf8))),
                       "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        // Two-block message (crosses the 56-byte padding boundary).
        XCTAssertEqual(hex(SHA256Digest.hash(Array("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".utf8))),
                       "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
    }

    func testPKCEMatchesRFC7636AppendixB() {
        let p = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(p.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testGeneratedVerifierIsWithinRFCLength() {
        let v = PKCE.generate().verifier
        XCTAssertTrue((43...128).contains(v.count))
        XCTAssertFalse(v.contains("=") || v.contains("+") || v.contains("/"))
    }
}

final class SessionStoreTests: XCTestCase {
    let project = URL(string: "https://proj.supabase.test")!

    func tokenJSON(access: String, refresh: String, expiresIn: Int = 3600) -> String {
        #"{"access_token":"\#(access)","refresh_token":"\#(refresh)","expires_in":\#(expiresIn),"token_type":"bearer","user":{"id":"u1","email":"a@b.co"}}"#
    }

    func testPasswordSignInPersistsToSecureStore() async throws {
        let t = StubTransport()
        t.onJSON("/auth/v1/token", tokenJSON(access: "A1", refresh: "R1"))
        let store = InMemorySecureStore()
        let s = SessionStore(client: SupabaseAuthClient(projectURL: project, anonKey: "anon", transport: t), store: store)
        try await s.signIn(email: "a@b.co", password: "pw")
        let token = await s.accessToken()
        XCTAssertEqual(token, "A1")
        let req = try XCTUnwrap(t.requests.first)
        XCTAssertEqual(req.queryItems["grant_type"], "password")
        XCTAssertEqual(req.headers["apikey"], "anon")

        // A fresh store instance (app relaunch) restores the session.
        let relaunched = SessionStore(client: SupabaseAuthClient(projectURL: project, anonKey: "anon", transport: t), store: store)
        let state = await relaunched.state
        XCTAssertEqual(state, .signedIn(AuthUser(id: "u1", email: "a@b.co")))
    }

    func testConcurrentRefreshesShareOneRequest() async throws {
        let t = StubTransport()
        t.on("/auth/v1/token") { req in
            if req.queryItems["grant_type"] == "refresh_token" {
                Thread.sleep(forTimeInterval: 0.05)
                return HTTPResponse(status: 200, body: Data(self.tokenJSON(access: "A2", refresh: "R2").utf8))
            }
            return HTTPResponse(status: 200, body: Data(self.tokenJSON(access: "A1", refresh: "R1", expiresIn: 10).utf8))
        }
        let s = SessionStore(client: SupabaseAuthClient(projectURL: project, anonKey: "anon", transport: t),
                             store: InMemorySecureStore())
        try await s.signIn(email: "a@b.co", password: "pw")   // expires within the refresh margin
        async let a = s.accessToken()
        async let b = s.accessToken()
        async let c = s.refreshAfterUnauthorized()
        let results = await [a, b, c]
        XCTAssertEqual(results, ["A2", "A2", "A2"])
        let refreshes = t.requests.filter { $0.queryItems["grant_type"] == "refresh_token" }
        XCTAssertEqual(refreshes.count, 1, "rotating refresh tokens must never be spent twice")
    }

    func testRevokedRefreshSignsOutButOfflineDoesNot() async throws {
        let t = StubTransport()
        t.onJSON("/auth/v1/token", tokenJSON(access: "A1", refresh: "R1", expiresIn: 10))
        let s = SessionStore(client: SupabaseAuthClient(projectURL: project, anonKey: "anon", transport: t),
                             store: InMemorySecureStore())
        try await s.signIn(email: "a@b.co", password: "pw")

        t.on("/auth/v1/token") { _ in throw APIError.transport(code: -1009, message: "offline") }
        _ = await s.refreshAfterUnauthorized()
        var state = await s.state
        XCTAssertNotEqual(state, .signedOut, "offline must not sign the user out")

        t.onJSON("/auth/v1/token", status: 400, #"{"error":"invalid_grant","error_description":"Invalid Refresh Token"}"#)
        _ = await s.refreshAfterUnauthorized()
        state = await s.state
        XCTAssertEqual(state, .signedOut)
    }

    func testSignUpWithConfirmationRequiredSurfacesIt() async {
        let t = StubTransport()
        t.onJSON("/auth/v1/signup", #"{"id":"u1","email":"a@b.co"}"#)
        let s = SessionStore(client: SupabaseAuthClient(projectURL: project, anonKey: "anon", transport: t),
                             store: InMemorySecureStore())
        do {
            try await s.signUp(email: "a@b.co", password: "longpassword", redirectTo: nil)
            XCTFail("expected confirmation")
        } catch {
            XCTAssertEqual(error as? AuthError, .emailConfirmationRequired(email: "a@b.co"))
        }
    }

    func testOAuthURLAndCallbackParsing() throws {
        let client = SupabaseAuthClient(projectURL: project, anonKey: "anon", transport: StubTransport())
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        let url = client.authorizeURL(provider: "google", redirectTo: URL(string: "drip://auth-callback")!,
                                      challenge: pkce.challenge)
        let q = HTTPRequest(method: .get, url: url).queryItems
        XCTAssertEqual(url.path, "/auth/v1/authorize")
        XCTAssertEqual(q["code_challenge"], pkce.challenge)
        XCTAssertEqual(q["code_challenge_method"], "s256")
        XCTAssertEqual(try SupabaseAuthClient.authCode(fromCallback: URL(string: "drip://auth-callback?code=xyz")!), "xyz")
        XCTAssertThrowsError(try SupabaseAuthClient.authCode(fromCallback: URL(string: "drip://auth-callback?error=access_denied")!))
    }
}

final class ViewerIdentityTests: XCTestCase {
    func testMintsOnceAndReusesFromTheKeychain() async throws {
        let t = StubTransport()
        t.onJSON("/api/session/anon", #"{"anonId":"11111111-1111-4111-8111-111111111111","token":"v1.x.sig"}"#)
        let store = InMemorySecureStore()
        let base = URL(string: "https://drip.test")!
        let v = ViewerIdentityStore(baseURL: base, transport: t, store: store)
        async let a = v.identity()
        async let b = v.identity()
        let (ia, ib) = try await (a, b)
        XCTAssertEqual(ia, ib)
        XCTAssertEqual(t.requests(to: "/api/session/anon").count, 1)

        let relaunched = ViewerIdentityStore(baseURL: base, transport: t, store: store)
        _ = try await relaunched.identity()
        XCTAssertEqual(t.requests(to: "/api/session/anon").count, 1, "a relaunch must not fork the device")
    }
}
