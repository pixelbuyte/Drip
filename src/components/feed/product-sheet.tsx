'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeedProduct } from '@/lib/feed/types';
import { emit } from '@/lib/events/client';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

type Detent = 'peek' | 'full';

/**
 * Bottom sheet over a paused, dimmed video. The video pauses but does NOT
 * unload — dismissing resumes the same frame.
 *
 * Variants are chips, not dropdowns, and out-of-stock options are shown struck
 * through rather than hidden: seeing a sold-out size builds urgency and trust,
 * and hiding it makes the shopper wonder whether it ever existed.
 */
export default function ProductSheet({
  product,
  videoId,
  onClose,
  onCheckout,
}: {
  product: FeedProduct | null;
  videoId: string;
  onClose: () => void;
  onCheckout: (selection: Record<string, string>, quantity: number) => void;
}) {
  const [detent, setDetent] = useState<Detent>('peek');
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(1);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<number | null>(null);

  useEffect(() => {
    if (!product) return;
    setDetent('peek');
    setQuantity(1);
    // Preselect a single-option group so the buy button is never blocked on a
    // choice the shopper does not actually have.
    const preset: Record<string, string> = {};
    for (const g of product.variants) {
      const live = g.options.filter((o) => o.inventoryCount > 0);
      if (live.length === 1) preset[g.name] = live[0].value;
    }
    setSelection(preset);
  }, [product]);

  useEffect(() => {
    if (!product) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [product, onClose]);

  const unitCents = useMemo(() => {
    if (!product) return 0;
    let cents = product.priceCents;
    for (const g of product.variants) {
      const chosen = g.options.find((o) => o.value === selection[g.name]);
      if (chosen) cents += chosen.priceDeltaCents;
    }
    return cents;
  }, [product, selection]);

  if (!product) return null;

  const needsChoice = product.variants.some((g) => !selection[g.name]);
  const soldOut = product.inventoryCount <= 0;
  const total = unitCents * quantity;

  const height = detent === 'full' ? '92dvh' : '45dvh';

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <div
        className="absolute inset-0 bg-black/55"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={product.title}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 flex flex-col rounded-t-[24px] bg-card outline-none"
        style={{
          height,
          transition: 'height 280ms cubic-bezier(0.32,0.72,0,1)',
          paddingBottom: 'env(safe-area-inset-bottom,0px)',
        }}
        onTouchStart={(e) => (dragStart.current = e.touches[0].clientY)}
        onTouchEnd={(e) => {
          const start = dragStart.current;
          dragStart.current = null;
          if (start === null) return;
          const dy = e.changedTouches[0].clientY - start;
          if (dy < -60) setDetent('full');
          else if (dy > 90) {
            if (detent === 'full') setDetent('peek');
            else onClose();
          }
        }}
      >
        <button
          onClick={() => setDetent((d) => (d === 'peek' ? 'full' : 'peek'))}
          aria-label={detent === 'peek' ? 'Expand details' : 'Collapse details'}
          className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-ink/15"
        />

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3">
          <div
            className="art relative mb-4 aspect-[4/5] w-full max-w-[220px] overflow-hidden rounded-art"
            style={{ background: 'linear-gradient(135deg,#ffe3d8,#ffc9b5)', containerType: 'inline-size' }}
            aria-hidden
          >
            <span className="absolute left-1/2 top-[55%] -translate-x-1/2 -translate-y-1/2 text-[52cqw] leading-none">
              🛍️
            </span>
          </div>

          <h2 className="text-[18px] font-bold leading-snug text-ink">{product.title}</h2>

          <div className="mt-2 flex items-baseline gap-2">
            <span data-num className="text-[22px] font-extrabold text-ink">{money(unitCents)}</span>
            {product.compareAtPriceCents && product.compareAtPriceCents > unitCents && (
              <span data-num className="text-[15px] text-muted line-through">
                {money(product.compareAtPriceCents)}
              </span>
            )}
          </div>

          {product.inventoryCount > 0 && product.inventoryCount <= product.lowStockThreshold && (
            <p className="mt-1 text-[13px] font-semibold text-coral-deep">
              Only {product.inventoryCount} left
            </p>
          )}

          {product.variants.map((g) => (
            <fieldset key={g.name} className="mt-5">
              <legend className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">
                {g.name}
              </legend>
              <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label={g.name}>
                {g.options.map((o) => {
                  const out = o.inventoryCount <= 0;
                  const active = selection[g.name] === o.value;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      aria-disabled={out}
                      aria-label={out ? `${o.value}, out of stock` : o.value}
                      disabled={out}
                      onClick={() => {
                        setSelection((s) => ({ ...s, [g.name]: o.value }));
                        emit({ t: 'variant_select', v: videoId, p: product.id, meta: { group: g.name, value: o.value } });
                      }}
                      className={`min-h-11 min-w-11 rounded-[12px] border px-4 text-[14px] font-semibold transition-colors ${
                        out
                          ? 'cursor-not-allowed border-hairline text-muted line-through'
                          : active
                            ? 'border-ink bg-ink text-cream'
                            : 'border-hairline-strong bg-card text-ink'
                      }`}
                    >
                      {o.value}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}

          <div className="mt-5 flex items-center gap-3">
            <span className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Qty</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Decrease quantity"
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                className="grid h-11 w-11 place-items-center rounded-full border border-hairline-strong text-[18px] text-ink"
              >
                −
              </button>
              <span data-num className="w-8 text-center text-[16px] font-bold text-ink">{quantity}</span>
              <button
                type="button"
                aria-label="Increase quantity"
                onClick={() => setQuantity((q) => Math.min(product.inventoryCount, q + 1))}
                className="grid h-11 w-11 place-items-center rounded-full border border-hairline-strong text-[18px] text-ink"
              >
                +
              </button>
            </div>
          </div>

          {detent === 'full' && (
            <div className="mt-6 border-t border-hairline pt-5 text-[14px] leading-relaxed text-muted">
              <p>Ships from the US. Tracking emailed the moment the label prints.</p>
              <p className="mt-3">Returns accepted within 14 days of delivery.</p>
            </div>
          )}
          <div className="h-24" />
        </div>

        {/* Sticky at every detent: never make someone reach checkout to learn the price. */}
        <div className="shrink-0 border-t border-hairline bg-card px-5 pb-3 pt-3">
          <button
            type="button"
            disabled={soldOut || needsChoice}
            onClick={() => onCheckout(selection, quantity)}
            className={`w-full rounded-full py-3.5 text-[16px] font-bold transition-colors ${
              soldOut
                ? 'bg-hairline-strong text-muted'
                : needsChoice
                  ? 'bg-ink/10 text-muted'
                  : 'bg-coral text-ink shadow-cta active:scale-[0.98]'
            }`}
          >
            {soldOut
              ? 'Sold out'
              : needsChoice
                ? `Pick a ${product.variants.find((g) => !selection[g.name])?.name.toLowerCase()}`
                : `Buy · ${money(total)}`}
          </button>
          <p className="mt-2 text-center text-[11px] font-medium uppercase tracking-[0.06em] text-muted">
            Checkout by Stripe · no account needed
          </p>
        </div>
      </div>
    </div>
  );
}
