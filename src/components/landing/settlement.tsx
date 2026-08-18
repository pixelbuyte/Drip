'use client';

import { useEffect, useRef, useState } from 'react';
import Clock from './clock';

const READOUT = [
  { label: 'TAP', value: '0.0s' },
  { label: 'APPLE PAY', value: '1.2s' },
  { label: 'PAID $48.00', value: '1.9s', signal: true },
  { label: 'USPS LABEL', value: '2.4s' },
  { label: 'TRACKING SENT', value: '2.8s' },
];

// Real arithmetic, checked on the page: round(4800 * 0.029) + 30 = 169c,
// and 4800 - 169 = 4631c. The audience will verify this.
const SALE = 4800;
const FEE = Math.round(SALE * 0.029) + 30;
const NET = SALE - FEE;
const money = (c: number) => (c / 100).toFixed(2);

/** Fixed-slot numeral. Counting from $00.00 rather than $0.00 keeps the glyph
 *  count identical for the whole run, so reflow is structurally impossible
 *  rather than merely discouraged by tabular-nums. */
function Numeral({ cents }: { cents: number }) {
  const [int, dec] = money(cents).split('.');
  const ints = int.padStart(2, '0').split('');
  return (
    <span data-num className="font-mono text-data-xl font-medium tabular-nums text-fg">
      <span className="text-[0.55em] opacity-60">$</span>
      {ints.map((d, i) => (
        <span key={i} className="inline-block w-[1ch] text-center">
          {d}
        </span>
      ))}
      <span className="text-[0.7em]">
        <span className="inline-block w-[0.6ch] text-center">.</span>
        {dec.split('').map((d, i) => (
          <span key={i} className="inline-block w-[1ch] text-center">
            {d}
          </span>
        ))}
      </span>
    </span>
  );
}

type Phase = 'idle' | 'running' | 'settled';

export default function Settlement() {
  const root = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [cents, setCents] = useState(0);
  const [lines, setLines] = useState(0);
  const [dot, setDot] = useState<'faint' | 'warn' | 'signal'>('faint');
  const [scan, setScan] = useState(false);
  const [plate, setPlate] = useState(false);

  useEffect(() => {
    const el = root.current;
    if (!el) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const resolve = () => {
      setCents(SALE);
      setLines(READOUT.length);
      setDot('signal');
      setPlate(true);
      setPhase('settled');
    };

    if (reduced.matches) {
      resolve();
      return;
    }

    const timers: ReturnType<typeof setTimeout>[] = [];
    let raf = 0;

    const run = () => {
      setPhase('running');

      // Readout lines wipe in — a mask, not character typing. Typing is a gimmick.
      READOUT.forEach((_, i) => {
        timers.push(setTimeout(() => setLines(i + 1), 260 + i * 90));
      });

      timers.push(setTimeout(() => setDot('warn'), 380));
      timers.push(setTimeout(() => setScan(true), 780));
      timers.push(setTimeout(() => setDot('signal'), 1180));
      timers.push(setTimeout(() => setPlate(true), 2900));
      timers.push(setTimeout(() => setPhase('settled'), 3600));

      // Count-up on the house curve, 1900ms, ending with the page at rest.
      const start = performance.now() + 260;
      const dur = 1900;
      const tick = (now: number) => {
        const t = Math.min(1, Math.max(0, (now - start) / dur));
        // approximates cubic-bezier(0.32, 0.72, 0, 1)
        const eased = 1 - Math.pow(1 - t, 3);
        setCents(Math.round(SALE * eased));
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        run();
      },
      { threshold: 0.35 }
    );
    io.observe(el);

    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
      cancelAnimationFrame(raf);
    };
  }, []);

  const dotColor =
    dot === 'signal' ? 'bg-signal' : dot === 'warn' ? 'bg-warn' : 'bg-fg-faint';

  return (
    <div ref={root} className="relative">
      {/* USPS label plate — slides out from behind the module's left edge and
          settles once. This is what turns "we take payments" into "we run
          your fulfilment", which is the actual gap versus a payment link. */}
      <div
        className={`bezel absolute -left-4 top-[58%] z-0 hidden rounded-plate bg-s2 p-1 shadow-module transition-all duration-[700ms] ease-instrument sm:block ${
          plate
            ? '-translate-x-[72%] rotate-[-3deg] opacity-100'
            : 'translate-x-6 rotate-0 opacity-0'
        }`}
        aria-hidden
      >
        <div className="rounded-plate-core bg-s1 px-3 py-2.5">
          <div className="font-mono text-mono-s tracking-mono-label text-fg-faint">
            USPS GROUND ADVANTAGE
          </div>
          <div className="mt-1 font-mono text-mono text-fg">9400 1000 0000 0000 0000 00</div>
          <div className="mt-2 flex h-6 items-end gap-px" aria-hidden>
            {Array.from({ length: 40 }).map((_, i) => (
              <span
                key={i}
                className="block bg-fg/70"
                style={{
                  width: i % 3 === 0 ? 2 : 1,
                  height: `${55 + ((i * 37) % 45)}%`,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* THE MODULE */}
      <div className="bezel relative z-10 rounded-shell bg-s2 p-2 shadow-module">
        <div
          className={`relative overflow-hidden rounded-core p-0 transition-colors duration-[900ms] ease-instrument ${
            phase === 'idle' ? 'bg-s1' : 'bg-s3'
          }`}
          style={{ boxShadow: 'var(--inset-core)' }}
        >
          {/* one-time scan line marking the PAID beat */}
          <div
            className={`pointer-events-none absolute inset-x-0 top-0 z-20 h-[2px] bg-signal/35 blur-[1px] transition-transform duration-[900ms] ease-instrument ${
              scan ? 'translate-y-[420px] opacity-0' : '-translate-y-2 opacity-100'
            }`}
            aria-hidden
          />

          {/* header plate */}
          <div className="flex h-9 items-center justify-between border-b border-edge-1 px-3">
            <div className="flex items-center gap-2">
              <span
                className={`h-[5px] w-[5px] rounded-full transition-colors duration-[400ms] ease-state ${dotColor}`}
              />
              <span className="font-mono text-mono-s tracking-mono-label text-fg-faint">
                DRIP · SETTLEMENT
              </span>
            </div>
            <Clock className="text-fg-faint" />
          </div>

          {/* body: input on the left, process on the right */}
          <div className="flex">
            <div className="shrink-0 p-4 pr-3">
              <div
                className="relative w-[88px] overflow-hidden rounded-well bg-s1 sm:w-[112px]"
                style={{ aspectRatio: '9 / 16' }}
              >
                <div className="absolute inset-0 bezel rounded-well" />
                {/* No footage exists in the repo yet. An honest empty
                    instrument beats a gradient blob pretending to be video. */}
                <div className="absolute inset-0 flex items-center justify-center px-2 text-center">
                  <span className="font-mono text-[0.5rem] leading-relaxed tracking-mono-label text-fg-faint/70">
                    NO SIGNAL
                    <br />
                    AWAITING
                    <br />
                    SOURCE
                  </span>
                </div>
              </div>
              <div className="mt-2 w-[88px] font-mono text-[0.5rem] leading-[1.5] tracking-mono-label text-fg-faint sm:w-[112px]">
                @MARIPOSA
                <br />
                HAND-DYED SILK
                <br />1 OF 6
              </div>
            </div>

            <div className="w-px shrink-0 bg-edge-1" aria-hidden />

            <div className="min-w-0 flex-1 p-4">
              <ul className="space-y-2">
                {READOUT.map((r, i) => (
                  <li
                    key={r.label}
                    className="flex items-baseline gap-2 font-mono text-mono text-fg-muted transition-all duration-[340ms] ease-quick"
                    style={{
                      clipPath: i < lines ? 'inset(0 0 0 0)' : 'inset(0 100% 0 0)',
                      opacity: i < lines ? 1 : 0.25,
                    }}
                  >
                    <span className={r.signal ? 'text-signal' : undefined}>{r.label}</span>
                    <span
                      aria-hidden
                      className="min-w-4 flex-1 -translate-y-[3px] border-b border-dotted border-current opacity-[0.28]"
                    />
                    <span data-num className="shrink-0 text-fg">
                      {r.value}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-5 border-t border-edge-1 pt-4">
                <div className="font-mono text-mono-s tracking-mono-label text-fg-faint">
                  NET TO SELLER
                </div>
                <div className="mt-1">
                  <Numeral cents={cents} />
                </div>
              </div>
            </div>
          </div>

          {/* footer plate — the honesty rendered as instrumentation */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-edge-1 px-4 py-3 font-mono text-mono-s tracking-mono-label text-fg-faint sm:flex sm:items-center sm:justify-between">
            <span>SALE ${money(SALE)}</span>
            <span>PROCESSING ${money(FEE)}</span>
            <span className="text-signal">DRIP $0.00</span>
            <span className="text-fg">NET ${money(NET)}</span>
          </div>
        </div>
      </div>

      <p className="mt-3 font-mono text-mono-s tracking-mono-label text-fg-faint">
        FIG. 1 — SETTLEMENT, ONE SALE, REAL ARITHMETIC.
      </p>
    </div>
  );
}
