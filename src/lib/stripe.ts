import Stripe from 'stripe';

let stripeClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2023-10-16',
      typescript: true,
    });
  }
  return stripeClient;
}

// Fee model (see README "How Drip makes money"):
//
//   application_fee_amount = Drip commission + Stripe processing passthrough
//
// - DRIP_FEE_BPS is Drip's commission on the (discounted) item price.
//   0 during the founding-seller program; flip to 800 (8%) after validation.
// - The processing passthrough (2.9% + 30c on the full charge) is always
//   included: on destination charges Stripe debits its fee from the
//   PLATFORM balance, so without the passthrough Drip would subsidize
//   card processing on every founding-seller sale. Marketed honestly as
//   "0% Drip commission" — sellers pay card processing, like anywhere.
export const DRIP_FEE_BPS = 0;

const STRIPE_FEE_BPS = 290; // 2.9%
const STRIPE_FEE_FIXED_CENTS = 30;

export function applicationFeeAmount(
  itemCents: number,
  chargeTotalCents: number
): number {
  const commission = Math.round((itemCents * DRIP_FEE_BPS) / 10000);
  const processing =
    Math.round((chargeTotalCents * STRIPE_FEE_BPS) / 10000) + STRIPE_FEE_FIXED_CENTS;
  // Application fee can never exceed the charge itself (e.g. a heavily
  // discounted cheap item).
  return Math.min(commission + processing, chargeTotalCents);
}
