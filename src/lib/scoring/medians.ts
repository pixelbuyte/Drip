// The load path for spec 2.2's per-category normalisation references.
//
// Migration 00013 computes `public.category_rate_medians` from video_stats;
// this is the other half — it turns those rows into the exact `CategoryMedians`
// shape `medianFor` / `makeMedianResolver` already consume, so nothing
// downstream of `normToReference` changes at all.
//
// Split in two on purpose:
//
//   toCategoryMedians()   pure transform, rows in -> CategoryMedians out. All
//                         the policy lives here and is testable with a literal
//                         array and no database.
//   loadCategoryMedians() the thinnest possible fetch around it, taking the
//                         client structurally so this module imports nothing.
//
// The determinism contract in ./types applies: no clock, no randomness. This
// module never constructs a Date and never reads one.

import {
  DEFAULT_CATEGORY_MEDIANS,
  type CategoryMedians,
  type NormalisableRate,
  type RateMedians,
} from './types';

/** The table migration 00013 creates. */
export const CATEGORY_MEDIANS_TABLE = 'category_rate_medians';

/**
 * Column name for every `NormalisableRate`, in the order the migration
 * declares them. This map is the ONLY place the two naming schemes meet:
 * adding a rate means adding it here, to the table, and to the aggregate in
 * 00013, and nowhere else.
 */
export const MEDIAN_RATE_COLUMNS: Readonly<Record<NormalisableRate, string>> = {
  purchaseRate: 'purchase_rate',
  cartRate: 'cart_rate',
  tapRate: 'tap_rate',
  shareRate: 'share_rate',
  saveRate: 'save_rate',
  avgLoopCount: 'avg_loop_count',
  skipUnder2sRate: 'skip_under_2s_rate',
  reportRate: 'report_rate',
  notInterestedRate: 'not_interested_rate',
};

const RATE_KEYS = Object.keys(MEDIAN_RATE_COLUMNS) as NormalisableRate[];

/** The columns the loader asks for, as a PostgREST select list. */
export const CATEGORY_MEDIANS_SELECT = ['category_id', ...Object.values(MEDIAN_RATE_COLUMNS)].join(
  ','
);

/**
 * One row of `category_rate_medians` as it comes off the wire. Deliberately
 * `unknown`-valued: PostgREST renders `numeric` as a JSON number, node-postgres
 * renders it as a string, and a column the job has not filled yet is null. The
 * transform is responsible for all three, so no caller has to be.
 */
export type CategoryMedianRow = {
  category_id?: unknown;
  [column: string]: unknown;
};

/**
 * A median is only usable if `normToReference` can divide by it. Zero is the
 * common real case — purchases are rare enough that a whole category's median
 * video genuinely has none in 24h — and 2.5 * 0 is a reference of 0, which
 * yields Infinity or NaN and would silently pin every video in that category to
 * the top of the feed. Negative and non-finite are impossible from the job (the
 * table CHECKs >= 0) but are rejected here anyway: this is the trust boundary,
 * and a NaN reaching `norm()` is a whole feed's worth of damage.
 *
 * Rejected rates are OMITTED rather than zeroed, so `medianFor` falls through
 * to the global fallback for that one rate. That is the same rule
 * `resolveMedian` applies at scoring time, stated once more at the edge.
 */
export function coerceMedian(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function readRates(row: CategoryMedianRow): Partial<RateMedians> {
  const out: Partial<RateMedians> = {};
  for (const rate of RATE_KEYS) {
    const v = coerceMedian(row[MEDIAN_RATE_COLUMNS[rate]]);
    if (v !== undefined) out[rate] = v;
  }
  return out;
}

/**
 * Rows -> `CategoryMedians`. Pure; no database, no clock.
 *
 * Three rules, all of which exist because a wrong normalisation reference is
 * invisible — it does not throw, it just quietly re-scales every weight:
 *
 *  1. GLOBAL ROW. `category_id IS NULL` is the platform-wide fallback. It is
 *     layered OVER `DEFAULT_CATEGORY_MEDIANS.fallback` rather than replacing
 *     it, so a rate the job could not measure keeps its shipped default
 *     instead of vanishing — `fallback` is typed complete and every consumer
 *     relies on that. This mirrors `computeCategoryMedians` in simulate.ts,
 *     which keeps the shipped default when the world itself has no signal.
 *
 *     It also serves UNCATEGORISED videos: `medianFor` looks up
 *     `byCategory['']` for a null categoryId, finds nothing, and resolves to
 *     `fallback`. That is why 00013 deliberately writes no row for the
 *     uncategorised group.
 *
 *  2. PER-RATE FALLBACK. A category row contributes only the rates it actually
 *     has. A category with a trustworthy tap rate and no purchase signal keeps
 *     its tap rate; discarding the whole row over one null column would throw
 *     away good evidence.
 *
 *  3. EMPTY IS NOT ZERO. No rows at all returns `DEFAULT_CATEGORY_MEDIANS`
 *     unchanged. An empty table means the job has not run or nothing has
 *     cleared the sample floor yet, and the shipped defaults are exactly the
 *     v1 global caps — the feed degrades to v1 behaviour, not to a division by
 *     zero.
 */
export function toCategoryMedians(rows: readonly CategoryMedianRow[] | null | undefined): CategoryMedians {
  if (!rows || rows.length === 0) return DEFAULT_CATEGORY_MEDIANS;

  const fallback: RateMedians = { ...DEFAULT_CATEGORY_MEDIANS.fallback };
  const byCategory: Record<string, Partial<RateMedians>> = {};
  let sawAny = false;

  for (const row of rows) {
    const rates = readRates(row);
    const rawId = row.category_id;
    const categoryId = typeof rawId === 'string' && rawId.length > 0 ? rawId : null;

    if (categoryId === null) {
      // The table's partial unique index allows only one global row; if a
      // second ever appears, the last one wins, deterministically.
      for (const rate of RATE_KEYS) {
        const v = rates[rate];
        if (v !== undefined) {
          fallback[rate] = v;
          sawAny = true;
        }
      }
      continue;
    }

    if (Object.keys(rates).length === 0) continue; // a row of nothing usable
    byCategory[categoryId] = { ...byCategory[categoryId], ...rates };
    sawAny = true;
  }

  // Rows that carried no usable number anywhere are indistinguishable from no
  // rows at all, and must resolve the same way.
  if (!sawAny) return DEFAULT_CATEGORY_MEDIANS;
  return { byCategory, fallback };
}

/**
 * The minimum surface of a Supabase client this loader needs. Structural rather
 * than imported so ./scoring stays free of every dependency the barrel would
 * otherwise drag into a client bundle, and so a test can pass an object literal.
 */
export type CategoryMedianSource = {
  from(table: string): {
    select(columns: string): PromiseLike<{ data: unknown; error: unknown }>;
  };
};

/**
 * Read the table, or fall back to the shipped defaults.
 *
 * NEVER THROWS, on purpose. This sits on the request path for the feed. If the
 * medians table is unreachable the correct behaviour is a feed ranked against
 * the v1 global caps, not a 500 — the references are a refinement of the
 * ranking, not a precondition for it. Callers that need to know whether the
 * refinement was applied can compare the result against
 * `DEFAULT_CATEGORY_MEDIANS` by identity.
 */
export async function loadCategoryMedians(
  source: CategoryMedianSource
): Promise<CategoryMedians> {
  try {
    const { data, error } = await source.from(CATEGORY_MEDIANS_TABLE).select(CATEGORY_MEDIANS_SELECT);
    if (error || !Array.isArray(data)) return DEFAULT_CATEGORY_MEDIANS;
    return toCategoryMedians(data as CategoryMedianRow[]);
  } catch {
    return DEFAULT_CATEGORY_MEDIANS;
  }
}
