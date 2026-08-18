'use client';

import { useEffect, useRef, useState } from 'react';

// Every figure here is literally true. A pre-launch site that invents traction
// metrics loses this audience faster than one that shows nothing.
const CELLS = [
  { label: 'DRIP COMMISSION', figure: '0%' },
  { label: 'CARD PROCESSING', figure: '2.9% + 30¢' },
  { label: 'LINKS TO SHARE', figure: '1' },
  { label: 'TAPS TO PAID', figure: '2' },
];

const GLYPHS = '0123456789%+¢';

export default function Rail() {
  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const [scramble, setScramble] = useState<string[]>(CELLS.map((c) => c.figure));

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        setShown(true);
        if (reduced.matches) return;

        // 500ms scramble through mono glyphs, then lock. Fires once.
        const start = performance.now();
        let raf = 0;
        const tick = (now: number) => {
          const t = (now - start) / 500;
          if (t >= 1) {
            setScramble(CELLS.map((c) => c.figure));
            return;
          }
          setScramble(
            CELLS.map((c) =>
              c.figure
                .split('')
                .map((ch) =>
                  ch === ' ' || Math.random() < t
                    ? ch
                    : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
                )
                .join('')
            )
          );
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={root} className="grid grid-cols-2 md:grid-cols-4">
      {CELLS.map((c, i) => (
        <div key={c.label} className="relative px-5 py-8 md:px-8">
          {/* dividing hairlines draw downward, staggered */}
          {i > 0 && (
            <span
              aria-hidden
              className="absolute left-0 top-0 hidden h-full w-px origin-top bg-edge-2 transition-transform duration-[700ms] ease-instrument md:block"
              style={{
                transform: `scaleY(${shown ? 1 : 0})`,
                transitionDelay: `${i * 90}ms`,
              }}
            />
          )}
          <div className="font-mono text-mono-s tracking-mono-eyebrow text-fg-faint">
            {c.label}
          </div>
          <div
            data-num
            className="mt-3 font-mono text-[1.75rem] font-medium tabular-nums tracking-[-0.02em] text-fg"
          >
            {scramble[i]}
          </div>
        </div>
      ))}
    </div>
  );
}
