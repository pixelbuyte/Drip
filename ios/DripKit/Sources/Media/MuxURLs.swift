import Foundation

/// Mux public-playback URLs. Assets are created with `playback_policy:
/// ['public']` (src/app/api/drops/route.ts), so no signed token is involved
/// and no Mux secret can ever be needed on device.
///
/// HLS, not the web's `low.mp4`: the MP4 rendition is never enabled on
/// upload, and HLS gives AVPlayer adaptive bitrate on cellular.
public enum MuxURLs {
    public static func hls(playbackId: String) -> URL? {
        guard isValid(playbackId) else { return nil }
        return URL(string: "https://stream.mux.com/\(playbackId).m3u8")
    }

    public static func thumbnail(playbackId: String, atSecond time: Double = 0, width: Int = 720) -> URL? {
        guard isValid(playbackId) else { return nil }
        var c = URLComponents(string: "https://image.mux.com/\(playbackId)/thumbnail.webp")!
        c.queryItems = [
            URLQueryItem(name: "time", value: String(format: "%.1f", max(0, time))),
            URLQueryItem(name: "width", value: String(width)),
        ]
        return c.url
    }

    /// Playback ids are alphanumeric; anything else must not be spliced into a URL.
    static func isValid(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 128 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
    }
}
