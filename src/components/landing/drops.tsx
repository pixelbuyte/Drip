import { Glyph, SCENE, Sticker } from './icons';
import { PRODUCTS, type Product } from './products';
import SaveButton from './save-button';

function pctOff(p: Product): number | null {
  if (!p.oldPrice) return null;
  return Math.round((1 - p.price / p.oldPrice) * 100);
}

/**
 * "Drops selling out this week." A product grid that reads as polished
 * commerce UI: the art is a lit sticker in the object's own pastel scene,
 * one sale badge, the save button, a claimed-progress bar that says WHY
 * it's selling out, then price / old price / savings, the review line, and
 * the shipping note — everything a buyer checks before tapping, in the
 * order they check it.
 */
function DropCard({ p, i }: { p: Product; i: number }) {
  const scene = SCENE[p.sticker];
  const off = pctOff(p);
  return (
    <li data-enter="rise" style={{ '--i': i % 3 } as React.CSSProperties}>
      <article className="group flex h-full flex-col rounded-[24px] bg-card p-2.5 shadow-card transition-[transform,box-shadow] duration-300 ease-out hover:-translate-y-1 hover:shadow-card-hover">
        <div
          className="relative aspect-[4/4.4] w-full overflow-hidden rounded-[18px]"
          style={{ background: `linear-gradient(140deg, ${scene.from}, ${scene.to})` }}
        >
          <span
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(72% 58% at 28% 20%, rgba(255,255,255,0.58), transparent 62%)' }}
          />
          <span className="pointer-events-none absolute inset-x-8 bottom-2 h-10 rounded-full blur-xl" style={{ background: scene.glow }} />
          <div className="absolute inset-0 grid place-items-center transition-transform duration-300 ease-out group-hover:scale-[1.05]">
            <Sticker kind={p.sticker} tilt={p.tilt} className="h-[74%] w-[74%]" title={p.name} />
          </div>

          {off !== null ? (
            <span className="absolute left-2.5 top-2.5 rounded-full bg-coral px-2.5 py-1 text-[12px] font-extrabold text-ink shadow-[0_4px_10px_-3px_rgba(255,75,46,0.5)]">
              −{off}%
            </span>
          ) : p.badge === 'new' ? (
            <span className="absolute left-2.5 top-2.5 rounded-full bg-lime px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em] text-ink">
              New
            </span>
          ) : null}

          <div className="absolute right-2.5 top-2.5">
            <SaveButton label={p.name} />
          </div>

          {/* why it's selling out */}
          <div className="absolute inset-x-2.5 bottom-2.5 rounded-full bg-white/85 px-3 py-1.5 backdrop-blur-sm">
            <div className="flex items-center justify-between text-[11px] font-bold text-ink">
              <span data-num>{p.claimed}% claimed</span>
              {p.left ? <span data-num className="text-sale">Only {p.left} left</span> : <span className="text-muted">Just dropped</span>}
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink/10">
              <div className="h-full rounded-full bg-coral" style={{ width: `${p.claimed}%` }} />
            </div>
          </div>
        </div>

        <div className="flex flex-1 flex-col px-2 pb-2 pt-3">
          <div className="text-[12px] font-semibold text-violet">{p.creator}</div>
          <h3 className="mt-0.5 line-clamp-2 text-[15px] font-semibold leading-snug tracking-[-0.01em] text-ink">{p.name}</h3>

          <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span data-num className="text-[20px] font-extrabold tracking-[-0.02em] text-ink">
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

          <div className="mt-auto flex items-center gap-1.5 pt-2.5 text-[12.5px] font-medium text-muted">
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
