# Drip iOS — Roadmap and Milestone Status

**Rule:** a milestone is **Complete** only with linked evidence (a CI run, a test, or a build artifact). Everything else is **In progress**, **Blocked** (with the blocker named) or **Not started**.

_Last updated by the `native-ios` session; branch `native-ios`, PR #14._

---

## Milestone 1 — Repository audit, architecture, roadmap
**Status: Complete.**

| Deliverable | Evidence |
|---|---|
| Audit of `main` and `astra-drip` with `path:line` citations | `docs/DRIP_REPOSITORY_AUDIT.md` (Parts A–D) |
| Screen and navigation inventory (web and native) | `docs/DRIP_SCREEN_INVENTORY.md` |
| Native architecture | `docs/DRIP_NATIVE_ARCHITECTURE.md` |
| Backend integration plan | `docs/DRIP_BACKEND_INTEGRATION.md` |
| `native-ios` branch from the verified base | `astra-drip` (`9e0aa04`) = `main` + 2 design-only commits, 0 behind |

## Milestone 2 — Native SwiftUI project that compiles in Codemagic
**Status: Complete on GitHub Actions; Codemagic run blocked.** The whole app (every module, plus Stripe) compiles for iOS, and all 60 tests pass on the iOS Simulator: [run 38101069030](https://github.com/pixelbuyte/Drip/actions/runs/38101069030), commit `705aa39`. The Codemagic build itself is **blocked on credentials and your approval** to spend minutes.

| Item | Status | Evidence |
|---|---|---|
| 13 SwiftPM modules + app target (XcodeGen) | Done | `ios/DripKit/Package.swift`, `ios/project.yml` |
| Non-UI code compiles under Swift 6.2 strict concurrency, no warnings (Linux) | Done | `swift build` locally; the GitHub Actions "DripKit tests (Linux)" job |
| 60 unit tests pass on Linux, macOS and the iOS Simulator | Done | [run 38101069030](https://github.com/pixelbuyte/Drip/actions/runs/38101069030): `Executed 60 tests, with 0 failures`, `** TEST SUCCEEDED **` |
| Every SwiftUI screen compiles for iOS | Done | same run, simulator test step (the test build compiles every module) |
| Unsigned Release device build of the app, with Stripe | Done | same run, "Build app (unsigned, device, Release)": `** BUILD SUCCEEDED **` |
| `codemagic.yaml`, four workflows, manual-only | Done (config) | `codemagic.yaml` |
| First Codemagic build | **Blocked:** needs a Codemagic API token and your approval | DRIP_CODEMAGIC_SETUP.md §5 |

**Note on CI honesty.** An earlier CI run reported green while `xcodebuild` had failed, because a `grep … || true` filter masked the exit status. That was found by reading the job log, then fixed: steps now exit with `xcodebuild`'s own status. Treat only runs from commit `4933efd` onward as evidence.

## Milestone 3 — Authentication, navigation and core video feed on real backend data
**Status: Built; blocked on backend data for end-to-end verification.**

| Item | Status | Evidence / blocker |
|---|---|---|
| Supabase Auth: Apple, Google (PKCE), password, email code; Keychain; single-flight refresh | Built + unit-tested | `AuthenticationTests.swift` (PKCE vs RFC 7636, concurrent refresh, revoked vs offline) |
| Device viewer identity (signed) + backend support | Built + tested both sides | `native-identity.test.ts`, `ViewerIdentityTests` |
| Five-tab navigation, deep links | Built + routing tests | `RoutingTests` |
| Paging feed: autoplay, offscreen pause, preload window, player reuse, memory shrink, states | Built; feed logic tested | `FeedModelTests`, `MediaTests` |
| Feed events with web-identical semantics | Built + tested | `FeedModelTests.testCommitEmitsSkip…` |
| **Real backend data** | **Blocked** | Production runs the legacy schema, so `/api/feed` has no content (audit A §0.1). Needs the 00006–00018 migration applied, plus Supabase providers configured (DRIP_BACKEND_INTEGRATION.md §1) |
| Device run | Not started | Needs a signed development build (M2 → Codemagic) |

## Milestone 4 — Shopping, creator features and commerce
**Status: Partially built; several items blocked on backend work.**

| Item | Status | Blocker / next step |
|---|---|---|
| Product peek, variants, quantity (server-mirrored pricing) | Built + tested | — |
| Checkout via server-priced PaymentIntent + Stripe PaymentSheet + Apple Pay + shipping address | Built; logic tested; Stripe UI unverified | Needs the Stripe publishable key, an Apple Pay merchant certificate, and backend env (Stripe secret key, webhook secret) in Vercel |
| Bag (per-line checkout) | Built + tested | A combined multi-item checkout needs a server cart (Proposed) |
| Likes / saves / follows + read-back | Built (app + API) | Migration `00017` must ship, so a like doesn't clear a save |
| Saved list | Built (app + API) | — |
| Search | Built + tested | — |
| Creator profile | Built | A profile endpoint is needed for bio and follower counts |
| Studio: payouts gate + listing creation + Mux upload | Built + tested (app + API): `POST /api/videos`; the Mux webhook publishes to the feed | Needs the migration to run in production (DRIP_BACKEND_INTEGRATION.md §5 #2) |
| Comments | Not built | No backend (§5 #3) |
| Buyer order history | Built + tested (app + API) | `GET /api/me/orders`; Profile → Orders. Needs the migration (`order_items`) to return data |
| Account deletion | Built + tested (app + API) | `DELETE /api/me`; Profile → Delete account. A seller with buyer orders is refused (409) and needs a support process |
| Categories / Discover tiles | Not built | Needs `GET /api/categories` |

**Proposed backend sequence for M4:**
1. Apply the migration chain.
2. ~~Add a videos/products creation endpoint and the Mux webhook update.~~ Done.
3. ~~Account deletion.~~ Done.
4. ~~Orders read.~~ Done.
5. Comments.
6. Categories.
7. Optionally a server cart.

## Milestone 5 — Signed IPA uploaded to TestFlight
**Status: Not started. Blocked** on:
- the App Store Connect API key and app record;
- Apple Pay and Sign in with Apple capabilities;
- the Codemagic API token;
- **your explicit approval** to run `ios-testflight`.

Setup: DRIP_CODEMAGIC_SETUP.md.

## Milestone 6 — Fully tested production release candidate
**Status: Not started.** Exit criteria: DRIP_RELEASE_CHECKLIST.md. This includes on-device QA of every screen in DRIP_SCREEN_INVENTORY.md, XCUITest smoke flows (Proposed), privacy labels, an account deletion endpoint, and a real end-to-end purchase in Stripe test mode.

---

## What you need to provide or decide

| # | Item | Unblocks |
|---|---|---|
| 1 | Approve and run the production migration (00006–00018) per `PREFLIGHT.md`; the Supabase project `tkppdmrkvyjixaiocwmd` isn't visible to this session's Supabase connector | M3, M4, the security fixes |
| 2 | The Supabase **anon/publishable key** for the new Vercel project `drip` and for the app config (public value) | Vercel switch-over, M3 |
| 3 | Vercel server secrets in project `drip`: `SUPABASE_SERVICE_ROLE_KEY`, `ANON_ID_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `MUX_TOKEN_ID/SECRET`, `MUX_WEBHOOK_SECRET`, `EASYPOST_API_KEY`, `EASYPOST_WEBHOOK_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Real feed, checkout, uploads (none are set in either Vercel project today) |
| 4 | Codemagic API token (new) + App Store Connect API key + Apple Developer Team ID | M2 (Codemagic), M5 |
| 5 | Supabase Auth: Apple provider, `drip://auth-callback` redirect | Sign-in on device |
| 6 | Decide whether comments are a launch feature | M4 scope |
