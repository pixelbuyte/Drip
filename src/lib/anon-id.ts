import { randomUUID, timingSafeEqual } from 'node:crypto';

export const ANON_COOKIE = 'drip_aid';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIN_SECRET_LENGTH = 32;

/**
 * Anon identity degrades; it never takes the site down.
 *
 * This module used to throw when ANON_ID_SECRET was missing. Because the proxy
 * mints an id on every matched route — including `/` — one unset variable
 * turned a *feed-attribution* secret into a site-wide outage: 500 on the
 * marketing page, the auth pages, everything behind the matcher. That is
 * exactly what happened in production (13 middleware crashes across 4 visitors
 * before anyone noticed the page was simply gone).
 *
 * The rule now: fail CLOSED on trust, OPEN on availability.
 *   - No secret => we cannot mint a signed id, so we mint nothing.
 *   - No secret => we cannot verify a presented id, so we trust nothing.
 * A forged cookie is still never accepted — `verifyAnonId` returns null rather
 * than falling back to an unsigned comparison. The feed keeps serving; it just
 * serves without device attribution, which costs personalisation quality and
 * nothing else.
 */
export function anonSecret(): string | null {
  const secret = process.env.ANON_ID_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return secret;
}

export function isAnonIdentityConfigured(): boolean {
  return anonSecret() !== null;
}

// One warning per process, not per request. A 500 was too loud to miss and a
// silent degrade is too quiet to notice; a single startup-shaped log is the
// middle. Rate-limited by module scope, which is per lambda instance.
let warned = false;
function warnUnconfigured(where: string) {
  if (warned) return;
  warned = true;
  console.error(
    `[drip] ANON_ID_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} chars. ` +
      `Anon device identity is DISABLED (${where}): the feed will serve, but ` +
      `impressions cannot be attributed and affinity profiles will not build. ` +
      `Set it in the Vercel project's environment variables — see .env.local.example.`
  );
}

async function key(secret: string) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
}

async function sign(value: string, secret: string) {
  const sig = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(value));
  return Buffer.from(sig).toString('base64url');
}

/** Null when identity is unconfigured — the caller skips the cookie entirely. */
export async function mintAnonId(): Promise<{ anonId: string; cookieValue: string } | null> {
  const secret = anonSecret();
  if (!secret) {
    warnUnconfigured('mint');
    return null;
  }
  const anonId = randomUUID();
  return { anonId, cookieValue: `v1.${anonId}.${await sign(anonId, secret)}` };
}

export async function signAnonId(anonId: string): Promise<string | null> {
  const secret = anonSecret();
  if (!secret) {
    warnUnconfigured('sign');
    return null;
  }
  return `v1.${anonId}.${await sign(anonId, secret)}`;
}

/**
 * Returns the uuid, or null if absent / malformed / forged / unverifiable.
 *
 * Unverifiable is deliberately the same answer as forged: with no key we cannot
 * distinguish a real cookie from one a client typed by hand, so neither is
 * trusted. Fail closed.
 */
export async function verifyAnonId(cookieValue: string): Promise<string | null> {
  const secret = anonSecret();
  if (!secret) {
    warnUnconfigured('verify');
    return null;
  }
  const parts = cookieValue.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, anonId, provided] = parts;
  if (!UUID_RE.test(anonId)) return null;
  const expected = await sign(anonId, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? anonId : null;
}

/**
 * sha256(ip || secret). Never store the raw address.
 *
 * Null without a secret rather than hashing with an empty salt: an unsalted
 * sha256 of an IPv4 address is trivially reversible by brute force (2^32 is
 * seconds of work), so the empty-string fallback this used to have was storing
 * raw addresses with extra steps.
 */
export async function hashIp(ip: string): Promise<Buffer | null> {
  const secret = anonSecret();
  if (!secret) {
    warnUnconfigured('hashIp');
    return null;
  }
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + secret));
  return Buffer.from(d);
}
