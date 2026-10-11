import Foundation

/// Build-time configuration, read from Info.plist keys that the xcconfig
/// fills per scheme. Every value here is PUBLIC by design (the same values
/// ship to every browser as NEXT_PUBLIC_*). No secret — Stripe secret key,
/// Supabase service role, Mux token, webhook secrets — belongs here, and
/// `validate` rejects anything shaped like one.
public struct AppConfiguration: Sendable, Equatable {
    public var apiBaseURL: URL
    public var supabaseURL: URL
    public var supabaseAnonKey: String
    public var stripePublishableKey: String
    public var appleMerchantId: String?
    /// Custom scheme for auth callbacks (`drip://auth-callback`).
    public var urlScheme: String
    public var environmentName: String

    public enum Key: String, CaseIterable {
        case apiBaseURL = "DripAPIBaseURL"
        case supabaseURL = "DripSupabaseURL"
        case supabaseAnonKey = "DripSupabaseAnonKey"
        case stripePublishableKey = "DripStripePublishableKey"
        case appleMerchantId = "DripAppleMerchantID"
        case urlScheme = "DripURLScheme"
        case environmentName = "DripEnvironment"
    }

    public struct Invalid: Error, Equatable, CustomStringConvertible {
        public let problems: [String]
        public var description: String { problems.joined(separator: "; ") }
    }

    public init(apiBaseURL: URL, supabaseURL: URL, supabaseAnonKey: String, stripePublishableKey: String,
                appleMerchantId: String?, urlScheme: String, environmentName: String) {
        self.apiBaseURL = apiBaseURL
        self.supabaseURL = supabaseURL
        self.supabaseAnonKey = supabaseAnonKey
        self.stripePublishableKey = stripePublishableKey
        self.appleMerchantId = appleMerchantId
        self.urlScheme = urlScheme
        self.environmentName = environmentName
    }

    /// Parses and validates. Collects every problem so one build log shows
    /// all of them, instead of failing on the first.
    public static func from(_ info: [String: Any]) throws -> AppConfiguration {
        var problems: [String] = []
        func string(_ key: Key, required: Bool = true) -> String? {
            let raw = (info[key.rawValue] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            // An unexpanded "$(VAR)" means the xcconfig never defined it.
            if raw.isEmpty || raw.hasPrefix("$(") {
                if required { problems.append("\(key.rawValue) is not set") }
                return nil
            }
            return raw
        }
        func httpsURL(_ key: Key) -> URL? {
            guard let s = string(key) else { return nil }
            guard let url = URL(string: s), let scheme = url.scheme, url.host != nil else {
                problems.append("\(key.rawValue) is not a URL")
                return nil
            }
            let isLocal = url.host == "localhost" || url.host == "127.0.0.1"
            guard scheme == "https" || (scheme == "http" && isLocal) else {
                problems.append("\(key.rawValue) must use https")
                return nil
            }
            return url
        }

        let api = httpsURL(.apiBaseURL)
        let supabase = httpsURL(.supabaseURL)
        let anon = string(.supabaseAnonKey)
        let stripe = string(.stripePublishableKey)
        let merchant = string(.appleMerchantId, required: false)
        let scheme = string(.urlScheme) ?? "drip"
        let env = string(.environmentName, required: false) ?? "production"

        if let stripe {
            if stripe.hasPrefix("sk_") || stripe.hasPrefix("rk_") {
                problems.append("DripStripePublishableKey is a SECRET key — use the pk_ publishable key")
            } else if !stripe.hasPrefix("pk_") {
                problems.append("DripStripePublishableKey must start with pk_")
            }
        }
        if let anon, Self.looksLikeServiceRole(anon) {
            problems.append("DripSupabaseAnonKey is the service_role key — use the anon/publishable key")
        }

        guard problems.isEmpty, let api, let supabase, let anon, let stripe else {
            throw Invalid(problems: problems)
        }
        return AppConfiguration(apiBaseURL: api, supabaseURL: supabase, supabaseAnonKey: anon,
                                stripePublishableKey: stripe, appleMerchantId: merchant,
                                urlScheme: scheme, environmentName: env)
    }

    /// Legacy Supabase keys are JWTs whose payload carries `"role"`; new-style
    /// secret keys start with `sb_secret_`. Either would be a leak if shipped.
    static func looksLikeServiceRole(_ key: String) -> Bool {
        if key.hasPrefix("sb_secret_") { return true }
        let parts = key.split(separator: ".")
        guard parts.count == 3 else { return false }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload += "=" }
        guard let data = Data(base64Encoded: payload),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return (json["role"] as? String) == "service_role"
    }

    public var authCallbackURL: URL { URL(string: "\(urlScheme)://auth-callback")! }
}
