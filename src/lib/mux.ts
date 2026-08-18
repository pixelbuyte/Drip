import Mux from '@mux/mux-node';
import crypto from 'crypto';

let muxClient: Mux | null = null;

export function getMux(): Mux {
  if (!muxClient) {
    muxClient = new Mux({
      tokenId: process.env.MUX_TOKEN_ID!,
      tokenSecret: process.env.MUX_TOKEN_SECRET!,
    });
  }
  return muxClient;
}

export const MAX_VIDEO_SECONDS = 60;

// View counts per asset over the past 90 days via Mux Data. Best-effort:
// any failure returns 0 for that asset so the dashboard never breaks on
// analytics. Uses the video-views list endpoint's total_row_count.
export async function getAssetViewCounts(
  assetIds: string[]
): Promise<Record<string, number>> {
  const tokenId = process.env.MUX_TOKEN_ID;
  const tokenSecret = process.env.MUX_TOKEN_SECRET;
  const counts: Record<string, number> = {};
  if (!tokenId || !tokenSecret || assetIds.length === 0) return counts;

  const auth = Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64');

  await Promise.all(
    assetIds.map(async (assetId) => {
      try {
        const res = await fetch(
          `https://api.mux.com/data/v1/video-views?filters[]=${encodeURIComponent(
            `asset_id:${assetId}`
          )}&timeframe[]=90:days&limit=1`,
          { headers: { Authorization: `Basic ${auth}` } }
        );
        if (!res.ok) {
          counts[assetId] = 0;
          return;
        }
        const data = await res.json();
        counts[assetId] = data.total_row_count ?? 0;
      } catch {
        counts[assetId] = 0;
      }
    })
  );

  return counts;
}

// Verifies the Mux-Signature header: "t=<timestamp>,v1=<hmac>".
// HMAC-SHA256 of `${timestamp}.${rawBody}` with the webhook secret.
export function verifyMuxSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSeconds = 300
): boolean {
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((part) => {
      const [key, ...rest] = part.trim().split('=');
      return [key, rest.join('=')];
    })
  );

  const timestamp = parts['t'];
  const signature = parts['v1'];
  if (!timestamp || !signature) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signature, 'utf8');
  return (
    expectedBuf.length === actualBuf.length &&
    crypto.timingSafeEqual(expectedBuf, actualBuf)
  );
}
