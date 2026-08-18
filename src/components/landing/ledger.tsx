'use client';

import { useState } from 'react';

// Integer cents throughout — never float dollars. Spot-checks:
// $10 → fee 59¢, net $9.41 · $48 → fee $1.69, net $46.31 · $500 → fee $14.80.
const RATES_VERIFIED = '18 August 2026';

const fmt = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Ledger() {
  const [price, setPrice] = useState(4800);

  const fee = Math.round(price * 0.029) + 30;
  const net = price - fee;

  const rivals = [
    { name: 'Drip', commission: 0 },
    { name: 'Whatnot', commission: Math.round(price * 0.08) },
    { name: 'TikTok Shop', commission: Math.round(price * 0.09) },
    // Poshmark: flat $2.95 under $15, otherwise 20%
    { name: 'Poshmark', commission: price >= 1500 ? Math.round(price * 0.2) : 295 },
  ];
  const maxBar = Math.max(...rivals.map((r) => r.commission), 1);
  const t = (price - 1000) / (50000 - 1000);

  return (
    <div className="grid gap-12 lg:grid-cols-12">
      {/* LEFT — the ledger, as a real accounting document */}
      <div className="lg:col-span-7">
        <div className="bezel-paper rounded-shell bg-black/[0.03] p-2">
          <div
            className="rounded-core bg-bone-card p-6 sm:p-8"
            style={{ boxShadow: 'var(--inset-paper), var(--shadow-paper)' }}
          >
            <table className="w-full font-mono text-mono-l">
              <caption className="pb-5 text-left font-display text-mono-s tracking-mono-eyebrow text-bone-faint">
                STATEMENT · ONE SALE
              </caption>
              <tbody className="text-bone-muted">
                <tr className="border-b border-bone-edge">
                  <td className="py-2.5">Sale price</td>
                  <td data-num className="py-2.5 text-right text-bone-ink">
                    {fmt(price)}
                  </td>
                </tr>
                <tr className="border-b border-bone-edge">
                  <td className="py-2.5">Card processing (2.9% + 30¢)</td>
                  <td data-num className="py-2.5 text-right text-bone-ink">
                    −{fmt(fee)}
                  </td>
                </tr>
                <tr className="border-b border-bone-edge">
                  <td className="py-2.5">Drip commission</td>
                  <td data-num className="py-2.5 text-right text-signal-ink">
                    0.00
                  </td>
                </tr>
                <tr>
                  <td className="py-2.5">Shipping (buyer paid)</td>
                  <td data-num className="py-2.5 text-right text-bone-ink">
                    0.00
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  {/* genuine double rule — the actual accounting convention */}
                  <td colSpan={2} className="pt-1">
                    <div className="h-px bg-bone-ink/70" />
                    <div className="mt-[3px] h-px bg-bone-ink/70" />
                  </td>
                </tr>
                <tr>
                  <td className="pt-3 font-display text-[1rem] font-semibold text-bone-ink">
                    You receive
                  </td>
                  <td
                    data-num
                    className="pt-3 text-right font-mono text-[1.375rem] font-medium text-bone-ink"
                  >
                    {fmt(net)}
                  </td>
                </tr>
              </tfoot>
            </table>

            {/* the drag handle: a native range at opacity 0 over a designed
                track, so keyboard and screen-reader support come free */}
            <div className="mt-8">
              <label
                htmlFor="price"
                className="flex items-baseline justify-between font-mono text-mono-s tracking-mono-label text-bone-faint"
              >
                <span>DRAG TO YOUR PRICE</span>
                <span data-num className="text-bone-ink">
                  ${fmt(price)}
                </span>
              </label>
              <div className="relative mt-3 h-11">
                <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-bone-ink/15" />
                <div
                  className="absolute top-1/2 h-px -translate-y-1/2 bg-bone-ink/60"
                  style={{ left: 0, width: `${t * 100}%` }}
                />
                <div
                  className="pointer-events-none absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-bone-card transition-transform duration-[240ms] ease-state"
                  style={{
                    left: `${t * 100}%`,
                    boxShadow: '0 1px 2px rgba(11,13,16,0.25), 0 0 0 1px rgba(11,13,16,0.12)',
                  }}
                />
                <input
                  id="price"
                  type="range"
                  min={1000}
                  max={50000}
                  step={100}
                  value={price}
                  onChange={(e) => setPrice(Number(e.target.value))}
                  className="absolute inset-0 h-11 w-full cursor-ew-resize opacity-0"
                  aria-label="Sale price"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT — commission compared. Drip is a tick at zero, not a short bar:
          a bar of nothing reads at thumbnail size. */}
      <div className="lg:col-span-5">
        <div className="font-mono text-mono-s tracking-mono-eyebrow text-bone-faint">
          COMMISSION ON THIS SALE
        </div>
        <div className="mt-6 space-y-5">
          {rivals.map((r) => (
            <div key={r.name}>
              <div className="flex items-baseline justify-between">
                <span className="font-display text-[0.9375rem] font-medium text-bone-ink">
                  {r.name}
                </span>
                <span
                  data-num
                  className={`font-mono text-mono-l ${
                    r.commission === 0 ? 'text-signal-ink' : 'text-bone-muted'
                  }`}
                >
                  {fmt(r.commission)}
                </span>
              </div>
              <div className="relative mt-2 h-[6px] bg-bone-ink/[0.06]">
                {r.commission === 0 ? (
                  <span className="absolute left-0 top-1/2 h-[14px] w-[2px] -translate-y-1/2 bg-signal-ink" />
                ) : (
                  <span
                    className="absolute inset-y-0 left-0 origin-left bg-bone-ink/70 transition-[width] duration-[240ms] ease-state"
                    style={{ width: `${(r.commission / maxBar) * 100}%` }}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-8 max-w-[46ch] font-mono text-mono-s leading-[1.7] text-bone-faint">
          Commission rates as published by each platform, verified {RATES_VERIFIED}. Card
          processing is additional on all four. Poshmark charges a flat $2.95 on sales under $15.
        </p>
      </div>
    </div>
  );
}
