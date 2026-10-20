import type { NextRequest } from 'next/server';
import { ANON_COOKIE, verifyAnonId } from './anon-id';

/**
 * Header carrying the same signed value the `drip_aid` cookie holds
 * (`v1.<uuid>.<hmac>`). Native clients have no cookie jar shared with the
 * proxy, so they obtain the value from POST /api/session/anon and send it
 * here instead.
 *
 * It is verified with the same HMAC as the cookie: a client still cannot
 * choose or borrow an identity, which is the property /api/events' abuse caps
 * depend on. Distinct from the legacy unsigned `x-drip-anon-id`, which the
 * proxy sets on the request it forwards and which is never trusted for writes.
 */
export const ANON_TOKEN_HEADER = 'x-drip-anon-token';

/** The cookie first (browsers), then the signed header (native). */
export async function resolveSignedAnonId(
  request: Pick<NextRequest, 'cookies' | 'headers'>
): Promise<string | null> {
  const cookie = request.cookies.get(ANON_COOKIE)?.value;
  const fromCookie = cookie ? await verifyAnonId(cookie) : null;
  if (fromCookie) return fromCookie;

  const header = request.headers.get(ANON_TOKEN_HEADER);
  if (!header || header.length > 256) return null;
  return verifyAnonId(header);
}
