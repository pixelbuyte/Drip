import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import {
  REACH_GUARANTEE_IMPRESSIONS,
  REACH_GUARANTEE_WINDOW_HOURS,
  STUDIO_ROUTES,
} from '@/lib/studio/types';
import { count, hoursSince, progressPct, sinceLabel } from '@/lib/studio/format';

/**
 * Studio → Videos (spec 7.3, the list).
 *
 * The library, and a triage screen: which of my videos should I open. Every
 * row therefore carries one signal that implies an action — the guarantee
 * still delivering (wait), the guarantee finished (go read the funnel), a
 * product sold out (restock), a video not live yet (nothing to do). A row of
 * three counts with no verdict would be decoration, and 7.2's first principle
 * says cut it.
 *
 * ZERO ROWS IS THE DEFAULT. The feed tables in 00007-00011 are not applied in
 * production, so today every query here returns nothing — which is also
 * exactly what a new seller sees. The empty state is the main state.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Videos — Drip Studio',
  description: 'Every video you have posted, and what each one did.',
};

/* ═══════════════════════════════════════════════════════════════════════════
   DATA
   ═══════════════════════════════════════════════════════════════════════════ */

/** Await a query and flatten every failure — missing table, revoked grant,
 *  network blip — to `null`. This screen treats all three as "no data". */
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
 * Row shapes by hand: there is no generated `Database` type, so an untyped
 * `from()` infers `never`. Writing them out also turns a column renamed
 * during the schema reconciliation into a compile error rather than an
 * `undefined` at runtime.
 */
type VideoRow = {
  id: string;
  caption: string | null;
  status: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  created_at: string | null;
};

type StatRow = {
  video_id: string;
  impressions_all: number | null;
  product_taps_all: number | null;
  purchases_all: number | null;
  exploration_impressions: number | null;
};

type LinkRow = { video_id: string; product_id: string; position: number | null };
type ProductRow = { id: string; title: string; inventory_count: number | null };

function adminOrNull(): ReturnType<typeof createAdminClient> | null {
  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
    return createAdminClient();
  } catch {
    return null;
  }
}

type VideoCard = {
  videoId: string;
  title: string;
  status: string;
  thumbnailUrl: string | null;
  /** `published_at` when live, otherwise `created_at`. Never null. */
  atIso: string | null;
  isLive: boolean;
  impressions: number;
  taps: number;
  sold: number;
  budgetDelivered: number;
  budgetTotal: number;
  soldOut: boolean;
};

async function loadVideos(): Promise<VideoCard[] | null> {
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

  // Every status, not just live. A seller whose video is stuck in
  // `processing`, or was paused, needs to see it here rather than conclude it
  // vanished — and `removed` is the one row they most need an answer about.
  const videoRows =
    (await safe<VideoRow[]>(
      supabase
        .from('videos')
        .select('id, caption, status, thumbnail_url, published_at, created_at')
        .eq('seller_id', userId)
        .order('published_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(60)
    )) ?? [];

  if (videoRows.length === 0) return [];

  const videoIds = videoRows.map((v) => v.id);

  // 00009 grants `authenticated` only video_id/likes_all/purchases_7d/
  // purchases_all on video_stats. Impressions and the exploration budget are
  // seller-private and readable only by the service role. Safe here because
  // videoIds came from a query already filtered to this seller — the admin
  // client never widens the row set, it only widens the columns.
  const admin = adminOrNull();

  const [statRows, links] = await Promise.all([
    admin
      ? safe<StatRow[]>(
          admin
            .from('video_stats')
            .select(
              'video_id, impressions_all, product_taps_all, purchases_all, exploration_impressions'
            )
            .in('video_id', videoIds)
        )
      : Promise.resolve(null),
    safe<LinkRow[]>(
      supabase
        .from('video_products')
        .select('video_id, product_id, position')
        .in('video_id', videoIds)
        .order('position', { ascending: true })
    ),
  ]);

  const statsById = new Map((statRows ?? []).map((s) => [s.video_id, s]));

  const productIds = [...new Set((links ?? []).map((l) => l.product_id))];
  const productRows =
    productIds.length > 0
      ? ((await safe<ProductRow[]>(
          supabase.from('products').select('id, title, inventory_count').in('id', productIds)
        )) ?? [])
      : [];

  const productsById = new Map(productRows.map((p) => [p.id, p]));

  const firstProduct = new Map<string, ProductRow>();
  const soldOut = new Set<string>();
  for (const link of links ?? []) {
    const product = productsById.get(link.product_id);
    if (!product) continue;
    if (!firstProduct.has(link.video_id)) firstProduct.set(link.video_id, product);
    if ((product.inventory_count ?? 0) <= 0) soldOut.add(link.video_id);
  }

  return videoRows.map((video) => {
    const stats = statsById.get(video.id);
    const status = video.status ?? 'processing';
    return {
      videoId: video.id,
      title: video.caption?.trim() || firstProduct.get(video.id)?.title || 'Untitled video',
      status,
      thumbnailUrl: video.thumbnail_url,
      atIso: video.published_at ?? video.created_at,
      isLive: status === 'live',
      impressions: Number(stats?.impressions_all ?? 0),
      taps: Number(stats?.product_taps_all ?? 0),
      sold: Number(stats?.purchases_all ?? 0),
      // Same fallback the pulse page uses, for the same reason:
      // exploration_impressions only counts lane='fresh' impressions, and
      // with ranking dark (100% of traffic on the chrono feed) it can never
      // move — a raw read renders "0/500 delivering" directly beside a
      // climbing Seen count. Real impressions ARE the delivery until the
      // ranked path serves traffic; take whichever counter is further along.
      budgetDelivered: Math.max(
        Number(stats?.exploration_impressions ?? 0),
        Math.min(Number(stats?.impressions_all ?? 0), REACH_GUARANTEE_IMPRESSIONS)
      ),
      budgetTotal: REACH_GUARANTEE_IMPRESSIONS,
      soldOut: soldOut.has(video.id),
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE ONE SIGNAL PER ROW
   ═══════════════════════════════════════════════════════════════════════════ */

type Signal = { text: string; tone: 'coral' | 'lime' | 'sale' | 'muted' | 'cobalt' };

/**
 * One verdict per video, hardest-hitting first. This is the whole reason the
 * list exists: it answers "which of these should I open" without making the
 * seller compare five columns of numbers themselves.
 */
function signalFor(video: VideoCard): Signal {
  if (video.status === 'removed') return { text: 'Removed', tone: 'sale' };
  if (video.status === 'processing') return { text: 'Still processing', tone: 'muted' };
  if (video.status === 'paused') return { text: 'Paused', tone: 'muted' };
  if (video.soldOut) return { text: 'Sold out — restock', tone: 'sale' };

  const hours = hoursSince(video.atIso);
  const delivering =
    video.budgetDelivered < video.budgetTotal &&
    hours !== null &&
    hours < REACH_GUARANTEE_WINDOW_HOURS;

  if (delivering) {
    return {
      text: `${count(video.budgetDelivered)}/${count(video.budgetTotal)} delivering`,
      tone: 'coral',
    };
  }
  if (video.budgetDelivered >= video.budgetTotal && video.sold === 0) {
    return { text: 'Read the funnel', tone: 'cobalt' };
  }
  if (video.sold > 0) {
    return { text: `${count(video.sold)} sold`, tone: 'lime' };
  }
  return { text: 'Read the funnel', tone: 'cobalt' };
}

const SIGNAL_CLASS: Record<Signal['tone'], string> = {
  coral: 'bg-coral/10 text-coral-deep',
  lime: 'bg-lime text-ink',
  sale: 'bg-sale/10 text-sale',
  cobalt: 'bg-cobalt/10 text-cobalt',
  muted: 'bg-hairline text-muted',
};

/* ═══════════════════════════════════════════════════════════════════════════
   PIECES
   ═══════════════════════════════════════════════════════════════════════════ */

function Thumb({ video }: { video: VideoCard }) {
  if (video.thumbnailUrl) {
    return (
      <img
        src={video.thumbnailUrl}
        alt=""
        width={64}
        height={86}
        loading="lazy"
        className="h-[86px] w-16 shrink-0 rounded-art bg-cream object-cover"
      />
    );
  }
  return (
    <div
      aria-hidden
      className="flex h-[86px] w-16 shrink-0 items-center justify-center rounded-art border border-hairline bg-cream"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-muted"
      >
        <rect x="3.2" y="4.6" width="17.6" height="14.8" rx="3.4" />
        <path d="M10.4 9.6 15 12l-4.6 2.4Z" />
      </svg>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-[0.07em] text-muted">{label}</dt>
      <dd data-num className="mt-0.5 text-[16px] font-extrabold leading-none text-ink">
        {value}
      </dd>
    </div>
  );
}

function VideoRowCard({ video }: { video: VideoCard }) {
  const signal = signalFor(video);
  const progress = progressPct(video.budgetDelivered, video.budgetTotal);
  // Gated on the 48h window like signalFor's "delivering" verdict already
  // is: without the gate, every live video short of 500 impressions carried
  // a first-day-reach bar FOREVER — a permanently unfinished promise on
  // videos whose first day ended weeks ago.
  const barHours = hoursSince(video.atIso);
  const showBar =
    video.isLive &&
    video.budgetDelivered < video.budgetTotal &&
    barHours !== null &&
    barHours < REACH_GUARANTEE_WINDOW_HOURS;

  return (
    <li>
      <Link
        href={STUDIO_ROUTES.video(video.videoId)}
        className="flex min-h-[44px] gap-3.5 rounded-card bg-card p-3.5 shadow-card transition-transform duration-150 active:scale-[0.99]"
      >
        <Thumb video={video} />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="line-clamp-2 text-[15px] font-bold leading-snug text-ink">
              {video.title}
            </h3>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.05em] ${SIGNAL_CLASS[signal.tone]}`}
            >
              {signal.text}
            </span>
          </div>

          <p className="mt-1 text-[12px] font-medium text-muted">
            {video.isLive ? `Posted ${sinceLabel(video.atIso)}` : `Uploaded ${sinceLabel(video.atIso)}`}
          </p>

          {showBar && (
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={video.budgetTotal}
              aria-valuenow={Math.min(video.budgetDelivered, video.budgetTotal)}
              aria-label={`First-day reach guarantee for ${video.title}`}
              className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-hairline-strong"
            >
              <div className="h-full rounded-full bg-coral" style={{ width: `${progress}%` }} />
            </div>
          )}

          <dl className="mt-3 grid grid-cols-3 gap-2">
            <MiniStat label="Seen" value={count(video.impressions)} />
            <MiniStat label="Tapped" value={count(video.taps)} />
            <MiniStat label="Sold" value={count(video.sold)} />
          </dl>
        </div>
      </Link>
    </li>
  );
}

function Empty() {
  return (
    <section className="rounded-card bg-card p-6 shadow-card md:p-8">
      <span className="inline-block rounded-full bg-lime px-3 py-1 text-[11px] font-extrabold uppercase tracking-[0.07em] text-ink">
        Nothing here yet
      </span>

      <h1 className="mt-4 max-w-[20ch] font-display text-[30px] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink md:text-[38px]">
        Every video you post shows up here, with its whole funnel.
      </h1>

      <p className="mt-4 max-w-[46ch] text-[15px] leading-[1.6] text-muted">
        Not just views — how many people stayed past the first two seconds, how many opened the
        product, how many added it, how many bought. Each one against the median for your
        category, so the numbers mean something on day one.
      </p>

      <Link
        href={STUDIO_ROUTES.newVideo}
        className="mt-6 flex min-h-[54px] w-full items-center justify-center rounded-full bg-coral px-7 text-[16px] font-bold text-ink shadow-cta transition-transform duration-[350ms] ease-spring active:scale-[0.96] md:w-auto md:self-start"
      >
        Post your first video
      </Link>

      <p className="mt-3 text-[13px] leading-[1.5] text-muted">
        It gets {count(REACH_GUARANTEE_IMPRESSIONS)} guaranteed impressions over its first{' '}
        {REACH_GUARANTEE_WINDOW_HOURS} hours, whether or not anyone follows you.
      </p>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE SCREEN
   ═══════════════════════════════════════════════════════════════════════════ */

export default async function StudioVideosPage() {
  const videos = await loadVideos();
  if (videos === null) redirect('/auth/login');

  const live = videos.filter((v) => v.isLive);
  const reached = live.reduce((sum, v) => sum + v.impressions, 0);
  const sold = live.reduce((sum, v) => sum + v.sold, 0);

  return (
    <div className="mx-auto w-full max-w-[560px] px-5 pt-6 md:max-w-[900px] md:px-10 md:pt-10">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div>
          <h1 className="font-display text-[28px] font-extrabold leading-none tracking-[-0.03em] text-ink md:text-[34px]">
            Videos
          </h1>
          <p className="mt-2 text-[14px] text-muted">
            {videos.length === 0
              ? 'Nothing posted yet.'
              : `${count(live.length)} live · ${count(reached)} people reached · ${count(sold)} sold`}
          </p>
        </div>

        {videos.length > 0 && (
          <Link
            href={STUDIO_ROUTES.newVideo}
            className="flex min-h-[44px] items-center justify-center rounded-full bg-coral px-5 text-[14px] font-bold text-ink shadow-cta transition-transform duration-[350ms] ease-spring active:scale-[0.96]"
          >
            Post a video
          </Link>
        )}
      </header>

      {videos.length === 0 ? (
        <div className="mt-6">
          <Empty />
        </div>
      ) : (
        <ul className="mt-6 grid grid-cols-1 gap-3">
          {videos.map((video) => (
            <VideoRowCard key={video.videoId} video={video} />
          ))}
        </ul>
      )}
    </div>
  );
}
