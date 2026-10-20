import { NextRequest, NextResponse } from 'next/server';
import { verifyMuxSignature, MAX_VIDEO_SECONDS } from '@/lib/mux';
import { createAdminClient } from '@/lib/supabase-admin';
import { muxAspectRatio, muxThumbnailUrl, parsePassthrough } from '@/lib/listings';

type MuxEvent = {
  id: string;
  type: string;
  data: {
    id: string;
    passthrough?: string;
    duration?: number;
    aspect_ratio?: string;
    playback_ids?: { id: string; policy: string }[];
    // video.upload.* events carry the Upload object, whose passthrough is
    // nested in the settings of the asset it will create.
    new_asset_settings?: { passthrough?: string };
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
    const target = parsePassthrough(
      event.data.passthrough ?? event.data.new_asset_settings?.passthrough
    );

    // Listings on the feed content model (POST /api/videos). Service role
    // passes guard_video_status, which is what lets Drip publish.
    if (target?.kind === 'video') {
      await handleVideoEvent(supabase, event, target.id);
      return NextResponse.json({ received: true });
    }

    switch (event.type) {
      case 'video.asset.ready': {
        const dropId = target?.id;
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
        const dropId = target?.id;
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

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Only a video still in 'processing' moves, so a replayed or out-of-order
 * event can never resurrect a removed video or re-date a live one.
 * published_at is the feed's freshness clock (spec 2.3): set once, here.
 */
async function handleVideoEvent(supabase: AdminClient, event: MuxEvent, videoId: string) {
  // On video.upload.* events data.id is the upload's id, not an asset's.
  const assetId = event.type.startsWith('video.asset.') ? event.data.id : undefined;
  const remove = async (reason: string) => {
    const { error } = await supabase
      .from('videos')
      .update({ status: 'removed', removed_reason: reason, ...(assetId ? { mux_asset_id: assetId } : {}) })
      .eq('id', videoId)
      .eq('status', 'processing');
    if (error) throw error;
  };

  switch (event.type) {
    case 'video.asset.ready': {
      const duration = event.data.duration ?? 0;
      if (duration > MAX_VIDEO_SECONDS + 1) {
        await remove(`Video is longer than ${MAX_VIDEO_SECONDS} seconds`);
        return;
      }
      const playbackId =
        event.data.playback_ids?.find((p) => p.policy === 'public')?.id ?? null;
      if (!playbackId) {
        await remove('Video has no public playback');
        return;
      }
      const { error } = await supabase
        .from('videos')
        .update({
          mux_asset_id: event.data.id,
          mux_playback_id: playbackId,
          duration_seconds: duration > 0 ? Math.round(duration * 1000) / 1000 : null,
          aspect_ratio: muxAspectRatio(event.data.aspect_ratio),
          thumbnail_url: muxThumbnailUrl(playbackId),
          status: 'live',
          published_at: new Date().toISOString(),
        })
        .eq('id', videoId)
        .eq('status', 'processing');
      if (error) throw error;
      return;
    }
    case 'video.asset.errored':
    case 'video.upload.errored':
      await remove('Video processing failed');
      return;
    default:
      return;
  }
}
