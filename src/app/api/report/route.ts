import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase-admin';
import { rateLimit, clientIp } from '@/lib/rate-limit';

const reportSchema = z.object({
  drop_id: z.string().uuid(),
  reason: z.enum(['prohibited_item', 'copyright', 'scam', 'other']),
  details: z.string().trim().max(500).optional(),
  reporter_email: z.string().trim().email().max(254).optional(),
});

export async function POST(request: NextRequest) {
  if (!rateLimit(`report:${clientIp(request)}`, 5, 60_000)) {
    return NextResponse.json({ error: 'Too many reports. Try again later.' }, { status: 429 });
  }

  let input;
  try {
    input = reportSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid report' }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: drop } = await supabase
    .from('drops')
    .select('id')
    .eq('id', input.drop_id)
    .single();

  if (!drop) {
    return NextResponse.json({ error: 'Drop not found' }, { status: 404 });
  }

  const { error } = await supabase.from('reports').insert({
    drop_id: input.drop_id,
    reason: input.reason,
    details: input.details || null,
    reporter_email: input.reporter_email || null,
  });

  if (error) {
    console.error('Report insert failed:', error);
    return NextResponse.json({ error: 'Could not submit report' }, { status: 500 });
  }

  return NextResponse.json({ reported: true });
}
