/**
 * `Authorization: Bearer <supabase access token>` support for non-browser
 * clients (the native iOS app).
 *
 * The web app authenticates with Supabase SSR cookies and never sends this
 * header, so accepting it changes nothing for browsers. It is also not a CSRF
 * surface: a cross-site page cannot attach an Authorization header without a
 * CORS preflight, and no route answers one.
 *
 * Parsing only. Whether the token is genuine is decided by Supabase Auth
 * (`auth.getUser(jwt)` verifies it server-side) — never by this module.
 */

// A Supabase access token is a three-part JWT. Real ones are ~1KB; the cap
// keeps an oversized header from reaching the auth server at all.
const MAX_TOKEN_LENGTH = 4096;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function bearerToken(headers: Pick<Headers, 'get'>): string | null {
  const raw = headers.get('authorization');
  if (!raw) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  if (!match) return null;
  const token = match[1];
  if (token.length > MAX_TOKEN_LENGTH || !JWT_SHAPE.test(token)) return null;
  return token;
}
