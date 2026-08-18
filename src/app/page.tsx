'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';

const TICKER = [
  '0% Drip commission',
  'Apple Pay + Google Pay',
  'USPS labels bought for you',
  'No buyer accounts',
  'Live in 60 seconds',
  'Ships from your door',
];

const STEPS = [
  {
    n: '01',
    title: 'Film it once',
    body: 'Upload a vertical clip up to 60 seconds — the one you already shot for your feed.',
  },
  {
    n: '02',
    title: 'Tag the price',
    body: 'Set price, inventory and sizes. Drip weighs the parcel and quotes shipping for you.',
  },
  {
    n: '03',
    title: 'Drop the link',
    body: 'One URL for your bio. They watch, they tap, they pay. The label prints itself.',
  },
];

export default function Home() {
  const router = useRouter();
  const supabase = createClient();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session) {
        router.push('/dashboard');
      } else {
        setIsLoading(false);
      }
    };

    checkAuth();
  }, [router, supabase]);

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-ink">
        <span className="font-mono text-xs uppercase tracking-[0.3em] text-dim">
          Drip
        </span>
      </div>
    );
  }

  return (
    <div className="grain relative min-h-dvh overflow-x-clip bg-ink">
      {/* Ambient wash behind the hero */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[38rem] w-[70rem] -translate-x-1/2 rounded-full opacity-20 blur-[120px]"
        style={{ background: 'radial-gradient(closest-side, #d8ff3e, transparent)' }}
      />

      <div className="relative z-10">
        {/* ---------------------------------------------------------------- nav */}
        <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-6">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-2xl font-extrabold tracking-tight text-paper">
              Drip
            </span>
            <span className="h-1.5 w-1.5 rounded-full bg-acid" />
          </div>
          <nav className="flex items-center gap-2">
            <a
              href="/auth/login"
              className="rounded-full px-4 py-2 text-sm font-medium text-dim transition hover:text-paper"
            >
              Sign in
            </a>
            <a
              href="/auth/signup"
              className="rounded-full bg-paper px-4 py-2 text-sm font-semibold text-ink transition hover:bg-acid"
            >
              Start selling
            </a>
          </nav>
        </header>

        {/* --------------------------------------------------------------- hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-8 pt-10 lg:grid-cols-[1.15fr_0.85fr] lg:pt-20">
          <div className="rise">
            <p
              className="rise-item font-mono text-[0.7rem] uppercase tracking-[0.28em] text-acid"
              style={{ animationDelay: '0ms' }}
            >
              Video commerce · US only
            </p>

            <h1
              className="rise-item mt-5 font-display text-[clamp(3rem,9vw,6.5rem)] font-extrabold leading-[0.86] tracking-[-0.04em] text-paper"
              style={{ animationDelay: '80ms' }}
            >
              Sell it
              <br />
              where they
              <br />
              <span className="relative inline-block">
                already watch
                <svg
                  aria-hidden
                  viewBox="0 0 400 12"
                  preserveAspectRatio="none"
                  className="absolute -bottom-1 left-0 h-2.5 w-full text-acid"
                >
                  <path
                    d="M2 8C80 3 200 2 398 6"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </h1>

            <p
              className="rise-item mt-8 max-w-md text-lg leading-relaxed text-dim"
              style={{ animationDelay: '160ms' }}
            >
              No storefront to build. No marketplace to get buried in. Post the video,
              tag the price, share one link — buyers tap once and it&apos;s theirs.
            </p>

            <div
              className="rise-item mt-9 flex flex-wrap items-center gap-3"
              style={{ animationDelay: '240ms' }}
            >
              <a
                href="/auth/signup"
                className="group inline-flex items-center gap-2 rounded-full bg-acid px-7 py-3.5 font-semibold text-ink transition hover:brightness-110 active:scale-[0.98]"
              >
                Claim your handle
                <span className="transition group-hover:translate-x-0.5">→</span>
              </a>
              <span className="font-mono text-xs text-dim">
                Free · 0% commission for founding sellers
              </span>
            </div>
          </div>

          {/* Product mock: the money page, in miniature */}
          <div
            className="rise-item relative mx-auto w-full max-w-[19rem]"
            style={{ animationDelay: '320ms' }}
          >
            <div className="absolute -inset-6 rounded-[3rem] bg-acid/10 blur-2xl" />
            <div className="relative aspect-[9/16] w-full rotate-[2.5deg] overflow-hidden rounded-[2rem] border border-line bg-ink-raised shadow-[0_40px_80px_-20px_rgba(0,0,0,0.9)]">
              {/* stand-in for the seller's video */}
              <div
                className="absolute inset-0"
                style={{
                  background:
                    'radial-gradient(120% 80% at 30% 15%, #2a2a31 0%, #131316 55%, #0b0b0c 100%)',
                }}
              />
              {/* suggestion of footage: a soft product form, drifting */}
              <div
                aria-hidden
                className="absolute left-1/2 top-[26%] h-44 w-44 -translate-x-1/2 rounded-full opacity-70 blur-2xl"
                style={{
                  background:
                    'conic-gradient(from 210deg, #ff4a26, #e0723f, #8d5cff, #ff4a26)',
                }}
              />
              <div
                aria-hidden
                className="absolute left-1/2 top-[32%] h-24 w-24 -translate-x-1/2 rounded-full bg-paper/10 blur-xl"
              />

              {/* player chrome */}
              <div className="absolute inset-x-3 top-3 flex items-center gap-2">
                <span className="rounded-full bg-black/60 px-2.5 py-1 font-mono text-[0.65rem] text-paper backdrop-blur">
                  @mariposa
                </span>
                <span className="ml-auto flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-[0.6rem] text-paper backdrop-blur">
                  ♪
                </span>
              </div>
              <div className="absolute inset-x-3 top-11 flex items-center gap-2">
                <div className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/20">
                  <div className="h-full w-2/5 rounded-full bg-paper/80" />
                </div>
                <span className="font-mono text-[0.55rem] text-paper/60">0:24</span>
              </div>
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/70 to-transparent p-4 pt-14">
                <div className="flex items-end justify-between gap-2">
                  <div>
                    <div className="font-display text-base font-bold text-paper">
                      Hand-dyed silk scarf
                    </div>
                    <div className="mt-0.5 text-[0.7rem] text-dim">1 of 6 · ships Tue</div>
                  </div>
                  <div className="font-mono text-lg font-semibold text-paper">$48</div>
                </div>
                <div className="mt-3 flex gap-1.5">
                  {['S', 'M', 'L'].map((s, i) => (
                    <span
                      key={s}
                      className={`rounded-md border px-2.5 py-1 text-[0.7rem] ${
                        i === 1
                          ? 'border-paper bg-paper font-semibold text-ink'
                          : 'border-white/25 text-paper/70'
                      }`}
                    >
                      {s}
                    </span>
                  ))}
                </div>
                <div className="mt-3 rounded-xl bg-acid py-2.5 text-center font-semibold text-ink">
                  Buy now · $48
                </div>
                <div className="mt-2 text-center font-mono text-[0.6rem] text-dim">
                  Secure checkout by Stripe
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------- ticker */}
        <div className="relative mt-6 flex overflow-hidden border-y border-line py-3">
          <div className="flex shrink-0 animate-marquee items-center whitespace-nowrap">
            {[...TICKER, ...TICKER].map((item, i) => (
              <span
                key={i}
                className="flex items-center font-mono text-xs uppercase tracking-[0.2em] text-dim"
              >
                <span className="px-6">{item}</span>
                <span className="text-acid">✳</span>
              </span>
            ))}
          </div>
        </div>

        {/* -------------------------------------------------------------- steps */}
        <section className="mx-auto max-w-6xl px-5 py-24">
          <h2 className="max-w-lg font-display text-4xl font-extrabold leading-tight tracking-tight text-paper sm:text-5xl">
            Three steps, then you&apos;re just packing boxes.
          </h2>

          <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
            {STEPS.map((step, i) => (
              <div
                key={step.n}
                className="group relative bg-ink p-8 transition-colors hover:bg-ink-raised"
                style={{ marginTop: `${i * 0}px` }}
              >
                <span className="font-mono text-xs text-acid">{step.n}</span>
                <h3 className="mt-6 font-display text-2xl font-bold tracking-tight text-paper">
                  {step.title}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-dim">{step.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---------------------------------------------------------- the money */}
        <section className="mx-auto max-w-6xl px-5 pb-24">
          <div className="grid gap-10 rounded-3xl border border-line bg-ink-raised p-8 sm:p-12 lg:grid-cols-2">
            <div>
              <p className="font-mono text-[0.7rem] uppercase tracking-[0.28em] text-acid">
                What it costs
              </p>
              <h2 className="mt-5 font-display text-4xl font-extrabold leading-[0.95] tracking-tight text-paper">
                Zero commission,
                <br />
                stated honestly.
              </h2>
              <p className="mt-5 max-w-sm text-sm leading-relaxed text-dim">
                Founding sellers pay Drip nothing on a sale. You still pay the card
                network — 2.9% + 30¢, same as anywhere that takes a card. We take our
                cut only once you tell us the thing works.
              </p>
            </div>

            <div className="space-y-3 self-center">
              <div className="flex items-center justify-between rounded-xl border border-acid/40 bg-acid/5 px-5 py-4">
                <span className="font-display text-lg font-bold text-paper">Drip</span>
                <span className="font-mono text-sm text-acid">0% + processing</span>
              </div>
              <div className="flex items-center justify-between rounded-xl border border-line px-5 py-4">
                <span className="font-display text-lg font-bold text-dim">Whatnot</span>
                <span className="font-mono text-sm text-dim">8% + processing</span>
              </div>
              <div className="flex items-center justify-between rounded-xl border border-line px-5 py-4">
                <span className="font-display text-lg font-bold text-dim">Poshmark</span>
                <span className="font-mono text-sm text-dim">20%</span>
              </div>
              <p className="pt-1 text-center font-mono text-[0.65rem] text-dim/70">
                Competitor rates as published by each platform
              </p>
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------------- cta */}
        <section className="mx-auto max-w-6xl px-5 pb-28 text-center">
          <h2 className="mx-auto max-w-3xl font-display text-[clamp(2.5rem,6vw,4.5rem)] font-extrabold leading-[0.9] tracking-[-0.03em] text-paper">
            Your next post could
            <br />
            have a checkout on it.
          </h2>
          <a
            href="/auth/signup"
            className="mt-10 inline-flex items-center gap-2 rounded-full bg-acid px-8 py-4 text-lg font-semibold text-ink transition hover:brightness-110 active:scale-[0.98]"
          >
            Start selling →
          </a>
        </section>

        {/* ------------------------------------------------------------ footer */}
        <footer className="border-t border-line">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 text-sm text-dim sm:flex-row">
            <span className="font-display font-bold text-paper">Drip</span>
            <div className="flex gap-5 font-mono text-xs">
              <a href="/legal/terms" className="transition hover:text-paper">
                Terms
              </a>
              <a href="/legal/privacy" className="transition hover:text-paper">
                Privacy
              </a>
              <a href="/legal/prohibited-items" className="transition hover:text-paper">
                Prohibited items
              </a>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
