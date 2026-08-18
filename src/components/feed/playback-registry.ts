'use client';

/**
 * One owner for playback, rather than a per-slide "am I current?" effect.
 * Per-slide effects run in unpredictable order relative to each other's
 * cleanup, and you reliably get a frame with two videos playing.
 */
export type FeedVideoHandle = {
  play(): Promise<void>;
  pauseAndReset(): void;
  pauseHold(): void;
  resume(): void;
  setMuted(m: boolean): void;
  currentTimeMs(): number;
  durationMs(): number;
  loopCount(): number;
  el(): HTMLVideoElement | null;
};

export type Registry = Map<number, FeedVideoHandle>;

export type PreloadStage = 'active' | 'warm' | 'manifest' | 'cold';

export const WINDOW_BEFORE = 1;
export const WINDOW_AFTER = 2;

export function stageFor(index: number, committed: number): PreloadStage | null {
  if (index === committed) return 'active';
  if (index === committed + 1) return 'warm';
  if (index === committed + 2) return 'manifest';
  if (index === committed - WINDOW_BEFORE) return 'cold';
  return null;
}
