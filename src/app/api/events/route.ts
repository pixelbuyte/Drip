import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase-admin';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { ANON_COOKIE, verifyAnonId, mintAnonId, hashIp } from '@/lib/anon-id';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 32 * 1024;

const EVENT_TYPES = [
  'impression','watch_progress','skip','replay','product_tap','variant_select',
  'add_to_cart','checkout_open','checkout_abandon','purchase','like','unlike',
  'save','unsave','share','seller_profile_tap','follow','unfollow',
  'not_interested','report','video_error',
] as const;

const SURFACES = ['for_you','following','category','seller_profile','search','shared_link'] as const;

const eventSchema = z.object({
  t: z.enum(EVENT_TYPES),
  v: z.string().uuid(),
  p: z.string().uuid().optional(),
  ts: z.number().int().optional(),
  pos: z.number().int().min(0).max(5000).optional(),
  wm: z.number().int().min(0).max(86_400_000).optional(),
  dm: z.number().int().min(0).max(3_600_000).optional(),
  lc: z.number().int().min(0).max(10_000).optional(),
  b: z.string().max(32).optional(),
  meta: z.record(z.unknown()).optional(),
});

const batchSchema = z.object({
  sid: z.string().uuid(),
  sf: z.enum(SURFACES),
  sent_at: z.number().int().optional(),
  e: z.array(z.unknown()).min(1).max(50),
});

export async function POST(request: NextRequest) {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });

  // sendBeacon sends text/plain by default when handed a string; accept both
  // rather than forcing a Blob (which costs a preflight in some webviews).
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });

  const ip = clientIp(request);
  if (!rateLimit(`events:ip:${ip}`, 100, 60_000)) {
    return new NextResponse(null, { status: 429 });
  }

  // Identity from the signed cookie, or minted here if Proxy did not run.
  const raw = request.cookies.get(ANON_COOKIE)?.value;
  let anonId = raw ? await verifyAnonId(raw) : null;
  let setCookieValue: string | null = null;
  if (!anonId) {
    const minted = await mintAnonId();
    anonId = minted.anonId;
    setCookieValue = minted.cookieValue;   // accept the batch, don't drop it
  }

  if (!rateLimit(`events:anon:${anonId}`, 20, 60_000)) {
    return new NextResponse(null, { status: 429 });
  }

  let batch;
  try {
    batch = batchSchema.parse(JSON.parse(text));
  } catch {
    return NextResponse.json({ error: 'Invalid batch' }, { status: 400 });
  }

  // Drop malformed individual events; never fail the batch over one bad row.
  const now = Date.now();
  const events = batch.e
    .map((raw) => eventSchema.safeParse(raw))
    .filter((r): r is { success: true; data: z.infer<typeof eventSchema> } => r.success)
    .map((r) => {
      const ev = r.data;
      // Clamp the client clock: skewed devices are common and a wild ts would
      // poison the dedupe key's time bucket.
      const ts = ev.ts && ev.ts > now - 86_400_000 && ev.ts < now + 300_000 ? ev.ts : now;
      return { ...ev, ts };
    });

  if (events.length === 0) return new NextResponse(null, { status: 202 });

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc('ingest_feed_events', {
    p_anon_id: anonId,
    p_session_id: batch.sid,
    p_surface: batch.sf,
    p_events: events,
  });

  if (error) {
    // Events are not precious. Log and swallow: the client must never retry
    // into a loop, and the UI must never learn that telemetry failed.
    console.error('ingest_feed_events failed:', error);
  }

  const row = Array.isArray(data) ? data[0] : data;
  const response = NextResponse.json(
    { accepted: row?.accepted ?? 0, deduped: row?.deduped ?? 0, discarded: row?.discarded ?? 0 },
    { status: 202 },
  );
  if (setCookieValue) {
    response.cookies.set({ name: ANON_COOKIE, value: setCookieValue, httpOnly: true,
      secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 730, priority: 'high' });
  }
  // Best-effort identity provenance for 2.9; failure is not fatal.
  void supabase.from('viewer_identities').update({ issued_ip_hash: await hashIp(ip) })
    .eq('anon_id', anonId).is('issued_ip_hash', null);

  return response;
}
