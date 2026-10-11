import Foundation
import DripModels

// MARK: Catalog (public, identity-free reads)

extension DripAPI {
    /// GET /api/categories — src/app/api/categories/route.ts. Active
    /// categories in sort order; no auth, no viewer identity.
    public static func categories() -> Endpoint<CategoriesResponse> {
        Endpoint(.get, "/api/categories")
    }

    /// GET /api/creators/{handle} — src/app/api/creators/[handle]/route.ts.
    /// 404 (`APIError.notFound`) for an unknown or malformed handle.
    public static func creator(handle: String) -> Endpoint<CreatorResponse> {
        // A valid handle is already path-safe. Anything else is sent encoded
        // (so "../x" cannot walk the path) and the server answers 404.
        let segment = CreatorHandle.normalize(handle)
            ?? handle.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        return Endpoint(.get, "/api/creators/\(segment)")
    }
}
