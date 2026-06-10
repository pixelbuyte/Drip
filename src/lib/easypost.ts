import crypto from 'crypto';
import type { FromAddress } from './validation';

const EASYPOST_API = 'https://api.easypost.com/v2';

type Parcel = { length_in: number; width_in: number; height_in: number; weight_oz: number };

export type ShippingAddress = {
  name: string | null;
  street1: string | null;
  street2?: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
};

export type PurchasedLabel = {
  shipment_id: string;
  tracking_code: string;
  label_url: string;
  carrier: string;
  service: string;
  rate_cents: number;
};

async function easypostFetch(path: string, body: unknown) {
  const apiKey = process.env.EASYPOST_API_KEY;
  if (!apiKey) throw new Error('EASYPOST_API_KEY not configured');

  const res = await fetch(`${EASYPOST_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`EasyPost ${path} failed: ${JSON.stringify(data.error ?? data)}`);
  }
  return data;
}

// Creates a shipment and buys the cheapest USPS rate as a PDF label.
export async function buyLabel(
  from: FromAddress,
  to: ShippingAddress,
  parcel: Parcel
): Promise<PurchasedLabel> {
  const shipment = await easypostFetch('/shipments', {
    shipment: {
      from_address: {
        name: from.name,
        street1: from.street1,
        street2: from.street2 ?? undefined,
        city: from.city,
        state: from.state,
        zip: from.zip,
        country: 'US',
      },
      to_address: {
        name: to.name ?? undefined,
        street1: to.street1,
        street2: to.street2 ?? undefined,
        city: to.city,
        state: to.state,
        zip: to.zip,
        country: 'US',
      },
      parcel: {
        length: parcel.length_in,
        width: parcel.width_in,
        height: parcel.height_in,
        weight: parcel.weight_oz,
      },
      options: { label_format: 'PDF' },
    },
  });

  const uspsRates = (shipment.rates ?? [])
    .filter((r: { carrier: string }) => r.carrier === 'USPS')
    .sort(
      (a: { rate: string }, b: { rate: string }) => parseFloat(a.rate) - parseFloat(b.rate)
    );

  if (uspsRates.length === 0) {
    throw new Error(`No USPS rates returned for shipment ${shipment.id}`);
  }

  const bought = await easypostFetch(`/shipments/${shipment.id}/buy`, {
    rate: { id: uspsRates[0].id },
  });

  return {
    shipment_id: bought.id,
    tracking_code: bought.tracking_code,
    label_url:
      bought.postage_label?.label_pdf_url ?? bought.postage_label?.label_url ?? '',
    carrier: bought.selected_rate?.carrier ?? 'USPS',
    service: bought.selected_rate?.service ?? '',
    rate_cents: Math.round(parseFloat(bought.selected_rate?.rate ?? '0') * 100),
  };
}

// EasyPost signs webhooks with HMAC-SHA256 of the raw body, delivered as
// "hmac-sha256-hex=<hex>" in the X-Hmac-Signature header.
export function verifyEasyPostSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader) return false;

  const expected = `hmac-sha256-hex=${crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex')}`;

  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');
  return (
    expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf)
  );
}
