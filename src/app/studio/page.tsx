import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { DRIP_FEE_BPS, getStripe } from '@/lib/stripe';
import {
  COUNTED_ORDER_STATUSES,
  FOUNDING_SELLER_CAP,
  FRESHNESS_HALF_LIFE_HOURS,
  REACH_GUARANTEE_IMPRESSIONS,
  REACH_GUARANTEE_WINDOW_HOURS,
  STANDARD_DRIP_FEE_PCT,
  STUDIO_ROUTES,
  type FoundingSellerStatus,
  type LiveVideo,
  type StudioPulse,
  type StudioSeller,
  type Todo,
} from '@/lib/studio/types';
import {
  count,
  dateLabel,
  deltaLabel,
  hoursSince,
  money,
  monthLabel,
  pct,
  progressPct,
  sinceLabel,
} from '@/lib/studio/format';

/**
 * Studio home — the pulse (spec 7.2).
 *
 * "The feed decides whether a video sells. This dashboard decides whether the
 * seller uploads again." Everything above the fold answers one of two
 * questions: what did I make, and is my newest video being seen.
 *
 * ZERO ROWS IS THE DEFAULT STATE. The feed tables in 00007-00011 are not
 * applied in production yet, so today every query below returns nothing — and
 * that is also exactly what a brand-new seller sees. The first-run screen is
 * therefore the main screen, not a fallback, and no query is allowed to throw
 * its way onto it.
 */

export const dynamic = 'force-dynamic';

/* ═══════════════════════════════════════════════════════════════════════════
   DATA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Await a Supabase query and flatten every failure to `null`.
 *
 * A missing table, a revoked grant and a network blip are all the same thing
 * to this screen: no data. Postgrest reports the first two in `error` and
 * throws for the third, so both paths are swallowed here.
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

/**
 * Row shapes, declared by hand.
 *
 * There is no generated `Database` type in this project, so an untyped
 * `from('videos')` infers `never` and every field access becomes an error.
 * Writing the shapes out is better than casting to `any` anyway: these are
 * the exact columns 00007-00011 define, so a column that gets renamed during
 * the schema reconciliation shows up here as a compile error instead of as
 * `undefined` at runtime.
 */
type ProfileRow = {
  id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string | null;
};

type PaymentsRow = {
  stripe_account_id: string | null;
  charges_enabled: boolean | null;
  from_address: unknown;
};

type VideoRow = {
  id: string;
  caption: string | null;
  published_at: string | null;
};

type StatRow = {
  video_id: string;
  impressions_all: number | null;
  product_taps_all: number | null;
  purchases_all: number | null;
  exploration_impressions: number | null;
};

type LinkRow = { video_id: string; product_id: string; position: number | null };

type ProductRow = {
  id: string;
  title: string;
  inventory_count: number | null;
  status: string | null;
};

/** Service-role client, or null when the key is not configured. */
function adminOrNull(): ReturnType<typeof createAdminClient> | null {
  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
    return createAdminClient();
  } catch {
    return null;
  }
}

type OrderRow = {
  created_at: string | null;
  status: string | null;
  total_cents: number | null;
  platform_fee_cents: number | null;
};

/** What actually lands in the seller's Stripe balance for one order. */
function netCents(order: OrderRow): number {
  return (order.total_cents ?? 0) - (order.platform_fee_cents ?? 0);
}

type PulseData = {
  seller: StudioSeller;
  pulse: StudioPulse;
  /** UTC month the earnings figure covers, so the caption cannot disagree. */
  monthIso: string;
};

async function loadPulse(): Promise<PulseData | null> {
  let supabase: Awaited<ReturnType<typeof createServerClient_>>;
  let userId: string;
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
  // Payment state comes from seller_payments, never from profiles: profiles
  // has a public read policy, and the Stripe id plus the seller's home
  // address were moved off it deliberately.
  const [profile, payments] = await Promise.all([
    safe<ProfileRow>(
      supabase
        .from('profiles')
        .select('id, handle, display_name, avatar_url, created_at')
        .eq('id', userId)
        .maybeSingle()
    ),
    safe<PaymentsRow>(
      supabase
        .from('seller_payments')
        .select('stripe_account_id, charges_enabled, from_address')
        .eq('seller_id', userId)
        .maybeSingle()
    ),
  ]);

  const seller: StudioSeller = {
    id: userId,
    handle: profile?.handle ?? '',
    displayName: profile?.display_name ?? 'there',
    avatarUrl: profile?.avatar_url ?? null,
    chargesEnabled: Boolean(payments?.charges_enabled),
    hasShipFromAddress: Boolean(payments?.from_address),
    founding: await loadFounding(supabase, profile?.created_at ?? null),
  };

  // ── Live videos and their reach-guarantee progress ──────────────────────
  const videoRows =
    (await safe<VideoRow[]>(
      supabase
        .from('videos')
        .select('id, caption, published_at')
        .eq('seller_id', userId)
        .eq('status', 'live')
        .not('published_at', 'is', null)
        .order('published_at', { ascending: false })
        .limit(12)
    )) ?? [];

  const videoIds = videoRows.map((v) => v.id);

  // video_stats grants `authenticated` only likes and purchase counts (00009);
  // impressions and the exploration budget are seller-private and readable
  // only by the service role. Safe because videoIds came from a query already
  // filtered to this seller — the admin client never widens the row set.
  const admin = adminOrNull();
  const statRows =
    videoIds.length > 0 && admin
      ? ((await safe<StatRow[]>(
          admin
            .from('video_stats')
            .select(
              'video_id, impressions_all, product_taps_all, purchases_all, exploration_impressions'
            )
            .in('video_id', videoIds)
        )) ?? [])
      : [];

  const statsById = new Map(statRows.map((s) => [s.video_id, s]));

  // Titles and stock, for videos whose caption is empty and for the
  // "selling something sold out" check.
  const links =
    videoIds.length > 0
      ? ((await safe<LinkRow[]>(
          supabase
            .from('video_products')
            .select('video_id, product_id, position')
            .in('video_id', videoIds)
            .order('position', { ascending: true })
        )) ?? [])
      : [];

  const productIds = [...new Set(links.map((l) => l.product_id))];
  const productRows =
    productIds.length > 0
      ? ((await safe<ProductRow[]>(
          supabase
            .from('products')
            .select('id, title, inventory_count, status')
            .in('id', productIds)
        )) ?? [])
      : [];

  const productsById = new Map(productRows.map((p) => [p.id, p]));
  const firstProductByVideo = new Map<string, ProductRow>();
  for (const link of links) {
    if (firstProductByVideo.has(link.video_id)) continue;
    const product = productsById.get(link.product_id);
    if (product) firstProductByVideo.set(link.video_id, product);
  }

  const liveVideos: LiveVideo[] = videoRows
    .filter((v): v is VideoRow & { published_at: string } => Boolean(v.published_at))
    .map((v) => {
      const stats = statsById.get(v.id);
      const fallbackTitle = firstProductByVideo.get(v.id)?.title;
      return {
        videoId: v.id,
        title: v.caption?.trim() || fallbackTitle || 'Untitled video',
        postedAt: v.published_at,
        impressions: Number(stats?.impressions_all ?? 0),
        taps: Number(stats?.product_taps_all ?? 0),
        sold: Number(stats?.purchases_all ?? 0),
        budgetDelivered: Number(stats?.exploration_impressions ?? 0),
        budgetTotal: REACH_GUARANTEE_IMPRESSIONS,
      };
    });

  // ── Money ───────────────────────────────────────────────────────────────
  // Month boundaries are UTC; monthLabel() reads the same instant, so the
  // figure and its caption can never describe different months.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  );

  const orders =
    (await safe<OrderRow[]>(
      supabase
        .from('orders')
        .select('created_at, status, total_cents, platform_fee_cents')
        .eq('seller_id', userId)
        .in('status', [...COUNTED_ORDER_STATUSES])
        .gte('created_at', lastMonthStart.toISOString())
    )) ?? [];

  let earnedCentsThisMonth = 0;
  let orderCount = 0;
  let lastMonthCents = 0;

  for (const order of orders) {
    if (!order.created_at) continue;
    const at = Date.parse(order.created_at);
    if (Number.isNaN(at)) continue;
    if (at >= monthStart.getTime()) {
      earnedCentsThisMonth += netCents(order);
      orderCount += 1;
    } else if (at >= lastMonthStart.getTime()) {
      lastMonthCents += netCents(order);
    }
  }

  // A change from zero is undefined, not infinite. Pass null and let the
  // screen write real copy for it.
  const deltaVsLastMonthPct =
    lastMonthCents > 0
      ? ((earnedCentsThisMonth - lastMonthCents) / lastMonthCents) * 100
      : null;

  const { pendingPayoutCents, nextPayoutDate } = await loadPayout(
    payments?.stripe_account_id ?? null,
    orderCount > 0 || lastMonthCents > 0
  );

  return {
    seller,
    monthIso: now.toISOString(),
    pulse: {
      earnedCentsThisMonth,
      orderCount,
      deltaVsLastMonthPct,
      pendingPayoutCents,
      nextPayoutDate,
      liveVideos,
      todos: buildTodos(seller, liveVideos, links, productsById),
    },
  };
}

/**
 * Founding-seller cohort by signup order. `profiles` is publicly readable, so
 * this is a plain count of accounts created no later than this one.
 */
async function loadFounding(
  supabase: Awaited<ReturnType<typeof createServerClient_>>,
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
      lockedRatePct: DRIP_FEE_BPS / 100,
      standardRatePct: STANDARD_DRIP_FEE_PCT,
    };
  } catch {
    return null;
  }
}

/**
 * Stripe balance and the next payout's arrival date.
 *
 * Skipped entirely when the seller has never had a counted order — which is
 * every seller today. That keeps the first-run screen free of a network round
 * trip it would learn nothing from. Any failure leaves both values null:
 * "unknown" renders as an em dash, never as $0.00.
 */
async function loadPayout(
  stripeAccountId: string | null,
  hasSales: boolean
): Promise<{ pendingPayoutCents: number | null; nextPayoutDate: string | null }> {
  if (!stripeAccountId || !hasSales) {
    return { pendingPayoutCents: null, nextPayoutDate: null };
  }

  try {
    const stripe = getStripe();

    const balance = await stripe.balance.retrieve({ stripeAccount: stripeAccountId });
    const pendingPayoutCents = balance.pending
      .filter((b) => b.currency === 'usd')
      .reduce((sum, b) => sum + b.amount, 0);

    let nextPayoutDate: string | null = null;
    try {
      const payouts = await stripe.payouts.list(
        { limit: 3 },
        { stripeAccount: stripeAccountId }
      );
      const upcoming = payouts.data.find(
        (p) => p.status === 'pending' || p.status === 'in_transit'
      );
      if (upcoming?.arrival_date) {
        nextPayoutDate = new Date(upcoming.arrival_date * 1000).toISOString();
      }
    } catch {
      // Balance is the load-bearing figure; a missing date is survivable.
    }

    return { pendingPayoutCents, nextPayoutDate };
  } catch {
    return { pendingPayoutCents: null, nextPayoutDate: null };
  }
}

/**
 * At most three actions, hardest-hitting first. Every entry is something the
 * seller can influence and something they can click; an observation with no
 * lever is decoration and does not belong here.
 */
function buildTodos(
  seller: StudioSeller,
  liveVideos: LiveVideo[],
  links: LinkRow[],
  productsById: Map<string, ProductRow>
): Todo[] {
  const todos: Todo[] = [];
  const liveIds = new Set(liveVideos.map((v) => v.videoId));
  // One video should not eat two of the three slots: a seller with one
  // problematic upload would then see nothing about the rest of their work.
  const claimed = new Set<string>();

  // 1. Money leaking right now: a live video selling something nobody can buy.
  const soldOutLink = links.find((l) => {
    if (!liveIds.has(l.video_id)) return false;
    const product = productsById.get(l.product_id);
    return product ? (product.inventory_count ?? 0) <= 0 : false;
  });
  if (soldOutLink) {
    const product = productsById.get(soldOutLink.product_id);
    todos.push({
      kind: 'restock',
      text: `“${truncate(product?.title ?? 'A product')}” is sold out but its video is still live — restock it or swap the product`,
      href: STUDIO_ROUTES.video(soldOutLink.video_id),
    });
    claimed.add(soldOutLink.video_id);
  }

  // 2. Nothing can pay out.
  if (!seller.chargesEnabled) {
    todos.push({
      kind: 'connect_payouts',
      text: 'Connect payouts — until you do, a sale cannot reach your bank',
      href: STUDIO_ROUTES.connectPayouts,
    });
  }

  // 3. Nothing can ship.
  if (!seller.hasShipFromAddress) {
    todos.push({
      kind: 'add_ship_from_address',
      text: 'Add your ship-from address so a sale can print a label',
      href: STUDIO_ROUTES.shipFromAddress,
    });
  }

  if (liveVideos.length === 0) {
    todos.push({
      kind: 'post_first_video',
      text: `Post your first video — ${count(REACH_GUARANTEE_IMPRESSIONS)} guaranteed impressions, no followers needed`,
      href: STUDIO_ROUTES.newVideo,
    });
    return todos.slice(0, 3);
  }

  const newest = liveVideos[0];

  // 4. The guarantee finished — the 500 have an answer in them.
  const finished = liveVideos.find(
    (v) => v.budgetDelivered >= v.budgetTotal && !claimed.has(v.videoId)
  );
  if (finished) {
    todos.push({
      kind: 'review_funnel',
      text: `“${truncate(finished.title)}” finished its ${count(finished.budgetTotal)} — see what they did with it`,
      href: STUDIO_ROUTES.video(finished.videoId),
    });
    claimed.add(finished.videoId);
  }

  // 5. Freshness has decayed. Half-life is 72h, so a week is three halvings.
  const hours = hoursSince(newest.postedAt);
  if (hours !== null && hours >= 24 * 7) {
    todos.push({
      kind: 'post_again',
      text: `Your last video went up ${sinceLabel(newest.postedAt)} — freshness halves every ${FRESHNESS_HALF_LIFE_HOURS}h, and a new post starts at the full ${count(REACH_GUARANTEE_IMPRESSIONS)} again`,
      href: STUDIO_ROUTES.newVideo,
    });
  }

  return todos.slice(0, 3);
}

function truncate(s: string, max = 32): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PIECES
   ═══════════════════════════════════════════════════════════════════════════ */

function FoundingBadge({ status }: { status: FoundingSellerStatus }) {
  return (
    <div className="mb-4 inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-full bg-violet/10 px-3.5 py-1.5">
      <span className="text-[12px] font-extrabold uppercase tracking-[0.07em] text-violet">
        Founding seller #{status.sellerNumber}
      </span>
      <span data-num className="text-[12px] font-semibold text-muted">
        {pct(status.lockedRatePct)} Drip fee, locked — later sellers pay{' '}
        {pct(status.standardRatePct)}
      </span>
    </div>
  );
}

/** The reach guarantee. Spec calls this the most important element on the screen. */
function ReachCard({ video }: { video: LiveVideo }) {
  const progress = progressPct(video.budgetDelivered, video.budgetTotal);
  const complete = video.budgetDelivered >= video.budgetTotal;
  const remaining = Math.max(0, video.budgetTotal - video.budgetDelivered);

  return (
    <article className="rounded-card bg-card p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[16px] font-bold leading-snug text-ink">
            {video.title}
          </h3>
          <p className="mt-0.5 text-[13px] text-muted">Posted {sinceLabel(video.postedAt)}</p>
        </div>
        {complete ? (
          <span className="shrink-0 rounded-full bg-lime px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em] text-ink">
            Delivered
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-coral/10 px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em] text-coral-deep">
            Delivering
          </span>
        )}
      </div>

      <div className="mt-5">
        <div className="flex items-baseline justify-between gap-3">
          <p
            data-num
            className="font-display text-[34px] font-extrabold leading-none tracking-[-0.03em] text-ink"
          >
            {count(video.budgetDelivered)}
            <span className="text-muted">/{count(video.budgetTotal)}</span>
          </p>
          <p data-num className="shrink-0 text-[13px] font-bold text-muted">
            {pct(progress)}
          </p>
        </div>

        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={video.budgetTotal}
          aria-valuenow={Math.min(video.budgetDelivered, video.budgetTotal)}
          aria-label={`First-day reach guarantee for ${video.title}`}
          className="mt-3 h-3.5 w-full overflow-hidden rounded-full bg-hairline-strong"
        >
          <div
            className="h-full rounded-full bg-coral transition-[width] duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>

        <p className="mt-2.5 text-[13px] leading-[1.5] text-muted">
          {complete
            ? 'First-day reach guarantee delivered in full. Everything after this was earned.'
            : `First-day reach guarantee. ${count(remaining)} more coming within ${REACH_GUARANTEE_WINDOW_HOURS}h of posting, whether or not anyone follows you.`}
        </p>
      </div>

      <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-hairline pt-4">
        <Stat label="Seen" value={count(video.impressions)} />
        <Stat label="Tapped" value={count(video.taps)} />
        <Stat label="Sold" value={count(video.sold)} />
      </dl>

      <Link
        href={STUDIO_ROUTES.video(video.videoId)}
        className="mt-4 inline-flex min-h-[44px] items-center text-[14px] font-bold text-coral-deep transition-opacity duration-150 hover:opacity-70"
      >
        See the full funnel →
      </Link>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-bold uppercase tracking-[0.07em] text-muted">{label}</dt>
      <dd data-num className="mt-1 text-[19px] font-extrabold leading-none text-ink">
        {value}
      </dd>
    </div>
  );
}

/** The list on its own, so a caller can supply its own heading. */
function TodoItems({ todos }: { todos: Todo[] }) {
  if (todos.length === 0) return null;
  return (
    <ul className="mt-3 grid grid-cols-1 gap-2.5">
      {todos.map((todo) => (
        <li key={todo.kind}>
          <Link
            href={todo.href}
            className="flex min-h-[60px] items-center justify-between gap-3 rounded-card bg-card px-4 py-3.5 shadow-card transition-transform duration-150 active:scale-[0.99]"
          >
            <span className="text-[14px] font-semibold leading-[1.45] text-ink">
              {todo.text}
            </span>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-coral"
              aria-hidden
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function TodoList({ todos }: { todos: Todo[] }) {
  if (todos.length === 0) return null;
  return (
    <section className="mt-7">
      <h2 className="font-display text-[20px] font-extrabold tracking-[-0.02em] text-ink">
        Worth doing next
      </h2>
      <TodoItems todos={todos} />
    </section>
  );
}

/**
 * Principle 4: explain the algorithm honestly. A seller who understands the
 * ranking makes better videos; a seller who thinks it is a black box posts on
 * Reddit about being shadowbanned.
 */
function HowItWorks() {
  return (
    <section className="mt-7 rounded-card border border-hairline p-5">
      <h2 className="font-display text-[17px] font-extrabold tracking-[-0.02em] text-ink">
        How the feed decides
      </h2>
      <p className="mt-2 text-[14px] leading-[1.6] text-muted">
        Every video starts with {count(REACH_GUARANTEE_IMPRESSIONS)} guaranteed impressions over
        its first {REACH_GUARANTEE_WINDOW_HOURS} hours. Nothing you do changes that number, and
        neither does your follower count — it is the same for seller #1 and seller #50.
      </p>
      <p className="mt-2.5 text-[14px] leading-[1.6] text-muted">
        What happens after depends entirely on what those first people did: how many watched past
        the first two seconds, how many opened the product, how many bought. Purchases weigh the
        most, taps next, watch time after that. A video that converts keeps being shown; one that
        does not quietly stops — and the next thing you post starts again at the full{' '}
        {count(REACH_GUARANTEE_IMPRESSIONS)}.
      </p>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE SCREEN
   ═══════════════════════════════════════════════════════════════════════════ */

export default async function StudioPulsePage() {
  const data = await loadPulse();
  // The layout already guards; this is the same answer if it is ever bypassed.
  if (!data) redirect('/auth/login');

  const { seller, pulse, monthIso } = data;
  const firstRun = pulse.liveVideos.length === 0;

  return (
    <div className="mx-auto w-full max-w-[560px] px-5 pt-6 md:max-w-[900px] md:px-10 md:pt-10">
      {seller.founding?.isFounding && <FoundingBadge status={seller.founding} />}
      {firstRun ? (
        <FirstRun todos={pulse.todos} />
      ) : (
        <Active pulse={pulse} monthIso={monthIso} />
      )}
    </div>
  );
}

/**
 * First run. No live videos — which today is every seller, and tomorrow is
 * every new one. Real copy about what the guarantee will give them, an empty
 * bar as a preview of the thing they are about to watch fill, and one CTA.
 * Emphatically not "$0.00" repeated over four empty cards.
 */
function FirstRun({ todos }: { todos: Todo[] }) {
  const setupTodos = todos.filter((t) => t.kind !== 'post_first_video');

  return (
    <>
      <section className="rounded-card bg-card p-6 shadow-card md:p-8">
        <span className="inline-block rounded-full bg-lime px-3 py-1 text-[11px] font-extrabold uppercase tracking-[0.07em] text-ink">
          Nothing live yet
        </span>

        <h1 className="mt-4 max-w-[18ch] font-display text-[32px] font-extrabold leading-[1.03] tracking-[-0.03em] text-ink md:text-[42px]">
          Your first video gets{' '}
          <span className="text-coral">{count(REACH_GUARANTEE_IMPRESSIONS)} people</span>,
          guaranteed.
        </h1>

        <p className="mt-4 max-w-[46ch] text-[15px] leading-[1.6] text-muted">
          Drip does not make you earn your first audience. Every video you post is shown to at
          least {count(REACH_GUARANTEE_IMPRESSIONS)} real shoppers in the feed over its first{' '}
          {REACH_GUARANTEE_WINDOW_HOURS} hours — no followers, no ad spend, no algorithm to
          argue with. You will watch the counter fill on this screen while it happens.
        </p>

        {/* A preview of the bar that becomes the centre of this screen. */}
        <div className="mt-6 rounded-art border border-hairline bg-cream p-4">
          <div className="flex items-baseline justify-between gap-3">
            <p
              data-num
              className="font-display text-[30px] font-extrabold leading-none tracking-[-0.03em] text-ink"
            >
              0<span className="text-muted">/{count(REACH_GUARANTEE_IMPRESSIONS)}</span>
            </p>
            <p className="shrink-0 text-[12px] font-bold uppercase tracking-[0.06em] text-muted">
              Waiting on you
            </p>
          </div>
          <div className="mt-3 h-3.5 w-full overflow-hidden rounded-full bg-hairline-strong" aria-hidden>
            <div className="h-full w-0 rounded-full bg-coral" />
          </div>
          <p className="mt-2.5 text-[13px] text-muted">First-day reach guarantee</p>
        </div>

        <Link
          href={STUDIO_ROUTES.newVideo}
          className="mt-6 flex min-h-[54px] w-full items-center justify-center rounded-full bg-coral px-7 text-[16px] font-bold text-ink shadow-cta transition-transform duration-[350ms] ease-spring active:scale-[0.96]"
        >
          Post your first video
        </Link>

        <p className="mt-3 text-[13px] leading-[1.5] text-muted">
          After it goes up, this screen shows what it earned and the one thing to change next
          time.
        </p>
      </section>

      {setupTodos.length > 0 && (
        <section className="mt-7">
          <h2 className="font-display text-[20px] font-extrabold tracking-[-0.02em] text-ink">
            Before your first sale
          </h2>
          <p className="mt-1.5 text-[14px] text-muted">
            A sale cannot complete until these are done.
          </p>
          <TodoItems todos={setupTodos} />
        </section>
      )}

      <HowItWorks />
    </>
  );
}

/** The seller has something live. Money first, then the guarantee, then actions. */
function Active({ pulse, monthIso }: { pulse: StudioPulse; monthIso: string }) {
  const delta = deltaLabel(pulse.deltaVsLastMonthPct);
  const deltaTone =
    delta.tone === 'up'
      ? 'bg-lime text-ink'
      : delta.tone === 'down'
        ? 'bg-sale/10 text-sale'
        : 'bg-hairline text-muted';

  // Inside the guarantee window the bar is the headline; after it, the video
  // is still listed but the guarantee is history.
  const inWindow = pulse.liveVideos.filter((v) => {
    const h = hoursSince(v.postedAt);
    return h !== null && h < REACH_GUARANTEE_WINDOW_HOURS;
  });
  const guaranteed = inWindow.length > 0 ? inWindow : pulse.liveVideos.slice(0, 1);

  return (
    <>
      {/* ── Money ─────────────────────────────────────────────────────── */}
      <section className="rounded-card bg-card p-5 shadow-card md:p-7">
        <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">
          Earned in {monthLabel(monthIso)}
        </p>

        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <span
            data-num
            className="font-display text-[42px] font-extrabold leading-none tracking-[-0.035em] text-ink md:text-[54px]"
          >
            {money(pulse.earnedCentsThisMonth)}
          </span>
          {pulse.deltaVsLastMonthPct !== null && (
            <span
              data-num
              className={`rounded-full px-2.5 py-1 text-[12px] font-extrabold ${deltaTone}`}
            >
              {delta.text}
            </span>
          )}
        </div>

        <p className="mt-2.5 text-[14px] leading-[1.5] text-muted">
          {pulse.orderCount === 0 ? (
            'No sales yet this month. Your live videos are still being shown.'
          ) : (
            <>
              <span data-num>{count(pulse.orderCount)}</span>{' '}
              {pulse.orderCount === 1 ? 'order' : 'orders'}, after Drip&rsquo;s fee and card
              processing.{' '}
              {pulse.deltaVsLastMonthPct === null && 'First month with sales — nothing to compare to yet.'}
            </>
          )}
        </p>

        <div className="mt-5 flex items-center justify-between gap-4 rounded-art border border-hairline bg-cream px-4 py-3.5">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-muted">
              Pending payout
            </p>
            <p data-num className="mt-1 text-[20px] font-extrabold leading-none text-ink">
              {money(pulse.pendingPayoutCents)}
            </p>
          </div>
          <div className="min-w-0 text-right">
            <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-muted">Lands</p>
            <p className="mt-1 text-[15px] font-bold leading-none text-ink">
              {pulse.nextPayoutDate ? dateLabel(pulse.nextPayoutDate) : 'Not scheduled'}
            </p>
          </div>
        </div>
      </section>

      {/* ── The reach guarantee ───────────────────────────────────────── */}
      <section className="mt-7">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="font-display text-[20px] font-extrabold tracking-[-0.02em] text-ink">
            First-day reach
          </h2>
          <p className="text-[13px] font-semibold text-muted">
            {count(REACH_GUARANTEE_IMPRESSIONS)} impressions, guaranteed
          </p>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3">
          {guaranteed.map((video) => (
            <ReachCard key={video.videoId} video={video} />
          ))}
        </div>
        {pulse.liveVideos.length > guaranteed.length && (
          <Link
            href={STUDIO_ROUTES.videos}
            className="mt-3 inline-flex min-h-[44px] items-center text-[14px] font-bold text-coral-deep transition-opacity duration-150 hover:opacity-70"
          >
            All {count(pulse.liveVideos.length)} live videos →
          </Link>
        )}
      </section>

      <TodoList todos={pulse.todos} />
      <HowItWorks />
    </>
  );
}
