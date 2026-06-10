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

// Platform fee in basis points. 0 at launch (founding seller program);
// flip to 800 (8%) later without touching checkout code.
export const APPLICATION_FEE_BPS = 0;

export function applicationFeeAmount(subtotalCents: number): number {
  return Math.round((subtotalCents * APPLICATION_FEE_BPS) / 10000);
}
