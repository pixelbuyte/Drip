import { Glyph } from './icons';
import ProductArt from './product-art';
import { PRODUCTS, type Product } from './products';
import SaveButton from './save-button';

function pctOff(p: Product): number | null {
  if (!p.oldPrice) return null;
  return Math.round((1 - p.price / p.oldPrice) * 100);
}

/**
 * "Drops selling out this week." A product grid that reads as polished
 * commerce UI: the art is the real render on its own pastel scene, one sale
 * badge, the save button, a claimed-progress bar that says WHY it is selling
 * out, then price / old price / savings, the review line and the shipping
 * note — everything a buyer checks before tapping, in the order they check it.
 */
function DropCard({ p, i }: { p: Product; i: number }) {
  const off = pctOff(p);
  return (
    <li data-enter="rise" style={{ '--i': i % 3 } as React.CSSProperties}>
      <article className="group flex h-full flex-col rounded-[24px] bg-card p-2.5 shadow-card transition-[transform,box-shadow] duration-300 ease-out hover:-translate-y-1.5 hover:shadow-card-hover">
        <div className="relative">
          {/* the claimed pill is docked over the bottom of the tile, so the
              object gets a reserved band above it — deeper on mobile, where
              the pill takes a much bigger share of a small tile */}
          {/* the object is decorative here — the <h3> below already names it,
              so an alt would make a screen reader say it twice */}
          <ProductArt
            art={p.art}
            align="end"
            sizes={`(max-width: 767px) 32vw, ${p.art.render}px`}
            inset="px-[15%] pb-[30%] pt-[7%] md:pb-[23%] md:pt-[9%]"
            className="aspect-square w-full rounded-[18px] md:aspect-[4/3.5]"
          />

          {off !== null ? (
            <span className="absolute left-2.5 top-2.5 z-20 rounded-full bg-coral px-2.5 py-1 text-[12px] font-extrabold tracking-[-0.01em] text-ink shadow-[0_4px_12px_-3px_rgba(255,75,46,0.55)]">
              −{off}%
            </span>
          ) : p.badge === 'new' ? (
            <span className="absolute left-2.5 top-2.5 z-20 rounded-full bg-lime px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em] text-ink">
              New
            </span>
          ) : null}

          <div className="absolute right-2.5 top-2.5 z-20">
            <SaveButton label={p.name} />
          </div>

          {/* why it's selling out */}
          <div className="absolute inset-x-2.5 bottom-2.5 z-20 rounded-full bg-white/88 px-3 py-1.5 shadow-[0_2px_8px_-4px_rgba(32,26,23,0.3)] backdrop-blur-sm">
            <div className="flex items-center justify-between gap-1.5 text-[10.5px] font-bold text-ink md:text-[11px]">
              <span data-num className="shrink-0 whitespace-nowrap">
                {p.claimed}%<span className="hidden md:inline"> claimed</span>
              </span>
              {p.left ? (
                <span data-num className="min-w-0 truncate text-sale">
                  <span className="hidden md:inline">Only </span>
                  {p.left} left
                </span>
              ) : (
                <span className="min-w-0 truncate text-muted">Just dropped</span>
              )}
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink/10">
              <div className="h-full rounded-full bg-coral" style={{ width: `${p.claimed}%` }} />
            </div>
          </div>
        </div>

        <div className="flex flex-1 flex-col px-2 pb-2 pt-3.5">
          <div className="text-[12px] font-semibold text-violet">{p.creator}</div>
          <h3 className="mt-0.5 line-clamp-2 text-[15px] font-semibold leading-snug tracking-[-0.012em] text-ink">{p.name}</h3>

          <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span data-num className="font-display text-[22px] font-extrabold tracking-[-0.03em] text-ink">
              ${p.price}
            </span>
            {p.oldPrice && (
              <>
                <span data-num className="text-[13px] text-muted line-through decoration-[1.5px]">
                  ${p.oldPrice}
                </span>
                <span data-num className="rounded-full bg-sale/10 px-2 py-0.5 text-[11.5px] font-bold text-sale">
                  Save ${p.oldPrice - p.price}
                </span>
              </>
            )}
          </div>

          <div className="mt-2 flex items-center gap-1 text-[12.5px]">
            <Glyph.Star size={13} className="text-amber" />
            <span data-num className="font-bold text-ink">{p.rating}</span>
            <span data-num className="text-muted">({p.reviews} reviews)</span>
          </div>

          <div className="mt-auto flex items-center gap-1.5 pt-3 text-[12.5px] font-medium text-muted">
            <Glyph.Truck size={15} className="text-ink/70" />
            {p.shipping}
          </div>
        </div>
      </article>
    </li>
  );
}

export default function Drops() {
  return (
    <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-5">
      {PRODUCTS.map((p, i) => (
        <DropCard key={p.id} p={p} i={i} />
      ))}
    </ul>
  );
}
