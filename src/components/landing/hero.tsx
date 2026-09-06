import Image from 'next/image';
import { Glyph } from './icons';
import { CREATORS } from './products';

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
      className={`anim-float absolute z-30 items-center gap-2 rounded-full bg-card py-1.5 pl-2 pr-3.5 shadow-float md:py-2 md:pl-2.5 md:pr-4 ${className}`}
      style={{ '--tilt': `${tilt}deg`, '--float-dur': `${dur}s`, animationDelay: `${delay}s`, transform: `rotate(${tilt}deg)` } as React.CSSProperties}
      aria-hidden
    >
      {children}
    </div>
  );
}

/**
 * The row of creator faces under the copy. On md+ it closes the copy column;
 * on a phone it is rendered *after* the visual instead, which lifts the device
 * ~60px up the fold — the difference between half a phone above the fold and
 * two thirds of one.
 */
function SocialProof({ className = '' }: { className?: string }) {
  return (
    <div className={`items-center gap-3 ${className}`}>
      <span className="flex -space-x-2.5" aria-hidden>
        {CREATORS.map((c) => (
          <Image
            key={c.handle}
            src={c.avatar}
            alt=""
            width={192}
            height={192}
            sizes="34px"
            className="h-[34px] w-[34px] rounded-full object-cover ring-2 ring-cream"
          />
        ))}
      </span>
      <span className="text-balance text-[13.5px] font-medium text-muted">
        Real creators, real carts. <span className="font-semibold text-ink">Free to browse.</span>
      </span>
    </div>
  );
}

/**
 * The hero. Copy on the left carries the three-beat message; the founder's
 * hero visual on the right proves it with the actual app — real screen, real
 * bottom tab bar, and its own handwritten annotations. The image is the main
 * attraction, so the page adds only two floating chips.
 *
 * Where the chips can sit is decided by the artwork: the device body runs from
 * about 23% to 83% of the image width and its chin ends around 95% of the
 * height, so the cream margins beside the phone are only ~20% and ~17% wide.
 * A full chip is ~175px of text and only clears the device once the image is
 * at its full 520px (≥1280px). Below that the top-left chip would land on the
 * phone's search field, so it is dropped — but the bottom chip is fine at
 * every width, because below the tab bar there is nothing to cover: it reads
 * as a badge docked under the device. That keeps at least one floating callout
 * on tablets and phones instead of none. No hand-drawn arrow either: the
 * visual already says "Real People. Great Products." in its own hand.
 */
export default function Hero() {
  return (
    <section className="relative overflow-hidden pb-14 pt-[86px] md:pb-24 md:pt-[132px]">
      {/* ambient glow — warm, low, never a "blob" */}
      <span
        className="pointer-events-none absolute -right-[10%] top-[6%] -z-10 h-[520px] w-[520px] rounded-full opacity-80 blur-3xl md:h-[720px] md:w-[720px]"
        style={{ background: 'radial-gradient(circle at 40% 40%, rgba(255,75,46,0.16), rgba(255,176,31,0.10) 45%, transparent 70%)' }}
        aria-hidden
      />
      <span
        className="pointer-events-none absolute -left-[12%] top-[40%] -z-10 h-[420px] w-[420px] rounded-full blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(255,46,147,0.1), transparent 70%)' }}
        aria-hidden
      />

      <div className="mx-auto grid max-w-[1240px] grid-cols-1 items-center gap-7 px-5 md:grid-cols-12 md:gap-8 md:px-6">
        {/* ── copy ── */}
        <div className="md:col-span-6">
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
            className="mt-4 font-display text-hero font-extrabold text-ink md:mt-6"
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
            className="mt-4 max-w-[36ch] text-sub text-muted md:mt-6 md:max-w-[38ch]"
          >
            Scroll short videos from creators you trust — then buy the thing in the video without
            leaving it. Every category, on camera.
          </p>

          <div
            data-enter="rise"
            style={{ '--i': 3 } as React.CSSProperties}
            className="mt-6 flex flex-wrap items-center gap-3 md:mt-8"
          >
            <a
              href="/auth/signup"
              className="inline-flex items-center gap-2 rounded-full bg-coral px-7 py-4 text-[17px] font-bold text-ink shadow-cta transition-[transform,filter] duration-[350ms] ease-spring hover:brightness-105 active:scale-[0.96]"
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

          <SocialProof className="mt-8 hidden md:flex" />
        </div>

        {/* ── the hero visual ── */}
        <div className="relative md:col-span-6" data-enter="lift" style={{ '--i': 2 } as React.CSSProperties}>
          <div className="relative mx-auto w-full max-w-[420px] md:max-w-[460px] lg:max-w-[500px] xl:max-w-[520px]">
            {/* pedestal glow directly behind the device */}
            <span
              className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[80%] w-[112%] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
              style={{ background: 'radial-gradient(ellipse at center, rgba(255,75,46,0.18), rgba(255,199,179,0.26) 45%, transparent 72%)' }}
              aria-hidden
            />

            <div
              className="anim-float [--tilt:0deg] md:[--tilt:-1.5deg]"
              style={{ '--float-dur': '9s' } as React.CSSProperties}
            >
              <Image
                src="/landing/hero-phone.webp"
                alt="The Drip app: a creator holding a coral BoomBox Mini speaker, with the product's price and a Buy button docked over the video."
                width={1122}
                height={1402}
                preload
                fetchPriority="high"
                sizes="(max-width: 767px) 92vw, (max-width: 1023px) 46vw, (max-width: 1279px) 500px, 520px"
                className="h-auto w-full"
              />
            </div>

            {/* left margin, above the coral scribble: clears the device edge */}
            <FloatChip className="left-[-9%] top-[12%] hidden max-w-[190px] xl:flex" tilt={-4} dur={6.5}>
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-amber/20 text-amber">
                <Glyph.Bolt size={14} />
              </span>
              <span className="whitespace-nowrap text-[13px] font-semibold text-ink">
                Sold out in <span data-num>40 min</span>
              </span>
            </FloatChip>

            {/* below the tab bar, past the phone's chin — never over a label */}
            <FloatChip
              className="-bottom-[2%] right-[1%] flex max-w-[190px] md:-bottom-[3%] md:right-[-2%] xl:right-[-7%]"
              tilt={5}
              dur={7.5}
              delay={0.9}
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-cobalt/12 text-cobalt md:h-7 md:w-7">
                <Glyph.Check size={13} strokeWidth={2.8} />
              </span>
              <span className="whitespace-nowrap text-[12px] font-semibold text-ink md:text-[13px]">
                One-tap checkout
              </span>
            </FloatChip>
          </div>

          <SocialProof className="mt-10 flex md:hidden" />
        </div>
      </div>
    </section>
  );
}
