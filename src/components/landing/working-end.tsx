'use client';

import { useEffect, useRef, useState } from 'react';

const STEPS = [
  { n: '01', title: 'Full bleed', body: 'The video is the page. Chrome stays out of the way.' },
  { n: '02', title: 'One decision', body: 'Size, if there is one. Nothing else to choose.' },
  { n: '03', title: 'One tap', body: 'Apple Pay. No account, no address form, no app.' },
  { n: '04', title: 'Settled', body: 'Paid, label bought, tracking emailed. You pack the box.' },
];

/** A presentational replica of the money page — deliberately NOT the real
 *  drop-view component, which is Supabase- and Mux-backed and would give the
 *  landing page a database query and a 100KB player. */
function MoneyPage({ step }: { step: number }) {
  return (
    <div className="relative h-full w-full overflow-hidden bg-s1">
      {/* the seller's footage sits here; no asset exists yet */}
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="font-mono text-[0.6rem] tracking-mono-eyebrow text-fg-faint/60">
          NO SIGNAL
        </span>
      </div>

      <div className="absolute left-3 top-3 rounded-full bg-void/70 px-2.5 py-1 font-mono text-[0.6rem] text-fg backdrop-blur-sm">
        @mariposa
      </div>

      {/* buy console — solid, never backdrop-blurred: it sits inside a tilting,
          video-backed frame, where blur on scrolling content is a repaint trap */}
      <div
        className={`absolute inset-x-2.5 bottom-2.5 rounded-core bg-s2/[0.94] p-3.5 transition-all duration-[420ms] ease-instrument ${
          step >= 2 ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-95'
        }`}
        style={{ boxShadow: 'var(--inset-core)' }}
      >
        <div className="flex items-end justify-between gap-2">
          <div>
            <div className="font-display text-[0.9375rem] font-semibold leading-tight text-fg">
              Hand-dyed silk scarf
            </div>
            <div className="mt-0.5 font-mono text-[0.6rem] tracking-mono-label text-fg-faint">
              1 OF 6 · SHIPS TUE
            </div>
          </div>
          <div data-num className="font-mono text-[1.0625rem] font-medium text-fg">
            $48.00
          </div>
        </div>

        <div className="mt-3 flex gap-1.5">
          {['S', 'M', 'L'].map((s, i) => (
            <span
              key={s}
              className={`rounded-plate-core px-2.5 py-1 font-mono text-[0.65rem] transition-all duration-[200ms] ease-state ${
                step >= 1 && i === 1
                  ? 'bg-fg text-void'
                  : 'bg-white/[0.06] text-fg-muted'
              }`}
            >
              {s}
            </span>
          ))}
        </div>

        <div
          className={`mt-3 rounded-plate py-2.5 text-center font-display text-[0.9375rem] font-semibold transition-all duration-[300ms] ease-state ${
            step >= 2 ? 'scale-[0.97] bg-fg/50 text-void/60' : 'bg-fg text-void'
          }`}
        >
          Buy now · $48.00
        </div>
        <div className="mt-2 text-center font-mono text-[0.55rem] tracking-mono-label text-fg-faint">
          CHECKOUT BY STRIPE · NO ACCOUNT NEEDED
        </div>
      </div>

      {/* Apple Pay sheet — real native-sheet physics on the spring curve */}
      <div
        className="absolute inset-x-0 bottom-0 rounded-t-core bg-[#1c1c1e] p-4 transition-transform duration-[520ms]"
        style={{
          transform: step === 2 ? 'translateY(0)' : 'translateY(105%)',
          transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)',
        }}
        aria-hidden
      >
        <div className="mx-auto h-1 w-9 rounded-full bg-white/25" />
        <div className="mt-4 flex items-center justify-between border-b border-white/10 pb-3">
          <span className="font-display text-[0.8125rem] font-medium text-white"> Pay</span>
          <span data-num className="font-mono text-[0.8125rem] text-white">
            $53.95
          </span>
        </div>
        <div className="flex items-center justify-between py-2.5 font-mono text-[0.6rem] tracking-mono-label text-white/50">
          <span>SCARF</span>
          <span data-num>$48.00</span>
        </div>
        <div className="flex items-center justify-between pb-3 font-mono text-[0.6rem] tracking-mono-label text-white/50">
          <span>USPS GROUND</span>
          <span data-num>$5.95</span>
        </div>
        <div className="rounded-full bg-white py-2.5 text-center font-display text-[0.8125rem] font-semibold text-black">
          Confirm with side button
        </div>
      </div>

      {/* SETTLED */}
      <div
        className={`absolute inset-0 flex flex-col items-center justify-center bg-void/92 transition-opacity duration-[420ms] ease-instrument ${
          step === 3 ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <svg width="46" height="46" viewBox="0 0 46 46" fill="none" aria-hidden>
          <circle cx="23" cy="23" r="22" stroke="var(--color-signal)" strokeWidth="1" opacity="0.4" />
          <path
            d="M14 23.5L20.5 30L32 18"
            stroke="var(--color-signal)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              strokeDasharray: 30,
              strokeDashoffset: step === 3 ? 0 : 30,
              transition: 'stroke-dashoffset 600ms var(--ease-instrument) 120ms',
            }}
          />
        </svg>
        <div className="mt-4 font-mono text-[0.6rem] tracking-mono-eyebrow text-signal">PAID</div>
        <div
          className="mt-6 rounded-plate bg-s2 px-3 py-2 font-mono text-[0.6rem] tracking-mono-label text-fg-muted transition-all"
          style={{
            transform: step === 3 ? 'scale(1)' : 'scale(0.94)',
            opacity: step === 3 ? 1 : 0,
            transitionDuration: '450ms',
            transitionTimingFunction: 'var(--ease-stamp)', // the one licensed overshoot
            transitionDelay: '420ms',
          }}
        >
          $48.00 → YOU $46.31 · DRIP $0.00
        </div>
      </div>
    </div>
  );
}

export default function WorkingEnd() {
  const [step, setStep] = useState(0);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [spec, setSpec] = useState({ x: 50, y: 50 });
  const frame = useRef<HTMLDivElement>(null);
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const i = Number((e.target as HTMLElement).dataset.step);
            setStep(i);
          }
        }
      },
      { threshold: 0.6 }
    );
    stepRefs.current.forEach((n) => n && io.observe(n));
    return () => io.disconnect();
  }, []);

  // Pointer tilt + specular. Transform and opacity only, fine pointers only.
  useEffect(() => {
    const mqHover = window.matchMedia('(hover: hover) and (pointer: fine)');
    const mqMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!mqHover.matches || mqMotion.matches) return;

    const el = frame.current;
    if (!el) return;

    let target = { x: 0, y: 0 };
    let current = { x: 0, y: 0 };
    let raf = 0;

    const onMove = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const px = (ev.clientX - r.left) / r.width;
      const py = (ev.clientY - r.top) / r.height;
      target = { x: (0.5 - py) * 6, y: (px - 0.5) * 6 };
      setSpec({ x: px * 100, y: py * 100 });
    };

    const loop = () => {
      current = {
        x: current.x + (target.x - current.x) * 0.08,
        y: current.y + (target.y - current.y) * 0.08,
      };
      setTilt({ x: current.x, y: current.y });
      raf = requestAnimationFrame(loop);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    raf = requestAnimationFrame(loop);
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="grid gap-16 lg:grid-cols-12">
      {/* callout column */}
      <div className="lg:col-span-4">
        {STEPS.map((s, i) => (
          <div
            key={s.n}
            data-step={i}
            ref={(el) => {
              stepRefs.current[i] = el;
            }}
            className="border-t border-edge-1 py-8 transition-opacity duration-[420ms] ease-state lg:py-16"
            style={{ opacity: step === i ? 1 : 0.32 }}
          >
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-mono-s tracking-mono-eyebrow text-signal">{s.n}</span>
              <h3 className="font-display text-display-m font-semibold text-fg">{s.title}</h3>
            </div>
            <p className="mt-2 max-w-[34ch] text-body text-fg-muted">{s.body}</p>
          </div>
        ))}
      </div>

      {/* the frame */}
      <div className="lg:col-span-8">
        <div className="lg:sticky lg:top-[12vh]">
          {/* the URL, treated as a designed object: the link IS the product */}
          <div className="bezel mx-auto mb-8 w-max rounded-full bg-s2 p-1">
            <div className="rounded-full bg-s3 px-4 py-2 font-mono text-[0.8125rem]">
              <span className="opacity-40">drip.app/</span>
              <span className="text-fg">@mariposa</span>
              <span className="opacity-70">/silk-scarf</span>
            </div>
          </div>

          <div className="flex justify-center" style={{ perspective: '1800px' }}>
            <div
              ref={frame}
              className="bezel relative rounded-frame bg-white/[0.04] p-[10px] shadow-frame"
              style={{
                transform: `rotateY(${-9 + tilt.y}deg) rotateX(${3 + tilt.x}deg)`,
                transformStyle: 'preserve-3d',
              }}
            >
              <div
                className="relative w-[300px] overflow-hidden rounded-frame-core sm:w-[340px]"
                style={{ aspectRatio: '9 / 16' }}
              >
                <MoneyPage step={step} />
                {/* specular highlight — glass catching light, one div */}
                <div
                  className="pointer-events-none absolute inset-0 hidden lg:block"
                  style={{
                    background: `radial-gradient(400px circle at ${spec.x}% ${spec.y}%, rgba(255,255,255,0.14), transparent 60%)`,
                    mixBlendMode: 'soft-light',
                    opacity: 0.5,
                  }}
                  aria-hidden
                />
              </div>
            </div>
          </div>

          <p className="mt-8 text-center font-mono text-mono-s tracking-mono-label text-fg-faint">
            FIG. 5 — THE BUYER&apos;S SCREEN, UNMODIFIED.
          </p>
        </div>
      </div>
    </div>
  );
}
