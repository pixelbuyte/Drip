import { NextRequest, NextResponse } from 'next/server';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { ANON_COOKIE, verifyAnonId, mintAnonId } from '@/lib/anon-id';

export async function POST(request: NextRequest) {
  const supabase = await createServerClient_();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const raw = request.cookies.get(ANON_COOKIE)?.value;
  const anonId = raw ? await verifyAnonId(raw) : null;
  if (!anonId) {
    const minted = await mintAnonId();
    const res = NextResponse.json({ linked: false });
    // Unconfigured identity: answer honestly instead of 500ing. Nothing to link.
    if (minted) {
      res.cookies.set({ name: ANON_COOKIE, value: minted.cookieValue, httpOnly: true,
        secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 730 });
    }
    return res;
  }

  const admin = createAdminClient();

  // claim_anon_identity, NOT link_anon_identity.
  //
  // Migration 00010 replaced link_anon_identity precisely because its
  // null-canonical branch repointed an identity row without checking whether
  // auth_user_id already belonged to someone else — so signing in on a shared
  // or borrowed device grafted the previous person's browsing history onto the
  // new account. 00010 shipped the safe version but never dropped the unsafe
  // one, and this route was never migrated, so the hole stayed reachable
  // through the only code path that could reach it. A fix that exists but is
  // never called fixes nothing.
  //
  // The contract also changed shape: claim returns a BOOLEAN (did this account
  // end up owning the identity), not the canonical uuid. There is no aliasing
  // and therefore no canonical-cookie rewrite — refusing to merge is the whole
  // point. A refusal is a normal outcome, not an error: the signed-in account
  // simply starts with a clean profile.
  const { data: claimed, error } = await admin.rpc('claim_anon_identity', {
    p_anon_id: anonId, p_user_id: user.id,
  });
  if (error) {
    console.error('claim_anon_identity failed:', error);
    return NextResponse.json({ error: 'Could not link session' }, { status: 500 });
  }

  return NextResponse.json({ linked: claimed === true });
}
