import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { sendBackInStock } from '@/lib/emails';

const restockSchema = z.object({
  inventory: z.number().int().min(1).max(100000),
});

// Sets new inventory on a sold-out (or low) drop and notifies the waitlist.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: dropId } = await params;

  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let input;
  try {
    input = restockSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid inventory amount' }, { status: 400 });
  }

  // RLS scopes this to the seller's own drops.
  const { data: drop } = await supabase
    .from('drops')
    .select('id, title, slug, inventory, status')
    .eq('id', dropId)
    .eq('seller_id', user.id)
    .single();

  if (!drop) {
    return NextResponse.json({ error: 'Drop not found' }, { status: 404 });
  }

  const wasSoldOut = drop.inventory === 0;

  const { error: updateError } = await supabase
    .from('drops')
    .update({ inventory: input.inventory })
    .eq('id', dropId)
    .eq('seller_id', user.id);

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update inventory' }, { status: 500 });
  }

  // Back-in-stock blast: only on a 0 -> N transition, only to entries not
  // yet notified. Mark first, then send best-effort, so a crash mid-blast
  // can't double-email anyone.
  let notified = 0;
  if (wasSoldOut && drop.status === 'active') {
    const admin = createAdminClient();
    const { data: profile } = await admin
      .from('profiles')
      .select('handle')
      .eq('id', user.id)
      .single();

    const { data: entries } = await admin
      .from('waitlist_entries')
      .update({ notified_at: new Date().toISOString() })
      .eq('drop_id', dropId)
      .is('notified_at', null)
      .select('email');

    const dropUrl = `${process.env.NEXT_PUBLIC_APP_URL}/@${profile?.handle}/${drop.slug}`;
    for (const entry of entries ?? []) {
      await sendBackInStock(entry.email, drop.title, dropUrl, profile?.handle ?? '');
      notified++;
    }
  }

  return NextResponse.json({ inventory: input.inventory, waitlist_notified: notified });
}
