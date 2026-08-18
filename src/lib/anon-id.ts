import { randomUUID, timingSafeEqual } from 'node:crypto';

export const ANON_COOKIE = 'drip_aid';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function key() {
  const secret = process.env.ANON_ID_SECRET;
  if (!secret || secret.length < 32) throw new Error('ANON_ID_SECRET missing or too short');
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
}

async function sign(value: string) {
  const sig = await crypto.subtle.sign('HMAC', await key(), new TextEncoder().encode(value));
  return Buffer.from(sig).toString('base64url');
}

export async function mintAnonId() {
  const anonId = randomUUID();
  return { anonId, cookieValue: `v1.${anonId}.${await sign(anonId)}` };
}

export async function signAnonId(anonId: string) {
  return `v1.${anonId}.${await sign(anonId)}`;
}

/** Returns the uuid, or null if absent / malformed / forged. */
export async function verifyAnonId(cookieValue: string): Promise<string | null> {
  const parts = cookieValue.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, anonId, provided] = parts;
  if (!UUID_RE.test(anonId)) return null;
  const expected = await sign(anonId);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? anonId : null;
}

/** sha256(ip || secret). Never store the raw address. */
export async function hashIp(ip: string) {
  const d = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(ip + (process.env.ANON_ID_SECRET ?? '')));
  return Buffer.from(d);
}
