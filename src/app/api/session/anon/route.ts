import { NextRequest, NextResponse } from 'next/server';
import { mintAnonId } from '@/lib/anon-id';
import { resolveSignedAnonId } from '@/lib/anon-request';
import { rateLimit, clientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Issues a signed viewer identity to a client with no cookie jar (the native
 * app), which then sends it as `x-drip-anon-token`. It is the same value the
 * proxy puts in the `drip_aid` cookie for browsers.
 *
 * This grants nothing a browser cannot already get: the proxy mints a fresh
 * signed id for any cookie-less request to /feed. The per-IP limit here is
 * tighter than that path's, because an app installs once and keeps its token
 * in the Keychain — a client asking repeatedly is not an app.
 *
 * A client that already holds a valid token gets the same identity back, so
 * a retried launch never forks a device into two viewers.
 */
export async function POST(request: NextRequest) {
  const existing = await resolveSignedAnonId(request);
  if (existing) {
    const token = request.headers.get('x-drip-anon-token') ?? null;
    if (token) return NextResponse.json({ anonId: existing, token });
  }

  if (!rateLimit(`anon-mint:${clientIp(request)}`, 10, 60 * 60_000)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const minted = await mintAnonId();
  if (!minted) {
    // ANON_ID_SECRET unset: same fail-closed-on-trust posture as the proxy.
    return NextResponse.json({ error: 'Viewer identity is not configured' }, { status: 503 });
  }

  return NextResponse.json(
    { anonId: minted.anonId, token: minted.cookieValue },
    { headers: { 'Cache-Control': 'private, no-store' } }
  );
}
