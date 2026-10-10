#if canImport(SwiftUI)
import SwiftUI

/// Loading / empty / error states shared by every screen.
public struct LoadingStateView: View {
    let label: String
    public init(_ label: String = "Loading") { self.label = label }
    public var body: some View {
        VStack(spacing: DripSpace.s) {
            ProgressView().tint(DripColor.coral)
            Text(label).dripText(.meta).foregroundStyle(DripColor.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

public struct EmptyStateView: View {
    let title: String
    let message: String
    let systemImage: String
    let actionTitle: String?
    let action: (() -> Void)?

    public init(_ title: String, message: String, systemImage: String = "sparkles",
                actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.title = title
        self.message = message
        self.systemImage = systemImage
        self.actionTitle = actionTitle
        self.action = action
    }

    public var body: some View {
        VStack(spacing: DripSpace.m) {
            Image(systemName: systemImage)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(DripColor.ink)
                .frame(width: 64, height: 64)
                .background(DripColor.peach, in: Circle())
            Text(title).dripText(.section).foregroundStyle(DripColor.ink).multilineTextAlignment(.center)
            Text(message).dripText(.body).foregroundStyle(DripColor.muted).multilineTextAlignment(.center)
            if let actionTitle, let action {
                Button(actionTitle, action: action).buttonStyle(.drip(.primary, fullWidth: false))
            }
        }
        .padding(DripSpace.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

public struct ErrorStateView: View {
    let message: String
    let retry: () -> Void

    public init(message: String, retry: @escaping () -> Void) {
        self.message = message
        self.retry = retry
    }

    public var body: some View {
        EmptyStateView("Something's off.", message: message, systemImage: "exclamationmark.triangle",
                       actionTitle: "Try again", action: retry)
    }
}

/// Mint success / ink info toast, auto-dismissed by the caller.
public struct ToastView: View {
    public enum Style: Sendable { case success, info, error }
    let text: String
    let style: Style

    public init(_ text: String, style: Style = .success) {
        self.text = text
        self.style = style
    }

    public var body: some View {
        HStack(spacing: DripSpace.xs) {
            Image(systemName: icon)
            Text(text).dripText(.meta)
        }
        .foregroundStyle(style == .success ? DripColor.successText : DripColor.cream)
        .padding(.horizontal, DripSpace.m)
        .padding(.vertical, DripSpace.s)
        .background(style == .success ? DripColor.mint : DripColor.ink, in: Capsule())
        .dripShadow(.card)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
    }

    private var icon: String {
        switch style {
        case .success: return "checkmark.circle.fill"
        case .info: return "info.circle.fill"
        case .error: return "exclamationmark.circle.fill"
        }
    }
}
#endif
