import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import {
  COUNTED_ORDER_STATUSES,
  FRESHNESS_HALF_LIFE_HOURS,
  REACH_GUARANTEE_IMPRESSIONS,
  REACH_GUARANTEE_WINDOW_HOURS,
  STUDIO_ROUTES,
  type FunnelStep,
} from '@/lib/studio/types';
import { count, money, pct, progressPct, ratioLabel, sinceLabel } from '@/lib/studio/format';
import {
  MIN_FUNNEL_IMPRESSIONS,
  MIN_MEDIAN_SAMPLE,
  buildFunnel,
  buildRetentionCurve,
  buildTrafficSources,
  clockLabel,
  median,
  type FunnelCounts,
  type RetentionCurve,
  type StudioVideoFunnel,
  type TrafficSource,
  type TrafficSourceKey,
} from '@/lib/studio/funnel';

/**
 * The per-video report (spec 7.3).
 *
 * Three things, in the order a seller needs them:
 *
 *   1. The funnel, as absolute numbers AND conversion rates, with the
 *      category median beside every rung.
 *   2. The drop-off diagnosis — the single highest-value element in the whole
 *      dashboard. One step, one quantified gap, one cause, one lever. The
 *      maths lives in `@/lib/studio/funnel` and is tested there; this file
 *      only renders it.
 *   3. Where the impressions came from, and where people stopped watching.
 *
 * ZERO ROWS IS THE DEFAULT STATE — the feed tables are not applied in
 * production yet. A video with no impressions shows the reach guarantee in
 * progress, never an empty funnel with five zeroes and a median of nothing.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Video report — Drip Studio',
  description: 'The funnel, the benchmark, and the one thing to change.',
};

/* ═══════════════════════════════════════════════════════════════════════════
   DATA
   ═══════════════════════════════════════════════════════════════════════════ */

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

/** `head: true` count queries return no rows, so they need their own wrapper. */
async function safeCount(
  query: PromiseLike<{ count: number | null; error: unknown }>
): Promise<number | null> {
  try {
    const { count: n, error } = await query;
    return error ? null : (n ?? null);
  } catch {
    return null;
  }
}

/** Row shapes by hand — see the note in the videos list for why. */
type VideoRow = {
  id: string;
  seller_id: string;
  caption: string | null;
  status: string | null;
  thumbnail_url: string | null;
  duration_seconds: number | string | null;
  published_at: string | null;
  created_at: string | null;
  category_id: string | null;
};

type CategoryRow = { id: string; name: string };

type StatRow = {
  video_id: string;
  impressions_all: number | null;
  skips_under_2s_all: number | null;
  product_taps_all: number | null;
  add_to_carts_all: number | null;
  purchases_all: number | null;
  exploration_impressions: number | null;
  shares_all: number | null;
};

type LinkRow = {
  video_id: string;
  product_id: string;
  position: number | null;
  pinned_at_second: number | string | null;
};

type ProductRow = {
  id: string;
  title: string;
  slug: string | null;
  inventory_count: number | null;
  price_cents: number | null;
};

type ShippingRow = { shipping_cents: number | null };

const STAT_COLUMNS =
  'video_id, impressions_all, skips_under_2s_all, product_taps_all, add_to_carts_all, purchases_all, exploration_impressions, shares_all';

function adminOrNull(): ReturnType<typeof createAdminClient> | null {
  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
    return createAdminClient();
  } catch {
    return null;
  }
}

function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `impressions - skips_under_2s`, floored at 0. See the note in funnel.ts. */
function countsFromStats(stats: StatRow | undefined | null): FunnelCounts {
  const impressions = Number(stats?.impressions_all ?? 0);
  const skipped = Number(stats?.skips_under_2s_all ?? 0);
  return {
    impressions,
    stayed: Math.max(0, impressions - skipped),
    taps: Number(stats?.product_taps_all ?? 0),
    addToCarts: Number(stats?.add_to_carts_all ?? 0),
    purchases: Number(stats?.purchases_all ?? 0),
  };
}

/**
 * The watch-progress buckets the client actually emits.
 *
 * `feed-video.tsx` sends `String(25|50|75|95)`; the rollup's completion
 * counter filters on `'q95'` and therefore never matches, which is why this
 * screen reads the events directly rather than trusting
 * `video_stats.completions_all`. Both spellings are accepted so the curve
 * keeps working when that mismatch is reconciled either way.
 */
const BUCKETS: Record<'q25' | 'q50' | 'q75' | 'q95', string[]> = {
  q25: ['25', 'q25'],
  q50: ['50', 'q50'],
  q75: ['75', 'q75'],
  q95: ['95', 'q95'],
};

type Report = {
  video: {
    id: string;
    title: string;
    status: string;
    thumbnailUrl: string | null;
    atIso: string | null;
    isLive: boolean;
    durationSeconds: number | null;
  };
  categoryName: string | null;
  product: { title: string; soldOut: boolean; priceCents: number | null } | null;
  funnel: StudioVideoFunnel;
  budgetDelivered: number;
  budgetTotal: number;
  retention: RetentionCurve;
  sources: TrafficSource[];
  shares: number;
  sharedOpens: number;
  /** Public URL for this video's product, only when one genuinely resolves. */
  shareUrl: string | null;
};

async function loadReport(videoId: string): Promise<Report | null | 'missing'> {
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

  // Ownership is enforced in the predicate, not after the fact: another
  // seller's video id simply does not resolve.
  const [video, categories] = await Promise.all([
    safe<VideoRow>(
      supabase
        .from('videos')
        .select(
          'id, seller_id, caption, status, thumbnail_url, duration_seconds, published_at, created_at, category_id'
        )
        .eq('id', videoId)
        .eq('seller_id', userId)
        .maybeSingle()
    ),
    safe<CategoryRow[]>(supabase.from('categories').select('id, name')),
  ]);

  if (!video) return 'missing';

  const admin = adminOrNull();
  const events = admin ? admin.from('feed_events') : null;

  const eventCount = (
    apply: (
      q: ReturnType<NonNullable<typeof events>['select']>
    ) => PromiseLike<{ count: number | null; error: unknown }>
  ): Promise<number | null> => {
    if (!events) return Promise.resolve(null);
    return safeCount(apply(events.select('*', { count: 'exact', head: true })));
  };

  const [
    links,
    subjectStats,
    peerVideos,
    q25,
    q50,
    q75,
    q95,
    checkoutOpens,
    laneAffinity,
    laneTrending,
    laneFresh,
    laneSocial,
    laneRandom,
    sharedOpens,
    myShipping,
  ] = await Promise.all([
    safe<LinkRow[]>(
      supabase
        .from('video_products')
        .select('video_id, product_id, position, pinned_at_second')
        .eq('video_id', video.id)
        .order('position', { ascending: true })
    ),
    // video_stats grants `authenticated` four public columns only (00009);
    // impressions, skips and the exploration budget are seller-private and
    // readable only by the service role. The id is already scoped to this
    // seller by the query above, so the admin client widens columns, not rows.
    admin
      ? safe<StatRow>(
          admin.from('video_stats').select(STAT_COLUMNS).eq('video_id', video.id).maybeSingle()
        )
      : Promise.resolve(null),
    video.category_id
      ? safe<{ id: string }[]>(
          supabase
            .from('videos')
            .select('id')
            .eq('category_id', video.category_id)
            .eq('status', 'live')
            .neq('id', video.id)
            .limit(400)
        )
      : Promise.resolve(null),
    eventCount((q) => q.eq('video_id', video.id).eq('event_type', 'watch_progress').in('bucket', BUCKETS.q25)),
    eventCount((q) => q.eq('video_id', video.id).eq('event_type', 'watch_progress').in('bucket', BUCKETS.q50)),
    eventCount((q) => q.eq('video_id', video.id).eq('event_type', 'watch_progress').in('bucket', BUCKETS.q75)),
    eventCount((q) => q.eq('video_id', video.id).eq('event_type', 'watch_progress').in('bucket', BUCKETS.q95)),
    eventCount((q) => q.eq('video_id', video.id).eq('event_type', 'checkout_open')),
    eventCount((q) => q.eq('video_id', video.id).eq('event_type', 'impression').eq('lane', 'affinity').neq('surface', 'shared_link')),
    eventCount((q) => q.eq('video_id', video.id).eq('event_type', 'impression').eq('lane', 'trending').neq('surface', 'shared_link')),
    eventCount((q) => q.eq('video_id', video.id).eq('event_type', 'impression').eq('lane', 'fresh').neq('surface', 'shared_link')),
    eventCount((q) => q.eq('video_id', video.id).eq('event_type', 'impression').eq('lane', 'social').neq('surface', 'shared_link')),
    eventCount((q) => q.eq('video_id', video.id).eq('event_type', 'impression').eq('lane', 'random').neq('surface', 'shared_link')),
    eventCount((q) => q.eq('video_id', video.id).eq('event_type', 'impression').eq('surface', 'shared_link')),
    safe<ShippingRow[]>(
      supabase
        .from('orders')
        .select('shipping_cents')
        .eq('video_id', video.id)
        .in('status', [...COUNTED_ORDER_STATUSES])
        .limit(200)
    ),
  ]);

  const peerIds = (peerVideos ?? []).map((v) => v.id);
  const productIds = [...new Set((links ?? []).map((l) => l.product_id))];

  const [products, peerStats, categoryShipping, publicDrop] = await Promise.all([
    productIds.length > 0
      ? safe<ProductRow[]>(
          supabase
            .from('products')
            .select('id, title, slug, inventory_count, price_cents')
            .in('id', productIds)
        )
      : Promise.resolve(null),
    peerIds.length > 0 && admin
      ? safe<StatRow[]>(admin.from('video_stats').select(STAT_COLUMNS).in('video_id', peerIds))
      : Promise.resolve(null),
    // Cross-seller, and deliberately so: a benchmark is only a benchmark if it
    // is drawn from other people's videos. Nothing per-order is ever rendered
    // — only the median leaves this function.
    peerIds.length > 0 && admin
      ? safe<ShippingRow[]>(
          admin
            .from('orders')
            .select('shipping_cents')
            .in('video_id', peerIds)
            .in('status', [...COUNTED_ORDER_STATUSES])
            .limit(500)
        )
      : Promise.resolve(null),
    // The share link is only offered when a public page genuinely resolves.
    // `/@handle/[slug]` reads the legacy `drops` table, so a product with no
    // matching drop row has no public URL yet and gets an honest note instead.
    safe<{ slug: string }[]>(
      supabase.from('drops').select('slug').eq('seller_id', userId).eq('status', 'active')
    ),
  ]);

  const productsById = new Map((products ?? []).map((p) => [p.id, p]));
  const firstLink = (links ?? [])[0] ?? null;
  const firstProduct = firstLink ? (productsById.get(firstLink.product_id) ?? null) : null;
  const anySoldOut = (links ?? []).some(
    (l) => (productsById.get(l.product_id)?.inventory_count ?? 0) <= 0
  );

  const counts = countsFromStats(subjectStats);
  const peerCounts = (peerStats ?? []).map((s) => countsFromStats(s));

  const durationSeconds = num(video.duration_seconds);
  const retention = buildRetentionCurve(
    counts.impressions,
    { q25: q25 ?? 0, q50: q50 ?? 0, q75: q75 ?? 0, q95: q95 ?? 0 },
    durationSeconds
  );

  const shippingMine = median(
    (myShipping ?? []).map((r) => Number(r.shipping_cents ?? 0)).filter((v) => v > 0)
  );
  const shippingCategory = median(
    (categoryShipping ?? []).map((r) => Number(r.shipping_cents ?? 0)).filter((v) => v > 0)
  );

  const funnel = buildFunnel({
    videoId: video.id,
    counts,
    peers: peerCounts,
    evidence: {
      checkoutOpens,
      productSoldOut: anySoldOut,
      pinnedAtSecond: firstLink ? num(firstLink.pinned_at_second) : null,
      medianDropOffPct: retention.medianDropOffPct,
      durationSeconds,
      shippingChargedCents: shippingMine,
      categoryShippingCents: shippingCategory,
    },
  });

  const bySource: Partial<Record<TrafficSourceKey, number>> = {
    affinity: laneAffinity ?? 0,
    trending: laneTrending ?? 0,
    fresh: laneFresh ?? 0,
    social: laneSocial ?? 0,
    random: laneRandom ?? 0,
    shared: sharedOpens ?? 0,
  };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const handle = await safe<{ handle: string | null }>(
    supabase.from('profiles').select('handle').eq('id', userId).maybeSingle()
  );
  const publicSlugs = new Set((publicDrop ?? []).map((d) => d.slug));
  const shareUrl =
    appUrl && handle?.handle && firstProduct?.slug && publicSlugs.has(firstProduct.slug)
      ? `${appUrl}/@${handle.handle}/${firstProduct.slug}`
      : null;

  return {
    video: {
      id: video.id,
      title: video.caption?.trim() || firstProduct?.title || 'Untitled video',
      status: video.status ?? 'processing',
      thumbnailUrl: video.thumbnail_url,
      atIso: video.published_at ?? video.created_at,
      isLive: video.status === 'live',
      durationSeconds,
    },
    categoryName:
      (categories ?? []).find((c) => c.id === video.category_id)?.name ?? null,
    product: firstProduct
      ? {
          title: firstProduct.title,
          soldOut: (firstProduct.inventory_count ?? 0) <= 0,
          priceCents: firstProduct.price_cents,
        }
      : null,
    funnel,
    budgetDelivered: Number(subjectStats?.exploration_impressions ?? 0),
    budgetTotal: REACH_GUARANTEE_IMPRESSIONS,
    retention,
    sources: buildTrafficSources(bySource),
    shares: Number(subjectStats?.shares_all ?? 0),
    sharedOpens: sharedOpens ?? 0,
    shareUrl,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE COPY BUTTON

   The shell already establishes this pattern: the nav's active state is set
   by an inline script because `layout.tsx` must stay an async server
   component. Same constraint here — this page is a server component and owns
   no client file — so the copy button is progressive enhancement over a URL
   that is always rendered as selectable text. Without JS the seller selects
   and copies it themselves; nothing is hidden behind the button.
   ═══════════════════════════════════════════════════════════════════════════ */

const COPY_SCRIPT = `(function(){
document.addEventListener("click",function(ev){
var t=ev.target;if(!t||!t.closest)return;var b=t.closest("[data-copy]");if(!b)return;
var v=b.getAttribute("data-copy");if(!v)return;
var l=b.querySelector("[data-copy-label]")||b;var o=l.textContent;
var ok=function(){l.textContent="Copied";setTimeout(function(){l.textContent=o;},1800);};
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(v).then(ok,function(){});return;}
var a=document.createElement("textarea");a.value=v;a.setAttribute("readonly","");
a.style.position="fixed";a.style.top="-1000px";document.body.appendChild(a);a.select();
try{document.execCommand("copy");ok();}catch(e){}document.body.removeChild(a);
},false);
})();`;

/* ═══════════════════════════════════════════════════════════════════════════
   PIECES
   ═══════════════════════════════════════════════════════════════════════════ */

function RatioChip({ ratio }: { ratio: number | null }) {
  if (ratio === null) return null;
  const tone =
    ratio >= 1
      ? 'bg-lime text-ink'
      : ratio < 0.85
        ? 'bg-sale/10 text-sale'
        : 'bg-hairline text-muted';
  const arrow = ratio >= 1 ? '▲' : '▼';
  return (
    <span
      data-num
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-extrabold ${tone}`}
    >
      {arrow} {ratioLabel(ratio)}
    </span>
  );
}

/** Percentages under 10 keep a decimal; "0%" would erase the difference
 *  between a 0.4% and a 0.04% conversion, which is the whole last rung. */
function ratePct(value: number | null): string {
  if (value === null) return '';
  return pct(value, value < 10 ? 1 : 0);
}

function FunnelRow({
  step,
  widthPct,
  medianCount,
  reachRatio,
}: {
  step: FunnelStep;
  widthPct: number;
  medianCount?: number | null;
  reachRatio?: number | null;
}) {
  const isFirst = step.key === 'impressions';
  const ratio = isFirst ? (reachRatio ?? null) : step.ratio;

  return (
    <li className="border-t border-hairline pt-3.5 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[14px] font-bold text-ink">{step.label}</p>
        <div className="flex shrink-0 items-baseline gap-2">
          <span data-num className="text-[19px] font-extrabold leading-none text-ink">
            {count(step.count)}
          </span>
          {step.ratePct !== null && (
            <span data-num className="text-[13px] font-bold text-muted">
              {ratePct(step.ratePct)}
            </span>
          )}
        </div>
      </div>

      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-hairline" aria-hidden>
        <div className="h-full rounded-full bg-coral/70" style={{ width: `${widthPct}%` }} />
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-3">
        <p data-num className="text-[12px] font-medium text-muted">
          {isFirst
            ? medianCount === null || medianCount === undefined
              ? 'No category median yet'
              : `Category median ${count(medianCount)}`
            : step.medianRatePct === null
              ? 'No category median yet'
              : `Category median ${ratePct(step.medianRatePct)}`}
        </p>
        <RatioChip ratio={ratio} />
      </div>
    </li>
  );
}

/** The reach guarantee, for a video with nothing to read yet. */
function GuaranteeCard({
  delivered,
  total,
  title,
}: {
  delivered: number;
  total: number;
  title: string;
}) {
  const progress = progressPct(delivered, total);
  const remaining = Math.max(0, total - delivered);

  return (
    <section className="rounded-card bg-card p-5 shadow-card md:p-7">
      <span className="inline-block rounded-full bg-coral/10 px-3 py-1 text-[11px] font-extrabold uppercase tracking-[0.07em] text-coral-deep">
        Delivering
      </span>

      <h2 className="mt-4 font-display text-[24px] font-extrabold leading-[1.1] tracking-[-0.025em] text-ink">
        Nothing to read yet — the guarantee is still running.
      </h2>

      <div className="mt-5 flex items-baseline justify-between gap-3">
        <p
          data-num
          className="font-display text-[34px] font-extrabold leading-none tracking-[-0.03em] text-ink"
        >
          {count(delivered)}
          <span className="text-muted">/{count(total)}</span>
        </p>
        <p data-num className="shrink-0 text-[13px] font-bold text-muted">
          {pct(progress)}
        </p>
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.min(delivered, total)}
        aria-label={`First-day reach guarantee for ${title}`}
        className="mt-3 h-3.5 w-full overflow-hidden rounded-full bg-hairline-strong"
      >
        <div
          className="h-full rounded-full bg-coral transition-[width] duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      <p className="mt-3 text-[14px] leading-[1.55] text-muted">
        {count(remaining)} more impressions are coming within {REACH_GUARANTEE_WINDOW_HOURS} hours
        of posting, whether or not anyone follows you. The funnel below fills in as they land —
        it needs about {count(MIN_FUNNEL_IMPRESSIONS)} before a comparison against your category
        means anything.
      </p>
    </section>
  );
}

/**
 * The drop-off diagnosis. The highest-value element on the surface, so it
 * gets the loudest card: the gap, then one cause, then one lever in coral.
 */
function Diagnosis({ funnel }: { funnel: StudioVideoFunnel }) {
  const { assessment } = funnel;

  if (assessment.kind === 'drop_off') {
    const { diagnosis } = assessment;
    return (
      <section className="mt-7 rounded-card bg-card p-5 shadow-float md:p-7">
        <h2 className="font-display text-[21px] font-extrabold leading-tight tracking-[-0.025em] text-ink">
          Where you&rsquo;re losing people
        </h2>

        <p className="mt-3 text-[15px] leading-[1.6] text-ink">{diagnosis.gapDescription}</p>

        <div className="mt-5 rounded-art border border-hairline bg-cream p-4">
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-muted">
            Most likely why
          </p>
          <p className="mt-1.5 text-[14px] leading-[1.6] text-ink">{diagnosis.oneCause}</p>
        </div>

        <div className="mt-3 rounded-art bg-coral/10 p-4">
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-coral-deep">
            The one thing to change
          </p>
          <p className="mt-1.5 text-[15px] font-semibold leading-[1.55] text-ink">
            {diagnosis.oneLever}
          </p>
        </div>

        <p className="mt-4 text-[12px] leading-[1.5] text-muted">
          One change at a time, on purpose. Change two and the next video cannot tell you which
          one worked.
        </p>
      </section>
    );
  }

  if (assessment.kind === 'healthy') {
    return (
      <section className="mt-7 rounded-card bg-card p-5 shadow-float md:p-7">
        <h2 className="font-display text-[21px] font-extrabold leading-tight tracking-[-0.025em] text-ink">
          {assessment.headline}
        </h2>
        <p className="mt-3 text-[15px] leading-[1.6] text-muted">{assessment.detail}</p>
        <Link
          href={STUDIO_ROUTES.newVideo}
          className="mt-5 flex min-h-[50px] w-full items-center justify-center rounded-full bg-coral px-7 text-[15px] font-bold text-ink shadow-cta transition-transform duration-[350ms] ease-spring active:scale-[0.96] md:w-auto md:px-8"
        >
          Post another
        </Link>
      </section>
    );
  }

  if (assessment.kind === 'too_early') {
    return (
      <section className="mt-7 rounded-card border border-hairline p-5">
        <h2 className="font-display text-[19px] font-extrabold tracking-[-0.02em] text-ink">
          Too early to tell you anything useful
        </h2>
        <p className="mt-2 text-[14px] leading-[1.6] text-muted">
          {count(assessment.impressions)} impressions so far. A comparison against your category
          needs about {count(assessment.needed)} before it is describing your video rather than
          describing a handful of people. This page fills itself in.
        </p>
      </section>
    );
  }

  if (assessment.kind === 'no_benchmark') {
    return (
      <section className="mt-7 rounded-card border border-hairline p-5">
        <h2 className="font-display text-[19px] font-extrabold tracking-[-0.02em] text-ink">
          No category median yet
        </h2>
        <p className="mt-2 text-[14px] leading-[1.6] text-muted">
          A median needs at least {MIN_MEDIAN_SAMPLE} other live videos in the same category.
          Until there are, the numbers above are shown without a benchmark — an invented
          comparison would be worse than none, because you would act on it.
        </p>
      </section>
    );
  }

  return null;
}

/**
 * Retention. Inline SVG, no chart library.
 *
 * The buckets re-arm on every loop, so these are plays reaching a point, not
 * distinct people — said plainly under the graph rather than quietly folded
 * into a headcount. The curve is `aria-hidden`; the five points are also
 * rendered as text, which is both the accessible version and the honest one.
 */
function Retention({
  curve,
  durationSeconds,
}: {
  curve: RetentionCurve;
  durationSeconds: number | null;
}) {
  if (!curve.hasData) return null;

  const x = (atPct: number) => (atPct / 95) * 100;
  const y = (sharePct: number) => 2 + (1 - Math.max(0, Math.min(100, sharePct)) / 100) * 40;

  const line = curve.points.map((p) => `${x(p.atPct).toFixed(2)},${y(p.sharePct).toFixed(2)}`);
  const linePath = `M ${line.join(' L ')}`;
  const areaPath = `${linePath} L 100,44 L 0,44 Z`;
  const markerX = curve.medianDropOffPct === null ? null : x(curve.medianDropOffPct);

  return (
    <section className="mt-7">
      <h2 className="font-display text-[20px] font-extrabold tracking-[-0.02em] text-ink">
        Where people stop watching
      </h2>

      <div className="mt-3 rounded-card bg-card p-4 shadow-card md:p-5">
        <div className="relative">
          <svg
            viewBox="0 0 100 44"
            preserveAspectRatio="none"
            className="block h-[132px] w-full"
            aria-hidden
          >
            <path d={areaPath} fill="var(--color-coral)" fillOpacity="0.12" />
            <path
              d={linePath}
              fill="none"
              stroke="var(--color-coral)"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {markerX !== null && (
              <line
                x1={markerX}
                y1="0"
                x2={markerX}
                y2="44"
                stroke="var(--color-ink)"
                strokeWidth="1"
                strokeDasharray="3 3"
                strokeOpacity="0.45"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {markerX !== null && (
            <span
              data-num
              className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-full bg-ink px-2 py-0.5 text-[10px] font-extrabold text-cream"
              style={{ left: `${Math.max(12, Math.min(88, markerX))}%` }}
            >
              half gone
            </span>
          )}
        </div>

        <ul className="mt-3 grid grid-cols-5 gap-1 border-t border-hairline pt-3">
          {curve.points.map((point) => (
            <li key={point.atPct} className="min-w-0 text-center">
              <p data-num className="text-[11px] font-bold text-muted">
                {point.atSeconds === null ? `${point.atPct}%` : clockLabel(point.atSeconds)}
              </p>
              <p data-num className="mt-0.5 text-[13px] font-extrabold leading-none text-ink">
                {pct(point.sharePct)}
              </p>
            </li>
          ))}
        </ul>

        <p className="mt-3.5 text-[13px] leading-[1.55] text-muted">
          {curve.mostFinish
            ? 'More than half of the plays reach the end — that is unusual, and it is the strongest signal the ranker reads after purchases.'
            : curve.medianDropOffPct === null
              ? 'Not enough watch data yet to say where the drop-off sits.'
              : durationSeconds !== null
                ? `Most people leave at ${clockLabel(curve.medianDropOffSeconds)} — half of all plays were over by then.`
                : `Half of all plays were over by ${pct(curve.medianDropOffPct)} of the way through.`}
        </p>

        <p className="mt-2 text-[12px] leading-[1.5] text-muted">
          Counted per play, replays included — so this is the share of plays still watching, not
          a headcount of people. There is no category retention benchmark yet, so nothing here is
          compared against one.
        </p>
      </div>
    </section>
  );
}

function Sources({
  sources,
  shares,
  sharedOpens,
  shareUrl,
}: {
  sources: TrafficSource[];
  shares: number;
  sharedOpens: number;
  shareUrl: string | null;
}) {
  return (
    <section className="mt-7">
      <h2 className="font-display text-[20px] font-extrabold tracking-[-0.02em] text-ink">
        Where the views came from
      </h2>

      {sources.length === 0 ? (
        <p className="mt-2 text-[14px] leading-[1.6] text-muted">
          Nothing served yet. Once the feed starts showing this video, every impression is
          attributed to the reason it was shown — and you get to see which of those you can grow.
        </p>
      ) : (
        <ul className="mt-3 grid grid-cols-1 gap-2.5">
          {sources.map((source) => (
            <li key={source.key} className="rounded-card bg-card p-4 shadow-card">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[14px] font-bold text-ink">{source.label}</p>
                <p data-num className="shrink-0 text-[15px] font-extrabold leading-none text-ink">
                  {count(source.impressions)}
                  <span className="ml-1.5 text-[12px] font-bold text-muted">
                    {pct(source.sharePct)}
                  </span>
                </p>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-hairline" aria-hidden>
                <div
                  className="h-full rounded-full bg-violet/60"
                  style={{ width: `${Math.min(100, source.sharePct)}%` }}
                />
              </div>
              <p className="mt-2 text-[12px] leading-[1.5] text-muted">{source.explanation}</p>
            </li>
          ))}
        </ul>
      )}

      {/* The distribution loop. Everything else on this list is the feed's
          decision; this is the one lane the seller controls outright. */}
      <div className="mt-3 rounded-card bg-card p-5 shadow-card">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-[15px] font-extrabold text-ink">Shared links</h3>
          <p data-num className="text-[13px] font-bold text-muted">
            {count(shares)} shares · {count(sharedOpens)} opens
          </p>
        </div>

        <p className="mt-2 text-[13px] leading-[1.55] text-muted">
          Every link you send lands on a page that plays the video and sells the product, and the
          views it brings are not rationed by the feed. This is the only lane you can grow
          yourself.
        </p>

        {shareUrl ? (
          <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-art border border-hairline bg-cream px-3.5 py-3 text-[13px] font-semibold text-ink">
              {shareUrl}
            </code>
            <button
              type="button"
              data-copy={shareUrl}
              className="flex min-h-[44px] shrink-0 items-center justify-center rounded-full bg-coral px-5 text-[14px] font-bold text-ink shadow-cta transition-transform duration-150 active:scale-[0.96]"
            >
              <span data-copy-label>Copy link</span>
            </button>
          </div>
        ) : (
          <p className="mt-4 rounded-art border border-hairline bg-cream px-3.5 py-3 text-[13px] leading-[1.5] text-muted">
            This video does not have a public page yet, so there is no link to copy. Shared-link
            views are still counted above.
          </p>
        )}
      </div>
    </section>
  );
}

/** Principle 4: explain the ranking honestly, in terms of this video. */
function HowThisRanks({ categoryName }: { categoryName: string | null }) {
  return (
    <section className="mt-7 rounded-card border border-hairline p-5">
      <h2 className="font-display text-[17px] font-extrabold tracking-[-0.02em] text-ink">
        How this video is ranked
      </h2>
      <p className="mt-2 text-[14px] leading-[1.6] text-muted">
        It started with {count(REACH_GUARANTEE_IMPRESSIONS)} guaranteed impressions over its first{' '}
        {REACH_GUARANTEE_WINDOW_HOURS} hours. What those people did decides everything after:
        purchases weigh the most, then taps, then watch time. Two seconds is the hinge — past a
        60% two-second skip rate the feed stops promoting a video, which is why the second row of
        the funnel is the one worth staring at.
      </p>
      <p className="mt-2.5 text-[14px] leading-[1.6] text-muted">
        Ranking freshness halves every {FRESHNESS_HALF_LIFE_HOURS} hours, so a video that did
        well two weeks ago is not competing with a video posted today. The medians on this page
        are the middle of{' '}
        {categoryName ? `every live video in ${categoryName}` : 'every live video in this category'}
        , not an average — one runaway hit cannot move them.
      </p>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE SCREEN
   ═══════════════════════════════════════════════════════════════════════════ */

export default async function StudioVideoReportPage({
  params,
}: {
  params: Promise<{ videoId: string }>;
}) {
  const { videoId } = await params;
  const report = await loadReport(videoId);

  if (report === null) redirect('/auth/login');
  if (report === 'missing') notFound();

  const { video, funnel, retention, sources } = report;
  const impressions = funnel.steps[0]?.count ?? 0;

  return (
    <div className="mx-auto w-full max-w-[560px] px-5 pt-6 md:max-w-[900px] md:px-10 md:pt-10">
      <Link
        href={STUDIO_ROUTES.videos}
        className="inline-flex min-h-[44px] items-center text-[14px] font-bold text-muted transition-colors duration-150 hover:text-coral-deep"
      >
        ← All videos
      </Link>

      {/* ── Header ───────────────────────────────────────────────────── */}
      <header className="mt-1 flex gap-4">
        {video.thumbnailUrl ? (
          <img
            src={video.thumbnailUrl}
            alt=""
            width={72}
            height={96}
            className="h-24 w-[72px] shrink-0 rounded-art bg-cream object-cover"
          />
        ) : null}

        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[26px] font-extrabold leading-[1.1] tracking-[-0.03em] text-ink md:text-[32px]">
            {video.title}
          </h1>
          <p className="mt-1.5 text-[13px] font-medium text-muted">
            {video.isLive ? `Posted ${sinceLabel(video.atIso)}` : `Uploaded ${sinceLabel(video.atIso)}`}
            {report.categoryName ? ` · ${report.categoryName}` : ''}
            {video.durationSeconds !== null ? ` · ${clockLabel(video.durationSeconds)}` : ''}
          </p>
          {report.product && (
            <p className="mt-1 text-[13px] font-semibold text-ink">
              {report.product.title}
              {report.product.priceCents !== null && (
                <span data-num className="ml-1.5 text-muted">
                  {money(report.product.priceCents)}
                </span>
              )}
              {report.product.soldOut && (
                <span className="ml-2 rounded-full bg-sale/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.05em] text-sale">
                  Sold out
                </span>
              )}
            </p>
          )}
        </div>
      </header>

      {/* ── The funnel, or the guarantee when there is nothing to read ── */}
      {impressions === 0 ? (
        <div className="mt-6">
          <GuaranteeCard
            delivered={report.budgetDelivered}
            total={report.budgetTotal}
            title={video.title}
          />
        </div>
      ) : (
        <section className="mt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 className="font-display text-[20px] font-extrabold tracking-[-0.02em] text-ink">
              The funnel
            </h2>
            <p className="text-[12px] font-semibold text-muted">
              {funnel.medians.sampleSize > 0
                ? `vs ${count(funnel.medians.sampleSize)} other live ${funnel.medians.sampleSize === 1 ? 'video' : 'videos'}${report.categoryName ? ` in ${report.categoryName}` : ''}`
                : 'No category to compare against yet'}
            </p>
          </div>

          <ol className="mt-3 grid grid-cols-1 gap-3.5 rounded-card bg-card p-5 shadow-card md:p-6">
            {funnel.steps.map((step) => (
              <FunnelRow
                key={step.key}
                step={step}
                widthPct={progressPct(step.count, impressions)}
                medianCount={funnel.reach.medianImpressions}
                reachRatio={funnel.reach.ratio}
              />
            ))}
          </ol>

          <p className="mt-2.5 text-[12px] leading-[1.5] text-muted">
            Each percentage is conversion from the row above it, not from impressions. &ldquo;
            {funnel.steps[1]?.label}&rdquo; counts everyone who did not swipe away inside the
            first two seconds.
          </p>
        </section>
      )}

      <Diagnosis funnel={funnel} />

      <Retention curve={retention} durationSeconds={video.durationSeconds} />

      <Sources
        sources={sources}
        shares={report.shares}
        sharedOpens={report.sharedOpens}
        shareUrl={report.shareUrl}
      />

      <HowThisRanks categoryName={report.categoryName} />

      <div className="mt-7 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <Link
          href={STUDIO_ROUTES.newVideo}
          className="flex min-h-[50px] items-center justify-center rounded-full bg-coral px-6 text-[15px] font-bold text-ink shadow-cta transition-transform duration-[350ms] ease-spring active:scale-[0.96]"
        >
          Post another video
        </Link>
        <Link
          href={STUDIO_ROUTES.feed}
          className="flex min-h-[50px] items-center justify-center rounded-full border border-hairline-strong px-6 text-[15px] font-bold text-ink transition-colors duration-150 hover:bg-card"
        >
          Open the feed
        </Link>
      </div>

      <script dangerouslySetInnerHTML={{ __html: COPY_SCRIPT }} />
    </div>
  );
}
