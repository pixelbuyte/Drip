import { SCENES } from './products';

// A sponsored shopping EVENT, not a banner: the campaign sits inside normal
// card grammar with a plain 11px Sponsored label. SUNCOURT is fictional.
const PACK = [
  { name: 'Sorbet Ace Low', price: 118, glyph: '👟', tilt: -5 },
  { name: 'Sorbet Court Jacket', price: 172, glyph: '🧥', tilt: 6 },
  { name: 'Sorbet Cap', price: 34, glyph: '🧢', tilt: -4 },
];

export default function Campaign() {
  const scene = SCENES.sneakers;
  return (
    <div
      data-enter="lift"
      className="art overflow-hidden rounded-banner shadow-card-hover"
      style={{ background: 'linear-gradient(135deg, #2a1e3f 0%, #4a2c6d 45%, #ff7a59 100%)' }}
    >
      <div className="relative z-10 p-6 md:p-12">
        <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-white/75">
          Sponsored · Suncourt
        </div>
        <h3 className="mt-3 max-w-[16ch] font-display text-[clamp(2rem,5vw,3.5rem)] font-extrabold leading-[0.98] tracking-[-0.02em] text-white">
          The Sorbet Pack has landed.
        </h3>
        <p className="mt-4 max-w-[44ch] text-[16px] leading-relaxed text-white/85">
          Court classics, re-dyed for golden hour. Five silhouettes, five summer colorways —
          one week on the feed, and your scroll finds them first.
        </p>

        <div className="rail mt-8 md:grid md:grid-cols-3 md:gap-4 md:overflow-visible">
          {PACK.map((p) => (
            <div key={p.name} className="w-[56vw] rounded-card bg-card p-1.5 md:w-auto">
              <div
                className="art relative aspect-[4/5] w-full overflow-hidden rounded-art"
                style={{ background: `linear-gradient(135deg, ${scene.from}, ${scene.to})`, containerType: 'inline-size' }}
              >
                <span
                  className="absolute left-1/2 top-[55%] select-none"
                  style={{
                    fontSize: '50cqw',
                    transform: `translate(-50%,-50%) rotate(${p.tilt}deg)`,
                    filter: 'drop-shadow(0 16px 18px rgba(64,40,90,0.3))',
                    lineHeight: 1,
                  }}
                  aria-hidden
                >
                  {p.glyph}
                </span>
              </div>
              <div className="flex items-baseline justify-between p-2.5">
                <span className="truncate text-[13px] font-medium text-ink">{p.name}</span>
                <span data-num className="ml-2 shrink-0 text-[15px] font-extrabold text-ink">${p.price}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <a
            href="#feed"
            className="rounded-full bg-white px-6 py-3 text-[15px] font-bold text-ink transition-transform duration-150 active:scale-[0.97]"
          >
            See the Pack
          </a>
          <span className="rounded-full bg-white/15 px-3.5 py-1.5 text-[12px] font-semibold text-white">
            This weekend only
          </span>
        </div>
      </div>
    </div>
  );
}
