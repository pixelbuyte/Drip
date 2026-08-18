'use client';

import type { FeedProduct } from '@/lib/feed/types';

const money = (cents: number) =>
  `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;

/**
 * Exactly one urgency line, and only if it is true. The first of:
 *   Only N left -> Ships in Xd -> nothing.
 * Never fabricate urgency — on a feed a shopper scrolls for minutes, invented
 * scarcity is the fastest way to lose them.
 */
function urgencyLine(p: FeedProduct): string | null {
  if (p.inventoryCount > 0 && p.inventoryCount <= p.lowStockThreshold) {
    return `Only ${p.inventoryCount} left`;
  }
  return null;
}

export default function ProductBar({
  products,
  activeIndex,
  onOpen,
  nudge,
}: {
  products: FeedProduct[];
  activeIndex: number;
  onOpen: (productId: string) => void;
  nudge: boolean;
}) {
  if (products.length === 0) return null;
  const multi = products.length > 1;
  const p = products[Math.min(activeIndex, products.length - 1)];
  const urgency = urgencyLine(p);

  return (
    <div
      className="pointer-events-auto absolute inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+18px)] z-30"
      style={{
        transform: nudge ? 'translateY(-6px)' : 'translateY(0)',
        transition: 'transform 420ms cubic-bezier(0.32,0.72,0,1), box-shadow 420ms cubic-bezier(0.32,0.72,0,1)',
      }}
    >
      <button
        type="button"
        onClick={() => onOpen(p.id)}
        aria-label={`${p.title}, ${money(p.priceCents)}${urgency ? `, ${urgency}` : ''}. Open product`}
        className="flex min-h-[56px] w-full items-center gap-3 rounded-[18px] bg-card p-2 pr-3 text-left shadow-card"
      >
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] text-[20px]"
          style={{ background: 'linear-gradient(135deg,#ffe3d8,#ffc9b5)' }}
          aria-hidden
        >
          {p.images[0] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.images[0]} alt="" width={40} height={40} className="h-10 w-10 rounded-[10px] object-cover" />
          ) : (
            '🛍️'
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold text-ink">{p.title}</span>
          {urgency ? (
            <span className="block text-[12px] font-semibold text-coral-deep">{urgency}</span>
          ) : (
            <span className="block text-[12px] text-muted">
              {multi ? `${products.length} items` : 'Tap to shop'}
            </span>
          )}
        </span>

        <span className="shrink-0 text-right">
          <span data-num className="block text-[17px] font-extrabold text-ink">
            {money(p.priceCents)}
          </span>
          {p.compareAtPriceCents && p.compareAtPriceCents > p.priceCents && (
            <span data-num className="block text-[12px] text-muted line-through">
              {money(p.compareAtPriceCents)}
            </span>
          )}
        </span>

        <span className="ml-1 shrink-0 text-muted" aria-hidden>▲</span>
      </button>
    </div>
  );
}
