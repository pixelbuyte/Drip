import XCTest
import DripModels
import Networking
import Analytics
import Discover
@testable import AppCore
import TestSupport

final class ShareLinkURLTests: XCTestCase {
    func testShareURLIsThePerVideoPage() {
        let base = URL(string: "https://drip.test")!
        XCTAssertEqual(ShareLinks.videoURL(base: base, videoId: Fixtures.videoA).absoluteString,
                       "https://drip.test/v/\(Fixtures.videoA)")
        XCTAssertEqual(ShareLinks.videoURL(base: URL(string: "https://drip.test/")!, videoId: Fixtures.videoA).absoluteString,
                       "https://drip.test/v/\(Fixtures.videoA)")
        XCTAssertEqual(ShareLinks.videoURL(base: base, videoId: Fixtures.videoA.uppercased()).absoluteString,
                       "https://drip.test/v/\(Fixtures.videoA)", "routes match lowercase uuids only")
    }

    func testANonUUIDNeverBecomesALink() {
        let base = URL(string: "https://drip.test")!
        XCTAssertEqual(ShareLinks.videoURL(base: base, videoId: "../admin"), base)
        XCTAssertEqual(ShareLinks.videoURL(base: base, videoId: ""), base)
        XCTAssertNil(ShareLinks.normalizedVideoId("aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaaaaaa"))
        XCTAssertNil(ShareLinks.normalizedVideoId("{\(Fixtures.videoA)}"))
    }
}

@MainActor
final class ShareDeepLinkTests: XCTestCase {
    func testParsesCustomSchemeAndUniversalVideoLinks() async {
        XCTAssertEqual(DeepLink.parse(URL(string: "drip://v/\(Fixtures.videoA)")!), .video(id: Fixtures.videoA))
        XCTAssertEqual(DeepLink.parse(URL(string: "https://drip.example.com/v/\(Fixtures.videoA)")!),
                       .video(id: Fixtures.videoA))
        XCTAssertEqual(DeepLink.parse(URL(string: "https://drip.example.com/v/\(Fixtures.videoA.uppercased())/")!),
                       .video(id: Fixtures.videoA))
        XCTAssertEqual(DeepLink.parse(URL(string: "https://drip.example.com/v/\(Fixtures.videoA)?utm_source=share")!),
                       .video(id: Fixtures.videoA))
        XCTAssertEqual(DeepLink.parse(URL(string: "dripdev://v/\(Fixtures.videoA)")!, scheme: "dripdev"),
                       .video(id: Fixtures.videoA))
    }

    func testRejectsMalformedVideoLinks() async {
        XCTAssertNil(DeepLink.parse(URL(string: "drip://v/not-a-uuid")!))
        XCTAssertNil(DeepLink.parse(URL(string: "drip://v")!))
        XCTAssertNil(DeepLink.parse(URL(string: "https://drip.example.com/v/..%2Fapi")!))
        XCTAssertNil(DeepLink.parse(URL(string: "https://drip.example.com/v/\(Fixtures.videoA)/extra")!))
        XCTAssertNil(DeepLink.parse(URL(string: "http://drip.example.com/v/\(Fixtures.videoA)")!), "https only")
    }

    func testRoutingAVideoOpensHomeOnThatVideoOnceEvenIfDeliveredTwice() async {
        let r = AppRouter()
        r.selectedTab = .profile
        r.push(.creator(Seller(id: "s", handle: "maya", displayName: "Maya")))

        let url = URL(string: "https://drip.example.com/v/\(Fixtures.videoA)")!
        XCTAssertEqual(r.open(url, scheme: "drip"), .video(id: Fixtures.videoA))
        XCTAssertEqual(r.selectedTab, .home)
        XCTAssertEqual(r.paths[.home], [.sharedVideo(videoId: Fixtures.videoA)])

        // onOpenURL and onContinueUserActivity may both see a universal link.
        r.open(url, scheme: "drip")
        XCTAssertEqual(r.paths[.home], [.sharedVideo(videoId: Fixtures.videoA)])

        r.open(URL(string: "drip://v/\(Fixtures.videoB)")!, scheme: "drip")
        XCTAssertEqual(r.paths[.home], [.sharedVideo(videoId: Fixtures.videoB)])

        XCTAssertNil(r.open(URL(string: "https://drip.example.com/nope")!, scheme: "drip"))
        XCTAssertEqual(r.paths[.home], [.sharedVideo(videoId: Fixtures.videoB)])
    }
}

@MainActor
final class SharedVideoModelTests: XCTestCase {
    func make(_ t: StubTransport, id: String = Fixtures.videoA) -> (SharedVideoModel, RecordingTracker) {
        let tracker = RecordingTracker()
        let api = APIClient(baseURL: URL(string: "https://drip.test")!, transport: t, viewer: FixedViewer())
        return (SharedVideoModel(videoId: id, api: api, tracker: tracker), tracker)
    }

    func testLoadsTheVideoAndSeedsASharedLinkFeedOnIt() async {
        let t = StubTransport()
        t.onJSON("/api/videos/\(Fixtures.videoA)", #"{"item":\#(Fixtures.itemJSON(Fixtures.videoA))}"#)
        t.onJSON("/api/me/reactions", #"{"liked":[],"saved":[],"following":[]}"#)
        let (m, tracker) = make(t)
        await m.load()

        XCTAssertEqual(m.phase, .loaded)
        let feed = m.feed
        XCTAssertNotNil(feed)
        XCTAssertEqual(feed?.items.map(\.videoId), [Fixtures.videoA])
        XCTAssertEqual(feed?.activeIndex, 0)
        XCTAssertEqual(feed?.surface, .sharedLink)
        XCTAssertEqual(t.requests(to: "/api/videos/\(Fixtures.videoA)").count, 1)

        let events = await tracker.events
        XCTAssertEqual(events.map(\.0.t), [.impression])
        XCTAssertEqual(events.first?.2, .sharedLink, "impressions are attributed to the shared link")
        XCTAssertEqual(events.first?.0.v, Fixtures.videoA)

        // Paging continues from /api/feed on the shared_link surface.
        t.onJSON("/api/feed", Fixtures.feedJSON([Fixtures.videoB]))
        await feed?.loadMoreIfNeeded()
        XCTAssertEqual(t.requests(to: "/api/feed").first?.queryItems["surface"], "shared_link")
        XCTAssertEqual(feed?.items.map(\.videoId), [Fixtures.videoA, Fixtures.videoB])
    }

    func testA404ReadsAsUnavailable() async {
        let t = StubTransport()
        t.onJSON("/api/videos/\(Fixtures.videoA)", status: 404, #"{"error":"This video is not available."}"#)
        let (m, _) = make(t)
        await m.load()
        XCTAssertEqual(m.phase, .unavailable)
        XCTAssertNil(m.feed)
    }

    func testAServerFailureIsRetryable() async {
        let t = StubTransport()
        t.onJSON("/api/videos/\(Fixtures.videoA)", status: 503, #"{"error":"Could not load this video."}"#)
        let (m, _) = make(t)
        await m.load()
        XCTAssertEqual(m.phase, .failed("Could not load this video."))

        t.onJSON("/api/videos/\(Fixtures.videoA)", #"{"item":\#(Fixtures.itemJSON(Fixtures.videoA))}"#)
        await m.load()
        XCTAssertEqual(m.phase, .loaded)
    }

    func testAnInvalidIdMakesNoRequest() async {
        let t = StubTransport()
        let (m, _) = make(t, id: "../me")
        await m.load()
        XCTAssertEqual(m.phase, .unavailable)
        XCTAssertTrue(t.requests.isEmpty)
    }

    func testEndpointPathAndNoViewerIdentity() async {
        let e = DripAPI.video(id: Fixtures.videoA)
        XCTAssertEqual(e.path, "/api/videos/\(Fixtures.videoA)")
        XCTAssertEqual(e.method, .get)
        XCTAssertFalse(e.sendsViewerIdentity)
    }
}
