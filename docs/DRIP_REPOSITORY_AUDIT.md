# Drip — Repository Audit

**Branches audited:** `main` (`de84aa9`) and `astra-drip` (`9e0aa04`). The work branch `native-ios` was cut from `astra-drip`.
**Method:** five parallel code readers covered database, API and auth, commerce and media, screens, and design. Each read the actual source and migrations, not the README, and cited `path:line` for every claim. Their reports are reproduced in Parts A–E below. This summary and the "since the audit" section were written afterwards, and each claim in them was checked against the code.

**Labels used throughout**
- **Confirmed**: read in the cited file, or follows mechanically from the cited SQL or code.
- **Inferred**: depends on behaviour that was not executed (library, platform, PostgREST) or on production state the repo doesn't capture.
- **Proposed**: a recommendation, not a fact.

**Line numbers** in Parts A–E refer to commit `9e0aa04` (some sections say `8a1e20f`). Later commits on `native-ios` shift a few lines in the files they touch, listed in [Since the audit](#since-the-audit-what-native-ios-has-already-changed).

---

## Executive summary

### 1. Branches (Confirmed)
- **`astra-drip` vs `main`.** `astra-drip` is `main` plus two commits that only add `docs/product-design/**`: 39 + 3 app frames, boards, tokens and a review gallery. It is 0 commits behind `main`, and no application code differs. It is the correct base for `native-ios`, so the design package is available and the web app is untouched.
- **`claude/hello-cj48qg` is not merged.** It carries a backend ranking fix, `a796cc3` ("store the RAW running affinity state, normalise at read"), that the native feed would also benefit from, plus web landing-page work. The fix should reach `main` in its own PR. *Proposed.*

### 2. Production does not run the schema the code targets (Confirmed)
- **What production has.** The live Supabase project (`tkppdmrkvyjixaiocwmd`) has run only migrations `00001`, `00002` and five out-of-band migrations.
- **The chain is blocked.** `00006`–`00016` is marked **"NOT READY TO APPLY"** (`docs/production-migration/PREFLIGHT.md:3`).
- **The code is split across two schemas:**
  - The feed, search, events, checkout-intent and Studio code expects the post-chain content model (`videos`, `products`, `video_products`, `viewer_*`).
  - Drop creation, the Mux and EasyPost webhooks, restock, export, waitlist and report still use the legacy `drops` table, which `00007` deletes (`00007_feed_content_model.sql:570`).
- **Consequences:**
  - No purchase path works in production today.
  - After the chain is applied, no code path creates feed content: nothing inserts into `videos` or `products`.
  - New-seller onboarding breaks on a trigger permission (`00007:295-306`).

### 3. Live security exposure in production (Confirmed from the policy dump; grants Inferred)
- **Orders.** `orders_insert_for_seller` and `orders_seller_update_own` are still live. A seller can fabricate a `paid` order and use retry-label to buy a real label on the platform's EasyPost account.
- **Drops.** Drops have no status guard, so moderation can be skipped.
- **Seller payments.** `seller_payments_self_update` exists, so a seller may be able to set their own `charges_enabled` (Inferred: depends on grants).
- **Fix.** All of these are closed by `00006`, which is part of the blocked chain.

### 4. Feature status at a glance

| Area | Web status | Evidence |
|---|---|---|
| Vertical video feed (paging, autoplay, preload, product bar/sheet) | Implemented, but empty in production (schema) | DRIP_SCREEN_INVENTORY.md §3, Part A §0 |
| In-feed checkout (`/api/checkout/intent` + Stripe Payment Element) | Implemented, with defects: no email collected, shipping address only at confirm, double-decrement on webhook retry | Part D §0.2 |
| Legacy drop checkout (`/api/checkout`, Stripe Checkout) | Broken in both schemas | Part D §0.1 |
| Search | Implemented; identity bug fixed on `native-ios` | Part C §4.3 |
| Likes / saves / follows | Written as events; no read path, no UI on web; like/save clobber bug | Part A §0.5, Part C §3 |
| Comments | **Missing**: no table, no route | Part C §3 |
| Cart / bag (multi-item) | **Missing**: one product per PaymentIntent | Part D §1.7 |
| Following feed | Accepted and ignored by the API; fixed on `native-ios` | Part C §3 |
| Buyer order history | **Missing** | Part C §3 |
| Account deletion | **Missing** (required by App Store guideline 5.1.1(v)) | Part C §3 |
| Creator upload → feed | **Missing**: uploads create legacy `drops`; the Mux webhook never touches `videos` | Part A §0.3 |
| Studio analytics | Implemented UI over the post-chain schema | DRIP_SCREEN_INVENTORY.md |
| Stripe Connect onboarding | Implemented (Express, destination charges) | Part D §1.1 |
| Landing page | Mock data (`src/components/landing/products.ts`) | DRIP_SCREEN_INVENTORY.md §4 |
| Sales tax, refunds, disputes | **Missing** | Part D §0.2 |

### 5. Design system (Confirmed)
- **Web.** Bricolage Grotesque and Hanken Grotesk on a cream / ink / coral palette (`src/app/globals.css:15-56`).
- **Design package.** Instrument Serif + DM Sans, `tokens.json` (colours, spacing, radii, type scale, motion, contrast table), and a five-zone dock.
- **Canonical source for native.** `docs/product-design/tokens.json` and `SPECIFICATION.md` (Part B §4).

### 6. App Store payment compliance (Confirmed for what is sold; guideline reading Inferred)
- **Physical goods only.** Everything sold is a physical good shipped by its creator; there are no tips, subscriptions or digital content in the code.
- **No IAP required.** Guideline 3.1.3(e), "Goods and Services Outside of the App", applies, so in-app purchase is not required.
- **Native payment path.** Stripe PaymentSheet with Apple Pay against the existing server-priced PaymentIntent (Part D §5).

---

## Since the audit: what `native-ios` has already changed

All changes are backward-compatible with the web app, tested, and pushed on PR #14. The web test suite went from 866 to 961 passing tests, and the Swift suite has 102 tests.

| Change | Files | Evidence |
|---|---|---|
| `Authorization: Bearer <supabase JWT>` accepted by every user route; browsers unchanged | `src/lib/bearer.ts`, `src/lib/supabase-server.ts` | `native-identity.test.ts`: the pinned token is verified against `/auth/v1/user` |
| Signed viewer identity for cookie-less clients: `x-drip-anon-token` (same HMAC as the cookie) and `POST /api/session/anon` (10 per IP per hour) | `src/lib/anon-request.ts`, `src/app/api/session/anon/route.ts`, feed/search/events/intent/link routes | tests: forged and unsigned values rejected; fails closed without the secret |
| Proxy honours the signed header (no second mint) and now covers `/search` and `/api/search`, closing finding C-4.3(a) | `src/proxy.ts` | tests in `native-identity.test.ts` |
| `GET /api/me/reactions` and `GET /api/me/saved`: read-back of like/save/follow state | `src/app/api/me/*` | — |
| `surface=following` now filters to the viewer's follows (was ignored) | `src/lib/feed/slice.ts`, `ranked-slice.ts` | `ranked-slice.test.ts` |
| Feed cursor no longer skips one video per page (finding C-4.14) | `src/lib/feed/slice.ts` | `slice.test.ts` fails on the old code and passes on the new |
| Like no longer clears save, and vice versa (finding C-4.15 / A-0.5) | `supabase/migrations/00017_reactions_no_clobber.sql` | the function is re-created byte-for-byte except the reactions block; seven batch sequences executed against PostgreSQL 16 |
| The native client never emits a client-asserted `purchase` event (finding C-4.5) | `ios/DripKit/Sources/Commerce/CheckoutModel.swift` | Swift test |
| `/auth/callback` only redirects to same-site paths (finding C-4.2) | `src/lib/safe-redirect.ts`, `src/app/auth/callback/route.ts` | `security-fixes.test.ts`: `https://evil`, `//evil`, `/\evil`, control-character tricks all fall back |
| EasyPost webhook fails closed (503) when `EASYPOST_WEBHOOK_SECRET` is unset, and never verifies against an empty key (finding C-4.1) | `src/app/api/webhooks/easypost/route.ts`, `src/lib/easypost.ts` | `security-fixes.test.ts` |
| Account deletion: `DELETE /api/me` (cookie or Bearer) plus an in-app entry point. Sellers with buyer orders get a 409, because `orders.seller_id` cascades from `profiles` and deletion would destroy those orders | `src/lib/account-deletion.ts`, `src/app/api/me/route.ts`, `ios/DripKit/Sources/Profile/*` | `account-deletion.test.ts`; `AccountDeletionTests` (Swift) |
| Buyer order history: `GET /api/me/orders` (guest device + the account's linked devices; a device claimed by another account is excluded) | `src/lib/buyer-orders.ts`, `src/app/api/me/orders/route.ts`, Profile → Orders | `buyer-orders.test.ts`; `BuyerOrdersTests` (Swift) |
| Creator listings on the feed model: `POST /api/videos` (product + video + link + Mux upload, under the seller's own RLS). The Mux webhook publishes `video:<id>` passthroughs. It also now reads upload-error passthroughs from `new_asset_settings`; before this, upload failures never matched a drop | `src/lib/listings.ts`, `src/app/api/videos/route.ts`, `src/app/api/webhooks/mux/route.ts`, Studio | `listings.test.ts`, `videos-route.test.ts`; Swift `testCreateListingValidationMirrorsTheServerSchema` |
| Public catalog reads: `GET /api/categories`, `GET /api/creators/{handle}`; Explore category tiles and creator header counts | `src/lib/categories.ts`, `src/lib/creators.ts`, Explore, Creators | `catalog.test.ts`; Swift `CatalogTests` |
| Shareable video links: `/v/[videoId]`, `GET /api/videos/[id]`, the Apple association file; Share and deep/universal links in the app | `src/app/v/[videoId]`, `src/lib/feed/shared-video.ts`, AppRouter, RootView | `shared-links.test.ts`; Swift `ShareLinkTests`; `next build` |
| A second device no longer fails to link (finding A-0.6) | `supabase/migrations/00018_claim_second_device.sql` | PostgreSQL 16: reproduced 23505 on the 00010 function; passes with 00018, including two concurrent claims |

### Still open, and needing a decision or credentials (Proposed order)
1. **Production migration.** Apply the `00006`–`00018` chain to production once `PREFLIGHT.md`'s blockers (PITR, fresh snapshot) are cleared. This one step fixes the security holes in §3 and makes the feed real. **Owner decision; cannot be done from this session.**
2. ~~Videos-model creation endpoint~~ Done (`POST /api/videos` + Mux webhook). After the migration, the web composer must switch from `/api/drops` as well.
3. **Native checkout prerequisites.** Collect the buyer email (the native app already sends it), set the shipping address before confirm (the native app collects it via Stripe's address element), and make the stock decrement idempotent.
4. ~~Account deletion endpoint~~ Done (see above). Closing a seller account that has buyer orders is a support process.
5. **Comments** (table, RLS, routes) if comments are a launch feature.
6. **EasyPost webhook secret.** Must be set. The webhook now fails closed without it (503; EasyPost retries), so tracking updates stop rather than being forgeable (C-4.1).
7. ~~Auth callback open redirect~~ Fixed (C-4.2).

---


## Part A — Database, RLS, functions and migrations

_Scope: every file in `supabase/migrations/` (including `_abandoned_fork/`), `docs/production-migration/*`, `scripts/down/full_chain_down.sql`, and every `.from(`/`.rpc(` call in `src/`. "Post-chain" = 00001 → 00002 → 00006…00016; "production" = project `tkppdmrkvyjixaiocwmd`._

### 0. Headline findings (most important first)

1. **Production does not run the schema the code on `main` targets. The code is also incompatible with both schemas in different places.** (Confirmed.) PREFLIGHT says chain 00006–00016 is "NOT READY TO APPLY" (`docs/production-migration/PREFLIGHT.md:3`). Production has 5 tables (`PREFLIGHT.md:14-15`). The app still relies on legacy `drops` and on fork-only tables and columns that production never received (`variants`, `mux_upload_id`, `discount_codes`, `waitlist_entries`, `reports`). It also relies on feed tables that exist only post-chain. Details are in §6.
2. **Post-chain, new-seller onboarding breaks.** (Confirmed by SQL semantics.) The `profiles_ensure_trust` AFTER INSERT trigger calls `ensure_seller_trust()`, which is SECURITY INVOKER (`00007_feed_content_model.sql:295-306`). It inserts into `seller_trust`, but `authenticated` has only SELECT on that table (`00007:709-712`) and RLS has only a SELECT policy (`00007:707-708`). The browser's `profiles.insert` (`src/app/onboarding/page.tsx:57`) therefore fails with permission denied.
3. **Post-chain, there is no write path into `videos`, `products`, `video_products` or `shipping_profiles`.** (Confirmed.) No `.insert`, `.update` or `.upsert` on these tables exists anywhere in `src/` (I grepped all write calls). Uploads still create `drops` rows (`src/app/api/drops/route.ts:77-110`). The Mux webhook still updates `drops` and never checks the error (`src/app/api/webhooks/mux/route.ts:56-86`). After 00007 drops `drops` (`00007:570`), no new video can ever go live.
4. **Live production RLS holes.** These are the exact holes that 00006 was written to close. (Confirmed from the prod pg_policies dump; grants are Inferred.)
   - `orders_insert_for_seller` and `orders_seller_update_own` are still live (`prod-snapshot-2026-08-19.json:26`). A seller can fabricate a `paid` order and then press retry-label to buy a real label on the platform's EasyPost account (`src/app/api/orders/[id]/retry-label/route.ts:25-46`; rationale at `00006:538-543`).
   - `drops_seller_read_write_own` (ALL) has no status guard, so a seller can set `status='active'` and skip Mux moderation.
   - `seller_payments_self_update` exists in production (`prod-snapshot:27`). If `split_seller_pii` left Supabase's default grants in place, a seller can set their own `charges_enabled=true` or `stripe_account_id` (Inferred; grants were not captured, see `00006:495-496`).
5. **Several 00010 "fixes" are dead code.** (Confirmed.) `apply_video_reactions`, `stale_video_stat_ids` and `clamp_loop_count` are defined (`00010:24-31,113-173`) but never called:
   - `ingest_feed_events` still has the buggy upsert where a like clears a save (`00008:509-521`).
   - `rollup_video_stats` still sweeps only when `impressions_1h > 0` (`00009:147-150`).
   - Nothing in `src/` calls the new functions. The only `.rpc` calls are listed in §3.
6. **`claim_anon_identity` raises a unique-index error for an account's second device, and no client calls it.** (Confirmed.) `idx_viewer_identities_one_canonical` is UNIQUE(auth_user_id) WHERE canonical_anon_id = anon_id (`00008:26-28`). `claim_anon_identity` always leaves rows self-canonical (`00010:200-211`), so a second device for the same user hits 23505 and the route returns 500 (`src/app/api/session/link/route.ts:45-47`). Separately, nothing in `src/` calls `/api/session/link`.
7. **The down-migration's "lossless" claim is contradicted by the production snapshot.** (Confirmed.) The snapshot drop has `video_url` set and `weight_oz`/`dimensions` both NULL (`prod-snapshot:16`). The down script restores `video_url` as NULL and states "NULL in prod" (`scripts/down/full_chain_down.sql:26-27,165`). It also says the drop "has real values" for shipping (`:22-25`), but 00007 COALESCEs NULL shipping to 8 oz / 9x6x2 (`00007:352-355`). So both the PREFLIGHT claim "row identical minus updated_at" (`PREFLIGHT.md:115`) and the 00007 comment "NULL for every row in production" (`00007:502`) are false for the real row.

---

### 1. Table catalogue (post-chain unless stated)

#### Enums and CHECK vocabularies
- `video_status` = processing | live | paused | removed (`00007:4`). **Confirmed.**
- `product_status` = active | out_of_stock | archived (`00007:5`). A trigger forces active/out_of_stock from `inventory_count` unless the status is archived (`00007:110-124`). **Confirmed.**
- `trust_tier` = new | building | trusted | elite (`00007:6`).
- `candidate_lane` = affinity | trending | fresh | social | random, plus `chrono` (`00007:7`, `00010:40`).
- `feed_surface` = for_you | following | category | seller_profile | search | shared_link (`00007:8-10`).
- `feed_event_type`: 21 values (`00008:114-121`).
- **Order status** is TEXT + CHECK `orders_status_check`:
  - 00001: paid / label_created / shipped / delivered (`00001:44`).
  - 00006: adds `refunded` (`00006:250-252`).
  - 00007: pending / paid / label_created / shipped / delivered / canceled / refunded / disputed (`00007:433-436`). **Confirmed.**
- **Drop status** (legacy, the table is dropped in 00007):
  - 00001: active / archived (`00001:27`).
  - 00006: processing / active / rejected / archived, default `processing` (`00006:192-195`).
  - Production today is still active / archived (`00006:191`). **Confirmed.**
- `processed_events.provider` is one of stripe / mux / easypost (`00002:6`).
- `viewer_blocks.subject_type` is video / seller; `reason` is not_interested / report / admin (`00008:62-65`).
- `reports.reason` is prohibited_item / copyright / scam / other (`00006:289`).

#### Money representation
All money is stored as **integer cents**. There is **no currency column**: USD is hard-coded in Stripe calls (`src/app/api/checkout/intent/route.ts:151`, `src/app/api/checkout/route.ts:145,159`) and in balance filters (`src/app/api/dashboard/stats/route.ts:71`). **Confirmed.**

| Where | Columns | Citation |
|---|---|---|
| `products` | `price_cents`, `compare_at_price_cents` (int, 100..99,999,900; compare > price) | `00007:69-70,91-92` |
| `orders` (00001) | `amount_cents` = full charge including shipping; `shipping_cents` | `00001:42-43`, `00007:420-429` |
| `orders` (00007) | `subtotal_cents`, `tax_cents`, `total_cents`, `platform_fee_cents` (int ≥0, default 0) | `00007:405-408` |
| `order_items` | `unit_price_cents` | `00007:461` |
| `video_stats` | `gmv_cents_*` (bigint) | `00009:35-38` |
| `viewer_profiles` | `ltv_cents` (bigint) | `00008:45` |

- `tax_cents`, `refunded_at`, `disputed_at`, `idempotency_key`, `session_id`, `surface` and `buyer_viewer_id` are **never written** by `src/`. The grep shows only reads in `src/app/studio/money/page.tsx:102-135`. **Confirmed.**
- No webhook handles refunds or disputes. The Stripe handler covers only `account.updated`, `checkout.session.completed` and `payment_intent.succeeded` (`src/app/api/webhooks/stripe/route.ts:388-416`). Status therefore never becomes refunded or disputed except for an auto-refunded oversell, and GMV in `video_stats` and Studio money is overstated after any Stripe-side refund. **Confirmed** (the effect on reports is Inferred).

#### Tables

Legend: PK is the primary key, FK a foreign key, idx an index. Defaults are in brackets.

**Legacy and core tables**
- **profiles** (seller identity, 1:1 with `auth.users`). `00001:2-11`, columns trimmed by `split_seller_pii` / `00006:155-176`.
  - PK `id` uuid, FK → `auth.users` ON DELETE CASCADE.
  - `handle` text UNIQUE NOT NULL; CHECK `^[a-z0-9_]{3,30}$` and not a reserved word (`00006:476-481`).
  - `display_name` text NOT NULL, length 1–50 (`00006:482-483`).
  - `avatar_url` text; `created_at` / `updated_at` timestamptz [now()].
  - Trigger `profiles_updated_at` (`00001:130`) and `profiles_ensure_trust` (`00007:305`).
  - **Confirmed.** Production's live columns match the snapshot (`prod-snapshot:13`).
- **seller_payments** (seller PII and payout config). Created out-of-band; replayed at `00006:134-150`.
  - PK and FK `seller_id` → `profiles` CASCADE.
  - `stripe_account_id` text UNIQUE; `charges_enabled` bool NOT NULL [false]; `from_address` jsonb.
  - `created_at`, `updated_at`. idx `idx_seller_payments_stripe_account_id` (`00006:143`). Trigger `seller_payments_updated_at`.
  - **Confirmed.**
- **drops** (legacy listing; **dropped in 00007:570**). `00001:15-31`.
  - `id` uuid PK; `seller_id` FK → `profiles`; `title`, `slug` UNIQUE(seller_id, slug).
  - `price_cents` int ≥100; `inventory` int ≥0; `weight_oz` decimal; `dimensions` jsonb.
  - `mux_asset_id`, `mux_playback_id`, `status`.
  - Added by 00006: `video_url`, `image_url` (`00006:130-131`), `mux_upload_id`, `variants` (`00006:186-187`).
  - idx on seller_id and slug (`00001:53-54`).
  - **Confirmed.**
- **orders**. `00001:34-50` plus `00007:397-447`.
  - PK `id`; FK `seller_id` → `profiles` CASCADE.
  - `stripe_session_id` UNIQUE, nullable since `00007:418`.
  - `buyer_email` / `buyer_name` NOT NULL; `shipping_address` jsonb.
  - `amount_cents`, `shipping_cents` NOT NULL; `status` ['paid'].
  - `easypost_shipment_id`, `tracking_code` (partial UNIQUE, `00006:553`), `label_url`.
  - Added by 00007: `video_id` FK → `videos` SET NULL; `buyer_anon_id` uuid (no FK); `buyer_viewer_id` FK → `auth.users` SET NULL; `session_id`; `surface`; `idempotency_key` (partial UNIQUE); `stripe_payment_intent_id` (partial UNIQUE); the money columns above; `refunded_at` / `disputed_at`.
  - `drop_id` was dropped (`00007:495`).
  - Indexes `00001:55-58` (`idx_orders_drop_id` falls with the column) and `00007:438-447`.
  - **Confirmed.**
- **processed_events** (webhook idempotency). `00002:4-11`. Identity PK; `provider`; `event_id`; UNIQUE(provider, event_id). **Confirmed.**

**Tables added in 00006 (from the fork)**
- **discount_codes**. `00006:200-212`.
  - `id`; `seller_id` FK → `profiles`; `code`; `percent_off` 1–100; `stripe_coupon_id`; `active` [true].
  - UNIQUE(seller_id, code); idx on seller_id.
- **waitlist_entries**. `00006:256-270` then `00007:477-485`.
  - `id`; `product_id` NOT NULL FK → `products` CASCADE (`drop_id` was dropped); `seller_id` FK → `profiles`.
  - `email`, `name`, `notified_at`. UNIQUE(product_id, email).
- **reports**. `00006:286-296` then `00007:487-493`.
  - `id`; `video_id` NOT NULL FK → `videos` CASCADE; `product_id` FK → `products` SET NULL; `reporter_anon_id`.
  - `reason`, `details`, `reporter_email`, `resolved_at`.

**Feed and content tables (00007)**
- **categories**. `00007:12-39`.
  - uuid PK; `slug` UNIQUE with CHECK; `name`; `sort_order` [100]; `is_active` [true]; `live_video_count` [0].
  - Seeded with 12 rows. Partial idx on active categories.
- **shipping_profiles**. `00007:41-61`.
  - `seller_id` FK; `weight_oz` / `length_in` / `width_in` / `height_in` numeric, NOT NULL with ranges; `handling_days`; `is_default`.
  - UNIQUE(id, seller_id); one default per seller (partial unique).
- **products** (the sellable item). `00007:63-124`.
  - `seller_id` FK; `slug` UNIQUE per seller; `title` 1–100; `description` ≤2000.
  - Price columns as above; `inventory_count` [0] ≥0; `low_stock_threshold`.
  - `variants` jsonb array ≤40; `images` text[] ≤8.
  - `shipping_profile_id` with a composite FK (shipping_profile_id, seller_id) that enforces same seller; `category_id` FK SET NULL; `status`.
  - `search_vector` generated tsvector + GIN (`00015:33-39`).
  - Indexes at `00007:100-105`.
- **videos**. `00007:126-197`.
  - `seller_id` FK; `category_id`.
  - Mux fields: `mux_upload_id`; `mux_asset_id` and `mux_playback_id` UNIQUE; `duration_seconds` ≤600; `aspect_ratio`; `thumbnail_url`; `preview_gif_url`.
  - `caption` ≤500; `hashtags` ≤10, normalised by a trigger; `status`; `removed_reason`; `published_at`.
  - CHECK `videos_live_has_playback` (`00007:153-154`).
  - `caption_search` generated tsvector + GIN (`00015:41-44`).
  - Seven indexes (`00007:160-174`); `idx_videos_fresh` duplicates `idx_videos_live_published` exactly (`00007:160-161` vs `171-172`). **Confirmed.**
- **video_products**. `00007:235-272`.
  - PK (video_id, product_id). Composite FKs through `seller_id` enforce same-seller ownership.
  - `position` 0–4, unique per video; `pinned_at_second`.
  - Deferred constraint trigger caps a video at 5 products.
- **seller_trust**. `00007:274-309`.
  - PK and FK `seller_id`. Scores and rates with ranges; `strikes`; `trust_tier`.
  - Auto-created by trigger; idx on tier.
- **order_items**. `00007:452-472`.
  - `order_id` FK CASCADE; `product_id` and `video_id` SET NULL; `seller_id`.
  - Snapshots of title and variant; `unit_price_cents`; `quantity` 1–20.
  - Indexes on order and on (seller, created_at).

**Viewer and event tables (00008)**
- **viewer_identities**. `00008:1-30`.
  - PK `anon_id`; `canonical_anon_id` with a self-FK, DEFERRABLE; `auth_user_id` FK → `auth.users` SET NULL.
  - Seen timestamps; `issued_ip_hash` / `user_agent_hash` bytea; `events_seen`; `is_flagged`.
- **viewer_profiles**. `00008:32-56`.
  - PK and FK `anon_id` → `viewer_identities`.
  - Affinity jsonb maps (CHECK that each is an object); `price_band`; `interest_picks`; counters.
  - `cold_start_complete` generated as `scored_impressions >= 20`.
- **viewer_blocks**: PK (anon_id, subject_type, subject_id); `expires_at` (`00008:60-71`).
- **viewer_video_reactions**: PK (anon_id, video_id); `liked_at`, `saved_at`; `video_id` FK (`00008:75-86`).
- **follows**: PK (anon_id, seller_id); `seller_id` FK → `profiles` (`00008:91-97`).
- **feed_slices**: PK (session_id, video_id). `anon_id`, `lane`, `position`, `score`, `weights_id`. **No FK to videos** (`00008:99-112`).
- **feed_events**. `00008:130-176`.
  - Partitioned by month on `created_at`; PK (created_at, id). FK-free by design.
  - Indexes on video/type, anon, viewer, session, plus BRIN.
  - Monthly partitions plus `feed_events_default`.
- **feed_event_dedupe**: UNLOGGED; PK `dedupe_key` (`00008:254-259`).
- **viewer_video_counters**: PK (anon_id, video_id); per-class capped counters (`00008:285-297`).

**Derived and config tables**
- **video_stats** (`00009:1-111`; `avg_loop_count` widened at `00010:18-19`).
  - PK and FK `video_id`. About 50 window counters. Generated 24h rates and `velocity_1h`. Four indexes.
- **rollup_state**: PK `job_name`; watermark (`00009:113-121`).
- **feed_weights** (`00009:361-423`).
  - `variant` UNIQUE; `is_active`; `traffic_share`; weights and lane shares with sum CHECKs.
  - Seeded with `control` (00009:415) and `ranked_v2` at a traffic share of 0 (`00014:42-54`).
- **category_rate_medians** (`00013:44-76`).
  - Nullable `category_id` FK. Nine numeric rates; `sample_size`.
  - Two partial unique indexes (per category, plus one global row).

---

### 2. RLS and grants

**Background.**
- Supabase grants ALL on new tables in `public` to anon/authenticated by default. 00008 revokes that default for tables created **after** it (`00008:608-609,618`). Tables created earlier (`processed_events`, `discount_codes`, `waitlist_entries`, `reports`) still carry table-level ALL for anon/authenticated and rely on RLS alone. That last point is **Inferred**: it depends on Supabase defaults.
- Policies with no `TO` clause apply to role `public`.

| Table | RLS | Policies (cmd, role, USING / CHECK) | Column grants | Assessment |
|---|---|---|---|---|
| profiles | on (`00001:61`) | `profiles_self_read` SELECT public `auth.uid()=id` (`00001:66`); `profiles_self_update` UPDATE public USING `auth.uid()=id`, no WITH CHECK (`00001:69`); `profiles_insert` INSERT public CHECK `auth.uid()=id` (`00001:72`); `profiles_public_read_handle` SELECT **anon** `true` (`00006:442-443`). Both the prod name `profiles_public_read` and the repo name are dropped (`00006:440-441`). | anon: SELECT(id, handle, display_name, avatar_url) (`00006:457-458`). authenticated: SELECT all, INSERT(id, handle, display_name, avatar_url), UPDATE(display_name, avatar_url) (`00006:464-467`). | OK. Signed-in users **cannot** read other sellers' profiles (the public policy is anon-only). |
| seller_payments | on (`00006:498`) | none; the 3 prod self policies are dropped (`00006:508-510`) | REVOKE ALL anon/auth (`00006:501`) | Service-role only. The code still reads it with user clients in 3 places (§6). |
| drops (legacy) | on | `drops_seller_read_write_own` ALL public (`00001:79`); `drops_public_read_active` SELECT anon `status='active'` (`00006:563`) | anon SELECT of 12 columns (`00006:571-573`); authenticated SELECT/INSERT/DELETE plus UPDATE of a column list (`00006:578-581`); guard trigger (`00006:589-612`) | Dropped in 00007. |
| orders | on | `orders_seller_read_own` SELECT public `auth.uid()=seller_id` (`00001:86`). Insert and update policies dropped (`00006:545-546`). | REVOKE ALL; authenticated SELECT (`00006:548-549`) | Sellers read buyer PII (email, name, address, `buyer_anon_id`) for their own orders. This is intentional for fulfilment. Buyers have no read path. |
| order_items | on | `order_items_seller_read_own` SELECT authenticated (`00007:715`) | authenticated SELECT (`00007:717-718`) | OK |
| processed_events | on (`00002:14`) | none | default grants (Inferred) | Deny via RLS. Sequence revoked (`00008:616`). |
| discount_codes | on | `discount_codes_seller_all` ALL public, owner (`00006:217-218`) | default ALL (Inferred) | Seller can write `stripe_coupon_id` / `percent_off` directly and bypass `/api/discounts` (`src/app/api/discounts/route.ts:56-72`). Low impact; should be column-restricted. |
| waitlist_entries | on | `waitlist_seller_read` SELECT public owner (`00006:277-278`) | default ALL (Inferred) | OK (no insert policy) |
| reports | on | none (`00006:300`) | default ALL (Inferred) | Deny |
| categories | on | `categories_public_read` SELECT anon, authenticated `is_active` (`00007:602-603`) | SELECT(id, slug, name, sort_order) (`00007:604-605`) | OK |
| shipping_profiles | on | `shipping_profiles_owner_all` ALL authenticated owner (`00007:611-613`) | authenticated SELECT/INSERT/DELETE plus UPDATE of 7 columns (`00007:614-617`) | OK |
| products | on | `products_public_read_sellable` SELECT **anon** `status<>'archived' AND seller_charges_enabled(seller_id)` (`00007:637-641`); `products_owner_all` ALL authenticated owner (`00007:642-644`) | anon SELECT of 13 columns (`00007:646-650`); authenticated SELECT/INSERT/DELETE plus UPDATE of a list (`00007:653-658`) | Authenticated users **cannot** read other sellers' products. |
| videos | on | `videos_public_read_live` SELECT **anon** `status='live'` (`00007:663-664`); `videos_owner_all` ALL authenticated (`00007:665-667`) | anon SELECT of 12 columns (`00007:669-673`); authenticated SELECT/INSERT/DELETE plus UPDATE(category_id, caption, hashtags, thumbnail_url, status) (`00007:677-680`) | Guard pins status, published_at and the Mux ids on UPDATE (`00007:199-233`). The INSERT branch does **not** reset `mux_*` ids (`00007:206-211`). `thumbnail_url` is seller-writable and publicly served, so it is unmoderated (Confirmed). |
| video_products | on | `video_products_public_read` SELECT **anon**, EXISTS live video (`00007:685-689`); `video_products_owner_all` ALL authenticated (`00007:690-692`) | anon SELECT of 4 columns; authenticated SELECT/INSERT/DELETE plus UPDATE(position, pinned_at_second) (`00007:693-698`) | OK |
| seller_trust | on | `seller_trust_public_read` SELECT anon, authenticated `true` (`00007:707-708`) | SELECT of 6 columns (`00007:709-712`) | OK. **No INSERT grant breaks the trigger** (§0.2). |
| viewer_identities, viewer_profiles, viewer_blocks, viewer_video_reactions, follows, feed_slices, feed_events, feed_event_dedupe, viewer_video_counters | on (`00008:589-597`) | none | REVOKE ALL from PUBLIC/anon/auth (`00008:599-603`). Partitions are revoked and get FORCE RLS (`00008:197-199,225-226`). | Service-role only |
| video_stats | on (`00009:426`) | `video_stats_public_read` SELECT anon, authenticated, EXISTS live video (`00009:437-441`) | SELECT(video_id, likes_all, purchases_7d, purchases_all) (`00009:442-444`) | OK |
| feed_weights, rollup_state | on | none | REVOKE ALL (`00009:429-430`) | Service-role only |
| category_rate_medians | on (`00013:218`) | none | REVOKE ALL; service_role CRUD (`00013:220-221`) | Service-role only |

**Overly permissive or flagged.**
- **Production today** (pre-chain policy dump at `prod-snapshot:24-27`):
  - `profiles_public_read` SELECT {public} USING true, combined with default ALL grants.
  - `drops_seller_read_write_own` FOR ALL with no status guard.
  - `orders_insert_for_seller` and `orders_seller_update_own`.
  - Three `seller_payments_self_*` policies.
  - These are the holes 00006 closes, and they are **still open in production**. Confirmed for the policies; grants are Inferred.
- No table in either schema has RLS **disabled**. **Confirmed**: every `CREATE TABLE` is followed by `ENABLE ROW LEVEL SECURITY`.

#### What a mobile client can do directly with the anon key and a user JWT (role `authenticated`), post-chain

**Safe to READ directly**
- `categories` (4 columns).
- `seller_trust` (6 columns).
- `video_stats` (4 columns, live videos only).
- Own `profiles` row (all columns).
- Seller-own rows of `products`, `videos`, `video_products`, `shipping_profiles`, `orders`, `order_items`, `discount_codes`, `waitlist_entries`.
- `rpc('seller_charges_enabled')` (`00006:404-406`).

**Cannot READ with a user JWT**
- Other sellers' `profiles`, live `videos`, sellable `products`, `video_products`. Those policies are scoped `TO anon` (`00006:442`, `00007:638,664,686`).
- A client must either query them **without** the user JWT (pure anon) or go through `/api/feed`, `/api/search` and the storefront pages. All of these use the service role (`src/app/api/feed/route.ts:62`, `src/app/api/search/route.ts:56`).

**Safe to WRITE directly**
- `profiles` UPDATE(display_name, avatar_url).
- `shipping_profiles` (own rows).
- `products` (own rows, listed columns; `seller_id` is not updatable).
- `video_products` (own rows; position and pin only).
- `videos`: caption, hashtags, category, thumbnail; status live↔paused only. `thumbnail_url` is unmoderated.
- `discount_codes` is technically writable, but should go through `/api/discounts` because `stripe_coupon_id` must come from Stripe.

**Must go through server routes**
- `profiles` INSERT: broken post-chain because of the trigger, so it needs a server route or a fix.
- Everything in `seller_payments` (`/api/settings/address`, `/api/stripe/onboarding/*`).
- All `orders` and `order_items` writes (webhooks).
- `processed_events`, `reports` (`/api/report`), `waitlist_entries` inserts (`/api/waitlist`).
- Every viewer, feed or event table, and every RPC except `seller_charges_enabled`:
  - `ingest_feed_events` (`00008:541-544`)
  - `claim_anon_identity` (`00010:219-220`)
  - `search_feed_videos` (`00015:126-129`)
  - `decrement_product_inventory` (`00010:96-99`)
  - all of these are service_role only.
- Checkout (`/api/checkout/intent`).

**Inferred caveat for mobile.** Viewer identity is the HttpOnly signed cookie `drip_aid`. `/api/events` and `/api/checkout/intent` return 401/400 without it (`src/app/api/events/route.ts:72-76`, `src/app/api/checkout/intent/route.ts:35-39`). The proxy mints it only on matched routes (`src/proxy.ts:15-24`, matcher at :16). A native client must persist that cookie; there is no header or JWT alternative.

---

### 3. Functions, RPCs, triggers, views, cron

**SECURITY DEFINER functions** (all have `search_path` pinned)

| Function | Grant | Citation |
|---|---|---|
| `seller_charges_enabled(uuid)` | anon, authenticated, service_role. Intended: discloses one boolean per seller. | `00006:388-406` |
| `ingest_feed_events(uuid, uuid, feed_surface, jsonb)` | service_role | `00008:349-544` |
| `link_anon_identity` | DROPPED | `00008:546-587`, dropped `00011:21` |
| `rollup_video_stats()` | revoked from anon by the 00010 loop | `00009:123-351`, `00010:47-65` |
| `refresh_category_counts()` | service_role | `00009:353`, replaced `00010:237-258` |
| `refresh_category_rate_medians(int, int)` | service_role | `00013:106-226` |
| `search_feed_videos(text, text, text, int, uuid[])` | service_role | `00015:54-129` |

**Confirmed.** `rollup_video_stats` was anon-executable between 00009 and 00010. That window is harmless in a single-transaction apply.

**SECURITY INVOKER functions**
- With explicit service_role grants:
  - `decrement_product_inventory` (`00007:574-591`; negative-quantity guard at `00010:73-99`)
  - `clamp_loop_count`, `apply_video_reactions`, `stale_video_stat_ids`, `claim_anon_identity` (`00010`)
- With **no revoke**, so EXECUTE stays granted to PUBLIC:
  - `create_feed_events_partition`, `ensure_feed_events_partitions`, `drop_old_feed_events_partitions`, `sweep_feed_event_dedupe` (`00008:178-276`)
  - `feed_event_dedupe_key`, `feed_event_cap_class` (`00008:301-347`)
  - `update_updated_at_column` (`00001:122`, not search_path-pinned)
- The 00010 revoke loop filters on `p.prosecdef` (`00010:55`), so the invoker maintenance functions it names are skipped. **Confirmed.**
- They are reachable via `/rest/v1/rpc`, but as invoker they should fail on table permissions or ownership. **Inferred low risk**: a hygiene gap.

**Triggers.** `updated_at` triggers on:
- profiles, drops, orders (`00001:130-143`)
- seller_payments (`00006:147`)
- shipping_profiles, products, videos (`00007:60,107,176`)
- feed_weights (`00009:411`)

Other triggers:
- `drops_guard_status` (`00006:610`, dropped `00007:498`)
- `products_sync_stock_status` (`00007:122`)
- `videos_normalize_hashtags` (`00007:195`)
- `videos_guard_status` (`00007:231`)
- constraint trigger `video_products_max_five` (`00007:269`)
- `profiles_ensure_trust` (`00007:305`), which is the broken one (§0.2)

**Views and materialized views.** None in the repo. Production's `public_profiles_view` was never captured (`00006:101-105`). The snapshot reports "views: none exist" (`prod-snapshot:30`), so it was presumably removed. That is Inferred; nothing in the repo explains it.

**pg_cron** (`00016:28-69`)
- Guarded by `pg_available_extensions`, and re-runnable through unschedule-by-name.
- Jobs:

| Job | Schedule | Calls |
|---|---|---|
| `video-stats-rollup` | `* * * * *` | `rollup_video_stats()` |
| `feed-dedupe-sweep` | `*/5` | sweep |
| `category-counts` | `*/10` | refresh counts |
| `feed-events-partitions` | `0 3 1 * *` | ensure 3 months |
| `feed-events-retention` | `30 3 1 * *` | drop partitions older than 6 months |
| `viewer-counters-prune` | weekly | inline DELETE of rows older than 180 days |
| `category-rate-medians` | `23 * * * *` | refresh medians |

- If pg_cron is unavailable, the guard raises only a NOTICE. Partitions would then stop being created after 3 months and events fall into `feed_events_default`. **Confirmed.**

**RPCs the app calls.** All use the admin client. **Confirmed.**

| RPC | Called at |
|---|---|
| `ingest_feed_events` | `src/app/api/events/route.ts:105` |
| `claim_anon_identity` | `src/app/api/session/link/route.ts:42` |
| `decrement_product_inventory` | `src/app/api/webhooks/stripe/route.ts:77,286` |
| `decrement_inventory` (legacy fallback) | `src/app/api/webhooks/stripe/route.ts:86` |
| `search_feed_videos` | `src/lib/search/slice.ts:97` |

---

### 4. Identity model

**Sellers**
- A seller is an `auth.users` row plus a `profiles` row with the same `id` (`00001:2-3`). It is created by the browser insert in onboarding (`src/app/onboarding/page.tsx:57-61`).
- Payout and PII data sit 1:1 in `seller_payments` (`00006:134-141`), written only by the service role (`src/app/api/stripe/onboarding/start/route.ts:85-86`, `src/app/api/settings/address/route.ts:45-47`).
- Trust data sits 1:1 in `seller_trust` (`00007:274-309`).
- There is no `creators` or `sellers` table: "seller" means "has a profile". **Confirmed.**

**Buyers and viewers have no accounts** (`00006:540`, `00007:393`).
- Identity is a random UUID `anon_id`, minted by the proxy as the HMAC-signed HttpOnly cookie `drip_aid`, `v1.<uuid>.<sig>` (`src/lib/anon-id.ts:3,63-71`, `src/proxy.ts:47-68`).
- It is verified with `timingSafeEqual` (`src/lib/anon-id.ts:89-104`).
- With no `ANON_ID_SECRET`, nothing is minted or trusted (`src/lib/anon-id.ts:25-29`).
- Server-side, an anon id becomes a `viewer_identities` row when it is first ingested (`00008:371-373`).
- All viewer state is keyed on `anon_id`: profiles, blocks, reactions, follows, slices, events, counters.
- The IP is stored only as `sha256(ip‖secret)` (`src/lib/anon-id.ts:114-121`, `src/app/api/events/route.ts:133-139`). **Confirmed.**
  - **Inferred:** a Node `Buffer` passed through supabase-js is serialised as JSON `{type, data}`, not as bytea hex, so this write may fail or store garbage. Not run.

**Account linking**
- 00008 designed a multi-device merge through `canonical_anon_id` (`00008:3-5,546-587`).
- 00010 replaced it with `claim_anon_identity`, which has no aliasing and refuses an identity that another user already owns (`00010:185-217`). 00011 dropped the old function.
- The `canonical_anon_id` machinery is now vestigial.
- The unique index makes a second device for the same user fail (§0.6).
- **Nothing in `src/` calls `/api/session/link`**, so no viewer is ever linked. `feed_events.viewer_id` and `orders.buyer_viewer_id` stay NULL. **Confirmed** by grep.

**Guest checkout is the only checkout.**
- Legacy path: a Stripe Checkout Session (`src/app/api/checkout/route.ts`), service role, no auth.
- Feed path: a PaymentIntent that needs only the anon cookie (`src/app/api/checkout/intent/route.ts:35-39`). The anon id is stored in metadata and then in `orders.buyer_anon_id` (`src/app/api/webhooks/stripe/route.ts:319`).
- Buyers are identified by `buyer_email` / `buyer_name` / `shipping_address` captured from Stripe.
- No RLS policy lets a buyer read their own order. **Confirmed.**

---

### 5. Migration numbering, production drift, risk

**Numbering**
- Present: 00001, 00002, 00006–00011, 00013–00016. **Confirmed** by `ls`.
- **00003–00005** and a *different* **00006_lock_down_rls** live in `_abandoned_fork/`.
- Why they are abandoned (`_abandoned_fork/README.md:1-22`, `00006:10-29`):
  - They were written in June 2026 and never applied to production.
  - Production instead ran five out-of-band migrations: `mvp_storefront_and_security`, `checkout_drop_info_fn`, `public_profiles_view`, `split_seller_pii`, `drop_checkout_drop_info_fn` (`00006:31-38`).
  - Applying the fork in filename order commits 00003–00005 against production's shape. It then fails at fork-00006, which references the removed `profiles.from_address` (`_abandoned_fork/00006_lock_down_rls.sql:35`).
- **00012** is missing because the reconcile migration was "formerly 00012" and was renumbered to 00006 so that filename order is apply order (`00006:2,23-26`).
- So the number "00006" names two different files in history.
- There is no `supabase/config.toml`. **Confirmed.**

**Production vs repo** (`PREFLIGHT.md`, snapshot)
- Production is Postgres 17.6. The verification replica was PG16, an acknowledged fidelity gap (`PREFLIGHT.md:7-11`).
- Production has only `profiles`, `drops`, `orders`, `seller_payments` and `processed_events`, with demo data only: 1 user, 1 profile, 1 drop, 1 `seller_payments` row (`PREFLIGHT.md:13-20`, `prod-snapshot:7`).
- **Pending:** the whole chain 00006–00016 (`PREFLIGHT.md:3,174-176`).
- **Open blockers:** PITR is unconfirmed and the T-0 snapshot has not been re-taken (`PREFLIGHT.md:244-252`).
- Production's `schema_migrations` uses timestamp versions, so `supabase db push` will not work against it (`README.md:50-54`). After a manual psql apply, the history table still won't record 00006–00016 (Inferred). Tooling drift will therefore persist unless someone runs `supabase migration repair`.
- **Conflicting apply guidance:**
  - README says one file per transaction (`README.md:53-54`).
  - PREFLIGHT recommends one psql `--single-transaction` for the whole chain (`PREFLIGHT.md:174-179`).
  - `SETUP.md:23,108,180` still says to run `supabase/migrations/00003…00005`, which no longer exist there. **Confirmed.**
- **Unknowns the reconcile cannot see:**
  - grants left by `split_seller_pii` (`00006:495-496`)
  - any extra RLS from `mvp_storefront_and_security` (`00006:106-111`)
  - The policy dump (`prod-snapshot:23-28`) partly closes this gap. It captured policies but not table or column ACLs.
- **The down-migration does not reproduce the real production row.**
  - `video_url` comes back NULL (`full_chain_down.sql:165`) versus a real URL in the snapshot (`prod-snapshot:16`).
  - NULL weight and dimensions come back as 8 oz / 9x6x2 (`00007:352-355` vs `prod-snapshot:16`).
  - So the replica the down was verified against did not match production data (Inferred), and PREFLIGHT's "row identical" claim is unproven for prod.
  - `PREFLIGHT.md:51` also says "all 3 of them" public tables, against 5 at `:14`.

**Risk summary**
- Data-loss risk is near zero, because production holds only demo data.
- Operational risk is high:
  - The deployed code and production schema disagree today (§6).
  - Applying the chain flips a different set of features into breakage at COMMIT: the legacy storefront, uploads, the Mux webhook, onboarding and dashboards.
  - Production also runs with known-open RLS holes until the chain lands.

---

### 6. Broken or inconsistent: code vs schema (verified by grep)

#### Works in neither, or broken in production today (pre-chain)
- Production `drops` has no `variants` or `mux_upload_id`, and its status CHECK is active/archived (`prod-snapshot:16`, `00006:183-195`). So in production:
  - The storefront select includes `variants` (`src/app/[handle]/[slug]/page.tsx:28`), so it errors and returns 404.
  - Legacy checkout selects `variants` (`src/app/api/checkout/route.ts:36`).
  - Drop creation inserts `variants` and `status:'processing'` (`src/app/api/drops/route.ts:88-89`). The Mux webhook writes `rejected` (`src/app/api/webhooks/mux/route.ts:58,83`).
  - **Confirmed** schema mismatch; PostgREST errors Inferred.
- `discount_codes`, `waitlist_entries` and `reports` do not exist in production (`PREFLIGHT.md:14-15`). So `/api/discounts`, the discount lookup in `/api/checkout` (`:103`), `/api/waitlist` (`:42`) and `/api/report` (`:37`) fail there. **Confirmed.**
- `/studio`, `/feed`, `/api/feed`, `/api/events`, `/api/search` and `/api/checkout/intent` need post-chain tables.

#### Breaks once the chain is applied (post-chain)
- `drops` no longer exists, but is still read or written by:
  - `src/app/[handle]/[slug]/page.tsx:27`, `src/app/[handle]/[slug]/thanks/page.tsx:24`
  - `src/app/api/checkout/route.ts:35`
  - `src/app/api/waitlist/route.ts:33`, `src/app/api/report/route.ts:28`
  - `src/app/api/drops/route.ts:66-119`, `src/app/api/drops/[id]/restock/route.ts:36-49`
  - `src/app/api/dashboard/stats/route.ts:30`
  - `src/app/api/webhooks/mux/route.ts:57-82` (errors unchecked, so updates are silently lost)
  - `src/app/api/webhooks/easypost/route.ts:67`
  - `src/app/dashboard/drops/page.tsx:56,86`
  - `src/app/studio/videos/[videoId]/page.tsx:348` (wrapped in `safe`)
  - **Confirmed.**
- `orders.drop_id` and the `drops(...)` embed are gone, but still used by:
  - The EasyPost webhook selects `drop_id` (`src/app/api/webhooks/easypost/route.ts:58`). The error is ignored, so `order` is null and shipped/delivered transitions are silently dropped while the event is still marked processed.
  - The dashboard orders page embeds `drops(title)` (`src/app/dashboard/orders/page.tsx:61`).
  - The orders CSV export embeds `drops(title, slug)` (`src/app/api/orders/export/route.ts:24`) and returns 500.
  - The stats route selects `drop_id` (`src/app/api/dashboard/stats/route.ts:27`).
  - `fulfillment.ts`, `src/app/api/webhooks/stripe/route.ts` and `src/app/studio/money/page.tsx` handle both schemas. **Confirmed.**
- Old column names on the 00007-repointed tables:
  - `waitlist_entries` inserts `drop_id` (`src/app/api/waitlist/route.ts:43`; the column was dropped at `00007:480-482`).
  - The restock route filters `.eq('drop_id')` (`src/app/api/drops/[id]/restock/route.ts:73`).
  - `reports` inserts `drop_id` (`src/app/api/report/route.ts:38`; dropped at `00007:492`).
  - **Confirmed.**
- `seller_payments` read with **user** clients, which is permission denied post-chain (`00006:501`):
  - `src/app/dashboard/settings/page.tsx:41-45` (the browser client shows an empty address)
  - `src/app/api/dashboard/stats/route.ts:20-24` (payout balance shows 0)
  - `src/app/api/drops/route.ts:24-28` (always 403 "complete onboarding")
  - Studio already switched to admin (`src/app/studio/page.tsx:185-215`). **Confirmed.**
- Onboarding profile insert fails because of the `seller_trust` trigger (§0.2). **Confirmed.**
- No content-creation path (§0.3). The only videos and products that will ever exist are the 00007 backfill. In production that is the single demo drop, demoted to `processing` (`00006:335-338`), so the post-chain feed is **empty**. **Confirmed.**

#### Logic and schema inconsistencies
- 00010 fixes are not wired in (§0.5): `ingest_feed_events` still clears the save on a like, and the rollup staleness gate is unchanged. **Confirmed.**
- `claim_anon_identity` hits the unique index on a second device, and no client calls it (§0.6). **Confirmed.**
- Feed queries:
  - `src/lib/feed/slice.ts:88` uses `categories!inner` unconditionally. That drops every uncategorised video from the naive feed, and nothing in `src/` ever sets `videos.category_id`. **Confirmed.**
  - `src/lib/feed/pool.ts:205` embeds `seller_trust` from `videos`, but no FK connects the two (they both FK to `profiles`).
  - `src/lib/feed/ranked-slice.ts:115` embeds `videos` from `feed_slices`, which has no FK (`00008:99-109`).
  - **Inferred:** PostgREST cannot resolve either relationship. The pool query would throw (`pool.ts:221`), and the ranked-slice error is swallowed, so session dedupe context is lost.
- `00007:502` claims `drops.video_url` is NULL in production, but the snapshot shows a URL (`prod-snapshot:16`). The 00007 DO block will WARN and discard it (`00007:507-523`). **Confirmed.**
- Duplicate index `idx_videos_fresh` = `idx_videos_live_published` (`00007:160-161,171-172`). **Confirmed.**
- Variant JSON shape differs:
  - The products comment says `[{id, name, options, price_delta_cents, …}]` (`00007:73`).
  - The intent route reads `options[].price_delta_cents` (`src/app/api/checkout/intent/route.ts:110-118`).
  - Backfilled legacy variants are `{name, options:[string]}` (`_abandoned_fork/00003…:11-12`).
  - **Confirmed** mismatch; impact is low.


## Part B — Branches and design system

_The SwiftUI mapping that followed from this part is implemented and documented in DRIP_NATIVE_ARCHITECTURE.md §DesignSystem._

### 1. Branch comparison

#### 1.1 Topology (Confirmed)

| Ref | SHA | Relation to `origin/main` |
| --- | --- | --- |
| `origin/main` | `de84aa9` (2026-08-19, "Merge pull request #12 from pixelbuyte/claude/hello-cj48qg") | base |
| `origin/astra-drip` | `9e0aa04` | 2 ahead, 0 behind (`git rev-list --left-right --count` = `0 2`) |
| `native-ios` (HEAD) | `9e0aa04` | same commit as `origin/astra-drip`; "up to date with 'origin/astra-drip'", clean tree |
| `origin/claude/hello-cj48qg` | `419d69d` | 4 ahead, 0 behind; merge-base = `de84aa9` (main tip) |

`git branch -r --merged origin/main` lists only `origin/main`. **`origin/claude/hello-cj48qg` is NOT merged.** Its older commits reached main through PR #11/#12, but these 4 newer commits have not:

| Commit | Date | Subject | Area |
| --- | --- | --- | --- |
| `a796cc3` | 2026-08-20 | Fix affinity persistence: store the RAW running state, normalise at read | **backend/ranking**: `src/lib/feed/affinity-update.ts`, `src/lib/feed/viewer-context.ts` + 2 tests |
| `64c4679` | 2026-09-06 | Redesign the landing page: sticker illustration system, real phone hero | web landing |
| `6536474` | 2026-09-06 | Add the landing image assets cut from the founder's reference visuals | `public/landing/*.webp` |
| `419d69d` | 2026-09-06 | Rebuild the landing page around the founder's section artwork | web landing |

hello-cj48qg vs main diff: 47 files, +1178/−1142 lines. Of the two design-system files, `src/app/globals.css` changes **only a comment**. The comment says the `hand` face (Caveat 600) from "TOKENS.md" was left out on purpose. **TOKENS.md does not exist on any branch** (`git log --all -- '*TOKENS.md'` returns nothing). In `src/app/layout.tsx` only the metadata copy and a comment wrap change. The fonts are still Bricolage + Hanken. Token values are identical to main.

#### 1.2 astra-drip commits (Confirmed)

| Commit | Date | Author | Subject |
| --- | --- | --- | --- |
| `b1129f9` | 2026-09-07 | pixelbuyte | design: add complete Drip product experience with 39 app frames |
| `9e0aa04` | 2026-09-07 | pixelbuyte | design: refine Drip shopping journey and add guided reference studio (frames 40–42, board 15, REVIEW-GUIDE, design-qa, review-data.json, gallery JS) |

`git diff --name-only origin/main origin/astra-drip | grep -v '^docs/product-design/'` returns **nothing**. All 39 changed files (+2153, 0 deletions) are under `docs/product-design/`:
- docs/specs: README.md, REVIEW-GUIDE.md, SPECIFICATION.md, design-qa.md, assets/README.md
- data: tokens.json, manifest.json, review-data.json
- gallery tooling: index.html, gallery-template.html, gallery.js, gallery.css, build_gallery.py, build_exports.py, preview.py, package.json, .gitignore
- raster: boards/01–14 (.jpg, 1448×1086), boards/15 (.png, 1536×1024), directions/a,b,c (.png, 853×1844), assets/maya-tote.png and jada-speaker.png, qa/*.jpg

**There is no code difference between main and astra-drip. The change is docs and design only.** README.md line "Only `docs/product-design/` is part of this design change. Production application behavior is unchanged." says the same.

Note (Confirmed): there are no per-frame image files. Each of the 42 "frames" is a crop rectangle into a board (`manifest.json` `crop: [x,y,w,h]`). The PDF ("Drip-Product-Design-v2.pdf") and the 42 per-frame PNGs come from `build_exports.py` and are git-ignored. They are not in the repo.

#### 1.3 Verdict: base for native-ios

- **`astra-drip` (= `native-ios`) is the correct base** (Confirmed facts, Inferred recommendation). It is main plus the design package. It is 0 behind main. It changes no app code, so web behaviour is the same as main and the iOS client gets the canonical design reference.
- **Action item (Inferred):** `a796cc3` on hello-cj48qg fixes a real server-side ranking bug. Normalised (≤0.45) affinities were being persisted where the raw event-scale state should have been, so one purchase (+10) wiped a viewer's history. The native app will use the same feed API, so this fix should reach main through its own PR, cherry-picked without the landing redesign. Do not rebase native-ios onto hello-cj48qg. Its other 3 commits are web-landing-only and do not matter for native.

---

### 2. Web design system as implemented (main = native-ios code)

#### 2.1 Tailwind v4 `@theme` tokens — `src/app/globals.css` (Confirmed)

Philosophy comment (globals.css:4-11): cream ground, white cards, one hot coral primary, six single-purpose semantic accents, warm shadows only.

**Colors**
| Token | Value | Line | Note |
| --- | --- | --- | --- |
| `--color-cream` | `#fff9f2` | 15 | page ground |
| `--color-card` | `#ffffff` | 16 | cards, nav, **sheets** |
| `--color-ink` | `#201a17` | 17 | text, CTA labels |
| `--color-muted` | `#6e6259` | 18 | only other text neutral |
| `--color-hairline` | `rgba(32,26,23,.06)` | 19 | |
| `--color-hairline-strong` | `rgba(32,26,23,.12)` | 20 | |
| `--color-coral` | `#ff4b2e` | 24 | CTA fill, ink label (white only at hero size) |
| `--color-coral-deep` | `#c2410c` | 25 | coral-as-text, 4.95:1 |
| `--color-sale` | `#d92d0f` | 28 | price-drop |
| `--color-pink` | `#ff2e93` | 29 | save/wishlist (hot pink) |
| `--color-pink-deep` | `#d6246e` | 30 | |
| `--color-lime` | `#c7f03c` | 31 | NEW chips, ink text |
| `--color-violet` | `#6d4aff` | 32 | creators |
| `--color-cobalt` | `#2e5cff` | 33 | back-in-stock/info |
| `--color-amber` | `#ffb01f` | 34 | rating stars |
| legacy: `ink-raised #2b2420`, `line rgba(255,249,242,.14)`, `paper #fff9f2`, `dim #a89d94`, `acid #ff4b2e`, `ember #ff8a70` | | 89-94 | dark auth/dashboard/drop-view pages |

**Fonts** (globals.css:37-39): `--font-display: var(--font-bricolage)`, `--font-sans: var(--font-hanken)`, `--font-mono` is a legacy alias to Hanken.
**Type scale** (41-49): `--text-hero: clamp(2.75rem, 7.5vw, 5.25rem)`, lh 0.95, tracking −0.03em. `--text-section: clamp(1.75rem, 3.6vw, 2.75rem)`, lh 1.02, −0.025em. `--text-sub: 1.125rem`, lh 1.55, −0.008em. Tabular numerals on `[data-num]`, `.font-mono` and tables (117-121).
**Radii** (52-56): card 18, art 12, tile 22, mock 24, banner 28 (px).
**Shadows** (59-79): warm ink rgba(32,26,23,…), multi-layer: `card`, `card-hover`, `mid`, `back`, `float`, `cta` (`0 8px 22px -6px rgba(255,75,46,.45)`, a coral glow), `nav`.
**Easing** (82-84): `ease-out (0.16,1,0.3,1)`, `ease-state (0.25,1,0.5,1)`, `ease-spring (0.34,1.56,0.64,1)` (overshoot; "save pop + hero CTA press ONLY").
**Motion vars** (98-101): `--dur-entry: 640ms`, `--ease-entry (0.16,1,0.3,1)`. Scroll entry `[data-enter]` rise/lift with a 70ms stagger (193-208). Ambient keyframes drift/float/ticker/dot-pulse (219-239). All honour `prefers-reduced-motion` (210-216, 229-233, 287-290).
**Utilities**: `art` = 135° pastel duotone + softbox + dither (142-162). `rail` = horizontal snap scroller, 12px gap (166-185).
**Save button** `.save-btn` (247-285): 38px white circle, `shadow-float`, press scale .8 / 90ms, saved state = pink fill + `save-pop` 350ms spring (.8→1.22→1) + 400ms ring burst. The icon is a **heart** (`src/components/landing/save-button.tsx:17-18`).
**Dark mode:** none. No `prefers-color-scheme` or `dark:` anywhere in `src/`. The feed is dark by construction (`bg-ink`, `src/components/feed/feed-shell.tsx:244,256`).

#### 2.2 Fonts loaded — `src/app/layout.tsx` (Confirmed)
- `Bricolage_Grotesque` from `next/font/google`, variable `--font-bricolage`, `axes: ['opsz']`, swap (layout.tsx:2,7-12)
- `Hanken_Grotesk`, variable `--font-hanken` (14-18)
- Comment (5-6): "Bricolage at high optical sizes for headlines; Hanken for every card title, price, button and chip. Both variable."

#### 2.3 Recurring component patterns in `src/components/**` (Confirmed)
| Pattern | Implementation | Cite |
| --- | --- | --- |
| Primary CTA | `rounded-full bg-coral text-ink font-bold shadow-cta`, py-3.5, 16px, `active:scale-[0.98]` | product-sheet.tsx:225, checkout-sheet.tsx:130, nav.tsx:136, app/page.tsx:108 (`ease-spring`, scale .96) |
| Secondary button | `rounded-full border border-hairline-strong bg-card text-ink` | app/page.tsx:114, checkout-sheet.tsx:280, creators.tsx:70 |
| Ink button | `rounded-full bg-ink text-cream`, min-h 52 | studio/money/page.tsx:745 |
| Bottom sheet | full-screen scrim `bg-black/55` or `/60`, `rounded-t-[24px] bg-card`, grabber `h-1 w-10 rounded-full bg-ink/15`; product sheet detents **45dvh / 92dvh**, `height 280ms cubic-bezier(0.32,0.72,0,1)`; video **paused** while open | product-sheet.tsx:12-13,76,81,91-95,113; checkout-sheet.tsx:234-241 (92dvh) |
| Feed product bar (web "shelf") | `rounded-[18px] bg-card shadow-card min-h-[56px]`, 40px thumb r10, title 14 semibold, price 17 extrabold, nudge translateY(−6px) 420ms | product-bar.tsx:51-103 |
| Variant chips | `min-h-11 min-w-11 rounded-[12px] border`; selected `bg-ink text-cream`; out-of-stock struck through | product-sheet.tsx:166-172 |
| Search/filter chips | `rounded-full border-hairline-strong bg-card px-3.5 py-1.5 text-[13px] font-semibold`, coral hover tint | nav.tsx:66 |
| Search field | `h-11 rounded-full border bg-card`, coral focus ring | nav.tsx:42 |
| Product card | `rounded-card bg-card p-1.5 shadow-card`, hover lift; emoji `ProductArt` with 4:5 aspect and `rounded-art`; one badge max (price drop / restock / NEW lime) | landing/product-card.tsx:4-58,71 |
| Qty stepper | 44px circular outline buttons | product-sheet.tsx:185-200 |
| Toast | `rounded-full bg-card shadow-float` centred | feed-shell.tsx:406 |
| Studio nav item | `min-h-[44px] rounded-full`, active `bg-coral/10 text-coral-deep` | studio/layout.tsx:165 |
| Legacy dark pages | `acid`/`paper`/`ink-raised` aliases | e.g. app/[handle]/[slug]/thanks/page.tsx:33 |

---

### 3. Design package on astra-drip (`docs/product-design/`)

#### 3.1 tokens.json — verbatim (Confirmed)

```json
{
  "colors": {
    "cream": "#FFF9F2",
    "ink": "#201A17",
    "muted": "#6E6259",
    "coral": "#FF4B2E",
    "coralText": "#C2410C",
    "lime": "#C7F03C",
    "lavender": "#E9DDFC",
    "pink": "#FADDE5",
    "peach": "#FFE0CC",
    "mint": "#DCEADB",
    "saleText": "#B52E18",
    "successText": "#245534"
  },
  "spacing": [
    4,
    8,
    12,
    16,
    20,
    24,
    32,
    40,
    48
  ],
  "radius": {
    "thumbnail": 8,
    "field": 12,
    "tile": 16,
    "media": 24,
    "sheet": 28,
    "pill": 999
  },
  "touchTarget": {
    "minimum": 44,
    "preferred": 48
  },
  "type": {
    "display": {
      "size": 48,
      "lineHeight": 50
    },
    "title": {
      "size": 32,
      "lineHeight": 36
    },
    "section": {
      "size": 24,
      "lineHeight": 28
    },
    "product": {
      "size": 18,
      "lineHeight": 24
    },
    "body": {
      "size": 16,
      "lineHeight": 24
    },
    "meta": {
      "size": 14,
      "lineHeight": 20
    },
    "nav": {
      "size": 13,
      "lineHeight": 16
    }
  },
  "motionMs": {
    "press": 80,
    "release": 120,
    "like": 260,
    "follow": 180,
    "save": 200,
    "peek": 320,
    "comments": 300,
    "checkout": 300,
    "tab": 180,
    "success": 360,
    "reducedMotionMax": 100
  },
  "easing": {
    "standard": "cubic-bezier(.2,.8,.2,1)"
  },
  "commentsDetents": [
    0.25,
    0.6,
    0.9
  ],
  "contrast": {
    "ink/cream": 16.44,
    "muted/cream": 5.65,
    "ink/coral": 5.16,
    "coralText/cream": 4.95,
    "ink/lime": 13.06,
    "saleText/peach": 4.98,
    "successText/mint": 6.95
  }
}
```

#### 3.2 design-qa.md (Confirmed)
"final result: passed". This QA covers the **reference gallery**, not the app. Frame 40 from the source board (crop `[48,47,447,977]`) was compared with the browser inspector capture (`qa/frame-40-comparison.jpg`, `qa/gallery-inspector.jpg`). No P0–P2 rendering differences were found. All 42 frames render. The buy flow 40→41→42→24→40 works, as do the comment detents, search empty state, Escape-to-close and PNG export over HTTP. Limits it states: raster art cannot show reflow, screen-reader behaviour or spring motion. Generated art sometimes drifts from labels and contrast, so the correction tables and tokens take precedence.

#### 3.3 manifest.json — all frames (Confirmed)
Title "DRIP — The complete product experience". 42 frames, 15 boards, 64 PDF pages, 3 directions. Boards 1–14 are 1448×1086 and board 15 is 1536×1024. Groups come from `review-data.json` notes.

| # | Title | Board (flow/section) | Group |
| --- | --- | --- | --- |
| 01 | For you | 01 The content-to-commerce journey | Feed |
| 02 | Product peek | 01 | Feed |
| 03 | Shop the frame | 01 | Feed |
| 04 | Comments / 25% | 02 Comments that stay with the video | Social |
| 05 | Comments / 60% | 02 | Social |
| 06 | Comments / 90% | 02 | Social |
| 07 | Shop / Daily drop | 03 Three shopping compositions | Shop |
| 08 | Shop / The edit | 03 | Shop |
| 09 | Shop / Creator picks | 03 | Shop |
| 10 | Discover | 04 Discovery and intent | Discover |
| 11 | Fashion | 04 | Discover |
| 12 | Search results | 04 | Discover |
| 13 | Product detail | 05 The buying decision | Shop |
| 14 | Seen on Drip | 05 | Shop |
| 15 | Sizes and reviews | 05 | Shop |
| 16 | Creator storefront | 06 People and your corner | Social |
| 17 | Following | 06 | Social |
| 18 | Your profile | 06 | Account |
| 19 | Saved | 07 The shopping essentials | Account |
| 20 | Notifications | 07 | Account |
| 21 | Shopping bag | 07 | Checkout |
| 22 | Quick checkout | 08 A purchase without losing your place | Checkout |
| 23 | Delivery details | 08 | Checkout |
| 24 | It's yours | 08 | Checkout |
| 25 | Compare in the feed | 09 Different stories, one feed | Feed |
| 26 | Collection carousel | 09 | Feed |
| 27 | Creator mini-review | 09 | Feed |
| 28 | New drop announcement | 10 Creating and collecting | Feed |
| 29 | Create a drop | 10 | Social |
| 30 | Save to a collection | 10 | Account |
| 31 | Shop loading | 11 Waiting, starting, reconnecting | States |
| 32 | Saved / empty | 11 | States |
| 33 | Feed / connection error | 11 | States |
| 34 | Payment declined | 12 Useful recovery paths | States |
| 35 | Variant unavailable | 12 | States |
| 36 | Search / no matches | 12 | States |
| 37 | Double-tap like | 13 Small interactions, Drip character | Social |
| 38 | Follow and mini-profile | 13 | Social |
| 39 | Product scrub | 13 | Feed |
| — | (no frames) | 14 The component language | — |
| 40 | The living shelf | 15 The living shelf / final refinement | Refinement |
| 41 | Choose your shade | 15 | Refinement |
| 42 | Make it yours | 15 | Refinement |

#### 3.4 review-data.json — key decisions (Confirmed)
- **9 guided flows**: buy "Watch it. Want it. Own it." [40,41,42,24,40]; comments [1,4,5,6,1]; discover [10–15]; shop [7,8,9,13,2,22]; people [1,38,16,17,30,19]; recover [42,34,35,33,1]; account [18,20,19,21,23,22]; formats [1,25–29]; states [31,32,36,33,34,35].
- **Per-frame contracts** (42 notes) that matter for native:
  - Peek: "320ms high-damping transition. Continue source video for peek; selected SKU must carry into checkout" (2).
  - Feed: one active video; restore post ID, playhead and mute (1).
  - Comments: 25% → 60% default → 90%; keyboard promotes to 90% (4–6).
  - Like: double-tap only likes, never unlikes; 260ms (37).
  - Follow: 180ms, optimistic with rollback (38).
  - Scrub: hold 350ms, lock horizontal intent (39).
  - Living shelf: "The second shelf is a 44pt Shop this look target. Count only tagged products: tote, knit and denim" (40).
  - Peek CTA: "Ink on coral passes normal-text contrast. Selected color uses check + label" (41).
  - Checkout: "Make the background header inert" (42).
  - Payment declined and unknown status are separate cases (34).
- **26 action maps**: the per-frame navigation graph, e.g. 40 → {41 Peek, 5 comments, 3 Shop this look, 7 Open Shop}.

#### 3.5 index.html / gallery (Confirmed)
A self-contained "DRIP / Product design studio" (`index.html`, data inlined as `#design-data`, rendered by gallery.js). It has four modes: App screens (search plus category filters All/Refinement/Feed/Shop/Social/Discover/Checkout/Account/States, with frames 40+ sorted first), Walk the flows, Three directions, and Design system (swatches and type scale from tokens.json, plus a motion table). The inspector supports keyboard, `#frame=N` deep links, detent buttons and canvas PNG export. Gallery chrome uses system sans + Georgia, which is review UI and not the brand. Selected-direction copy: "SELECTED FINAL DIRECTION — Editorial creator commerce."

#### 3.6 Directions and the choice (Confirmed from SPECIFICATION.md:9-17, REVIEW-GUIDE "Final visual selection"; visuals Inferred from images)
- **A · Editorial Commerce** (`directions/a-editorial-commerce.png`): full-bleed creator photo feed, an elegant high-contrast **serif** headline ("The everyday rotation.") over media, a white/cream compact shelf card with a coral "Shop" pill, a labeled cream tab bar with a coral circle Drop, and an ink segmented "For you | Shop" pill.
- **B · Playful Creator Commerce** (`b-playful…png`): Shop stream with a **heavy grotesque** display ("Your daily drop.", similar in character to the web's Bricolage ExtraBold), a letter-spaced uppercase eyebrow, pastel circle category objects, an editorial card with a floating product inset, "Picked by @creator" product tiles, and an underline tab switch.
- **C · Future Social Shopping** (`c-future…png`): immersive media with a white wordmark, a mute control, and a contextual cream product sheet growing over the video (thumbnail rail, swatches, "Buy now · $59" coral + outlined Save, commission line). Its Drop button is a coral droplet shape.
- **Chosen: a synthesis, "Editorial creator commerce" / "The feed is the store. The people make it Drip."** A supplies photography, serif headings and quiet cream. B supplies dimensional category objects, the tactile product shelf and coral/lime punctuation. C supplies contextual sheets and video→product→purchase continuity. Navigation: **Study 1, the labeled cream dock** (SPECIFICATION.md:55). Frames **40–42 are preferred** for feed → peek → checkout. They replace the tall vertical social rail with one **horizontal social row** above the "living shelf".

#### 3.7 Visual specs from the images (Inferred from viewing; numbers in the spec are Confirmed)

Images viewed: boards 14, 15, 01, 02, 03, 04, 05, 06, 07, 08, 10, 13 and directions A/B/C.

**Board 14 — component language**
- Wordmark "drip." is a heavy, rounded geometric/grotesque lowercase with a **coral dot** period. Taglines "People with taste." / "GOOD FINDS. BRIGHTER DAYS." (wide-tracked caps).
- Palette circles: Cream, Ink, Coral, Lime, Lavender, Pink, Peach, Mint. These are the same as tokens.json minus saleText/successText/coralText/muted.
- Type sample: "Good finds. Great company." in a **bold, tightly tracked editorial serif**. "The Studio Tote · $78" in a medium sans. Body in a light/regular sans.
- **Five product cards**:
  1. Feed chip (horizontal): ~72pt photo thumb r≈8, title semibold, color in muted, price, coral pill "Shop" with ink label.
  2. Discovery card (portrait): photo with white circular bookmark top-right, name, price + amber star rating, "Picked by Maya" avatar row with chevron.
  3. Editorial feature: large photo, white italic serif overlay "A softer evening.", creator inset card with verified tick, ink pill "Shop the drop".
  4. Price drop card: peach surface, lime "Price dropped" badge, bookmark, price + struck old price + peach/coral "Down $30" pill.
  5. Creator pick card: avatar + name + verified + followers, serif heading "Jada's everyday pick.", product photo, price + rating, peach tonal "Watch review" button with play icon.
- Navigation studies: (1) rounded line, labeled cream, coral circle Drop, coral dot under selected (**selected**); (2) duotone rounded with ink square Drop; (3) organic filled with a peach selected pill and droplet Drop.
- Control states:
  - Follow: outline with person+ icon, then **Following** with a mint fill and check.
  - Bookmark: outline, then ink-filled on peach.
  - Like: outline heart, then coral-filled heart on peach.
  - Primary "Shop": coral with ink label. Tonal "Shop the drop": peach. Outline "View product": ink border.

**Board 15 / frames 40–42 — The living shelf (canonical journey)**
- **Header** (cream): wordmark left; segmented pill with ink-filled selected "For you" (cream text) and unselected "Shop" on a light track; bag icon right.
- **Media**: full-bleed photo from under the header to just above the dock. Lime "NEW DROP" pill (ink caps) top-left.
- **Lower-left stack over a bottom scrim**: avatar (~40pt, white ring) + "Maya Chen" + verified + @handle + white-outline "Follow" pill; a white serif headline of two lines ("The everyday rotation.").
- **Social row** (horizontal): coral filled heart 12.4K · comment 328 · bookmark · Share.
- **Living shelf**: a cream rounded card (r≈16–24) inset ~12–16pt from the edges. It holds a ~56pt product thumb, "The Studio Tote" semibold, "Chocolate · $78" muted, and a coral pill **"Peek"** with an ink label.
- **Second shelf row** directly below: overlapping thumbnails (knit, denim, cup) + "3 in this look" + chevron. This is the 44pt "Shop this look" target.
- **Dock**: cream, five zones Home/Discover/Drop/Following/Profile. Home ink-filled icon, semibold label and a coral dot. Drop is a coral circle with a white "+".
- **41 Choose your shade**: the video stays visible in the top ~30%. A cream sheet with top radius ≈28, grabber and close ×. Large product photo r≈16; serif title "The Studio Tote"; "$78" bold sans + amber star 4.8 (216); description; "Color: Chocolate". Swatch tiles are photos with a **coral selected border + ink check badge** and the name below. Tonal info row (truck icon) "Free shipping · 30-day returns ›"; "Maya earns a commission."; outlined "Full details" plus coral "Buy now · $78" (ink label).
- **42 Make it yours**: serif "Make it yours." + "Secure checkout"; line item row (thumb, name, "Chocolate · Qty 1", $78); Delivery and Payment rows with icons and coral-text "Edit"/"Change"; Order summary with right-aligned figures; TOTAL $84.24; outlined "Pay with Apple Pay"; coral "Buy now · $84.24"; lock + "Your place in the feed is saved."
- Raster colour sampling (board 15): cream ≈ `#FEFBF4`, coral button ≈ `#FB5938`–`#FF5D3E`. These drift from the tokens (`#FFF9F2`, `#FF4B2E`) because the art is generated, so use the tokens.

**Feed (01–03, 37–39)**
- Original layout uses a vertical right-side social rail (heart, comment, bookmark, share, more) and a coral "Shop" on the shelf.
- Peek (02) is a cream sheet at ~55–60% height with the image left and serif title right, and the grabber is visible.
- Shop the frame (03): numbered ink circles + white label tags on the media, and a "Shop this look" sheet listing 3 products with numbers and chevrons.
- 37: double-tap heart burst (coral heart + small coral dots) near the subject.
- 38: mini-profile sheet. Avatar with coral ring, "✓ Following" peach-outlined pill, ink "View creator profile", outlined "Drop reminders", mint toast "Added to your Following feed."
- 39: scrub sheet with 3 swatch tiles, "2 of 3", "Color · Sand / Slide to preview colors", coral "Use Sand".

**Comments (04–06)**
- Cream sheet at 25/60/90%. Title "Comments 328" (sans semibold, count muted) and ×.
- Pinned creator comment on a peach-tinted rounded row ("Creator · Pinned").
- Rows: 40pt avatar, name semibold, body 16, meta (time, heart count, Reply).
- Threaded replies with an indent line; emoji reaction chips in rounded squares; composer with a pill field and a 44pt coral circular send button (ink paper-plane).

**Shop (07–09)**
- Big headlines: 07 "Your daily drop." and 09 "People with taste." use the heavy grotesque (direction B carry-over); 08 "The Sunday edit." uses the serif. Eyebrows are tracked caps ("PICKED BY PEOPLE, NOT ADS").
- Pastel circle category objects; editorial hero card r≈24 with a floating white product inset card and coral "Shop now".
- "Price drops." cards with coral "−$30" badges; 2-up product tiles with white bookmark circles and amber ratings; creator circles with verified ticks; peach "UNDER $50" banner with outline pill "Shop collection →".

**Discover / category / search (10–12)**
- Serif "Find your next thing."; pill search field on a light fill; trend chips in pastel fills (peach/sand/lavender).
- 3×3 **dimensional object category tiles** on pastel squares (r≈16) with labels.
- Creator cards are photos with a white "Follow" pill. Fashion hero has a tracked-caps eyebrow, serif "Wear it on repeat." and a coral "Watch the edit ▶".
- Subcategory chips (selected = peach fill). Search has tabs All (ink selected)/Videos/Products/Creators, video result tiles with play button and view counts, and creator circles with outline Follow.

**Product detail (13–15)**
- Back, wordmark, heart (wishlist here is drift: the spec says bookmark = Save) and bag. Image pager dots.
- Serif title, bold price, rating, swatches. Serif "Room for your everyday." Two tonal info tiles (Free shipping / 30-day returns).
- "Recommended by Maya Chen" with a video thumb, then the commission line. Sticky bar: outlined "Add to bag" + coral "Buy now".
- 14 "Seen on Drip." is a 2×2 creator video grid with play counts plus accordions (Materials/Measurements/Care).
- 15: size pills (ink selected), reviews histogram, verified-purchase review card.

**Creator / Following / Profile (16–18)**
- Storefront: cover photo, overlapping 88pt avatar with white ring, serif name + verified, bell outline circle + coral Follow, pastel tag chips, "Featured drops" cards with bookmarks, underline tabs Videos/Collections/Top picks, 3-up video grid with play counts.
- Following: serif "Your people. Their latest."; story circles with coral rings, a lime "LIVE NOW" pill and a coral "Join"; post card with an embedded shelf; "Coming up" row with outline "Remind me".
- Profile: serif "Your corner of Drip."; stats with dividers; list rows (icon + label + chevron); "On the way" order card with coral "Track order"; pastel category pills (pink/mint/peach) with line icons.

**Saved / Notifications / Bag (07 board)**
- Saved: two chip rows (ink selected); peach price-drop banner "A good find got better." Notifications: unread coral dot, peach icon circles, outline "Set reminder", "You're all caught up" card. Bag: steppers in outlined pill, Remove/Save for later, order summary, black Apple Pay + coral "Checkout · $114.48".

**Checkout (22–24)**
- Serif "Make it yours."; outlined info rows r≈12 with icons and underlined "Change"; summary with green "Free"; black Apple Pay; "or pay with card" divider; coral "Buy now · $84.24".
- Address form: labelled fields, r≈12, label above value inside the field. Coral radio selected; ink checkbox.
- Success: coral circle with ink check, serif "It's yours.", order row, a "Your spot is saved." tonal card, outline "View order" + coral "▶ Back to your feed".

**Create / Save (10 board)**
- Create a drop: serif title, outline "Save draft", 9:16 media with play and timer and "Replace video" glass pill, tonal text area, tagged-product card with ×, dashed "Add product" tile, disclosure radios (I bought this / Gifted / Paid partnership), captions row, coral "Preview drop".
- Save to collection: peach circle bookmark icon, serif "Saved. Make it a collection.", collection rows with 4 thumbs and a radio (selected row peach tint + coral check), dashed "New collection", ink snackbar "Saved to Wishlist · Undo", coral toggle "Price drop alerts", coral "Done".

**Iconography** (spec Confirmed, art Inferred): 24pt grid, 2pt rounded line strokes; selected tab icon is filled ink. Icons in use: house, magnifier, plus, people, person, bell, bag, heart, speech bubble, bookmark, share (box+arrow), truck, pin, card, lock, box, tag, gear, sliders. SPECIFICATION.md:57 says to pick one licensed family. SF Symbols is a good fit on iOS (Inferred).

**Motion cues in art**: heart burst (37), sheet grabbers on every sheet, "Slide to preview colors" scrub (39), the growing shelf→sheet (40→41), toasts/snackbars (30, 38), success check (24).

---

### 4. Implemented web tokens vs design tokens.json

| Area | Web (`src/app/globals.css`, layout.tsx, components) | Design (`docs/product-design/tokens.json`, SPECIFICATION.md) | Status |
| --- | --- | --- | --- |
| cream / ink / muted / coral / coralText / lime | `#fff9f2 / #201a17 / #6e6259 / #ff4b2e / #c2410c (coral-deep) / #c7f03c` (15-31) | identical | **Match** (rename `coral-deep`→`coralText`) |
| `pink` | `#ff2e93` hot pink = save identity (29) | `#FADDE5` pastel beauty/editorial surface | **Name collision, different meaning** |
| Sale | `sale #d92d0f` (28) | `saleText #B52E18` (on peach) | **Conflict** |
| Pastel surfaces | none as tokens; ad-hoc gradients in `products.ts` SCENES, `#ffe3d8→#ffc9b5` in product-bar.tsx:70 | lavender `#E9DDFC`, peach `#FFE0CC`, mint `#DCEADB` | design-only |
| successText | — | `#245534` | design-only |
| violet / cobalt / amber / pink-deep / hairlines / card #fff | present (16-34) | absent (amber star still appears in the art; spec says "sheet" and "nav" use cream) | web-only. Keep `amber` for star rating and hairlines as native extras (Inferred) |
| Fonts | **Bricolage Grotesque** (display, opsz) + **Hanken Grotesk** (layout.tsx:2-18) | **Instrument Serif** (display) + **DM Sans** (UI) "such as" (SPECIFICATION.md:82); REVIEW-GUIDE flags this gap | **Conflict** |
| Type scale | fluid web clamps (41-49) | fixed pt: 48/50, 32/36, 24/28, 18/24, 16/24, 14/20, 13/16 | different model |
| Radii | card 18, art 12, tile 22, mock 24, banner 28; sheets 24 (product-sheet.tsx:91); chips 12 | thumbnail 8, field 12, tile 16, media 24, sheet **28**, pill 999 | **Conflict** (only 12 and 24 coincide) |
| Shadows | multi-layer warm stacks + coral `shadow-cta` glow (59-79) | card `0 4 16 .06`, floating shelf `0 8 28 .12`, sheet `0 −8 32 .14`; "dividers before shadows"; no CTA glow | **Conflict** |
| Easing | `ease-out (0.16,1,0.3,1)`, `ease-spring (0.34,1.56,0.64,1)` overshoot; sheets `(0.32,0.72,0,1)` | standard `(.2,.8,.2,1)`; sheets = platform springs damping 0.9–1.0, **no visible overshoot** | **Conflict** |
| Durations | entry 640ms; sheet 280ms; save pop 350 + burst 400; press 90–350ms, scale .96–.98 | press 80 / release 120 (scale .98), like 260, follow 180, save 200, peek 320, comments 300, checkout 300, tab 180, success 360, reduced ≤100 | **Conflict** |
| Save semantics | **heart** icon, pink fill (save-button.tsx:17-18; globals.css:247-285) | **Heart = Like; Bookmark = Save** (SPECIFICATION.md:27) | **Conflict** |
| Sheet behaviour | 2 detents 45/92dvh; black scrim; video **paused** (product-sheet.tsx:12-13,76) | peek ≈65% with video **still playing**; comments 25/60/90; checkout covers nav | **Conflict** (REVIEW-GUIDE "integration gap") |
| Sheet surface | `bg-card` white | cream | Conflict |
| Touch target | `min-h-11` = 44 (product-sheet.tsx:166) | 44 min / 48 preferred | Match/compatible |
| Spacing | Tailwind 4px base, no scale token | 4,8,12,16,20,24,32,40,48 | compatible |
| Dark mode | none (feed is dark-by-design) | none defined | both light-only |

**Recommendation (Inferred, as the brief expects): `docs/product-design/tokens.json` is canonical for native.** Use SPECIFICATION.md as the authority for what the tokens do not cover: elevation values, button heights, avatar sizes, nav metrics, product peek ≈65%, and the frame-image correction table. Reasons:
- It is the newest, deliberate, reviewed spec (2026-09-07).
- It carries measured contrast pairs.
- REVIEW-GUIDE calls the web's Bricolage/Hanken a gap to close later.
- The web globals.css is landing/marketing-tuned (fluid clamps, ambient loops, legacy dark aliases).

Keep a small "native extras" set where tokens.json is silent: `card #FFFFFF` (if white cards are wanted at all; the art mostly uses cream), hairline 6%/12% ink, `amber #FFB01F` for stars, and an `overlay` scrim. Do **not** port web `pink #ff2e93`, violet, cobalt or `ease-spring`.

---


## Part C — HTTP API, authentication and security

_Baseline `9e0aa04`. §7 reviews the first native-identity commit (`8a1e20f`)._

### 1. Auth model

#### 1.1 How a seller session is established
- **Providers. Confirmed:**
  - The login and signup pages use `@supabase/auth-ui-react` `<Auth>` with `providers={['google']}` and `onlyThirdPartyProviders={false}` (`src/app/auth/login/page.tsx:58-66`, `src/app/auth/signup/page.tsx:58-66`). That gives email + password plus Google OAuth.
  - `redirectTo` is `${NEXT_PUBLIC_APP_URL}/auth/callback` (`login/page.tsx:63`).
- **Magic link. Inferred not enabled:** the `magicLink` prop isn't passed, and Auth UI hides the magic-link view by default. Nothing in `src` references `signInWithOtp`, `magic_link` or `update_password`.
- **Password reset. Inferred:** Auth UI's "forgot password" link is on by default (`showLinks`). No update-password page exists, so a reset lands on `/auth/callback`, which then goes to `/onboarding`.
- **Browser client. Confirmed:** `createBrowserClient` from `@supabase/ssr` (`src/lib/supabase.ts:5-9`). It stores the session in `sb-<ref>-auth-token` cookies.
  - **Inferred** from `node_modules/@supabase/ssr` 0.12.0 `DEFAULT_COOKIE_OPTIONS`: `sameSite: "lax"`, `httpOnly: false`, `maxAge` of 400 days. These cookies are readable by JavaScript.
- **OAuth/PKCE callback. Confirmed:** `GET /auth/callback` calls `exchangeCodeForSession(code)` and then redirects to `next`, which defaults to `/onboarding` (`src/app/auth/callback/route.ts:4-20`).
- **Profile creation. Confirmed:** there's no API route for it. The onboarding page inserts into `profiles` directly with the browser Supabase client (`src/app/onboarding/page.tsx:57`).
- **Sellers vs. users. Confirmed:** there is no role claim. Any authenticated Supabase user is a potential seller.
  - "Seller" gates are data checks, not roles: a profile row must exist (`src/app/api/drops/route.ts:22-33`) and `seller_payments.charges_enabled` must be true (`drops/route.ts:37-42`).
  - Buyers and viewers have no accounts. They are anonymous devices (`src/app/api/waitlist/route.ts:12-13`; comment at `src/app/api/checkout/route.ts:30-31`).

#### 1.2 How each route resolves the user
- **Server client is cookie-only at HEAD. Confirmed:** `createServerClient_()` builds an `@supabase/ssr` `createServerClient` whose cookie adapter reads `cookies().getAll()` and writes with `cookies().set` (`src/lib/supabase-server.ts:4-27`).
  - At `9e0aa04` nothing reads `Authorization` (grep for `authorization`/`Bearer` in `src`).
- **All user-scoped routes call `supabase.auth.getUser()` with no argument. Confirmed.** That makes a network round trip to Supabase Auth to verify the cookie session's access token:
  - `dashboard/stats/route.ts:8-15`
  - `discounts/route.ts:7-14`, `:33-40` and `:92-99`
  - `drops/route.ts:9-16`
  - `drops/[id]/restock/route.ts:18-25`
  - `orders/[id]/retry-label/route.ts:15-22`
  - `orders/export/route.ts:12-19`
  - `settings/address/route.ts:8-15`
  - `stripe/onboarding/{start:7-14, status:10-17, refresh:9-16}`
  - `session/link/route.ts:7-9`
- **Session refresh. Inferred:** no middleware refreshes Supabase sessions. `src/proxy.ts` never builds a Supabase client. A refresh only happens when a route handler's `getUser()` triggers `setAll`. In Server Components, `setAll` throws and the error is swallowed (`supabase-server.ts:20-22`).
- **`src/lib/auth.ts` is dead code. Confirmed:** `getSession`, `requireAuth` and `getUserProfile` have no importers (grep). It also uses the unverified `getSession()` (`auth.ts:6`). Don't revive it for authorization.
- **Landing redirect. Confirmed:** the proxy redirects `/` to `/dashboard` when any cookie matches `sb-*-auth-token`. This is a presence check only (`src/proxy.ts:27-36`).
  - **Inferred:** a chunked session cookie (`sb-<ref>-auth-token.0`) doesn't end with `-auth-token`, so a large session (for example Google with provider tokens) won't trigger the redirect. This is a UX issue only.

#### 1.3 Anonymous viewer identity
- **Cookie. Confirmed:**
  - Name `drip_aid` (`src/lib/anon-id.ts:3`).
  - Value `v1.<uuid v4>.<base64url(HMAC-SHA256(uuid, ANON_ID_SECRET))>` (`anon-id.ts:57-71`).
  - Verified with `timingSafeEqual`. The uuid must be lowercase (`UUID_RE`, `anon-id.ts:4, 89-104`).
  - The secret must be at least 32 characters. Otherwise identity is "unconfigured": nothing is minted and nothing verifies (`anon-id.ts:25-33, 63-68, 89-94`).
- **Who mints it. Confirmed:** `src/proxy.ts`, on matcher paths `/`, `/feed/:path*`, `/v/:path*`, `/discover/:path*`, `/api/events` and `/api/feed/:path*` (`proxy.ts:15-24`). `/api/feed` itself matches because `:path*` matches zero or more segments (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md:128`).
  - If the cookie is missing or invalid, the proxy mints a new id and sets the cookie. Attributes: `HttpOnly`, `Secure` in production, `SameSite=Lax`, `Path=/`, `Max-Age` of 730 days, `priority=high` (`proxy.ts:42-67`).
  - It also forwards the id to the route as the request header `x-drip-anon-id` (`proxy.ts:54-57`).
- **No expiry or rotation. Confirmed:** the signed value has no timestamp, so it is valid as long as the secret is unchanged (`anon-id.ts:69-70`). The `v1.` prefix leaves room for key versioning, but nothing uses it.
- **How each route reads identity. Confirmed:**
  - `/api/feed`: signed cookie, otherwise the **unsigned** `x-drip-anon-id` header (`src/app/api/feed/route.ts:37-46`).
  - `/api/search`: same (`src/app/api/search/route.ts:29-36`). **`/api/search` is not in the proxy matcher**, so the header there is whatever the client sent (see 4.3).
  - `/api/events`: signed cookie only. 401 without it (`events/route.ts:59-76`).
  - `/api/checkout/intent`: signed cookie only. 400 without it (`checkout/intent/route.ts:35-39`).
  - `/api/session/link`: signed cookie (`session/link/route.ts:11-12`).
  - SSR pages `feed/page.tsx:15-17` and `search/page.tsx:24-26`: cookie, then header.
- **IP provenance. Confirmed:** `/api/events` writes `viewer_identities.issued_ip_hash = sha256(ip || secret)` once (`events/route.ts:129-143`; `anon-id.ts:114-122`).

#### 1.4 `POST /api/session/link` (anon to account)
- **Behaviour. Confirmed:** requires a Supabase user (401 otherwise). Reads the signed `drip_aid`.
  - With no anon id, it mints a new cookie (hard-coded `secure: true`) and returns `{linked:false}` (`session/link/route.ts:13-22`).
  - Otherwise it calls the service-role RPC `claim_anon_identity(p_anon_id, p_user_id)` and returns `{linked: boolean}`, or 500 `{error:'Could not link session'}` (`:42-50`).
- **RPC semantics. Confirmed:** claims an unclaimed identity. Returns true if it's already owned by the same user and false if owned by someone else. It never merges or repoints (`supabase/migrations/00010_feed_review_fixes.sql:185-220`; `00011` drops the unsafe `link_anon_identity`).
- **Nothing calls this route. Confirmed:** no `fetch('/api/session/link')` anywhere in `src`. Account linking is effectively unused on web.

#### 1.5 CSRF and origin checks
- **No route handler checks `Origin` or `Referer`, and there are no CSRF tokens. Confirmed** (grep).
- **Inferred:** protection rests entirely on `SameSite=Lax` for both the `sb-*` cookies and `drip_aid`. Lax cookies aren't sent on cross-site `fetch`/XHR or cross-site POST forms.
- GET routes with side effects:
  - `GET /api/stripe/onboarding/status` writes `seller_payments.charges_enabled` (`status/route.ts:48-55`).
  - `GET /api/stripe/onboarding/refresh` mints a Stripe account link and redirects (`refresh/route.ts:35-45`).
  - Both are idempotent and owner-scoped, so the impact is low.
- **No CORS headers or OPTIONS handlers anywhere. Confirmed** (grep `Access-Control`). `next.config.ts` is empty. That's irrelevant to a native client, because CORS is enforced only by browsers.

#### 1.6 Rate limiting
- **Implementation. Confirmed:** an in-memory sliding window per serverless instance (`src/lib/rate-limit.ts:6-23`).
  - The whole map is cleared once it has more than 10,000 keys (`:12`).
  - Client IP is the first `x-forwarded-for` value, then `x-real-ip`, then `'unknown'` (`:25-31`).
  - **Inferred:** on Vercel the platform sets XFF. Self-hosted, the client can spoof it.

| Key | Limit | Location |
|---|---|---|
| `feed:<ip>` | 60/min | `api/feed/route.ts:33` |
| `search:<ip>`, `search:anon:<id>` | 60/min, 30/min | `api/search/route.ts:25, 45` |
| `events:ip:<ip>`, `events:anon:<id>` | 100/min, 20/min | `api/events/route.ts:55, 78` |
| `checkout:<ip>` | 10/min | `api/checkout/route.ts:16` |
| `intent:<ip>` | 12/min | `api/checkout/intent/route.ts:31` |
| `report:<ip>` | 5/min | `api/report/route.ts:14` |
| `waitlist:<ip>` | 5/min | `api/waitlist/route.ts:15` |
| Seller routes, webhooks, `/auth/callback`, session/link | none | (Confirmed) |

---

### 2. Endpoint catalogue (HEAD)

**Error format.** Every route uses `{"error": "<human message>"}` with an HTTP status. Exceptions:
- Some 413/429/202 responses have **no body**: events `:47, :52, :56, :79, :102` and search `:46`.
- Intent's sold-out 409 adds `code` and `available`: `{"error":"Sold out","code":"sold_out","available":N}` (`checkout/intent/route.ts:75-79`).
- Zod errors on seller routes return the first issue's message: `drops/route.ts:55-60`, `discounts/route.ts:45-51`, `settings/address/route.ts:20-26`, `waitlist/route.ts:22-28`.

**Legacy schema.** Migration `00007_feed_content_model.sql` drops `public.drops` (`:570`), `orders.drop_id` (`:495`), `waitlist_entries.drop_id` (`:477-482`) and `reports.drop_id` (`:487-491`). Routes marked **LEGACY** below still use those, so they fail against the post-00007 schema.
- Confirmed that the code references the dropped objects.
- Inferred about production: `src/app/api/webhooks/stripe/route.ts:9-29` says migrations are applied to prod by hand, later.

| # | Path | Methods | Auth | Request schema | Response (200 unless noted) | Errors | Side effects | File |
|---|---|---|---|---|---|---|---|---|
| 1 | `/api/feed` | GET | anon: signed `drip_aid` cookie, or unsigned `x-drip-anon-id` | Query, zod: `session_id` uuid (req); `surface` enum for_you\|following\|category\|seller_profile\|search\|shared_link (default for_you); `exclude_ids` string ≤8000 (comma list, lowercase uuids, first 300 kept); `category` ≤40; `seller` ≤40; `mode` default\|diversify (default default); `offset` int 0–5000 (default 0); `before` ISO datetime with offset | `FeedResponse` (see §5). Header `Cache-Control: private, no-store` | 429 `Slow down a moment.`; 400 `No viewer identity`; 400 `Invalid request`; 500 `Could not load the feed` | Reads videos, products, profiles, seller_payments, viewer_blocks, viewer_profiles, follows, orders, feed_slices, feed_weights. **Writes `feed_slices`** (upsert, ignore dupes) | `src/app/api/feed/route.ts:15-92` |
| 2 | `/api/events` | POST | anon: **signed cookie only** | Body (JSON or text/plain), ≤32 KB: `{sid: uuid, sf: surface enum, sent_at?: int, e: unknown[1..50]}`. Each event is validated separately (see §5.2) | **202** `{"accepted":n,"deduped":n,"discarded":n}`; 202 with empty body if every event failed zod | 413 (empty); 429 (empty); 401 `No viewer identity`; 400 `Invalid batch` | RPC `ingest_feed_events` (feed_events, feed_event_dedupe, viewer_video_counters, viewer_blocks, viewer_video_reactions, follows, viewer_identities); `viewer_identities.issued_ip_hash`; `recordFeedEventsForAffinity` (viewer_profiles) | `src/app/api/events/route.ts:10-154` |
| 3 | `/api/search` | GET | anon: signed cookie, or unsigned `x-drip-anon-id` (**route not in proxy matcher**) | Query: `session_id` uuid; `q` 1–200 chars; `exclude_ids` ≤8000; `category` ≤40; `seller` ≤40 | `FeedResponse` with `surface:'search'`, `mode:'default'`, `nextBefore:null`. Header `Cache-Control: private, no-store` | 429 json; 400 `No viewer identity`; 400 `Invalid request`; 429 empty (per anon); 500 `Could not search` | RPC `search_feed_videos`; **writes `feed_slices`** | `src/app/api/search/route.ts:11-85`; `src/lib/search/slice.ts:64-147` |
| 4 | `/api/checkout/intent` | POST | anon: **signed cookie only** | `{video_id: uuid, product_id: uuid, quantity?: int 1–10 = 1, selection?: Record<string≤24,string≤24>, idempotency_key: string 16–64, email?: email ≤120}` | `{"clientSecret":"pi_..._secret_...","paymentIntentId":"pi_...","subtotalCents":2500,"shippingCents":595,"totalCents":3095,"title":"...","sellerHandle":"..."}` | 429 `Too many attempts...`; 400 `No viewer identity`; 400 `Invalid request`; 404 `That item is not available here`; 409 `This drop is no longer available`; 409 sold_out (see above); 409 `This seller cannot take payments right now`; 500 `Something went wrong on our side. You have not been charged.` | Stripe `paymentIntents.create` (destination charge, `application_fee_amount`, metadata `drip_video_id`/`drip_product_id`/`drip_seller_id`/`drip_anon_id`/`drip_quantity`/`drip_subtotal_cents`/`drip_shipping_cents`/`drip_selection`, idempotency key `pi_<key>`); shipping estimate (EasyPost, via `estimateFlatShippingCents`). No DB writes (the order is written by the webhook) | `src/app/api/checkout/intent/route.ts:11-193` |
| 5 | `/api/checkout` | POST | none (**LEGACY**) | `{drop_id: uuid, selection?: Record<≤20,≤20>, code?: string ≤20}` | `{"url":"https://checkout.stripe.com/..."}` | 429; 400 `Invalid request`; 404 `This drop is not available`; 409 `Sold out`; 400 `Please select a <dim>`; 409 `Seller cannot accept payments right now`; 400 `Invalid discount code`; 500 `Could not start checkout` | Stripe `checkout.sessions.create` (30-minute expiry, US shipping, coupon) | `src/app/api/checkout/route.ts:8-196` |
| 6 | `/api/session/link` | POST | user (cookie) + anon cookie | none | `{"linked":true\|false}`; may Set-Cookie `drip_aid` | 401 `Not signed in`; 500 `Could not link session` | RPC `claim_anon_identity` (viewer_identities) | `src/app/api/session/link/route.ts:6-51` |
| 7 | `/api/dashboard/stats` | GET | user (seller) (**LEGACY**: `orders.drop_id`, `drops`) | none | `{"total_revenue_cents":0,"total_sales":0,"pending_payout_cents":0,"available_payout_cents":0,"per_drop":{"<drop_id>":{"views":0,"sales":0,"revenue_cents":0}}}` | 401 `Not authenticated` | Stripe `balance.retrieve` on the connected account; Mux view counts | `src/app/api/dashboard/stats/route.ts:7-88` |
| 8 | `/api/discounts` | GET | user | none | `{"discounts":[{"id","code","percent_off","active","created_at"}]}` | 401; 500 `Failed to load discount codes` | none | `src/app/api/discounts/route.ts:6-27` |
| 8b | `/api/discounts` | POST | user | `createDiscountSchema`: `{code: string 3–20 [A-Za-z0-9]+ (upper-cased), percent_off: int 1–100}` (`src/lib/validation.ts:52-60`) | `{"discount":{"id","code","percent_off","active","created_at"}}` | 401; 400 (zod message); 409 `You already have a code with that name`; 500 `Failed to create discount code` | Stripe `coupons.create` (and `coupons.del` on failure); insert `discount_codes` | `discounts/route.ts:32-88` |
| 8c | `/api/discounts?id=<id>` | DELETE | user | query `id` (not validated) | `{"deactivated":true}` (also returned when no row matched) | 401; 400 `Missing id`; 500 `Failed to deactivate code` | update `discount_codes.active=false` scoped to `seller_id` | `discounts/route.ts:91-118` |
| 9 | `/api/drops` | POST | user + profile + `charges_enabled` + from_address (**LEGACY**: `drops` table) | `createDropSchema`: `{title 1–100, description? ≤280, price_cents int 100–99,999,900, inventory int 1–100000, weight_oz 0.1–1120, dimensions{length_in,width_in,height_in 0.1–108}, variants? [{name 1–20, options string[1–5] (each 1–20)}] (max 2)}` (`validation.ts:3-27`) | `{"drop":{"id","slug"},"upload_url":"https://storage.googleapis.com/..."}` (Mux direct upload) | 401; 400 `Profile not found`; 403 `Complete Stripe onboarding...`; 400 `Add your ship-from address...`; 400 zod; 500 `Failed to create drop` / `Failed to create video upload` | insert/update/delete `drops`; Mux `video.uploads.create` (`cors_origin`=APP_URL, public playback, passthrough=drop id) | `src/app/api/drops/route.ts:8-122` |
| 10 | `/api/drops/{id}/restock` | POST | user, owner (**LEGACY**) | `{inventory: int 1–100000}` | `{"inventory":N,"waitlist_notified":n}` | 401; 400 `Invalid inventory amount`; 404 `Drop not found`; 500 `Failed to update inventory` | update `drops.inventory`; admin update `waitlist_entries.notified_at`; Resend `sendBackInStock` per entry (sequential) | `src/app/api/drops/[id]/restock/route.ts:7-85` |
| 11 | `/api/orders/{id}/retry-label` | POST | user, owner via `.eq('seller_id', user.id)` + RLS | none | `{"label_created":true}` | 401; 404 `Order not found`; 409 `A label already exists for this order`; 502 `<error>` or `Label purchase failed — try again shortly` | `fulfillOrder`: EasyPost `buyLabel`; update `orders` (tracking, label_url, status=label_created); Resend seller email | `src/app/api/orders/[id]/retry-label/route.ts:9-56`; `src/lib/fulfillment.ts:165-260` |
| 12 | `/api/orders/export` | GET | user (**LEGACY** embed `drops(title, slug)`) | none | `text/csv` attachment `drip-orders-YYYY-MM-DD.csv`; columns `order_id,date,item,buyer_name,buyer_email,ship_to_street,ship_to_city,ship_to_state,ship_to_zip,total_usd,shipping_usd,status,tracking_code` | 401; 500 `Failed to load orders` | none | `src/app/api/orders/export/route.ts:11-79` |
| 13 | `/api/report` | POST | none (**LEGACY**: `drops`, `reports.drop_id`) | `{drop_id: uuid, reason: prohibited_item\|copyright\|scam\|other, details? ≤500, reporter_email? email ≤254}` | `{"reported":true}` | 429; 400 `Invalid report`; 404 `Drop not found`; 500 `Could not submit report` | insert `reports` | `src/app/api/report/route.ts:6-50` |
| 14 | `/api/settings/address` | PUT | user | `fromAddressSchema`: `{name 1–60, street1 1–100, street2? ≤100, city 1–60, state US_STATES enum, zip /^\d{5}(-\d{4})?$/, country 'US' (default)}` (`validation.ts:40-48`) | `{"saved":true}` | 401; 400 zod; 500 `Failed to save address` | admin upsert `seller_payments.from_address` (`seller_id = user.id`) | `src/app/api/settings/address/route.ts:7-55` |
| 15 | `/api/stripe/onboarding/start` | POST | user + profile row | none | `{"url":"https://connect.stripe.com/setup/..."}` | 401; 400 `Complete your profile before connecting Stripe`; 500 `Failed to save Stripe account` / `Failed to start Stripe onboarding` | Stripe `accounts.create` (Express, US, individual) if none exists; admin upsert `seller_payments.stripe_account_id`; `accountLinks.create` (refresh/return URLs on APP_URL) | `src/app/api/stripe/onboarding/start/route.ts:6-105` |
| 16 | `/api/stripe/onboarding/status` | GET | user | none | not connected: `{"connected":false,"charges_enabled":false,"requirements":[]}`; connected: `{"connected":true,"charges_enabled":bool,"payouts_enabled":bool,"details_submitted":bool,"requirements":[string],"disabled_reason":string\|null}` | 401; 500 `Failed to check Stripe status` | Stripe `accounts.retrieve`; admin update `seller_payments.charges_enabled` | `src/app/api/stripe/onboarding/status/route.ts:9-69` |
| 17 | `/api/stripe/onboarding/refresh` | GET | user (cookie); browser redirect target | none | **302** to a Stripe account link; 302 `/auth/login` without a session; 302 `/onboarding/stripe` with no account; 302 `/onboarding/stripe?error=refresh_failed` | (redirects) | Stripe `accountLinks.create` | `src/app/api/stripe/onboarding/refresh/route.ts:8-50` |
| 18 | `/api/waitlist` | POST | none (**LEGACY**: `drops`, `waitlist_entries.drop_id`) | `{drop_id: uuid, email: email ≤254, name? ≤60}` | `{"joined":true}` (a duplicate counts as success) | 429; 400 zod; 404 `This drop is not available`; 500 `Could not join the waitlist` | insert `waitlist_entries` | `src/app/api/waitlist/route.ts:6-55` |
| 19 | `/api/webhooks/stripe` | POST | `stripe-signature` via `constructEvent(STRIPE_WEBHOOK_SECRET)` | Stripe event | `{"received":true}` or `{"received":true,"duplicate":true}` | 400 `Missing signature` / `Invalid signature`; 500 `Event claim failed` / `Handler failed` (claim released for retry) | `processed_events` claim; `account.updated` updates `seller_payments.charges_enabled`; `checkout.session.completed` (legacy) and `payment_intent.succeeded` (feed): decrement inventory RPC, refund on oversell, insert `orders` + `order_items`, `fulfillOrder` (EasyPost + Resend) | `src/app/api/webhooks/stripe/route.ts:347-432` (handlers `:163-345`) |
| 20 | `/api/webhooks/mux` | POST | `mux-signature` HMAC with a 300 s tolerance (`src/lib/mux.ts:57-90`) | Mux event | `{"received":true}` / duplicate | 400 `Invalid signature` / `Invalid payload`; 500 | `processed_events`; update `drops` (**LEGACY**: no `videos` handling) | `src/app/api/webhooks/mux/route.ts:16-103` |
| 21 | `/api/webhooks/easypost` | POST | `x-hmac-signature` HMAC over the body (`src/lib/easypost.ts:110-126`) using `EASYPOST_WEBHOOK_SECRET ?? ''` | EasyPost event | `{"received":true}` / duplicate | 400 `Invalid signature` / `Invalid payload`; 500 | `processed_events`; `orders.status` → shipped/delivered; Resend `sendBuyerDelivered`. Selects `orders.drop_id` and `drops` (**LEGACY**) | `src/app/api/webhooks/easypost/route.ts:19-97` |
| 22 | `/auth/callback` | GET | none | query `code`, `next` (default `/onboarding`) | 302 to `next` (sets `sb-*` cookies) or `/auth/login?error=auth_failed` | (redirects) | Supabase `exchangeCodeForSession` | `src/app/auth/callback/route.ts:4-20` |

---

### 3. Native client classification

**Key**
- **(a)** usable as-is
- **(b)** usable after Bearer-token or signed-anon-header support
- **(c)** server-only, never called by the app
- **(d)** needs a new endpoint

| Endpoint | Class | Notes for Swift |
|---|---|---|
| GET `/api/feed` | **(a), with caveat** | Works if the app keeps `HTTPCookieStorage` (the URLSession default config). The first call goes through the proxy, which mints the id, forwards it in `x-drip-anon-id` and sets the `drip_aid` cookie. URLSession then replays the cookie, because `HttpOnly` doesn't affect it (**Inferred**). It's fragile: an ephemeral or cleared cookie store forks the device into a new viewer, and the proxy mints a new id on every cookie-less call. **Recommended: (b)** with an explicit signed anon header (below). Don't depend on the unsigned `x-drip-anon-id` fallback. |
| POST `/api/events` | (a) with a cookie jar, else **(b)** | Cookie-only at HEAD (`events/route.ts:72-76`). It needs the same `drip_aid` the feed call received, or the events land on a different viewer. |
| GET `/api/search` | (a), but insecure | It accepts any client-chosen `x-drip-anon-id` (see 4.3). Use the signed header once it exists. |
| POST `/api/checkout/intent` | (a) with a cookie jar, else **(b)** | Also see "Checkout specifics" below. |
| POST `/api/session/link` | **(b)** | Needs Bearer for the user and a signed anon header for the device. On a missing anon id it should return a token, not a cookie. Unused on web today. |
| Seller routes: discounts (GET/POST/DELETE), settings/address, stripe/onboarding/start, stripe/onboarding/status, orders/{id}/retry-label | **(b)** | Cookie-only today. See "Bearer change" below. |
| `/api/dashboard/stats`, `/api/orders/export`, `/api/drops`, `/api/drops/{id}/restock` | **(b) + (d)** | Bearer alone isn't enough: they read the dropped `drops` table and `orders.drop_id`. The app needs videos/products-model replacements, such as video+product creation with a Mux upload URL and stats keyed by `video_id`. Nothing in the API currently creates `videos` rows. Only the service role can move a video out of `processing` (`00007_feed_content_model.sql:199-231`), and the Mux webhook only knows `drops`. |
| GET `/api/stripe/onboarding/refresh` | **(c), browser-only** | Stripe redirects a browser here. In an `ASWebAuthenticationSession` the request carries no Bearer, and usually no cookie, so it bounces to `/auth/login` (`refresh/route.ts:14-16`). Native onboarding needs `refresh_url`/`return_url` that route back to the app (universal link) plus an app-side re-call of `start`. Both URLs are hard-coded to APP_URL (`start/route.ts:95-96`). |
| `/api/checkout`, `/api/waitlist`, `/api/report` | **(d)** | Legacy `drop_id`. For native: buying uses `checkout/intent`. Waitlist and report need product/video-keyed versions. The `report` event is ingested as telemetry only and doesn't insert `reports` (`00008_viewer_identity_and_events.sql:349-539`, Confirmed). |
| `/api/webhooks/*` | **(c)** | |
| `/auth/callback` | **(c)** | Native should use supabase-swift directly: PKCE with a custom-scheme or universal-link redirect added to Supabase's allowed redirect URLs (**Inferred**, config outside the repo). |

#### Missing for a native app: (d), all Confirmed absent
1. **Reaction and follow state read-back.**
   - Likes, saves and follows can be *written* through `/api/events`: `like/unlike/save/unsave/follow/unfollow/not_interested` have server side effects in `ingest_feed_events` (`00008:499-529`).
   - Nothing *reads* them back. `FeedItem` has no `liked`/`saved`/`following` fields (`src/lib/feed/types.ts:31-50`), and no endpoint lists saved videos (index `idx_reactions_saved` exists, `00008:85-86`) or followed sellers.
   - Proposed: optional `viewer: {liked, saved, followingSeller}` on `FeedItem`, plus `GET /api/me/saved` and `GET /api/me/following`.
   - Partly addressed since: `8a1e20f` adds `GET /api/me/reactions` for per-id state (§7).
2. **Following surface.** `surface=following` is accepted but ignored: neither slice path reads `surface` (`src/lib/feed/slice.ts:24-40, 60-157`; `ranked-slice.ts:221-339`). A `following` feed returns the general feed.
3. **Single video / shared link.** There's no `GET /api/videos/{id}` for `shared_link` deep links.
4. **Comments.** No table, no route (table list in migrations).
5. **Buyer order status/history.** Orders carry `buyer_anon_id` (`webhooks/stripe/route.ts:319`), but nothing returns them to the buyer.
6. **Account deletion and push-token registration.** Neither exists. **Inferred:** App Store guideline 5.1.1(v) requires in-app account deletion for apps that create accounts.
7. **Seller profile page.** The feed already supports it: `/api/feed?surface=seller_profile&seller=<handle>` filters on `profiles.handle` (`slice.ts:106`; `pool.ts:218`). That's (a), but no profile-header endpoint exists (avatar, bio, follower count).

#### Bearer change: what must change
- `createServerClient_()` must detect `Authorization: Bearer <jwt>`. If present, build `createClient(URL, ANON_KEY, {global:{headers:{Authorization:`Bearer ${jwt}`}}, auth:{persistSession:false}})` so PostgREST enforces RLS as that user. Verify with `supabase.auth.getUser(jwt)`, which calls Supabase Auth.
- Without the explicit `jwt` argument, `getUser()` on a stateless client has no session to read. Every route calls it argument-less. So either pass the token at each call site, or pin it as the default.
- `src/lib/supabase-server.ts:6-58` in `8a1e20f` does the second option: `client.auth.getUser = (jwt?) => getUser(jwt ?? token)`.
- No route needs changes beyond that, because they all use `user.id` from `getUser()` and service-role writes are pinned to it.
- `/api/stripe/onboarding/refresh` stays browser-only.

#### Anon identity: minimal backward-compatible proposal
- **Signed header.** Add `x-drip-anon-token: v1.<uuid>.<sig>`, verified with the same `verifyAnonId`, and accept it wherever the cookie is accepted. Check the cookie first, so browsers are unchanged.
- **Mint endpoint.** Add `POST /api/session/anon` returning `{anonId, token}`. The app stores the token in the Keychain.
- **Unsigned header.** Stop trusting the unsigned `x-drip-anon-id` from clients:
  - make the proxy delete any incoming `x-drip-anon-id` before forwarding;
  - add `/api/search` and `/search` to the matcher;
  - or have the proxy sign the header it forwards.
- **Casing.** Lowercase all UUIDs on the client. `UUID_RE` is lowercase-only for `x-drip-anon-id` and `exclude_ids` (`api/feed/route.ts:30, 42, 55-59`; `api/search/route.ts:22`). Swift's `UUID().uuidString` is **uppercase**: an uppercase anon id gets a 400, and uppercase exclude ids are **silently dropped**. Zod `.uuid()` accepts either case for `session_id`, `sid` and `v` (tested: zod 3.25.76).

#### Checkout specifics for native (Stripe PaymentSheet)
- **Shipping address.** The PaymentIntent is created with `shipping: undefined` (`checkout/intent/route.ts:159`).
  - On web, Stripe.js `AddressElement` (mode `shipping`) attaches it during `confirmPayment` (`src/components/feed/checkout-sheet.tsx:58-61, 114`).
  - The webhook copies `intent.shipping` into `orders.shipping_address` (`webhooks/stripe/route.ts:313-314`), and label purchase requires it (`fulfillment.ts:220`).
  - **The iOS app must collect the shipping address and set it on the PaymentIntent** (PaymentSheet shipping details), or orders will never get labels (**Inferred** for SDK behaviour).
- **Publishable key.** The response has no publishable key, so the app must embed it. It's the platform account (destination charge, `transfer_data`), so no `stripeAccount` is needed.
- **Receipt email.** Pass `email` for receipts and buyer emails. The web never does, so `buyer_email` is `''` (`webhooks/stripe/route.ts:312`).
- **Idempotency key.** Generate one per sheet open (16–64 chars). Reusing it with different params gets a Stripe idempotency error, which surfaces as a 500 (**Inferred**).
- **Variant selection.** Send `selection` as `{[VariantGroup.name]: VariantOption.value}`. The route matches `o.value === chosen || o.name === chosen` (`checkout/intent/route.ts:112-120`).

---

### 4. Security findings

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| 4.1 | **High** (if the env var is unset) | **EasyPost webhook fails open.** The secret defaults to `''`, and HMAC with an empty key is computable by anyone. A forged `tracker.updated` can mark any order `shipped`/`delivered` and trigger Resend "delivered" emails. There's no timestamp, so replays are only deduped by `event.id`. Mux (`MUX_WEBHOOK_SECRET!`) and Stripe fail closed. | `webhooks/easypost/route.ts:23-27`; `easypost.ts:110-126` | Confirmed (code); Inferred (env state) |
| 4.2 | Medium | **Open redirect in `/auth/callback`.** `next` is unvalidated, and `new URL(next, request.url)` accepts absolute URLs (`https://evil`) and protocol-relative ones (`//evil`). Only the success path redirects. PKCE needs the code verifier in the same browser, which limits drive-by use. | `auth/callback/route.ts:7, 14` | Confirmed (code); Inferred (exploitability) |
| 4.3 | Medium | **Unsigned anon-id header is trusted.** (a) `/api/search` and the `/search` page aren't in the proxy matcher, so a client-supplied `x-drip-anon-id` is used verbatim. (b) `/api/feed` does the same when `ANON_ID_SECRET` is unset, because the proxy passes through without minting. Impact: per-anon search rate limit bypassed by rotating the header; `feed_slices` rows written under arbitrary anon ids; serving shaped by another viewer's blocks/affinity. Rotating ids also creates more than 10k rate-limit keys, which **clears every bucket on that instance**. | `proxy.ts:15-24, 44-48`; `api/search/route.ts:29-47`; `api/feed/route.ts:37-46`; `search/slice.ts:137-144`; `rate-limit.ts:12` | Confirmed |
| 4.4 | Medium | **Anon-identity farming is still self-service.** The proxy mints a fresh signed id for any cookie-less request to `/feed` or `/api/feed`, with no rate limit. A script can GET `/api/feed`, take the `Set-Cookie`, and post events. The per-anon caps (1 impression and 1 purchase per anon per video) therefore don't bound a farmer, contrary to the comment in events. IP-hash provenance is only an offline signal. | `proxy.ts:38-68`; `events/route.ts:59-71`; `00008:461-467` | Confirmed (code); Inferred (impact on rollups) |
| 4.5 | Medium | **Client-asserted `purchase` events.** The web emits `purchase` from the browser after `confirmPayment`, and ingest accepts it from any client (1 per anon per video). This inflates purchase signals in the event stream and affinity (`DIRECT_POSITIVE` includes `purchase`). Purchases should come from the Stripe webhook only. | `checkout-sheet.tsx:71-76`; `events/route.ts:12-16`; `feed/affinity-update.ts:43-45` | Confirmed |
| 4.6 | Med-Low | **Double label purchase race.** `retry-label` checks `status==='paid'` and then calls `fulfillOrder`, which buys a label without a compare-and-set. Concurrent retries, or a retry racing the webhook, can buy two EasyPost labels. | `retry-label/route.ts:36-46`; `fulfillment.ts:220-235` | Confirmed |
| 4.7 | Med-Low | **Intent doesn't validate variant selection.** Unknown or omitted options are silently priced at base. Per-variant inventory isn't checked (only `products.inventory_count`). Arbitrary selection strings flow into metadata and `order_items.variant_snapshot`. | `checkout/intent/route.ts:75, 108-120`; `webhooks/stripe/route.ts:297-305` | Confirmed |
| 4.8 | Low (legacy) | **Seller can desync the discount fee basis.** The RLS `discount_codes_seller_all` (FOR ALL) lets a seller edit `percent_off` and `stripe_coupon_id` directly through PostgREST. Legacy `/api/checkout` computes the application fee from the DB `percent_off` while Stripe applies the real coupon, so the platform under-collects. | `00006_reconcile_forked_schema.sql:216-218`; `checkout/route.ts:101-116, 132-135, 172` | Confirmed (code); route is legacy |
| 4.9 | Low | **CSV formula injection.** `csvEscape` quotes but doesn't neutralise leading `= + - @` in buyer-controlled `buyer_name` and address fields. | `orders/export/route.ts:4-7, 56-66` | Confirmed |
| 4.10 | Low | **No Origin checks on cookie-authenticated mutating routes.** They rely on SameSite=Lax only (section 1.5). Supabase auth cookies are `httpOnly:false`, so any XSS steals tokens. | grep; `@supabase/ssr` defaults | Confirmed / Inferred |
| 4.11 | Low | **`DELETE /api/discounts` reports success when nothing matched.** The `id` isn't validated as a uuid. | `discounts/route.ts:101-117` | Confirmed |
| 4.12 | Low | **Rate limiter is per instance, trusts the first XFF value, and has no limit on any seller route or `/auth/callback`.** | `rate-limit.ts:6-31` | Confirmed |
| 4.13 | Info | **Anon token never expires and can't be rotated per id.** If a device token is stolen, the thief becomes that viewer, including their purchase-history-driven personalisation (`viewer-context.ts:124-136` reads `orders` by `buyer_anon_id`). | `anon-id.ts:69-70` | Confirmed |
| 4.14 | Info (correctness) | **Feed cursor skips one video per page.** `oldestSeen` is set to the row the loop breaks on, which isn't served. The next page uses `published_at < oldestSeen`, so that row is never served. | `src/lib/feed/slice.ts:118-121, 156` | Confirmed |
| 4.15 | Info (correctness) | **Like/save clobber each other.** A `like` batch upsert sets `saved_at` to NULL, and `save` sets `liked_at` to NULL, because each ON CONFLICT branch writes NULL when its own excluded value is NULL. Liking a saved video un-saves it. A native client relying on these events would show wrong state once read-back exists. | `00008_viewer_identity_and_events.sql:509-521` | Confirmed |
| 4.16 | Info | **Test drift.** The wire-contract test allows `lc ≤ 10000` but the route caps at 500, so an event with `lc` above 500 passes the test and is silently dropped in production. There are no tests for any route handler. | `src/lib/events/__tests__/wire-contract.test.ts:32` vs `events/route.ts:33` | Confirmed |
| 4.17 | Info | **Secrets.** No secret reaches a response. Stripe account ids and the from-address stay in `seller_payments` (no browser grants: `00006:498-510`). `clientSecret` goes only to the payer. Service-role clients are used on unauthenticated routes, but every query is scoped in code. | various | Confirmed |

**What a native client widens**
- Bearer tokens remove CSRF entirely for those requests.
- No CORS change is needed, and none should be added (`bearer.ts` comment, added in `8a1e20f`).
- The real widening is anonymous identity issued to non-browser clients. That's already possible through the proxy (4.4), so a mint endpoint needs IP limits and should feed 2.9 provenance.
- A Keychain-stored anon token and Supabase refresh token are long-lived bearer secrets.

---

### 5. Exact contracts for the Swift client

#### 5.1 `GET /api/feed`
- **Identity:** the `drip_aid` cookie (or, after the proposal, `x-drip-anon-token`). Lowercase uuids only.
- **Query** (`api/feed/route.ts:15-28`):
  - `session_id` (required uuid): generate one per app session and keep it for every feed/search/events call in that session. Lane attribution joins `feed_slices` on `(session_id, video_id)` (`00008:401-402`). Avoid `00000000-0000-0000-0000-000000000000`: it's the SSR placeholder and is never recorded (`types.ts:73-81`).
  - `surface`: default `for_you`. Currently ignored by serving (§3).
  - `exclude_ids`: comma-joined lowercase video ids already shown. String ≤8000 chars (about 216 ids); the server keeps the first 300 valid ones. Web sends the last 200 (`feed-shell.tsx:84-88`). The server also excludes everything `feed_slices` recorded for this `session_id`, up to 1000 (ranked: `ranked-slice.ts:258-269`; search: `search/slice.ts:54-95`).
  - `category` (category slug), `seller` (seller handle).
  - `mode`: echoed only.
  - `offset`: number of items already received. It's used for `feed_slices.position` and the ranked RNG seed.
  - `before`: pass back the last non-null `nextBefore` verbatim, URL-encoded because of the `+` in the offset.
- **Page size:** `FEED_SLICE_SIZE = 20` (`types.ts:83`). Prefetch when the viewer reaches index 15 of the buffer (`types.ts:85`).
- **Pagination:**
  - Naive path (the default unless a non-`control` `feed_weights` variant is active, `ranked-slice.ts:229-230`):
    - Reverse-chronological by `published_at`. Over-fetches 80 rows.
    - `nextBefore` is a `published_at` string while the underlying page was full, otherwise `null`.
    - `exhausted` is true only when the page was short **and** produced no items (`slice.ts:151-156`).
    - A page can legitimately have 0 items with a non-null `nextBefore`: re-request with it.
  - Ranked path: `nextBefore` is always `null`. Paging comes from growing exclusion plus the server-side session history. `exhausted` is true when there are no candidates (`ranked-slice.ts:240, 294, 316`).
  - Client stop rule, matching web (`feed-shell.tsx:96-104`): stop when `exhausted`, or when a page has no new `videoId`s and `nextBefore == null`. Dedupe by `videoId`.
- **Item filters applied server-side:**
  - video `status='live'`, `published_at` not null;
  - seller `charges_enabled`;
  - at least one product `active` with `inventory_count > 0` (at most 5, sorted by `position`);
  - viewer blocks (`slice.ts:66-128`; `products.ts:345-365`).
- **`position` in `FeedItem`** is the 0-based index *within this response*, not global (`slice.ts:147`; `ranked-slice.ts:332`).
- **Video playback:**
  - `playbackId` is a Mux **public** playback id (`drops/route.ts:104` sets `playback_policy: ['public']` on the legacy path; feed videos come from `videos.mux_playback_id`).
  - Web plays `https://stream.mux.com/{playbackId}/low.mp4` (`src/components/feed/feed-video.tsx:98`). **Inferred:** HLS `https://stream.mux.com/{playbackId}.m3u8` should also work for AVPlayer.
  - `thumbnailUrl` may be null. Fallback: `https://image.mux.com/{playbackId}/thumbnail.jpg` (pattern used at `checkout/route.ts:150`).
- **`src/lib/feed/types.ts`, verbatim:**

```ts
// The wire contract between /api/feed and the shell. Deliberately flat and
// small: it is fetched on the critical path and again every 15 slides.

export type FeedProduct = {
  id: string;
  title: string;
  priceCents: number;
  compareAtPriceCents: number | null;
  inventoryCount: number;
  lowStockThreshold: number;
  images: string[];
  variants: VariantGroup[];
  position: number;
  pinnedAtSecond: number | null;
};

export type VariantGroup = {
  id: string;
  name: string;
  options: VariantOption[];
};

export type VariantOption = {
  id: string;
  value: string;
  priceDeltaCents: number;
  inventoryCount: number;
  sku: string | null;
};

export type FeedItem = {
  videoId: string;
  playbackId: string | null;
  durationSeconds: number;
  aspectRatio: string | null;
  thumbnailUrl: string | null;
  caption: string | null;
  hashtags: string[];
  categorySlug: string | null;
  seller: {
    id: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
  };
  products: FeedProduct[];
  /** Which candidate lane produced this item. 'chrono' until ranking is live. */
  lane: FeedLane;
  position: number;
};

export type FeedLane = 'chrono' | 'affinity' | 'trending' | 'fresh' | 'social' | 'random';

export type FeedSurface =
  | 'for_you' | 'following' | 'category' | 'seller_profile' | 'search' | 'shared_link';

export type FeedResponse = {
  items: FeedItem[];
  /** Echoed so the client can keep excluding what it has already seen. */
  sessionId: string;
  surface: FeedSurface;
  /** True when the candidate pool is empty — the shell shows "all caught up". */
  exhausted: boolean;
  /**
   * Echoed but not yet honored. Step 10 (within-session adaptation) reads it;
   * keeping it in the contract now means the client never has to change.
   */
  mode: 'default' | 'diversify';
  /** published_at cursor for the next slice; null when the tail is reached. */
  nextBefore: string | null;
};

/**
 * The SSR page's throwaway session id — "the client owns session identity;
 * this first render only needs content, and the shell re-requests with its
 * real session id" (see `feed/page.tsx`). Every anonymous visitor's first
 * render shares this same value, so nothing may be written to `feed_slices`
 * keyed on it: that would collide every visitor's SSR slice into one
 * (session_id, video_id) primary key.
 */
export const SSR_PLACEHOLDER_SESSION_ID = '00000000-0000-0000-0000-000000000000';

export const FEED_SLICE_SIZE = 20;
/** Fetch the next slice when the viewer reaches this index of the buffer. */
export const FEED_PREFETCH_AT = 15;
```

- **Shaping notes** (`src/lib/feed/products.ts:309-338`):
  - `VariantGroup.id` falls back to `name`.
  - `VariantOption.id` falls back to `"<group>:<value>"`.
  - `value` falls back to the stored `name`.
  - `priceDeltaCents` and `inventoryCount` default to 0.
  - `images` defaults to `[]`.
  - `hashtags` defaults to `[]`.
  - `aspectRatio` is a free string, for example `"9:16"` (**Inferred** format).
- **Example response:**

```json
{
  "items": [{
    "videoId": "3f1c2a9e-1b2c-4d5e-8f90-a1b2c3d4e5f6",
    "playbackId": "a4nOgmxGWg6gULfcBbAa00gXyfcwPnAFldF8RdsNyk8M",
    "durationSeconds": 32,
    "aspectRatio": "9:16",
    "thumbnailUrl": null,
    "caption": "Hand-dyed tee, last 12",
    "hashtags": ["streetwear"],
    "categorySlug": "apparel",
    "seller": {"id": "9b0d...", "handle": "maya", "displayName": "Maya", "avatarUrl": null},
    "products": [{
      "id": "c7e1...", "title": "Dye Tee", "priceCents": 3800, "compareAtPriceCents": null,
      "inventoryCount": 12, "lowStockThreshold": 3, "images": ["https://..."],
      "variants": [{"id": "Size", "name": "Size", "options": [
        {"id": "Size:M", "value": "M", "priceDeltaCents": 0, "inventoryCount": 5, "sku": null}]}],
      "position": 0, "pinnedAtSecond": 4.5
    }],
    "lane": "chrono",
    "position": 0
  }],
  "sessionId": "8a7f6e5d-4c3b-4a29-8187-6f5e4d3c2b1a",
  "surface": "for_you",
  "exhausted": false,
  "mode": "default",
  "nextBefore": "2026-10-09T18:22:41.123456+00:00"
}
```

`pinnedAtSecond` is numeric. **Inferred:** the column type wasn't checked, so treat it as `Double?`.

#### 5.2 `POST /api/events`
- **Headers:** `Content-Type: application/json` (`text/plain` is also accepted). Identity: the `drip_aid` cookie (or, after the proposal, `x-drip-anon-token`). Body ≤32 KB.
- **Envelope** (`events/route.ts:38-43`):
  - `sid`: uuid. Use the same `session_id` as the feed calls.
  - `sf`: one of the six surfaces. An invalid `sf` rejects the whole batch with 400.
  - `sent_at`: optional ms epoch.
  - `e`: array of 1–50 events. Web flushes at 40, every 4 s, and on page hide (`src/lib/events/client.ts:32-33, 111-157`).
- **Event fields** (`events/route.ts:21-36`). Unknown keys are stripped. Invalid events are dropped silently, never the batch.
  - `t`: one of: `impression, watch_progress, skip, replay, product_tap, variant_select, add_to_cart, checkout_open, checkout_abandon, purchase, like, unlike, save, unsave, share, seller_profile_tap, follow, unfollow, not_interested, report, video_error`.
  - `v`: video uuid (required). It must exist in `videos`, or the event counts as `discarded` (`00008:399`).
  - `p?`: product uuid. It must be attached to `v` via `video_products`, or the event is discarded (`00008:416-420`).
  - `ts?`: int ms epoch. Clamped to now if older than 24 h or more than 5 min ahead (`events/route.ts:96-99`).
  - `pos?`: int 0–5000, position in feed.
  - `wm?`: watched ms, int 0–86,400,000. It must be ≤ server duration × (lc+1) × 1.1, or the event is discarded (`00008:409-415`).
  - `dm?`: client duration ms, int 0–3,600,000.
  - `lc?`: loop count, int 0–500.
  - `b?`: string ≤32. A bucket, `"25"|"50"|"75"|"95"` for `watch_progress`.
  - `meta?`: JSON object.
- **What web sends** (mirror this):
  - `impression {v,pos}`: once per video per viewer, ever (`feed-shell.tsx:145-148`).
  - `skip {v,wm,dm,lc,pos}`: on swipe-away. `wm` is cumulative including loops (`feed-shell.tsx:116-138`).
  - `watch_progress {v,b,wm,dm,lc,pos}` (`feed-shell.tsx:301-310`).
  - `video_error {v,pos}`.
  - `product_tap {v,p,pos}`.
  - `variant_select {v,p,meta:{group,value}}` (`product-sheet.tsx:164`).
  - `checkout_open {v,p,meta:{selection,quantity}}` (`feed-shell.tsx:377-382`).
  - `checkout_abandon {v,p,meta:{step:'quote'|'payment'}}` (`checkout-sheet.tsx:213-218`).
  - `purchase {v,p,meta:{intent,total}}` (`checkout-sheet.tsx:71-76`). See 4.5: prefer not to rely on it.
  - Native can also send `like/unlike/save/unsave/follow/unfollow/not_interested/share/seller_profile_tap/report`. Web doesn't send these yet.
- **Server semantics** (`00008:301-334, 449-529`):
  - Dedupe keys: `impression`, `purchase`, `not_interested` and `report` are per anon+video forever. `watch_progress` is per anon+video+bucket. `replay` is per anon+video+loop (≤16). `skip` is per session+video+lc. Everything else is per session+video+product+bucket+2-second bucket of `ts`.
  - Caps per anon+video: impressions 1, purchases 1, progress 20, other 200.
  - Side effects:
    - `not_interested` permanently blocks the video and blocks the seller for 30 days.
    - `like/save/unlike/unsave` update `viewer_video_reactions` (note bug 4.15).
    - `follow/unfollow` update `follows` (seller resolved from the video).
- **Response:** 202 `{"accepted":n,"deduped":n,"discarded":n}`.
  - `discarded` counts events that failed server-side sanity (unknown video, product not attached, `wm` too large).
  - `deduped` counts events lost to dedupe or caps.
  - Events dropped by zod in the route aren't counted.
  - An RPC failure still returns 202 with zeros, because it's swallowed (`events/route.ts:112-120`).
  - Other statuses: 401 means no signed identity, 400 `Invalid batch`, and 413/429 have empty bodies.
  - **Never retry in a loop.** Events are best effort.

---

### 6. Other noteworthy facts
- **Ranking is effectively off. Confirmed:** `control` is active at 100% traffic share in `feed_weights`, and `control` falls through to the naive feed (`ranked-slice.ts:198-230`). Expect `lane: "chrono"` everywhere until a non-control variant is given traffic.
- **Country gating. Confirmed:** comes from the `x-vercel-ip-country` header and defaults to `XX` (`ranked-slice.ts:46-57`). A native client can't set it meaningfully; it's set by the Vercel edge (**Inferred**).
- **Webhook idempotency. Confirmed:** handlers claim `processed_events(provider, event_id)` before processing and delete the claim on failure (`webhooks/stripe/route.ts:371-385, 423-430`). Feed orders are additionally deduped on `stripe_payment_intent_id` (`:274-279`).

---

### 7. Commit `8a1e20f` (landed during the audit)

This commit implements most of the section 3 proposal. Line numbers below refer to `8a1e20f`. Review:
- **New: `GET /api/me/reactions?video_ids=<uuid,...>&seller_ids=<uuid,...>`** (`src/app/api/me/reactions/route.ts:23-75`).
  - Auth: anon, signed cookie or `x-drip-anon-token`. 401 `No viewer identity`.
  - Limits: 120/min/IP. At most 50 ids per list, **lowercase only** (`parseUuidList`, `src/lib/validation.ts`). A malformed or uppercase id returns 400 `Invalid request`.
  - Returns `{"liked":[uuid],"saved":[uuid],"following":[uuid]}` with `Cache-Control: private, no-store`. 500 `Could not load reactions`.
  - Reads `viewer_video_reactions` and `follows` via the service role, scoped to the caller's anon id. Correctly scoped, no IDOR.
  - It inherits bug 4.15 (like and save clobber each other), so the state it returns will be wrong after mixed like/save actions.
  - This closes §3 (d)1 for per-item state. Saved and following *lists* are still missing.
- **New: cookie-first identity can fork a native device. Confirmed from code, behaviour Inferred.**
  - `resolveSignedAnonId` checks the **cookie before** `x-drip-anon-token`.
  - The proxy still mints and `Set-Cookie`s a new `drip_aid` on every cookie-less request to `/api/feed` and `/api/events` (matcher unchanged, `src/proxy.ts:15-24`).
  - So a Swift client that sends the header with the default URLSession config will store the proxy's cookie on its first feed call. From then on the cookie, a *different* identity, overrides the Keychain token.
  - The iOS client must set `httpShouldSetCookies = false` / `httpCookieStorage = nil`. Alternatively, the proxy should skip minting when a valid `x-drip-anon-token` is present.
- **`src/lib/bearer.ts:19-27`:** parses `Authorization: Bearer`, checks JWT shape, caps length at 4096. Correct.
- **`src/lib/supabase-server.ts:10-11, 46-58`:** Bearer takes precedence over cookies. Builds an anon-key client with a global Authorization header and pins `getUser` to the token, so verification hits Supabase Auth on each call. Correct, and RLS applies.
- **`src/lib/anon-request.ts`:** `resolveSignedAnonId` checks the cookie first, then `x-drip-anon-token` (≤256 chars, HMAC-verified). It's used in feed, search, events, intent and link.
  - **Gap:** feed and search *still* fall back to the unsigned `x-drip-anon-id` (diff at `api/feed/route.ts:37-39`, `api/search/route.ts:29-31`), and `/api/search` is still outside the proxy matcher. Finding 4.3 remains.
- **`src/app/api/session/anon/route.ts`:** returns `{anonId, token}` with `Cache-Control: private, no-store` and a limit of 10 mints per IP per hour.
  - **Concerns:**
    - (i) 10/hour/IP will 429 real first launches behind carrier CGNAT or campus NAT.
    - (ii) The idempotent branch only echoes when the *header* is valid, and that response lacks the `no-store` header (`:23-26`).
    - (iii) It isn't wired into 2.9 provenance: no `issued_ip_hash` at mint.
    - (iv) It doesn't stop proxy-based farming (4.4).
- **`session/link`:** now accepts the signed header, but when no anon id exists it still sets a *cookie* and returns no token, which is useless to native.
- **Not addressed:** the open redirect (4.2), the EasyPost fail-open (4.1), the legacy-schema routes, the missing read endpoints (§3 (d)) and the Stripe onboarding redirect URLs for native.


## Part D — Commerce, payments, Mux, fulfillment and App Store compliance

_Line numbers re-checked against `8a1e20f`._

### 0. Headline findings (read this first)

#### 0.1 The schema is split in two, so no purchase path works in production today
- **Confirmed.** Production is on `00001` + `00002` plus five out-of-band migrations. The chain `00006…00016` is marked "**NOT READY TO APPLY**": `docs/production-migration/PREFLIGHT.md:3`, `PREFLIGHT.md:13-19` (prod has 1 demo drop with no Mux video, `seller_payments.stripe_account_id = acct_demo_placeholder`, `from_address` NULL, 0 orders) and `PREFLIGHT.md:173-174`.
- **Before the chain (production today).**
  - Legacy `/api/checkout` selects `drops.variants`: `src/app/api/checkout/route.ts:36`.
  - Legacy `/api/drops` inserts `variants` and `status:'processing'`: `src/app/api/drops/route.ts:88-89`.
  - The reconcile migration says production has no `drops.variants`, `drops.mux_upload_id`, `discount_codes` or `waitlist_entries`: `supabase/migrations/00006_reconcile_forked_schema.sql:46-49`, `:186-218`, `:256`. The 00001 status CHECK allows only `active|archived`: `00001_initial_schema.sql:27`.
  - **Inferred:** drop creation, legacy checkout, discounts and waitlist all fail at PostgREST on prod. The feed path (`videos`, `video_products`) does not exist on prod either.
- **After the chain.** `00007` runs `DROP TABLE public.drops` (`00007_feed_content_model.sql:570`), `ALTER TABLE orders DROP COLUMN drop_id` (`:495`) and drops `decrement_inventory` (`:497`). Every legacy surface still reads or writes `drops`:
  - `api/checkout/route.ts:35`
  - `api/drops/route.ts:66,78,110`
  - `api/drops/[id]/restock/route.ts:36,49`
  - `api/waitlist/route.ts:33`
  - `api/report/route.ts:28`
  - `api/dashboard/stats/route.ts:30`
  - `api/orders/export/route.ts:24` (embeds `drops(title)`)
  - `dashboard/orders/page.tsx:61`
  - `[handle]/[slug]/page.tsx:27`
  - `[handle]/[slug]/thanks/page.tsx:24`
  - `webhooks/mux/route.ts:57,66,82`
  - `webhooks/easypost/route.ts:58,67`
  - `studio/videos/[videoId]/page.tsx:348`
- **No code path creates `videos`, `products`, `video_products` or `shipping_profiles` rows.** The only inserts are the 00007 backfill (`00007:335,360`). A repo grep for insert/upsert on those tables finds nothing in `src/` (**Confirmed**).
  - Studio's "new video" button still points at the legacy drops form: `src/lib/studio/types.ts:95-96`.
  - **After the chain, sellers have no way to publish anything into the feed (MISSING).**
- **Net (Inferred):** the only modern, coherent purchase path is feed → `/api/checkout/intent` → `payment_intent.succeeded` → `orders` + `order_items` → EasyPost label. It works only after the chain is applied, and only for backfilled content. The single backfilled drop has no video, so it lands as `processing` (`00006:307-338`).

#### 0.2 Highest-severity defects in the modern feed path
| # | Defect | Evidence | Label |
|---|---|---|---|
| 1 | Buyer email is never collected. The sheet's POST body has no `email` and there is no LinkAuthenticationElement. The webhook reads only `intent.receipt_email`, so `buyer_email=''` and no buyer confirmation or tracking email is sent. | `components/feed/checkout-sheet.tsx:183-189`, `:113-114`; `webhooks/stripe/route.ts:312,343` | Confirmed |
| 2 | The PI is created with `shipping: undefined`. The shipping address comes only from AddressElement at confirm time. If it is not attached, `fulfillOrder` skips the label (`status==='paid' && order.shipping_address`). | `checkout/intent/route.ts:158`; `lib/fulfillment.ts:220` | Confirmed (Inferred that Stripe.js attaches AddressElement shipping on `confirmPayment`) |
| 3 | The EasyPost webhook selects `orders.drop_id` and reads `drops`. Post-chain the select errors, `order` is null and the event is silently acked, so orders never move to `shipped`/`delivered`. | `webhooks/easypost/route.ts:56-60,67`; `00007:495,570` | Confirmed |
| 4 | Inventory is decremented before the order insert, outside any transaction. If the insert throws, the claim is released and Stripe retries, which decrements again (stock leak). | `webhooks/stripe/route.ts:286-291` then `:307-328`, release `:425-429` | Confirmed |
| 5 | The web feed plays `https://stream.mux.com/{id}/low.mp4`. Uploads never request MP4/static renditions (`video_quality:'basic'`, no `mp4_support`), so real seller videos likely 404. | `components/feed/feed-video.tsx:98`; `api/drops/route.ts:103-107` | Inferred |
| 6 | No refund, dispute or cancel webhooks. `orders.refunded_at`/`disputed_at` are never written by any code, but Studio money reads them. | `webhooks/stripe/route.ts:388-419`; `00007:409-410`; `studio/money/page.tsx:135,166` | Confirmed |
| 7 | No sales tax anywhere. `orders.tax_cents` exists but is never written; there is no `automatic_tax`. | `00007:406`; grep `tax` in `src/app/api` and `src/lib/stripe.ts` finds nothing | Confirmed |
| 8 | `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is read by the sheet but missing from `.env.local.example`. If it is unset, `stripePromise` resolves to null and the Pay button stays disabled. | `checkout-sheet.tsx:15-16,129`; `.env.local.example` | Confirmed |
| 9 | Terms say "Sellers are the merchant of record". The code uses destination charges with no `on_behalf_of`, which makes Drip the settlement merchant. | `app/legal/terms/page.tsx:12-15` vs `checkout/intent/route.ts:156-157`, `checkout/route.ts:167-177` | Confirmed (legal/tax impact Inferred) |

#### 0.3 Native-client work (committed during the audit in `8a1e20f`)
- `/api/checkout/intent` now resolves identity through `resolveSignedAnonId`: cookie first, then header `x-drip-anon-token` (`src/lib/anon-request.ts:15-28`; `checkout/intent/route.ts:35-38`).
- `POST /api/session/anon` mints the token for native clients: `src/app/api/session/anon/route.ts:21-42`.
- `createServerClient_()` accepts `Authorization: Bearer <supabase JWT>` (`src/lib/supabase-server.ts`, diff; `src/lib/bearer.ts:19-27`). Every seller route that uses `createServerClient_` (drops, discounts, restock, orders, onboarding, settings) therefore becomes native-callable.

---

### 1. Checkout flow end-to-end

#### 1.1 Stripe Connect model
- **Account type:** Express, US, individual. Capabilities `card_payments` and `transfers`; `debit_negative_balances: true` so refunds and disputes can be clawed back (`api/stripe/onboarding/start/route.ts:59-76`). **Confirmed.**
- **Charge type:** destination charges on the platform account (`transfer_data.destination` = seller's `stripe_account_id`).
  - Legacy: `checkout/route.ts:169`. Feed: `checkout/intent/route.ts:156`. **Confirmed.**
  - No `on_behalf_of`, `transfer_group` or `statement_descriptor` anywhere (grep). **Confirmed.**
  - Result: Drip is the merchant of record and settlement merchant, and the Stripe fee is debited from the platform balance. That is why the fee passthrough exists (`lib/stripe.ts:15-25`). **Confirmed.**
- **Application fee:** `applicationFeeAmount(item, total)` = `round(item × DRIP_FEE_BPS / 1e4)` + `round(total × 290 / 1e4) + 30`, capped at `total` (`lib/stripe.ts:26-41`). `DRIP_FEE_BPS = 0` (founding program), so the fee is the Stripe processing passthrough only. **Confirmed.**
- **Stripe client:** API version pinned to `2023-10-16`, `stripe@^14` (`lib/stripe.ts:7-10`, `package.json`). **Confirmed.**

#### 1.2 The two checkout entry points
| | Legacy `/api/checkout` (Checkout Session, redirect) | Feed `/api/checkout/intent` (PaymentIntent, in-sheet) |
|---|---|---|
| Caller | `[handle]/[slug]/drop-view.tsx:49` (storefront page) | `components/feed/checkout-sheet.tsx:179` |
| Catalog table | `drops` (`route.ts:34-38`) | `video_products ⋈ videos ⋈ products` (`intent/route.ts:51-56`) |
| Identity | none (IP rate limit 10/min, `:16`) | signed anon id required (`intent/route.ts:35-38`), IP rate limit 12/min (`:31`) |
| Price | `drop.price_cents`, variant validated but no deltas (`:48-56`, `:153`) | `products.price_cents` + per-option `price_delta_cents` from the DB (`intent/route.ts:109-119`) |
| Quantity | fixed 1 (`:155`) | 1–10 (`intent/route.ts:14`), `subtotal = unit × qty` (`:121`) |
| Discount | per-seller code → Stripe coupon via `discounts:[{coupon}]` (`:101-116`, `:166`) | **none** (no `code` in schema, `intent/route.ts:11-20`) |
| Shipping | flat estimate added as a line item (`:118-123`, `:157-164`); `shipping_address_collection: US` (`:141`) | flat estimate added to amount (`intent/route.ts:123-144`, fallback 595¢ `:141`); **no** shipping on PI (`:158`) |
| Tax | none | none |
| Idempotency | none on create (each click is a new Session); expiry 30 min (`:186`) | Stripe idempotency key `pi_${client key}` (`intent/route.ts:173`); key generated once per sheet open (`checkout-sheet.tsx:175`) |
| Returns | `{url}` (`:191`) | `{clientSecret, paymentIntentId, subtotalCents, shippingCents, totalCents, title, sellerHandle}` (`intent/route.ts:176-184`) |
| Webhook | `checkout.session.completed` | `payment_intent.succeeded` |

**Gate in both flows (Confirmed):** the seller must have a `seller_payments` row with `stripe_account_id`, `charges_enabled` and `from_address`. Legacy: `checkout/route.ts:70-94`. Feed: `intent/route.ts:87-105`.

**Shipping estimate (Confirmed).** EasyPost rates a parcel from the seller to a far-coast reference ZIP (NY or LA), takes the cheapest USPS rate, adds a 10% buffer and rounds up. Evidence: `lib/shipping.ts:13-14`, `:34`, `:72-80`. It falls back to a weight-tier table if there is no key, on any error, or after a 6-second timeout (`shipping.ts:17-24`, `:32`, `:38`, `:69`, `:77`, `:81-83`). The feed path defaults the parcel to 8 oz and 9×6×2 in when there is no shipping profile (`intent/route.ts:132-136`).

**Discount math (legacy, Confirmed).** The coupon applies across all line items, shipping included. The fee is computed on the discounted amounts (`checkout/route.ts:129-134`, `:172`). Coupons are created on the platform account with `duration: 'once'` (`api/discounts/route.ts:57-62`).

#### 1.3 Inventory reservation and oversell protection
- **No reservation at quote time.** Intent only checks `inventory_count >= quantity` (`intent/route.ts:74-79`). Legacy only checks `inventory > 0` (`checkout/route.ts:44-46`). **Confirmed.**
- **Decrement at webhook time.** It uses an atomic conditional UPDATE. **Confirmed.**
  - Modern: `decrement_product_inventory(uuid, smallint)` → new count or NULL (`00007:574-591`).
  - Legacy: 00001 BOOLEAN version (`00001:96-119`); 00006 INTEGER version (`00006:231-244`).
  - The handler treats both return conventions as sold out (`webhooks/stripe/route.ts:72-89`).
- **Oversell handling.** A full refund with `reverse_transfer` and `refund_application_fee` (`webhooks/stripe/route.ts:93-104`), and the order is recorded as `refunded` (`:201`, `:317`). **Confirmed.**
- **Gaps:**
  - Per-variant `inventory_count` is shown in the UI (`components/feed/product-sheet.tsx:44,151`; `lib/feed/products.ts:49`) but never checked or decremented server-side. **Confirmed.**
  - The quantity stepper caps at product-level inventory (`product-sheet.tsx:197`).
  - Variant selection is not required server-side in the feed path; a missing group is skipped (`intent/route.ts:113-114`). **Confirmed.**
  - Legacy drops store options as strings (`lib/validation.ts:5-8`). `toVariantGroups` drops non-object options (`lib/feed/products.ts:39`), so a backfilled product with variants renders a group with no chips and "Pick a …" blocks purchase (`product-sheet.tsx:72,218`). **Inferred.**
- **Double-decrement on retry:** see §0.2 #4. **Confirmed.**

#### 1.4 Webhook handling (`/api/webhooks/stripe`)
- **Signature verification:** `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)` (`webhooks/stripe/route.ts:349-367`). **Confirmed.**
- **Idempotency table:** `processed_events(provider, event_id)` with a UNIQUE constraint. The task brief calls it "webhook_events", but the migration is named `00002_webhook_events.sql` and the table is `processed_events` (`00002_webhook_events.sql:4-11`). **Confirmed.**
  - The handler claims the event before processing; a 23505 duplicate is acked (`route.ts:373-385`).
  - On handler error the claim is released and the handler returns 500 so Stripe retries (`:422-430`). Mux and EasyPost use the same pattern.
- **Events handled:**
  - `account.updated` → `seller_payments.charges_enabled` (`:389-403`).
  - `checkout.session.completed` (`:405-409` → `:163-243`).
  - `payment_intent.succeeded` (`:411-415` → `:262-345`).
  - Everything else is ignored (`:417-418`). **Confirmed.**
- **Not handled (Confirmed absent):**
  - `checkout.session.async_payment_succeeded` and `_failed`. Legacy delayed-payment sessions return early at `:174` and are never recorded.
  - `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.*`, `account.application.deauthorized`, `payout.*`.
- **Connect events caveat (Inferred).** `account.updated` for connected accounts is delivered only to a *Connect*-type endpoint, which has its own signing secret. One `STRIPE_WEBHOOK_SECRET` cannot verify both platform and Connect endpoints on the same URL. The polling fallback in `/api/stripe/onboarding/status` re-syncs `charges_enabled` (`api/stripe/onboarding/status/route.ts:45-55`).

#### 1.5 Order creation and status transitions
- **Writes are schema-adaptive.** They try the modern columns first and fall back to legacy on undefined-column codes (`webhooks/stripe/route.ts:9-36`, `:109-123`). **Confirmed.**
- **`order_items` snapshot:** best-effort and fire-and-forget (`void`) (`:128-157`, `:229-237`, `:332-340`). **Confirmed.**
- **Order de-duplication:**
  - Legacy: `orders.stripe_session_id` lookup (`:177-182`) plus UNIQUE (`00001:38`).
  - Feed: `stripe_payment_intent_id` lookup (`:274-279`) plus partial unique index (`00007:440-441`).
  - `orders.idempotency_key` and its unique index exist (`00007:403,438-439`) but are never written. **Confirmed.**
- **Status vocabulary.** 00007 allows `pending, paid, label_created, shipped, delivered, canceled, refunded, disputed` (`00007:433-436`). Before the chain, 00001 allows only `paid, label_created, shipped, delivered` (`00001:44`); 00006 adds `refunded` (`00006:250-252`). **Confirmed.**
- **Transitions that code actually performs (Confirmed):**
  - `paid` or `refunded` on insert (`stripe/route.ts:201,317`).
  - `paid → label_created` on label purchase (`lib/fulfillment.ts:228-236`).
  - `label_created → shipped` on EasyPost `in_transit`/`out_for_delivery` (`webhooks/easypost/route.ts:78-83`).
  - `→ delivered` (`:63-64`).
  - `pending`, `canceled` and `disputed` are never set.
- **Order RLS.** Sellers can only SELECT their own orders; all writes are service-role (`00006:545-549`). `tracking_code` is unique so EasyPost `.single()` cannot collide (`00006:553-554`). **Confirmed.**

#### 1.6 Fulfillment: EasyPost labels, emails, retry
- **`fulfillOrder` is called from both webhooks and from retry-label** (`lib/fulfillment.ts:165`).
  - It loads the order in modern or legacy shape (`:46-74`) and item info from `order_items` or `drops` (`:77-158`).
  - It buys a label only when `status==='paid' && shipping_address` (`:220`).
  - On success it writes `easypost_shipment_id`, `tracking_code`, `label_url` and `status='label_created'` (`:228-236`).
  - It never throws (`:264-268`). **Confirmed.**
- **`buyLabel`.** POSTs `/shipments`, filters USPS rates, buys the cheapest as a PDF, all on the **platform's** EasyPost account (`lib/easypost.ts:48-106`, `:79`, `:83-95`). The label cost is not deducted from the seller transfer. Shipping is collected from the buyer, so the platform carries the label cost against the buffered estimate. **Inferred** from absence of any transfer reversal or fee adjustment.
- **Retry label.** `POST /api/orders/[id]/retry-label` checks ownership through RLS (`route.ts:25-34`), allows only `status==='paid'` (`:36-41`), and calls `fulfillOrder(..., {sendBuyerEmail:false})` (`:44-46`). The UI button is at `dashboard/orders/page.tsx:79`. **Confirmed.**
- **Emails (Resend).** Best-effort; a missing key logs and skips (`lib/emails.ts:5-28`).
  - Templates: seller "new sale + label + packing slip" (`:59-87`), buyer confirmation (`:89-113`), delivered (`:115-129`), back-in-stock (`:131-147`).
  - **No HTML escaping** of seller- or buyer-controlled strings (title, buyer name, address) in the HTML bodies (`:52-57`, `:73`, `:102`, `:125`, `:142`): an HTML-injection risk in emails. **Confirmed.**
  - `RESEND_FROM_EMAIL` defaults to `onboarding@resend.dev` (`:13`).
- **Refunds.** The only refund code path is the automatic oversell refund (`webhooks/stripe/route.ts:93-104`). There is no seller or admin refund endpoint, no cancel-order flow and no label void. **Confirmed (MISSING).**

#### 1.7 Cart, single vs multi-item, guest checkout
- **No cart. Every purchase is one product line.** **Confirmed.**
  - Legacy: quantity 1 (`checkout/route.ts:155`).
  - Feed: one `product_id` × quantity 1–10 (`intent/route.ts:12-14`); the sheet shows "1 item" (`checkout-sheet.tsx:91`).
  - Schema is cart-ready (`order_items`, "same-seller cart" comment) but unused (`00007:449-464`).
- **Guest checkout: yes.** Buyers have no accounts (`checkout/route.ts:30-31`; `00006:540-541`). **Confirmed.**
  - Legacy fields: Stripe Checkout collects email, name and a US shipping address (`checkout/route.ts:141`; webhook reads `customer_details` and `shipping_details`, `stripe/route.ts:190-207`).
  - Feed fields: PaymentElement plus AddressElement (shipping, US) (`checkout-sheet.tsx:113-114`). Email is **not** collected (§0.2 #1). The intent schema already accepts an optional `email` and maps it to `receipt_email` (`intent/route.ts:19`, `:169`).
- **Buyer identity on orders:** `buyer_anon_id` from the signed anon id (`stripe/route.ts:319`; `intent/route.ts:163`). **Confirmed.**
- **Redirect-based methods (Inferred).** `automatic_payment_methods` is enabled (`intent/route.ts:152`). The sheet calls `confirmPayment({redirect:'if_required'})` with no `return_url` (`checkout-sheet.tsx:58-61`). A redirect-type method (Klarna, Cash App, etc.), if enabled on the account, would error.

---

### 2. Mux

- **Upload creation: direct uploads.** **Confirmed.**
  - `mux.video.uploads.create({cors_origin: NEXT_PUBLIC_APP_URL, new_asset_settings:{playback_policy:['public'], passthrough: drop.id, video_quality:'basic'}})` (`api/drops/route.ts:99-108`).
  - The upload id is saved on `drops.mux_upload_id` (`:110`).
  - The browser uploads with `<MuxUploader endpoint={upload_url}>` (`dashboard/drops/new/page.tsx:3,55,76,95-99`).
  - On Mux failure the drop row is deleted (`api/drops/route.ts:116-121`).
- **Playback policy: PUBLIC.** No signed policy, no signing keys and no JWT minting anywhere (grep `signed` and `playback_policy`). **Confirmed.**
- **Webhook `/api/webhooks/mux`.** **Confirmed.**
  - Verifies HMAC `t=…,v1=…` with a 300-second tolerance and timing-safe compare (`lib/mux.ts:57-90`; `route.ts:20-22`), then applies the `processed_events` idempotency (`:34-46`).
  - `video.asset.ready`: if duration > 61 s → drop `rejected` (`:55-62`); else → `mux_asset_id`, `mux_playback_id = playback_ids[0].id`, `status='active'`, guarded by `status='processing'` (`:64-73`).
  - `video.asset.errored` and `video.upload.errored` → `rejected` (`:77-87`).
  - Duration, aspect ratio and thumbnail are **not** persisted.
- **Asset → row mapping.** `passthrough = drops.id` writes to the **`drops`** table only. There is no mapping to `videos`. Post-chain, the update targets a dropped table; the error is not checked, so the event is silently acked (`webhooks/mux/route.ts:65-73`). **Confirmed (BROKEN post-chain).**
  - The `videos` table has `mux_upload_id`, `mux_asset_id`, `mux_playback_id`, `duration_seconds`, `aspect_ratio`, `thumbnail_url` and a `live ⇒ playback_id` CHECK (`00007:126-155`).
  - Seller writes to those columns are blocked by `guard_video_status`; only the service role can set them (`00007:199-233`).
- **Thumbnails.** Built ad hoc from `image.mux.com`: OG image (`[handle]/[slug]/page.tsx:51`), Checkout product image (`checkout/route.ts:150`), demo posters (`feed/demo/fixtures.ts:56`). The feed poster uses `videos.thumbnail_url` (`feed-shell.tsx:296`), which no code writes; it is populated only by backfill from `drops.image_url` (`00007:336-338`). **Confirmed.**
- **How playback ids reach the feed.**
  - `getFeedSlice` selects `videos.mux_playback_id` where `status='live'` and the seller is `charges_enabled` (`lib/feed/slice.ts:83-101`), mapped to `FeedItem.playbackId` (`:132`; type `lib/feed/types.ts:31-33`).
  - `/api/feed` uses the service-role client (`api/feed/route.ts:62`).
  - The web player is a plain `<video src="https://stream.mux.com/{id}/low.mp4">` (`components/feed/feed-video.tsx:98-117`); the legacy storefront uses `<MuxPlayer>` (`drop-view.tsx:3,92`). **Confirmed.** `low.mp4` concern: §0.2 #5.
- **What a native AVPlayer needs (Proposed).**
  - Use HLS: `https://stream.mux.com/{playback_id}.m3u8` with no token while the policy is public. This needs no MP4 renditions and gives ABR.
  - Poster: `https://image.mux.com/{playback_id}/thumbnail.jpg?time=…&width=…`. Animated: `…/animated.gif|webp`.
  - The feed JSON already carries `playbackId`, `thumbnailUrl`, `durationSeconds` and `aspectRatio` (`lib/feed/types.ts:31-36`); the client builds the URL.
  - If signed playback is adopted later, the server must mint per-playback JWTs (RS256 with a Mux signing key) and return `?token=` URLs. That would need new secrets `MUX_SIGNING_KEY_ID` and `MUX_SIGNING_PRIVATE_KEY`, which are server-only. Not needed today.
- **Mux Data.** View counts per asset over 90 days, best-effort (`lib/mux.ts:21-53`).

---

### 3. Creator / seller tooling

| Feature | Where | Status | Notes |
|---|---|---|---|
| Stripe Connect onboarding | `api/stripe/onboarding/start/route.ts:59-100` (Express + AccountLink), `refresh/route.ts:38-45`, `status/route.ts:45-64`; return page `src/app/onboarding/stripe/return/page.tsx` | **IMPLEMENTED** | Hosted onboarding (AccountLink). No Express dashboard login link (`createLoginLink` absent). |
| Ship-from address | `api/settings/address/route.ts:45-47` (upsert into `seller_payments`, service role) | **IMPLEMENTED** | US-only zod schema `lib/validation.ts:40-48`. |
| Create drop + upload video | `api/drops/route.ts`, `dashboard/drops/new/page.tsx` | **BROKEN** on prod pre-chain (Inferred: `variants` column and status CHECK, §0.1); **BROKEN** post-chain (Confirmed: `drops` dropped) | Gated on `charges_enabled` + `from_address` (`api/drops/route.ts:37-50`). Writes only the legacy model. |
| Create video / product / attach / shipping profile (feed model) | — | **MISSING** | No insert anywhere in `src/` (§0.1). |
| Restock + waitlist blast | `api/drops/[id]/restock/route.ts:35-81` | **BROKEN** post-chain (`drops`; `waitlist_entries.drop_id` dropped `00007:477-482`) | Marks `notified_at` before sending (`:70-75`). |
| Discount codes | `api/discounts/route.ts:6-118` | **PARTIAL** | Create (Stripe coupon), list and deactivate work if the tables exist. Applied only in legacy checkout; the feed intent ignores codes. |
| Orders list / export CSV | `dashboard/orders/page.tsx:59-61`, `api/orders/export/route.ts:21-27` | **BROKEN** post-chain | Both embed `drops(title)`. |
| Retry label | `api/orders/[id]/retry-label/route.ts` | **IMPLEMENTED** | — |
| Studio home / videos / per-video funnel / money | `src/app/studio/**`, `src/lib/studio/**` | **IMPLEMENTED (read-only)** | Server components with no write actions. Reads `videos`, `video_stats`, `video_products`, `products`, `orders`. Stripe `balance.retrieve` + `payouts.list` on the connected account (`studio/page.tsx:441-450`; `studio/money/page.tsx:574-592`). Uses the service role for `seller_payments` (`studio/page.tsx:120`, `money/page.tsx:79`). Pure, tested maths in `lib/studio/{funnel,explain,earnings}.ts` with `__tests__`. |
| Studio share link | `studio/videos/[videoId]/page.tsx:344-348` | **BROKEN** post-chain | Reads `drops`. |
| Studio funnel completions | `lib/studio/funnel.ts:21-22` | **Known bug, worked around** | The rollup counts `bucket='q95'` but the client emits `"95"`, so completions are always 0. |

---

### 4. Status per feature

| Feature | Status | Evidence |
|---|---|---|
| Feed PaymentIntent creation (server-priced) | **IMPLEMENTED** (post-chain only) | `checkout/intent/route.ts:51-184` |
| Feed checkout UI (Elements, wallets) | **PARTIAL** | No email (`checkout-sheet.tsx:183-189`); publishable key env undocumented (§0.2 #8); no `return_url` (`:58-61`) |
| Legacy Checkout Session flow | **BROKEN** on prod (Inferred, §0.1); **BROKEN** post-chain (Confirmed) | `checkout/route.ts:34-38` |
| Webhook signature + idempotency (Stripe/Mux/EasyPost) | **IMPLEMENTED** | `webhooks/stripe/route.ts:349-385`; `webhooks/mux/route.ts:20-46`; `webhooks/easypost/route.ts:23-50` |
| Order recording from PI | **IMPLEMENTED** with defects | Double-decrement on retry; `buyer_email` empty |
| Oversell auto-refund | **IMPLEMENTED** | `webhooks/stripe/route.ts:93-104,293-295` |
| Inventory reservation | **MISSING** | Check at quote only |
| Per-variant inventory | **MISSING** (shown in UI, not enforced) | `product-sheet.tsx:151` vs `intent/route.ts:74` |
| Discounts in feed checkout | **MISSING** | `intent/route.ts:11-20` |
| Sales tax | **MISSING** | `00007:406` never written |
| Multi-item cart | **MISSING** | §1.7 |
| Shipping estimate (EasyPost + fallback) | **IMPLEMENTED** | `lib/shipping.ts` |
| Label purchase (EasyPost) | **IMPLEMENTED**; depends on a shipping address on the PI | `lib/easypost.ts:48-106`; `fulfillment.ts:220` |
| Tracking → shipped / delivered | **BROKEN** post-chain | `webhooks/easypost/route.ts:56-60` |
| Emails (Resend) | **PARTIAL** | No escaping; buyer email missing in feed flow |
| Refunds / disputes sync | **MISSING** | §1.4 |
| Seller refund / cancel tooling | **MISSING** | — |
| Mux direct upload | **IMPLEMENTED** (legacy model only) | `api/drops/route.ts:99-108` |
| Mux webhook → playable video | **BROKEN** post-chain (writes `drops`) | `webhooks/mux/route.ts:65-73` |
| Web feed playback | **PARTIAL / likely BROKEN** for real uploads (`low.mp4`) | `feed-video.tsx:98` |
| Seller onboarding (Stripe Express) | **IMPLEMENTED** | §3 |
| Studio analytics | **IMPLEMENTED** (read-only) | §3 |
| Demo feed | **MOCKED** (fixture playback ids) | `src/app/feed/demo/fixtures.ts:36-52` |
| Rate limiting | **PARTIAL**: per-instance in-memory | `lib/rate-limit.ts:3-6` |

**TODO / FIXME scan.** No `TODO`, `FIXME`, `HACK` or `XXX` markers in any audited file (grep). **Confirmed.** Known-gap comments instead:
- `api/feed/route.ts:23` ("not yet honored").
- `lib/studio/types.ts:95` ("Upload still lives on the legacy dashboard until Videos owns it").
- `lib/rate-limit.ts:3-5` ("swap for Upstash/Redis").
- `lib/studio/funnel.ts:21-22` (completions counter always 0).

---

### 5. App Store payment compliance (native iOS)

#### 5.1 What Drip sells: physical goods only (Confirmed)
- Every Stripe call in `src/` is commerce for shipped goods or Connect plumbing:
  - `paymentIntents.create`, `checkout.sessions.create`, `refunds.create`, `coupons.create/del`
  - `accounts.create/retrieve`, `accountLinks.create`, `balance.retrieve`, `payouts.list`
  - Locations: `checkout/intent/route.ts:148`, `checkout/route.ts:138`, `webhooks/stripe/route.ts:95`, `discounts/route.ts:57,76`, `stripe/onboarding/*`, `studio/*`, `api/dashboard/stats/route.ts:67`.
- No `subscriptions`, `prices`, `customers`, `invoices` or ephemeral keys. A grep for tips, subscription, donation, virtual, coins, credits, digital, membership, premium, unlock, paywall or download finds no monetized feature; "boost" hits are ranking internals in `lib/scoring/session.ts`.
- Every purchase requires a US shipping address and buys a USPS label (`checkout/route.ts:141`; `lib/fulfillment.ts:220`; `lib/easypost.ts:48`). Video viewing is free (public playback).
- Drip's revenue is an application fee on physical-goods sales (`lib/stripe.ts:31-41`). Sellers never pay Drip in-app. **Confirmed.**
- **Gap (Proposed).** The prohibited-items list (`src/app/legal/prohibited-items/page.tsx:16-25`) bans gift cards and currency but does not explicitly ban **digital goods, downloads or in-app-consumed services**. Add that line so a seller cannot list, for example, a "preset pack" that an Apple reviewer reads as digital content.

#### 5.2 Guideline analysis
- **App Store Review Guideline 3.1.3(e), "Goods and Services Outside of the App"** (numbered **3.1.5(a)** before the 2020 renumbering).
  - Apps that sell physical goods or services consumed outside the app **must** use a method other than IAP, "such as Apple Pay or traditional credit card entry".
  - Drip's purchases are shipped physical goods, so Stripe PaymentSheet with Apple Pay and cards is the required path, not merely an allowed one. **Inferred (policy reading).**
- **Seller onboarding.**
  - Opening Stripe-hosted Connect onboarding (AccountLink URL from `/api/stripe/onboarding/start`, `route.ts:93-100`) in `ASWebAuthenticationSession` or `SFSafariViewController` is acceptable. It is identity and KYC for receiving payouts, not a purchase. **Inferred.**
  - Use a universal link or custom scheme for `return_url`. The current `return_url` is `${APP_URL}/onboarding/stripe/return` and `refresh_url` is `/api/stripe/onboarding/refresh` (`start/route.ts:95-96`).
  - The refresh route needs a cookie session (`refresh/route.ts:9-16`), so in an ephemeral web-auth session it redirects to `/auth/login`. Proposed: let the native app re-call `/start` for a fresh link instead of relying on `refresh_url`, or pass a one-time token.
- **Things to keep out of the iOS app (Proposed):**
  - Creator tips or "support the creator" payments, paid boosts or promoted placement bought in-app, and subscriptions or memberships. These would trigger 3.1.1 IAP.
  - Any link-out to buy digital content.

#### 5.3 Recommended native payment integration: Stripe iOS PaymentSheet + Apple Pay
**What PaymentSheet needs (Inferred from Stripe iOS SDK):**
1. `paymentIntentClientSecret`. **Already returned** as `clientSecret` (`intent/route.ts:177`).
2. A publishable key for `STPAPIClient.shared.publishableKey`. **Not returned.** Either bake it into the app config or add `publishableKey` to the intent response. It is public by design. Note that `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is not in `.env.local.example`.
3. Optional `customer` + `ephemeralKeySecret` only for saved cards. **Not needed for guest checkout.** If added later: `customers.create` and `ephemeralKeys.create({customer},{apiVersion: <iOS SDK's version>})` server-side, plus `setup_future_usage`.
4. `merchantDisplayName` ("Drip") and `returnURL` (an app URL scheme) for any redirect-based method.
5. Apple Pay: `PaymentSheet.ApplePayConfiguration(merchantId: "merchant.com.drip…", merchantCountryCode: "US")`.
   - Because these are **destination charges on the platform account** (no `on_behalf_of`), the Apple Pay merchant ID and certificate are registered under **Drip's** Stripe account.
   - `automatic_payment_methods` is already enabled (`intent/route.ts:152`).

**Server changes needed (Proposed):**
- **a. Response.** Add `publishableKey` and `merchantDisplayName`. Optionally add `ephemeralKey` and `customer` behind a flag.
- **b. Email.** The native app collects email before calling intent (the schema already accepts `email`, `intent/route.ts:19,169`). Alternatively, the webhook falls back to `latest_charge.billing_details.email` when `receipt_email` is empty (`webhooks/stripe/route.ts:312`). Set `billingDetailsCollectionConfiguration.email = .always` in PaymentSheet.
- **c. Shipping address.** Collect it with Stripe `AddressViewController` (US only) and pass it as `PaymentSheet.Configuration.shippingDetails`. For robustness, add `POST /api/checkout/intent/{id}/shipping`, which calls `paymentIntents.update({shipping, receipt_email})`, re-estimates shipping to the actual destination, and updates `amount` and `application_fee_amount` before confirm. Today `shipping: undefined` (`intent/route.ts:158`) and labels depend on it (`fulfillment.ts:220`).
  - With Apple Pay, either require the shipping contact in the Apple Pay sheet (`paymentRequestHandler` sets `requiredShippingContactFields`, then update the PI in `authorizationResultHandler`), or collect the address first.
- **d. Redirect methods.** Set `automatic_payment_methods: { enabled: true, allow_redirects: 'never' }` for native requests, or supply `returnURL`.
- **e. Identity headers.** The native client sends `x-drip-anon-token` (already supported: `anon-request.ts:15-28`). The rate limit is per IP at 12/min (`intent/route.ts:31`); carrier NAT may share IPs.
- **f. Payment-status UX.** Call `paymentSheet.present` and then show order status by polling an order-by-PI endpoint. None exists yet: add `GET /api/orders/by-intent/{pi}` scoped to the anon id. Do not treat client success as the order.
- **g. Webhook fixes.** Fix the double-decrement-on-retry (make decrement + insert one RPC/transaction keyed on the PI id). Add `charge.refunded` and `charge.dispute.created`, updating `status`, `refunded_at` and `disputed_at`.

---

### 6. Secrets inventory (every `process.env` read in `src/`)

| Var | Read at | Class | Client-side? |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `api/checkout/route.ts:125`; `api/drops/route.ts:102`; `api/drops/[id]/restock/route.ts:77`; `api/stripe/onboarding/start/route.ts:49`; `.../refresh/route.ts:37`; `[handle]/[slug]/page.tsx:44`; `auth/login/page.tsx:63`; `auth/signup/page.tsx:65`; `studio/videos/[videoId]/page.tsx:401` | Public | Yes (fine) |
| `NEXT_PUBLIC_SUPABASE_URL` | `lib/supabase.ts:7`; `lib/supabase-public.ts:7`; `lib/supabase-server.ts:16,48`; `lib/supabase-admin.ts:7` | Public | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `lib/supabase.ts:8`; `lib/supabase-public.ts:8`; `lib/supabase-server.ts:17,49` | Public (RLS-bound) | Yes; native app embeds it |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `components/feed/checkout-sheet.tsx:15` | Public | Yes; native needs it (§5.3). **Missing from `.env.local.example`** |
| `SUPABASE_SERVICE_ROLE_KEY` | `lib/supabase-admin.ts:8`; `studio/page.tsx:120`; `studio/money/page.tsx:79`; `studio/videos/page.tsx:80`; `studio/videos/[videoId]/page.tsx:130` | **Secret** (bypasses RLS) | Never |
| `STRIPE_SECRET_KEY` | `lib/stripe.ts:7` | **Secret** | Never |
| `STRIPE_WEBHOOK_SECRET` | `api/webhooks/stripe/route.ts:362` | **Secret** | Never |
| `MUX_TOKEN_ID` / `MUX_TOKEN_SECRET` | `lib/mux.ts:9-10,24-25` | **Secret** | Never; native AVPlayer needs only the playback id |
| `MUX_WEBHOOK_SECRET` | `api/webhooks/mux/route.ts:20` | **Secret** | Never |
| `EASYPOST_API_KEY` | `lib/easypost.ts:28`; `lib/shipping.ts:31` | **Secret** | Never |
| `EASYPOST_WEBHOOK_SECRET` | `api/webhooks/easypost/route.ts:24` | **Secret** | Never |
| `RESEND_API_KEY` | `lib/emails.ts:6,8` | **Secret** | Never |
| `RESEND_FROM_EMAIL` | `lib/emails.ts:13` | Config (non-secret) | Not needed |
| `ANON_ID_SECRET` | `lib/anon-id.ts:26` | **Secret** (HMAC for anon ids) | Never; native gets a *signed token* from `/api/session/anon`, not the key |
| `NODE_ENV` | `proxy.ts:62` | Runtime | n/a |
| `CRON_SECRET` | listed in `.env.local.example` only; **not read anywhere in `src/` or `supabase/`** (grep) | Secret, currently unused | — |

**Client exposure check (Confirmed).** No `'use client'` file imports `supabase-admin`, `lib/stripe`, `lib/mux`, `lib/easypost`, `lib/shipping`, `lib/fulfillment` or `lib/emails` (grep returned nothing). All non-`NEXT_PUBLIC_` vars are read only in route handlers, server components or server libs. The native app needs only:
- Supabase URL and anon key
- Stripe publishable key
- App base URL
- Mux playback ids (from API responses)

None of the secrets are needed client-side.

**Proposed hardening:** add `import 'server-only'` to `lib/supabase-admin.ts`, `lib/stripe.ts`, `lib/mux.ts`, `lib/easypost.ts` and `lib/emails.ts`. No `server-only` guard exists today (grep), and `lib/supabase-admin.ts:3-4` relies on a comment.

---

### 7. Prioritized fixes (Proposed)
1. Build the feed-model creator path:
   - `POST /api/videos` (Mux direct upload with `passthrough = videos.id`)
   - `POST /api/products`, attaching via `video_products`, plus shipping profiles
   - Repoint the Mux webhook to `videos`: set `mux_playback_id`, `duration_seconds`, `aspect_ratio`, `thumbnail_url`, `status='live'` and `published_at`.
2. Apply the migration chain only after (1) exists. Fix every `drops` reader listed in §0.1 in the same release.
3. Fix the EasyPost webhook so it selects without `drop_id` and reads the title from `order_items`.
4. Feed checkout: collect email; attach shipping server-side; make decrement + insert one transaction; add refund and dispute webhooks.
5. Native: return `publishableKey`; `allow_redirects:'never'` or `returnURL`; add an order-status endpoint; use the HLS `.m3u8` URL.
6. Policy and legal: align Terms "merchant of record" with destination charges (or add `on_behalf_of`); add digital goods to prohibited items; add Stripe Tax or a marketplace-facilitator tax plan.
7. Escape HTML in email templates. Add `server-only` guards. Document `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.
