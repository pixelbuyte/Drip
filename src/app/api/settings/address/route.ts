import { NextRequest, NextResponse } from 'next/server';
import { createServerClient_ } from '@/lib/supabase-server';
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

  const { error } = await supabase
    .from('profiles')
    .update({ from_address: address })
    .eq('id', user.id);

  if (error) {
    console.error('Failed to save from-address:', error);
    return NextResponse.json({ error: 'Failed to save address' }, { status: 500 });
  }

  return NextResponse.json({ saved: true });
}
