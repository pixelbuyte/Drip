import { describe, expect, it } from 'vitest';
import {
  FEE_RATES,
  applicationFeeCents,
  bpsOf,
  buildOrderEarnings,
  dripCommissionCents,
  effectiveDripRatePct,
  orderRefFor,
  processingFeeCents,
  summarizeReversal,
  sumDripFeeCents,
  sumGrossCents,
  sumNetCents,
  sumProcessingCents,
  toBps,
  volumeTierProgress,
  type OrderEarnings,
  type OrderEarningsInput,
} from '../earnings';

/**
 * Money tests. These are not smoke tests — every assertion below is a cent
 * that ends up in someone's bank account, so they are written as exact
 * equalities against hand-computed values, never as `toBeCloseTo`.
 */

const SPEC_ORDER: OrderEarningsInput = {
  orderRef: '#DRP-8K2LM',
  soldAt: '2026-08-14T10:04:00Z',
  itemSubtotalCents: 9_600,
  shippingChargedCents: 599,
  labelCents: 542,
  dripRatePct: FEE_RATES.foundingDripPct,
};

/* ═══════════════════════════════════════════════════════════════════════════
   RATE CONVERSION — the float trap
   ═══════════════════════════════════════════════════════════════════════════ */

describe('toBps', () => {
  // `x * 100` is not exact for every two-decimal rate. Truncating instead of
  // rounding would bill 4.34% where policy says 4.35% — a cent lost on every
  // order, silently, forever.
  it('survives the floating-point trap in percent-to-bps', () => {
    expect(4.35 * 100).not.toBe(435); // the trap itself, so it cannot be "fixed" away
    expect(Math.trunc(4.35 * 100)).toBe(434); // what the naive version would bill
    expect(toBps(4.35)).toBe(435);
  });

  // The rates this module DERIVES are arbitrary reals, and they get fed back
  // in by summarizeReversal, so the conversion has to hold for them too.
  it('converts a derived effective rate without dropping a basis point', () => {
    const effective = (500 / 9_600) * 100; // 5.208333...%
    expect(toBps(effective)).toBe(521);
    expect(bpsOf(9_600, toBps(effective))).toBe(500); // round-trips to the cent
  });

  it('converts every rate the product uses', () => {
    expect(toBps(0)).toBe(0);
    expect(toBps(4)).toBe(400);
    expect(toBps(6)).toBe(600);
    expect(toBps(8)).toBe(800);
  });

  it('is 0 for nonsense rather than NaN', () => {
    expect(toBps(Number.NaN)).toBe(0);
    expect(toBps(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('bpsOf', () => {
  it('rounds half AWAY FROM ZERO, in both directions', () => {
    // 500c at 290bps is exactly 14.5.
    expect(bpsOf(500, 290)).toBe(15);
    // Math.round(-14.5) is -14. That asymmetry is the bug this guards.
    expect(bpsOf(-500, 290)).toBe(-15);
    expect(bpsOf(-500, 290)).toBe(-bpsOf(500, 290));
  });

  it('stays exact at the largest amounts this product will see', () => {
    // $10,000 at 8% — the multiply happens before the divide, so no float slop.
    expect(bpsOf(1_000_000, 800)).toBe(80_000);
    expect(Number.isSafeInteger(1_000_000 * 800)).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PROCESSING — 2.9% + 30c
   ═══════════════════════════════════════════════════════════════════════════ */

describe('processingFeeCents', () => {
  it('is exact at the amounts that matter', () => {
    expect(processingFeeCents(1)).toBe(30); // $0.01  -> 0.029c rounds to 0, + 30c
    expect(processingFeeCents(100)).toBe(33); // $1.00  -> 2.9c rounds to 3, + 30c
    expect(processingFeeCents(9_600)).toBe(308); // $96.00 -> 278.4 rounds to 278, + 30c
    expect(processingFeeCents(1_000_000)).toBe(29_030); // $10,000 -> 29,000 + 30c
  });

  it('rounds a dead-half up', () => {
    // 500 * 290 / 10000 === 14.5 exactly. Half away from zero -> 15.
    expect(processingFeeCents(500)).toBe(45);
  });

  it('charges nothing on a zero charge — there is no card transaction', () => {
    expect(processingFeeCents(0)).toBe(0);
    expect(processingFeeCents(-100)).toBe(0);
  });

  it('always returns whole cents', () => {
    for (let cents = 0; cents <= 2_000; cents += 7) {
      expect(Number.isInteger(processingFeeCents(cents))).toBe(true);
    }
  });

  it('is monotonic — a bigger charge never costs less to process', () => {
    let previous = -1;
    for (let cents = 1; cents <= 500_000; cents += 997) {
      const fee = processingFeeCents(cents);
      expect(fee).toBeGreaterThanOrEqual(previous);
      previous = fee;
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   COMMISSION — 6% founding vs 8% standard
   ═══════════════════════════════════════════════════════════════════════════ */

describe('dripCommissionCents', () => {
  it('bills the founding rate and the standard rate differently on the same order', () => {
    expect(dripCommissionCents(9_600, FEE_RATES.foundingDripPct)).toBe(576); // $5.76
    expect(dripCommissionCents(9_600, FEE_RATES.standardDripPct)).toBe(768); // $7.68
    // The whole retention argument, in one number: $1.92 an order.
    expect(
      dripCommissionCents(9_600, FEE_RATES.standardDripPct) -
        dripCommissionCents(9_600, FEE_RATES.foundingDripPct)
    ).toBe(192);
  });

  it('never charges commission on shipping — the base is items only', () => {
    // Same items, wildly different shipping: identical commission.
    expect(dripCommissionCents(9_600, 6)).toBe(dripCommissionCents(9_600, 6));
    const order = buildOrderEarnings({ ...SPEC_ORDER, shippingChargedCents: 4_000 });
    expect(order.dripFeeCents).toBe(576);
  });

  it('is 0 at a 0% rate and on a 0 base', () => {
    expect(dripCommissionCents(9_600, 0)).toBe(0);
    expect(dripCommissionCents(0, 8)).toBe(0);
  });

  it('rounds a fractional cent half away from zero', () => {
    // 999c at 6% is 59.94 -> 60.
    expect(dripCommissionCents(999, 6)).toBe(60);
    // 125c at 4% is exactly 5.
    expect(dripCommissionCents(125, 4)).toBe(5);
    // 625c at 8% is exactly 50.
    expect(dripCommissionCents(625, 8)).toBe(50);
  });
});

describe('applicationFeeCents', () => {
  it('matches the sum of its two parts on an ordinary order', () => {
    // $96.00 items + $5.99 shipping = $101.99 charged.
    expect(applicationFeeCents(9_600, 10_199, 6)).toBe(576 + 326);
  });

  it('can never exceed the charge itself', () => {
    // 1c order: 30c of processing is more than the whole charge.
    expect(applicationFeeCents(1, 1, 6)).toBe(1);
    expect(applicationFeeCents(0, 0, 6)).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE ORDER BREAKDOWN
   ═══════════════════════════════════════════════════════════════════════════ */

describe('buildOrderEarnings — spec 7.6 worked example', () => {
  const order = buildOrderEarnings(SPEC_ORDER);

  it('reproduces every line of the spec block', () => {
    expect(order.grossCents).toBe(9_600); // Order  ............  $96.00
    expect(order.dripFeeCents).toBe(576); //   Drip fee (6%)  ...  -$5.76
    expect(order.dripFeeRatePct).toBe(6);
    expect(order.shippingChargedCents).toBe(599); //   Shipping  .....  +$5.99
    expect(order.labelCents).toBe(542); //   Label  .........  -$5.42
  });

  it('bills Stripe on the full charge, not on the items alone', () => {
    // Spec 7.6 quotes -$3.08, which is 2.9% of the $96.00 item price + 30c.
    // Stripe bills on what the card was actually charged — $101.99 — so the
    // real figure is $3.26. The spec's own primitive still holds exactly:
    expect(processingFeeCents(order.grossCents)).toBe(308);
    // ...but the money that actually moved is this one, and this screen must
    // agree with the seller's Stripe dashboard, not with the illustration.
    expect(order.chargeTotalCents).toBe(10_199);
    expect(order.processingCents).toBe(326);
  });

  it('leaves the seller $87.55', () => {
    // $101.99 charged - $5.76 commission - $3.26 processing - $5.42 label.
    // (The spec's illustration says $87.73; the 18c is the shipping that its
    // processing base left out.)
    expect(order.netCents).toBe(8_755);
  });

  it('holds the contract identity exactly', () => {
    expect(order.netCents).toBe(
      order.grossCents +
        order.shippingChargedCents -
        order.dripFeeCents -
        order.processingCents -
        (order.labelCents ?? 0)
    );
  });
});

describe('buildOrderEarnings — founding vs standard on the same order', () => {
  const founding = buildOrderEarnings({ ...SPEC_ORDER, dripRatePct: 6 });
  const standard = buildOrderEarnings({ ...SPEC_ORDER, dripRatePct: 8 });

  it('charges the founding seller $1.92 less and hands it straight to them', () => {
    expect(standard.dripFeeCents - founding.dripFeeCents).toBe(192);
    expect(founding.netCents - standard.netCents).toBe(192);
  });

  it('changes nothing else — processing and label are rate-independent', () => {
    expect(founding.processingCents).toBe(standard.processingCents);
    expect(founding.labelCents).toBe(standard.labelCents);
    expect(founding.chargeTotalCents).toBe(standard.chargeTotalCents);
  });
});

describe('buildOrderEarnings — shipping against the real label cost', () => {
  it('keeps the difference when the buyer overpaid for shipping', () => {
    const order = buildOrderEarnings({
      ...SPEC_ORDER,
      shippingChargedCents: 999,
      labelCents: 542,
    });
    // Charged $9.99, label cost $5.42: $4.57 stays with the seller, minus the
    // processing on the extra shipping.
    expect(order.chargeTotalCents).toBe(10_599);
    expect(order.processingCents).toBe(337); // round(307.371) + 30
    expect(order.netCents).toBe(10_599 - 576 - 337 - 542);
    expect(order.netCents).toBe(9_144);
  });

  it('eats the difference when the label cost more than the buyer paid', () => {
    const order = buildOrderEarnings({
      ...SPEC_ORDER,
      shippingChargedCents: 400,
      labelCents: 1_250,
    });
    expect(order.chargeTotalCents).toBe(10_000);
    expect(order.processingCents).toBe(320); // round(290) + 30
    expect(order.netCents).toBe(10_000 - 576 - 320 - 1_250);
    expect(order.netCents).toBe(7_854);
    // Still positive here, but strictly worse than break-even shipping.
    const breakEven = buildOrderEarnings({
      ...SPEC_ORDER,
      shippingChargedCents: 400,
      labelCents: 400,
    });
    expect(order.netCents).toBeLessThan(breakEven.netCents);
    expect(breakEven.netCents - order.netCents).toBe(850);
  });

  it('treats an unbought label as unknown, not as free', () => {
    const order = buildOrderEarnings({ ...SPEC_ORDER, labelCents: null });
    expect(order.labelCents).toBeNull(); // renders as an em dash, never $0.00
    expect(order.netCents).toBe(9_297); // arithmetic still treats it as 0
    const free = buildOrderEarnings({ ...SPEC_ORDER, labelCents: 0 });
    expect(free.netCents).toBe(order.netCents);
    expect(free.labelCents).toBe(0); // ...but the two render differently
  });
});

describe('buildOrderEarnings — the tiny orders', () => {
  it('handles a zero order without inventing a 30c fee', () => {
    const order = buildOrderEarnings({
      ...SPEC_ORDER,
      itemSubtotalCents: 0,
      shippingChargedCents: 0,
      labelCents: null,
    });
    expect(order.chargeTotalCents).toBe(0);
    expect(order.processingCents).toBe(0);
    expect(order.dripFeeCents).toBe(0);
    expect(order.applicationFeeCents).toBe(0);
    expect(order.netCents).toBe(0);
    expect(order.absorbedByDripCents).toBe(0);
  });

  it('never pushes a 1c order negative — Drip absorbs the rest of the card fee', () => {
    const order = buildOrderEarnings({
      ...SPEC_ORDER,
      itemSubtotalCents: 1,
      shippingChargedCents: 0,
      labelCents: null,
    });
    expect(order.chargeTotalCents).toBe(1);
    expect(order.dripFeeCents).toBe(0); // 6% of 1c rounds to nothing
    expect(order.processingCents).toBe(1); // capped at the charge
    expect(order.absorbedByDripCents).toBe(29); // Drip eats the other 29c
    expect(order.netCents).toBe(0); // NOT -29c
    expect(order.applicationFeeCents).toBeLessThanOrEqual(order.chargeTotalCents);
  });

  it('stops absorbing once the charge covers the fee', () => {
    // 31c items: 31c processing + 2c commission = 33c > 31c, so 2c is absorbed.
    const capped = buildOrderEarnings({
      ...SPEC_ORDER,
      itemSubtotalCents: 31,
      shippingChargedCents: 0,
      labelCents: null,
    });
    expect(capped.processingCents).toBe(29);
    expect(capped.absorbedByDripCents).toBe(2);
    expect(capped.netCents).toBe(0);
    // 40c items: 31c processing + 2c commission = 33c, comfortably inside.
    const fine = buildOrderEarnings({
      ...SPEC_ORDER,
      itemSubtotalCents: 40,
      shippingChargedCents: 0,
      labelCents: null,
    });
    expect(fine.absorbedByDripCents).toBe(0);
    expect(fine.processingCents).toBe(31);
    expect(fine.dripFeeCents).toBe(2);
    expect(fine.netCents).toBe(7);
  });
});

describe('buildOrderEarnings — the recorded fee wins', () => {
  it('derives the split from what Stripe actually took', () => {
    const order = buildOrderEarnings({
      ...SPEC_ORDER,
      recordedApplicationFeeCents: 326, // founding program: 0% commission
    });
    expect(order.applicationFeeCents).toBe(326);
    expect(order.processingCents).toBe(326);
    expect(order.dripFeeCents).toBe(0);
    expect(order.dripFeeRatePct).toBe(0); // shows what was charged, not policy
    expect(order.netCents).toBe(10_199 - 326 - 542);
  });

  it('keeps the clean policy rate when the recorded fee matches it exactly', () => {
    const order = buildOrderEarnings({
      ...SPEC_ORDER,
      recordedApplicationFeeCents: 576 + 326,
    });
    expect(order.dripFeeCents).toBe(576);
    expect(order.dripFeeRatePct).toBe(6); // not 5.9999999
  });

  it('reports the effective rate when the recorded fee matches no policy rate', () => {
    const order = buildOrderEarnings({
      ...SPEC_ORDER,
      recordedApplicationFeeCents: 326 + 500,
    });
    expect(order.dripFeeCents).toBe(500);
    expect(order.dripFeeRatePct).toBeCloseTo(5.2083, 4);
  });

  it('clamps a corrupt recorded fee rather than reporting a negative net', () => {
    const order = buildOrderEarnings({
      ...SPEC_ORDER,
      labelCents: null,
      recordedApplicationFeeCents: 999_999,
    });
    expect(order.applicationFeeCents).toBe(10_199);
    expect(order.netCents).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE EXHAUSTIVE ARITHMETIC SWEEP
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A fixed, hand-written spread of amounts: every carry boundary, every
 * rounding edge found above, the cheap end, and the expensive end. Fixed
 * literals rather than a generator — a money test that produces different
 * cases on different runs cannot be bisected when it fails.
 */
const AMOUNTS_CENTS = [
  0, 1, 2, 3, 5, 7, 9, 10, 17, 25, 29, 30, 31, 32, 33, 40, 49, 50, 51, 66, 75, 83, 99,
  100, 101, 111, 125, 149, 199, 250, 299, 333, 350, 399, 449, 499, 500, 501, 555, 599,
  625, 699, 750, 799, 833, 899, 999, 1_000, 1_001, 1_250, 1_499, 1_667, 1_999, 2_499,
  2_500, 2_501, 3_333, 4_999, 5_000, 5_001, 6_666, 7_499, 8_333, 9_599, 9_600, 9_601,
  12_500, 19_999, 25_000, 33_333, 49_999, 50_000, 66_667, 99_999, 100_000, 100_001,
  249_999, 500_000, 833_333, 999_999, 1_000_000,
] as const;

const SHIPPINGS_CENTS = [0, 1, 399, 599, 1_299] as const;
const LABELS_CENTS = [null, 0, 1, 542, 1_800] as const;
const RATES_PCT = [0, 4, 6, 8] as const;

describe('the arithmetic never loses or invents a cent', () => {
  it('holds the contract identity for every combination', () => {
    let checked = 0;

    for (const gross of AMOUNTS_CENTS) {
      for (const shipping of SHIPPINGS_CENTS) {
        for (const label of LABELS_CENTS) {
          for (const rate of RATES_PCT) {
            const order = buildOrderEarnings({
              orderRef: '#DRP-000001',
              soldAt: '2026-08-01T00:00:00Z',
              itemSubtotalCents: gross,
              shippingChargedCents: shipping,
              labelCents: label,
              dripRatePct: rate,
            });
            const where = `gross=${gross} ship=${shipping} label=${label} rate=${rate}`;

            // 1. Every figure is a whole number of cents.
            for (const value of [
              order.grossCents,
              order.shippingChargedCents,
              order.dripFeeCents,
              order.processingCents,
              order.netCents,
              order.chargeTotalCents,
              order.applicationFeeCents,
              order.absorbedByDripCents,
            ]) {
              expect(Number.isInteger(value), `${where}: ${value} is not an integer`).toBe(true);
            }
            if (order.labelCents !== null) expect(Number.isInteger(order.labelCents)).toBe(true);

            // 2. The identity from `types.ts`, exactly.
            expect(order.netCents, where).toBe(
              order.grossCents +
                order.shippingChargedCents -
                order.dripFeeCents -
                order.processingCents -
                (order.labelCents ?? 0)
            );

            // 3. The same identity said the other way: the parts of the
            //    application fee sum to the whole application fee.
            expect(order.applicationFeeCents, where).toBe(
              order.dripFeeCents + order.processingCents
            );
            expect(order.netCents, where).toBe(
              order.chargeTotalCents - order.applicationFeeCents - (order.labelCents ?? 0)
            );

            // 4. Nothing is charged that the buyer did not pay.
            expect(order.chargeTotalCents, where).toBe(gross + shipping);
            expect(order.applicationFeeCents, where).toBeLessThanOrEqual(order.chargeTotalCents);
            expect(order.dripFeeCents, where).toBeGreaterThanOrEqual(0);
            expect(order.processingCents, where).toBeGreaterThanOrEqual(0);

            // 5. Before the label, the seller is never underwater.
            expect(order.netCents + (order.labelCents ?? 0), where).toBeGreaterThanOrEqual(0);

            checked += 1;
          }
        }
      }
    }

    expect(checked).toBe(
      AMOUNTS_CENTS.length * SHIPPINGS_CENTS.length * LABELS_CENTS.length * RATES_PCT.length
    );
  });

  it('is deterministic — the same input is the same cents, every time', () => {
    for (const gross of AMOUNTS_CENTS) {
      const input = {
        orderRef: '#DRP-000001',
        soldAt: '2026-08-01T00:00:00Z',
        itemSubtotalCents: gross,
        shippingChargedCents: 599,
        labelCents: 542,
        dripRatePct: 6,
      };
      expect(buildOrderEarnings(input)).toEqual(buildOrderEarnings(input));
    }
  });

  it('sums a month of orders without drift', () => {
    const orders = AMOUNTS_CENTS.map((gross, index) =>
      buildOrderEarnings({
        orderRef: `#DRP-${String(index).padStart(6, '0')}`,
        soldAt: '2026-08-01T00:00:00Z',
        itemSubtotalCents: gross,
        shippingChargedCents: 599,
        labelCents: 542,
        dripRatePct: 6,
      })
    );

    const labels = orders.reduce((total, o) => total + (o.labelCents ?? 0), 0);
    const shipping = orders.reduce((total, o) => total + o.shippingChargedCents, 0);

    expect(sumNetCents(orders)).toBe(
      sumGrossCents(orders) +
        shipping -
        sumDripFeeCents(orders) -
        sumProcessingCents(orders) -
        labels
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   REFUNDS — where the seller finds out about Stripe
   ═══════════════════════════════════════════════════════════════════════════ */

function specOrder(overrides: Partial<typeof SPEC_ORDER> = {}): OrderEarnings {
  return buildOrderEarnings({ ...SPEC_ORDER, ...overrides });
}

describe('summarizeReversal — a full refund', () => {
  const order = specOrder({ labelCents: null });
  const refund = summarizeReversal({
    kind: 'refund',
    order,
    refundedItemCents: order.grossCents,
    refundedShippingCents: order.shippingChargedCents,
  });

  it('hands the buyer back every cent they paid', () => {
    expect(refund.refundedCents).toBe(10_199);
    expect(refund.isFull).toBe(true);
  });

  it('returns Drip’s commission in full', () => {
    expect(refund.dripFeeReturnedCents).toBe(576);
    expect(refund.dripFeeKeptCents).toBe(0);
  });

  // THE ASSERTION SELLERS DISPUTE. Stripe does not give back its 2.9% + 30c
  // when a charge is refunded. The seller sold nothing, was paid nothing, and
  // is still out the card fee.
  it('leaves the seller NEGATIVE, by exactly Stripe’s processing fee', () => {
    expect(refund.processingKeptCents).toBe(326);
    expect(refund.netCents).toBe(-326);
    expect(refund.netCents).toBeLessThan(0);
    expect(refund.netCents).toBe(-refund.processingKeptCents);
  });

  it('is worse still once a label has been bought', () => {
    const withLabel = specOrder();
    const refunded = summarizeReversal({
      kind: 'refund',
      order: withLabel,
      refundedItemCents: withLabel.grossCents,
      refundedShippingCents: withLabel.shippingChargedCents,
    });
    // -$3.26 of card processing, plus a $5.42 label that a refund does not unprint.
    expect(refunded.netCents).toBe(-868);
    expect(refunded.netCents).toBe(-(refunded.processingKeptCents + (refunded.labelCents ?? 0)));
  });

  it('holds for every amount, not just this one', () => {
    for (const gross of AMOUNTS_CENTS) {
      const o = specOrder({ itemSubtotalCents: gross, labelCents: null });
      const r = summarizeReversal({
        kind: 'refund',
        order: o,
        refundedItemCents: o.grossCents,
        refundedShippingCents: o.shippingChargedCents,
      });
      expect(r.netCents, `gross=${gross}`).toBe(-o.processingCents);
      if (o.processingCents > 0) expect(r.netCents, `gross=${gross}`).toBeLessThan(0);
    }
  });
});

describe('summarizeReversal — a partial refund', () => {
  const order = specOrder(); // $96.00 + $5.99 shipping, $5.42 label, 6%
  const refund = summarizeReversal({
    kind: 'refund',
    order,
    refundedItemCents: 3_000, // $30.00 back, shipping kept
    refundedShippingCents: 0,
  });

  it('returns commission only on the refunded items', () => {
    expect(refund.refundedCents).toBe(3_000);
    expect(refund.dripFeeKeptCents).toBe(396); // 6% of the $66.00 kept
    expect(refund.dripFeeReturnedCents).toBe(180); // 6% of the $30.00 returned
    expect(refund.isFull).toBe(false);
  });

  it('splits the commission without inventing or losing a cent', () => {
    expect(refund.dripFeeKeptCents + refund.dripFeeReturnedCents).toBe(order.dripFeeCents);
  });

  it('still keeps Stripe’s fee on the ORIGINAL charge, in full', () => {
    expect(refund.processingKeptCents).toBe(order.processingCents);
    expect(refund.processingKeptCents).toBe(326);
  });

  it('leaves the seller with what they kept, minus the untouched fees', () => {
    // $87.55 net - $30.00 returned + $1.80 commission back.
    expect(refund.netCents).toBe(8_755 - 3_000 + 180);
    expect(refund.netCents).toBe(5_935);
  });

  it('never drifts across a full sweep of partial amounts', () => {
    for (const gross of AMOUNTS_CENTS) {
      const o = specOrder({ itemSubtotalCents: gross });
      for (const fraction of [0, 1, 3, 7, 13, 50, 99]) {
        const refundedItemCents = Math.min(o.grossCents, Math.floor((o.grossCents * fraction) / 100));
        const r = summarizeReversal({
          kind: 'refund',
          order: o,
          refundedItemCents,
          refundedShippingCents: 0,
        });
        const where = `gross=${gross} pct=${fraction}`;
        expect(r.dripFeeKeptCents + r.dripFeeReturnedCents, where).toBe(o.dripFeeCents);
        expect(r.dripFeeReturnedCents, where).toBeGreaterThanOrEqual(0);
        expect(r.dripFeeKeptCents, where).toBeGreaterThanOrEqual(0);
        expect(r.netCents, where).toBe(o.netCents - r.refundedCents + r.dripFeeReturnedCents);
        expect(Number.isInteger(r.netCents), where).toBe(true);
      }
    }
  });

  it('clamps a refund larger than the order rather than paying the buyer twice', () => {
    const r = summarizeReversal({
      kind: 'refund',
      order,
      refundedItemCents: 999_999,
      refundedShippingCents: 999_999,
    });
    expect(r.refundedCents).toBe(order.chargeTotalCents);
    expect(r.isFull).toBe(true);
  });
});

describe('summarizeReversal — a dispute', () => {
  const order = specOrder();

  it('never guesses Stripe’s dispute fee', () => {
    const d = summarizeReversal({
      kind: 'dispute',
      order,
      refundedItemCents: order.grossCents,
      refundedShippingCents: order.shippingChargedCents,
    });
    expect(d.disputeFeeCents).toBeNull(); // renders as "—", not as $0.00
    expect(d.netCents).toBe(-868); // same shape as a lost full refund
  });

  it('subtracts the dispute fee once Stripe has told us what it was', () => {
    const d = summarizeReversal({
      kind: 'dispute',
      order,
      refundedItemCents: order.grossCents,
      refundedShippingCents: order.shippingChargedCents,
      disputeFeeCents: 1_500,
    });
    expect(d.disputeFeeCents).toBe(1_500);
    expect(d.netCents).toBe(-868 - 1_500);
  });

  it('ignores a dispute fee passed on a refund — refunds do not have one', () => {
    const r = summarizeReversal({
      kind: 'refund',
      order,
      refundedItemCents: order.grossCents,
      refundedShippingCents: order.shippingChargedCents,
      disputeFeeCents: 1_500,
    });
    expect(r.disputeFeeCents).toBeNull();
    expect(r.netCents).toBe(-868);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   VOLUME TIERS
   ═══════════════════════════════════════════════════════════════════════════ */

describe('effectiveDripRatePct', () => {
  it('starts a standard seller at 8% and a founding seller at 6%', () => {
    expect(effectiveDripRatePct({ isFounding: false, monthGrossCents: 0 })).toBe(8);
    expect(effectiveDripRatePct({ isFounding: true, monthGrossCents: 0 })).toBe(6);
  });

  it('drops a standard seller to 6% at $1,000, exactly on the boundary', () => {
    expect(effectiveDripRatePct({ isFounding: false, monthGrossCents: 99_999 })).toBe(8);
    expect(effectiveDripRatePct({ isFounding: false, monthGrossCents: 100_000 })).toBe(6);
  });

  it('drops anyone to 4% at $5,000', () => {
    expect(effectiveDripRatePct({ isFounding: false, monthGrossCents: 499_999 })).toBe(6);
    expect(effectiveDripRatePct({ isFounding: false, monthGrossCents: 500_000 })).toBe(4);
    expect(effectiveDripRatePct({ isFounding: true, monthGrossCents: 500_000 })).toBe(4);
  });

  it('never raises a founding seller’s rate — a tier can only help', () => {
    for (const gross of AMOUNTS_CENTS) {
      expect(effectiveDripRatePct({ isFounding: true, monthGrossCents: gross })).toBeLessThanOrEqual(
        FEE_RATES.foundingDripPct
      );
    }
  });
});

describe('volumeTierProgress', () => {
  it('shows a standard seller the $1,000 / 6% tier', () => {
    const p = volumeTierProgress(68_000, false);
    expect(p).not.toBeNull();
    expect(p?.currentRatePct).toBe(8);
    expect(p?.nextRatePct).toBe(6);
    expect(p?.thresholdCents).toBe(100_000); // "$680 of $1,000 this month"
    expect(p?.remainingCents).toBe(32_000);
    expect(p?.progressPct).toBeCloseTo(68, 10);
  });

  it('skips straight to the $5,000 / 4% tier for a founding seller', () => {
    // A founding seller is already at 6%, so the 6% tier would say nothing.
    const p = volumeTierProgress(68_000, true);
    expect(p?.currentRatePct).toBe(6);
    expect(p?.nextRatePct).toBe(4);
    expect(p?.thresholdCents).toBe(500_000);
    expect(p?.remainingCents).toBe(432_000);
  });

  it('moves a standard seller on to the next tier once they cross the first', () => {
    const p = volumeTierProgress(120_000, false);
    expect(p?.currentRatePct).toBe(6);
    expect(p?.nextRatePct).toBe(4);
    expect(p?.thresholdCents).toBe(500_000);
  });

  it('is null when there is no better rate left to reach', () => {
    expect(volumeTierProgress(500_000, true)).toBeNull();
    expect(volumeTierProgress(1_000_000, false)).toBeNull();
  });

  it('starts at zero for a seller with no sales, rather than hiding the tier', () => {
    const p = volumeTierProgress(0, false);
    expect(p?.progressPct).toBe(0);
    expect(p?.remainingCents).toBe(100_000);
  });

  it('never reports a negative remainder or a progress above 100', () => {
    for (const gross of AMOUNTS_CENTS) {
      for (const founding of [true, false]) {
        const p = volumeTierProgress(gross, founding);
        if (!p) continue;
        expect(p.remainingCents).toBeGreaterThan(0);
        expect(p.progressPct).toBeGreaterThanOrEqual(0);
        expect(p.progressPct).toBeLessThanOrEqual(100);
      }
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   ODDS AND ENDS
   ═══════════════════════════════════════════════════════════════════════════ */

describe('orderRefFor', () => {
  it('makes a short, sayable reference out of a uuid', () => {
    expect(orderRefFor('4f2a9c1e-7b3d-4a5f-9c2e-1d8b6a3f0e77')).toBe('#DRP-4F2A9C');
  });

  it('is stable — the same id is always the same reference', () => {
    const id = '00b1c2d3-0000-0000-0000-000000000000';
    expect(orderRefFor(id)).toBe(orderRefFor(id));
    expect(orderRefFor(id)).toBe('#DRP-00B1C2');
  });

  it('never renders a ragged reference for a missing id', () => {
    expect(orderRefFor(null)).toBe('#DRP-000000');
    expect(orderRefFor('')).toBe('#DRP-000000');
    expect(orderRefFor('ab')).toBe('#DRP-AB0000');
  });
});

describe('sums', () => {
  it('are 0 on an empty month, not NaN', () => {
    expect(sumNetCents([])).toBe(0);
    expect(sumGrossCents([])).toBe(0);
    expect(sumDripFeeCents([])).toBe(0);
    expect(sumProcessingCents([])).toBe(0);
  });

  it('survive a corrupt row without poisoning the total', () => {
    expect(sumNetCents([{ netCents: 100 }, { netCents: Number.NaN }, { netCents: 50 }])).toBe(150);
  });
});
