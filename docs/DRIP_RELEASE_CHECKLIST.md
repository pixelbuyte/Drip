# Drip iOS — Release Checklist

How to use it:
- Tick an item only with evidence (a link to a CI run, a TestFlight build, a screenshot, a ticket).
- Items marked **Status today** record the state as of the `native-ios` session.
- Nothing ships to the App Store without an explicit, named approval (`RELEASE_APPROVED_BY` in Codemagic).

## 1. Backend readiness
- [ ] Migration chain `00006`–`00018` applied to production, following `docs/production-migration/PREFLIGHT.md` (PITR on, fresh snapshot taken, rollback rehearsed). **Status today: not applied; PREFLIGHT says "NOT READY".**
- [ ] Production RLS re-checked after the migration: there must be no `orders_insert_for_seller`, `orders_seller_update_own` or `seller_payments_self_update` (audit A §0.4).
- [ ] Videos/products creation endpoint and Mux webhook support for `videos`, so creator uploads reach the feed.
- [ ] Account deletion endpoint (App Store 5.1.1(v)) and an in-app entry point. **Status today: built and tested (`DELETE /api/me`, Profile → Delete account); verify on device. Define the support process for sellers with buyer orders (they get a 409).**
- [ ] Stripe webhook: idempotent inventory decrement; refund and dispute handling.
- [ ] `EASYPOST_WEBHOOK_SECRET` set. Without it, the webhook now returns 503 (fail-closed) and tracking updates stop (audit C §4.1).
- [x] `/auth/callback` open redirect fixed (audit C §4.2): `security-fixes.test.ts`.
- [ ] All server secrets present in the Vercel production project (see §6).

## 2. App configuration
- [ ] Release `DRIP_*` values point at **production**: API URL, Supabase URL and anon key, Stripe **live** publishable key.
- [ ] Launch shows no "This build isn't configured" screen on a Release build.
- [ ] Bundle id `com.pixelbuyte.drip`; version (`MARKETING_VERSION`) bumped; build number set by CI.
- [ ] App icon replaced with the final brand asset. **Status today: placeholder wordmark.**
- [ ] Display fonts locked after a side-by-side with board 14 (Instrument Serif vs a heavier serif; audit B §5.7).

- [ ] **Associated Domains capability enabled on the App ID `com.pixelbuyte.drip`**, and provisioning profiles regenerated. `Drip.entitlements` requests `applinks:$(DRIP_ASSOCIATED_DOMAIN)`, so **signed builds fail until this is done**. The unsigned CI build is unaffected.
- [ ] `APPLE_TEAM_ID` set in the Vercel production project, so `/.well-known/apple-app-site-association` serves the app ID instead of a 404.
- [ ] `DRIP_ASSOCIATED_DOMAIN` equals the host of `DRIP_API_BASE_URL`. Codemagic derives it; local builds set it in `Local.xcconfig`.

## 3. Functional QA on device (iPhone, latest and previous iOS)
- [ ] Feed: smooth paging; one video audible at a time; offscreen pause; preload (next video starts instantly); memory warning doesn't crash; empty, error and processing states.
- [ ] Engagement: like, double-tap like, save, follow, share, not interested, report. State persists after relaunch (`/api/me/reactions`).
- [ ] Product peek: variants (sold-out options disabled), quantity cap 10, the video keeps playing under the peek.
- [ ] Checkout, in Stripe **test** mode end-to-end:
  - [ ] address sheet → PaymentSheet (card and Apple Pay) → "It's yours."
  - [ ] the order row exists, with shipping address and buyer email
  - [ ] a label is purchased
  - [ ] sold-out returns 409
  - [ ] a declined card shows the error
  - [ ] cancel returns to the quote without charging
- [ ] Bag: add, change quantity, remove, per-line checkout.
- [ ] Search: results, empty, offline; opening a result opens the feed at that video.
- [ ] Following: shows only followed creators; empty state when following nobody.
- [ ] Creator profile: grid, follow.
- [ ] Sign in: Apple, Google, email/password, email code; sign out; session survives relaunch; an expired access token refreshes silently.
- [ ] Studio: payouts gate → Stripe onboarding → listing creation (`POST /api/videos`) → upload progress → the Mux webhook publishes → the video appears in the feed (needs §1).
- [ ] Deep links: `drip://bag`, `drip://creator/<handle>`, `drip://search?q=`, `drip://v/<videoId>`; universal link `https://<host>/v/<videoId>` from Messages opens the app; Share sends that link, and it unfurls with the poster.
- [ ] Discover: category tiles open that category's feed; a creator page shows follower and drop counts.
- [ ] Backgrounding: playback pauses; events flush.

## 4. Accessibility and quality
- [ ] VoiceOver across every screen: labels, the feed's custom actions, the adjustable quantity stepper.
- [ ] Dynamic Type at XXL and the accessibility sizes: no truncated purchase controls.
- [ ] Reduce Motion: no scale or bounce animations; durations ≤ 100 ms.
- [ ] Contrast: coral buttons have ink labels (automated: `DesignTokenTests`).
- [ ] No crashes in a 30-minute feed soak; memory stays flat (Instruments).
- [ ] XCUITest smoke flows green (Proposed: launch → feed → peek → checkout sheet → cancel).

## 5. App Store submission
- [ ] Privacy nutrition labels match `ios/DripApp/PrivacyInfo.xcprivacy`: email, physical address, purchase history, product interaction, photos/videos; no tracking.
- [ ] App Review notes:
  - physical goods sold by creators, so guideline 3.1.3(e) applies (no IAP);
  - demo account credentials;
  - how to reach a product and check out in test mode.
- [ ] Sign in with Apple offered alongside Google (4.8). **Status today: implemented.**
- [ ] In-app account deletion (5.1.1(v)). **Status today: built (Profile → Delete account → confirm); verify on device.**
- [ ] User-generated content (4.2/1.2): report and "not interested" present; a moderation process documented; block or hide a creator. **Status today: report + not interested implemented; seller block is 30 days via `not_interested`.**
- [ ] Export compliance: `ITSAppUsesNonExemptEncryption = NO` (HTTPS only). **Status today: set.**
- [ ] Screenshots (6.9" and 6.5"), description, keywords, support URL, privacy policy URL (`/legal/privacy`).

## 6. Vercel production project

**Status today:**
- Two projects build every push.
- `drip-backend` (current production, `drip-backend-lime.vercel.app`) has only three public env vars: app URL, Supabase URL, anon key. They are stored as "sensitive", so they can't be read back.
- The new `drip` project (`drip-beta-one.vercel.app`) has the app URL and Supabase URL (`tkppdmrkvyjixaiocwmd`) and is **missing the anon key**.
- **Neither project** has any server secret (service role, Stripe, Mux, EasyPost, Resend, `ANON_ID_SECRET`).

Switch-over steps:
1. Add `NEXT_PUBLIC_SUPABASE_ANON_KEY` to `drip`. It's a public value from Supabase → Settings → API; Vercel won't reveal the copy in `drip-backend`.
2. Add the server secrets listed in DRIP_IOS_ROADMAP.md, item 3, to `drip`.
3. Redeploy `drip` production from `main`. Smoke-test `/`, `/auth/login`, `/feed`.
4. Point the app's `DRIP_API_BASE_URL`, and any custom domain, at `drip`.
5. **Then** delete `drip-backend`. Deletion is irreversible, and it holds the only stored copy of the anon key in Vercel, so it is deleted after step 1, not before.
6. Optionally delete `drip-deploy`, which appears unused (verify that no domain points at it).

## 7. Release
- [ ] TestFlight build tested by internal testers; no open P0/P1 issues.
- [ ] `RELEASE_APPROVED_BY` set by the approver; `ios-production-release` run from `main` or a tag.
- [ ] After review approval, a person presses **Release** in App Store Connect (`release_type: MANUAL`).
- [ ] Monitoring after launch: crash rate (Xcode Organizer); `/api/events` and `/api/checkout/intent` error rates in Vercel logs.
