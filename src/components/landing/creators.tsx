import Image from 'next/image';
import { Glyph } from './icons';
import ProductArt from './product-art';
import { byId, CREATORS, type Creator } from './products';

function Avatar({ c }: { c: Creator }) {
  return (
    <span className="relative block h-[68px] w-[68px] shrink-0">
      <Image
        src={c.avatar}
        alt=""
        aria-hidden
        width={192}
        height={192}
        sizes="68px"
        className="h-[68px] w-[68px] rounded-full object-cover"
        style={{ boxShadow: `0 0 0 3px #fff, 0 0 0 7px ${c.ring}, 0 12px 22px -12px rgba(32,26,23,0.45)` }}
      />
      <span className="absolute -bottom-0.5 -right-0.5 grid h-[22px] w-[22px] place-items-center rounded-full bg-cobalt text-white ring-[3px] ring-white">
        <Glyph.Check size={12} strokeWidth={3} />
      </span>
    </span>
  );
}

/**
 * "Shop through people with taste." Each card is half social profile
 * (real face, handle, follower count, niche) and half recommendation card
 * (their three current picks with prices, and a shop CTA). The card wears
 * the creator's own tint so four of them read as four people rather than
 * four slots; the CTA stays a quiet white pill so the page keeps exactly
 * one coral primary.
 */
export default function Creators() {
  return (
    <ul className="rail -mx-5 px-5 md:mx-0 md:grid md:grid-cols-2 md:gap-5 md:overflow-visible md:px-0 xl:grid-cols-4">
      {CREATORS.map((c, i) => (
        <li
          key={c.handle}
          data-enter="rise"
          style={{ '--i': i % 4 } as React.CSSProperties}
          className="w-[80vw] max-w-[340px] shrink-0 md:w-auto md:max-w-none"
        >
          <article
            className="group flex h-full flex-col rounded-[28px] p-5 shadow-card transition-[transform,box-shadow] duration-300 ease-out hover:-translate-y-1.5 hover:shadow-card-hover"
            style={{ background: c.tint }}
          >
            <header className="flex items-center gap-3.5">
              <Avatar c={c} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-display text-[19px] font-extrabold tracking-[-0.025em] text-ink">{c.name}</div>
                <div className="truncate text-[13px] font-semibold text-muted">{c.handle}</div>
                <div
                  className="mt-1.5 inline-block max-w-full truncate rounded-full px-2.5 py-[3px] text-[11.5px] font-bold text-ink/80"
                  style={{ background: c.chip }}
                >
                  {c.niche}
                </div>
              </div>
            </header>

            <p className="mt-4 text-[14px] leading-[1.55] text-muted">{c.blurb}</p>

            <div className="mt-3.5 flex flex-wrap gap-1.5">
              {c.tags.map((t) => (
                <span key={t} className="rounded-full bg-white/70 px-2.5 py-1 text-[11.5px] font-semibold text-ink/75">
                  {t}
                </span>
              ))}
            </div>

            <dl className="mt-4 flex items-baseline gap-4 border-t border-ink/[0.07] pt-4">
              <div className="flex items-baseline gap-1.5">
                <dt className="sr-only">Followers</dt>
                <dd data-num className="font-display text-[21px] font-extrabold leading-none tracking-[-0.03em] text-ink">
                  {c.followers}
                </dd>
                <span className="text-[12.5px] font-medium text-muted">followers</span>
              </div>
              <div className="ml-auto flex items-baseline gap-1.5">
                <dt className="sr-only">Drops</dt>
                <dd data-num className="text-[14px] font-bold text-ink">{c.drops}</dd>
                <span className="text-[12.5px] font-medium text-muted">drops</span>
              </div>
            </dl>

            {/* current picks — the recommendation half of the card */}
            <div className="mt-4 mb-5">
              <div className="text-[11px] font-bold uppercase tracking-[0.09em] text-muted">
                Picks · {c.descriptor}
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {c.picks.map((id) => {
                  const p = byId(id);
                  return (
                    <div key={id} className="min-w-0">
                      {/* named here, unlike the drops grid: the only text under
                          the tile is a bare price, so the alt carries the
                          product for anyone who can't see the render */}
                      <ProductArt
                        art={p.art}
                        alt={p.name}
                        // measured boxes: 58px in the mobile rail, 82px in the
                        // two-across band, 51px in the four-across row
                        sizes="(max-width: 767px) 16vw, (max-width: 1279px) 84px, 52px"
                        className="aspect-square w-full rounded-[14px] ring-1 ring-ink/[0.04]"
                        inset="p-[16%]"
                      />
                      <div data-num className="mt-1.5 truncate text-[12.5px] font-bold text-ink">
                        ${p.price}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* mt-auto: the four CTAs line up across the row even when the
                blurbs and tag rows run to different heights */}
            <a
              href="/feed"
              className="mt-auto flex items-center justify-center gap-2 rounded-full bg-card py-3 text-[14.5px] font-bold text-ink shadow-[0_2px_6px_-3px_rgba(32,26,23,0.3)] transition-[color,transform] duration-200 hover:text-coral-deep active:scale-[0.98]"
            >
              {c.cta}
              <Glyph.Arrow size={16} strokeWidth={2.4} />
            </a>
          </article>
        </li>
      ))}
    </ul>
  );
}
