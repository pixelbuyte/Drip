# Drip Setup Guide

# Step 7: Seller Dashboard

## What's Been Built

- **Dashboard home** — revenue / sales / pending-payout stat cards (payout read live from the seller's connected-account Stripe balance), nav to Orders
- **`/dashboard/orders`** — orders list: item, buyer, total, date, status chain badges (Paid — needs label → Label created → Shipped → Delivered, plus Refunded), USPS tracking link, **Print label** button, and a **Buy label** retry button for orders stuck in `paid` (e.g. EasyPost was down during the webhook)
- **CSV export** (`GET /api/orders/export`) — full order history with ship-to address, totals, status, tracking; opens as a download
- **Per-drop analytics** on `/dashboard/drops` — views (Mux Data, last 90 days), sales count, revenue under each drop
- **`GET /api/dashboard/stats`** — aggregates orders (refunds excluded), fetches Mux view counts per asset (best-effort, zeros on failure), reads pending/available USD balance via `stripe.balance.retrieve({ stripeAccount })`
- **Fulfillment refactor** — label+email logic extracted to `src/lib/fulfillment.ts`, shared by the checkout webhook and the retry endpoint; retry skips the buyer confirmation (already sent) and only buys the label + emails the seller

## Setup for Step 7

Nothing new — uses existing Stripe/Mux/EasyPost keys. (Mux view counts require Mux Data, which is on by default when using Mux Player.)

## What to Test (Final Step Before Polish)

- [ ] Dashboard shows revenue/sales matching your test orders; pending payout matches Stripe Dashboard → Connect → account balance
- [ ] Orders page lists orders newest-first with correct status badges
- [ ] Print label opens the PDF; tracking link opens USPS tracking
- [ ] Force a failed label (remove `EASYPOST_API_KEY`, buy something, restore key) → order shows "Buy label" → click → label purchased, status flips, seller email arrives, NO duplicate buyer confirmation
- [ ] Retry on an order that already has a label → 409
- [ ] Another seller's order ID in the retry URL → 404 (RLS)
- [ ] Export CSV → opens in a spreadsheet with correct columns; commas/quotes in addresses don't break rows
- [ ] Drops page shows views/sales/revenue per drop (views may lag — Mux Data takes a few minutes)
- [ ] Stats endpoint unauthenticated → 401

---

# Step 6: Shipping Labels + Emails + Tracking

## What's Been Built

- **Auto label purchase** — after order creation, the webhook buys the cheapest USPS rate via EasyPost (PDF format) using buyer address + seller from-address + package weight/dims, then sets `easypost_shipment_id`, `tracking_code`, `label_url`, status → `label_created`. Label purchase is **best-effort**: a failure logs and leaves the order `paid` (the Step 7 dashboard gets a retry button) — it never re-triggers inventory work
- **Emails (Resend, all best-effort, never block fulfillment):**
  - Seller: "🎉 New sale" with the label PDF link + inline packing slip (order ID, item w/ variant, total, ship-to)
  - Buyer: order confirmation with tracking number (or "tracking soon" if the label failed)
  - Buyer: "Delivered 📦" when the tracker hits delivered
  - Waitlist: "Back in stock 🔥" with a buy link
- **EasyPost tracking webhook** (`/api/webhooks/easypost`) — verifies the `X-Hmac-Signature` HMAC, idempotent via `processed_events`; `tracker.updated` maps `in_transit`/`out_for_delivery` → `shipped` and `delivered` → `delivered` + buyer email
- **Restock + waitlist blast** — `POST /api/drops/[id]/restock` (Restock button on sold-out drops): sets new inventory, and on a 0→N transition emails all un-notified waitlist entries. Entries are marked `notified_at` *before* sending so a crash mid-blast can't double-email
- New env vars: `EASYPOST_WEBHOOK_SECRET` (signature verification is a hard rule), `RESEND_FROM_EMAIL` (optional; defaults to Resend's test sender)

## Setup for Step 6

1. EasyPost dashboard → Webhooks → add `https://<tunnel>/api/webhooks/easypost`, copy the webhook secret → `EASYPOST_WEBHOOK_SECRET`
2. Resend → create API key → `RESEND_API_KEY`; verify a sending domain and set `RESEND_FROM_EMAIL` (or skip and use the test sender, which only delivers to your own account email)
3. Use EasyPost **test mode** keys — test labels are free and USPS test tracking codes simulate transitions

## What to Test Before Step 7

- [ ] Complete a purchase → order goes `paid` → `label_created` within seconds; `tracking_code` + `label_url` populated
- [ ] Seller email arrives with working label PDF link + packing slip
- [ ] Buyer email arrives with tracking number
- [ ] With `EASYPOST_API_KEY` removed: order stays `paid`, both emails still send (buyer gets "tracking soon"), webhook still returns 200
- [ ] Simulate tracker updates (EasyPost test trackers): `in_transit` → order `shipped`; `delivered` → order `delivered` + buyer delivered email
- [ ] Replay an EasyPost event → `duplicate: true`
- [ ] EasyPost webhook with a bad signature → 400
- [ ] Sell out a drop, join its waitlist, hit Restock (set 10) → inventory updates, waitlist email sent, `notified_at` set; restocking again does NOT re-email

---

# Step 5: Order Creation + Atomic Inventory + Waitlist

## What's Been Built

- **`checkout.session.completed` handler** (in the Stripe webhook):
  - **Atomic inventory decrement** via the conditional-UPDATE pattern: `UPDATE drops SET inventory = inventory - 1 WHERE id = $1 AND inventory >= 1 RETURNING inventory` — two checkouts racing for the last unit can never both succeed (migration `00004` replaces the old `FOR UPDATE` function)
  - **Order record** created with buyer name/email + shipping address from Checkout, amount, shipping cents, variant metadata
  - **Oversell auto-refund**: if the decrement returns NULL (a concurrent checkout took the last unit between session creation and payment), the buyer is refunded in full with `reverse_transfer: true` (funds pulled back from the seller's connected account) and the order is recorded as `refunded` for audit
  - **Layered idempotency**: event-ID claim + pre-check on `orders.stripe_session_id` + UNIQUE constraint as the final backstop
- **Waitlist** — when a drop is sold out, the public page swaps the buy button for a "Notify me" email capture (`POST /api/waitlist`, deduped per drop+email). Doubles as lead-gen for the seller; the back-in-stock email sends in Step 6
- **Migration `00004`** — new `decrement_inventory`, `waitlist_entries` table (seller-readable via RLS), `refunded` order status

## Setup for Step 5

1. Run migration `supabase/migrations/00004_orders_waitlist.sql`
2. Make sure `stripe listen --forward-to localhost:3000/api/webhooks/stripe` is running with `checkout.session.completed` events included (default: all events)

## What to Test Before Step 6

- [ ] Buy a drop with test card `4242...` → within seconds: inventory decremented in Supabase, order row created with status `paid`, buyer email + US shipping address captured
- [ ] `amount_cents` = item + shipping (minus discount if used); `shipping_cents` matches the Checkout line item
- [ ] Buy with a discount code → order still records correctly
- [ ] Replay the webhook event → `duplicate: true`, inventory NOT decremented twice
- [ ] Set inventory to 1, complete a purchase → drop shows Sold Out on the public page
- [ ] **Oversell drill**: set inventory to 0 in Supabase, then complete a checkout session created beforehand → buyer auto-refunded (check Stripe Dashboard → Payments), order recorded as `refunded`
- [ ] On a sold-out drop: join the waitlist → row in `waitlist_entries`; joining twice with the same email still returns success, no duplicate row
- [ ] Seller can SELECT their waitlist rows in Supabase; other sellers' rows invisible (RLS)

---

# Step 4: Public Drop Page + Stripe Checkout (the money page)

## What's Been Built

- **`/@handle/drop-slug`** — mobile-first public drop page: full-bleed vertical video (Mux Player: autoplay muted, loop, plays inline, object-cover), tap-to-unmute, seller badge, price, "Only N left" when ≤5, variant pickers (44px+ tap targets), collapsible discount-code field, buy button, sold-out state, "Powered by Drip" footer
- **OG tags** — `generateMetadata` emits og:title (`Title — $price`), og:description, og:image (Mux thumbnail at 1200×630 smartcrop, absolute HTTPS URL), og:url + Twitter `summary_large_image` so links preview well in bios/DMs
- **`POST /api/checkout`** — re-validates everything server-side (drop active, inventory > 0, variant selection legal, seller `charges_enabled`), then creates a Stripe Checkout Session:
  - **Destination charge** to the seller's connected account, `application_fee_amount` plumbed (= 0)
  - **US-only**: `shipping_address_collection.allowed_countries = ['US']`
  - Shipping as a separate line item, priced via **EasyPost flat-rate estimate** (rates seller's package to the far coast, cheapest USPS rate + 10% buffer; weight-based fallback table if EasyPost is down)
  - **Per-seller discount validation** — code looked up against this seller only, applied via session `discounts` (never `allow_promotion_codes`)
  - Variant selection + shipping cents + discount code stored in session metadata for Step 5's order creation
  - Sessions expire after 30 min to limit open carts against finite inventory
  - Apple Pay / Google Pay are on automatically in hosted Checkout (enable them in Stripe Dashboard → Payment Methods)
- **`/@handle/drop-slug/thanks`** — order confirmation landing page

## Setup for Step 4

1. Set `EASYPOST_API_KEY` (test key) in `.env.local` — optional; the fallback rate table kicks in without it
2. Stripe Dashboard → Settings → Payment Methods → confirm Apple Pay + Google Pay enabled
3. Use a tunnel (ngrok) if testing wallet buttons — Apple Pay requires HTTPS

## What to Test Before Step 5

- [ ] Open `/@yourhandle/your-slug` on a phone (or devtools mobile emulation) → video autoplays muted, fills the screen, loops
- [ ] Tap 🔇 → audio unmutes
- [ ] Paste the link into a link-preview debugger (e.g. opengraph.xyz) → title, price, and video thumbnail render
- [ ] With variants: tapping Buy without selecting → "Please select a Size"; after selecting → Stripe Checkout opens with "Title (M / Black)"
- [ ] Checkout shows item + "Shipping (USPS)" line; shipping price looks sane for the package weight
- [ ] Address form only accepts US addresses
- [ ] Enter discount code `SAVE10` → Checkout shows the discount applied; a bogus code → "Invalid discount code" on the drop page
- [ ] Another seller's code on your drop → rejected
- [ ] Pay with test card `4242 4242 4242 4242` → land on `/thanks` page
- [ ] Set inventory to 0 in Supabase → page shows Sold Out; `POST /api/checkout` returns 409
- [ ] Set inventory to 3 → "Only 3 left" appears
- [ ] Drop with status `processing` or `archived` → public page 404s

> Note: paying does NOT yet decrement inventory or create an order — that's Step 5 (the `checkout.session.completed` webhook).

---

# Step 3: Mux Upload + Drop Creation (+ Variants, Discounts, From-Address)

## What's Been Built

- **`POST /api/drops`** — validates product fields (zod), gates on `charges_enabled` AND a saved from-address, generates a per-seller unique slug, inserts the drop as `processing`, and creates a Mux direct upload (`passthrough` = drop ID) returning the upload URL
- **`POST /api/webhooks/mux`** — verifies the `mux-signature` HMAC, idempotent via `processed_events`; `video.asset.ready` enforces the 60s cap (rejects longer videos) and flips the drop to `active` with its `mux_playback_id`; `video.asset.errored`/`video.upload.errored` → `rejected`
- **`/dashboard/drops/new`** — two-phase flow: product form (title, description w/ char counter, price, inventory, package weight + dims, optional variants) → `<MuxUploader>` with progress
- **Variants** — up to 2 dimensions (e.g. Size, Color), 5 options each, all inherit base price; stored as JSONB, validated server-side
- **`/dashboard/drops`** — list with status badges (Processing / Live / Rejected), copy-link + view buttons
- **`/dashboard/settings`** — US-only ship-from address (state dropdown, ZIP validation), saved to `profiles.from_address`, reused for every label
- **`/dashboard/discounts`** — create/deactivate percent-off codes; each is backed by a Stripe coupon on the platform account and applied **per-seller** at checkout (we never use `allow_promotion_codes`, which would make codes platform-wide)
- **Migration `00003`** — `mux_upload_id` + `variants` columns, drop lifecycle (`processing → active | rejected | archived`), `discount_codes` table with RLS

## Setup for Step 3

1. Run migration `supabase/migrations/00003_drops_video_variants_discounts.sql`
2. Create a Mux account → Settings → API Access Tokens → set `MUX_TOKEN_ID` + `MUX_TOKEN_SECRET`
3. Mux Dashboard → Settings → Webhooks → add `https://<your-tunnel>/api/webhooks/mux` (use ngrok/cloudflared locally) → copy signing secret into `MUX_WEBHOOK_SECRET`

## What to Test Before Step 4

- [ ] Without a from-address: dashboard shows the amber warning; `POST /api/drops` returns the "add your address" error
- [ ] Save a from-address in Settings → bad ZIP / missing state rejected, valid address persists across reload
- [ ] Create a drop with variants (Size: S,M,L + Color: Black,White) → upload a short vertical video → progress bar shows → "processing" confirmation
- [ ] Within ~1-2 min, Mux webhook fires → drop flips to **Live** in `/dashboard/drops`, `mux_playback_id` populated in Supabase
- [ ] Upload a video **over 60s** → drop ends up **Rejected**
- [ ] Copy link button produces `https://<host>/@handle/slug` (page itself is Step 4)
- [ ] Two drops with the same title → slugs are `title` and `title-2`
- [ ] Create discount code `SAVE10` (10%) → appears in list AND as a coupon in Stripe Dashboard; duplicate code rejected with 409
- [ ] Deactivate the code → grays out with strikethrough
- [ ] Replay a Mux webhook event → `duplicate: true`, no reprocessing

---

# Step 2: Stripe Connect Express Onboarding

## What's Been Built

- **`POST /api/stripe/onboarding/start`** — creates the seller's Express account (US, individual, card_payments + transfers, `debit_negative_balances: true` so Stripe can recover refund/dispute shortfalls from the seller's bank) and returns a hosted Account Link URL
- **`GET /api/stripe/onboarding/refresh`** — Stripe redirects here when an Account Link expires; mints a fresh link and bounces the seller back into onboarding
- **`GET /api/stripe/onboarding/status`** — fetches live account state from Stripe, syncs `charges_enabled` to the profile, and returns outstanding `requirements` + `disabled_reason`
- **`POST /api/webhooks/stripe`** — signature-verified, idempotent webhook handler; `account.updated` keeps `charges_enabled` in sync (`checkout.session.completed` stubbed for Step 5)
- **`/onboarding/stripe/return`** — post-onboarding landing page; shows 🎉 + redirect to dashboard when verified, or a human-readable list of missing requirements with a "Continue Stripe Setup" button
- **Idempotency table** — `processed_events` (migration `00002`), UNIQUE on `(provider, event_id)`; duplicate webhook deliveries are acknowledged without reprocessing, and failed handlers release their claim so Stripe retries work
- **Fee plumbing** — `APPLICATION_FEE_BPS = 0` in `src/lib/stripe.ts`; flip to `800` later without touching checkout code

## Setup for Step 2

1. Run migration `supabase/migrations/00002_webhook_events.sql` in the Supabase SQL Editor
2. Get your Stripe **test mode** secret key → `STRIPE_SECRET_KEY` in `.env.local`
3. Forward webhooks locally: `stripe listen --forward-to localhost:3000/api/webhooks/stripe` → copy the `whsec_...` into `STRIPE_WEBHOOK_SECRET`
4. Make sure `NEXT_PUBLIC_APP_URL=http://localhost:3000` is set (Account Links need absolute URLs)

## What to Test Before Step 3

- [ ] From `/onboarding/stripe`, click "Start Stripe Onboarding" → redirected to Stripe-hosted Express onboarding
- [ ] Complete onboarding with Stripe test data (SSN `000-00-0000`, any future DOB over 18, test bank `110000000` / `000123456789`)
- [ ] Land on `/onboarding/stripe/return` → see "You're ready to sell!" → auto-redirect to dashboard
- [ ] Check Supabase: profile row has `stripe_account_id` set and `charges_enabled = true`
- [ ] Abandon onboarding halfway, return → requirements list shows what's missing, "Continue Stripe Setup" resumes
- [ ] In Stripe Dashboard → Connect → the Express account exists with `debit_negative_balances` on
- [ ] Trigger `stripe trigger account.updated` → webhook returns 200, row appears in `processed_events`
- [ ] Replay the same event (`stripe events resend <id>`) → returns `duplicate: true`, no double-processing
- [ ] Visit `/dashboard` with `charges_enabled = false` → bounced to `/onboarding/stripe` (listing creation stays blocked)

---

# Step 1: Supabase Schema + RLS + Auth

## What's Been Built

### 1. Database Schema (Supabase)
- **profiles**: Seller accounts with handle, display name, avatar, Stripe account ID, from-address
- **drops**: Product listings with video details, pricing, inventory, dimensions
- **orders**: Purchase records with shipping info and tracking
- All tables have RLS policies to ensure sellers only see their own data
- Atomic inventory decrement function to prevent overselling

### 2. Authentication
- Email/password + Google OAuth via Supabase Auth
- Signup flow (`/auth/signup`)
- Login flow (`/auth/login`)
- Auth callback handler
- Protected routes that redirect unauthenticated users

### 3. Onboarding Flow
- Profile setup (`/onboarding`): Seller chooses handle & display name
- Stripe onboarding placeholder (`/onboarding/stripe`) — full implementation in Step 2
- Dashboard (`/dashboard`): View after auth (blocks until Stripe onboarding complete)

### 4. Project Structure
- `/src/lib/supabase.ts` — Client-side Supabase initialization
- `/src/lib/supabase-server.ts` — Server-side Supabase for API routes
- `/src/lib/auth.ts` — Auth utilities (getSession, requireAuth, getUserProfile)
- `/src/app/auth/*` — Auth pages
- `/src/app/onboarding/*` — Onboarding pages
- `/src/app/dashboard/*` — Seller dashboard

## Setup Instructions

### 1. Create a Supabase Project
1. Go to [supabase.com](https://supabase.com) and create a new project
2. Grab your `SUPABASE_URL` and `SUPABASE_ANON_KEY` from project settings
3. Go to SQL Editor and run the SQL from `/supabase/migrations/00001_initial_schema.sql`

### 2. Configure Environment Variables
```bash
cp .env.local.example .env.local
```
Fill in:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_APP_URL` (http://localhost:3000 for local dev)

### 3. Enable Google OAuth (Optional for Testing)
In Supabase project settings:
1. Go to Authentication > Providers > Google
2. Add your Google OAuth credentials (or skip for now, email/password works)

## What to Test Before Step 2

### Test Supabase Connection
- [ ] Run `npm run dev` — should start without errors
- [ ] Check Supabase dashboard → SQL Editor → can see profiles, drops, orders tables
- [ ] Verify RLS is enabled on all tables

### Test Auth Flow
- [ ] Click "Start Selling" on home page
- [ ] Sign up with an email
- [ ] You should be redirected to onboarding
- [ ] Fill in handle and display name
- [ ] Handle validation works (no capital letters, no duplicates)
- [ ] You should be redirected to `/onboarding/stripe`

### Test Session Persistence
- [ ] After signup, refresh the page
- [ ] You should stay on the onboarding flow (session persists)
- [ ] Sign out from dashboard
- [ ] You should be redirected to home page
- [ ] Visiting `/dashboard` should redirect to login

### Test RLS
In Supabase SQL Editor, run:
```sql
-- This should return the profile you just created
SELECT * FROM profiles WHERE handle = 'your_handle';

-- These should return empty (RLS protection)
SELECT * FROM profiles WHERE id != auth.uid();
```

### Test Handle Uniqueness
- [ ] Try to signup again with the same handle
- [ ] Should see error message "Handle is already taken"

## Files Created
- `/supabase/migrations/00001_initial_schema.sql` — Database schema
- `/src/lib/supabase.ts` — Client initialization
- `/src/lib/supabase-server.ts` — Server initialization
- `/src/lib/auth.ts` — Auth helpers
- `/src/app/auth/login/page.tsx` — Login UI
- `/src/app/auth/signup/page.tsx` — Signup UI
- `/src/app/auth/callback/route.ts` — OAuth callback
- `/src/app/onboarding/page.tsx` — Profile setup
- `/src/app/onboarding/stripe/page.tsx` — Stripe placeholder
- `/src/app/dashboard/page.tsx` — Dashboard placeholder
- `/src/app/page.tsx` — Home page (landing + redirect)

## Next Steps (Step 2)
- Stripe Connect Express onboarding flow
- Create `/api/stripe/*` endpoints
- Handle Stripe webhook (account.updated to set charges_enabled)
- Block drop creation until charges_enabled = true
