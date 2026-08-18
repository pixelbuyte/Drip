'use client';

import { useEffect, useRef, useState } from 'react';

// One instrument with unequal bays (5/4/3), not three floating cards — the
// deliberate escape from the symmetric thirds grid every template ships.
export default function Bays() {
  const root = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        setLive(true);
      },
      { threshold: 0.3 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={root} className="bezel rounded-shell bg-s2 p-2 shadow-module">
      <div
        className="grid grid-cols-1 rounded-core bg-s3 md:grid-cols-12"
        style={{ boxShadow: 'var(--inset-core)' }}
      >
        {/* BAY 01 — INGEST (5 cols) */}
        <div className="group border-b border-edge-1 p-7 transition-[transform,background-color] duration-[240ms] ease-state hover:bg-s4 md:col-span-5 md:border-b-0 md:border-r md:hover:-translate-y-[2px]">
          <div className="font-mono text-mono-s tracking-mono-eyebrow text-fg-faint">
            01 · INGEST
          </div>
          <h3 className="mt-4 font-display text-display-m font-semibold text-fg">Upload once</h3>
          <p className="mt-2 max-w-[34ch] text-body text-fg-muted">
            One vertical clip, up to 60 seconds — the same one you shot for your feed.
          </p>
          <div className="mt-6 flex items-end gap-4">
            <div
              className="relative w-[74px] shrink-0 overflow-hidden rounded-well bg-s1"
              style={{ aspectRatio: '9 / 16' }}
            >
              <div className="bezel absolute inset-0 rounded-well" />
              <div
                className="absolute inset-x-0 bottom-0 origin-bottom bg-fg/[0.07] transition-transform duration-[1100ms] ease-instrument"
                style={{ height: '100%', transform: `scaleY(${live ? 1 : 0})` }}
              />
            </div>
            <div className="pb-1 font-mono text-mono-s leading-[1.7] tracking-mono-label text-fg-faint">
              MUX · H.264
              <br />
              ≤60s
              <br />
              9:16
            </div>
          </div>
          <p className="mt-4 font-mono text-mono-s tracking-mono-label text-fg-faint">FIG. 2</p>
        </div>

        {/* BAY 02 — PRICE (4 cols) */}
        <div className="group border-b border-edge-1 p-7 transition-[transform,background-color] duration-[240ms] ease-state hover:bg-s4 md:col-span-4 md:border-b-0 md:border-r md:hover:-translate-y-[2px]">
          <div className="font-mono text-mono-s tracking-mono-eyebrow text-fg-faint">
            02 · PRICE
          </div>
          <h3 className="mt-4 font-display text-display-m font-semibold text-fg">Tag the price</h3>
          <p className="mt-2 max-w-[30ch] text-body text-fg-muted">
            Price, inventory, sizes. Drip weighs the parcel and quotes the postage.
          </p>
          <div className="mt-6 space-y-2">
            <div className="bezel flex items-center justify-between rounded-plate bg-s1 px-3 py-2">
              <span className="font-mono text-mono-s tracking-mono-label text-fg-faint">PRICE</span>
              <span
                data-num
                className="font-mono text-mono-l text-fg transition-opacity duration-[420ms] ease-quick"
                style={{ opacity: live ? 1 : 0 }}
              >
                $48.00
              </span>
            </div>
            <div className="bezel flex items-center justify-between rounded-plate bg-s1 px-3 py-2">
              <span className="font-mono text-mono-s tracking-mono-label text-fg-faint">STOCK</span>
              <span data-num className="font-mono text-mono-l text-fg">
                6
              </span>
            </div>
            <div className="flex gap-1.5 pt-1">
              {['S', 'M', 'L'].map((s, i) => (
                <span
                  key={s}
                  className={`rounded-plate-core px-3 py-1.5 font-mono text-mono-s transition-all duration-[200ms] ease-state ${
                    live && i === 1
                      ? 'bg-fg text-void'
                      : 'bezel bg-s1 text-fg-muted'
                  }`}
                  style={{ transitionDelay: `${140 + i * 60}ms` }}
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
          <p className="mt-4 font-mono text-mono-s tracking-mono-label text-fg-faint">FIG. 3</p>
        </div>

        {/* BAY 03 — SHIP (3 cols) */}
        <div className="group p-7 transition-[transform,background-color] duration-[240ms] ease-state hover:bg-s4 md:col-span-3 md:hover:-translate-y-[2px]">
          <div className="font-mono text-mono-s tracking-mono-eyebrow text-fg-faint">03 · SHIP</div>
          <h3 className="mt-4 font-display text-display-m font-semibold text-fg">Share one link</h3>
          <p className="mt-2 max-w-[26ch] text-body text-fg-muted">
            Put it in your bio. The label prints itself.
          </p>
          <div className="bezel mt-6 rounded-plate bg-s1 p-3">
            <div className="font-mono text-mono-s tracking-mono-label text-fg-faint">
              USPS GROUND ADVANTAGE
            </div>
            {/* the barcode prints, 12ms stagger — the detail of this section */}
            <div className="mt-2 flex h-9 items-end gap-px" aria-hidden>
              {Array.from({ length: 40 }).map((_, i) => (
                <span
                  key={i}
                  className="block origin-bottom bg-fg/70 transition-transform duration-[260ms] ease-quick"
                  style={{
                    width: i % 3 === 0 ? 2 : 1,
                    height: `${55 + ((i * 37) % 45)}%`,
                    transform: `scaleY(${live ? 1 : 0})`,
                    transitionDelay: `${300 + i * 12}ms`,
                  }}
                />
              ))}
            </div>
            <div className="mt-2 font-mono text-[0.6rem] tracking-mono-label text-fg-muted">
              9400 1000 0000 0000
            </div>
          </div>
          <p className="mt-4 font-mono text-mono-s tracking-mono-label text-fg-faint">FIG. 4</p>
        </div>
      </div>
    </div>
  );
}
