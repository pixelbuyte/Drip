/**
 * Studio data contracts.
 *
 * Every screen under /studio codes against this file. It is deliberately
 * plain — types, unions and constants, no runtime dependencies — so it can be
 * imported from a server component, a client component or a route handler
 * without dragging anything along.
 *
 * THREE CONVENTIONS THAT ARE NOT NEGOTIABLE, because getting them wrong is
 * silent rather than loud:
 *
 *   1. MONEY IS ALWAYS INTEGER CENTS. Any field ending in `Cents` is an
 *      integer number of cents. Never a float, never dollars. Convert exactly
 *      once, at the render boundary, with `money()` / `compactMoney()` from
 *      ./format.
 *
 *   2. PERCENTAGES ARE PERCENTAGE POINTS, NOT FRACTIONS. Any field ending in
 *      `Pct` holds 48 to mean 48%, and 0.7 to mean 0.7%. It never holds 0.48.
 *      `pct()` from ./format renders them.
 *
 *   3. TIMESTAMPS ARE ISO-8601 STRINGS, NOT `Date`. A `Date` cannot cross the
 *      server/client boundary in a payload and formats differently in two
 *      timezones. Store the string, format it with `dateLabel()` /
 *      `sinceLabel()`.
 *
 * A `null` always means "we do not know", and must render as an em dash or as
 * real copy — never as a zero. `0` means we know, and the answer is zero.
 * That distinction is the whole difference between "no sales yet" and
 * "Stripe is down"; do not collapse it.
 */

/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The reach guarantee. Spec 2.8: every new video is pushed to at least this
 * many shoppers over its first {@link REACH_GUARANTEE_WINDOW_HOURS} hours,
 * independent of follower count. Mirrors `feed_weights.exploration_budget`
 * and the `video_stats.exploration_impressions` counter.
 */
export const REACH_GUARANTEE_IMPRESSIONS = 500;

/** The window the guarantee is delivered over. Also the "fresh" lane window. */
export const REACH_GUARANTEE_WINDOW_HOURS = 48;

/**
 * Freshness half-life in hours (`feed_weights.freshness_half_life_hours`).
 * Studio quotes this when it tells a seller why posting again matters.
 */
export const FRESHNESS_HALF_LIFE_HOURS = 72;

/** Pre-launch cap on the founding-seller cohort. Spec 7.6. */
export const FOUNDING_SELLER_CAP = 50;

/**
 * Drip's commission after the founding program ends, in percentage points.
 * The live rate is `DRIP_FEE_BPS` in `@/lib/stripe` (0 today) — that is the
 * source of truth. This is only the number the badge compares against.
 */
export const STANDARD_DRIP_FEE_PCT = 8;

/**
 * Order statuses that count as money earned. Refunded, disputed, canceled and
 * pending orders are excluded — which is also how `rollup_video_stats()`
 * computes commerce, so Studio and the feed never disagree about a sale.
 */
export const COUNTED_ORDER_STATUSES = [
  'paid',
  'label_created',
  'shipped',
  'delivered',
] as const;

export type CountedOrderStatus = (typeof COUNTED_ORDER_STATUSES)[number];

/* ═══════════════════════════════════════════════════════════════════════════
   NAVIGATION
   ═══════════════════════════════════════════════════════════════════════════ */

export type StudioTab = 'home' | 'videos' | 'money';

/**
 * Every href Studio links to, in one place, so four agents cannot drift into
 * four spellings of the same route. Anything still pointing at `/dashboard`
 * is a legacy screen Studio has not absorbed yet — change it here when it is
 * absorbed and every caller follows.
 */
export const STUDIO_ROUTES = {
  home: '/studio',
  videos: '/studio/videos',
  money: '/studio/money',
  /** Per-video funnel (spec 7.3). */
  video: (videoId: string) => `/studio/videos/${videoId}`,
  /** Upload still lives on the legacy dashboard until Videos owns it. */
  newVideo: '/dashboard/drops/new',
  /** Ship-from address. Written to `seller_payments.from_address`. */
  shipFromAddress: '/dashboard/settings',
  /** Stripe Connect onboarding. */
  connectPayouts: '/onboarding/stripe',
  /** The buyer-facing feed, for a seller who wants to see their own video. */
  feed: '/feed',
} as const;

/* ═══════════════════════════════════════════════════════════════════════════
   THE SELLER
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Spec 7.6's retention mechanic: a founding seller's rate is locked, and the
 * badge exists so they can see what they would be paying if they had waited.
 *
 * `null` (rather than `isFounding: false`) is the right value when we could
 * not work out the cohort at all — render nothing, not "you are not special".
 */
export type FoundingSellerStatus = {
  isFounding: boolean;
  /** 1-based position in signup order. Seller #7 of {@link FOUNDING_SELLER_CAP}. */
  sellerNumber: number;
  /** Percentage points. 0 during the founding program. */
  lockedRatePct: number;
  /** Percentage points. What a later seller pays — {@link STANDARD_DRIP_FEE_PCT}. */
  standardRatePct: number;
};

/**
 * The signed-in seller, as every Studio screen needs them.
 *
 * NOTE `chargesEnabled` and `hasShipFromAddress` are derived from the
 * `seller_payments` row (seller_id, stripe_account_id, charges_enabled,
 * from_address). They are NOT on `profiles` — `profiles` has a public read
 * policy and the payment identifiers plus the seller's home address were
 * moved off it deliberately. Never read them from `profiles`.
 *
 * Both are `false` when the `seller_payments` row is missing, which is also
 * what a seller who never started onboarding looks like. That is correct: in
 * both cases the answer to "can this account take money" is no.
 */
export type StudioSeller = {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  chargesEnabled: boolean;
  hasShipFromAddress: boolean;
  founding: FoundingSellerStatus | null;
};

/* ═══════════════════════════════════════════════════════════════════════════
   THINGS WORTH DOING
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A stable machine key per action, so a screen can pick an icon or a tone
 * without string-matching the copy. Ordered here roughly by urgency: the
 * first kinds are money leaking right now.
 */
export type TodoKind =
  | 'restock'              // a live video is selling something sold out
  | 'ship_order'           // a paid order has no label yet
  | 'connect_payouts'      // Stripe Connect incomplete — a sale cannot pay out
  | 'add_ship_from_address'// no from_address — a sale cannot print a label
  | 'post_first_video'     // nothing live at all
  | 'review_funnel'        // the 500 finished; go read what they did
  | 'fix_hook'             // heavy sub-2s skipping
  | 'post_again';          // freshness has decayed since the last upload

/**
 * One action. Never a bare observation: if there is nothing to click, it is
 * not a todo, it is decoration, and spec 7.2 says cut it.
 *
 * `text` is a complete sentence written for a phone screen — the screen
 * renders it verbatim and does not append anything.
 */
export type Todo = {
  kind: TodoKind;
  text: string;
  href: string;
};

/* ═══════════════════════════════════════════════════════════════════════════
   THE PULSE (spec 7.2)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * One live video and its reach-guarantee progress.
 *
 * `budgetDelivered / budgetTotal` is the single most important pair of
 * numbers in Studio: it is the visible proof of the 500-impression promise,
 * and it is what stops a new seller concluding they were buried after one
 * quiet upload.
 */
export type LiveVideo = {
  videoId: string;
  /**
   * `videos.caption`, falling back to the first attached product's title,
   * falling back to a placeholder. Never empty, never null — a nameless row
   * in a list is unreadable.
   */
  title: string;
  /** ISO-8601. `videos.published_at`. */
  postedAt: string;
  /** `video_stats.impressions_all` — times it appeared in someone's feed. */
  impressions: number;
  /** `video_stats.product_taps_all` — times someone opened the product. */
  taps: number;
  /** `video_stats.purchases_all` — counted orders attributed to this video. */
  sold: number;
  /**
   * `video_stats.exploration_impressions` — impressions delivered against the
   * guarantee so far. Can exceed `budgetTotal`; clamp when drawing the bar,
   * do not clamp the number.
   */
  budgetDelivered: number;
  /** {@link REACH_GUARANTEE_IMPRESSIONS} today. A column when budgets vary. */
  budgetTotal: number;
};

/**
 * Everything above the fold on the Studio home screen.
 *
 * Zero rows is a first-class state, not an error: today it is the ONLY state,
 * and it is also what every brand-new seller sees. A `StudioPulse` with
 * `liveVideos: []` and `orderCount: 0` must render a genuine first-run
 * screen, not "$0.00" four times.
 */
export type StudioPulse = {
  /**
   * Net to the seller across counted orders in the current calendar month:
   * charge total minus Drip's commission and the card-processing passthrough.
   * The number they can actually spend, not gross merchandise value.
   *
   * Month boundaries are UTC, and the month label rendered beside this number
   * must be computed in UTC too, so the figure and its caption always agree.
   */
  earnedCentsThisMonth: number;
  /** Counted orders in the same window. */
  orderCount: number;
  /**
   * Percentage points versus the same measure last month. Positive is up.
   *
   * `null` when there is nothing to compare against — last month had no
   * earnings, so the change is undefined rather than infinite. Producers must
   * pass `null` in that case; the screen writes real copy for it instead of
   * rendering a fake percentage.
   */
  deltaVsLastMonthPct: number | null;
  /**
   * Money at Stripe that has not landed in the seller's bank yet.
   * `null` = we could not reach Stripe. `0` = nothing pending. Rendering a
   * "$0.00" for an unreachable Stripe is a lie, so keep them apart.
   */
  pendingPayoutCents: number | null;
  /** ISO-8601 arrival date of the next payout. `null` when none is scheduled. */
  nextPayoutDate: string | null;
  /** Newest first. Consumers filter to the guarantee window themselves. */
  liveVideos: LiveVideo[];
  /** At most three. Already prioritised — render in order, do not re-sort. */
  todos: Todo[];
};

/* ═══════════════════════════════════════════════════════════════════════════
   THE FUNNEL (spec 7.3)
   ═══════════════════════════════════════════════════════════════════════════ */

/** Stable key per step, so icons and copy do not string-match a label. */
export type FunnelStepKey =
  | 'impressions'
  | 'watched'
  | 'taps'
  | 'add_to_cart'
  | 'purchases';

/**
 * One rung of the funnel, always benchmarked. Spec principle 2: "412 views"
 * means nothing; "412 views — 2.1x the category median" means something.
 */
export type FunnelStep = {
  key: FunnelStepKey;
  /** Shopper-language label: "Saw it", "Watched it through", "Tapped the product". */
  label: string;
  count: number;
  /**
   * Conversion from the PREVIOUS step, in percentage points.
   * `null` on the first step, which has nothing to convert from.
   */
  ratePct: number | null;
  /**
   * The same conversion across the video's category, in percentage points.
   * `null` when the category has too few videos to have an honest median —
   * show no benchmark rather than a benchmark drawn from four videos.
   */
  medianRatePct: number | null;
  /**
   * `ratePct / medianRatePct`. 2.3 renders as "2.3x" via `ratioLabel()`.
   * `null` when either side is null, or the median is 0.
   */
  ratio: number | null;
};

/**
 * The one thing to fix. Exactly one cause and exactly one lever, because a
 * seller given five things to change learns nothing from the result.
 *
 * Every string is rendered verbatim and must be honest about the algorithm
 * (principle 4) — a seller who understands the ranking makes better videos.
 */
export type DropOffDiagnosis = {
  /** Which rung leaks. */
  step: FunnelStepKey;
  /** The gap, stated with both numbers: "38% tapped. The category median is 61%." */
  gapDescription: string;
  /** The single likeliest reason. */
  oneCause: string;
  /** The single change to make next time — always something the seller controls. */
  oneLever: string;
};

export type VideoFunnel = {
  videoId: string;
  /** Ordered widest to narrowest. */
  steps: FunnelStep[];
  /** `null` when nothing is meaningfully below median, or there is too little data. */
  dropOff: DropOffDiagnosis | null;
};

/* ═══════════════════════════════════════════════════════════════════════════
   THE MONEY (spec 7.4)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Where one order's money went, to the cent. This is the anti-surprise
 * screen: a seller who cannot reconcile a payout stops trusting the platform.
 *
 * The identity the screen must be able to show, and which must hold exactly:
 *
 *   netCents = grossCents + shippingChargedCents
 *            - dripFeeCents - processingCents - (labelCents ?? 0)
 */
export type EarningsBreakdown = {
  /** Short human-readable reference, e.g. "#4F2A9C". Not the raw uuid. */
  orderRef: string;
  /** ISO-8601. When the order was placed. */
  soldAt: string;
  /** Item subtotal the buyer paid, before shipping. */
  grossCents: number;
  /** Drip's commission. 0 during the founding program. */
  dripFeeCents: number;
  /** Percentage points that produced `dripFeeCents`. 0 during the program. */
  dripFeeRatePct: number;
  /** Card-processing passthrough (2.9% + 30c). Charged by Stripe, not by Drip. */
  processingCents: number;
  /** Shipping the buyer paid. Money in, not money out. */
  shippingChargedCents: number;
  /**
   * What the shipping label actually cost.
   * `null` = no label bought yet, or the cost was never recorded. Treat as 0
   * in the arithmetic, but render it as unknown — a label that has not been
   * bought is not a label that was free.
   */
  labelCents: number | null;
  /** What the seller keeps. See the identity above. */
  netCents: number;
};
