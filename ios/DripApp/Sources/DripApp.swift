import SwiftUI
import AppCore
import Authentication
import DesignSystem

@main
struct DripApp: App {
    @State private var boot: Boot

    init() {
        _boot = State(initialValue: Boot.start())
    }

    var body: some Scene {
        WindowGroup {
            switch boot {
            case .ready(let env):
                RootView(env: env)
            case .misconfigured(let problems):
                MisconfiguredView(problems: problems)
            }
        }
    }
}

/// Configuration is validated before anything touches the network. A build
/// with a missing or secret-looking value shows exactly what is wrong
/// instead of failing obscurely on the first request.
@MainActor
enum Boot {
    case ready(AppEnvironment)
    case misconfigured([String])

    static func start() -> Boot {
        do {
            let config = try AppConfiguration.from(Bundle.main.infoDictionary ?? [:])
            let payments = StripePaymentPresenter(publishableKey: config.stripePublishableKey,
                                                  merchantId: config.appleMerchantId,
                                                  returnURL: "\(config.urlScheme)://stripe-redirect")
            let env = AppEnvironment(config: config, payments: payments,
                                     secureStore: KeychainStore(service: Bundle.main.bundleIdentifier ?? "app.drip"))
            return .ready(env)
        } catch let invalid as AppConfiguration.Invalid {
            return .misconfigured(invalid.problems)
        } catch {
            return .misconfigured([String(describing: error)])
        }
    }
}

private struct MisconfiguredView: View {
    let problems: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: DripSpace.m) {
            Text("This build isn't configured.").dripText(.title).foregroundStyle(DripColor.ink)
            ForEach(problems, id: \.self) { p in
                Label(p, systemImage: "exclamationmark.triangle").dripText(.meta)
            }
            Text("Set the values in ios/Config (see docs/DRIP_CODEMAGIC_SETUP.md).")
                .dripText(.meta).foregroundStyle(DripColor.muted)
        }
        .padding(DripSpace.inset)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(DripColor.cream)
    }
}
