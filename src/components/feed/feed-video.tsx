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
  isLcpCandidate,
}: {
  playbackId: string | null;
  poster: string | null;
  stage: PreloadStage;
  handleRef: Ref<FeedVideoHandle>;
  onError?: () => void;
  onLoop?: () => void;
  isLcpCandidate?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const loops = useRef(0);
  const lastTime = useRef(0);

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

  // Count loops without a 'ended' event: loop videos never fire it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onTime = () => {
      if (el.currentTime < lastTime.current - 0.5) {
        loops.current += 1;
        onLoop?.();
      }
      lastTime.current = el.currentTime;
    };
    el.addEventListener('timeupdate', onTime);
    return () => el.removeEventListener('timeupdate', onTime);
  }, [onLoop]);

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
