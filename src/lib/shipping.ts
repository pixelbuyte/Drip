import type { FromAddress } from './validation';

type Dimensions = { length_in: number; width_in: number; height_in: number };

const EASYPOST_API = 'https://api.easypost.com/v2';

const WESTERN_STATES = new Set(['WA', 'OR', 'CA', 'NV', 'ID', 'UT', 'AZ', 'MT', 'WY', 'CO', 'NM', 'AK', 'HI']);

// Reference destinations for flat-rate estimation: rate to the far coast so
// the flat price covers the worst typical zone. Buyer address isn't known
// until Stripe Checkout completes, so the rate is estimated at session
// creation; the ~10% buffer absorbs zone variance.
const REF_EAST = { city: 'New York', state: 'NY', zip: '10001', country: 'US' };
const REF_WEST = { city: 'Los Angeles', state: 'CA', zip: '90001', country: 'US' };

// Fallback if EasyPost is unreachable: rough USPS Ground Advantage retail.
function fallbackRateCents(weightOz: number): number {
  if (weightOz <= 4) return 450;
  if (weightOz <= 8) return 550;
  if (weightOz <= 16) return 700;
  if (weightOz <= 32) return 950;
  if (weightOz <= 80) return 1250;
  return 1800;
}

export async function estimateFlatShippingCents(
  from: FromAddress,
  weightOz: number,
  dims: Dimensions
): Promise<number> {
  const apiKey = process.env.EASYPOST_API_KEY;
  if (!apiKey) return fallbackRateCents(weightOz);

  const toAddress = WESTERN_STATES.has(from.state) ? REF_EAST : REF_WEST;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(`${EASYPOST_API}/shipments`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        shipment: {
          from_address: {
            street1: from.street1,
            street2: from.street2 ?? undefined,
            city: from.city,
            state: from.state,
            zip: from.zip,
            country: 'US',
          },
          to_address: { street1: '1 Main St', ...toAddress },
          parcel: {
            length: dims.length_in,
            width: dims.width_in,
            height: dims.height_in,
            weight: weightOz,
          },
        },
      }),
    });
    clearTimeout(timeout);

    if (!res.ok) return fallbackRateCents(weightOz);

    const shipment = await res.json();
    const uspsRates = (shipment.rates ?? [])
      .filter((r: { carrier: string }) => r.carrier === 'USPS')
      .map((r: { rate: string }) => parseFloat(r.rate))
      .filter((r: number) => Number.isFinite(r) && r > 0);

    if (uspsRates.length === 0) return fallbackRateCents(weightOz);

    const cheapest = Math.min(...uspsRates);
    return Math.ceil(cheapest * 1.1 * 100);
  } catch {
    return fallbackRateCents(weightOz);
  }
}
