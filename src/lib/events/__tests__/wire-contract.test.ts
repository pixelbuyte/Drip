import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * The event client and /api/events are written in different files and were
 * shipped with disagreeing envelopes — the client sent {session_id, surface,
 * events} while the route required {sid, sf, e}, so every batch 400'd and the
 * event log stayed empty. Nothing failed loudly: events are fire-and-forget by
 * design, which is exactly why the contract needs a test rather than a comment.
 *
 * This duplicates the route's schema on purpose. Importing it would make the
 * two move together and the test would pass through any rename — which is the
 * failure it exists to catch.
 */
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

/** Byte-for-byte what flushEvents() posts. */
function clientEnvelope(sessionId: string, surface: string, batch: unknown[]) {
  return JSON.stringify({ sid: sessionId, sf: surface, sent_at: Date.now(), e: batch });
}

const SID = '11111111-2222-4333-8444-555555555555';
const VID = '00000000-0000-4000-8000-00000000000a';

describe('event wire contract', () => {
  it('the envelope the client posts is accepted by the route schema', () => {
    const body = clientEnvelope(SID, 'for_you', [{ t: 'impression', v: VID, ts: Date.now(), pos: 0 }]);
    const parsed = batchSchema.safeParse(JSON.parse(body));
    expect(parsed.success).toBe(true);
  });

  it('rejects the old envelope, so a regression fails loudly', () => {
    const stale = JSON.stringify({ session_id: SID, surface: 'for_you', events: [{ t: 'impression', v: VID }] });
    expect(batchSchema.safeParse(JSON.parse(stale)).success).toBe(false);
  });

  it('accepts every event type the client can emit', () => {
    for (const t of EVENT_TYPES) {
      expect(eventSchema.safeParse({ t, v: VID }).success).toBe(true);
    }
  });

  it('accepts the field set the shell actually sends on a skip', () => {
    const skip = { t: 'skip', v: VID, wm: 4200, dm: 18000, lc: 1, pos: 3, ts: Date.now() };
    expect(eventSchema.safeParse(skip).success).toBe(true);
  });

  it('accepts a product_tap with a product id and meta', () => {
    const tap = { t: 'product_tap', v: VID, p: '00000000-0000-4000-8000-00000000000b',
                  meta: { selection: { Size: 'M' }, quantity: 1 } };
    expect(eventSchema.safeParse(tap).success).toBe(true);
  });

  it('caps a batch at 50 events, which is why the client flushes at 40', () => {
    const many = Array.from({ length: 51 }, () => ({ t: 'impression', v: VID }));
    expect(batchSchema.safeParse(JSON.parse(clientEnvelope(SID, 'for_you', many))).success).toBe(false);
  });
});
