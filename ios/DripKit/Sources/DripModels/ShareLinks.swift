import Foundation

/// Per-video share links. The website serves `/v/<videoId>`
/// (src/app/v/[videoId]/page.tsx): a public page with the poster, caption,
/// creator and first product, plus Open Graph tags so the link unfurls in
/// Messages and Slack. With universal links configured
/// (`/.well-known/apple-app-site-association`), the same URL opens this app
/// at the video instead (`DeepLink.video`).
public enum ShareLinks {
    /// `<base>/v/<videoId>`. Falls back to `base` for an id that is not a
    /// uuid, which the server would 404 — never share a dead link.
    public static func videoURL(base: URL, videoId: String) -> URL {
        guard let id = normalizedVideoId(videoId) else { return base }
        return base.appendingPathComponent("v").appendingPathComponent(id)
    }

    /// The lowercase uuid, or nil. The routes match lowercase uuids only; the
    /// check also keeps a crafted path (`..`, `%2F`) out of any request URL
    /// built from a deep link.
    public static func normalizedVideoId(_ raw: String) -> String? {
        guard raw.count == 36, let uuid = UUID(uuidString: raw) else { return nil }
        return uuid.uuidString.lowercased()
    }
}
