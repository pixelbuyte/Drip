'use client';

import { useRef, useState } from 'react';

export default function Film() {
  const [playing, setPlaying] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  const start = () => {
    setPlaying(true);
    const v = video.current;
    if (!v) return;
    v.preload = 'auto';
    v.controls = true;
    void v.play();
  };

  return (
    <div className="rounded-banner bg-card p-2 shadow-card">
      <div className="relative overflow-hidden rounded-[20px] bg-cream" style={{ aspectRatio: '16 / 9' }}>
        <video
          ref={video}
          poster="/media/drip-launch-poster.jpg"
          preload="none"
          playsInline
          muted
          className="absolute inset-0 h-full w-full"
          onEnded={() => setPlaying(false)}
        >
          <source src="/media/drip-launch.webm" type="video/webm" />
          <source src="/media/drip-launch.mp4" type="video/mp4" />
        </video>

        {!playing && (
          <button
            onClick={start}
            className="group absolute inset-0 flex items-center justify-center"
            aria-label="Play the Drip film, 30 seconds, no sound"
          >
            <span className="flex items-center gap-3 rounded-full bg-card py-2 pl-6 pr-2 shadow-float transition-transform duration-200 group-hover:scale-[1.03] group-active:scale-[0.97]">
              <span className="text-[15px] font-bold text-ink">Play the film</span>
              <span className="grid h-9 w-9 place-items-center rounded-full bg-coral">
                <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden>
                  <path d="M1 1L10 6L1 11V1Z" fill="var(--color-ink)" />
                </svg>
              </span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
