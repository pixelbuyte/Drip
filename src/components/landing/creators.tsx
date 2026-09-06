import { Glyph, SCENE, Sticker } from './icons';
import { byId, CREATORS, type Creator } from './products';

const ACCENT: Record<Creator['accent'], { fill: string; text: string; soft: string }> = {
  violet: { fill: 'bg-violet',  text: 'text-violet',     soft: 'bg-violet/10' },
  pink:   { fill: 'bg-pink',    text: 'text-pink-deep',  soft: 'bg-pink/10' },
  cobalt: { fill: 'bg-cobalt',  text: 'text-cobalt',     soft: 'bg-cobalt/10' },
  coral:  { fill: 'bg-coral',   text: 'text-coral-deep', soft: 'bg-coral/10' },
};

function Avatar({ c, size = 56 }: { c: Creator; size?: number }) {
  return (
    <span
      className="relative grid shrink-0 place-items-center rounded-full font-display font-extrabold tracking-[-0.03em] text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.34,
        background: `linear-gradient(135deg, ${c.from}, ${c.to})`,
        boxShadow: `0 8px 18px -8px ${c.to}99, inset 0 0 0 3px rgba(255,255,255,0.9)`,
      }}
      aria-hidden
    >
      {c.initials}
      <span className="absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full bg-cobalt text-white ring-2 ring-card">
        <Glyph.Check size={11} strokeWidth={3} />
      </span>
    </span>
  );
}

/**
 * "Shop through people with taste." Each card is half social profile
 * (avatar, handle, follower count, niche), half recommendation card (the
 * creator's three current picks with prices, and a shop CTA in their own
 * accent). The picks strip is the part that makes it commerce and not just
 * a directory of influencers.
 */
export default function Creators() {
  return (
    <ul className="rail -mx-5 px-5 md:mx-0 md:grid md:grid-cols-2 md:gap-5 md:overflow-visible md:px-0 xl:grid-cols-4">
      {CREATORS.map((c, i) => {
        const a = ACCENT[c.accent];
        return (
          <li
            key={c.handle}
            data-enter="rise"
            style={{ '--i': i % 4 } as React.CSSProperties}
            className="w-[82vw] max-w-[360px] shrink-0 md:w-auto md:max-w-none"
          >
            <article className="flex h-full flex-col rounded-[28px] bg-card p-5 shadow-card transition-[transform,box-shadow] duration-300 ease-out hover:-translate-y-1 hover:shadow-card-hover">
              <header className="flex items-start gap-3.5">
                <Avatar c={c} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[17px] font-bold tracking-[-0.01em] text-ink">{c.name}</div>
                  <div className="truncate text-[13px] font-medium text-muted">{c.handle}</div>
                  <div className={`mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-[11.5px] font-bold ${a.soft} ${a.text}`}>
                    {c.niche}
                  </div>
                </div>
              </header>

              <p className="mt-4 text-[14px] leading-[1.55] text-muted">{c.blurb}</p>

              <div className="mt-4 flex flex-wrap gap-1.5">
                {c.tags.map((t) => (
                  <span key={t} className="rounded-full border border-hairline-strong px-2.5 py-1 text-[12px] font-semibold text-ink">
                    {t}
                  </span>
                ))}
              </div>

              <dl className="mt-4 flex items-center gap-4 border-t border-hairline pt-4 text-[13px]">
                <div>
                  <dt className="sr-only">Followers</dt>
                  <dd>
                    <span data-num className="font-extrabold text-ink">{c.followers}</span>{' '}
                    <span className="text-muted">followers</span>
                  </dd>
                </div>
                <div>
                  <dt className="sr-only">Drops</dt>
                  <dd>
                    <span data-num className="font-extrabold text-ink">{c.drops}</span>{' '}
                    <span className="text-muted">drops</span>
                  </dd>
                </div>
              </dl>

              {/* current picks — the recommendation half of the card */}
              <div className="mt-4 grid grid-cols-3 gap-2">
                {c.picks.map((id) => {
                  const p = byId(id);
                  const scene = SCENE[p.sticker];
                  return (
                    <div key={id} className="min-w-0">
                      <div
                        className="relative aspect-square w-full overflow-hidden rounded-[14px]"
                        style={{ background: `linear-gradient(140deg, ${scene.from}, ${scene.to})` }}
                      >
                        <span
                          className="pointer-events-none absolute inset-0"
                          style={{ background: 'radial-gradient(70% 55% at 30% 22%, rgba(255,255,255,0.55), transparent 62%)' }}
                        />
                        <div className="absolute inset-0 grid place-items-center">
                          <Sticker kind={p.sticker} tilt={p.tilt} className="h-[78%] w-[78%]" />
                        </div>
                      </div>
                      <div data-num className="mt-1.5 truncate text-[12.5px] font-bold text-ink">
                        ${p.price}
                      </div>
                    </div>
                  );
                })}
              </div>

              <a
                href="/feed"
                className={`mt-5 flex items-center justify-center gap-2 rounded-full py-3 text-[14.5px] font-bold text-white shadow-[0_8px_20px_-8px_rgba(32,26,23,0.35)] transition-transform duration-[350ms] ease-spring active:scale-[0.97] ${a.fill}`}
              >
                {c.cta}
                <Glyph.Arrow size={16} strokeWidth={2.4} />
              </a>
            </article>
          </li>
        );
      })}
    </ul>
  );
}
