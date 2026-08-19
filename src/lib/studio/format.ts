/**
 * Studio render-boundary formatting.
 *
 * Pure functions, no imports, no locale lookups. Every one of them is
 * null-safe and returns {@link DASH} for "we do not know", so a screen never
 * has to guard before calling one — and never accidentally prints "$0.00"
 * or "NaN%" for a number it does not actually have.
 *
 * Money arrives as INTEGER CENTS and is formatted with integer arithmetic.
 * `cents / 100` as a float is how a ledger loses a penny; the only division
 * that happens here is for the deliberately-lossy compact forms.
 *
 * Percentages arrive as PERCENTAGE POINTS: `pct(48)` is "48%", not `pct(0.48)`.
 */

/** Em dash. The single rendering of "we do not know". */
export const DASH = '—';

export type DeltaTone = 'up' | 'down' | 'flat';

export type DeltaLabel = {
  /** Ready to render, arrow included: "▲ 38%", "▼ 12%", "no change", "—". */
  text: string;
  /** Drives colour. 'up' is not always good — the caller decides the palette. */
  tone: DeltaTone;
};

function isNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Thousands separators on a non-negative integer. */
function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** One decimal place, with a bare ".0" trimmed off: 1.0 -> "1", 1.25 -> "1.3". */
function oneDp(n: number): string {
  const s = (Math.round(n * 10) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/* ═══════════════════════════════════════════════════════════════════════════
   MONEY
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Full precision, always two decimals, thousands separated.
 *
 *   money(128440)  -> "$1,284.40"
 *   money(0)       -> "$0.00"
 *   money(-1250)   -> "-$12.50"
 *   money(null)    -> "—"
 *
 * Use this anywhere the seller might reconcile the figure against a bank
 * statement. Never round it away.
 */
export function money(cents: number | null | undefined): string {
  if (!isNum(cents)) return DASH;
  const rounded = Math.round(cents);
  const abs = Math.abs(rounded);
  const sign = rounded < 0 ? '-' : '';
  const whole = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${group(whole)}.${String(remainder).padStart(2, '0')}`;
}

/**
 * Deliberately lossy, for dense stat tiles where the exact cent is noise.
 *
 *   compactMoney(0)         -> "$0"
 *   compactMoney(499)       -> "$4.99"     (under $10 the cents still matter)
 *   compactMoney(41200)     -> "$412"
 *   compactMoney(120000)    -> "$1.2k"
 *   compactMoney(128440)    -> "$1.3k"
 *   compactMoney(450000000) -> "$4.5m"
 *   compactMoney(null)      -> "—"
 *
 * Never use it on a payout total or a fee line — a seller reconciling "$1.3k"
 * against their bank has been given nothing.
 */
export function compactMoney(cents: number | null | undefined): string {
  if (!isNum(cents)) return DASH;
  const rounded = Math.round(cents);
  if (rounded === 0) return '$0';

  const abs = Math.abs(rounded);
  const sign = rounded < 0 ? '-' : '';

  // Under $10.00 the cents carry most of the information.
  if (abs < 1000) return money(rounded);

  const dollars = Math.round(abs / 100);
  if (dollars < 1000) return `${sign}$${group(dollars)}`;

  const thousands = dollars / 1000;
  if (thousands < 1000) {
    return `${sign}$${thousands >= 10 ? group(Math.round(thousands)) : oneDp(thousands)}k`;
  }

  const millions = thousands / 1000;
  return `${sign}$${millions >= 10 ? group(Math.round(millions)) : oneDp(millions)}m`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PERCENTAGES AND RATIOS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Percentage points in, a percentage out.
 *
 *   pct(48)        -> "48%"
 *   pct(0.7, 1)    -> "0.7%"
 *   pct(0)         -> "0%"
 *   pct(-3.24, 1)  -> "-3.2%"
 *   pct(null)      -> "—"
 *
 * @param dp decimal places, clamped to 0-4. Defaults to 0.
 */
export function pct(n: number | null | undefined, dp = 0): string {
  if (!isNum(n)) return DASH;
  const places = Math.max(0, Math.min(4, Math.trunc(dp)));
  const rounded = Number(n.toFixed(places));
  // Number() collapses "-0.0" to -0; Object.is catches it where === cannot.
  const safe = Object.is(rounded, -0) ? 0 : rounded;
  const abs = Math.abs(safe);
  const [whole, frac] = abs.toFixed(places).split('.');
  const sign = safe < 0 ? '-' : '';
  return `${sign}${group(Number(whole))}${frac ? `.${frac}` : ''}%`;
}

/**
 * A month-over-month change, arrow included. The arrow carries the sign, so
 * the number is never also negative — "▼ -12%" reads as a double negative.
 *
 *   deltaLabel(38)    -> { text: "▲ 38%",     tone: 'up' }
 *   deltaLabel(-12)   -> { text: "▼ 12%",     tone: 'down' }
 *   deltaLabel(0.4)   -> { text: "▲ 0.4%",    tone: 'up' }
 *   deltaLabel(0)     -> { text: "no change", tone: 'flat' }
 *   deltaLabel(null)  -> { text: "—",         tone: 'flat' }
 *
 * Anything rounding to 0.0% is "no change" — a 0.04% swing is noise, and
 * "▲ 0%" is an insult to the reader.
 *
 * Pass `null`, not Infinity, when the previous period was zero: a percentage
 * change from nothing is undefined, and the screen owes the seller real copy
 * ("first sales this month") rather than a made-up multiple.
 */
export function deltaLabel(n: number | null | undefined): DeltaLabel {
  if (!isNum(n)) return { text: DASH, tone: 'flat' };
  if (Math.round(n * 10) === 0) return { text: 'no change', tone: 'flat' };

  const abs = Math.abs(n);
  // Keep a tenth only when it survives rounding and the magnitude is small.
  const needsTenth = abs < 10 && Math.round(abs * 10) % 10 !== 0;
  const body = pct(abs, needsTenth ? 1 : 0);

  return n > 0 ? { text: `▲ ${body}`, tone: 'up' } : { text: `▼ ${body}`, tone: 'down' };
}

/**
 * A multiple, for every comparison against the category median.
 *
 *   ratioLabel(2.3)   -> "2.3x"
 *   ratioLabel(2)     -> "2x"
 *   ratioLabel(0.7)   -> "0.7x"
 *   ratioLabel(12.4)  -> "12x"
 *   ratioLabel(0.04)  -> "<0.1x"
 *   ratioLabel(0)     -> "0x"
 *   ratioLabel(null)  -> "—"
 *
 * Below 0.1x the exact figure is meaningless and the honest render is a
 * bound, not a spurious "0.04x".
 */
export function ratioLabel(x: number | null | undefined): string {
  if (!isNum(x)) return DASH;
  if (x === 0) return '0x';

  const abs = Math.abs(x);
  const sign = x < 0 ? '-' : '';

  if (abs < 0.1) return `${sign}<0.1x`;
  if (abs >= 10) return `${sign}${group(Math.round(abs))}x`;
  return `${sign}${oneDp(abs)}x`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   COUNTS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A plain integer with separators. Used for every impression, tap and sale.
 *
 *   count(412)   -> "412"
 *   count(1284)  -> "1,284"
 *   count(null)  -> "—"
 */
export function count(n: number | null | undefined): string {
  if (!isNum(n)) return DASH;
  const rounded = Math.round(n);
  return `${rounded < 0 ? '-' : ''}${group(Math.abs(rounded))}`;
}

/**
 * Compact count for tiles. Exact below 1,000 — "412/500" must never become
 * "0.4k/0.5k", which would destroy the one number this product is built on.
 *
 *   compactCount(412)     -> "412"
 *   compactCount(1284)    -> "1.3k"
 *   compactCount(1200000) -> "1.2m"
 */
export function compactCount(n: number | null | undefined): string {
  if (!isNum(n)) return DASH;
  const rounded = Math.round(n);
  const abs = Math.abs(rounded);
  const sign = rounded < 0 ? '-' : '';

  if (abs < 1000) return String(rounded);
  if (abs < 1_000_000) {
    const k = abs / 1000;
    return `${sign}${k >= 10 ? group(Math.round(k)) : oneDp(k)}k`;
  }
  const m = abs / 1_000_000;
  return `${sign}${m >= 10 ? group(Math.round(m)) : oneDp(m)}m`;
}

/**
 * Progress as a 0-100 number, ready for a bar's `width: ${n}%`.
 * Over-delivery clamps to 100 — the bar cannot overflow its track — but the
 * underlying counts must be rendered unclamped beside it.
 *
 *   progressPct(412, 500)  -> 82.4
 *   progressPct(700, 500)  -> 100
 *   progressPct(0, 500)    -> 0
 *   progressPct(1, 0)      -> 100   (a zero budget is already delivered)
 */
export function progressPct(
  delivered: number | null | undefined,
  total: number | null | undefined
): number {
  if (!isNum(delivered) || !isNum(total)) return 0;
  if (total <= 0) return delivered > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (delivered / total) * 100));
}

/* ═══════════════════════════════════════════════════════════════════════════
   TIME
   ═══════════════════════════════════════════════════════════════════════════ */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A short date, always in UTC.
 *
 *   dateLabel('2026-08-21T14:00:00Z') -> "Aug 21"
 *   dateLabel(null)                   -> "—"
 *
 * UTC, not local, on purpose: these strings are produced during a server
 * render and shipped as HTML. Formatting in the server's local zone would
 * make the same payout read as a different day depending on where the box is,
 * and would mismatch if a client component ever re-rendered it.
 */
export function dateLabel(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return DASH;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * The full month name for a heading: "August". UTC, for the reason above —
 * the caption over an earnings figure must be computed in the same zone the
 * figure's month boundaries were.
 */
export function monthLabel(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return DASH;
  return MONTHS_LONG[d.getUTCMonth()];
}

/**
 * Whole hours elapsed since an ISO timestamp. `null` when unparseable.
 * Used to decide whether a video is still inside the 48h guarantee window.
 * Future timestamps return a negative number rather than lying about zero.
 */
export function hoursSince(
  iso: string | null | undefined,
  now: number = Date.now()
): number | null {
  const d = parse(iso);
  if (!d) return null;
  return Math.floor((now - d.getTime()) / 3_600_000);
}

/**
 * Human elapsed time.
 *
 *   sinceLabel(30s ago)  -> "just now"
 *   sinceLabel(3h ago)   -> "3h ago"
 *   sinceLabel(2d ago)   -> "2d ago"
 *   sinceLabel(40d ago)  -> "Jul 10"    (falls back to a date)
 *
 * Pass an explicit `now` from a client component so the server render and the
 * hydrated render agree; a server component can let it default.
 */
export function sinceLabel(
  iso: string | null | undefined,
  now: number = Date.now()
): string {
  const d = parse(iso);
  if (!d) return DASH;

  const minutes = Math.floor((now - d.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;

  return dateLabel(iso);
}
