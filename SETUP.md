# Drip Setup Guide — Step 1: Supabase Schema + RLS + Auth

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
