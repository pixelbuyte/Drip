import { NextRequest, NextResponse } from 'next/server';
import { verifyMuxSignature, MAX_VIDEO_SECONDS } from '@/lib/mux';
import { createAdminClient } from '@/lib/supabase-admin';

type MuxEvent = {
  id: string;
  type: string;
  data: {
    id: string;
    passthrough?: string;
    duration?: number;
    playback_ids?: { id: string; policy: string }[];
  };
};

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('mux-signature');

  if (!verifyMuxSignature(rawBody, signature, process.env.MUX_WEBHOOK_SECRET!)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  let event: MuxEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Same claim-before-process idempotency as the Stripe handler.
  const { error: claimError } = await supabase.from('processed_events').insert({
    provider: 'mux',
    event_id: event.id,
    event_type: event.type,
  });

  if (claimError) {
    if (claimError.code === '23505') {
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error('Failed to claim Mux event:', claimError);
    return NextResponse.json({ error: 'Event claim failed' }, { status: 500 });
  }

  try {
    switch (event.type) {
      case 'video.asset.ready': {
        const dropId = event.data.passthrough;
        if (!dropId) break;

        // Enforce the 60s cap server-side (small grace for encoder rounding).
        if ((event.data.duration ?? 0) > MAX_VIDEO_SECONDS + 1) {
          await supabase
            .from('drops')
            .update({ status: 'rejected', mux_asset_id: event.data.id })
            .eq('id', dropId)
            .eq('status', 'processing');
          break;
        }

        const playbackId = event.data.playback_ids?.[0]?.id ?? null;
        await supabase
          .from('drops')
          .update({
            mux_asset_id: event.data.id,
            mux_playback_id: playbackId,
            status: 'active',
          })
          .eq('id', dropId)
          .eq('status', 'processing');
        break;
      }

      case 'video.asset.errored':
      case 'video.upload.errored': {
        const dropId = event.data.passthrough;
        if (!dropId) break;
        await supabase
          .from('drops')
          .update({ status: 'rejected' })
          .eq('id', dropId)
          .eq('status', 'processing');
        break;
      }

      default:
        break;
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error(`Mux webhook handler failed for ${event.type}:`, err);
    await supabase
      .from('processed_events')
      .delete()
      .eq('provider', 'mux')
      .eq('event_id', event.id);
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 });
  }
}
