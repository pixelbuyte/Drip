import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { DRIP_FEE_BPS, getStripe } from '@/lib/stripe';
import {
  COUNTED_ORDER_STATUSES,
  FOUNDING_SELLER_CAP,
  STUDIO_ROUTES,
  type FoundingSellerStatus,
} from '@/lib/studio/types';
import {
  FEE_RATES,
  buildOrderEarnings,
  effectiveDripRatePct,
  orderRefFor,
  summarizeReversal,
  sumGrossCents,
  sumNetCents,
  volumeTierProgress,
  type OrderEarnings,
  type ReversalBreakdown,
  type VolumeTierProgress,
} from '@/lib/studio/earnings';
import {
  DASH,
  count,
  dateLabel,
  money,
  monthLabel,
  pct,
} from '@/lib/studio/format';

/**
 * Studio money — spec 7.6.
 *
 * One job: a seller should never have to compute anything, and should never
 * be surprised. Every fee is named, sourced and shown against the order it
 * came out of; every rate the seller is on is stated next to the rate they
 * would be paying if they had signed up later; and the two things sellers
 * find out about the hard way — an incomplete Stripe account silently holding
 * their money, and Stripe keeping its processing fee on a refund — are given
 * the loudest treatment on the screen rather than a footnote.
 *
 * ZERO ROWS IS A FIRST-CLASS STATE. The 00007 widening of `orders` is not
 * applied in production, so today most sellers land on the pre-sale screen.
 * That screen is not "empty": it shows the fee model on a worked example, so
 * the first real order lands on a layout they have already read.
 */

export const dynamic = 'force-dynamic';

/* ═══════════════════════════════════════════════════════════════════════════
   DATA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Await a Supabase query and flatten every failure to `null`.
 *
 * Same contract as `/studio`: a missing table, a revoked grant and a network
 * blip are all "no data" to this screen. `null` means the query failed,
 * `[]` means it succeeded and found nothing — the two are kept apart because
 * the first one is what triggers the legacy-column fallback below.
 */
async function safe<T>(
  query: PromiseLike<{ data: unknown; error: unknown }>
): Promise<T | null> {
  try {
    const { data, error } = await query;
    return error ? null : ((data ?? null) as T | null);
  } catch {
    return null;
  }
}

/** Service-role client, or null when the key is not configured. */
function adminOrNull(): ReturnType<typeof createAdminClient> | null {
  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
    return createAdminClient();
  } catch {
    return null;
  }
}

type ProfileRow = { created_at: string | null };

/**
 * Row shapes by hand, as on `/studio` — there is no generated `Database`
 * type, so an untyped `from()` infers `never`.
 */
type ModernOrderRow = {
  id: string;
  created_at: string | null;
  status: string | null;
  subtotal_cents: number | null;
  shipping_cents: number | null;
  total_cents: number | null;
  platform_fee_cents: number | null;
  label_url: string | null;
  refunded_at: string | null;
  disputed_at: string | null;
};

/**
 * `orders` as migration 00001 defines it — which is what production actually
 * has, because the 00007 widening is part of the un-applied feed set. Money
 * that exists today is in `amount_cents` / `shipping_cents`, and there is no
 * recorded application fee, so the breakdown falls back to computing it.
 */
type LegacyOrderRow = {
  id: string;
  created_at: string | null;
  status: string | null;
  amount_cents: number | null;
  shipping_cents: number | null;
  label_url: string | null;
};

/** The shape the rest of the file works in, whichever schema answered. */
type OrderRow = {
  id: string;
  createdAt: string | null;
  status: string | null;
  itemSubtotalCents: number;
  shippingChargedCents: number;
  /** `null` when the schema does not record it — then policy rates are used. */
  recordedApplicationFeeCents: number | null;
  hasLabel: boolean;
  reversedAt: string | null;
};

const MODERN_COLUMNS =
  'id, created_at, status, subtotal_cents, shipping_cents, total_cents, platform_fee_cents, label_url, refunded_at, disputed_at';
const LEGACY_COLUMNS = 'id, created_at, status, amount_cents, shipping_cents, label_url';

function fromModern(row: ModernOrderRow): OrderRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
    itemSubtotalCents: Number(row.subtotal_cents ?? 0),
    shippingChargedCents: Number(row.shipping_cents ?? 0),
    recordedApplicationFeeCents:
      row.platform_fee_cents === null || row.platform_fee_cents === undefined
        ? null
        : Number(row.platform_fee_cents),
    hasLabel: Boolean(row.label_url),
    reversedAt: row.refunded_at ?? row.disputed_at ?? null,
  };
}

function fromLegacy(row: LegacyOrderRow): OrderRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
    itemSubtotalCents: Number(row.amount_cents ?? 0),
    shippingChargedCents: Number(row.shipping_cents ?? 0),
    recordedApplicationFeeCents: null,
    hasLabel: Boolean(row.label_url),
    reversedAt: null,
  };
}

type SupabaseClient = Awaited<ReturnType<typeof createServerClient_>>;

/**
 * Fetch orders, tolerating the schema fork.
 *
 * The modern column set is tried first. A `null` result means the SELECT
 * itself failed — on today's production that is `column subtotal_cents does
 * not exist` — so the same window is re-read with the 00001 columns. An empty
 * array is a real answer and is returned as-is.
 */
async function loadOrders(
  supabase: SupabaseClient,
  userId: string,
  shape: (q: ReturnType<SupabaseClient['from']>) => PromiseLike<{ data: unknown; error: unknown }>,
  legacyShape: (
    q: ReturnType<SupabaseClient['from']>
  ) => PromiseLike<{ data: unknown; error: unknown }>
): Promise<OrderRow[]> {
  void userId;
  const modern = await safe<ModernOrderRow[]>(shape(supabase.from('orders')));
  if (modern !== null) return modern.map(fromModern);

  const legacy = await safe<LegacyOrderRow[]>(legacyShape(supabase.from('orders')));
  return (legacy ?? []).map(fromLegacy);
}

type PayoutStatus = {
  /** `null` = we could not reach Stripe. `0` = nothing pending. */
  pendingCents: number | null;
  nextPayoutDate: string | null;
  /** One sentence, ready to render. `null` when Stripe has not set one. */
  scheduleText: string | null;
  connected: boolean;
  chargesEnabled: boolean;
  /** `null` = unknown (Stripe unreachable); we only claim it when we know. */
  payoutsEnabled: boolean | null;
  /** Raw Stripe requirement keys, humanised. */
  requirements: string[];
  disabledReason: string | null;
};

type MoneyData = {
  displayName: string;
  founding: FoundingSellerStatus | null;
  /** Commission the platform is charging right now, in percentage points. */
  liveDripRatePct: number;
  monthIso: string;
  monthNetCents: number;
  monthGrossCents: number;
  monthOrderCount: number;
  lastMonthNetCents: number;
  tier: VolumeTierProgress | null;
  recent: OrderEarnings[];
  reversals: ReversalBreakdown[];
  payout: PayoutStatus;
};

async function loadMoney(): Promise<MoneyData | null> {
  let supabase: SupabaseClient;
  let userId: string;
  let displayName = 'there';
  try {
    supabase = await createServerClient_();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    userId = user.id;
  } catch {
    return null;
  }

  // ── The seller ──────────────────────────────────────────────────────────
  // Payment state comes from `seller_payments`, and it is read with the
  // SERVICE ROLE: The reconcile migration (00006) revokes every privilege on that table from `anon` and
  // `authenticated` (it holds the payout destination and the seller's home
  // address), so a caller-scoped read returns nothing and would render a
  // false "payouts not connected" alarm on every screen. Every other route
  // that touches this table does the same. The read is pinned to the caller's
  // own id, so authorisation is unchanged.
  const admin = adminOrNull();
  const [profile, payments] = await Promise.all([
    safe<{ created_at: string | null; display_name: string | null }>(
      supabase
        .from('profiles')
        .select('created_at, display_name')
        .eq('id', userId)
        .maybeSingle()
    ),
    admin
      ? safe<{ stripe_account_id: string | null; charges_enabled: boolean | null }>(
          admin
            .from('seller_payments')
            .select('stripe_account_id, charges_enabled')
            .eq('seller_id', userId)
            .maybeSingle()
        )
      : Promise.resolve(null),
  ]);

  displayName = profile?.display_name?.trim() || 'there';
  const founding = await loadFounding(supabase, profile?.created_at ?? null);

  // ── Orders ──────────────────────────────────────────────────────────────
  // Month boundaries are UTC, and `monthLabel()` reads the same instant, so
  // the figure and its caption can never describe different months.
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const lastMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const lastMonthStartIso = new Date(lastMonthStart).toISOString();
  const counted = [...COUNTED_ORDER_STATUSES];

  const [windowRows, recentRows, reversalRows] = await Promise.all([
    loadOrders(
      supabase,
      userId,
      (q) =>
        q
          .select(MODERN_COLUMNS)
          .eq('seller_id', userId)
          .in('status', counted)
          .gte('created_at', lastMonthStartIso),
      (q) =>
        q
          .select(LEGACY_COLUMNS)
          .eq('seller_id', userId)
          .in('status', counted)
          .gte('created_at', lastMonthStartIso)
    ),
    loadOrders(
      supabase,
      userId,
      (q) =>
        q
          .select(MODERN_COLUMNS)
          .eq('seller_id', userId)
          .in('status', counted)
          .order('created_at', { ascending: false })
          .limit(12),
      (q) =>
        q
          .select(LEGACY_COLUMNS)
          .eq('seller_id', userId)
          .in('status', counted)
          .order('created_at', { ascending: false })
          .limit(12)
    ),
    loadOrders(
      supabase,
      userId,
      (q) =>
        q
          .select(MODERN_COLUMNS)
          .eq('seller_id', userId)
          .in('status', ['refunded', 'disputed'])
          .order('created_at', { ascending: false })
          .limit(8),
      (q) =>
        q
          .select(LEGACY_COLUMNS)
          .eq('seller_id', userId)
          .in('status', ['refunded', 'disputed'])
          .order('created_at', { ascending: false })
          .limit(8)
    ),
  ]);

  // The rate to bill an order at when it did not record what it paid. This is
  // the LIVE commission from `@/lib/stripe`, not the policy rate — an order
  // charged during the 0% founding program must not be shown a 6% line.
  const liveDripRatePct = DRIP_FEE_BPS / 100;

  const toEarnings = (row: OrderRow): OrderEarnings =>
    buildOrderEarnings({
      orderRef: orderRefFor(row.id),
      soldAt: row.createdAt ?? '',
      itemSubtotalCents: row.itemSubtotalCents,
      shippingChargedCents: row.shippingChargedCents,
      // `orders` has no column for what EasyPost charged, so the cost is
      // genuinely unknown — never 0. `hasLabel` only says one was bought.
      labelCents: null,
      dripRatePct: liveDripRatePct,
      recordedApplicationFeeCents: row.recordedApplicationFeeCents,
    });

  let monthNetCents = 0;
  let monthGrossCents = 0;
  let monthOrderCount = 0;
  let lastMonthNetCents = 0;

  for (const row of windowRows) {
    if (!row.createdAt) continue;
    const at = Date.parse(row.createdAt);
    if (Number.isNaN(at)) continue;
    const earnings = toEarnings(row);
    if (at >= monthStart) {
      monthNetCents += earnings.netCents;
      monthGrossCents += earnings.grossCents;
      monthOrderCount += 1;
    } else if (at >= lastMonthStart) {
      lastMonthNetCents += earnings.netCents;
    }
  }

  const recent = recentRows.map(toEarnings);
  const reversals = reversalRows.map((row) => {
    const order = toEarnings(row);
    return summarizeReversal({
      // 00007's vocabulary separates the two; 00001-era rows only ever say
      // 'refunded'. Anything not explicitly disputed is treated as a refund.
      kind: row.status === 'disputed' ? 'dispute' : 'refund',
      order,
      // There is no partial-refund column anywhere in the schema, and the one
      // refund path in the codebase (the oversell auto-refund) returns the
      // whole charge. Every row that can exist today is a full reversal.
      refundedItemCents: order.grossCents,
      refundedShippingCents: order.shippingChargedCents,
      disputeFeeCents: null,
    });
  });

  const payout = await loadPayout(
    payments?.stripe_account_id ?? null,
    Boolean(payments?.charges_enabled)
  );

  return {
    displayName,
    founding,
    liveDripRatePct,
    monthIso: now.toISOString(),
    monthNetCents,
    monthGrossCents,
    monthOrderCount,
    lastMonthNetCents,
    tier: volumeTierProgress(monthGrossCents, founding?.isFounding ?? false),
    recent,
    reversals,
    payout,
  };
}

/**
 * Founding cohort by signup order, exactly as `/studio` computes it, so the
 * two screens can never quote different seller numbers.
 *
 * The rates here are the POLICY rates from spec 7.6 — what the seller is
 * locked at and what a later seller pays. What any individual order was
 * charged is a separate question, answered per row by `buildOrderEarnings`.
 */
async function loadFounding(
  supabase: SupabaseClient,
  createdAt: string | null
): Promise<FoundingSellerStatus | null> {
  if (!createdAt) return null;
  try {
    const { count: n, error } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .lte('created_at', createdAt);
    if (error || n === null || n < 1) return null;
    return {
      isFounding: n <= FOUNDING_SELLER_CAP,
      sellerNumber: n,
      lockedRatePct: FEE_RATES.foundingDripPct,
      standardRatePct: FEE_RATES.standardDripPct,
    };
  } catch {
    return null;
  }
}

/**
 * Stripe balance, payout schedule and KYC state.
 *
 * Unlike `/studio`, this call is NOT skipped for a seller with no sales:
 * "where is my money" is the whole question this screen answers, and an
 * account that is silently blocked must be reported before the first sale,
 * not after it. It is skipped only when there is no connected account at all
 * — then there is nothing to ask Stripe about.
 *
 * Every failure leaves the money figures `null`, which renders as an em dash.
 * A "$0.00 pending" for an unreachable Stripe is a lie.
 */
async function loadPayout(
  stripeAccountId: string | null,
  chargesEnabledFromDb: boolean
): Promise<PayoutStatus> {
  const base: PayoutStatus = {
    pendingCents: null,
    nextPayoutDate: null,
    scheduleText: null,
    connected: Boolean(stripeAccountId),
    chargesEnabled: chargesEnabledFromDb,
    payoutsEnabled: null,
    requirements: [],
    disabledReason: null,
  };

  if (!stripeAccountId) return base;

  try {
    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(stripeAccountId);

    base.chargesEnabled = account.charges_enabled === true;
    base.payoutsEnabled = account.payouts_enabled === true;
    base.requirements = (account.requirements?.currently_due ?? []).map(humaniseRequirement);
    base.disabledReason = account.requirements?.disabled_reason ?? null;
    base.scheduleText = payoutScheduleText(account);

    try {
      const balance = await stripe.balance.retrieve({ stripeAccount: stripeAccountId });
      base.pendingCents = balance.pending
        .filter((entry) => entry.currency === 'usd')
        .reduce((total, entry) => total + entry.amount, 0);
    } catch {
      // Account state is the load-bearing half; a missing balance is survivable.
    }

    try {
      const payouts = await stripe.payouts.list({ limit: 3 }, { stripeAccount: stripeAccountId });
      const upcoming = payouts.data.find(
        (p) => p.status === 'pending' || p.status === 'in_transit'
      );
      if (upcoming?.arrival_date) {
        base.nextPayoutDate = new Date(upcoming.arrival_date * 1000).toISOString();
      }
    } catch {
      // A missing date is survivable too.
    }

    return base;
  } catch {
    return base;
  }
}

/** "individual.verification.document" -> "Individual verification document". */
function humaniseRequirement(key: string): string {
  const words = key.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const WEEKDAYS: Record<string, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

/** One sentence describing when Stripe moves money to the seller's bank. */
function payoutScheduleText(account: {
  settings?: { payouts?: { schedule?: unknown } | null } | null;
}): string | null {
  const schedule = account.settings?.payouts?.schedule as
    | {
        interval?: string;
        delay_days?: number;
        weekly_anchor?: string;
        monthly_anchor?: number;
      }
    | undefined;
  if (!schedule?.interval) return null;

  const delay = typeof schedule.delay_days === 'number' ? schedule.delay_days : null;
  const after = delay === null ? '' : ` Funds clear ${delay} ${delay === 1 ? 'day' : 'days'} after a sale.`;

  switch (schedule.interval) {
    case 'manual':
      return 'Manual — money sits in your Stripe balance until you request a payout.';
    case 'daily':
      return `Daily.${after}`;
    case 'weekly': {
      const day = WEEKDAYS[String(schedule.weekly_anchor ?? '').toLowerCase()];
      return `Every ${day ?? 'week'}.${after}`;
    }
    case 'monthly': {
      const dayOfMonth = schedule.monthly_anchor;
      return `Monthly${typeof dayOfMonth === 'number' ? `, on day ${dayOfMonth}` : ''}.${after}`;
    }
    default:
      return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   PIECES
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Spec 7.6's retention mechanic, and the reason it is on every earnings
 * screen rather than in a settings page: the cost of leaving has to be
 * impossible to forget.
 *
 * The second line only appears when what Drip is charging today differs from
 * the locked rate. Quoting "6%" while the ledger below shows 0% would be the
 * kind of small inconsistency that makes a seller stop believing the rest.
 */
function FoundingBadge({
  status,
  liveRatePct,
}: {
  status: FoundingSellerStatus;
  liveRatePct: number;
}) {
  const differs = Math.abs(liveRatePct - status.lockedRatePct) > 0.001;

  return (
    <section className="rounded-card border border-violet/25 bg-violet/[0.07] p-4 md:p-5">
      <span className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-violet">
        Founding seller #{status.sellerNumber}
      </span>
      <p className="mt-2 text-[15px] font-bold leading-[1.45] text-ink">
        Your <span data-num>{pct(status.lockedRatePct)}</span> rate is locked for life. Standard
        rate is <span data-num>{pct(status.standardRatePct)}</span>.
      </p>
      {differs && (
        <p className="mt-1.5 text-[13px] leading-[1.5] text-muted">
          Right now Drip is charging founding sellers{' '}
          <span data-num>{pct(liveRatePct)}</span> — every order below shows exactly what you
          were charged, not what you are protected at.
        </p>
      )}
    </section>
  );
}

/**
 * The banner. Money arriving at a half-finished Stripe account is invisible
 * to the seller and looks, from where they sit, exactly like the platform not
 * paying them. Coral fill and an ink label — the CTA grammar — because this
 * has to be the loudest thing on the screen when it is true.
 */
function PayoutBlockedBanner({ payout }: { payout: PayoutStatus }) {
  const notConnected = !payout.connected;
  const heading = notConnected
    ? 'Your payouts are not connected yet'
    : payout.chargesEnabled
      ? 'Stripe cannot pay out yet'
      : 'Stripe still needs something from you';

  const body = notConnected
    ? 'Nothing is broken and nothing is lost — but until you finish this, a sale has nowhere to land. It takes about three minutes.'
    : payout.chargesEnabled
      ? 'You can take payments, but Stripe is holding the money until it can verify who to pay. It will sit in your balance, not disappear.'
      : 'Stripe has to verify you before it will release money to your bank. Sales still complete; the payout is what is blocked.';

  return (
    <section className="rounded-card bg-coral p-5 shadow-cta md:p-6">
      <span className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-ink/70">
        Action needed
      </span>
      <h2 className="mt-2 font-display text-[22px] font-extrabold leading-[1.1] tracking-[-0.02em] text-ink md:text-[26px]">
        {heading}
      </h2>
      <p className="mt-2.5 max-w-[46ch] text-[14px] leading-[1.55] text-ink/85">{body}</p>

      {payout.requirements.length > 0 && (
        <ul className="mt-4 grid grid-cols-1 gap-1.5">
          {payout.requirements.slice(0, 4).map((requirement) => (
            <li key={requirement} className="flex items-start gap-2 text-[13px] font-semibold text-ink">
              <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink" />
              {requirement}
            </li>
          ))}
        </ul>
      )}

      <Link
        href={STUDIO_ROUTES.connectPayouts}
        className="mt-5 flex min-h-[52px] w-full items-center justify-center rounded-full bg-ink px-7 text-[16px] font-bold text-cream transition-transform duration-[350ms] ease-spring active:scale-[0.96]"
      >
        {notConnected ? 'Connect payouts' : 'Finish verification'}
      </Link>
    </section>
  );
}

function Row({
  label,
  note,
  valueCents,
  sign,
  unknownText,
  tone = 'muted',
}: {
  label: string;
  note?: string;
  valueCents: number | null;
  sign?: '+' | '-';
  unknownText?: string;
  tone?: 'muted' | 'ink' | 'sale';
}) {
  const known = typeof valueCents === 'number';
  const body = known ? money(valueCents) : (unknownText ?? DASH);
  const text = known && sign ? `${sign === '-' ? '−' : '+'}${body}` : body;
  const toneClass =
    tone === 'ink' ? 'text-ink' : tone === 'sale' ? 'text-sale' : 'text-muted';

  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="min-w-0 text-[13.5px] leading-[1.4] text-muted">
        {label}
        {note && <span className="block text-[12px] text-muted/80">{note}</span>}
      </dt>
      <dd
        data-num
        className={`shrink-0 text-[14px] font-bold leading-[1.4] ${toneClass} ${known ? '' : 'font-semibold'}`}
      >
        {text}
      </dd>
    </div>
  );
}

/**
 * One order, line by line — the spec 7.6 ledger.
 *
 * The label line is the honest one. `orders` has no column for what EasyPost
 * charged, so the cost is unknown rather than zero, and the total is named
 * "You keep, before the label" rather than quietly pretending postage was
 * free. Understating a cost on a money screen is the same class of error as
 * overstating a fee.
 */
function OrderLedger({ order, hasLabel }: { order: OrderEarnings; hasLabel?: boolean }) {
  const labelKnown = typeof order.labelCents === 'number';

  return (
    <article className="rounded-card bg-card p-4 shadow-card md:p-5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h3 data-num className="truncate font-display text-[15px] font-extrabold tracking-[-0.01em] text-ink">
            Order {order.orderRef}
          </h3>
          <p className="mt-0.5 text-[12.5px] text-muted">{dateLabel(order.soldAt)}</p>
        </div>
        <p data-num className="shrink-0 font-display text-[20px] font-extrabold leading-none tracking-[-0.02em] text-ink">
          {money(order.grossCents)}
        </p>
      </div>

      <dl className="mt-3 border-t border-hairline pt-2">
        <Row
          label={`Drip fee (${pct(order.dripFeeRatePct, order.dripFeeRatePct % 1 === 0 ? 0 : 2)})`}
          valueCents={order.dripFeeCents}
          sign="-"
        />
        <Row
          label={`Card processing (${pct(FEE_RATES.processingPct, 1)} + ${money(FEE_RATES.processingFixedCents)})`}
          note="Stripe's, not Drip's — charged on the full amount the buyer paid"
          valueCents={order.processingCents}
          sign="-"
        />
        <Row label="Shipping (buyer paid)" valueCents={order.shippingChargedCents} sign="+" />
        <Row
          label="Label (EasyPost)"
          valueCents={order.labelCents}
          sign="-"
          unknownText={hasLabel ? 'Bought — cost not recorded' : 'Not bought yet'}
        />
        {order.absorbedByDripCents > 0 && (
          <Row
            label="Card fee Drip covered for you"
            note="The processing fee was larger than the sale, so Drip paid the rest"
            valueCents={order.absorbedByDripCents}
            sign="+"
          />
        )}
      </dl>

      <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-hairline-strong pt-3">
        <p className="text-[14px] font-bold text-ink">
          You keep
          {!labelKnown && <span className="font-semibold text-muted"> (before the label)</span>}
        </p>
        <p data-num className="shrink-0 font-display text-[22px] font-extrabold leading-none tracking-[-0.02em] text-ink">
          {money(order.netCents)}
        </p>
      </div>
    </article>
  );
}

/**
 * Spec 7.6's volume tier. Principle 1: a number with no implied action is
 * decoration — so this is a distance to a specific, stated outcome, never a
 * bare "revenue this month".
 */
function TierCard({ tier }: { tier: VolumeTierProgress }) {
  return (
    <section className="rounded-card bg-card p-5 shadow-card md:p-6">
      <h2 className="font-display text-[17px] font-extrabold tracking-[-0.02em] text-ink">
        Your next rate
      </h2>
      <p className="mt-2 text-[15px] leading-[1.5] text-ink">
        <span data-num className="font-bold">{money(tier.monthGrossCents)}</span> of{' '}
        <span data-num className="font-bold">{money(tier.thresholdCents)}</span> this month — cross
        it and your rate drops to <span data-num className="font-bold">{pct(tier.nextRatePct)}</span>.
      </p>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(tier.progressPct)}
        aria-label={`Progress to the ${pct(tier.nextRatePct)} rate`}
        className="mt-4 h-3 w-full overflow-hidden rounded-full bg-hairline-strong"
      >
        <div
          className="h-full rounded-full bg-coral transition-[width] duration-500 ease-out"
          style={{ width: `${tier.progressPct}%` }}
        />
      </div>

      <p className="mt-2.5 text-[13px] leading-[1.5] text-muted">
        <span data-num>{money(tier.remainingCents)}</span> to go. Tiers reset with the calendar
        month, and they are measured on what you sold, before shipping. You are on{' '}
        <span data-num>{pct(tier.currentRatePct)}</span> today.
      </p>
    </section>
  );
}

function PayoutCard({ payout }: { payout: PayoutStatus }) {
  const healthy = payout.connected && payout.chargesEnabled && payout.payoutsEnabled !== false;

  return (
    <section className="rounded-card bg-card p-5 shadow-card md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="font-display text-[17px] font-extrabold tracking-[-0.02em] text-ink">
          Payouts
        </h2>
        {healthy ? (
          <span className="rounded-full bg-lime px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em] text-ink">
            Stripe connected
          </span>
        ) : (
          <span className="rounded-full bg-coral/10 px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em] text-coral-deep">
            {payout.connected ? 'Verification pending' : 'Not connected'}
          </span>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-art border border-hairline bg-cream px-4 py-3.5">
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-muted">
            Pending at Stripe
          </p>
          <p data-num className="mt-1.5 text-[22px] font-extrabold leading-none text-ink">
            {money(payout.pendingCents)}
          </p>
        </div>
        <div className="rounded-art border border-hairline bg-cream px-4 py-3.5">
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-muted">
            Next payout lands
          </p>
          <p className="mt-1.5 text-[18px] font-extrabold leading-none text-ink">
            {payout.nextPayoutDate ? dateLabel(payout.nextPayoutDate) : 'Not scheduled'}
          </p>
        </div>
      </div>

      <p className="mt-4 text-[13.5px] leading-[1.55] text-muted">
        <span className="font-bold text-ink">Schedule. </span>
        {payout.scheduleText ??
          (payout.connected
            ? 'Stripe has not set a payout schedule for this account yet. It appears here as soon as it does.'
            : 'Connect payouts and Stripe will set a schedule — usually daily, a couple of days behind each sale.')}
      </p>

      {payout.pendingCents === null && payout.connected && (
        <p className="mt-2 text-[13px] leading-[1.5] text-muted">
          We could not reach Stripe just now, so the balance above is unknown rather than zero.
          Nothing has happened to your money.
        </p>
      )}

      {payout.disabledReason && (
        <p className="mt-2 text-[13px] leading-[1.5] text-sale">
          Stripe reports: {humaniseRequirement(payout.disabledReason)}.
        </p>
      )}
    </section>
  );
}

/**
 * The refund and dispute log.
 *
 * The paragraph at the top is the point of the section. Sellers overwhelmingly
 * learn this from a bank statement, decide they were cheated, and never post
 * again. Saying it here, before it happens, costs nothing and is the whole
 * difference between "a fee I knew about" and "they took my money".
 */
function ReversalLog({ reversals }: { reversals: ReversalBreakdown[] }) {
  return (
    <section className="mt-7">
      <h2 className="font-display text-[20px] font-extrabold tracking-[-0.02em] text-ink">
        Refunds and disputes
      </h2>

      <div className="mt-3 rounded-card border border-hairline p-4 md:p-5">
        <p className="text-[14px] leading-[1.6] text-muted">
          <span className="font-bold text-ink">Stripe keeps its processing fee on a refund.</span>{' '}
          Drip returns its commission in full — every cent of it — but the{' '}
          <span data-num>{pct(FEE_RATES.processingPct, 1)}</span> +{' '}
          <span data-num>{money(FEE_RATES.processingFixedCents)}</span> the card networks charged
          to move the money is gone, and refunding does not bring it back. So a fully refunded
          order leaves you down by that fee, plus any label you had already bought. That is not
          Drip&rsquo;s policy and we cannot waive it — but you should never find it out from a
          bank statement.
        </p>
        <p className="mt-2.5 text-[14px] leading-[1.6] text-muted">
          A dispute works the same way, and Stripe adds its own dispute fee on top. Stripe sets
          that amount, so it shows here as unknown until Stripe tells us what it was.
        </p>
      </div>

      {reversals.length === 0 ? (
        <p className="mt-3 text-[14px] leading-[1.5] text-muted">
          You have not had a refund or a dispute. Nothing to show here — which is the good
          version of this section.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3">
          {reversals.map((reversal) => (
            <article
              key={`${reversal.kind}-${reversal.orderRef}`}
              className="rounded-card bg-card p-4 shadow-card md:p-5"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h3 data-num className="truncate font-display text-[15px] font-extrabold tracking-[-0.01em] text-ink">
                  Order {reversal.orderRef}
                </h3>
                <span className="shrink-0 rounded-full bg-sale/10 px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em] text-sale">
                  {reversal.kind === 'dispute' ? 'Disputed' : 'Refunded'}
                </span>
              </div>

              <dl className="mt-3 border-t border-hairline pt-2">
                <Row
                  label={reversal.isFull ? 'Returned to the buyer (in full)' : 'Returned to the buyer'}
                  valueCents={reversal.refundedCents}
                  sign="-"
                />
                <Row
                  label="Drip fee given back"
                  valueCents={reversal.dripFeeReturnedCents}
                  sign="+"
                />
                <Row
                  label="Card processing Stripe kept"
                  note="Not refundable"
                  valueCents={reversal.processingKeptCents}
                  sign="-"
                  tone="sale"
                />
                <Row
                  label="Label already bought"
                  valueCents={reversal.labelCents}
                  sign="-"
                  unknownText="Cost not recorded"
                />
                {reversal.kind === 'dispute' && (
                  <Row
                    label="Stripe dispute fee"
                    valueCents={reversal.disputeFeeCents}
                    sign="-"
                    unknownText="Set by Stripe"
                    tone="sale"
                  />
                )}
              </dl>

              <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-hairline-strong pt-3">
                <p className="text-[14px] font-bold text-ink">
                  {reversal.netCents < 0 ? 'You are out' : 'You keep'}
                </p>
                <p
                  data-num
                  className={`shrink-0 font-display text-[22px] font-extrabold leading-none tracking-[-0.02em] ${
                    reversal.netCents < 0 ? 'text-sale' : 'text-ink'
                  }`}
                >
                  {money(reversal.netCents)}
                </p>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/** Principle 4, applied to money: explain the mechanism, not just the total. */
function HowFeesWork({ liveRatePct }: { liveRatePct: number }) {
  return (
    <section className="mt-7 rounded-card border border-hairline p-5">
      <h2 className="font-display text-[17px] font-extrabold tracking-[-0.02em] text-ink">
        Where every cent goes
      </h2>
      <dl className="mt-3 grid grid-cols-1 gap-3.5">
        <div>
          <dt className="text-[13.5px] font-bold text-ink">
            Drip&rsquo;s fee — <span data-num>{pct(liveRatePct)}</span> today
          </dt>
          <dd className="mt-1 text-[13.5px] leading-[1.55] text-muted">
            Charged on the item price only. You are never charged commission on the shipping you
            collected, because that money is the carrier&rsquo;s, not yours.
          </dd>
        </div>
        <div>
          <dt className="text-[13.5px] font-bold text-ink">
            Card processing — <span data-num>{pct(FEE_RATES.processingPct, 1)}</span> +{' '}
            <span data-num>{money(FEE_RATES.processingFixedCents)}</span>
          </dt>
          <dd className="mt-1 text-[13.5px] leading-[1.55] text-muted">
            Stripe&rsquo;s, and Drip keeps none of it. It is charged on the full amount the buyer
            paid — items and shipping together — which is why it is a few cents more than{' '}
            <span data-num>{pct(FEE_RATES.processingPct, 1)}</span> of the price tag. On a sale
            small enough that the <span data-num>{money(FEE_RATES.processingFixedCents)}</span>{' '}
            would swallow it whole, Drip pays the difference so you never go backwards.
          </dd>
        </div>
        <div>
          <dt className="text-[13.5px] font-bold text-ink">Shipping and the label</dt>
          <dd className="mt-1 text-[13.5px] leading-[1.55] text-muted">
            The buyer pays shipping to you, and you buy the label. Charge more than the label
            costs and you keep the difference; charge less and you cover it. Drip does not record
            what EasyPost charged, so label costs show as unknown rather than as zero.
          </dd>
        </div>
        <div>
          <dt className="text-[13.5px] font-bold text-ink">Getting paid</dt>
          <dd className="mt-1 text-[13.5px] leading-[1.55] text-muted">
            Money goes straight from the buyer to your own Stripe account — it never sits in a
            Drip balance. Stripe holds it briefly against chargebacks, then pays your bank on the
            schedule above.
          </dd>
        </div>
      </dl>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE SCREEN
   ═══════════════════════════════════════════════════════════════════════════ */

export default async function StudioMoneyPage() {
  const data = await loadMoney();
  // The layout already guards; this is the same answer if it is ever bypassed.
  if (!data) redirect('/auth/login');

  const blocked = !data.payout.connected || !data.payout.chargesEnabled || data.payout.payoutsEnabled === false;
  const hasSales = data.recent.length > 0 || data.monthOrderCount > 0;

  return (
    <div className="mx-auto w-full max-w-[560px] px-5 pt-6 md:max-w-[900px] md:px-10 md:pt-10">
      <h1 className="font-display text-[30px] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink md:text-[38px]">
        Money
      </h1>
      <p className="mt-1.5 text-[14px] leading-[1.5] text-muted">
        Every fee, named and sourced. Nothing here needs a calculator.
      </p>

      <div className="mt-5 grid grid-cols-1 gap-4">
        {blocked && <PayoutBlockedBanner payout={data.payout} />}
        {data.founding?.isFounding && (
          <FoundingBadge status={data.founding} liveRatePct={data.liveDripRatePct} />
        )}
      </div>

      {hasSales ? (
        <EarnedCard
          monthIso={data.monthIso}
          netCents={data.monthNetCents}
          orderCount={data.monthOrderCount}
          lastMonthNetCents={data.lastMonthNetCents}
        />
      ) : (
        <BeforeFirstSale
          displayName={data.displayName}
          liveRatePct={data.liveDripRatePct}
          monthIso={data.monthIso}
        />
      )}

      <div className="mt-4 grid grid-cols-1 gap-4">
        {data.tier && <TierCard tier={data.tier} />}
        <PayoutCard payout={data.payout} />
      </div>

      {data.recent.length > 0 && (
        <section className="mt-7">
          <h2 className="font-display text-[20px] font-extrabold tracking-[-0.02em] text-ink">
            Where your money went
          </h2>
          <p className="mt-1.5 text-[14px] leading-[1.5] text-muted">
            Your last {count(data.recent.length)} {data.recent.length === 1 ? 'order' : 'orders'},
            broken out to the cent.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3">
            {data.recent.map((order) => (
              <OrderLedger key={order.orderRef} order={order} />
            ))}
          </div>
        </section>
      )}

      <ReversalLog reversals={data.reversals} />
      <HowFeesWork liveRatePct={data.liveDripRatePct} />
    </div>
  );
}

function EarnedCard({
  monthIso,
  netCents,
  orderCount,
  lastMonthNetCents,
}: {
  monthIso: string;
  netCents: number;
  orderCount: number;
  lastMonthNetCents: number;
}) {
  return (
    <section className="mt-4 rounded-card bg-card p-5 shadow-card md:p-7">
      <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">
        You kept in {monthLabel(monthIso)}
      </p>
      <p
        data-num
        className="mt-2 font-display text-[42px] font-extrabold leading-none tracking-[-0.035em] text-ink md:text-[54px]"
      >
        {money(netCents)}
      </p>
      <p className="mt-2.5 text-[14px] leading-[1.5] text-muted">
        {orderCount === 0 ? (
          'No sales yet this month.'
        ) : (
          <>
            After every fee, across <span data-num>{count(orderCount)}</span>{' '}
            {orderCount === 1 ? 'order' : 'orders'}. Label costs are not in this figure — Drip
            does not record them.
          </>
        )}
      </p>
      {lastMonthNetCents > 0 && (
        <p className="mt-1.5 text-[13px] text-muted">
          Last month you kept <span data-num className="font-semibold">{money(lastMonthNetCents)}</span>.
        </p>
      )}
    </section>
  );
}

/**
 * No sales yet — which today is every seller.
 *
 * Not four cards of "$0.00". The fee model on a real worked example, laid out
 * in exactly the component a real order will use, so the first payout lands
 * on a page they have already read once.
 */
function BeforeFirstSale({
  displayName,
  liveRatePct,
  monthIso,
}: {
  displayName: string;
  liveRatePct: number;
  monthIso: string;
}) {
  const example = buildOrderEarnings({
    orderRef: '#DRP-EXAMPL',
    soldAt: monthIso,
    itemSubtotalCents: 4_000,
    shippingChargedCents: 600,
    labelCents: null,
    dripRatePct: liveRatePct,
  });

  return (
    <section className="mt-4 rounded-card bg-card p-6 shadow-card md:p-8">
      <span className="inline-block rounded-full bg-lime px-3 py-1 text-[11px] font-extrabold uppercase tracking-[0.07em] text-ink">
        No sales yet
      </span>
      <h2 className="mt-4 max-w-[20ch] font-display text-[28px] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink md:text-[34px]">
        Here is exactly what you&rsquo;ll keep, {displayName}.
      </h2>
      <p className="mt-3 max-w-[46ch] text-[15px] leading-[1.6] text-muted">
        Nothing has sold yet, so there is nothing to add up. This is the shape every order will
        take when one does — a real <span data-num>{money(4_000)}</span> item with{' '}
        <span data-num>{money(600)}</span> of shipping, at the rate you are on today.
      </p>

      <div className="mt-5">
        <OrderLedger order={example} />
      </div>

      <Link
        href={STUDIO_ROUTES.newVideo}
        className="mt-6 flex min-h-[54px] w-full items-center justify-center rounded-full bg-coral px-7 text-[16px] font-bold text-ink shadow-cta transition-transform duration-[350ms] ease-spring active:scale-[0.96]"
      >
        Post a video
      </Link>
      <p className="mt-3 text-[13px] leading-[1.5] text-muted">
        Every video is shown to at least 500 shoppers in its first 48 hours, so the first order is
        a question of what you post, not of who follows you.
      </p>
    </section>
  );
}
