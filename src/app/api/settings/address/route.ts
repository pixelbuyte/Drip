import { NextRequest, NextResponse } from 'next/server';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { fromAddressSchema } from '@/lib/validation';

// Saves the seller's US-only ship-from address (reused for every label).
export async function PUT(request: NextRequest) {
  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let address;
  try {
    address = fromAddressSchema.parse(await request.json());
  } catch (err) {
    const message =
      err instanceof Error && 'errors' in err
        ? (err as { errors: { message: string }[] }).errors[0]?.message
        : 'Invalid address';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // from_address lives on `seller_payments`, NOT on `profiles`: profiles
  // carries a public read policy (profiles_public_read_handle, USING (true)),
  // and this is the seller's physical home address. It must never sit in a
  // publicly readable table. Do not move it back.
  //
  // Upsert, not update: a seller can save a ship-from address before ever
  // starting Stripe onboarding, so their seller_payments row may not exist yet
  // — a bare UPDATE would match zero rows, return no error, and report success
  // while saving nothing.
  //
  // Service role because seller_payments also holds platform-attested Stripe
  // state that sellers may not write, so the table grants sellers nothing.
  // Authorization is unchanged: the caller must be authenticated, and
  // seller_id is taken from the verified session rather than the request body,
  // so this can only ever write the caller's own row. `address` is nested
  // whole into the from_address jsonb column, so nothing in the request body
  // can reach another column.
  const { error } = await createAdminClient()
    .from('seller_payments')
    .upsert({ seller_id: user.id, from_address: address }, { onConflict: 'seller_id' });

  if (error) {
    console.error('Failed to save from-address:', error);
    return NextResponse.json({ error: 'Failed to save address' }, { status: 500 });
  }

  return NextResponse.json({ saved: true });
}
