import XCTest
import DripModels
import Networking
import Analytics
import DesignSystem
import Products
@testable import Commerce
import Creators
@testable import AppCore
import TestSupport

final class ProductSelectionTests: XCTestCase {
    func product() throws -> FeedProduct {
        let feed = try JSONDecoder().decode(FeedResponse.self, from: Data(Fixtures.feedJSON([Fixtures.videoA]).utf8))
        return feed.items[0].products[0]
    }

    func testSingleInStockOptionIsPreselectedAndPricingMatchesTheServer() throws {
        var s = ProductSelection(product: try product())
        // "Sand" is out of stock, so "Chocolate" is the only choice.
        XCTAssertTrue(s.isComplete)
        XCTAssertEqual(s.serverSelection, ["Color": "Chocolate"])
        s.choose(optionId: "o2", in: "g1")   // sold out: ignored
        XCTAssertEqual(s.serverSelection, ["Color": "Chocolate"])
        s.quantity = 50
        XCTAssertEqual(s.quantity, 3, "capped by the option's inventory")
        XCTAssertEqual(s.subtotal, Money(cents: 7800 * 3))
        XCTAssertTrue(s.isPurchasable)
    }

    func testQuantityNeverExceedsTheServerCapOf10() {
        let p = FeedProduct(id: "p", title: "t", priceCents: 100, inventoryCount: 99)
        var s = ProductSelection(product: p)
        s.quantity = 25
        XCTAssertEqual(s.quantity, 10)
    }

    func testMissingChoiceBlocksPurchase() {
        let group = VariantGroup(id: "g", name: "Size", options: [
            VariantOption(id: "s", value: "S", inventoryCount: 2), VariantOption(id: "m", value: "M", priceDeltaCents: 200, inventoryCount: 2)])
        var s = ProductSelection(product: FeedProduct(id: "p", title: "t", priceCents: 1000, inventoryCount: 4, variants: [group]))
        XCTAssertEqual(s.blockingReason, "Choose a size")
        XCTAssertFalse(s.isPurchasable)
        s.choose(optionId: "m", in: "g")
        XCTAssertEqual(s.unitPrice, Money(cents: 1200))
        XCTAssertNil(s.blockingReason)
    }
}

@MainActor
final class CheckoutModelTests: XCTestCase {
    let intentJSON = #"{"clientSecret":"pi_1_secret_x","paymentIntentId":"pi_1","subtotalCents":7800,"shippingCents":624,"totalCents":8424,"title":"The Studio Tote","sellerHandle":"maya"}"#

    func make(_ t: StubTransport, outcome: PaymentOutcome = .completed) throws -> (CheckoutModel, RecordingTracker, ScriptedPaymentPresenter) {
        let feed = try JSONDecoder().decode(FeedResponse.self, from: Data(Fixtures.feedJSON([Fixtures.videoA]).utf8))
        let tracker = RecordingTracker()
        let pay = ScriptedPaymentPresenter(outcome: outcome)
        let api = APIClient(baseURL: URL(string: "https://drip.test")!, transport: t, viewer: FixedViewer())
        let m = CheckoutModel(videoId: Fixtures.videoA, selection: ProductSelection(product: feed.items[0].products[0]),
                              sellerHandle: "maya", email: "buyer@example.com", api: api, payments: pay,
                              tracker: tracker, sessionId: "s", surface: .forYou, idempotencyKey: "0123456789abcdef0123")
        return (m, tracker, pay)
    }

    func testQuoteThenPaySucceedsAndNeverSendsAnAmount() async throws {
        let t = StubTransport()
        t.onJSON("/api/checkout/intent", intentJSON)
        let (m, tracker, pay) = try make(t)
        await m.open()
        await m.quote()
        guard case .ready(let intent) = m.phase else { return XCTFail("\(m.phase)") }
        XCTAssertEqual(intent.totalCents, 8424)

        let body = t.requests(to: "/api/checkout/intent")[0].jsonBody
        XCTAssertNil(body["amount"]); XCTAssertNil(body["price_cents"])
        XCTAssertEqual(body["idempotency_key"] as? String, "0123456789abcdef0123")
        XCTAssertEqual(body["email"] as? String, "buyer@example.com")
        XCTAssertEqual(body["selection"] as? [String: String], ["Color": "Chocolate"])

        await m.pay()
        guard case .succeeded = m.phase else { return XCTFail("\(m.phase)") }
        XCTAssertEqual(pay.presented.first?.clientSecret, "pi_1_secret_x")
        await m.close()
        let kinds = await tracker.kinds
        XCTAssertEqual(kinds, [.checkoutOpen], "no abandon after a purchase, and no client-asserted purchase event")
    }

    func testSoldOutIsItsOwnState() async throws {
        let t = StubTransport()
        t.onJSON("/api/checkout/intent", status: 409, #"{"error":"Sold out","code":"sold_out","available":0}"#)
        let (m, _, _) = try make(t)
        await m.quote()
        XCTAssertEqual(m.phase, .soldOut(available: 0))
    }

    func testCancelReturnsToReadyAndCloseReportsAbandon() async throws {
        let t = StubTransport()
        t.onJSON("/api/checkout/intent", intentJSON)
        let (m, tracker, _) = try make(t, outcome: .canceled)
        await m.open()
        await m.quote()
        await m.pay()
        guard case .ready = m.phase else { return XCTFail("\(m.phase)") }
        await m.close()
        let kinds = await tracker.kinds
        XCTAssertEqual(kinds, [.checkoutOpen, .checkoutAbandon])
    }

    func testRetryReusesTheSameIdempotencyKey() async throws {
        let t = StubTransport()
        t.onJSON("/api/checkout/intent", status: 500, #"{"error":"Something went wrong on our side. You have not been charged."}"#)
        let (m, _, _) = try make(t)
        await m.quote()
        t.onJSON("/api/checkout/intent", intentJSON)
        await m.quote()
        let keys = t.requests(to: "/api/checkout/intent").map { $0.jsonBody["idempotency_key"] as? String }
        XCTAssertEqual(Set(keys.compactMap { $0 }).count, 1)
    }

    func testEmailValidation() async {
        XCTAssertTrue(CheckoutModel.isPlausibleEmail("a@b.co"))
        XCTAssertFalse(CheckoutModel.isPlausibleEmail("a@b"))
        XCTAssertFalse(CheckoutModel.isPlausibleEmail("a b@c.co"))
    }
}

@MainActor
final class BagStoreTests: XCTestCase {
    func testMergesSameChoicesAndPersists() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("bag-\(UUID()).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let p = FeedProduct(id: "p", title: "t", priceCents: 500, inventoryCount: 20)
        let bag = BagStore(fileURL: url)
        var s = ProductSelection(product: p)
        s.quantity = 2
        bag.add(s, videoId: "v", sellerHandle: "h")
        bag.add(s, videoId: "v", sellerHandle: "h")
        XCTAssertEqual(bag.lines.count, 1)
        XCTAssertEqual(bag.count, 4)
        XCTAssertEqual(bag.estimatedSubtotal, Money(cents: 2000))

        let reopened = BagStore(fileURL: url)
        XCTAssertEqual(reopened.lines, bag.lines)
        reopened.remove(reopened.lines[0].id)
        XCTAssertTrue(BagStore(fileURL: url).lines.isEmpty)
    }
}

@MainActor
final class StudioTests: XCTestCase {
    func testPriceParsing() async {
        XCTAssertEqual(StudioModel.cents(from: "78"), 7800)
        XCTAssertEqual(StudioModel.cents(from: "$24.50"), 2450)
        XCTAssertEqual(StudioModel.cents(from: "1,200"), 120_000)
        XCTAssertNil(StudioModel.cents(from: "24.505"))
        XCTAssertNil(StudioModel.cents(from: "abc"))
    }

    func testOnboardingStates() async {
        let t = StubTransport()
        t.onJSON("/api/stripe/onboarding/status", #"{"connected":true,"charges_enabled":false,"payouts_enabled":false,"requirements":[]}"#)
        let m = StudioModel(api: APIClient(baseURL: URL(string: "https://drip.test")!, transport: t, tokens: FakeTokens(token: "jwt")))
        await m.refreshOnboarding()
        XCTAssertEqual(m.onboarding, .incomplete)
        XCTAssertEqual(t.requests.first?.headers["Authorization"], "Bearer jwt")
    }
}

final class AppConfigurationTests: XCTestCase {
    let valid: [String: Any] = [
        "DripAPIBaseURL": "https://drip.example.com",
        "DripSupabaseURL": "https://proj.supabase.co",
        "DripSupabaseAnonKey": "sb_publishable_abc",
        "DripStripePublishableKey": "pk_test_123",
        "DripURLScheme": "drip",
    ]

    func testAcceptsPublicValues() throws {
        let c = try AppConfiguration.from(valid)
        XCTAssertEqual(c.authCallbackURL.absoluteString, "drip://auth-callback")
        XCTAssertNil(c.appleMerchantId)
    }

    func testRejectsSecretsAndUnexpandedVariables() {
        var v = valid
        v["DripStripePublishableKey"] = "sk_live_123"
        v["DripSupabaseAnonKey"] = "sb_secret_abc"
        v["DripAPIBaseURL"] = "$(DRIP_API_BASE_URL)"
        XCTAssertThrowsError(try AppConfiguration.from(v)) { error in
            let problems = (error as? AppConfiguration.Invalid)?.problems ?? []
            XCTAssertEqual(problems.count, 3, "\(problems)")
        }
    }

    func testDetectsLegacyServiceRoleJWT() {
        // {"role":"service_role"} as a JWT payload.
        let payload = Data(#"{"role":"service_role"}"#.utf8).base64EncodedString()
            .replacingOccurrences(of: "=", with: "")
        XCTAssertTrue(AppConfiguration.looksLikeServiceRole("eyJhbGciOiJIUzI1NiJ9.\(payload).sig"))
        let anon = Data(#"{"role":"anon"}"#.utf8).base64EncodedString().replacingOccurrences(of: "=", with: "")
        XCTAssertFalse(AppConfiguration.looksLikeServiceRole("eyJhbGciOiJIUzI1NiJ9.\(anon).sig"))
    }

    func testRejectsPlainHTTPExceptLocalhost() {
        var v = valid
        v["DripAPIBaseURL"] = "http://drip.example.com"
        XCTAssertThrowsError(try AppConfiguration.from(v))
        v["DripAPIBaseURL"] = "http://localhost:3000"
        XCTAssertNoThrow(try AppConfiguration.from(v))
    }
}

@MainActor
final class RoutingTests: XCTestCase {
    func testDeepLinks() async {
        XCTAssertEqual(DeepLink.parse(URL(string: "drip://bag")!), .bag)
        XCTAssertEqual(DeepLink.parse(URL(string: "drip://creator/maya")!), .creator(handle: "maya"))
        XCTAssertEqual(DeepLink.parse(URL(string: "drip://search?q=tote")!), .search("tote"))
        XCTAssertEqual(DeepLink.parse(URL(string: "https://drip.example.com/search?q=denim")!), .search("denim"))
        XCTAssertEqual(DeepLink.parse(URL(string: "drip://auth-callback?code=1")!), .authCallback)
        XCTAssertNil(DeepLink.parse(URL(string: "drip://creator/..%2Fx")!))
        XCTAssertNil(DeepLink.parse(URL(string: "drip://creator/..")!))
        XCTAssertNil(DeepLink.parse(URL(string: "drip://creator/a.b")!))
        XCTAssertEqual(DeepLink.parse(URL(string: "drip://creator/Maya_Chen")!), .creator(handle: "maya_chen"))
        XCTAssertNil(DeepLink.parse(URL(string: "javascript://x")!))
    }

    func testReselectingATabPopsToRoot() async {
        let r = AppRouter()
        r.push(.creator(Seller(id: "s", handle: "h", displayName: "H")))
        XCTAssertEqual(r.paths[.home]?.count, 1)
        r.select(.home)
        XCTAssertEqual(r.paths[.home], [])
        r.handle(.bag)
        XCTAssertEqual(r.sheet, .bag)
    }
}

final class DesignTokenTests: XCTestCase {
    /// docs/product-design/tokens.json "contrast" — the package's accessibility
    /// claims, recomputed from the shipped colour values.
    func testContrastTableFromTokensJSON() {
        let table: [(RGB, RGB, Double)] = [
            (DripPalette.ink, DripPalette.cream, 16.44),
            (DripPalette.muted, DripPalette.cream, 5.65),
            (DripPalette.ink, DripPalette.coral, 5.16),
            (DripPalette.coralText, DripPalette.cream, 4.95),
            (DripPalette.ink, DripPalette.lime, 13.06),
            (DripPalette.saleText, DripPalette.peach, 4.98),
            (DripPalette.successText, DripPalette.mint, 6.95),
        ]
        for (fg, bg, expected) in table {
            XCTAssertEqual(fg.contrast(with: bg), expected, accuracy: 0.02)
            XCTAssertGreaterThanOrEqual(fg.contrast(with: bg), 4.5, "AA body text")
        }
    }

    func testWhiteOnCoralFailsWhichIsWhyCoralButtonsUseInk() {
        XCTAssertLessThan(DripPalette.white.contrast(with: DripPalette.coral), 4.5)
    }

    func testReduceMotionCapsDurations() {
        XCTAssertEqual(DripMotionSpec.duration(DripMotionSpec.successMs, reduceMotion: true), 0.1)
        XCTAssertEqual(DripMotionSpec.duration(DripMotionSpec.likeMs, reduceMotion: false), 0.26)
    }

    func testCompactCounts() {
        XCTAssertEqual(CountFormat.compact(328), "328")
        XCTAssertEqual(CountFormat.compact(1_000), "1K")
        XCTAssertEqual(CountFormat.compact(12_400), "12.4K")
        XCTAssertEqual(CountFormat.compact(12_490), "12.4K", "truncates, never rounds up past the real count")
        XCTAssertEqual(CountFormat.compact(250_000), "250K")
        XCTAssertEqual(CountFormat.compact(3_000_000), "3M")
        XCTAssertEqual(CountFormat.compact(1_250_000), "1.2M")
        XCTAssertEqual(CountFormat.compact(-4), "0")
    }
}
