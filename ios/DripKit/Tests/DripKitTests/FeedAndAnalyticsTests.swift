import XCTest
import DripModels
import Networking
@testable import Analytics
import Media
import Discover
import Explore
import TestSupport

@MainActor
final class FeedModelTests: XCTestCase {
    let base = URL(string: "https://drip.test")!

    func makeModel(_ t: StubTransport, source: FeedModel.Source = .feed(.forYou)) -> (FeedModel, RecordingTracker) {
        let tracker = RecordingTracker()
        let api = APIClient(baseURL: base, transport: t, viewer: FixedViewer())
        return (FeedModel(source: source, api: api, tracker: tracker, sessionId: "ABCDEF00-0000-4000-8000-000000000000"), tracker)
    }

    nonisolated func ids(_ range: Range<Int>) -> [String] { range.map(Fixtures.uuid) }

    func testInitialLoadEmitsOneImpressionAndHydratesReactions() async {
        let t = StubTransport()
        t.onJSON("/api/feed", Fixtures.feedJSON(ids(0..<3), nextBefore: "c1"))
        t.onJSON("/api/me/reactions", #"{"liked":["\#(Fixtures.uuid(1))"],"saved":[],"following":["\#(Fixtures.seller)"]}"#)
        let (m, tracker) = makeModel(t)
        await m.loadInitial()

        XCTAssertEqual(m.phase, .loaded)
        XCTAssertEqual(m.items.count, 3)
        XCTAssertEqual(m.sessionId, "abcdef00-0000-4000-8000-000000000000", "routes match lowercase uuids only")
        XCTAssertEqual(t.requests(to: "/api/feed").first?.queryItems["session_id"], m.sessionId)
        XCTAssertTrue(m.liked.contains(Fixtures.uuid(1)))
        XCTAssertTrue(m.following.contains(Fixtures.seller))
        let kinds = await tracker.kinds
        XCTAssertEqual(kinds, [.impression])
    }

    func testCommitEmitsSkipWithCumulativeWatchTimeThenImpressionOncePerVideo() async {
        let t = StubTransport()
        t.onJSON("/api/feed", Fixtures.feedJSON(ids(0..<3), nextBefore: "c1"))
        let (m, tracker) = makeModel(t)
        await m.loadInitial()

        // Two full loops of a 20s clip, then 5s into the third pass.
        for p in stride(from: 0.0, through: 19.5, by: 0.5) { await m.playbackProgress(videoId: m.items[0].videoId, position: p) }
        for p in stride(from: 0.0, through: 19.5, by: 0.5) { await m.playbackProgress(videoId: m.items[0].videoId, position: p) }
        for p in stride(from: 0.0, through: 5.0, by: 0.5) { await m.playbackProgress(videoId: m.items[0].videoId, position: p) }

        await m.commit(index: 1)
        await m.commit(index: 0)   // back again: skip for 1, no second impression for 0

        let events = await tracker.events.map(\.0)
        let skip = events.first { $0.t == .skip }
        XCTAssertEqual(skip?.lc, 2)
        XCTAssertEqual(skip?.wm, 5_000 + 2 * 20_000)
        XCTAssertEqual(skip?.dm, 20_000)
        XCTAssertEqual(events.filter { $0.t == .impression }.map(\.v), [m.items[0].videoId, m.items[1].videoId])
        // 25/50/75/95 buckets fired on each of the two complete passes, and 25 on the third.
        XCTAssertEqual(events.filter { $0.t == .watchProgress }.count, 9)
    }

    func testPrefetchesNearTheEndAndDedupes() async {
        let t = StubTransport()
        t.on("/api/feed") { req in
            let offset = Int(req.queryItems["offset"] ?? "0") ?? 0
            let page = offset == 0 ? Array(0..<10) : Array(8..<14)   // overlaps by two
            return HTTPResponse(status: 200, body: Data(Fixtures.feedJSON(page.map(Fixtures.uuid), nextBefore: "c\(offset)").utf8))
        }
        let (m, _) = makeModel(t)
        await m.loadInitial()
        XCTAssertEqual(t.requests(to: "/api/feed").count, 1)

        await m.commit(index: 5)   // 10 - 5 = the prefetch distance
        let second = t.requests(to: "/api/feed").last!
        XCTAssertEqual(second.queryItems["offset"], "10")
        XCTAssertEqual(second.queryItems["before"], "c0")
        XCTAssertEqual(second.queryItems["exclude_ids"]?.split(separator: ",").count, 10)
        XCTAssertEqual(m.items.count, 14, "overlapping ids are not appended twice")
    }

    func testPageWithNothingNewAndNoCursorIsTheEnd() async {
        let t = StubTransport()
        t.on("/api/feed") { req in
            let offset = Int(req.queryItems["offset"] ?? "0") ?? 0
            let json = offset == 0 ? Fixtures.feedJSON(self.ids(0..<5), nextBefore: "c") : Fixtures.feedJSON(self.ids(0..<2))
            return HTTPResponse(status: 200, body: Data(json.utf8))
        }
        let (m, _) = makeModel(t)
        await m.loadInitial()
        await m.commit(index: 1)
        XCTAssertTrue(m.exhausted)
        XCTAssertEqual(m.items.count, 5)
    }

    func testEmptyAndFailedStates() async {
        let t = StubTransport()
        t.onJSON("/api/feed", Fixtures.feedJSON([], exhausted: true))
        let (m, _) = makeModel(t)
        await m.loadInitial()
        XCTAssertEqual(m.phase, .empty)

        let t2 = StubTransport()
        t2.onJSON("/api/feed", status: 500, #"{"error":"Could not load the feed"}"#)
        let (m2, _) = makeModel(t2)
        await m2.loadInitial()
        XCTAssertEqual(m2.phase, .failed("Could not load the feed"))
    }

    func testEngagementTogglesAreOptimisticEvents() async {
        let t = StubTransport()
        t.onJSON("/api/feed", Fixtures.feedJSON(ids(0..<2)))
        let (m, tracker) = makeModel(t)
        await m.loadInitial()
        let item = m.items[0]

        await m.toggleLike(item)
        await m.likeFromDoubleTap(item)   // already liked: no unlike
        await m.toggleSave(item)
        await m.toggleFollow(item)
        await m.toggleFollow(item)
        XCTAssertTrue(m.liked.contains(item.videoId))
        XCTAssertTrue(m.saved.contains(item.videoId))
        XCTAssertFalse(m.following.contains(item.seller.id))
        let kinds = await tracker.kinds
        XCTAssertEqual(kinds, [.impression, .like, .save, .follow, .unfollow])
    }

    func testNotInterestedRemovesTheVideoAndKeepsPaging() async {
        let t = StubTransport()
        t.onJSON("/api/feed", Fixtures.feedJSON(ids(0..<3)))
        let (m, tracker) = makeModel(t)
        await m.loadInitial()
        let first = m.items[0]
        await m.notInterested(first)
        XCTAssertFalse(m.items.contains(first))
        XCTAssertEqual(m.activeIndex, 0)
        XCTAssertEqual(m.activeItem?.videoId, Fixtures.uuid(1))
        let kinds = await tracker.kinds
        XCTAssertTrue(kinds.contains(.notInterested))
    }

    func testFollowingSurfaceAndSeededStart() async {
        let t = StubTransport()
        t.onJSON("/api/feed", Fixtures.feedJSON(ids(0..<2)))
        let (m, tracker) = makeModel(t, source: .feed(.following))
        await m.loadInitial()
        XCTAssertEqual(t.requests(to: "/api/feed").first?.queryItems["surface"], "following")

        let (seeded, seededTracker) = makeModel(t, source: .search("tote"))
        let items = m.items
        await seeded.seed(items: items, startAt: 1)
        XCTAssertEqual(seeded.activeIndex, 1)
        let kinds = await seededTracker.kinds
        XCTAssertEqual(kinds, [.impression])
        _ = tracker
    }
}

@MainActor
final class ExploreModelTests: XCTestCase {
    func testSubmitSearchesAndStaleResultsNeverWin() async {
        let t = StubTransport()
        t.on("/api/search") { req in
            let q = req.queryItems["q"] ?? ""
            let ids = q == "tote" ? [Fixtures.videoA] : []
            return HTTPResponse(status: 200, body: Data(Fixtures.feedJSON(ids).utf8))
        }
        let m = ExploreModel(api: APIClient(baseURL: URL(string: "https://drip.test")!, transport: t, viewer: FixedViewer()))
        m.query = "tote"
        await m.submit()
        XCTAssertEqual(m.results.value?.count, 1)
        m.query = "zzz"
        await m.submit()
        XCTAssertEqual(m.results, .empty)
        m.query = "a"   // below the minimum: back to idle, no request
        XCTAssertEqual(m.results, .idle)
    }
}

final class EventTrackerTests: XCTestCase {
    func testBatchesAt50AndPostsTheWireShape() async throws {
        let t = StubTransport()
        t.on("/api/events") { _ in HTTPResponse(status: 202, body: Data(#"{"accepted":50}"#.utf8)) }
        let api = APIClient(baseURL: URL(string: "https://drip.test")!, transport: t, viewer: FixedViewer())
        let tracker = EventTracker(api: api, flushInterval: .seconds(60))
        for i in 0..<50 {
            await tracker.track(FeedEvent(.impression, videoId: Fixtures.uuid(i), position: i), sessionId: "s1", surface: .forYou)
        }
        let posts = t.requests(to: "/api/events")
        XCTAssertEqual(posts.count, 1)
        let body = posts[0].jsonBody
        XCTAssertEqual(body["sid"] as? String, "s1")
        XCTAssertEqual(body["sf"] as? String, "for_you")
        XCTAssertEqual((body["e"] as? [[String: Any]])?.count, 50)
        XCTAssertEqual((body["e"] as? [[String: Any]])?.first?["t"] as? String, "impression")
        XCTAssertNotNil(posts[0].headers["x-drip-anon-token"])
    }

    func testDropsServerErrorsButRequeuesOneConnectivityFailure() async {
        let t = StubTransport()
        t.on("/api/events") { _ in throw APIError.transport(code: -1009, message: "offline") }
        let api = APIClient(baseURL: URL(string: "https://drip.test")!, transport: t, viewer: FixedViewer())
        let tracker = EventTracker(api: api, flushInterval: .seconds(60))
        await tracker.track(FeedEvent(.like, videoId: Fixtures.videoA), sessionId: "s", surface: .forYou)
        await tracker.flush()
        var pending = await tracker.pendingCount
        XCTAssertEqual(pending, 1, "one second chance")
        await tracker.flush()
        pending = await tracker.pendingCount
        XCTAssertEqual(pending, 0, "then let it go — never a retry loop")
    }

    func testClampsLoopCountToTheServersBound() {
        XCTAssertEqual(FeedEvent(.skip, videoId: "v", loopCount: 9_999).lc, 500)
    }

    func testChunksKeepEachRequestUnder32KB() {
        let big = (0..<50).map { FeedEvent(.report, videoId: Fixtures.uuid($0), meta: ["reason": String(repeating: "x", count: 900)]) }
        let chunks = EventTracker.chunks(big)
        XCTAssertGreaterThan(chunks.count, 1)
        for c in chunks {
            XCTAssertLessThan(try JSONEncoder.drip.encode(c).count, 32 * 1024)
        }
        XCTAssertEqual(chunks.flatMap { $0 }.count, 50)
    }
}

final class MediaTests: XCTestCase {
    func testPreloadWindowIsOneBackTwoAhead() {
        let plan = PreloadPlanner().plan(active: 5, count: 10)
        XCTAssertEqual(plan, [5: .active, 6: .preroll, 7: .warm, 4: .retain])
        XCTAssertEqual(PreloadPlanner().plan(active: 0, count: 1), [0: .active])
        XCTAssertEqual(PreloadPlanner().plan(active: 9, count: 10), [9: .active, 8: .retain])
        XCTAssertEqual(PreloadPlanner.constrained.plan(active: 3, count: 10), [3: .active, 4: .preroll])
        XCTAssertEqual(PreloadPlanner().plan(active: 3, count: 0), [:])
    }

    func testWatchSessionCountsLoopsAndRearmsBuckets() {
        var w = WatchSession(videoId: "v", durationSeconds: 10)
        var fired: [Int] = []
        for p in stride(from: 0.0, through: 9.75, by: 0.25) { fired += w.observe(position: p).map(\.bucket) }
        for p in stride(from: 0.0, through: 3.0, by: 0.25) { fired += w.observe(position: p).map(\.bucket) }
        XCTAssertEqual(fired, [25, 50, 75, 95, 25])
        XCTAssertEqual(w.loops, 1)
        XCTAssertEqual(w.cumulativeWatchedMs, 13_000)
    }

    func testMuxURLs() {
        XCTAssertEqual(MuxURLs.hls(playbackId: "abc123")?.absoluteString, "https://stream.mux.com/abc123.m3u8")
        XCTAssertNil(MuxURLs.hls(playbackId: "../evil"))
        XCTAssertEqual(MuxURLs.thumbnail(playbackId: "abc", atSecond: 2, width: 360)?.absoluteString,
                       "https://image.mux.com/abc/thumbnail.webp?time=2.0&width=360")
    }
}
