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

## 3. Down-migration — VERIFIED ON THE REPLICA

`scripts/down/full_chain_down.sql` — one explicit transaction, deliberately
outside `supabase/migrations/` so no version-ordered tool can ever
auto-apply it. It takes a post-chain database back to the pre-chain
production state: reconstructs `public.drops` (00001's exact DDL plus
production's `video_url`/`image_url` columns, original constraints, index,
trigger, and policy names) and its row by precisely inverting 00007's
backfill — including flipping `status` back `processing` → `active`
(inverting the reconcile's section-4 correction) and rebuilding the
`dimensions` jsonb byte-identically; restores `orders` to its 00001 shape
(`drop_id` NOT NULL FK re-derived from `video_id`, 13 chain columns
dropped, the 4-value status check, original policies and grants); restores
00001's BOOLEAN `decrement_inventory` verbatim (function-definition md5 and
ACL match the pre-state); restores production's REAL policy names
(`profiles_public_read`, the three `seller_payments` self policies); drops
all 23 chain tables children-first with no CASCADE, 22 chain functions, 6
enum types; and unschedules the cron jobs behind the same pg_cron guard the
chain uses.

Verified twice by execution on a fresh replica rebuild (production policy
names modeled, no views — matching primary evidence): chain 00006→00016 in
ONE `psql --single-transaction`, exit 0, **251–310 ms wall-clock**; down
migration exit 0, clean on its first full cycle. Post-down state diffed
EXHAUSTIVELY against pre-chain (tables, columns+types+defaults, all
constraints, policies incl. roles/qual/with_check, function definitions and
ACLs, triggers, indexes, ACLs, enums, sequences, views, extensions, and
full row data minus `updated_at`): **one** residual difference, justified —
`orders.drop_id` sits at column ordinal 29 instead of 2, because Postgres
appends re-added columns and cannot reorder without a rewrite; name, type,
NOT NULL, FK, and index are identical, and nothing consumes column order.

Accepted irreversibilities, documented in the file header — all vacuous for
current production data (0 orders, 1 demo drop): COALESCEd shipping
defaults, `video_url` discarded by the chain itself, `mux_asset_id` nulled
by 00007's own backfill, the 'removed'-status mapping, and hypothetical
feed-era orders having no `drop_id` to restore.

## 4. Row-count and FK-integrity diff — CLEAN

Row counts, replica: pre-chain → post-chain → post-down. Every delta
expected and explained; full table below (chain-created tables show their
seeds).

| table | pre | post-chain | post-down | why |
|---|---|---|---|---|
| auth.users | 1 | 1 | 1 | untouched |
| profiles | 1 | 1 | 1 | constraints/policies/grants only; row data identical |
| drops | 1 | 0 (table dropped) | 1 | backfilled into videos/products, then reconstructed by the down; row identical minus updated_at |
| orders | 0 | 0 | 0 | columns only |
| seller_payments | 1 | 1 | 1 | policies dropped, rows untouched |
| processed_events | 0 | 0 | 0 | untouched |
| categories | — | 12 (00007 seed) | — | dropped by down |
| videos / products / shipping_profiles / video_products / seller_trust | — | 1 each (backfill from the drop) | — | consumed by inversion, dropped |
| feed_weights | — | 2 (control + dark ranked_v2) | — | dropped |
| rollup_state | — | 1 | — | dropped |
| category_rate_medians | — | 0 (seed correctly writes nothing on empty stats) | — | dropped |
| 14 other chain tables (feed_events, feed_slices, viewer_*, follows, video_stats, order_items, waitlist_entries, reports, discount_codes, …) | — | 0 | — | created empty, dropped |

FK integrity, post-chain: mechanical audit over **every** FK constraint in
the schema (30 constraints, including composite FKs, the viewer_identities
self-FK, and the three FKs into auth.users), generated LEFT JOIN orphan
checks with MATCH SIMPLE semantics: **0 orphan rows**.

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

## 8. ranked_v2 five-property audit (Task 0.2) — ALL FIVE PRESENT (verified at both the pure core and the wired path)

| # | Property | Verdict | Core evidence | Wired evidence |
|---|---|---|---|---|
| 1 | Stochastic selection, not greedy (P1 deterministic, 2..N softmax T≈0.08) | **PRESENT** | select.ts:636 (P1 no-rng), 175-197 softmax w/ log-sum-exp, T=0.08 (types.ts:42) | ranked-slice.ts:308-314 passes neither temperature nor engagedEvents → resolves to the 0.08 default; per-session seeded rng |
| 2 | Evidence gating: blend toward 0.5 ∝ min(1, impressions/100) | **PRESENT** | normalize.ts:67-78 evidenceGate, threshold 100 (types.ts:50); order is smooth → 2.5×-median norm → gate; every rate signal in signals.ts enumerated and routed through it | weights.ts:120 hardcodes the threshold (not a feed_weights column — no A/B row can weaken the gate) |
| 3 | Normalisation reference at 2.5× category median | **PRESENT** | types.ts:100 (2.5), normalize.ts:139-148 (reference = median × multiplier; zero/non-finite → 0.5 neutral, no div-by-zero); empty-table path falls to shipped defaults | weights.ts:121 code-constant; ranked-slice.ts:232→302 medians loaded and threaded |
| 4 | Affinity cap by iterative water-filling, floor 1/n | **PRESENT** | affinity.ts:324-404: effectiveCap = max(0.45, 1/n), freeze-and-redistribute loop, structural termination + n+2 guard; 2-key {9,1}→{0.5,0.5} verified concretely | events route → recordFeedEventsForAffinity → updateViewerAffinityWithSignals, default cap 0.45, applied to all three maps |
| 5 | Exploration lane floor 3 AND ceiling 6 per 20-slice | **PRESENT** | types.ts:46-48; select.ts enforces floor by slot reservation (short slice rather than dropped floor) and ceiling at 650-652; ids 4/5 structurally absent from RELAX_ORDER — neither can be relaxed | floor flows from feed_weights.min_fresh_per_slice; the ceiling has NO config column at all — code-constant 6 |

On the user's literal 1-in-3 vs 90-in-20,000 example: the fluke gates to
~0.51 (held AT neutral) while 90/20,000 scores ~0.09 — the fluke ranks
higher, and correctly so: 0.45% conversion against a 2% median is a
WELL-EVIDENCED bad performer that belongs below neutral. The gate's actual
guarantee — thin evidence can never rise meaningfully above neutral, and a
well-evidenced good performer (90/2,000 → 0.89) beats the fluke — holds.

Adjacent findings from the audit (reported, per instruction NOT yet fixed):
1. **REAL BUG, flagged for immediate follow-up — raw vs normalised
   affinity persistence.** affinity-update.ts:222-232 upserts
   `result.profile` (the normalised, sum-to-1, capped maps) into
   viewer_profiles and feeds those same maps back as the next pass's input.
   affinity.ts:141-150 explicitly documents that the running state must be
   `result.raw`: feeding normalised maps back is a scale mismatch — a
   single +10 purchase event dwarfs an entire ≤1.0 stored history, and
   decay-then-renormalise becomes a near-no-op. Passes unit tests because
   each single pass is correct; the damage only compounds across passes.
   Same family as the frozen-decay-clock bug fixed earlier: corrupts stored
   affinity today, user-visible once ranked_v2 takes traffic.
2. Spec-6.6 opt-ins are dead in production: adaptiveTemperature/
   engagedEvents (strangers should get T≈0.12) and the 1-in-20 uniform
   random slot exist in the core but are never passed by ranked-slice.ts —
   every viewer gets fixed T=0.08 and zero random slots. Deliberately
   opt-in by design; wiring them is a rollout-tuning decision, not a bug.
3. A feed_weights variant could set min_fresh_per_slice above 6, and
   select() raises the ceiling to match the floor — the only config path
   that can move the ceiling. Worth a guard or an ops note before tuning.

## Blockers summary

| # | Item | State |
|---|------|-------|
| 1 | PITR confirmed by operator (§1) | **OPEN — operator action** |
| 2 | T-0 snapshot re-taken clean (§2) | open until apply day |
| 3 | Down-migration verified on replica (§3) | **CLOSED** — verified twice by execution |
| 4 | Row-count/FK diff clean (§4) | **CLOSED** — 30 FKs, 0 orphans, 1 justified residual |
| 5 | Window plan accepted (§5–6) | ready for review |
