import { Glyph, HandArrow } from './icons';
import PhoneMockup from './phone-mockup';

function FloatChip({
  children,
  className = '',
  tilt,
  dur,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  tilt: number;
  dur: number;
  delay?: number;
}) {
  return (
    <div
      className={`anim-float absolute z-30 flex items-center gap-2 rounded-full bg-card py-2 pl-2.5 pr-4 shadow-float ${className}`}
      style={{ '--tilt': `${tilt}deg`, '--float-dur': `${dur}s`, animationDelay: `${delay}s`, transform: `rotate(${tilt}deg)` } as React.CSSProperties}
      aria-hidden
    >
      {children}
    </div>
  );
}

/**
 * The hero. Copy on the left carries the three-beat message; the phone on
 * the right proves it with an actual screen. Two floating app-UI chips and
 * one handwritten note point at the buy chip — the single interaction the
 * whole product is about.
 */
export default function Hero() {
  return (
    <section className="relative overflow-hidden pb-16 pt-28 md:pb-28 md:pt-36">
      {/* ambient glow — warm, low, never a "blob" */}
      <span
        className="pointer-events-none absolute -right-[10%] top-[8%] -z-10 h-[520px] w-[520px] rounded-full opacity-80 blur-3xl md:h-[720px] md:w-[720px]"
        style={{ background: 'radial-gradient(circle at 40% 40%, rgba(255,75,46,0.22), rgba(255,176,31,0.12) 45%, transparent 70%)' }}
        aria-hidden
      />
      <span
        className="pointer-events-none absolute -left-[12%] top-[40%] -z-10 h-[420px] w-[420px] rounded-full blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(255,46,147,0.1), transparent 70%)' }}
        aria-hidden
      />

      <div className="mx-auto grid max-w-[1240px] grid-cols-1 items-center gap-12 px-5 md:grid-cols-12 md:gap-8 md:px-6">
        {/* ── copy ── */}
        <div className="md:col-span-6 lg:col-span-6">
          <div data-enter="rise" className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-hairline-strong bg-card py-1.5 pl-2.5 pr-3.5 text-[12.5px] font-bold text-ink shadow-[0_2px_10px_-6px_rgba(32,26,23,0.2)]">
              <span className="anim-dot h-2 w-2 rounded-full bg-coral" />
              Video-first shopping
            </span>
            <span className="text-[12.5px] font-semibold text-muted">Now on iOS &amp; Android</span>
          </div>

          <h1
            data-enter="rise"
            style={{ '--i': 1 } as React.CSSProperties}
            className="mt-6 font-display text-hero font-extrabold text-ink"
          >
            See it.
            <br />
            Want it.
            <br />
            <span className="text-coral">Buy it.</span>
          </h1>

          <p
            data-enter="rise"
            style={{ '--i': 2 } as React.CSSProperties}
            className="mt-6 max-w-[40ch] text-sub text-muted"
          >
            Scroll short videos from creators you trust — then buy the thing in the video without
            leaving it. Every category, on camera.
          </p>

          <div
            data-enter="rise"
            style={{ '--i': 3 } as React.CSSProperties}
            className="mt-9 flex flex-wrap items-center gap-3"
          >
            <a
              href="/auth/signup"
              className="inline-flex items-center gap-2 rounded-full bg-coral px-7 py-4 text-[17px] font-bold text-ink shadow-cta transition-transform duration-[350ms] ease-spring hover:brightness-105 active:scale-[0.96]"
            >
              Get the app
              <Glyph.Arrow size={18} strokeWidth={2.4} />
            </a>
            <a
              href="/feed/demo"
              className="inline-flex items-center gap-2.5 rounded-full border border-hairline-strong bg-card py-3 pl-3 pr-5 text-[15px] font-semibold text-ink transition-colors duration-150 hover:border-coral/40 hover:text-coral-deep"
            >
              <span className="grid h-8 w-8 place-items-center rounded-full bg-ink text-cream">
                <Glyph.Play size={14} />
              </span>
              Watch how it works
            </a>
          </div>

          <div
            data-enter="rise"
            style={{ '--i': 4 } as React.CSSProperties}
            className="mt-8 flex items-center gap-3"
          >
            <span className="flex -space-x-2" aria-hidden>
              {[
                ['MO', '#ff8f74', '#ff2e93'],
                ['TL', '#6f92ff', '#6d4aff'],
                ['SM', '#ffd67a', '#f0930a'],
                ['RN', '#b5e86a', '#2e5cff'],
              ].map(([i, a, b]) => (
                <span
                  key={i}
                  className="grid h-8 w-8 place-items-center rounded-full text-[10px] font-extrabold text-white ring-2 ring-cream"
                  style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}
                >
                  {i}
                </span>
              ))}
            </span>
            <span className="text-[13.5px] font-medium text-muted">
              Real creators, real carts. <span className="font-semibold text-ink">Free to browse.</span>
            </span>
          </div>
        </div>

        {/* ── phone ── */}
        <div className="relative md:col-span-6" data-enter="lift" style={{ '--i': 2 } as React.CSSProperties}>
          <div className="relative mx-auto flex w-fit justify-center py-6 md:py-8">
            {/* pedestal glow directly behind the device */}
            <span
              className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[88%] w-[130%] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
              style={{ background: 'radial-gradient(ellipse at center, rgba(255,75,46,0.28), rgba(255,199,179,0.35) 45%, transparent 72%)' }}
              aria-hidden
            />

            <div className="anim-float [--tilt:0deg] md:[--tilt:-3deg]" style={{ '--float-dur': '9s' } as React.CSSProperties}>
              <PhoneMockup />
            </div>

            <FloatChip className="-top-3 right-1 md:-right-14 md:top-[24%]" tilt={5} dur={6.5}>
              <span className="grid h-7 w-7 place-items-center rounded-full bg-amber/20 text-amber">
                <Glyph.Bolt size={14} />
              </span>
              <span className="whitespace-nowrap text-[13px] font-semibold text-ink">
                Sold out in <span data-num>40 min</span>
              </span>
            </FloatChip>

            <FloatChip className="-left-3 top-[47%] md:-left-12 md:top-[45%]" tilt={-4} dur={7.5} delay={0.9}>
              <span className="grid h-7 w-7 place-items-center rounded-full bg-pink/15 text-pink">
                <Glyph.Heart size={14} filled />
              </span>
              <span className="whitespace-nowrap text-[13px] font-semibold text-ink">Saved to your list</span>
            </FloatChip>

            {/* handwritten note pointing at the buy chip — only where it has room */}
            <div className="pointer-events-none absolute -right-[4.25rem] bottom-[19%] hidden w-[170px] text-coral-deep lg:block" aria-hidden>
              <span className="ml-14 block -rotate-6 font-hand text-[27px] font-semibold leading-none">tap to buy</span>
              <HandArrow direction="left" className="-mt-3" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
