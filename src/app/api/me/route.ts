import { NextRequest, NextResponse } from 'next/server';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { DELETE_CONFIRMATION, deleteAccount } from '@/lib/account-deletion';
import { rateLimit, clientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/me  body: { "confirm": "DELETE" }
 *
 * Deletes the signed-in account (cookie or Bearer session). The confirmation
 * body makes an accidental or replayed bare DELETE a no-op; DELETE with a
 * JSON body is never a CORS "simple" request, so another origin cannot send
 * it with the user's cookies.
 */
export async function DELETE(request: NextRequest) {
  if (!rateLimit(`account-delete:${clientIp(request)}`, 5, 60 * 60_000)) {
    return NextResponse.json({ error: 'Slow down a moment.' }, { status: 429 });
  }

  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if ((body as { confirm?: unknown } | null)?.confirm !== DELETE_CONFIRMATION) {
    return NextResponse.json(
      { error: `Send {"confirm":"${DELETE_CONFIRMATION}"} to delete this account.` },
      { status: 400 }
    );
  }

  const result = await deleteAccount(createAdminClient(), user.id);
  if (!result.ok) {
    if (result.reason === 'seller_has_orders') {
      return NextResponse.json(
        {
          error:
            'This account has orders from buyers, so it can’t be deleted automatically. Contact support and we’ll close it once those orders are settled.',
          code: 'seller_has_orders',
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: 'Could not delete the account. Try again.' }, { status: 500 });
  }

  // The user (and with it every refresh token) is gone; clear any cookie
  // session too. A 401/404 from the already-deleted user is expected.
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    /* already signed out */
  }
  return NextResponse.json({ deleted: true });
}
