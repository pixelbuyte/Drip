# Drip — Codemagic Setup

Pipeline file: `codemagic.yaml` (repo root). App sources: `ios/`.

**Labels:** **Confirmed** = what this repo contains · **Required (you)** = credentials or console steps only the account owner can do · **Assumption** = Codemagic behaviour to confirm on the first run.

## 0. What runs where

| Check | Where | Cost | Trigger |
|---|---|---|---|
| Unit tests (Linux + macOS), iOS Simulator tests, unsigned Release device build | GitHub Actions `.github/workflows/ios.yml` | Free (public repo) | Every push or PR touching `ios/` |
| Unsigned build + tests on Codemagic hardware | Codemagic `ios-unsigned-test` | Codemagic minutes | **Manual only** |
| Signed development build | Codemagic `ios-signed-dev` | minutes | **Manual only** |
| TestFlight upload | Codemagic `ios-testflight` | minutes | **Manual only** |
| App Store submission | Codemagic `ios-production-release` | minutes | **Manual only**, plus the approval gate |

**Confirmed:** no workflow in `codemagic.yaml` has a `triggering:` section, so connecting the repository to Codemagic starts nothing on its own.

## 1. Credentials

None of these are in the repo; they live in Codemagic.

### 1a. App Store Connect API key (Required, you)
1. In App Store Connect → Users and Access → Integrations → App Store Connect API, create a **Team key** with the **App Manager** role.
2. Download the `.p8` (it can be downloaded once) and note the **Issuer ID** and **Key ID**.
3. In Codemagic → Team settings → Integrations → **Developer Portal**, use the App Store Connect key named **`codemagic1`** (key ID YCNX76TT2M). The workflows reference that name; if you rename the key, update `app_store_connect:` in `codemagic.yaml`.
4. Codemagic stores the `.p8` encrypted. It is never printed, and nothing in `codemagic.yaml` echoes it.

### 1b. Codemagic API token (Required, you)
- **Purpose.** Lets this session start or inspect builds through the Codemagic REST API, which is how I'd trigger builds once you approve.
- **Where to create it.** Codemagic → Teams → Personal Account → Integrations → Codemagic API → *Show* / *Regenerate*.
- **Don't reuse the token rejected earlier.** Generate a new one.
- **How to provide it.** As a secret in this environment, not pasted into chat. See "Environment secrets" in the Claude Code environment settings.
- **First use is read-only.** `GET https://api.codemagic.io/apps` with header `x-auth-token`, to confirm the app id. No build is triggered without your approval.

### 1c. Environment variable groups (Required, you, in Codemagic → App → Environment variables)
| Group | Variable | Value | Secret? |
|---|---|---|---|
| `drip_public_config` | `DRIP_API_BASE_URL` | the Vercel production URL, e.g. `https://drip-beta-one.vercel.app` | no (public) |
| | `DRIP_SUPABASE_URL` | `https://tkppdmrkvyjixaiocwmd.supabase.co` | no (public) |
| | `DRIP_SUPABASE_ANON_KEY` | Supabase → Settings → API → **anon / publishable** key | no (public), but mark it secure anyway |
| | `DRIP_STRIPE_PUBLISHABLE_KEY` | `pk_test_…` first, `pk_live_…` for release | no (public) |
| | `DRIP_TEAM_ID` | 10-character Apple Developer Team ID | no |
| | `DRIP_APPLE_MERCHANT_ID` | e.g. `merchant.com.pixelbuyte.drip` | no |
| `drip_release_guard` | `RELEASE_APPROVED_BY` | the approver's name, set **only** when a production release is approved | no |

**The build refuses a secret key in the public slots.**
- `check_public_config` fails the build if the Stripe key isn't `pk_…` or the Supabase key is `sb_secret_…`, without printing either value.
- The app repeats the check at launch, including legacy service-role JWTs (`AppConfiguration.swift`, tested).

## 2. Apple-side setup (Required, you)

1. **App ID** `com.pixelbuyte.drip` with these capabilities:
   - **Sign in with Apple**
   - **Apple Pay Payment Processing**, with merchant ID `merchant.com.pixelbuyte.drip`
2. **Apple Pay certificate:**
   - In Stripe → Settings → Payment methods → Apple Pay → iOS certificates, add a certificate. It generates the CSR.
   - Upload the CSR in the Apple Developer portal under the merchant ID.
3. **App Store Connect app record** for bundle id `com.pixelbuyte.drip`. Put its numeric **Apple ID** into `APP_STORE_APPLE_ID` in `codemagic.yaml` (currently the placeholder `0000000000`).
4. **Signed validation.** `ios-signed-dev` reuses the uploaded production identity named `Both` and the Drip App Store profile referenced as `drip_app_store_validation` in Codemagic Code signing identities. The profile must target `com.pixelbuyte.drip`, include Apple Pay, Associated Domains and Sign in with Apple, and match the stored certificate. The Apple profile is named `Drip App Store Validation 20261017`. This avoids creating another distribution certificate: Apple currently rejects creation at the account limit. No certificate is revoked, and no private key needs to be exported. The TestFlight/release workflows retain their existing signing setup and require separate approval before running.

## 3. Supabase-side setup (Required, you)

- **Redirect URL.** Authentication → URL Configuration → Redirect URLs: add `drip://auth-callback`.
- **Apple provider.** Authentication → Providers → Apple: enable it and add client id `com.pixelbuyte.drip`, the native bundle id used for `id_token` sign-in.
- **Email code.** Authentication → Email Templates: include `{{ .Token }}` if email-code sign-in should show a 6-digit code.

## 4. Workflows in detail

| Workflow | Steps | Artifacts | Publishing |
|---|---|---|---|
| `ios-unsigned-test` | Toolchain → `swift test` (JUnit XML) → XcodeGen → simulator tests (scheme auto-detected) → unsigned Release build | logs, `.xcresult`, `.app` | none |
| `ios-signed-dev` | + public-config check → write `Local.xcconfig` → apply uploaded **App Store** certificate/profile → `build-ipa` (Release) | `.ipa`, logs | none |
| `ios-testflight` | + build number = latest TestFlight build + 1 → **App Store** profile → `build-ipa` (Release) | `.ipa`, dSYMs | `submit_to_testflight: true`, `submit_to_app_store: false` |
| `ios-production-release` | **Approval gate:** fails unless `RELEASE_APPROVED_BY` is set and the build is from `main` or a tag; then as TestFlight | `.ipa`, dSYMs | TestFlight + App Store review, `release_type: MANUAL` (a person presses Release in App Store Connect) |

**Other settings:**
- **Xcode.** `xcode: latest`. App Store uploads must be built with a current SDK. Pin the exact version after the first green build; Codemagic prints it in the Toolchain step.
- **Cache.** SwiftPM caches (`org.swift.swiftpm`, `SourcePackages`).
- **Versioning.**
  - `MARKETING_VERSION` (`ios/Config/Shared.xcconfig`) is committed and bumped by a person.
  - `CURRENT_PROJECT_VERSION` is set by CI.

## 5. First-run procedure (after the credentials exist)

1. **Read-only verification.** List Codemagic apps with the API token and confirm the repository is connected. Nothing is built.
2. **Unsigned build.** Run `ios-unsigned-test` manually. It needs no Apple credentials. The expected result matches the free GitHub Actions job.
3. **Signing check.** Run `ios-signed-dev`. It validates certificates, the profile and entitlements (Sign in with Apple, Apple Pay).
4. **Beta.** Run `ios-testflight` **only with explicit approval**. Uploads go to internal testers.
5. **Release.** Run `ios-production-release` only after the release checklist (DRIP_RELEASE_CHECKLIST.md) is signed off and `RELEASE_APPROVED_BY` is set.

## 6. Troubleshooting notes

- **"This build isn't configured" on launch.** One of the `DRIP_*` values was missing or secret-shaped at build time. The screen lists which, without values.
- **xcconfig and URLs.** In xcconfig, `//` starts a comment. The CI script rewrites URLs to `https:$(SLASH)$(SLASH)host` (tested in the session).
- **Scheme names.** The package scheme name depends on how many products the package has. Both CI systems read it from `xcodebuild -list` instead of hard-coding it.
