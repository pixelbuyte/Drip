# Drip

A web-only seller checkout tool for video commerce. Sellers upload a short product video, tag it with price + inventory, and get a shareable checkout link for their TikTok/Instagram bio. Buyers watch and buy — no accounts, no feed, no marketplace. US-only, USD-only.

## Stack

- **Next.js (App Router)** + TypeScript + Tailwind — deployed on Vercel
- **Supabase** — auth (email + Google), Postgres with RLS
- **Mux** — direct video upload + playback (60s max)
- **Stripe Connect Express** — destination charges to seller accounts with an `application_fee_amount` on every sale
- **EasyPost** — USPS label purchase + tracking webhooks
- **Resend** — transactional email (receipts, labels, tracking, back-in-stock)

## How it works

1. **Seller onboarding** — sign up, pick a handle, complete Stripe Express verification (listing creation is blocked until `charges_enabled`)
2. **Create a drop** — upload video, set price/inventory/variants/package size; goes live when Mux finishes processing
3. **The money page** — `drip.app/@handle/drop-slug`: full-bleed autoplay video, one-tap Stripe Checkout (Apple Pay/Google Pay), guest-only
4. **Post-purchase** — webhook decrements inventory atomically, buys the USPS label, emails seller (label + packing slip) and buyer (receipt + tracking); delivery tracked via EasyPost webhooks
5. **Dashboard** — orders with label actions, revenue + pending payout, per-drop views/sales, CSV export, discount codes, restock + waitlist

## How Drip makes money

Every sale carries an `application_fee_amount`, taken automatically before the seller is paid:

```
application fee = Drip commission + Stripe processing passthrough (2.9% + $0.30)
```

- **Founding sellers (launch):** commission = 0% (`DRIP_FEE_BPS = 0` in `src/lib/stripe.ts`). The fee only covers Stripe's processing cost — Drip earns $0 but never subsidizes a sale. Marketed honestly as "0% Drip commission"; sellers pay card processing like they would anywhere (Whatnot charges 8% **and** 2.9% + $0.30 on top).
- **After validation:** flip `DRIP_FEE_BPS` to `800` (8% — the Whatnot-validated rate, still far below TikTok Shop's 15–55% effective or Poshmark's 20%).

The 0% period is the acquisition weapon, not the business model: no seller moves to an empty platform unless it costs them nothing.

## Local development

```bash
npm install
cp .env.local.example .env.local   # fill in keys
npm run dev
```

**Migrations.** On a **fresh** Supabase project, apply the files in
`supabase/migrations/` in plain filename order (00001, 00002, 00006, 00007, …) —
`supabase db push` does exactly this. Filename order is the correct order by
construction: `00006_reconcile_forked_schema.sql` carries guards that bring a
fresh database up to the shape the later files assume. Never apply anything in
`supabase/migrations/_abandoned_fork/` — see the README inside it.

Against the **existing production project** (which already ran 00001, 00002,
and five out-of-band June migrations recorded under timestamp versions),
`supabase db push` will NOT work — its migration history doesn't line up with
these filenames. Apply `00006_reconcile_forked_schema.sql` onward by hand (SQL
editor or MCP `apply_migration`), one file per transaction, in filename order.

Forward webhooks locally:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
# Mux + EasyPost webhooks need a tunnel (ngrok / cloudflared)
```

See `SETUP.md` for a step-by-step build log with per-step test checklists.

## Hard rules baked in

- US addresses only, USD only
- Atomic inventory decrement (conditional UPDATE) — no overselling, oversold races auto-refund
- All webhook handlers verify signatures and are idempotent (`processed_events` dedup)
- No marketplace feed, no buyer accounts, no live streaming, no chat
