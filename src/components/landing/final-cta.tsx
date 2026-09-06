import Image from 'next/image';
import { Glyph } from './icons';
import { CATEGORIES } from './products';

// Four of the category objects drifting around the close, so the ending is
// unmistakably the same product as the beginning. Two of them are drawn on
// mobile too, small and tucked into the two corners the centred copy never
// reaches, so the close isn't text-only on a phone.
const ORBIT = [
  { i: 0, className: 'left-[3%] top-[2%] w-[56px] md:top-[13%] md:w-[104px] lg:w-[116px]', tilt: -10, dur: 7, delay: 0, mobile: true },
  { i: 2, className: 'right-[5%] top-[9%] w-[96px] lg:w-[108px]', tilt: 8, dur: 6.5, delay: 0.6, mobile: false },
  { i: 4, className: 'bottom-[13%] left-[8%] w-[96px] lg:w-[110px]', tilt: 6, dur: 7.5, delay: 1.1, mobile: false },
  { i: 5, className: 'bottom-[3%] right-[3%] w-[56px] md:bottom-[9%] md:right-[7%] md:w-[100px] lg:w-[114px]', tilt: -6, dur: 6.8, delay: 0.3, mobile: true },
];

/**
 * The close. One line with real teeth, one coral button, one quiet exit —
 * and the page's own objects drifting on their pastel tiles against the dark
 * panel, lit from the same top-left source as everywhere else. The panel's
 * deeper bottom padding on mobile is where the lower sticker lives — it keeps
 * the object clear of the store line above it.
 */
export default function FinalCta() {
  return (
    <div className="relative isolate overflow-hidden rounded-[36px] bg-ink px-6 pb-28 pt-20 text-center md:py-28">
      {/* warm glow so the dark panel still belongs to a cream page */}
      <span
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: 'radial-gradient(60% 70% at 50% 100%, rgba(255,75,46,0.45), transparent 70%)' }}
      />
      <span
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: 'radial-gradient(40% 50% at 15% 0%, rgba(255,46,147,0.22), transparent 70%)' }}
      />

      {ORBIT.map((o) => {
        const art = CATEGORIES[o.i].art;
        return (
          <div
            key={o.i}
            className={`anim-float pointer-events-none absolute z-0 rounded-[22px] p-2.5 md:rounded-[26px] md:p-3 ${
              o.mobile ? 'block' : 'hidden md:block'
            } ${o.className}`}
            style={
              {
                '--tilt': `${o.tilt}deg`,
                '--float-dur': `${o.dur}s`,
                animationDelay: `${o.delay}s`,
                transform: `rotate(${o.tilt}deg)`,
                background: art.tile,
                boxShadow: '0 26px 44px -20px rgba(0,0,0,0.75)',
              } as React.CSSProperties
            }
            aria-hidden
          >
            <Image src={art.src} alt="" width={art.w} height={art.h} sizes="(max-width: 767px) 56px, 116px" className="h-auto w-full" />
          </div>
        );
      })}

      <div className="relative z-10">
        <p data-enter="rise" className="text-[13px] font-bold uppercase tracking-[0.12em] text-cream/60">
          See it. Want it. Buy it.
        </p>
        <h2
          data-enter="rise"
          style={{ '--i': 1 } as React.CSSProperties}
          className="mx-auto mt-4 max-w-[13ch] font-display text-[clamp(2.5rem,6.8vw,4.75rem)] font-extrabold leading-[0.94] tracking-[-0.035em] text-cream"
        >
          The good stuff sells out. Be early.
        </h2>
        <p data-enter="rise" style={{ '--i': 2 } as React.CSSProperties} className="mx-auto mt-5 max-w-[46ch] text-[17px] leading-[1.5] text-cream/70">
          Free to browse. Dangerous to your wishlist.
        </p>
        <div
          data-enter="rise"
          style={{ '--i': 3 } as React.CSSProperties}
          className="mt-9 flex flex-wrap items-center justify-center gap-3"
        >
          <a
            href="/auth/signup"
            className="inline-flex items-center gap-2 rounded-full bg-coral px-8 py-4 text-[17px] font-bold text-ink shadow-cta transition-[transform,filter] duration-[350ms] ease-spring hover:brightness-105 active:scale-[0.96]"
          >
            Get the app
            <Glyph.Arrow size={18} strokeWidth={2.4} />
          </a>
          <a
            href="#creators"
            className="rounded-full border border-cream/25 px-6 py-4 text-[15px] font-semibold text-cream transition-colors duration-150 hover:border-cream/60 hover:bg-cream/[0.06]"
          >
            See what creators are loving
          </a>
        </div>
        <p
          data-enter="rise"
          style={{ '--i': 4 } as React.CSSProperties}
          className="mt-7 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[13px] font-medium text-cream/55"
        >
          <Glyph.Apple size={15} className="text-cream/70" />
          <Glyph.Android size={15} className="text-cream/70" />
          <span>iOS &amp; Android · No account needed to browse</span>
        </p>
      </div>
    </div>
  );
}
