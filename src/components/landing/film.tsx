'use client';

import { useRef, useState } from 'react';

// preload="none" and no autoplay: the film is 3MB and must never compete with
// the hero for bandwidth. The poster is the video's own first frame, so the
// swap on play is invisible.
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
    <div className="bezel rounded-shell bg-s2 p-2 shadow-module">
      <div
        className="relative overflow-hidden rounded-core bg-s1"
        style={{ aspectRatio: '16 / 9', boxShadow: 'var(--inset-core)' }}
      >
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
            aria-label="Play the Drip launch film, 35 seconds, no sound"
          >
            <span className="bezel flex items-center gap-4 rounded-full bg-s2/80 py-2 pl-6 pr-2 backdrop-blur-xl transition-transform duration-[240ms] ease-state group-hover:scale-[1.02] group-active:scale-[0.985]">
              <span className="text-[0.9375rem] font-medium text-fg">Play the film</span>
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-fg">
                <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden>
                  <path d="M1 1L10 6L1 11V1Z" fill="var(--color-void)" />
                </svg>
              </span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
