import { SCENE, Sticker } from './icons';
import { CATEGORIES } from './products';

/**
 * "Every category, on camera." Six cards, each a sticker illustration on
 * its own pastel tile. The tile carries the object's tinted glow so the
 * icon reads as a lit object sitting in a space, not a flat glyph on a
 * square; hover nudges the object (scale + a few degrees) rather than the
 * whole card, which is what makes it feel like picking something up.
 */
export default function Categories() {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4 xl:grid-cols-6">
      {CATEGORIES.map((c, i) => {
        const scene = SCENE[c.sticker];
        return (
          <li key={c.name} data-enter="rise" style={{ '--i': i % 3 } as React.CSSProperties}>
            <a
              href="/feed"
              className="group relative block rounded-[26px] bg-card p-2.5 shadow-card transition-[transform,box-shadow] duration-300 ease-out hover:-translate-y-1 hover:shadow-card-hover active:translate-y-0 active:duration-100"
            >
              <div
                className="relative aspect-[1/0.92] w-full overflow-hidden rounded-[20px]"
                style={{ background: `linear-gradient(140deg, ${scene.from}, ${scene.to})` }}
              >
                {/* softbox: one light source, top-left, on every tile */}
                <span
                  className="pointer-events-none absolute inset-0"
                  style={{ background: 'radial-gradient(72% 58% at 28% 20%, rgba(255,255,255,0.6), transparent 62%)' }}
                />
                <span
                  className="pointer-events-none absolute inset-x-6 bottom-1 h-8 rounded-full blur-xl"
                  style={{ background: scene.glow }}
                />
                <div className="absolute inset-0 grid place-items-center transition-transform duration-300 ease-out group-hover:scale-[1.06] group-hover:-rotate-2">
                  <Sticker kind={c.sticker} tilt={c.tilt} className="h-[72%] w-[72%]" />
                </div>
                {c.isNew && (
                  <span className="absolute left-2.5 top-2.5 rounded-full bg-lime px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em] text-ink shadow-[0_2px_8px_-2px_rgba(32,26,23,0.25)]">
                    New
                  </span>
                )}
              </div>

              <div className="flex items-end justify-between gap-2 px-2 pb-1.5 pt-3">
                <div className="min-w-0">
                  <div className="truncate text-[16px] font-bold tracking-[-0.01em] text-ink">{c.name}</div>
                  <div data-num className="mt-0.5 text-[12.5px] font-medium text-muted">
                    {c.drops}
                  </div>
                </div>
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-hairline-strong text-ink transition-all duration-200 group-hover:border-coral group-hover:bg-coral group-hover:text-ink"
                  aria-hidden
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" />
                  </svg>
                </span>
              </div>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
