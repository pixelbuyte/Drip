#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import AuthenticationServices
import DripModels
import DesignSystem
import Authentication
import Discover

/// Sign in with Apple, Google (PKCE web flow), email + password, or an email
/// code. Apple is offered first: guideline 4.8 requires it alongside Google.
public struct SignInView: View {
    @Bindable var model: SignInModel
    let callbackScheme: String
    let onClose: () -> Void
    @State private var appleNonce = PKCE.appleNonce()
    @State private var webAuth = WebAuthenticator()

    public init(model: SignInModel, callbackScheme: String, onClose: @escaping () -> Void) {
        self.model = model
        self.callbackScheme = callbackScheme
        self.onClose = onClose
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DripSpace.l) {
                SheetHeader("") { onClose() }.padding(.bottom, -DripSpace.l)
                Text("Your corner of Drip.").dripText(.title).foregroundStyle(DripColor.ink)
                Text("Sign in to sell, and to keep your saves and follows across devices. Browsing and buying never need an account.")
                    .dripText(.body).foregroundStyle(DripColor.muted)

                SignInWithAppleButton(.continue) { request in
                    appleNonce = PKCE.appleNonce()
                    request.requestedScopes = [.email, .fullName]
                    request.nonce = appleNonce.sha256Hex
                } onCompletion: { result in
                    guard case .success(let auth) = result,
                          let credential = auth.credential as? ASAuthorizationAppleIDCredential,
                          let tokenData = credential.identityToken,
                          let token = String(data: tokenData, encoding: .utf8) else { return }
                    Task { await model.signInWithApple(idToken: token, rawNonce: appleNonce.raw) }
                }
                .signInWithAppleButtonStyle(.black)
                .frame(height: DripSize.button)
                .clipShape(Capsule())

                Button {
                    Task { await google() }
                } label: {
                    Label("Continue with Google", systemImage: "globe")
                }
                .buttonStyle(.drip(.secondary))

                divider

                Picker("Method", selection: $model.mode) {
                    Text("Sign in").tag(SignInModel.Mode.signIn)
                    Text("Create account").tag(SignInModel.Mode.signUp)
                    Text("Email code").tag(SignInModel.Mode.emailCode)
                }
                .pickerStyle(.segmented)

                input("Email", text: $model.email, content: .emailAddress, keyboard: .emailAddress)
                switch model.mode {
                case .signIn:
                    secure("Password", text: $model.password, content: .password)
                case .signUp:
                    secure("Password (8+ characters)", text: $model.password, content: .newPassword)
                case .emailCode:
                    if case .codeSent(let e) = model.status {
                        Text("We sent a 6-digit code to \(e).").dripText(.meta).foregroundStyle(DripColor.muted)
                        input("Code", text: $model.code, content: .oneTimeCode, keyboard: .numberPad)
                    }
                }

                status

                Button(action: { Task { await model.submit() } }) {
                    if model.status == .working { ProgressView().tint(DripColor.ink) } else { Text(submitTitle) }
                }
                .buttonStyle(.drip(.primary))
                .disabled(!model.canSubmit || model.status == .working)
            }
            .padding(DripSpace.inset)
        }
        .background(DripColor.cream)
        .onChange(of: model.status) { _, s in if s == .signedIn { onClose() } }
    }

    private var submitTitle: String {
        switch model.mode {
        case .signIn: return "Sign in"
        case .signUp: return "Create account"
        case .emailCode:
            if case .codeSent = model.status { return "Verify code" }
            return "Email me a code"
        }
    }

    @ViewBuilder private var status: some View {
        switch model.status {
        case .failed(let m):
            Label(m, systemImage: "exclamationmark.circle").dripText(.meta).foregroundStyle(DripColor.saleText)
        case .confirmEmail(let e):
            InfoRow(systemImage: "envelope", text: "Check \(e) to confirm your account, then sign in.")
        default:
            EmptyView()
        }
    }

    private var divider: some View {
        HStack {
            Rectangle().fill(DripColor.hairlineStrong).frame(height: 1)
            Text("or").dripText(.meta).foregroundStyle(DripColor.muted)
            Rectangle().fill(DripColor.hairlineStrong).frame(height: 1)
        }
    }

    private func google() async {
        let pkce = PKCE.generate()
        let url = await model.oauthURL(provider: "google", pkce: pkce)
        do {
            let callback = try await webAuth.start(url: url, callbackScheme: callbackScheme)
            await model.completeOAuth(callback: callback, verifier: pkce.verifier)
        } catch {
            model.cancelled()
        }
    }

    private func input(_ label: String, text: Binding<String>, content: UITextContentType,
                       keyboard: UIKeyboardType = .default) -> some View {
        TextField(label, text: text)
            .textContentType(content)
            .keyboardType(keyboard)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .dripText(.body)
            .padding(DripSpace.s)
            .frame(minHeight: DripSize.preferredHit)
            .background(DripColor.surface, in: RoundedRectangle(cornerRadius: DripRadius.field, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: DripRadius.field, style: .continuous).strokeBorder(DripColor.hairlineStrong))
    }

    private func secure(_ label: String, text: Binding<String>, content: UITextContentType) -> some View {
        SecureField(label, text: text)
            .textContentType(content)
            .dripText(.body)
            .padding(DripSpace.s)
            .frame(minHeight: DripSize.preferredHit)
            .background(DripColor.surface, in: RoundedRectangle(cornerRadius: DripRadius.field, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: DripRadius.field, style: .continuous).strokeBorder(DripColor.hairlineStrong))
    }
}

/// Frame 18: "Your corner of Drip." — account, saved finds, legal, sign out.
public struct ProfileView: View {
    @Bindable var model: ProfileModel
    let legalBaseURL: URL
    let onSignIn: () -> Void
    let onOpenSaved: ([FeedItem], Int) -> Void

    public init(model: ProfileModel, legalBaseURL: URL, onSignIn: @escaping () -> Void,
                onOpenSaved: @escaping ([FeedItem], Int) -> Void) {
        self.model = model
        self.legalBaseURL = legalBaseURL
        self.onSignIn = onSignIn
        self.onOpenSaved = onOpenSaved
    }

    public var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: DripSpace.xs) {
                    Text("Your corner of Drip.").dripText(.title).foregroundStyle(DripColor.ink)
                    if let user = model.user {
                        Text(user.email ?? "Signed in").dripText(.meta).foregroundStyle(DripColor.muted)
                    } else {
                        Button("Sign in or create an account", action: onSignIn)
                            .buttonStyle(.drip(.primary))
                            .padding(.top, DripSpace.xs)
                    }
                }
                .listRowBackground(DripColor.cream)
            }

            Section("Saved") {
                savedContent.listRowBackground(DripColor.cream)
            }

            Section("About") {
                Link("Terms", destination: legalBaseURL.appendingPathComponent("legal/terms"))
                Link("Privacy", destination: legalBaseURL.appendingPathComponent("legal/privacy"))
                Link("Prohibited items", destination: legalBaseURL.appendingPathComponent("legal/prohibited-items"))
            }
            .foregroundStyle(DripColor.ink)
            .listRowBackground(DripColor.cream)

            if model.user != nil {
                Section {
                    Button("Sign out", role: .destructive) { Task { await model.signOut() } }
                }
                .listRowBackground(DripColor.cream)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(DripColor.cream)
        .task { await model.loadSaved() }
        .task { await model.observeSession() }
        .refreshable { await model.loadSaved() }
    }

    @ViewBuilder private var savedContent: some View {
        switch model.saved {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, minHeight: 120)
        case .empty:
            Text("Tap the bookmark on anything you love and it waits here.")
                .dripText(.body).foregroundStyle(DripColor.muted)
        case .failed(let m):
            Button("\(m) Tap to retry.") { Task { await model.loadSaved() } }
                .dripText(.body).foregroundStyle(DripColor.ink)
        case .loaded(let items):
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: DripSpace.xs) {
                    ForEach(Array(items.enumerated()), id: \.element.videoId) { i, item in
                        Button { onOpenSaved(items, i) } label: { VideoTile(item: item).frame(width: 120) }
                            .buttonStyle(PressableStyle())
                    }
                }
            }
        }
    }
}
#endif
