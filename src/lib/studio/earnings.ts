/**
 * Studio earnings arithmetic — spec 7.6.
 *
 * Every number the money screen shows is computed here, and nothing here
 * touches the network, the clock, or a React tree. Pure functions, integer
 * cents in, integer cents out.
 *
 * THIS IS MONEY. A rounding bug in this file is a financial defect, not a
 * cosmetic one, so three rules hold without exception:
 *
 *   1. INTEGER CENTS ONLY. No float ever holds an amount. Percentages are
 *      converted to basis points and multiplied before dividing, so the only
 *      division is the final integer-scaled one.
 *
 *   2. ONE ROUNDING RULE, APPLIED ONCE PER FEE: half away from zero, on the
 *      fee itself, never on the residual. See {@link bpsOf}. The seller's net
 *      is defined as what is left after the rounded fees — it is never itself
 *      rounded, which is what makes the parts sum exactly to the whole.
 *
 *   3. THE LEDGER WINS. When an order recorded what Stripe actually took
 *      (`orders.platform_fee_cents`), that figure is authoritative and the
 *      breakdown is derived from it. A screen that disagrees with the bank by
 *      a cent is worse than no screen: it is the exact thing that makes a
 *      seller stop trusting the platform.
 *
 * WHY HALF AWAY FROM ZERO, AND WHY ON EACH FEE
 *
 * `applicationFeeAmount()` in `@/lib/stripe` — the code that actually moves
 * the money — computes `Math.round((cents * bps) / 10_000)`. Stripe rounds
 * its own processing fee the same way. Any other rule here (banker's
 * rounding, floor, rounding the total instead of the parts) would produce a
 * breakdown that differs by a cent from the charge the seller can see in
 * their Stripe dashboard, on exactly the amounts they scrutinise most.
 * Matching the charging code is not a preference, it is the requirement.
 *
 * `Math.round` alone rounds half toward +infinity, so -0.5 becomes -0 rather
 * than -1. Fees are therefore always computed on a magnitude and the sign
 * re-applied, which makes the fee on a $30 refund identical to the fee on a
 * $30 sale — a symmetry a reversal screen has to have.
 */

import { progressPct } from './format';
import { STANDARD_DRIP_FEE_PCT, type EarningsBreakdown } from './types';

/* ═══════════════════════════════════════════════════════════════════════════
   THE RATES — the only place any of them is written down
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Every rate spec 7.6 defines, and nothing else. Changing a rate is a
 * one-line edit here; there is deliberately no second copy anywhere.
 *
 * All percentages are PERCENTAGE POINTS (6 means 6%), matching the `*Pct`
 * convention in `./types`.
 *
 * NOTE the difference between a POLICY rate and a CHARGED rate. These are
 * policy: what the pricing page promises. What a given order was actually
 * charged is recorded on that order, and {@link buildOrderEarnings} always
 * prefers the recorded figure. During the founding program the live
 * commission (`DRIP_FEE_BPS` in `@/lib/stripe`) is 0, so a real order will
 * often show 0% against a 6% policy rate. Rendering the charged number is
 * correct; the badge quoting the policy rate is what the seller is protected
 * at, and both can be true at once.
 */
export const FEE_RATES = {
  /** Drip's commission for a founding seller. Locked for life. */
  foundingDripPct: 6,
  /** Drip's commission for everyone who signs up after the cohort closes. */
  standardDripPct: STANDARD_DRIP_FEE_PCT,
  /** Stripe's card-processing rate. A passthrough — Drip keeps none of it. */
  processingPct: 2.9,
  /** Stripe's flat per-charge component, on top of {@link processingPct}. */
  processingFixedCents: 30,
  /**
   * Monthly volume tiers, cheapest commission last. A seller pays the lowest
   * rate they qualify for: their base rate, or a tier they have crossed this
   * month, whichever is smaller. Measured on gross item sales, which is the
   * number the seller can see accumulating.
   */
  volumeTiers: [
    { thresholdCents: 100_000, dripPct: 6 },
    { thresholdCents: 500_000, dripPct: 4 },
  ],
} as const;

/* ═══════════════════════════════════════════════════════════════════════════
   PRIMITIVES
   ═══════════════════════════════════════════════════════════════════════════ */

/** Coerce anything to a whole number of cents. NaN and Infinity become 0. */
function intCents(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Percentage points to basis points.
 *
 *   toBps(6)   -> 600
 *   toBps(2.9) -> 290
 *   toBps(4)   -> 400
 *
 * The rounding is load-bearing, not defensive. `x * 100` is not exact in
 * IEEE-754 for every two-decimal rate — `4.35 * 100` is 434.99999999999994 —
 * so `Math.trunc` would silently bill 4.34%. The policy rates in
 * {@link FEE_RATES} happen to survive it today, but the EFFECTIVE rates this
 * module derives (a recorded commission divided by the item subtotal) are
 * arbitrary reals, and they are fed straight back in by
 * {@link summarizeReversal}. There is a test pinning exactly this.
 */
export function toBps(ratePct: number): number {
  if (!Number.isFinite(ratePct)) return 0;
  return Math.round(ratePct * 100);
}

/**
 * `cents * bps / 10_000`, rounded half AWAY FROM ZERO.
 *
 * The multiply happens before the divide so the intermediate stays exact for
 * every amount this product will ever see (a $10,000 order at 800bps is
 * 8 x 10^9, far below `Number.MAX_SAFE_INTEGER`).
 *
 * Sign is taken off first and re-applied after, so `bpsOf(-500, 290)` is
 * exactly `-bpsOf(500, 290)`. `Math.round(-14.5)` would give -14 and quietly
 * break that symmetry on refunds.
 */
export function bpsOf(cents: number, bps: number): number {
  if (!Number.isFinite(cents) || !Number.isFinite(bps)) return 0;
  const sign = cents < 0 ? -1 : 1;
  return sign * Math.round((Math.abs(cents) * bps) / 10_000);
}

/**
 * Drip's commission on the item subtotal.
 *
 * Shipping is NOT in the base. The seller collected that on the carrier's
 * behalf and hands most of it straight back to EasyPost; taking a commission
 * on it would be charging them for the privilege of posting a parcel. This
 * also matches `applicationFeeAmount(itemCents, ...)` in `@/lib/stripe`.
 */
export function dripCommissionCents(itemSubtotalCents: number, ratePct: number): number {
  const base = intCents(itemSubtotalCents);
  if (base <= 0) return 0;
  return bpsOf(base, toBps(ratePct));
}

/**
 * Stripe's card processing on one charge: 2.9% + 30c.
 *
 * The base is the FULL amount charged to the card — items plus shipping —
 * because that is what Stripe bills on. Spec 7.6's worked example computes
 * 2.9% of the item price alone and so quotes $3.08 on a $96.00 order; on the
 * real $101.99 charge it is $3.26. This function bills the way Stripe does,
 * and {@link buildOrderEarnings} feeds it the charge total. Under-stating it
 * would make this screen disagree with both the seller's Stripe dashboard and
 * the earnings figure on `/studio`, which nets against the same recorded fee.
 *
 * A zero charge costs zero: there is no charge, so there is no 30c. Only a
 * real charge — a penny is enough — attracts the fixed component.
 *
 *   processingFeeCents(0)         -> 0
 *   processingFeeCents(1)         -> 30
 *   processingFeeCents(100)       -> 33
 *   processingFeeCents(500)       -> 45      (14.5 rounds up, half away from zero)
 *   processingFeeCents(9_600)     -> 308
 *   processingFeeCents(1_000_000) -> 29_030
 */
export function processingFeeCents(chargeTotalCents: number): number {
  const base = intCents(chargeTotalCents);
  if (base <= 0) return 0;
  return bpsOf(base, toBps(FEE_RATES.processingPct)) + FEE_RATES.processingFixedCents;
}

/**
 * What Drip asks Stripe to move out of the charge: commission plus the
 * processing passthrough. Mirrors `applicationFeeAmount()` in `@/lib/stripe`,
 * including its cap.
 *
 * THE CAP MATTERS ON CHEAP ORDERS. A 1c sale attracts a 30c processing fee.
 * The application fee cannot exceed the charge, so Stripe takes 1c and Drip
 * absorbs the other 29c out of its own balance. The seller nets 0, not -29c,
 * and {@link buildOrderEarnings} reports the absorbed amount so the screen can
 * say so out loud.
 */
export function applicationFeeCents(
  itemSubtotalCents: number,
  chargeTotalCents: number,
  dripRatePct: number
): number {
  const total = Math.max(0, intCents(chargeTotalCents));
  const commission = dripCommissionCents(itemSubtotalCents, dripRatePct);
  const processing = processingFeeCents(total);
  return Math.min(commission + processing, total);
}

/* ═══════════════════════════════════════════════════════════════════════════
   WHICH RATE THIS SELLER PAYS
   ═══════════════════════════════════════════════════════════════════════════ */

export type SellerRateInput = {
  isFounding: boolean;
  /** Gross item sales so far this month, in cents. */
  monthGrossCents: number;
};

/**
 * The rate a seller pays right now: their base rate, lowered by any volume
 * tier they have already crossed this month. Never raised — a tier can only
 * help.
 *
 *   standard, $0        -> 8
 *   standard, $1,200    -> 6
 *   founding, $0        -> 6   (already better than the $1,000 tier)
 *   founding, $6,000    -> 4
 */
export function effectiveDripRatePct({ isFounding, monthGrossCents }: SellerRateInput): number {
  const base = isFounding ? FEE_RATES.foundingDripPct : FEE_RATES.standardDripPct;
  const gross = intCents(monthGrossCents);
  let rate: number = base;
  for (const tier of FEE_RATES.volumeTiers) {
    if (gross >= tier.thresholdCents && tier.dripPct < rate) rate = tier.dripPct;
  }
  return rate;
}

export type VolumeTierProgress = {
  /** What they pay today. */
  currentRatePct: number;
  /** What crossing {@link thresholdCents} would drop them to. */
  nextRatePct: number;
  thresholdCents: number;
  monthGrossCents: number;
  /** Still to sell this month. Always > 0 — a reached tier is not "next". */
  remainingCents: number;
  /** 0-100, ready for a bar's width. */
  progressPct: number;
};

/**
 * The next tier worth showing, or `null` when the seller is already on the
 * best rate that exists.
 *
 * "Next" means strictly cheaper than what they pay now AND not yet reached.
 * That is what puts a founding seller — already at 6% — in front of the 4%
 * tier at $5,000 instead of a $1,000 tier that would change nothing for them.
 */
export function volumeTierProgress(
  monthGrossCents: number,
  isFounding: boolean
): VolumeTierProgress | null {
  const gross = Math.max(0, intCents(monthGrossCents));
  const currentRatePct = effectiveDripRatePct({ isFounding, monthGrossCents: gross });

  const next = FEE_RATES.volumeTiers.find(
    (tier) => tier.dripPct < currentRatePct && gross < tier.thresholdCents
  );
  if (!next) return null;

  return {
    currentRatePct,
    nextRatePct: next.dripPct,
    thresholdCents: next.thresholdCents,
    monthGrossCents: gross,
    remainingCents: next.thresholdCents - gross,
    progressPct: progressPct(gross, next.thresholdCents),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ONE ORDER, LINE BY LINE
   ═══════════════════════════════════════════════════════════════════════════ */

export type OrderEarningsInput = {
  orderRef: string;
  /** ISO-8601. */
  soldAt: string;
  itemSubtotalCents: number;
  shippingChargedCents: number;
  /**
   * What the shipping label cost. `null` when no label has been bought, or
   * when the cost was never recorded — which is every order today, because
   * `orders` has no column for it. Treated as 0 in the arithmetic and
   * rendered as unknown: a label that has not been bought is not a label that
   * was free.
   */
  labelCents: number | null;
  /** The policy rate to bill at, if the order did not record what it paid. */
  dripRatePct: number;
  /**
   * `orders.platform_fee_cents` — what Stripe actually moved. When present it
   * OVERRIDES the computed fee and the breakdown is derived from it, so this
   * screen can never disagree with the seller's balance.
   */
  recordedApplicationFeeCents?: number | null;
};

/**
 * One order's money, to the cent. A superset of the shared
 * {@link EarningsBreakdown} contract — it satisfies that type exactly, and
 * adds the three figures the money screen needs to explain itself.
 */
export type OrderEarnings = EarningsBreakdown & {
  /** Items + shipping. What the card was charged, and Stripe's fee base. */
  chargeTotalCents: number;
  /** `dripFeeCents + processingCents`. What left the charge as fees. */
  applicationFeeCents: number;
  /**
   * Processing Drip paid on the seller's behalf because the fee would
   * otherwise have exceeded the charge. Non-zero only on sub-31c orders.
   */
  absorbedByDripCents: number;
};

/**
 * Build one order's breakdown.
 *
 * The identity below holds EXACTLY, for every input, with no rounding slack:
 *
 *   netCents = grossCents + shippingChargedCents
 *            - dripFeeCents - processingCents - (labelCents ?? 0)
 *
 * It holds because `netCents` is computed as the residual rather than
 * independently rounded. Every fee is rounded once, at the moment it is
 * computed; nothing downstream rounds again.
 */
export function buildOrderEarnings(input: OrderEarningsInput): OrderEarnings {
  const grossCents = Math.max(0, intCents(input.itemSubtotalCents));
  const shippingChargedCents = Math.max(0, intCents(input.shippingChargedCents));
  const chargeTotalCents = grossCents + shippingChargedCents;
  const labelCents =
    input.labelCents === null || input.labelCents === undefined
      ? null
      : Math.max(0, intCents(input.labelCents));

  // What policy says, and what Stripe's own arithmetic says.
  const policyCommission = dripCommissionCents(grossCents, input.dripRatePct);
  const fullProcessing = processingFeeCents(chargeTotalCents);

  const recorded = input.recordedApplicationFeeCents;
  const hasRecorded = typeof recorded === 'number' && Number.isFinite(recorded);

  let applicationFee: number;
  let processingCents: number;
  let dripFeeCents: number;

  if (hasRecorded) {
    // The ledger wins. Processing is a published formula on a known base, so
    // it is the trustworthy half of the split; the commission is whatever is
    // left, which is exactly how the fee was assembled in the first place.
    applicationFee = clamp(intCents(recorded), 0, chargeTotalCents);
    processingCents = Math.min(fullProcessing, applicationFee);
    dripFeeCents = applicationFee - processingCents;
  } else {
    applicationFee = Math.min(policyCommission + fullProcessing, chargeTotalCents);
    // The commission can never be the part that gets capped: it is at most 8%
    // of the items, which is at most the charge. Only the passthrough shrinks.
    dripFeeCents = Math.min(policyCommission, applicationFee);
    processingCents = applicationFee - dripFeeCents;
  }

  const absorbedByDripCents = Math.max(0, fullProcessing - processingCents);

  // Quote the clean policy number when it is exactly what was charged;
  // otherwise show the rate the seller actually paid, however untidy.
  const dripFeeRatePct =
    dripFeeCents === policyCommission
      ? input.dripRatePct
      : grossCents > 0
        ? (dripFeeCents / grossCents) * 100
        : 0;

  const netCents = chargeTotalCents - applicationFee - (labelCents ?? 0);

  return {
    orderRef: input.orderRef,
    soldAt: input.soldAt,
    grossCents,
    dripFeeCents,
    dripFeeRatePct,
    processingCents,
    shippingChargedCents,
    labelCents,
    netCents,
    chargeTotalCents,
    applicationFeeCents: applicationFee,
    absorbedByDripCents,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   REFUNDS AND DISPUTES — the part sellers learn by surprise
   ═══════════════════════════════════════════════════════════════════════════ */

export type ReversalKind = 'refund' | 'dispute';

export type ReversalInput = {
  kind: ReversalKind;
  /** The order as it settled, from {@link buildOrderEarnings}. */
  order: OrderEarnings;
  /** Item cents handed back. Equal to `order.grossCents` on a full refund. */
  refundedItemCents: number;
  /** Shipping cents handed back. */
  refundedShippingCents: number;
  /**
   * Stripe's flat dispute fee, when Stripe has told us what it was. `null`
   * means we do not know — Stripe sets this number, spec 7.6 does not, and a
   * guessed figure on a money screen is worse than an honest blank.
   */
  disputeFeeCents?: number | null;
};

export type ReversalBreakdown = {
  kind: ReversalKind;
  orderRef: string;
  /** Total handed back to the buyer, items plus shipping. */
  refundedCents: number;
  /** Drip's commission on the refunded items, returned to the seller. */
  dripFeeReturnedCents: number;
  /** Drip's commission on whatever the buyer kept. */
  dripFeeKeptCents: number;
  /**
   * Stripe's processing fee on the original charge. NOT returned — not on a
   * partial refund, not on a full one. This is the line sellers dispute and
   * the one the screen has to state plainly.
   */
  processingKeptCents: number;
  /** The label, if one was bought. Already spent; a refund does not unprint it. */
  labelCents: number | null;
  disputeFeeCents: number | null;
  /**
   * What the seller is left holding once the reversal settles.
   *
   * On a FULL refund this is exactly `-(processingKeptCents + labelCents)` —
   * a negative number. The seller is out of pocket on a sale they made and
   * then unmade, and no amount of interface design changes that; the only
   * choice is whether they find out here or from a bank statement.
   */
  netCents: number;
  isFull: boolean;
};

/**
 * What a refund or a dispute does to one order.
 *
 * The commission split is computed on what the buyer KEPT and the returned
 * share taken as the residual, so a partial refund can never invent or lose a
 * cent of commission no matter how the pro-rata lands.
 */
export function summarizeReversal(input: ReversalInput): ReversalBreakdown {
  const { order, kind } = input;

  const refundedItemCents = clamp(intCents(input.refundedItemCents), 0, order.grossCents);
  const refundedShippingCents = clamp(
    intCents(input.refundedShippingCents),
    0,
    order.shippingChargedCents
  );
  const refundedCents = refundedItemCents + refundedShippingCents;

  const keptItemCents = order.grossCents - refundedItemCents;
  const dripFeeKeptCents = Math.min(
    order.dripFeeCents,
    dripCommissionCents(keptItemCents, order.dripFeeRatePct)
  );
  const dripFeeReturnedCents = order.dripFeeCents - dripFeeKeptCents;

  const disputeFeeCents =
    kind === 'dispute'
      ? typeof input.disputeFeeCents === 'number' && Number.isFinite(input.disputeFeeCents)
        ? Math.max(0, intCents(input.disputeFeeCents))
        : null
      : null;

  const netCents =
    order.netCents - refundedCents + dripFeeReturnedCents - (disputeFeeCents ?? 0);

  return {
    kind,
    orderRef: order.orderRef,
    refundedCents,
    dripFeeReturnedCents,
    dripFeeKeptCents,
    processingKeptCents: order.processingCents,
    labelCents: order.labelCents,
    disputeFeeCents,
    netCents,
    isFull: order.chargeTotalCents > 0 && refundedCents >= order.chargeTotalCents,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   AGGREGATES AND LABELS
   ═══════════════════════════════════════════════════════════════════════════ */

export function sumNetCents(rows: readonly { netCents: number }[]): number {
  return rows.reduce((total, row) => total + intCents(row.netCents), 0);
}

export function sumGrossCents(rows: readonly { grossCents: number }[]): number {
  return rows.reduce((total, row) => total + intCents(row.grossCents), 0);
}

export function sumDripFeeCents(rows: readonly { dripFeeCents: number }[]): number {
  return rows.reduce((total, row) => total + intCents(row.dripFeeCents), 0);
}

export function sumProcessingCents(rows: readonly { processingCents: number }[]): number {
  return rows.reduce((total, row) => total + intCents(row.processingCents), 0);
}

/**
 * A short, stable, sayable reference for one order.
 *
 * A seller emailing support should not have to read out a uuid, and the raw
 * id is also the thing an attacker would enumerate. Six hex characters from
 * the front of the id give 16.7M values — plenty to disambiguate one seller's
 * orders, and the full id is still the key everywhere it matters.
 *
 *   orderRefFor('4f2a9c1e-7b3d-...') -> "#DRP-4F2A9C"
 */
export function orderRefFor(orderId: string | null | undefined): string {
  const hex = (orderId ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return `#DRP-${hex.slice(0, 6).padEnd(6, '0')}`;
}
