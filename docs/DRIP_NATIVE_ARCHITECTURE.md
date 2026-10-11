# Drip — Native iOS Architecture

**Status labels:**
- **Built**: implemented in `ios/`, with unit tests where it is logic.
- **Compiled**: proven to build for iOS in CI. See the CI status in DRIP_IOS_ROADMAP.md.
- **Proposed**: not built yet.

Facts about the backend cite `path:line`. Design decisions are marked **Decision** with the reason.

## 1. Shape

```
ios/
├── project.yml              XcodeGen spec → Drip.xcodeproj (generated, never committed)
├── Config/*.xcconfig        public build settings; secrets never live here
├── DripApp/                 thin app target: @main, Stripe adapter, resources
│   ├── Sources/DripApp.swift, StripePaymentPresenter.swift
│   ├── Info.plist, Drip.entitlements, PrivacyInfo.xcprivacy
│   └── Resources/ (Assets.xcassets, Fonts/*.ttf), Licenses/ (OFL)
└── DripKit/                 Swift package — every module, dependency-free
    ├── Sources/<Module>/
    └── Tests/ (DripKitTests, TestSupport)
```

**Decision: a local Swift package plus a generated project.**
- **Modules.** Each requested module is a real SwiftPM target with enforced dependency edges.
- **Tests.** `swift test` runs the unit tests with no Xcode, on Linux CI as well as macOS.
- **Project file.** XcodeGen produces the `.xcodeproj` on CI, so there are no merge conflicts in a generated `pbxproj`.

**Decision: one third-party dependency.**
- **What it is.** `stripe-ios` (StripePaymentSheet), linked only by the app target.
- **Why it's needed.** PCI-compliant card entry, Apple Pay and the shipping-address element can't responsibly be hand-rolled.
- **Built without SDKs:**
  - Supabase Auth is a small REST surface, implemented directly (`Authentication/SupabaseAuthClient.swift`).
  - Mux playback is plain HLS through `AVPlayer`.
  - Mux upload is one `PUT` to a direct-upload URL.

## 2. Modules and dependency graph

```
DripModels ─┬─ Networking ─┬─ Authentication ──┐
            │              ├─ Analytics ───────┤
            ├─ DesignSystem┤                   │
            └─ Media ──────┤ (Models, Analytics)│
Products (DesignSystem, Networking)            │
Commerce (Products, Analytics)                 │
Discover (Media, Products, Commerce, Analytics, DesignSystem)
Explore (Discover)   Creators (Discover, Media, Authentication)
Profile (Discover, Authentication, Creators)
AppCore (all features) ← DripApp (+ StripePaymentSheet)
```

| Module | Responsibility | Key types | Tested on Linux |
|---|---|---|---|
| **DripModels** | Wire types that mirror the server exactly (`src/lib/feed/types.ts`); `Money` in integer cents; `Loadable` | `FeedItem`, `FeedProduct`, `PaymentIntentRequest`, `CreateDropRequest` | yes |
| **Networking** | Typed endpoints, a cookie-less transport, Bearer auth with a single refresh-and-retry on 401, signed viewer header, error mapping to user copy | `APIClient`, `Endpoint<R>`, `DripAPI`, `APIError` | yes |
| **Authentication** | Supabase Auth REST: password, email code, Sign in with Apple (`id_token`), Google (PKCE); Keychain session; single-flight refresh; device viewer identity | `SupabaseAuthClient`, `SessionStore` (actor), `ViewerIdentityStore` (actor), `KeychainStore`, `PKCE` | yes (Keychain on Apple only) |
| **Analytics** | `/api/events` batching: at most 50 events per batch, under 32 KB, with one re-queue on connectivity failure and never a retry loop | `EventTracker` (actor), `FeedEvent` | yes |
| **DesignSystem** | Tokens from `tokens.json`; Instrument Serif + DM Sans; buttons, chips, price tags, avatars, social actions, states, toasts; Reduce Motion support | `DripPalette`, `DripTypeScale`, `DripMotionSpec`, `DripButtonStyle` | tokens and contrast yes; views on iOS only |
| **Media** | Mux HLS and thumbnail URLs; preload window planner; watch accounting; `AVPlayer` pool; direct upload | `PreloadPlanner`, `WatchSession`, `PlayerPool`, `UploadCoordinator` | planner and watch accounting yes |
| **Products** | Variant selection and preview pricing that mirror the server; product peek sheet | `ProductSelection`, `ProductPeekSheet` | yes |
| **Commerce** | Server-priced checkout state machine; bag; payment UI behind a protocol | `CheckoutModel`, `BagStore`, `PaymentPresenting`, `CheckoutSheet` | yes |
| **Discover** | The feed state machine and the paging feed UI | `FeedModel`, `FeedView`, `FeedPage`, `LivingShelf` | model yes |
| **Explore** | Debounced search with stale-response protection; results grid | `ExploreModel`, `ExploreView`, `VideoTile` | yes |
| **Creators** | Creator storefront; Studio (payouts gate, drop creation, upload) | `CreatorProfileModel`, `StudioModel` | yes |
| **Profile** | Sign-in flows; account, saved items, legal, sign out | `SignInModel`, `ProfileModel` | model yes |
| **AppCore** | Config validation, dependency container, router, deep links, dock | `AppConfiguration`, `AppEnvironment`, `AppRouter`, `DeepLink`, `RootView` | yes |

## 3. Cross-cutting rules

### Concurrency
- **Isolation.** Swift concurrency throughout. UI-facing models are `@MainActor @Observable`. Shared mutable services are actors: `SessionStore`, `ViewerIdentityStore`, `EventTracker`.
- **Strictness.** Strict concurrency checking is on for every module (`Package.swift`, upcoming feature `StrictConcurrency`). The package builds warning-free under Swift 6.2.
- **Single-flight refresh.** Supabase refresh tokens rotate, so two concurrent refreshes with one token would sign the user out. `SessionStore` shares one in-flight refresh. Tested: three concurrent callers produce one network refresh.

### Identity and authentication
Two identities, mirroring the web:

1. **Viewer.** An anonymous device identity, the `drip_aid` equivalent.
   - Minted once by `POST /api/session/anon`, kept in the Keychain, and sent as `x-drip-anon-token`.
   - It carries the same HMAC as the cookie (`src/lib/anon-request.ts`), so the server trusts exactly what it trusts for browsers.
   - Likes, saves, follows, feed personalisation and guest checkout all hang off it, as on the web.
2. **Account.** A Supabase user, for sellers and for keeping state across devices.
   - Sent as `Authorization: Bearer <access token>`.
   - Each user route verifies it with Supabase Auth (`src/lib/supabase-server.ts`).
   - After sign-in the app calls `POST /api/session/link` (`claim_anon_identity`), which deliberately refuses to merge another account's history.

**Decision: cookie-less transport.**
- **Why.** The proxy sets a `drip_aid` cookie on `/api/feed`, and routes check the cookie before the header.
- **Risk.** A default `URLSession` would replay it and fork the device into two viewers.
- **Implementation.** `URLSessionTransport.makeSession()` disables cookies entirely.

**Decision: lowercase UUIDs.**
- **Why.** The routes match lowercase only (`api/feed/route.ts` `UUID_RE`), while Swift's `uuidString` is uppercase.
- **Implementation.** `FeedModel` and `CheckoutModel` lowercase every id they generate. Tested.

### Secrets
The app contains only public values: the API base URL, Supabase URL, Supabase anon/publishable key, Stripe **publishable** key, and the Apple merchant id.
- **Validated at launch.** `AppConfiguration.from` rejects a Stripe `sk_`/`rk_` key, a Supabase `sb_secret_` key, and a legacy JWT whose role is `service_role` (tested). On any problem the app shows a "This build isn't configured" screen instead of running.
- **Kept on the server.** Stripe secret and webhook keys, the Supabase service role, Mux tokens, EasyPost and Resend keys, and `ANON_ID_SECRET` exist only in the Vercel project.

### Errors
- **One error type.** Every network failure becomes `APIError`, already classified: transport, unauthorized, conflict (including `sold_out`), rate-limited, server and so on.
- **User-facing copy.** Server messages are shown verbatim, because the routes write them for buyers ("You have not been charged").
- **Loading model.** Screens use `Loadable`/`Phase` with distinct loading, empty and error states.

### Accessibility
- **Targets.** Every control is at least 44 pt (`DripSize.minHit`).
- **Text.** Custom fonts scale with Dynamic Type through `Font.custom(_:size:relativeTo:)`.
- **Reduce Motion.** Durations are capped at 100 ms and transforms removed (`DripMotionSpec.duration`).
- **Contrast.** Coral buttons always carry ink labels: white on coral fails AA, ink on coral is 5.16:1. This is tested against `tokens.json`'s contrast table.
- **VoiceOver.** Feed pages have accessibility actions: pause or play, like, mute, plus a scroll action for paging. The quantity stepper is adjustable.

## 4. The feed (Discover)

**Paging.** `ScrollView` + `LazyVStack` + `.scrollTargetBehavior(.paging)` + `.scrollPosition(id:)` (iOS 17). It is native paging with no artificial delayed lock, as `SPECIFICATION.md` asks. A settled page calls `FeedModel.commit(index:)`.

**Playback** (`Media/PlayerPool`):
- **Window.** `PreloadPlanner` gives the active page `play`, the next `preroll` (buffered, paused at 0), the one after `warm` (item created, minimal buffer) and the previous `retain` (paused in place). This matches the web shell's one-back, two-ahead window.
- **Reuse.** Players are recycled: a pool of `AVQueuePlayer`s with `AVPlayerLooper`, re-pointed as the window slides. Exactly one plays at a time.
- **Memory warnings.** These shrink the window to active plus next and release everything else.
- **Background.** Backgrounding, checkout and opening a creator pause playback. The product peek keeps the video playing, as the design specifies (frame 41).
- **Stream.** Mux HLS (`stream.mux.com/{id}.m3u8`), not the web's `low.mp4`. The audit found MP4 renditions are never enabled on upload (audit D §0.2 #5).

**Events.** These are the same semantics as `src/components/feed/feed-shell.tsx`, so the ranker gets identical signals from both clients:
- one `impression` per video per session;
- a `skip` on every page change, with cumulative watch time (playhead plus loops times duration) and the loop count;
- `watch_progress` at 25, 50, 75 and 95%, re-armed every loop;
- product taps, variant selection, add to bag, `checkout_open` and `checkout_abandon`.
- **No client `purchase` event.** The Stripe webhook is the authority (audit C §4.5).

**Paging the API.**
- **Prefetch.** It fetches five from the end, with `offset = items.count`, `before = nextBefore`, and the last 200 ids as `exclude_ids`. The server rejects more than 8,000 characters.
- **Dedupe.** Items already in the buffer are dropped.
- **End.** The feed is exhausted when a page adds nothing new and has no cursor.

**States.** Loading, empty ("You're all caught up."), error with retry, a per-video playback error with retry, and "processing" for videos without a playback id.

## 5. Commerce

**Flow:** Peek (choose variants and quantity) → `CheckoutModel.quote()` → `POST /api/checkout/intent` → `PaymentPresenting.present` → done.
- **Quote.** The request carries video, product, quantity, `{groupName: optionValue}`, an idempotency key and email. It never carries an amount.
- **Payment presentation.** It opens the Stripe address sheet for the shipping label, then PaymentSheet with Apple Pay and cards.
- **Server authority.** The server decides price, variant deltas, shipping, inventory, seller eligibility and the Connect destination charge (`checkout/intent/route.ts`).
- **Order creation.** The Stripe webhook creates the order (`webhooks/stripe/route.ts`).
- **Idempotency.** One key per checkout, generated when it opens, so retries return the same PaymentIntent. Tested.
- **App Store compliance.** Only physical goods are sold, shipped by creators, so guideline 3.1.3(e) applies and IAP is not used (audit D §5).

**Bag.**
- **Storage.** The bag is on-device (`BagStore`, a JSON file in Application Support).
- **Checkout.** Each line checks out on its own, because the server takes one product per PaymentIntent (`intent/route.ts:14`).
- **Pricing.** Prices shown in the bag are estimates; checkout re-quotes from the server.
- **Proposed.** A server cart with a multi-item PaymentIntent (`order_items` already exists) for a single combined checkout.

## 6. Creators

- **Profile.** `GET /api/feed?surface=seller_profile&seller=<handle>`; follow is an event keyed to one of the creator's videos.
- **Studio:**
  - Payouts gate via `/api/stripe/onboarding/status` and `start`. Hosted onboarding opens in `ASWebAuthenticationSession`, never in an embedded web view.
  - Drop creation via `POST /api/drops`, then a Mux direct-upload `PUT` with progress.
  - **Known blocker:** `/api/drops` writes the legacy `drops` table, which the feed doesn't read (audit A §0.3). The native flow is correct against today's API, but published drops won't appear in the feed until the backend gains a videos/products creation endpoint.

## 7. Navigation

- **Dock.** The design's five-zone dock: Home, Discover, Drop, Following, Profile (`SPECIFICATION.md:41-51`).
- **Stacks.** One `NavigationStack` per tab; re-selecting a tab pops to its root.
- **Sheets.** Sign-in and Bag are app-level sheets; product peek and checkout belong to the feed.
- **Deep links** (`DeepLink.parse`, tested):
  - `drip://home|discover|following|profile|bag`
  - `drip://search?q=`
  - `drip://creator/<handle>`, with the handle validated against the database's `^[a-z0-9_]{3,30}$`
  - `drip://auth-callback`
  - `https://<site>/search?q=`
- **Universal links.** Need an `apple-app-site-association` file served by the web app. *Proposed.*

## 8. Testing

- **DripKit: 60 XCTest cases.** They cover the network contracts, auth, analytics, media logic, products, commerce, explore, studio, config, routing and design tokens. They run with `swift test` on Linux and macOS, and on the iOS Simulator in CI.
- **Web: 886 Vitest tests**, including native identity, the proxy, the Following surface and the feed cursor.
- **Not yet covered:**
  - UI snapshot or XCUITest flows (Proposed, roadmap M6).
  - Network calls against a real backend: production has none to test against (see the audit).
