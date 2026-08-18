'use client';

import { useEffect, useRef } from 'react';

const IDLE_MS = 90;
/** Fraction of a slide. ~8px at 844 — anything further out is mid-gesture. */
const SETTLE_EPSILON = 0.01;

export type CommitCause = 'init' | 'idle' | 'scrollend';

/**
 * Which slide is committed, and nothing else.
 *
 * The scroll handler sets a boolean and resets a timer: no scrollTop read, no
 * layout query, no setState, no allocation. That is how "0 long tasks during
 * scroll" is honored at the source rather than optimized afterward.
 *
 * Commits are idempotent by construction, because an impression emitted twice
 * for one landing corrupts the exact rate the whole ranking model reads.
 */
export function useSnapIndex(opts: {
  scrollerRef: React.RefObject<HTMLElement | null>;
  /** Live count, read through a ref so appends never re-subscribe. */
  count: number;
  onCommit: (index: number, cause: CommitCause) => void;
}) {
  const { scrollerRef, onCommit } = opts;
  const committedRef = useRef(-1);
  const isScrollingRef = useRef(false);

  // Latest values without re-subscribing: re-attaching the listener on every
  // buffer append would drop scroll events in the gap.
  const latest = useRef(opts);
  latest.current = opts;

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    let idle: ReturnType<typeof setTimeout> | undefined;

    const commit = (cause: CommitCause) => {
      const { count } = latest.current;
      // Measured live rather than passed in. A render-time snapshot goes stale
      // on an orientation change or a mobile toolbar collapse — the resize
      // handler updates a ref but triggers no render, so the detector divided
      // by the old height and stopped committing for the rest of the session.
      const slideHeight = el.clientHeight;
      if (!slideHeight) return;
      const raw = el.scrollTop / slideHeight;
      const nearest = Math.round(raw);
      // Not parked on a snap point: interrupted fling, rubber-band bounce, or
      // a finger still down. Emitting here is how you double-count.
      if (Math.abs(raw - nearest) > SETTLE_EPSILON) return;
      const next = Math.min(Math.max(nearest, 0), Math.max(0, count - 1));
      if (next === committedRef.current) return;
      committedRef.current = next;
      latest.current.onCommit(next, cause);
    };

    const onScroll = () => {
      isScrollingRef.current = true;
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        isScrollingRef.current = false;
        commit('idle');
      }, IDLE_MS);
    };

    const onScrollEnd = () => {
      if (idle) clearTimeout(idle);
      isScrollingRef.current = false;
      commit('scrollend');
    };

    const hasScrollEnd = 'onscrollend' in el;
    el.addEventListener('scroll', onScroll, { passive: true });
    if (hasScrollEnd) el.addEventListener('scrollend', onScrollEnd, { passive: true });
    commit('init'); // no scroll event fires for index 0

    return () => {
      el.removeEventListener('scroll', onScroll);
      if (hasScrollEnd) el.removeEventListener('scrollend', onScrollEnd);
      if (idle) clearTimeout(idle);
    };
    // Subscribe exactly once for the life of the scroller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { committedRef, isScrollingRef };
}
