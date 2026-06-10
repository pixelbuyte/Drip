# Drip Setup Guide

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
