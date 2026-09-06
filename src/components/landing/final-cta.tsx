import { Glyph, SCENE, Sticker, type StickerKind } from './icons';

const ORBIT: { kind: StickerKind; className: string; tilt: number; dur: number; delay: number }[] = [
  { kind: 'sneaker',  className: 'left-[4%] top-[14%] hidden md:block',    tilt: -10, dur: 7,   delay: 0 },
  { kind: 'lipoil',   className: 'right-[6%] top-[10%] hidden md:block',   tilt: 8,   dur: 6.5, delay: 0.6 },
  { kind: 'earbuds',  className: 'left-[10%] bottom-[12%] hidden md:block', tilt: 6,  dur: 7.5, delay: 1.1 },
  { kind: 'plant',    className: 'right-[9%] bottom-[8%] hidden md:block', tilt: -6,  dur: 6.8, delay: 0.3 },
];

/**
 * The close. One line, one button, and the six objects from the rest of
 * the page drifting quietly around it — the same vocabulary, so the ending
 * feels like the same product as the beginning.
 */
export default function FinalCta() {
  return (
    <div className="relative isolate overflow-hidden rounded-[36px] bg-ink px-6 py-20 text-center md:py-28">
      {/* warm glow so the dark panel still belongs to a cream page */}
      <span
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: 'radial-gradient(60% 70% at 50% 100%, rgba(255,75,46,0.45), transparent 70%)' }}
      />
      <span
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: 'radial-gradient(40% 50% at 15% 0%, rgba(255,46,147,0.22), transparent 70%)' }}
      />

      {ORBIT.map((o) => (
        <div
          key={o.kind}
          className={`anim-float pointer-events-none absolute z-0 w-[104px] rounded-[26px] p-3 ${o.className}`}
          style={
            {
              '--tilt': `${o.tilt}deg`,
              '--float-dur': `${o.dur}s`,
              animationDelay: `${o.delay}s`,
              transform: `rotate(${o.tilt}deg)`,
              background: `linear-gradient(140deg, ${SCENE[o.kind].from}, ${SCENE[o.kind].to})`,
              boxShadow: '0 24px 40px -18px rgba(0,0,0,0.6)',
            } as React.CSSProperties
          }
          aria-hidden
        >
          <Sticker kind={o.kind} className="h-full w-full" />
        </div>
      ))}

      <div className="relative z-10">
        <p data-enter="rise" className="text-[13px] font-bold uppercase tracking-[0.12em] text-cream/60">
          See it. Want it. Buy it.
        </p>
        <h2
          data-enter="rise"
          style={{ '--i': 1 } as React.CSSProperties}
          className="mx-auto mt-4 max-w-[14ch] font-display text-[clamp(2.4rem,6.5vw,4.5rem)] font-extrabold leading-[0.96] tracking-[-0.03em] text-cream"
        >
          Your next drop is already waiting.
        </h2>
        <p data-enter="rise" style={{ '--i': 2 } as React.CSSProperties} className="mx-auto mt-5 max-w-[36ch] text-[17px] leading-[1.5] text-cream/70">
          Free to browse. Dangerous to your wishlist.
        </p>
        <div
          data-enter="rise"
          style={{ '--i': 3 } as React.CSSProperties}
          className="mt-9 flex flex-wrap items-center justify-center gap-3"
        >
          <a
            href="/auth/signup"
            className="inline-flex items-center gap-2 rounded-full bg-coral px-8 py-4 text-[17px] font-bold text-ink shadow-cta transition-transform duration-[350ms] ease-spring hover:brightness-105 active:scale-[0.96]"
          >
            Get the app
            <Glyph.Arrow size={18} strokeWidth={2.4} />
          </a>
          <a
            href="#creators"
            className="rounded-full border border-cream/25 px-6 py-4 text-[15px] font-semibold text-cream transition-colors duration-150 hover:border-cream/60"
          >
            See what creators are loving
          </a>
        </div>
        <p data-enter="rise" style={{ '--i': 4 } as React.CSSProperties} className="mt-6 text-[13px] text-cream/50">
          iOS &amp; Android · No account needed to browse
        </p>
      </div>
    </div>
  );
}
