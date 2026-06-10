import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase-admin';
import { rateLimit, clientIp } from '@/lib/rate-limit';

const waitlistSchema = z.object({
  drop_id: z.string().uuid(),
  email: z.string().trim().email('Enter a valid email').max(254),
  name: z.string().trim().max(60).optional(),
});

// Buyers have no accounts, so inserts go through the service role after
// validating the drop. Duplicate signups are treated as success.
export async function POST(request: NextRequest) {
  if (!rateLimit(`waitlist:${clientIp(request)}`, 5, 60_000)) {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 });
  }

  let input;
  try {
    input = waitlistSchema.parse(await request.json());
  } catch (err) {
    const message =
      err instanceof Error && 'errors' in err
        ? (err as { errors: { message: string }[] }).errors[0]?.message
        : 'Invalid input';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: drop } = await supabase
    .from('drops')
    .select('id, seller_id, status')
    .eq('id', input.drop_id)
    .single();

  if (!drop || drop.status !== 'active') {
    return NextResponse.json({ error: 'This drop is not available' }, { status: 404 });
  }

  const { error } = await supabase.from('waitlist_entries').insert({
    drop_id: drop.id,
    seller_id: drop.seller_id,
    email: input.email.toLowerCase(),
    name: input.name || null,
  });

  if (error && error.code !== '23505') {
    console.error('Waitlist insert failed:', error);
    return NextResponse.json({ error: 'Could not join the waitlist' }, { status: 500 });
  }

  return NextResponse.json({ joined: true });
}
