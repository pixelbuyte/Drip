import Image from 'next/image';
import { CATEGORIES } from './products';

/**
 * "Every category, on camera." Six cards, each a soft-3D sticker cutout on a
 * flat pastel tile in that object's own colour. The cutouts ship with their
 * contact shadow already baked in and tinted to the tile, so the tile stays
 * flat — the only lighting the card adds is a top-left softbox and a wide
 * ambient pool under the object. Hover lifts the object out of the tile
 * rather than moving the whole card, which is what makes it feel like
 * picking something up.
 *
 * Columns step 2 → 3 → 6: the six-across row starts at lg rather than xl so
 * the 1024-1279 range stops drawing 200px stickers into a 269px box, and the
 * card's contents are capped at 200px so the three-across tablet band doesn't
 * inflate a tile past what the renders can fill sharply. Each object then
 * takes its own share of the tile (`art.scale`) so a wide, short render and a
 * tall, narrow one carry the same optical weight across the row.
 *
 * Two of the founder's cutouts were generated carrying third-party marks — a
 * swoosh on the sneaker's quarter panel and a Beats "b" on the headphones'
 * earcup. Both were painted out before use (see public/landing/README.md);
 * the art here is otherwise the founder's, untouched.
 */
export default function Categories() {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4 lg:grid-cols-6">
      {CATEGORIES.map((c, i) => (
        <li key={c.name} data-enter="rise" style={{ '--i': i % 3 } as React.CSSProperties}>
          <a
            href="/feed"
            className="group relative block rounded-[26px] bg-card p-2.5 shadow-card transition-[transform,box-shadow] duration-300 ease-out hover:-translate-y-1 hover:shadow-card-hover active:translate-y-0 active:duration-100"
          >
            <div className="mx-auto w-full max-w-[200px]">
            <div
              className="relative aspect-[1/0.94] w-full overflow-hidden rounded-[20px]"
              style={{ background: c.art.tile }}
            >
              {/* softbox: one light source, top-left, on every tile */}
              <span
                className="pointer-events-none absolute inset-0"
                style={{ background: 'radial-gradient(70% 56% at 26% 18%, rgba(255,255,255,0.62), transparent 64%)' }}
              />
              {/* ambient pool the object sits in — deepens on hover */}
              <span
                className="pointer-events-none absolute inset-x-5 bottom-1 h-9 rounded-full opacity-70 blur-xl transition-opacity duration-300 group-hover:opacity-100"
                style={{ background: c.art.glow }}
              />

              <div className="absolute inset-0 grid place-items-center">
                <Image
                  src={c.art.src}
                  alt=""
                  aria-hidden
                  width={c.art.w}
                  height={c.art.h}
                  // measured: 123px max at 390, 165px max once the 200px
                  // content cap binds, 136px in the six-across row
                  sizes="(max-width: 500px) 32vw, 165px"
                  className="h-auto transition-transform duration-[420ms] ease-out will-change-transform group-hover:-translate-y-1.5 group-hover:scale-[1.05]"
                  // its share of the tile, but never past 1.3× its own pixels
                  style={{ width: `${c.art.scale * 100}%`, maxWidth: Math.round(c.art.w * 1.3) }}
                />
              </div>

              {c.isNew && (
                <span className="absolute left-2.5 top-2.5 rounded-full bg-lime px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em] text-ink shadow-[0_2px_8px_-2px_rgba(32,26,23,0.25)]">
                  New
                </span>
              )}
            </div>

            <div className="flex items-end justify-between gap-2 px-2 pb-1.5 pt-3">
              <div className="min-w-0">
                <div className="truncate text-[16px] font-bold tracking-[-0.012em] text-ink lg:text-[15px] xl:text-[16px]">{c.name}</div>
                <div data-num className="mt-0.5 text-[12.5px] font-medium text-muted">
                  {c.drops}
                </div>
              </div>
              <span
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-hairline-strong text-ink lg:h-7 lg:w-7 xl:h-8 xl:w-8 transition-[background-color,border-color,transform] duration-200 group-hover:-rotate-45 group-hover:border-coral group-hover:bg-coral"
                aria-hidden
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" />
                </svg>
              </span>
            </div>
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
