import XCTest
import DripModels
import Networking
import Analytics
import Discover
import Explore
import Creators
@testable import AppCore
import TestSupport

// GET /api/categories and GET /api/creators/{handle}: wire decoding, the
// endpoints, and the Explore / creator-profile models that consume them.
// Every @MainActor test is async: synchronous @MainActor XCTest methods
// crash on Linux.

enum CatalogFixtures {
    static let categoriesJSON = #"""
    {"categories":[{"slug":"apparel","name":"Apparel"},{"slug":"jewelry-accessories","name":"Jewelry & Accessories"}]}
    """#

    /// As src/lib/creators.ts serializes it (no bio column exists yet).
    static func creatorJSON(handle: String = "maya", followers: Int = 12_400, live: Int = 7,
                            displayName: String = "Maya Chen") -> String {
        #"{"creator":{"id":"\#(Fixtures.seller)","handle":"\#(handle)","displayName":"\#(displayName)","avatarUrl":"https://img.test/m.jpg","followerCount":\#(followers),"liveVideoCount":\#(live)}}"#
    }
}

final class CatalogWireTests: XCTestCase {
    func testCategoriesDecodeInServerOrder() throws {
        let r = try JSONDecoder().decode(CategoriesResponse.self, from: Data(CatalogFixtures.categoriesJSON.utf8))
        XCTAssertEqual(r.categories, [
            CatalogCategory(slug: "apparel", name: "Apparel"),
            CatalogCategory(slug: "jewelry-accessories", name: "Jewelry & Accessories"),
        ])
        XCTAssertEqual(r.categories[1].id, "jewelry-accessories")
    }

    func testCreatorDecodesWithoutBioAndExposesTheSeller() throws {
        let r = try JSONDecoder().decode(CreatorResponse.self, from: Data(CatalogFixtures.creatorJSON().utf8))
        XCTAssertNil(r.creator.bio)
        XCTAssertEqual(r.creator.followerCount, 12_400)
        XCTAssertEqual(r.creator.liveVideoCount, 7)
        XCTAssertEqual(r.creator.seller, Seller(id: Fixtures.seller, handle: "maya", displayName: "Maya Chen",
                                                avatarUrl: "https://img.test/m.jpg"))
    }

    func testCreatorDecodesABioIfTheServerStartsSendingOne() throws {
        let json = #"{"creator":{"id":"x","handle":"maya","displayName":"M","avatarUrl":null,"bio":"Thrifted.","followerCount":0,"liveVideoCount":0}}"#
        let r = try JSONDecoder().decode(CreatorResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.creator.bio, "Thrifted.")
        XCTAssertNil(r.creator.avatarUrl)
    }

    func testCreatorMissingCountsIsADecodingErrorNotAZero() {
        let json = #"{"creator":{"id":"x","handle":"maya","displayName":"M","avatarUrl":null}}"#
        XCTAssertThrowsError(try JSONDecoder().decode(CreatorResponse.self, from: Data(json.utf8)))
    }

    func testHandleNormalizationMirrorsTheDatabaseRule() {
        XCTAssertEqual(CreatorHandle.normalize("Maya_Chen"), "maya_chen")
        XCTAssertEqual(CreatorHandle.normalize("@maya"), "maya")
        XCTAssertEqual(CreatorHandle.normalize(" maya "), "maya")
        XCTAssertEqual(CreatorHandle.normalize(String(repeating: "a", count: 30)), String(repeating: "a", count: 30))
        for bad in ["ab", String(repeating: "a", count: 31), "maya-chen", "..", "a/b", "@@maya", "mäya", ""] {
            XCTAssertNil(CreatorHandle.normalize(bad), bad)
        }
    }
}

final class CatalogEndpointTests: XCTestCase {
    let base = URL(string: "https://drip.test")!

    func testCategoriesIsAPlainPublicGet() async throws {
        let t = StubTransport()
        t.onJSON("/api/categories", CatalogFixtures.categoriesJSON)
        let api = APIClient(baseURL: base, transport: t, tokens: FakeTokens(token: "jwt"), viewer: FixedViewer())
        let r = try await api.send(DripAPI.categories())
        XCTAssertEqual(r.categories.count, 2)

        let req = try XCTUnwrap(t.requests(to: "/api/categories").first)
        XCTAssertEqual(req.method, .get)
        XCTAssertNil(req.headers["Authorization"], "public and CDN-cached: no token")
        XCTAssertNil(req.headers[APIClient.anonTokenHeader], "no viewer identity either")
    }

    func testCreatorPathUsesTheNormalizedHandle() async throws {
        let t = StubTransport()
        t.onJSON("/api/creators/maya", CatalogFixtures.creatorJSON())
        let api = APIClient(baseURL: base, transport: t, tokens: FakeTokens(token: "jwt"), viewer: FixedViewer())
        let r = try await api.send(DripAPI.creator(handle: "@Maya"))
        XCTAssertEqual(r.creator.handle, "maya")
        let req = try XCTUnwrap(t.requests.first)
        XCTAssertEqual(req.url.path, "/api/creators/maya")
        XCTAssertNil(req.headers["Authorization"])
        XCTAssertNil(req.headers[APIClient.anonTokenHeader])
    }

    func testAMalformedHandleCannotEscapeTheCreatorsPath() async {
        let t = StubTransport()
        let api = APIClient(baseURL: base, transport: t)
        do {
            _ = try await api.send(DripAPI.creator(handle: "../me/orders"))
            XCTFail("should 404")
        } catch let e as APIError {
            guard case .notFound = e else { return XCTFail("\(e)") }
        } catch { XCTFail("\(error)") }
        let path = t.requests.first?.url.path ?? ""
        XCTAssertTrue(path.hasPrefix("/api/creators/"), path)
        XCTAssertEqual(path.split(separator: "/").count, 3, "one segment after /api/creators: \(path)")
    }

    func testCreator404MapsToNotFound() async {
        let t = StubTransport()
        t.onJSON("/api/creators/nobody", status: 404, #"{"error":"Creator not found"}"#)
        let api = APIClient(baseURL: base, transport: t)
        do {
            _ = try await api.send(DripAPI.creator(handle: "nobody"))
            XCTFail("should throw")
        } catch let e as APIError {
            XCTAssertEqual(e, .notFound(message: "Creator not found"))
        } catch { XCTFail("\(error)") }
    }
}

@MainActor
final class ExploreCategoriesTests: XCTestCase {
    func makeModel(_ t: StubTransport) -> ExploreModel {
        ExploreModel(api: APIClient(baseURL: URL(string: "https://drip.test")!, transport: t, viewer: FixedViewer()))
    }

    func testLoadsTilesOnceThenNoOps() async {
        let t = StubTransport()
        t.onJSON("/api/categories", CatalogFixtures.categoriesJSON)
        let m = makeModel(t)
        XCTAssertEqual(m.categories, .idle)
        await m.loadCategories()
        XCTAssertEqual(m.categories.value?.map(\.slug), ["apparel", "jewelry-accessories"])
        await m.loadCategories()   // the view's .task fires on every appearance
        XCTAssertEqual(t.requests(to: "/api/categories").count, 1)
    }

    func testEmptyListIsEmptyNotLoaded() async {
        let t = StubTransport()
        t.onJSON("/api/categories", #"{"categories":[]}"#)
        let m = makeModel(t)
        await m.loadCategories()
        XCTAssertEqual(m.categories, .empty)
    }

    func testFailureShowsTheServerMessageAndRetryRecovers() async {
        let t = StubTransport()
        t.onJSON("/api/categories", status: 500, #"{"error":"Could not load categories"}"#)
        let m = makeModel(t)
        await m.loadCategories()
        XCTAssertEqual(m.categories, .failed(message: "Could not load categories"))

        t.onJSON("/api/categories", CatalogFixtures.categoriesJSON)
        await m.loadCategories()   // a failed load is retried on the next appearance
        XCTAssertEqual(m.categories.value?.count, 2)
    }

    func testReloadAfterSuccessFetchesAgain() async {
        let t = StubTransport()
        t.onJSON("/api/categories", CatalogFixtures.categoriesJSON)
        let m = makeModel(t)
        await m.loadCategories()
        await m.reloadCategories()
        XCTAssertEqual(t.requests(to: "/api/categories").count, 2)
    }

    func testBadBodyIsAFriendlyFailure() async {
        let t = StubTransport()
        t.onJSON("/api/categories", #"{"nope":true}"#)
        let m = makeModel(t)
        await m.loadCategories()
        XCTAssertEqual(m.categories, .failed(message: "Something went wrong on our side."))
    }

    func testCategoriesDoNotDisturbSearch() async {
        let t = StubTransport()
        t.onJSON("/api/categories", CatalogFixtures.categoriesJSON)
        let m = makeModel(t)
        await m.loadCategories()
        XCTAssertEqual(m.results, .idle)
        XCTAssertTrue(t.requests(to: "/api/search").isEmpty)
    }

    func testATileOpensTheCategorySurfaceFilteredBySlug() async {
        let category = CatalogCategory(slug: "vintage-thrift", name: "Vintage & Thrift")
        XCTAssertEqual(ExploreModel.feedSource(for: category), .feed(.category, category: "vintage-thrift"))

        let t = StubTransport()
        t.onJSON("/api/feed", Fixtures.feedJSON([Fixtures.videoA]))
        t.onJSON("/api/me/reactions", #"{"liked":[],"saved":[],"following":[]}"#)
        let api = APIClient(baseURL: URL(string: "https://drip.test")!, transport: t, viewer: FixedViewer())
        let feed = FeedModel(source: ExploreModel.feedSource(for: category), api: api, tracker: RecordingTracker())
        await feed.loadInitial()
        let q = t.requests(to: "/api/feed").first?.queryItems ?? [:]
        XCTAssertEqual(q["surface"], "category")
        XCTAssertEqual(q["category"], "vintage-thrift")
        XCTAssertNil(q["seller"])
        XCTAssertEqual(feed.surface, .category)
    }

    func testCategoryRouteIsHashableAndPushes() async {
        let r = AppRouter()
        r.selectedTab = .discover
        let c = CatalogCategory(slug: "pet", name: "Pet")
        r.push(.category(c))
        XCTAssertEqual(r.paths[.discover], [.category(c)])
    }
}

@MainActor
final class CreatorProfileModelTests: XCTestCase {
    func makeModel(_ t: StubTransport, seller: Seller = Seller(id: "", handle: "maya", displayName: "@maya"))
        -> CreatorProfileModel {
        let api = APIClient(baseURL: URL(string: "https://drip.test")!, transport: t, viewer: FixedViewer())
        return CreatorProfileModel(seller: seller, api: api, tracker: RecordingTracker())
    }

    func stubFeed(_ t: StubTransport, ids: [String] = [Fixtures.videoA], following: [String] = []) {
        t.onJSON("/api/feed", Fixtures.feedJSON(ids))
        let f = following.map { "\"\($0)\"" }.joined(separator: ",")
        t.onJSON("/api/me/reactions", #"{"liked":[],"saved":[],"following":[\#(f)]}"#)
    }

    func testLoadsHeaderCountsAlongsideTheVideos() async {
        let t = StubTransport()
        stubFeed(t)
        t.onJSON("/api/creators/maya", CatalogFixtures.creatorJSON(followers: 12_400, live: 7))
        let m = makeModel(t)
        await m.load()

        XCTAssertEqual(m.followerCount, 12_400)
        XCTAssertEqual(m.liveVideoCount, 7)
        XCTAssertEqual(m.feed.phase, .loaded)
        XCTAssertEqual(m.seller.id, Fixtures.seller, "deep-linked seller adopts the real id")
        XCTAssertEqual(m.seller.avatarUrl, "https://img.test/m.jpg")
        XCTAssertEqual(t.requests(to: "/api/creators/maya").count, 1)
        // Feed request is unchanged: same surface and handle as before.
        let q = t.requests(to: "/api/feed").first?.queryItems ?? [:]
        XCTAssertEqual(q["surface"], "seller_profile")
        XCTAssertEqual(q["seller"], "maya")
    }

    func testHeaderFailureKeepsTheOldBehaviourAndAdoptsFromTheFirstVideo() async {
        let t = StubTransport()
        stubFeed(t)
        t.onJSON("/api/creators/maya", status: 500, #"{"error":"Could not load this creator"}"#)
        let m = makeModel(t)
        await m.load()

        XCTAssertEqual(m.profile, .failed(message: "Could not load this creator"))
        XCTAssertNil(m.followerCount)
        XCTAssertNil(m.liveVideoCount)
        XCTAssertEqual(m.feed.phase, .loaded, "the grid does not depend on the header")
        XCTAssertEqual(m.seller.id, Fixtures.seller, "adopted from the first video, as before")
        XCTAssertEqual(m.seller.displayName, "Maya Chen")
        XCTAssertFalse(m.isUnknownCreator)
    }

    func testUnknownHandleIsEmptyNotAnError() async {
        let t = StubTransport()
        t.onJSON("/api/feed", Fixtures.feedJSON([], exhausted: true))
        t.onJSON("/api/creators/ghost", status: 404, #"{"error":"Creator not found"}"#)
        let m = makeModel(t, seller: Seller(id: "", handle: "ghost", displayName: "@ghost"))
        await m.load()

        XCTAssertEqual(m.profile, .empty)
        XCTAssertTrue(m.isUnknownCreator)
        XCTAssertEqual(m.feed.phase, .empty)
        XCTAssertEqual(m.seller.displayName, "@ghost", "nothing to adopt")
    }

    func testCreatorWithoutVideosStillGetsAHeader() async {
        // A creator page can exist before payouts: the server returns the
        // profile with liveVideoCount 0 and the feed is empty.
        let t = StubTransport()
        t.onJSON("/api/feed", Fixtures.feedJSON([], exhausted: true))
        t.onJSON("/api/creators/maya", CatalogFixtures.creatorJSON(followers: 3, live: 0))
        let m = makeModel(t)
        await m.load()

        XCTAssertEqual(m.followerCount, 3)
        XCTAssertEqual(m.liveVideoCount, 0)
        XCTAssertEqual(m.seller.displayName, "Maya Chen")
        XCTAssertFalse(m.isUnknownCreator)
        XCTAssertFalse(m.canFollow, "follow events still need a video")
    }

    func testFollowStateUsesTheIdFromTheHeader() async {
        let t = StubTransport()
        stubFeed(t, following: [Fixtures.seller])
        t.onJSON("/api/creators/maya", CatalogFixtures.creatorJSON())
        let m = makeModel(t)
        await m.load()
        XCTAssertTrue(m.isFollowing)
    }

    func testAMalformedHandleSkipsTheHeaderRequest() async {
        let t = StubTransport()
        t.onJSON("/api/feed", Fixtures.feedJSON([], exhausted: true))
        let m = makeModel(t, seller: Seller(id: "", handle: "a", displayName: "@a"))
        await m.load()
        XCTAssertEqual(m.profile, .empty)
        XCTAssertTrue(t.requests.allSatisfy { !$0.url.path.hasPrefix("/api/creators") })
    }

    func testLoadDoesNotRefetchALoadedHeaderButReloadDoes() async {
        let t = StubTransport()
        stubFeed(t)
        t.onJSON("/api/creators/maya", CatalogFixtures.creatorJSON(followers: 1))
        let m = makeModel(t)
        await m.load()
        await m.load()
        XCTAssertEqual(t.requests(to: "/api/creators/maya").count, 1)

        t.onJSON("/api/creators/maya", CatalogFixtures.creatorJSON(followers: 2))
        await m.reload()
        XCTAssertEqual(t.requests(to: "/api/creators/maya").count, 2)
        XCTAssertEqual(m.followerCount, 2)
    }

    func testHeaderForADifferentHandleIsNotAdopted() async {
        // Defensive: the server echoes the stored handle; a mismatch must not
        // swap the identity the screen was opened for.
        let t = StubTransport()
        t.onJSON("/api/feed", Fixtures.feedJSON([], exhausted: true))
        t.onJSON("/api/creators/maya", CatalogFixtures.creatorJSON(handle: "someone_else"))
        let m = makeModel(t)
        await m.load()
        XCTAssertEqual(m.seller.handle, "maya")
        XCTAssertEqual(m.seller.id, "")
    }
}
