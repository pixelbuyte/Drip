# Drip — Screen Inventory

This document has two halves:
- **Native screens as built** (first section). What `native-ios` implements in SwiftUI, mapped to the design frames and the backend routes behind each screen.
- **The web application as it exists** (Parts 0–7). Every route, component, navigation edge and feed behaviour, with `path:line` citations. Written from a read of the code at `9e0aa04`.

**Labels:** **[C]** Confirmed in code · **[I]** Inferred · **Proposed**.
**Native statuses:**
- **Built**: implemented, compiled, and its logic is unit-tested in DripKit.
- **Built, unverified on device**: compiles for iOS in CI, but has not been run on a device or simulator by a person.
- **Not built**: needs backend work first, with the reason given.

---

## Native screens as built

### App shell
- **Navigation.** It follows the design spec, not a generic template. There is a five-zone cream dock (Home · Discover · **Drop** · Following · Profile), with Drop as a coral circle and an ink plus sign (`docs/product-design/SPECIFICATION.md:41-51`, board 14 study 1). Bag sits in the Home header.
- **Source:** `ios/DripKit/Sources/AppCore/RootView.swift`, `AppRouter.swift`.
- **One `NavigationStack` per tab.** Re-tapping a tab pops it to its root.

| Native screen | Design frames | SwiftUI source | Backend | Status |
|---|---|---|---|---|
| **Home: For you feed**, the living shelf | 1, 40 | `Discover/FeedView.swift`, `FeedPage.swift` | `GET /api/feed` (surface `for_you`), `POST /api/events`, `GET /api/me/reactions` | Built, unverified on device. Paging, autoplay, offscreen pause, one-back/two-ahead preload, player reuse, memory-warning shrink, loading/empty/error states |
| ├ Double-tap like + heart burst | 37 | `FeedPage.swift` | `like` event | Built |
| ├ Like / save / share / follow (horizontal social row) | 40, 38 | `FeedPage.swift`, `DesignSystem/Components.swift` | `like/unlike/save/unsave/follow/unfollow/share` events | Built (optimistic; state re-read per session) |
| ├ Not interested / report | — | `FeedPage.swift` menu | `not_interested`, `report` events | Built (the `report` event is telemetry only; the `reports` table is legacy, see audit C §3) |
| ├ Product peek (variants, quantity, add to bag) | 2, 41 | `Products/ProductPeekSheet.swift` | data embedded in `FeedItem.products` | Built. The video keeps playing under the 65% detent, as the design specifies |
| ├ Shop this look (multi-product) | 3 (partial), 40 | `LivingShelf` in `FeedPage.swift` | same | Built as a menu. On-video frame tags (frame 3) not built: `pinnedAtSecond` is in the data but unused |
| ├ Checkout: Make it yours → It's yours | 42, 22, 23, 24, 34 | `Commerce/CheckoutViews.swift`, app `StripePaymentPresenter.swift` | `POST /api/checkout/intent` → Stripe PaymentSheet (address element, Apple Pay, cards) → webhook | Built, unverified on device. Needs Stripe keys and an Apple Pay merchant ID |
| └ Comments | 4–6 | — | **none** | **Not built.** There is no comments table or route. The button is deliberately absent rather than fake |
| **Bag** (Home header) | 21 | `Commerce/CheckoutViews.swift` (`BagView`), `BagStore.swift` | on-device; each line checks out via `checkout/intent` | Built, with a limit: one checkout per line, because the server takes one product per PaymentIntent. A combined checkout needs a server cart |
| **Discover**: search + results grid | 10, 12, 36 | `Explore/ExploreView.swift` | `GET /api/search` | Built. Trending chips are static suggestions, since no categories endpoint exists. Category tiles (frame 10/11) not built |
| └ Result → vertical feed at that video | — | `AppCore/RootView.swift` (`SeededFeedScreen`) | `GET /api/search` paging | Built |
| **Drop** (creator tools) | 29 | `Creators/CreatorViews.swift` (`StudioView`) | `GET /api/stripe/onboarding/status`, `POST /api/stripe/onboarding/start`, `POST /api/drops` + Mux direct upload | Built against the existing routes. **Blocked end-to-end:** `/api/drops` writes the legacy `drops` table, which the feed never reads (audit A §0.3) |
| **Following** feed | 17 | `FeedView` with surface `following` | `GET /api/feed?surface=following` (now filtered server-side on `native-ios`) | Built. Empty state when following nobody |
| **Creator profile** (pushed) | 16, 38 | `Creators/CreatorViews.swift` (`CreatorProfileView`) | `GET /api/feed?surface=seller_profile&seller=<handle>` | Built: header, follow, 3-up video grid. Bio, follower count and cover image need a profile endpoint |
| **Profile**: account, saved, legal, sign out | 18, 19, 32 | `Profile/ProfileViews.swift` | `GET /api/me/saved`; Supabase Auth | Built. **Orders, notifications and account deletion are not built** (no backend) |
| **Sign in** | — | `Profile/ProfileViews.swift` (`SignInView`) | Supabase Auth REST: Apple `id_token`, Google PKCE, password, email code; `POST /api/session/link` | Built. Needs Apple and Google providers configured in Supabase, plus the `drip://auth-callback` redirect allow-listed |
| Misconfigured-build screen | — | `DripApp/Sources/DripApp.swift` | — | Built. Lists the missing or secret-looking config values without crashing |

### Design frames not built natively, and why
| Frames | Reason |
|---|---|
| 4–6 Comments | No backend (no table or route). Proposed in DRIP_IOS_ROADMAP.md, M4 |
| 7–9 Shop editorial surfaces | Need curated collections or editorial data; no model exists |
| 11 Category feed UI | The API supports `surface=category&category=`, but there is no categories list endpoint for tiles. Roadmap M4 |
| 14, 15 (reviews), 26, 27, 30 Collections, reviews | No data model |
| 20 Notifications | No notifications or push-token backend |
| 25, 28, 39 Compare, announcement, scrub | Feature work after M4 |

---

# The web application as it exists
## 0. Headline findings

1. **Two incompatible content models coexist.** The legacy "drop" model (`drops` table: seller dashboard, `/@handle/slug` page, Stripe Checkout) and the new feed model (`videos` / `products` / `video_products`: `/feed`, `/search`, in-feed checkout, Studio). Migration `00007` backfills drops into videos and then runs `DROP TABLE public.drops` (`supabase/migrations/00007_feed_content_model.sql:570`) **[C]**. Yet 14 call sites still query `drops` (for example `src/app/dashboard/drops/page.tsx:56`, `src/app/[handle]/[slug]/page.tsx:27`, `src/app/api/drops/route.ts:78`, `src/app/api/webhooks/mux/route.ts:66`) **[C]**.
2. **Production runs the *legacy* schema today.** It has 5 tables: `profiles, drops, orders, seller_payments, processed_events` (`docs/production-migration/PREFLIGHT.md:14-16`) **[C]**. As a result:
   - **Today:** `/feed`, `/search` and Studio find no feed tables, so they render their empty or first-run states (`src/app/studio/page.tsx:39-43` says so explicitly) **[C]**. Discounts, waitlist and report have no tables in prod **[I]**.
   - **After 00007:** every legacy seller screen, the public drop page and the Mux webhook break **[I, strongly evidenced]**.
3. **No working "create video" path in the new model.** Studio's "Post a video" goes to `/dashboard/drops/new` (`src/lib/studio/types.ts:96`) **[C]**, which creates a `drops` row (`src/app/api/drops/route.ts:77-92`) **[C]**. The Mux webhook only ever updates `drops` (`src/app/api/webhooks/mux/route.ts:57-85`) **[C]**. Nothing inserts into `videos`, so no new upload can reach `/feed` **[I]**.
4. **`/dashboard` redirect loop for onboarded sellers.**
   - `/dashboard` reads `profiles.charges_enabled` (`src/app/dashboard/page.tsx:43`) **[C]**. That column was dropped (`supabase/migrations/00006_reconcile_forked_schema.sql:172`) and moved to `seller_payments` **[C]**. So the value is always `undefined`, and the page pushes to `/onboarding/stripe` (`dashboard/page.tsx:44`) **[C]**.
   - `/onboarding/stripe` checks `/api/stripe/onboarding/status`. If `charges_enabled` is true it pushes back to `/dashboard` (`src/app/onboarding/stripe/page.tsx:19-20`) **[C]**. The result is a ping-pong **[I]**.
   - `src/proxy.ts:29-35` also sends any signed-in visitor of `/` to `/dashboard` **[C]**.
5. **Social and shopping-utility features are unbuilt in the UI.** Likes, saves, follows, comments, cart/bag, notifications, profile, creator storefront, categories and Following have no screens. The backend has partial plumbing:
   - Event types exist: `like`, `save`, `follow`, `share`, `not_interested` (`src/lib/events/client.ts:12-17`) **[C]**.
   - Tables and ingest exist: `viewer_video_reactions` and `follows` (`supabase/migrations/00008_viewer_identity_and_events.sql:75-97`), ingested at `00008…sql:509-528` **[C]**.
   - **No component emits these events** (grep finds only the type unions and the server allow-list) **[C]**.

---

## 1. Route table (every page / layout / route group)

There are no route groups (`(group)` folders), no `loading.tsx`, and no `global-error.tsx` in `src/app` (file listing) **[C]**. Dynamic segments: `[handle]/[slug]`, `[handle]/[slug]/thanks`, `studio/videos/[videoId]`, plus API `[id]` routes **[C]**.

**Status key:**
- **IMPLEMENTED:** the code path is complete against its intended schema.
- **PARTIAL:** works, but with stubs or missing pieces.
- **MOCKED:** fixture or hardcoded data.
- **BROKEN:** fails against the repo schema, or against production today.
- **MISSING:** referenced but has no route.

| URL | File | Server/Client | Auth & enforcement | Data source | Status |
|---|---|---|---|---|---|
| `/` | `src/app/page.tsx:71` | Server page, client islands | Public. Signed-in visitors are redirected to `/dashboard` by a cookie-presence check on `sb-*-auth-token` (`src/proxy.ts:27-35`) [C] | None. All content comes from `src/components/landing/products.ts:37-79` [C] | **MOCKED** |
| `/feed` | `src/app/feed/page.tsx:12` | Server (`force-dynamic`, :10). Renders client `FeedShell` | Anonymous. The proxy mints the signed `drip_aid` cookie and forwards `x-drip-anon-id` (`src/proxy.ts:38-68`) [C] | SSR: `getFeedSliceRankedOrNaive(createAdminClient())` (:36-43), which reads `videos`, `categories`, `profiles`, `seller_payments`, `video_products`, `products` (`src/lib/feed/slice.ts:84-102`) and writes `feed_slices` [C]. Client: `GET /api/feed` (`feed-shell.tsx:92-96`) [C] | **IMPLEMENTED** in code. Empty in prod today because the tables are missing [I] |
| `/feed/demo` | `src/app/feed/demo/page.tsx:7` | Server, renders `FeedShell` | Anonymous (proxy matcher `/feed/:path*`, `proxy.ts:18`) [C] | `DEMO_ITEMS` fixtures: 6 items, Mux public demo playback ids (`src/app/feed/demo/fixtures.ts:47-51,67-95`) [C] | **MOCKED** (`initialExhausted`, no pagination, :8) |
| `/search?q=` | `src/app/search/page.tsx:14` | Server (`force-dynamic`) + client `FeedShell` (surface `search`) | Anonymous, but **`/search` is not in the proxy matcher** (`proxy.ts:16-23`) [C]. A cold visitor has no anon cookie, so `anonId` is null, the slice is skipped (:36) and the page says "Nothing matched" (:78-86) [I] | `getSearchSlice` (`src/lib/search/slice.ts`, writes `feed_slices` :57) [C]. Client pagination: `GET /api/search` (`feed-shell.tsx:89-91`) [C] | **PARTIAL**: no-cookie bug; the 100dvh feed sits inside a `calc(100vh-10rem)` box (:93) [I] |
| `/@handle/slug` (`[handle]/[slug]`) | `src/app/[handle]/[slug]/page.tsx:74` + client `drop-view.tsx` | Server + client | Public. The handle must start with `@` (:12-13) [C] | Anon Supabase: `profiles`, `drops` where status is active (:18-32) [C] | **BROKEN** after 00007 (`drops` dropped). Works on prod-today legacy schema [I] |
| `/@handle/slug/thanks` | `src/app/[handle]/[slug]/thanks/page.tsx:9` | Server | Public | `profiles`, `drops` (:16-29) [C] | **BROKEN** after 00007 [I] |
| `/auth/login` | `src/app/auth/login/page.tsx:9` | Client | If a session exists, push to `/dashboard` (:16-19) [C] | Supabase Auth UI, email/password + Google (:58-66) [C] | **PARTIAL**: no `onAuthStateChange` anywhere in `src` (grep) [C], so a password sign-in does not navigate [I] |
| `/auth/signup` | `src/app/auth/signup/page.tsx` | Client | Same as login | Auth UI `view="sign_up"`; copy is "Claim your handle" (seller) [C] | **PARTIAL** (as login) |
| `/auth/callback` | `src/app/auth/callback/route.ts:4` | Route handler | Exchanges the code. Redirects to `next` or `/onboarding` (:7,14), or on failure to `/auth/login?error=auth_failed` (:19) [C] | Supabase Auth | **IMPLEMENTED**. Returning OAuth users still land on `/onboarding` [I] |
| `/onboarding` | `src/app/onboarding/page.tsx:22` | Client | No guard on render. Submit checks `getUser` (:47-54) [C] | Inserts into `profiles` (:57-61). Unique violation shows "Handle is already taken" (:64-65) [C] | **IMPLEMENTED** (no existing-profile skip) |
| `/onboarding/stripe` | `src/app/onboarding/stripe/page.tsx:6` | Client | Via API 401s only | `GET /api/stripe/onboarding/status` (:16). `POST /api/stripe/onboarding/start` then `window.location` to Stripe (:37-48) [C] | **IMPLEMENTED** (but see the loop in §0.4) |
| `/onboarding/stripe/return` | `src/app/onboarding/stripe/return/page.tsx` | Client | Via API | Status polling. Goes to `/dashboard` after 1.5 s if enabled (:37-43), "continue" restarts onboarding (:56-59), retry reloads (:75) [C] | **IMPLEMENTED** |
| `/dashboard` | `src/app/dashboard/page.tsx:7` | Client | In-page: no user → `/auth/login` (:27-28). Not `charges_enabled` → `/onboarding/stripe` (:43-44) [C] | `profiles.*` (:32-36), `GET /api/dashboard/stats` (:49), which reads `drops` (`api/dashboard/stats/route.ts:30`) [C] | **BROKEN** (charges_enabled loop; `from_address` banner always shows :93) |
| `/dashboard/drops` | `src/app/dashboard/drops/page.tsx` | Client | In-page redirect (:48-49) [C] | `profiles`, `drops` (:54-60). Archive/unarchive updates `drops` (:86). Restock calls `POST /api/drops/[id]/restock` (:98). Stats via `/api/dashboard/stats` (:67) [C] | **BROKEN** after 00007 |
| `/dashboard/drops/new` | `src/app/dashboard/drops/new/page.tsx:12` | Client | API 401 (`api/drops/route.ts:14-16`) [C] | Phase 1 form → `POST /api/drops` (:55). Phase 2 `<MuxUploader endpoint=upload_url>` (:95-99) [C] | **BROKEN** after 00007, and the output never reaches the feed model (§0.3) |
| `/dashboard/orders` | `src/app/dashboard/orders/page.tsx:40` | Client | In-page (:53-54) [C] | `orders` with embed `drops(title)` (:58-64). Retry label: `POST /api/orders/[id]/retry-label` (:79). CSV export link `/api/orders/export` (:101) [C] | **BROKEN** after 00007: the embed errors and the page silently shows "No orders yet" [I] |
| `/dashboard/discounts` | `src/app/dashboard/discounts/page.tsx` | Client | API only (no in-page redirect) [C] | `GET/POST/DELETE /api/discounts` (:25,43,63), table `discount_codes` [C] | **PARTIAL**: codes apply only in legacy `/api/checkout` (:103). `/api/checkout/intent` has no discount handling (grep) [C] |
| `/dashboard/settings` | `src/app/dashboard/settings/page.tsx` | Client | In-page (:34) [C] | `seller_payments.from_address` read (:42); `POST /api/settings/address` (:75) [C] | **IMPLEMENTED** |
| `/studio` (layout) | `src/app/studio/layout.tsx:137` | Server (`force-dynamic` :18) | **Layout guard**: `getUser()`, and no user → `redirect('/auth/login')` (:31-51,142) [C] | `profiles.handle` (:41-45) | **IMPLEMENTED** |
| `/studio` | `src/app/studio/page.tsx:753` | Server | Layout guard plus page re-check (:756) [C] | `profiles`, `seller_payments` (admin), `videos`, `video_stats`, `video_products`, `products`, `orders` (:200-342). Stripe `balance.retrieve` / `payouts.list` (`:441-449` region) [C] | **IMPLEMENTED** (first-run state in prod today) |
| `/studio/videos` | `src/app/studio/videos/page.tsx:407` | Server | Layout guard plus `redirect` (:409) [C] | `videos`, `video_stats`, `video_products`, `products` (:123-168) [C] | **IMPLEMENTED** |
| `/studio/videos/[videoId]` | `src/app/studio/videos/[videoId]/page.tsx:930` | Server | Layout guard. Ownership is checked in the predicate `.eq('seller_id', userId)` (:211-220). Not found → `notFound()` (:939) [C] | `videos`, `categories`, `feed_events` (admin count queries), `video_products`, `video_stats`, `orders`, `products`, `profiles` (:214-403) [C] | **IMPLEMENTED** (funnel, retention, sources). `AlgorithmPanel` is deliberately not mounted (`src/components/studio/algorithm-panel.tsx:33-40`) [C] |
| `/studio/money` | `src/app/studio/money/page.tsx:1127` | Server | Layout guard plus `redirect` (:1130) [C] | `orders` (modern/legacy dual shape, :219-300), `profiles`, `seller_payments`. Stripe `accounts.retrieve`, `balance`, `payouts` (:574-592) [C] | **IMPLEMENTED** |
| `/legal/*` | `src/app/legal/layout.tsx:1`; `terms/`, `privacy/`, `prohibited-items/` | Server, static | Public | None | **IMPLEMENTED** |
| (404) | `src/app/not-found.tsx:1` | Server | — | — | **IMPLEMENTED**. Copy "This drop is gone"; link `/` (:13) |
| (error) | `src/app/error.tsx:1` | Client boundary | — | — | **IMPLEMENTED**. "Try again" calls `reset()` (:15) |
| `/v/*`, `/discover/*` | — | — | In proxy matcher (`proxy.ts:19-20`) [C] | — | **MISSING** (no route files) |
| Root layout | `src/app/layout.tsx:31` | Server | — | Fonts Bricolage Grotesque + Hanken Grotesk (:7-18) | — |

### API surface used by screens (and reusable by native)

| Endpoint | File | Used by | Tables | Notes |
|---|---|---|---|---|
| `GET /api/feed` | `src/app/api/feed/route.ts:32` | FeedShell | `videos`… `feed_slices` | Params: `session_id` (uuid), `surface`, `exclude_ids` (≤8000 chars), `category`, `seller`, `mode`, `offset`, `before` (:15-28). Needs the anon id (:37-46). Rate limit 60/min/IP (:33) [C] |
| `GET /api/search` | `src/app/api/search/route.ts:24` | FeedShell (search) | via `getSearchSlice` | `q` 1–200 chars. Rate limits 60/min/IP and 30/min/anon (:25,45). `nextBefore` is always null (:75) [C] |
| `POST /api/events` | `src/app/api/events/route.ts` | `lib/events/client.ts` | RPC `ingest_feed_events`, `viewer_identities` (:104-140) | Batched; beacon on hide [C] |
| `POST /api/checkout/intent` | `src/app/api/checkout/intent/route.ts` | CheckoutSheet | `video_products`, `videos`, `products`, `profiles`, `seller_payments`, `shipping_profiles` (:53-128) | Creates a PaymentIntent with `transfer_data` and `application_fee` (:153-170). `quantity` max is **10** (:14) [C] |
| `POST /api/checkout` | `src/app/api/checkout/route.ts` | legacy drop page | `drops`, `discount_codes`, `profiles`, `seller_payments` | Stripe Checkout Session. `success_url` = `…/thanks` (:187) [C] |
| `POST /api/waitlist`, `POST /api/report` | `api/waitlist/route.ts:33`, `api/report/route.ts:28` | legacy drop page | `drops` + `waitlist_entries` / `reports` | BROKEN after 00007 [I] |
| `GET /api/dashboard/stats` | `api/dashboard/stats/route.ts:17-30` | /dashboard, /dashboard/drops | `seller_payments`, `orders`, `drops` | BROKEN after 00007 [I] |
| `/api/stripe/onboarding/{start,status,refresh}` | `api/stripe/onboarding/*` | onboarding | `seller_payments` | `return_url` = `/onboarding/stripe/return` (`start/route.ts:96`) [C] |
| `POST /api/session/link` | `api/session/link/route.ts` | **no UI caller** (grep) [C] | `claim_anon_identity` RPC | Links the anon id to a signed-in user |
| Webhooks: stripe / mux / easypost | `api/webhooks/*` | — | stripe: `orders`, `order_items`, `products`, `seller_payments` (:114-397). mux: **`drops` only** (:57-85) | [C] |

---

## 2. Navigation graph

Edges are `source → target  (mechanism, file:line)`. All are **[C]** unless marked.

- `/` (landing)
  - → `/auth/signup` ("Start Shopping" hero `page.tsx:107`, final CTA `:249`, nav `nav.tsx:135`, mobile overlay `nav.tsx:175`, footer "Become a creator" `page.tsx:278`)
  - → `/auth/login` ("Sign in" `nav.tsx:129`, mobile `nav.tsx:161`)
  - → `/search?q=…` (search field submit `nav.tsx:32`; chips `nav.tsx:65`)
  - → `#feed` / `#categories` / `#creators` / `#lists` in-page anchors only (`nav.tsx:75-80`, `page.tsx:113,255,277`, `category-tiles.tsx:22`, `campaign.tsx:61`). **The landing page never links to `/feed`.**
  - → `/legal/terms|privacy|prohibited-items` (footer `page.tsx:280`)
  - → `/dashboard` (proxy redirect when an `sb-*-auth-token` cookie exists, `proxy.ts:29-35`)
- `/feed`, `/feed/demo`
  - No outbound links. There is no header, tab bar or back control (`feed-shell.tsx:253-411`).
  - In-place overlays: ProductSheet → CheckoutSheet → success state → "Keep watching" closes both (`feed-shell.tsx:395-400`).
- `/search`
  - → `/` (logo `search/page.tsx:60-62`)
  - → `/search?q=` (own `SearchField` `:66`)
  - → `/feed` ("browse the feed" when empty `:81`)
  - Embedded FeedShell overlays as above.
- `/@h/s` (drop page)
  - → Stripe Checkout (`window.location = data.url`, `drop-view.tsx:62`) → `/@h/s/thanks` (`api/checkout/route.ts:187`). Cancel → `/@h/s` (:188).
  - `/thanks` has no outbound link (`thanks/page.tsx:124-148`).
- `/auth/login` ↔ `/auth/signup` (`login/page.tsx:72`, `signup/page.tsx:74`). Both → `/` (logo, :46).
  - Session → `/dashboard` (:18).
  - OAuth / email confirm → `/auth/callback` → `/onboarding` (default) or `/auth/login?error=auth_failed`.
- `/onboarding` → `/onboarding/stripe` (`onboarding/page.tsx:71`).
- `/onboarding/stripe` → Stripe-hosted onboarding (`:48`) → `/onboarding/stripe/return` → `/dashboard` (`return/page.tsx:43`). Already enabled → `/dashboard` (`stripe/page.tsx:20`).
- `/dashboard`
  - → `/auth/login` (no user :28)
  - → `/onboarding/stripe` (always, see the loop :44)
  - → `/dashboard/drops` (:135), `/dashboard/orders` (:143), `/dashboard/discounts` (:151), `/dashboard/settings` (:97,159)
  - Sign Out button calls `signOut()` and does not navigate (:86).
- `/dashboard/drops` → `/dashboard/drops/new` (:123), `/@handle/slug` (:166), `/dashboard` (:214).
- `/dashboard/drops/new` → `/dashboard/drops` (after upload :116).
- `/dashboard/orders`
  - → `/api/orders/export` (CSV :101)
  - → USPS tracking (external :142)
  - → label PDF (`label_url` :155)
  - → `/dashboard` (:178)
- `/dashboard/discounts`, `/dashboard/settings` → `/dashboard` (:153, :205).
- `/studio/*` (layout)
  - Tabs: `/studio`, `/studio/videos`, `/studio/money` (`layout.tsx:67-103`; side rail :160-171, bottom bar :209-226)
  - "View the feed →" `/feed` (:177)
  - Unauthenticated → `/auth/login` (:142)
- `/studio`
  - → `/studio/videos/[id]` (:655)
  - Todo links (`buildTodos`, `:473-555`): `/studio/videos/[id]`, `/onboarding/stripe`, `/dashboard/settings`, `/dashboard/drops/new`
  - → `/dashboard/drops/new` (:822), `/studio/videos` (:942)
- `/studio/videos` → `/studio/videos/[id]` (:326), `/dashboard/drops/new` (:389, :431).
- `/studio/videos/[id]` → `/studio/videos` (:947), `/dashboard/drops/new` (:664, :1053), `/feed` (:1059).
- `/studio/money` → `/onboarding/stripe` (:744), `/dashboard/drops/new` (:1280).
- `/legal/*` → each other and `/` (`legal/layout.tsx:8-11`).
- `not-found` → `/` (:13). `error` → `reset()`.

**Orphans / dead ends [C]:**
- `/feed` is reachable only from `/search` (empty state) and Studio.
- `/feed/demo` is unlinked.
- `/thanks` and `/feed` have no exits.
- Studio is not linked from `/dashboard`, and `/dashboard` is not linked from Studio.

---

## 3. Feed: exact behaviours (port spec)

Sources: `src/components/feed/feed-shell.tsx`, `feed-video.tsx`, `playback-registry.ts`, `product-bar.tsx`, `product-sheet.tsx`, `checkout-sheet.tsx`, `src/hooks/use-snap-index.ts`, `src/lib/events/client.ts`. Everything in this section is **[C]** unless marked.

### 3.1 Vertical paging (`use-snap-index.ts`)

**Layout**
- The scroller is one `overflow-y-scroll` div at `100dvh` with `scroll-snap-type: y mandatory`, `overscroll-behavior-y: contain` (`feed-shell.tsx:254-262`).
- Each slide is a `<section>` with height `100dvh`, `scroll-snap-align: start`, and **`scroll-snap-stop: always`**, so a fling cannot skip slides (:268-277).

**Commit detection**
- Passive `scroll` listener. Each event sets a flag and resets a **90 ms idle timer** (`use-snap-index.ts:5,61-68`).
- `scrollend`, when supported, commits immediately (:70-78).
- On mount it commits index 0 (`'init'`, :79).
- Commit math:
  - `raw = scrollTop / clientHeight`, measured live each time (:48-50).
  - Commit only if `|raw - round(raw)| ≤ 0.01`, i.e. parked on a snap point (:7, :54).
  - Clamp to `[0, count-1]`.
  - **Idempotent**: no-op when the index equals the last committed index (:56).
- The listener subscribes once; `count` and `onCommit` are read through a ref (:31-34, :86-88).

**Native equivalent [I]:** a paging `ScrollView` (`.scrollTargetBehavior(.paging)` with `scrollPosition(id:)`), committing on scroll-phase idle. Never commit mid-gesture, and dedupe commits.

### 3.2 On commit (`feed-shell.tsx:117-163`)

1. **Skip event for the outgoing slide**, if it differs. It is computed *before* reset:
   - `watched = currentTimeMs + loops × durationMs`
   - Emits `{t:'skip', v, wm, dm, lc, pos}` (:123-139).
2. Set `committedRef` and `committed` state (:141-142).
3. **Impression**, emitted at most once per videoId per mount (`impressed` Set): `{t:'impression', v, pos}` (:144-148).
4. **Product-bar nudge.** At +1500 ms set `nudgeAt=index`; at +1900 ms clear it (:150-153). The nudge is `translateY(-6px)` with a 420 ms `cubic-bezier(0.32,0.72,0,1)` transition, and is disabled under reduced motion (`product-bar.tsx:33-60`). (The cleanup returned by `onCommit` is ignored by the hook, whose signature returns `void` (`use-snap-index.ts:25`), so the timers are never cancelled [C/I].)
5. **Prefetch** when `index ≥ items.length − 5` (`FEED_SLICE_SIZE 20 − FEED_PREFETCH_AT 15`; `feed-shell.tsx:155`, `lib/feed/types.ts:83-85`).

### 3.3 Pagination (`fetchMore`, :80-115)

- Guarded by `loading` ref and `exhausted`.
- Request:
  - `GET /api/feed?session_id&surface&offset=items.length&exclude_ids=<last 200 ids>&before=<cursor>`.
  - On search: `GET /api/search?session_id&q&exclude_ids`.
- Response handling:
  - Dedupe against the buffer.
  - If there are no fresh items and no `nextBefore`, set exhausted ("You're all caught up" slide, :353-363).
  - Errors are swallowed silently (:110-111).
- Empty initial list → "Nothing here yet" (:242-251).

### 3.4 Mount window and preloading (`playback-registry.ts`)

- Mounted window: `[committed−1, committed+2]` (`WINDOW_BEFORE=1`, `WINDOW_AFTER=2`, :115-116; `feed-shell.tsx:265`).
- Outside the window: a black placeholder. `content-visibility: auto` with `contain-intrinsic-size: 100dvh` (:281-283, :321).
- Off-screen slides are `inert` (:290).

| Index relative to committed | Stage (`stageFor`, :118-124) | `<video preload>` (`feed-video.tsx:237`) |
|---|---|---|
| 0 | `active` | `auto` |
| +1 | `warm` | `auto` |
| +2 | `manifest` | `metadata` |
| −1 | `cold` | `none` |
| other | not mounted | — |

**Native equivalent [I]:** `AVPlayer` pool of 4. Current: playing. +1: `AVPlayerItem` with `preferredForwardBufferDuration` set and preroll. +2: asset loaded, keys only. −1: kept paused, buffer dropped.

### 3.5 Video element (`feed-video.tsx`)

- A plain `<video>`, not MuxPlayer. Source is `https://stream.mux.com/{playbackId}/low.mp4` (:222). This requires Mux static MP4 renditions [I].
- Attributes: `muted loop playsInline webkit-playsinline disablePictureInPicture disableRemotePlayback`, `object-cover` (:225-241).
- **Poster:** set from `thumbnailUrl` *except* for index 0 (`isLcpCandidate` → `poster=undefined`, :228). No `<img>` substitutes for it anywhere (`feed-shell.tsx` has no image for slide 0) [C]. So the first slide shows black until the first frame decodes. This contradicts the stated intent in `feed/page.tsx:8-9` [I: likely bug].
- **Loop counting:** no `ended` event fires on a looping video. A loop is counted when `currentTime` jumps back by more than 0.5 s (:199-205). Each loop re-arms the progress buckets.
- **Progress buckets:** 25 / 50 / 75 / 95 %, each emitted once per loop as `{t:'watch_progress', b, wm, dm, lc, pos}` (:207-216; shell :301-311).
- **Errors:** `{t:'video_error'}` (shell :300).

### 3.6 Playback ownership, autoplay and off-screen pausing (`feed-shell.tsx:168-238`)

- **Single owner:** a `Map<index, FeedVideoHandle>` registry. The handle API is `play`, `pauseAndReset`, `pauseHold`, `resume` (unused, grep), `setMuted`, `currentTimeMs`, `durationMs`, `loopCount` (`playback-registry.ts:7-17`).
- **On every commit / mute / sheet change**, in a `useLayoutEffect` (same frame) (:196-208):
  - Every non-current handle: `pauseAndReset()` (pause, seek to 0, clear loop and bucket state, `feed-video.tsx:166-178`).
  - If a sheet is open: current `pauseHold()` (pause, keep frame) and stop.
  - Otherwise `startCurrent()`.
- **`startCurrent`** (:175-194):
  1. Apply `mutedRef`.
  2. `play()`. On rejection, force muted and retry.
  3. On a second rejection, show the "Tap to play" pill (`needsTap`, :403-410).
- **Late mount** (`register`, :210-224): a slide mounting after its commit is started if current, held if suspended, or reset if not current.
- **Mute:**
  - Default muted. Tapping anywhere on the video (gradient overlay) toggles mute (:313-318).
  - Persisted in `localStorage['drip_muted']` (`'0'` = unmuted) and applies to all later videos (:13, :67-78, :226-238).
- **Not implemented [C]:**
  - No pause-on-tap. Tap means mute.
  - No `visibilitychange` pause of the video. Only an event flush happens on hide (`events/client.ts:145-152`).
  - No double-tap.
  - No scrubber.

### 3.7 Slide chrome (`feed-shell.tsx:324-347`)

- `@handle` pill at top-left, below the safe area (:326-330). **Not tappable** (`pointer-events-none`).
- Caption: 2-line clamp, 90 px above the bottom safe area (:332-336).
- Bottom gradient: `rgba(0,0,0,.55)` → transparent at 38% (:317).
- **No** right-side social rail, avatar, follow, like, comment, share or save [C].

### 3.8 Product bar (`product-bar.tsx`)

- Shows **only `products[activeIndex]`, and `activeIndex` is hard-coded to `0`** (`feed-shell.tsx:340`). Multi-product videos show the label "N items" (:86-88), with no carousel. `pinnedAtSecond` is never read in `src/components` (grep) [C].
- Card contents:
  - 40 px thumb: `images[0]` or a 🛍️ placeholder (:73-78).
  - Title (truncated).
  - Urgency line: only "Only N left" when `0 < inventory ≤ lowStockThreshold` (:15-20), otherwise "Tap to shop".
  - Price and struck compare-at price (:92-101). Money format drops `.00` (:6-7).
- Tap emits `{t:'product_tap', v, p, pos}` and opens the sheet (`feed-shell.tsx:342-345`).

### 3.9 Product sheet (`product-sheet.tsx`)

**Container**
- Modal dialog over a `black/55` scrim. Tapping the scrim or pressing Esc closes it (:159-165, :187-191).
- The video is held, not unloaded (shell :200-205).

**Detents**
- `peek` = 45dvh, `full` = 92dvh. Height animates over 280 ms (:183, :199-203).
- Drag: up more than 60 px goes to full. Down more than 90 px goes full→peek, or peek→close (:204-215).
- The grabber button toggles the detent (:217-221).

**Content**
- **Placeholder** art: a gradient with 🛍️. Product images are not shown (:224-232) [C → PARTIAL].
- Title, live unit price (base plus variant `priceDeltaCents`, :167-175), compare-at, "Only N left".
- **Variant chips:**
  - `role=radio`, minimum 44 px.
  - Out-of-stock options are struck through and disabled, never hidden (:251-287).
  - Single-live-option groups are preselected (:147-154).
  - Each pick emits `variant_select` (:271).
- **Quantity stepper:** from 1 to `inventoryCount` (:289-310). The server caps quantity at **10** (`api/checkout/intent/route.ts:14`), so quantities 11+ get a 400 [C/I].
- Full detent only: hardcoded shipping and returns copy (:312-317).

**Sticky CTA** (:322-344)
- "Sold out" / "Pick a {group}" / "Buy · $total".
- Footer: "Checkout by Stripe · no account needed".
- Tapping Buy emits `checkout_open` with `{selection, quantity}` (shell :375-389).

### 3.10 Checkout sheet (`checkout-sheet.tsx`)

**Container**
- Fixed 92dvh dialog at z-60, above the product sheet (:234-242).
- Close (✕) or scrim emits `checkout_abandon` with `step: 'quote' | 'payment'` (:211-221).

**Quote request**
- On open, it mints `idempotencyKey = uuid without dashes` (:175).
- `POST /api/checkout/intent {video_id, product_id, quantity, selection, idempotency_key}` (:179-190). No email is sent, so the server sets no `receipt_email` (`intent/route.ts:170`) [C]. The "receipt is on its way" copy (:266) may be false [I].

**States**

| State | What renders |
|---|---|
| Loading | Three pulse skeletons (:285-291) |
| Error | Message with "Back to the video". `sold_out` maps to dedicated copy (:194-198, :275-284) |
| Form | Stripe `Elements` (theme `flat`): collapsed summary line "1 item · $sub + $ship shipping = $total", expandable (:84-107). `PaymentElement` (accordion; wallets) and `AddressElement` (shipping, US only) on one scroll (:112-115) |
| Paid | In place: "Order confirmed" / "You got it." / "Keep watching". No route change (:256-274) |

**Pay**
- `stripe.confirmPayment({redirect:'if_required'})`.
- Card and validation errors show the Stripe message. Other errors: "Something went wrong on our side. You have not been charged." (:54-70).
- Success emits `purchase {intent, total}` (:71-76).

**Keep watching** closes both sheets and resumes the same frame (`feed-shell.tsx:395-400`).

**Native equivalent [I]:** Stripe iOS `PaymentSheet` with the same `/api/checkout/intent` client secret, and `AddressElement` replaced by `PaymentSheet.Configuration.shippingDetails` or `AddressViewController`.

### 3.11 Telemetry contract (`lib/events/client.ts`)

- Batches flush every 4 s or at 40 events. Payload: `{sid, sf, sent_at, e:[...]}` (:32-33, :111-141).
- `sendBeacon` is used on hide or pagehide (:92-99, :145-152). Otherwise `fetch` with `keepalive`.
- Session id:
  - Adopted from SSR (`adoptSessionId`, :56-63).
  - Else `sessionStorage['drip_sid']`.
  - Else a fresh uuid (:67-86).
- Full `EventType` union (:12-17) includes the unused `replay`, `add_to_cart`, `like/unlike`, `save/unsave`, `share`, `seller_profile_tap`, `follow/unfollow`, `not_interested`, `report`.

---

## 4. Components inventory

### `src/components/feed/*` and `src/hooks/*`

| Component | File | Kind | Used by | Status |
|---|---|---|---|---|
| FeedShell | `feed/feed-shell.tsx:15` | client | `/feed`, `/feed/demo`, `/search` | IMPLEMENTED (§3) |
| FeedVideo | `feed/feed-video.tsx:136` | client | FeedShell | IMPLEMENTED. Slide-0 poster gap [I] |
| playback-registry | `feed/playback-registry.ts` | types and `stageFor` | FeedShell | IMPLEMENTED |
| ProductBar | `feed/product-bar.tsx:22` | client | FeedShell | PARTIAL (first product only) |
| ProductSheet | `feed/product-sheet.tsx:126` | client | FeedShell | PARTIAL (no images, no description) |
| CheckoutSheet | `feed/checkout-sheet.tsx:152` | client | FeedShell | IMPLEMENTED |
| useSnapIndex | `hooks/use-snap-index.ts:21` | hook | FeedShell | IMPLEMENTED |
| AlgorithmPanel | `studio/algorithm-panel.tsx:172` | presentational | **nothing** (grep) | Built, deliberately unmounted (:33-40) |

### `src/components/landing/*`

All are mounted only on `/` (`src/app/page.tsx:1-12`). All are **MOCKED** from `landing/products.ts` (`PRODUCTS` :37-50, `CREATORS` :54-79) or hardcoded arrays. None fetches data (grep: no `fetch`) [C].

| Component | File | Interactivity | Notes |
|---|---|---|---|
| Nav / SearchField / SearchChips | `nav.tsx:82/17/57` | Sticky header via IntersectionObserver (:87-93). Mobile overlay locks body scroll (:95-100). Search → `/search` | **The only live behaviour on `/`** |
| HeroFeed | `hero-feed.tsx:109` | Drifting product columns, CSS only | Float cards "Saved to your list", "Price drop" are depictions (:147-180) |
| FeedPreview | `feed-preview.tsx:17` | Category filter chips (local state, :18-29) | 8 fixture cards |
| CategoryTiles | `category-tiles.tsx:14` | Links to `#feed` (:22) | 8 categories: sneakers…gifts |
| ForYou, Trending | `for-you.tsx:15`, `trending.tsx:6` | none | Fixture cards |
| ProductCard | `product-card.tsx:60` | Contains SaveButton; the card itself is **not a link** | Fake ratings and reviews (:110-114) |
| SaveButton | `save-button.tsx:5` | Local `useState` toggle only (:6, :15) | **MOCKED save**: no persistence, no event |
| Creators | `creators.tsx:3` | none | `CREATORS` fixtures |
| ShoppingList | `shopping-list.tsx:30` | "Move to cart" is a depiction (:90) | MOCKED list/cart |
| Campaign | `campaign.tsx:11` | Link to `#feed` (:61) | — |
| Activity | `activity.tsx:31` | CSS ticker of fake notifications (:4-29) | MOCKED notifications |
| Film | `film.tsx:5` | Click-to-play `/media/drip-launch.{webm,mp4}` (:6-14, :30-31) | Real asset in `public/media` |
| Reveal | `reveal.tsx:9` | IntersectionObserver scroll-in animations (:21) | — |

---

## 5. Design package (42 frames) vs web implementation

`docs/product-design/manifest.json:3` declares `frame_count: 42`. The first design commit `b1129f9` had 39 frames across 14 boards. `9e0aa04` added board 15 with frames 40–42 [C].

Board 14 ("The component language") has no frames. Nav decision: a 5-slot labeled dock **Home · Discover · Drop (center, coral) · Following · Profile**, with **Bag and Notifications in the top bar** (`docs/product-design/SPECIFICATION.md:41-51,55-57`) [C].

| # | Frame (manifest line) | Web equivalent | Status / evidence |
|---|---|---|---|
| 1 | For you (:29) | `/feed` FeedShell | IMPLEMENTED (no social rail, no Home header/tabs) |
| 2 | Product peek (:40) | ProductSheet `peek` | PARTIAL (no images) |
| 3 | Shop the frame (:51) | — | MISSING. `pinnedAtSecond` unused (grep) |
| 4–6 | Comments 25 / 60 / 90% (:70-92) | — | MISSING. No "comment" in `src` except code comments (grep); no table |
| 7–9 | Shop / Daily drop, The edit, Creator picks (:111-133) | landing sections only (MOCKED) | MISSING in app |
| 10 | Discover (:152) | — | MISSING. `/discover` is in the proxy matcher only (`proxy.ts:20`) |
| 11 | Fashion (category) (:163) | `GET /api/feed?surface=category&category=` exists (`api/feed/route.ts:21`) | MISSING UI (backend ready) |
| 12 | Search results (:174) | `/search` (videos only, feed format) | PARTIAL. No Products/Creators/Collections tabs, no filters |
| 13 | Product detail (:193) | ProductSheet full detent | PARTIAL |
| 14 | Seen on Drip (:204) | — | MISSING |
| 15 | Sizes and reviews (:215) | variant chips only | PARTIAL. No reviews data model (grep) |
| 16 | Creator storefront (:234) | legacy `/@handle/slug` is a single drop, not a storefront. `surface=seller_profile&seller=` exists | MISSING UI |
| 17 | Following (:245) | `follows` table + `surface=following` accepted | MISSING UI. `following` gets no surface-specific filtering in `slice.ts` (only `categorySlug`/`sellerHandle` filters, :105-106) [I] |
| 18 | Your profile (:256) | — | MISSING (buyers have no accounts; `orders.buyer_anon_id` exists, `00007…sql` ALTER at :440ff) |
| 19 | Saved (:275) | `viewer_video_reactions.saved_at` (`00008…sql:75-85`) | MISSING UI. Landing SaveButton is MOCKED |
| 20 | Notifications (:286) | landing Activity ticker | MISSING (MOCKED depiction) |
| 21 | Shopping bag (:297) | — | MISSING. No cart; `add_to_cart` is never emitted. Intent route is single-product (:14) |
| 22 | Quick checkout (:316) | CheckoutSheet | IMPLEMENTED |
| 23 | Delivery details (:327) | AddressElement inside CheckoutSheet | IMPLEMENTED (combined) |
| 24 | It's yours (:338) | CheckoutSheet paid state | IMPLEMENTED |
| 25 | Compare in the feed (:357) | — | MISSING |
| 26 | Collection carousel (:368) | — | MISSING (no collections model) |
| 27 | Creator mini-review (:379) | — | MISSING |
| 28 | New drop announcement (:398) | — | MISSING |
| 29 | Create a drop (:409) | `/dashboard/drops/new` | BROKEN for feed model (§0.3) |
| 30 | Save to a collection (:420) | — | MISSING |
| 31 | Shop loading (:439) | CheckoutSheet skeletons only | PARTIAL. The feed has no skeleton |
| 32 | Saved / empty (:450) | — | MISSING |
| 33 | Feed / connection error (:461) | — | MISSING. `fetchMore` swallows errors (`feed-shell.tsx:110-111`). SSR failure renders "Nothing here yet" |
| 34 | Payment declined (:480) | CheckoutSheet inline error (:117-121) | IMPLEMENTED |
| 35 | Variant unavailable (:491) | struck-through chips; `sold_out` error | IMPLEMENTED |
| 36 | Search / no matches (:502) | `/search` empty copy (:78-86) | PARTIAL (no suggestions; no network-vs-empty distinction) |
| 37 | Double-tap like (:521) | `like` event type only | MISSING UI (backend ingest exists) |
| 38 | Follow and mini-profile (:532) | `follow` event type only | MISSING UI (backend ingest exists) |
| 39 | Product scrub (:543) | — | MISSING |
| 40 | The living shelf (:571) | — | MISSING |
| 41 | Choose your shade (:582) | variant chips (text only) | PARTIAL (no swatches) |
| 42 | Make it yours (:593) | — | MISSING |

**Score:** about 6 frames are implemented, 9 partial, and 27 missing **[I, from the table]**.

---

## 6. Other confirmed defects to carry into the port plan

| # | Defect | Evidence |
|---|---|---|
| 1 | `/search` and `/api/search`, `/api/checkout/intent` are not in the proxy matcher, so cold deep links have no anon id | `proxy.ts:16-23`; `search/page.tsx:36` [C]. Consequence [I] |
| 2 | Landing CTA "Start Shopping" leads to seller signup ("Claim your handle") | `page.tsx:107`; `auth/signup/page.tsx` heading [C] |
| 3 | `Sign Out` on `/dashboard` does not navigate | `dashboard/page.tsx:86` [C] |
| 4 | `/dashboard` "ship-from" banner always shows (`profile.from_address` no longer on profiles) | `dashboard/page.tsx:93`; `00006…sql:173` [C] |
| 5 | Naive feed drops uncategorized videos (`categories!inner`), and nothing in the UI sets `category_id`. The ranked pool joins non-inner unless filtering | `lib/feed/slice.ts:88`; `lib/feed/pool.ts:189-191` [C] |
| 6 | `POST /api/session/link` (anon → user identity claim) has no caller | grep [C] |
| 7 | FeedShell `onCommit` cleanup (nudge timers) is discarded | `feed-shell.tsx:157-160` vs `use-snap-index.ts:25` [C] |

---

## 7. Native screen map (proposal)

**Design conflict to resolve first:** the requested tabs (Discover, Explore, Bag, Creator Studio, Profile) differ from the design spec (Home, Discover, **Drop**, Following, Profile; Bag and Notifications in the top bar; `SPECIFICATION.md:41-51`). The map below uses the requested tabs, noting the design equivalent of each.

| Native tab / screen | Design frames | Existing web screen to replicate | Backend today | Gaps to build |
|---|---|---|---|---|
| **Discover** (= design "Home"): `FeedView` (paging player) | 1, 2, 22–24, 34, 35, 37, 38 | `/feed` + FeedShell + ProductBar + ProductSheet + CheckoutSheet (§3) | `GET /api/feed`, `POST /api/events`, `POST /api/checkout/intent` + Stripe PaymentSheet; Stripe webhook `payment_intent.succeeded` (`webhooks/stripe/route.ts:411`) | Signed anon token for native (`x-drip-anon-token`, `src/lib/anon-request.ts:15`) and `POST /api/session/anon` (addressed in 8a1e20f). Reaction state is not in `FeedItem` (`lib/feed/types.ts:31-50`); a separate `GET /api/me/reactions` was added in 8a1e20f |
| └ `ProductSheetView` (detents .fraction(0.45)/.large) | 2, 13, 15, 41 | ProductSheet | data embedded in `FeedItem.products` | Images, description, reviews |
| └ `CheckoutSheetView` | 22–24, 34 | CheckoutSheet | `/api/checkout/intent` | Email or receipt; quantity cap of 10 |
| └ Social rail (like / save / share / follow) | 37, 38 | **none** | `/api/events` types `like/save/follow/share` → `viewer_video_reactions`, `follows` (`00008…sql:509-528`) | Read endpoint: `api/me/reactions` (addressed in 8a1e20f; not audited here) |
| **Explore** (= design "Discover"): `ExploreView`, `SearchResultsView`, `CategoryFeedView` | 10–12, 36 | `/search` (+ landing chips as suggestions, `nav.tsx:6`) | `GET /api/search`; `GET /api/feed?surface=category&category=` | A categories list endpoint (`categories` table, read directly at `studio/videos/[videoId]/page.tsx:222`); a products/creators search |
| **Bag** (design: top-bar utility) | 21 | **none** | none. Checkout is single-product (`intent/route.ts:14`) | Cart model + multi-item intent (`order_items` exists, `00007…sql:452`) |
| **Creator Studio** (design "Drop" + seller): `StudioHomeView`, `StudioVideosView`, `VideoReportView`, `MoneyView`, `CreateDropFlow` | 28, 29 | `/studio`, `/studio/videos`, `/studio/videos/[id]`, `/studio/money` (server-rendered, direct Supabase); create flow = `/dashboard/drops/new` | **No JSON API for Studio**. Pages query Supabase and Stripe server-side (`studio/page.tsx:169-400`, `money/page.tsx:304-592`). Create: `POST /api/drops` (drops model) | Studio JSON endpoints; a videos/products create + Mux upload path whose webhook writes `videos`; Stripe onboarding via `/api/stripe/onboarding/*` (reusable, opens in `SFSafariViewController`) |
| └ Seller settings | — | `/dashboard/settings`, `/dashboard/discounts`, `/dashboard/orders` | `/api/settings/address`, `/api/discounts`, `/api/orders/*` | Port only after the `drops` decommission is fixed |
| **Profile** (buyer): `ProfileView`, `SavedView`, `OrdersView`, `FollowingView` | 16–20, 32 | **none** (auth pages are seller-only) | Supabase Auth (`/auth/*`); `POST /api/session/link` (anon→user); `follows`, `viewer_video_reactions`, `orders.buyer_anon_id` | Buyer account model, saved/orders/following read APIs, notifications |
| Creator storefront (pushed from any tab) | 16, 38 | legacy `/@handle/slug` (single drop) | `GET /api/feed?surface=seller_profile&seller=` | Profile header endpoint (`profiles` is public-read) |
| Shared links / deep links | — | `/@handle/slug`; proxy reserves `/v/*` | — | Universal-link routes (`/v/:id` is MISSING) |

**Suggested build order for parity [I]:**
1. Discover feed, product sheet and checkout. These depend only on the three working new-model APIs.
2. Explore (search plus a category feed).
3. Social rail on the existing event ingest.
4. Studio read-only, after JSON endpoints exist.
5. Create flow, after the video/product upload pipeline exists.
6. Bag and Profile, which need new backend models.
