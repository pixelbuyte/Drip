'use client';

import type { FeedSurface } from '@/lib/feed/types';

/**
 * The client half of step 3. Events are batched and flushed on a timer, on
 * page hide, and when the batch fills. The wire format is deliberately terse
 * (`t`/`v`/`p`/…) because this is the highest-volume request the app makes and
 * it must fit in a sendBeacon payload.
 */

export type EventType =
  | 'impression' | 'watch_progress' | 'skip' | 'replay' | 'product_tap'
  | 'variant_select' | 'add_to_cart' | 'checkout_open' | 'checkout_abandon'
  | 'purchase' | 'like' | 'unlike' | 'save' | 'unsave' | 'share'
  | 'seller_profile_tap' | 'follow' | 'unfollow' | 'not_interested'
  | 'report' | 'video_error';

export type WireEvent = {
  t: EventType;
  v: string;
  p?: string;
  ts?: number;
  pos?: number;
  wm?: number;
  dm?: number;
  lc?: number;
  b?: string;
  meta?: Record<string, unknown>;
};

const FLUSH_MS = 4000;
const MAX_BATCH = 40; // the endpoint rejects >50

let queue: WireEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sessionId: string | null = null;
let surface: FeedSurface = 'for_you';

/**
 * Adopt a server-minted session id (the SSR page generates one per render,
 * records the first slice under it, and hands it to the shell). Adopting it
 * makes every event this page emits carry the SAME sid the slice was
 * recorded under — which is what lets the ingest join resolve each
 * impression's lane. Without adoption, the SSR slice's impressions joined
 * feed_slices on a sid that had no rows, lane came back NULL, and none of
 * them ever counted toward the 500-impression exploration guarantee — and
 * the 1-impression-per-viewer-per-video cap then burned that viewer's only
 * countable impression for each of those videos, permanently.
 *
 * A page load IS a session under this model (each SSR render mints a fresh
 * id). Nothing depended on cross-reload session continuity before: the
 * shell's exclude list lives in component state and resets on reload anyway,
 * and every abuse cap that matters is keyed per anon+video, not per session.
 */
export function adoptSessionId(id: string): void {
  sessionId = id;
  try {
    sessionStorage.setItem('drip_sid', id);
  } catch {
    /* memory-only for this session */
  }
}

/** v4 uuid in sessionStorage, falling back to memory: in-app browsers may
 *  partition or block storage entirely, and the spec says to assume so. */
export function getSessionId(): string {
  if (sessionId) return sessionId;
  try {
    const stored = sessionStorage.getItem('drip_sid');
    if (stored) {
      sessionId = stored;
      return stored;
    }
  } catch {
    /* storage partitioned or blocked */
  }
  const id = crypto.randomUUID();
  sessionId = id;
  try {
    sessionStorage.setItem('drip_sid', id);
  } catch {
    /* memory-only for this session */
  }
  return id;
}

export function setSurface(s: FeedSurface) {
  surface = s;
}

function post(body: string, useBeacon: boolean): void {
  const url = '/api/events';
  if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    // Beacon survives the page being backgrounded or closed, which is exactly
    // when the last skip of a session is emitted.
    const ok = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    if (ok) return;
  }
  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
    credentials: 'same-origin',
  }).catch(() => {
    /* events are best effort; never surface a network error to a shopper */
  });
}

export function flushEvents(useBeacon = false): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;
  const batch = queue.slice(0, MAX_BATCH);
  queue = queue.slice(MAX_BATCH);
  // Envelope keys are terse to fit sendBeacon payload limits, and MUST match
  // the batchSchema in src/app/api/events/route.ts. They disagreed once and
  // every batch 400'd silently; src/lib/events/__tests__ now pins the contract.
  post(
    JSON.stringify({ sid: getSessionId(), sf: surface, sent_at: Date.now(), e: batch }),
    useBeacon
  );
  if (queue.length > 0) scheduleFlush();
}

function scheduleFlush() {
  if (timer) return;
  timer = setTimeout(() => flushEvents(false), FLUSH_MS);
}

export function emit(event: WireEvent): void {
  queue.push({ ts: Date.now(), ...event });
  if (queue.length >= MAX_BATCH) {
    flushEvents(false);
    return;
  }
  scheduleFlush();
}

let installed = false;
/** Flush on the transitions where a queued event would otherwise be lost. */
export function installEventFlushHandlers(): () => void {
  if (installed || typeof document === 'undefined') return () => {};
  installed = true;
  const onHide = () => {
    if (document.visibilityState === 'hidden') flushEvents(true);
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', () => flushEvents(true));
  return () => {
    document.removeEventListener('visibilitychange', onHide);
    installed = false;
  };
}
