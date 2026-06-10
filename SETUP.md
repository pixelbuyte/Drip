# Drip Setup Guide

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
