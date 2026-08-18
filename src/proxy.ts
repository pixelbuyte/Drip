import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// The landing page used to be a client component that called getSession()
// before painting, so every logged-out visitor — the whole audience a landing
// page exists for — watched a loading state until a network round-trip
// resolved. The redirect lives here instead: a cookie presence check, no
// Supabase client, no network call. Next 16 renamed `middleware` to `proxy`.
export function proxy(request: NextRequest) {
  const hasSession = request.cookies
    .getAll()
    .some((c) => c.name.startsWith('sb-') && c.name.endsWith('-auth-token'));

  if (hasSession) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: '/' };
