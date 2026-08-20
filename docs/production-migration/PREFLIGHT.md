# Production migration pre-flight — chain 00006–00016 → tkppdmrkvyjixaiocwmd

Status: **NOT READY TO APPLY** until every item in "Blockers" is closed.
Nothing in producing this document touched production; every production
access was a read-only query via the management API, logged below.

Target: Supabase project `tkppdmrkvyjixaiocwmd` (us-east-1), Postgres
**17.6.1.127**. Verification replica: local Postgres **16** — a stated
fidelity gap; nothing in the chain uses 17-only features, and the chain has
additionally been type-checked against 17 semantics in review, but the
version difference is a residual risk to acknowledge, not hide.

Production state at evidence-time (2026-08-19, re-verify at T-0):
5 public tables (profiles, drops, orders, seller_payments,
processed_events); 1 auth user (`demo@drip.test`), 1 profile (`@demo`),
1 drop (Vintage Denim Jacket, `status='active'`, no Mux video), 1
seller_payments row (`acct_demo_placeholder`, `from_address` NULL),
0 orders, 0 processed_events. **All demo data. No real sellers, buyers, or
PII exist yet.** That is the single most important risk fact in this
document: the worst-case loss today is a demo account.

---

## 1. PITR — UNCONFIRMED (blocker)

Could not be confirmed from this environment: the management tools exposed
here do not surface plan/add-on state, and no access token is available for
the backups endpoint. WAL archiving is running on the instance
(`archive_command` → wal-g), but that is Supabase's own infrastructure and
does **not** indicate the customer PITR add-on.

Facts (from Supabase docs, current):
- PITR is a **paid per-project add-on** (Pro/Team/Enterprise org plan AND at
  least a Small compute add-on), ~$100/mo for 7-day retention. RPO ≤ 2 min.
- Without PITR: Pro orgs get daily backups (7 days). **Free-plan projects
  get no automated backups at all.**

ACTION (yours): Dashboard → project `tkppdmrkvyjixaiocwmd` → Database →
Backups → "Point in Time" tab. State the retention window here. If the
project is on the Free plan, there is no PITR to enable without upgrading —
given the data is one demo row, decide explicitly whether the logical
snapshot below is sufficient (it is a complete copy of everything that
exists) or whether to upgrade first. Until this line is filled in, the
answer to "is PITR enabled" is **NO for planning purposes**.

> PITR status: ____________  retention window: ______ hours  (filled by operator)

## 2. Independent pre-migration snapshot — TAKEN (re-take at T-0)

`docs/production-migration/prod-snapshot-2026-08-19.json` — complete
logical snapshot: every row of every public table (all 3 of them), auth
user metadata, the full pg_policies dump, functions, triggers,
dependent-object audit. Verified PII-free before committing to git
(`from_address IS NULL`, placeholder Stripe id, demo email). The auth
user's password hash was deliberately NOT captured (credential hashes do
not belong in git); restore path for the demo account is re-creation with
its original UUID + a fresh password.

Restore procedure (total loss scenario, no platform backup): create the
auth user with id `11111111-…-1111`, then INSERT the profiles, drops,
seller_payments rows verbatim from the JSON. Five minutes by hand.

RE-TAKE AT T-0: run the same queries (they are embedded in the JSON's
provenance notes) immediately before applying, so the snapshot cannot be
stale. Any diff vs the committed snapshot = stop and investigate.

## 3. Down-migration — <!-- SPLICE:DOWN -->

## 4. Row-count and FK-integrity diff — <!-- SPLICE:DIFF -->

## 5. Locks and the maintenance window

Full statement-level table in `docs/production-migration/lock-analysis.md`.
The conclusions:

- **By lock math alone, no maintenance window is required.** Every ACCESS
  EXCLUSIVE lock in the chain is on a table of 0–1 rows; every validation
  scan, backfill, and index build is bounded by those same rows. Whole-chain
  blocking is realistically **1–5 seconds**.
- **Take a short window anyway (2–5 quiet minutes)** — not for lock
  duration, for three other reasons:
  1. **App cutover is atomic with COMMIT**: the instant the chain commits,
     `public.drops` ceases to exist and profiles/orders grants change
     shape. Any app instance still running pre-migration code errors
     immediately. The migration and the app deploy must land together; a
     window is the cheapest way to guarantee that ordering.
  2. **Pause the Stripe/Mux/EasyPost webhook endpoints** for those minutes.
     They are the only realistic lock counterparties (three concrete
     deadlock shapes are documented in the lock analysis — all die with
     this mitigation). All three providers retry, so nothing is lost.
  3. **Run with `lock_timeout` 5–10s** and re-run on failure: if a stray
     long transaction holds `drops`/`profiles`, the chain fails fast and
     retries instead of queuing an AEL that stalls every later storefront
     read behind it. The chain is single-transaction and re-runnable by
     design.
- In single-transaction mode every AEL is held to the final COMMIT, so the
  effective full-block window on drops/profiles/orders/seller_payments is
  the entire chain runtime — that IS the 1–5 seconds above. `supabase db
  push` / `apply_migration` wrap each FILE instead; same shape, shorter
  holds, but then a mid-chain failure leaves earlier FILES committed —
  which is why the recommended apply is ONE psql single transaction (below).
- One in-transaction subtlety verified safe: 00010's
  `ALTER TYPE … ADD VALUE 'chrono'` is legal in-transaction only because no
  later statement in the chain uses the value; the full chain applies
  single-transaction exit 0 on the replica, which proves it empirically.

## 6. The apply procedure (when unblocked — DO NOT run yet)

1. Confirm §1 (PITR) is filled in and accepted.
2. Re-take the §2 snapshot; diff against committed; stop on any change.
3. Announce the 5-minute window. Pause webhook delivery (Stripe dashboard →
   webhook endpoint → disable; same for Mux/EasyPost).
4. Apply as ONE transaction in filename order (00001/00002 are already
   applied in production; the set is 00006…00016):
   `psql "$PROD_URL" -v ON_ERROR_STOP=1 --single-transaction \
      -c "SET lock_timeout='10s'" -f 00006_… -f 00007_… … -f 00016_…`
   (or the MCP `apply_migration` per file, accepting per-file transactions
   and re-runnability on mid-chain failure — every file is idempotent-by-
   design for exactly this case).
5. Run the §4 verification queries against production; compare to replica
   expectations.
6. Deploy the app build that expects the new schema (already on `main`).
7. Re-enable webhooks. Confirm `/`, `/feed`, a storefront page, and a
   webhook test event.
8. Sit 48h (per the rollout plan) before starting ranked_v2 shadow work.

Rollback: `scripts/down/full_chain_down.sql` (§3) in one transaction, then
redeploy the pre-migration app build. Verified on the replica; §3 carries
the evidence.

## 7. Corrections already made to the chain because of this pre-flight

- The reconcile migration's policy drops targeted repo 00001's policy name
  `profiles_public_read_handle`; production's real policy (pg_policies
  dump) is `profiles_public_read`. Policies OR together, so the wide-open
  `USING (true)` policy would have survived the entire chain. The reconcile
  now drops both names, and production's three `seller_payments`
  self-access policies (also discovered in the dump; inert but a tripwire)
  are dropped too. The replica's production-delta was corrected to model
  the REAL policy names, so this is exercised, not assumed. (Commit
  `bbf07ac`.)
- Ruled out by primary evidence (not modeling): production has no views and
  no objects depending on `drops`, so `DROP TABLE public.drops` cannot fail
  on dependencies.

## 8. ranked_v2 five-property audit — <!-- SPLICE:AUDIT -->

## Blockers summary

| # | Item | State |
|---|------|-------|
| 1 | PITR confirmed by operator (§1) | **OPEN — operator action** |
| 2 | T-0 snapshot re-taken clean (§2) | open until apply day |
| 3 | Down-migration verified on replica (§3) | <!-- SPLICE:B3 --> |
| 4 | Row-count/FK diff clean (§4) | <!-- SPLICE:B4 --> |
| 5 | Window plan accepted (§5–6) | ready for review |
