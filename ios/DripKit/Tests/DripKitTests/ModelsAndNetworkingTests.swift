import XCTest
import DripModels
import Networking
import TestSupport

final class ModelDecodingTests: XCTestCase {
    func testDecodesTheFeedWireContract() throws {
        let data = Data(Fixtures.feedJSON([Fixtures.videoA], nextBefore: "2026-08-01T12:00:00Z").utf8)
        let feed = try JSONDecoder().decode(FeedResponse.self, from: data)
        XCTAssertEqual(feed.items.count, 1)
        let item = feed.items[0]
        XCTAssertEqual(item.videoId, Fixtures.videoA)
        XCTAssertEqual(item.seller.handle, "maya")
        XCTAssertEqual(item.products[0].priceCents, 7800)
        XCTAssertEqual(item.products[0].variants[0].options[1].priceDeltaCents, 500)
        XCTAssertEqual(item.aspectRatioValue!, 9.0 / 16.0, accuracy: 0.0001)
        XCTAssertEqual(feed.nextBefore, "2026-08-01T12:00:00Z")
        XCTAssertEqual(feed.surface, .forYou)
    }

    func testUnknownLaneDoesNotBlankTheFeed() throws {
        let json = #"{"items":[\#(Fixtures.itemJSON(Fixtures.videoA, lane: "brand_new_lane"))],"sessionId":"s","surface":"for_you","exhausted":false,"mode":"default","nextBefore":null}"#
        let feed = try JSONDecoder().decode(FeedResponse.self, from: Data(json.utf8))
        XCTAssertEqual(feed.items[0].lane, .unknown)
    }

    func testFeaturedProductHonoursPinnedSecond() {
        let early = FeedProduct(id: "p1", title: "A", priceCents: 100, inventoryCount: 1, position: 0, pinnedAtSecond: nil)
        let later = FeedProduct(id: "p2", title: "B", priceCents: 100, inventoryCount: 1, position: 1, pinnedAtSecond: 8)
        let item = FeedItem(videoId: "v", playbackId: nil, durationSeconds: 20,
                            seller: Seller(id: "s", handle: "h", displayName: "H"), products: [early, later])
        XCTAssertEqual(item.featuredProduct(atSecond: 2)?.id, "p1")
        XCTAssertEqual(item.featuredProduct(atSecond: 9)?.id, "p2")
    }

    func testMoneyFormatsLikeTheWebShelf() {
        XCTAssertEqual(Money(cents: 7800).formatted, "$78")
        XCTAssertEqual(Money(cents: 8424).formatted, "$84.24")
        XCTAssertEqual(Money(cents: 7800).percentOff(from: Money(cents: 9800)), 20)
        XCTAssertNil(Money(cents: 100).percentOff(from: Money(cents: 100)))
    }

    func testCompareAtPriceOnlyWhenHigher() {
        let p = FeedProduct(id: "p", title: "t", priceCents: 500, compareAtPriceCents: 400, inventoryCount: 1)
        XCTAssertNil(p.compareAtPrice)
        XCTAssertTrue(FeedProduct(id: "p", title: "t", priceCents: 1, inventoryCount: 2, lowStockThreshold: 3).isLowStock)
        XCTAssertTrue(FeedProduct(id: "p", title: "t", priceCents: 1, inventoryCount: 0).isSoldOut)
    }

    func testPaymentIntentRequestUsesTheRoutesSnakeCaseKeys() throws {
        let body = PaymentIntentRequest(videoId: "v", productId: "p", quantity: 2, selection: ["Color": "Sand"],
                                        idempotencyKey: "0123456789abcdef", email: "a@b.co")
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as! [String: Any]
        XCTAssertEqual(Set(json.keys), ["video_id", "product_id", "quantity", "selection", "idempotency_key", "email"])
    }

    func testCreateDropValidationMirrorsTheServerSchema() {
        let ok = CreateDropRequest(title: "Tote", description: nil, priceCents: 7800, inventory: 3, weightOz: 8,
                                   dimensions: .init(lengthIn: 9, widthIn: 6, heightIn: 2), variants: nil)
        XCTAssertEqual(ok.validationErrors(), [])
        var bad = ok
        bad.priceCents = 99
        bad.variants = [.init(name: "Color", options: ["a", "b", "c", "d", "e", "f"])]
        XCTAssertEqual(bad.validationErrors(), ["Minimum price is $1.00", "Max 5 options per variant"])
    }
}

final class APIClientTests: XCTestCase {
    let base = URL(string: "https://drip.test")!

    func testSendsBearerAndSignedViewerTokenButNeverACookie() async throws {
        let t = StubTransport()
        t.onJSON("/api/checkout/intent", #"{"clientSecret":"cs","paymentIntentId":"pi","subtotalCents":1,"shippingCents":0,"totalCents":1,"title":"t","sellerHandle":"h"}"#)
        let api = APIClient(baseURL: base, transport: t, tokens: FakeTokens(token: "jwt"), viewer: FixedViewer(token: "v1.signed"))
        _ = try await api.send(DripAPI.createPaymentIntent(.init(videoId: "v", productId: "p", quantity: 1,
                                                                selection: nil, idempotencyKey: "0123456789abcdef", email: nil)))
        let req = try XCTUnwrap(t.requests.first)
        XCTAssertEqual(req.headers["Authorization"], "Bearer jwt")
        XCTAssertEqual(req.headers["x-drip-anon-token"], "v1.signed")
        XCTAssertNil(req.headers["Cookie"])
        XCTAssertEqual(req.headers["Content-Type"], "application/json")
    }

    func testRefreshesOnceOn401ThenRetries() async throws {
        let t = StubTransport()
        t.on("/api/drops") { req in
            req.headers["Authorization"] == "Bearer fresh"
                ? HTTPResponse(status: 200, body: Data(#"{"drop":{"id":"d","slug":"s"},"upload_url":"https://u.test"}"#.utf8))
                : HTTPResponse(status: 401, body: Data(#"{"error":"Not authenticated"}"#.utf8))
        }
        let tokens = FakeTokens(token: "stale", refreshed: "fresh")
        let api = APIClient(baseURL: base, transport: t, tokens: tokens)
        let r = try await api.send(DripAPI.createDrop(.init(title: "t", description: nil, priceCents: 100, inventory: 1,
                                                            weightOz: 1, dimensions: .init(lengthIn: 1, widthIn: 1, heightIn: 1), variants: nil)))
        XCTAssertEqual(r.uploadUrl, "https://u.test")
        let count = await tokens.refreshCount
        XCTAssertEqual(count, 1)
        XCTAssertEqual(t.requests.count, 2)
    }

    func testSecond401SurfacesUnauthorizedWithoutLooping() async {
        let t = StubTransport()
        t.onJSON("/api/stripe/onboarding/status", status: 401, #"{"error":"Not authenticated"}"#)
        let api = APIClient(baseURL: base, transport: t, tokens: FakeTokens(token: "a", refreshed: "b"))
        do {
            _ = try await api.send(DripAPI.onboardingStatus())
            XCTFail("expected unauthorized")
        } catch {
            XCTAssertEqual(error as? APIError, .unauthorized(message: "Not authenticated"))
        }
        XCTAssertEqual(t.requests.count, 2)
    }

    func testRequiredAuthFailsFastWhenSignedOut() async {
        let t = StubTransport()
        let api = APIClient(baseURL: base, transport: t, tokens: FakeTokens(token: nil))
        do {
            _ = try await api.send(DripAPI.onboardingStatus())
            XCTFail("expected unauthorized")
        } catch {
            guard case .unauthorized = error as? APIError else { return XCTFail("\(error)") }
        }
        XCTAssertTrue(t.requests.isEmpty)
    }

    func testMapsSoldOutConflict() {
        let e = APIError.from(status: 409, body: Data(#"{"error":"Sold out","code":"sold_out","available":2}"#.utf8))
        XCTAssertEqual(e, .conflict(message: "Sold out", code: "sold_out", available: 2))
        XCTAssertEqual(APIError.from(status: 503, body: Data()).isRetryable, true)
    }

    func testFeedQueryCapsExcludeIdsUnderTheServers8000CharLimit() throws {
        let ids = (0..<400).map(Fixtures.uuid)
        let e = DripAPI.feed(.init(sessionId: "s", excludeIds: ids, before: "2026-01-01T00:00:00Z", offset: 40))
        let exclude = try XCTUnwrap(e.query.first { $0.name == "exclude_ids" }?.value)
        XCTAssertLessThanOrEqual(exclude.count, 8_000)
        XCTAssertEqual(exclude.split(separator: ",").count, FeedConstants.maxExcludeIds)
        XCTAssertTrue(exclude.hasSuffix(Fixtures.uuid(399)), "keeps the most recent ids")
        XCTAssertEqual(e.query.first { $0.name == "offset" }?.value, "40")
        XCTAssertTrue(e.sendsViewerIdentity)
    }

    func testBaseURLWithPathIsPreserved() async throws {
        let t = StubTransport()
        t.onJSON("/prefix/api/me/reactions", #"{"liked":[],"saved":[],"following":[]}"#)
        let api = APIClient(baseURL: URL(string: "https://drip.test/prefix/")!, transport: t)
        _ = try await api.send(DripAPI.reactions(videoIds: ["a"], sellerIds: []))
        XCTAssertEqual(t.requests.first?.url.path, "/prefix/api/me/reactions")
    }
}
