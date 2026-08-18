import { NextRequest, NextResponse } from 'next/server';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { ANON_COOKIE, verifyAnonId, signAnonId, mintAnonId } from '@/lib/anon-id';

export async function POST(request: NextRequest) {
  const supabase = await createServerClient_();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const raw = request.cookies.get(ANON_COOKIE)?.value;
  const anonId = raw ? await verifyAnonId(raw) : null;
  if (!anonId) {
    const { cookieValue } = await mintAnonId();
    const res = NextResponse.json({ linked: false });
    res.cookies.set({ name: ANON_COOKIE, value: cookieValue, httpOnly: true,
      secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 730 });
    return res;
  }

  const admin = createAdminClient();
  const { data: canonical, error } = await admin.rpc('link_anon_identity', {
    p_anon_id: anonId, p_auth_user_id: user.id,
  });
  if (error) {
    console.error('link_anon_identity failed:', error);
    return NextResponse.json({ error: 'Could not link session' }, { status: 500 });
  }

  const res = NextResponse.json({ linked: true });
  if (canonical !== anonId) {
    // The key move: rewrite the cookie to the canonical id, so every future
    // event lands on the merged profile and the hot ingestion path never has
    // to resolve an alias.
    res.cookies.set({ name: ANON_COOKIE, value: await signAnonId(canonical),
      httpOnly: true, secure: true, sameSite: 'lax', path: '/',
      maxAge: 60 * 60 * 24 * 730, priority: 'high' });
  }
  return res;
}
