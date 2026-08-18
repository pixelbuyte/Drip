'use client';

import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import type { FeedVideoHandle, PreloadStage } from './playback-registry';

/**
 * A plain <video>, not MuxPlayer. MuxPlayer pulls media-chrome and the player
 * stylesheet — a six-figure byte count against a 180KB route budget, for
 * controls this surface deliberately does not show. Mux still serves the
 * media; only the player is ours.
 */
export default function FeedVideo({
  playbackId,
  poster,
  stage,
  handleRef,
  onError,
  onLoop,
  onProgress,
  isLcpCandidate,
}: {
  playbackId: string | null;
  poster: string | null;
  stage: PreloadStage;
  handleRef: Ref<FeedVideoHandle>;
  onError?: () => void;
  onLoop?: () => void;
  onProgress?: (bucket: 25 | 50 | 75 | 95, watchedMs: number, durationMs: number, loops: number) => void;
  isLcpCandidate?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const loops = useRef(0);
  const lastTime = useRef(0);
  const fired = useRef<Set<number>>(new Set());

  useImperativeHandle(handleRef, (): FeedVideoHandle => ({
    play: async () => {
      const el = ref.current;
      if (!el) return;
      await el.play();
    },
    pauseAndReset: () => {
      const el = ref.current;
      if (!el) return;
      el.pause();
      try {
        el.currentTime = 0;
      } catch {
        /* not seekable yet */
      }
      loops.current = 0;
      lastTime.current = 0;   // or a late timeupdate reads as a loop
      fired.current.clear();
    },
    pauseHold: () => ref.current?.pause(),
    resume: () => {
      void ref.current?.play().catch(() => {});
    },
    setMuted: (m: boolean) => {
      if (ref.current) ref.current.muted = m;
    },
    currentTimeMs: () => Math.round((ref.current?.currentTime ?? 0) * 1000),
    durationMs: () => {
      const d = ref.current?.duration ?? 0;
      return Number.isFinite(d) ? Math.round(d * 1000) : 0;
    },
    loopCount: () => loops.current,
    el: () => ref.current,
  }));

  // Count loops without an 'ended' event: looping videos never fire one.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onTime = () => {
      if (el.currentTime < lastTime.current - 0.5) {
        loops.current += 1;
        fired.current.clear(); // each loop re-arms the progress buckets
        onLoop?.();
      }
      lastTime.current = el.currentTime;

      const dur = el.duration;
      if (Number.isFinite(dur) && dur > 0) {
        const pct = (el.currentTime / dur) * 100;
        for (const bucket of [25, 50, 75, 95] as const) {
          if (pct >= bucket && !fired.current.has(bucket)) {
            fired.current.add(bucket);
            onProgress?.(bucket, Math.round(el.currentTime * 1000), Math.round(dur * 1000), loops.current);
          }
        }
      }
    };
    el.addEventListener('timeupdate', onTime);
    return () => el.removeEventListener('timeupdate', onTime);
  }, [onLoop, onProgress]);

  const src = playbackId ? `https://stream.mux.com/${playbackId}/low.mp4` : undefined;

  return (
    <video
      ref={ref}
      className="absolute inset-0 h-full w-full object-cover"
      poster={isLcpCandidate ? undefined : (poster ?? undefined)}
      muted
      loop
      playsInline
      // Load-bearing on older iOS: without it the video takes over fullscreen.
      // React passes unknown lowercase-hyphenated attributes straight through.
      {...{ 'webkit-playsinline': 'true' }}
      disablePictureInPicture
      disableRemotePlayback
      preload={stage === 'active' || stage === 'warm' ? 'auto' : stage === 'manifest' ? 'metadata' : 'none'}
      src={src}
      onError={onError}
      aria-hidden
    />
  );
}
