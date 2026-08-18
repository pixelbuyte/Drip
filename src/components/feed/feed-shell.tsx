'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FEED_PREFETCH_AT, type FeedItem, type FeedResponse, type FeedSurface } from '@/lib/feed/types';
import { emit, flushEvents, getSessionId, installEventFlushHandlers, setSurface } from '@/lib/events/client';
import { useSnapIndex } from '@/hooks/use-snap-index';
import FeedVideo from './feed-video';
import ProductBar from './product-bar';
import { stageFor, WINDOW_AFTER, WINDOW_BEFORE, type FeedVideoHandle, type Registry } from './playback-registry';

const MUTE_KEY = 'drip_muted';

export default function FeedShell({
  initialItems,
  surface = 'for_you',
  initialExhausted = false,
}: {
  initialItems: FeedItem[];
  surface?: FeedSurface;
  initialExhausted?: boolean;
}) {
  const [items, setItems] = useState<FeedItem[]>(initialItems);
  const [committed, setCommitted] = useState(0);
  const [muted, setMuted] = useState(true);
  const [exhausted, setExhausted] = useState(initialExhausted);
  const [needsTap, setNeedsTap] = useState(false);
  const [nudgeAt, setNudgeAt] = useState<number | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const mutedRef = useRef(true);
  const registry = useRef<Registry>(new Map());
  const impressed = useRef<Set<string>>(new Set());
  const loading = useRef(false);
  const slideHeight = useRef(0);

  useEffect(() => {
    setSurface(surface);
    return installEventFlushHandlers();
  }, [surface]);

  // Once a viewer unmutes, every subsequent video is unmuted.
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    try {
      if (localStorage.getItem(MUTE_KEY) === '0') setMuted(false);
    } catch {
      /* partitioned storage */
    }
  }, []);

  useEffect(() => {
    slideHeight.current = scrollerRef.current?.clientHeight ?? 0;
    const onResize = () => {
      slideHeight.current = scrollerRef.current?.clientHeight ?? 0;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const fetchMore = useCallback(async () => {
    if (loading.current || exhausted) return;
    loading.current = true;
    try {
      const exclude = items.map((i) => i.videoId).slice(-300).join(',');
      const url =
        `/api/feed?session_id=${getSessionId()}&surface=${surface}` +
        `&offset=${items.length}` +
        (exclude ? `&exclude_ids=${encodeURIComponent(exclude)}` : '');
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = (await res.json()) as FeedResponse;
      if (data.items.length === 0) setExhausted(true);
      else setItems((prev) => [...prev, ...data.items]);
    } catch {
      /* the shell keeps whatever it has; the viewer sees no error mid-scroll */
    } finally {
      loading.current = false;
    }
  }, [items, surface, exhausted]);

  const onCommit = useCallback(
    (index: number) => {
      const outgoing = registry.current.get(committedRef.current);
      const outgoingItem = items[committedRef.current];

      // Read the outgoing clock BEFORE pauseAndReset zeroes it. Order matters.
      if (outgoing && outgoingItem && committedRef.current !== index) {
        const watched = outgoing.currentTimeMs();
        emit({
          t: 'skip',
          v: outgoingItem.videoId,
          wm: watched,
          dm: outgoing.durationMs(),
          lc: outgoing.loopCount(),
          pos: committedRef.current,
        });
      }

      committedRef.current = index;
      setCommitted(index);

      const item = items[index];
      if (item && !impressed.current.has(item.videoId)) {
        impressed.current.add(item.videoId);
        emit({ t: 'impression', v: item.videoId, pos: index });
      }

      // One nudge per video, 1.5s in. Enough to draw the eye, not to annoy.
      setNudgeAt(null);
      const nudgeTimer = setTimeout(() => setNudgeAt(index), 1500);
      const settleTimer = setTimeout(() => setNudgeAt(null), 1900);

      if (index >= items.length - (20 - FEED_PREFETCH_AT)) void fetchMore();

      return () => {
        clearTimeout(nudgeTimer);
        clearTimeout(settleTimer);
      };
    },
    [items, fetchMore]
  );

  const committedRef = useRef(0);
  useSnapIndex({
    scrollerRef,
    slideHeight: slideHeight.current || 1,
    count: items.length,
    onCommit,
  });

  // One owner for playback. useLayoutEffect, not useEffect: the outgoing pause
  // must land in the same frame as the commit or two soundtracks overlap.
  // Reads committedRef/mutedRef rather than closing over state. A slide can
  // mount holding a previous render's callback; if this function closed over
  // `committed`, that stale call would start a video that is no longer
  // current and two would play at once. Refs make every invocation agree on
  // what "current" means, whenever it fires.
  const startCurrent = useCallback(async () => {
    const index = committedRef.current;
    const cur = registry.current.get(index);
    if (!cur) return;
    cur.setMuted(mutedRef.current);
    try {
      await cur.play();
      if (committedRef.current === index) setNeedsTap(false);
    } catch {
      // Unmuted autoplay refused (webview without a user gesture). Fall back
      // to muted once, then surrender to a tap.
      cur.setMuted(true);
      try {
        await cur.play();
      } catch {
        if (committedRef.current === index) setNeedsTap(true);
      }
    }
  }, []);

  useLayoutEffect(() => {
    for (const [i, h] of registry.current) {
      if (i !== committedRef.current) h.pauseAndReset();
    }
    void startCurrent();
  }, [committed, muted, startCurrent]);

  const register = useCallback(
    (i: number, h: FeedVideoHandle | null) => {
      if (!h) {
        registry.current.delete(i);
        return;
      }
      registry.current.set(i, h);
      // A slide can mount after its commit already happened; start it if it
      // is the current one, and make sure it is silent if it is not.
      if (i === committedRef.current) void startCurrent();
      else h.pauseAndReset();
    },
    [startCurrent]
  );

  const toggleMute = () => {
    setMuted((m) => {
      const next = !m;
      try {
        localStorage.setItem(MUTE_KEY, next ? '1' : '0');
      } catch {
        /* partitioned */
      }
      registry.current.get(committedRef.current)?.setMuted(next);
      return next;
    });
    if (needsTap) void startCurrent();
  };

  useEffect(() => () => flushEvents(true), []);

  if (items.length === 0) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-ink px-8 text-center">
        <p className="font-display text-[22px] font-bold text-cream">Nothing here yet</p>
        <p className="mt-2 text-[15px] text-cream/70">
          New drops land through the day. Check back in a bit.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={scrollerRef}
      className="feed-scroller h-[100dvh] w-full overflow-y-scroll bg-ink"
      style={{
        scrollSnapType: 'y mandatory',
        overscrollBehaviorY: 'contain',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      {items.map((item, i) => {
        const stage = stageFor(i, committed);
        const mounted = i >= committed - WINDOW_BEFORE && i <= committed + WINDOW_AFTER;

        return (
          <section
            key={item.videoId}
            className="relative w-full"
            style={{
              height: '100dvh',
              scrollSnapAlign: 'start',
              // scroll-snap-stop:always stops a fast flick from blowing past
              // five videos, which would wreck both the experience and the
              // impression data the ranker reads.
              scrollSnapStop: 'always',
              // Only unmounted rails may skip painting — doing it to mounted
              // neighbours would skip the very posters that make the <300ms
              // transition possible.
              contentVisibility: mounted ? 'visible' : 'auto',
              containIntrinsicSize: mounted ? undefined : '100dvh',
              contain: mounted ? 'layout paint style' : undefined,
            }}
            aria-roledescription="feed item"
            aria-label={`${item.seller.displayName}: ${item.caption ?? item.products[0]?.title ?? 'video'}`}
          >
            {mounted && stage ? (
              <>
                <FeedVideo
                  playbackId={item.playbackId}
                  poster={item.thumbnailUrl}
                  stage={stage}
                  isLcpCandidate={i === 0}
                  handleRef={(h) => register(i, h)}
                  onError={() => emit({ t: 'video_error', v: item.videoId, pos: i })}
                />
                <div
                  className="absolute inset-0"
                  onClick={toggleMute}
                  role="presentation"
                  style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 38%)' }}
                />
              </>
            ) : (
              <div className="absolute inset-0 bg-ink" aria-hidden />
            )}

            {mounted && (
              <>
                <div className="pointer-events-none absolute left-4 top-[calc(env(safe-area-inset-top,0px)+16px)] z-20 flex items-center gap-2">
                  <span className="rounded-full bg-black/45 px-3 py-1 text-[13px] font-semibold text-white backdrop-blur-sm">
                    @{item.seller.handle}
                  </span>
                </div>

                {item.caption && (
                  <p className="pointer-events-none absolute inset-x-4 bottom-[calc(env(safe-area-inset-bottom,0px)+90px)] z-20 line-clamp-2 text-[14px] leading-snug text-white drop-shadow">
                    {item.caption}
                  </p>
                )}

                <ProductBar
                  products={item.products}
                  activeIndex={0}
                  nudge={nudgeAt === i}
                  onOpen={(productId) => {
                    emit({ t: 'product_tap', v: item.videoId, p: productId, pos: i });
                  }}
                />
              </>
            )}
          </section>
        );
      })}

      {exhausted && (
        <section
          className="relative flex w-full flex-col items-center justify-center bg-ink px-8 text-center"
          style={{ height: '100dvh', scrollSnapAlign: 'start' }}
        >
          <p className="font-display text-[24px] font-bold text-cream">You&apos;re all caught up</p>
          <p className="mt-2 max-w-[28ch] text-[15px] text-cream/70">
            That&apos;s everything new for now. Pick a category and we&apos;ll find you something else.
          </p>
        </section>
      )}

      {needsTap && (
        <button
          onClick={toggleMute}
          className="fixed inset-x-0 bottom-1/2 z-50 mx-auto w-max rounded-full bg-card px-5 py-3 text-[15px] font-bold text-ink shadow-float"
        >
          Tap to play
        </button>
      )}
    </div>
  );
}
