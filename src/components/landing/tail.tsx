'use client';

import { useEffect, useRef, useState } from 'react';

const NODES = [
  { label: 'PAID', t: '0.0s', tone: 'signal' },
  { label: 'LABEL PURCHASED', t: '+2.4s', tone: 'warn' },
  { label: 'PACKING SLIP EMAILED', t: '+2.8s', tone: 'warn' },
  { label: 'SCANNED', t: '+1d', tone: 'signal' },
  { label: 'DELIVERED', t: '+3d', tone: 'signal' },
] as const;

const tones = {
  signal: 'bg-signal',
  warn: 'bg-warn',
} as const;

// The page's only scrubbed element: the rail fills as you read across it.
export default function Tail() {
  const root = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(0);

  useEffect(() => {
    const el = root.current;
    if (!el) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) {
      setP(1);
      return;
    }

    let raf = 0;
    let running = false;

    const measure = () => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // 0 when the rail enters the lower third, 1 once it passes the middle
      const raw = (vh * 0.85 - r.top) / (r.height + vh * 0.35);
      setP(Math.min(1, Math.max(0, raw)));
      if (running) raf = requestAnimationFrame(measure);
    };

    // rAF loop scoped to intersection — no scroll listener, cancelled on exit
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !running) {
        running = true;
        raf = requestAnimationFrame(measure);
      } else if (!e.isIntersecting && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    });
    io.observe(el);

    return () => {
      io.disconnect();
      running = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={root}>
      {/* desktop: horizontal rail */}
      <div className="relative hidden md:block">
        <div className="absolute inset-x-0 top-[7px] h-px bg-edge-1" aria-hidden />
        <div
          className="absolute left-0 top-[7px] h-px origin-left bg-fg/50"
          style={{ width: '100%', transform: `scaleX(${p})` }}
          aria-hidden
        />
        <div className="relative grid grid-cols-5">
          {NODES.map((n, i) => {
            const reached = p >= (i + 0.4) / NODES.length;
            return (
              <div key={n.label} className="pr-6">
                <span
                  className={`block h-[15px] w-[15px] rounded-full transition-transform duration-[320ms] ease-state ${
                    reached ? tones[n.tone] : 'bg-edge-2'
                  }`}
                  style={{ transform: `scale(${reached ? 1 : 0.55})` }}
                />
                <div
                  className={`mt-5 font-mono text-mono-s tracking-mono-label transition-colors duration-[320ms] ${
                    reached ? 'text-fg' : 'text-fg-faint'
                  }`}
                >
                  {n.label}
                </div>
                <div data-num className="mt-1 font-mono text-mono-s text-fg-faint">
                  {n.t}
                </div>
                {n.label === 'SCANNED' && (
                  <div className="mt-2 font-mono text-[0.6rem] text-fg-faint/80">
                    9400 1000 0000 0000
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* mobile: vertical rail with a left spine */}
      <div className="relative md:hidden">
        <div className="absolute bottom-0 left-[7px] top-0 w-px bg-edge-1" aria-hidden />
        <div
          className="absolute left-[7px] top-0 h-full w-px origin-top bg-fg/50"
          style={{ transform: `scaleY(${p})` }}
          aria-hidden
        />
        <div className="space-y-8">
          {NODES.map((n, i) => {
            const reached = p >= (i + 0.4) / NODES.length;
            return (
              <div key={n.label} className="relative pl-8">
                <span
                  className={`absolute left-0 top-1 h-[15px] w-[15px] rounded-full transition-transform duration-[320ms] ease-state ${
                    reached ? tones[n.tone] : 'bg-edge-2'
                  }`}
                  style={{ transform: `scale(${reached ? 1 : 0.55})` }}
                />
                <div
                  className={`font-mono text-mono-s tracking-mono-label ${
                    reached ? 'text-fg' : 'text-fg-faint'
                  }`}
                >
                  {n.label}
                </div>
                <div data-num className="mt-1 font-mono text-mono-s text-fg-faint">
                  {n.t}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
