import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ANON_COOKIE, mintAnonId, verifyAnonId } from '@/lib/anon-id';

// Two jobs, deliberately in one place because both must happen before the
// route renders:
//
// 1. Anon identity. The signed device cookie must exist before the first
//    /api/feed call and the first /api/events beacon, and both must see the
//    same id within one page load — otherwise the impression that decides
//    whether a session continues is attributed to nobody.
// 2. The landing redirect. `/` is the marketing page; a signed-in seller goes
//    to their dashboard. A cookie presence check only — no network call, or
//    the LCP element waits on a round trip.
export const config = {
  matcher: [
    '/',
    '/feed/:path*',
    '/v/:path*',
    '/discover/:path*',
    '/api/events',
    '/api/feed/:path*',
  ],
};

export async function proxy(request: NextRequest) {
  const isLanding = request.nextUrl.pathname === '/';

  if (isLanding) {
    const hasSession = request.cookies
      .getAll()
      .some((c) => c.name.startsWith('sb-') && c.name.endsWith('-auth-token'));
    if (hasSession) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
  }

  const existing = request.cookies.get(ANON_COOKIE)?.value;
  const verified = existing ? await verifyAnonId(existing) : null;
  if (verified) return NextResponse.next();

  const minted = await mintAnonId();

  // Identity is unconfigured (no ANON_ID_SECRET). Serve the page anyway.
  // Attribution is lost until the secret is set; the site staying up is worth
  // more than the impression data, and this used to throw here — taking every
  // route in the matcher, the landing page included, down with it.
  if (!minted) return NextResponse.next();

  const { anonId, cookieValue } = minted;

  // Hand the freshly minted id to this same request so the server render and
  // any route handler it calls agree on the identity.
  const headers = new Headers(request.headers);
  headers.set('x-drip-anon-id', anonId);

  const response = NextResponse.next({ request: { headers } });
  response.cookies.set({
    name: ANON_COOKIE,
    value: cookieValue,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 730,
    priority: 'high',
  });
  return response;
}
