import Nav from '@/components/landing/nav';
import Reveal from '@/components/landing/reveal';
import Clock from '@/components/landing/clock';
import Settlement from '@/components/landing/settlement';
import Rail from '@/components/landing/rail';
import Bays from '@/components/landing/bays';
import Ledger from '@/components/landing/ledger';
import WorkingEnd from '@/components/landing/working-end';
import Tail from '@/components/landing/tail';
import Film from '@/components/landing/film';

// Server component. The authenticated redirect lives in src/proxy.ts, so the
// hero paints in the initial HTML instead of behind a getSession() round-trip.

function Eyebrow({ children, tone = 'faint' }: { children: React.ReactNode; tone?: 'faint' | 'signal' }) {
  return (
    <span className="bezel inline-flex rounded-full bg-s2 p-[3px]">
      <span className="inline-flex items-center gap-2 rounded-full bg-s3 px-3 py-1">
        <span
          className={`h-[5px] w-[5px] rounded-full ${tone === 'signal' ? 'bg-signal' : 'bg-fg-faint'}`}
        />
        <span className="font-mono text-mono-s tracking-mono-eyebrow text-fg-faint">{children}</span>
      </span>
    </span>
  );
}

function Arrow() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
      <path
        d="M2.5 10.5L10.5 2.5M10.5 2.5H4.5M10.5 2.5V8.5"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PrimaryCta({ children = 'Claim your handle' }: { children?: string }) {
  return (
    <a
      href="/auth/signup"
      className="group inline-flex items-center gap-4 rounded-full bg-fg py-2 pl-7 pr-2 text-[0.9375rem] font-medium text-void transition-transform duration-[180ms] ease-state active:scale-[0.985]"
    >
      {children}
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/[0.08] transition-transform duration-[240ms] ease-state group-hover:translate-x-[2px] group-hover:-translate-y-[1px] group-hover:scale-105">
        <Arrow />
      </span>
    </a>
  );
}

/** Three persistent vertical hairlines mirroring the content grid. Section
 *  rules cross them — the intersections are what make the page read as
 *  engineered onto a grid rather than assembled from centred divs. */
function GridRules() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 hidden md:block" aria-hidden>
      <div className="mx-auto grid h-full max-w-[1240px] grid-cols-12 gap-x-6 px-6">
        {[4, 7, 10].map((c) => (
          <div
            key={c}
            style={{ gridColumnStart: c }}
            className="-ml-3 h-full w-px justify-self-start bg-grid-rule"
          />
        ))}
      </div>
    </div>
  );
}

const PARTNERS = [
  { name: 'Stripe', line: 'CARD PROCESSING · PCI · PAYOUTS', mid: false },
  { name: 'Mux', line: 'VIDEO ENCODE · DELIVERY', mid: true },
  { name: 'EasyPost + USPS', line: 'LABEL PURCHASE · TRACKING', mid: false },
];

export default function Home() {
  return (
    <div className="dither relative min-h-dvh overflow-x-clip bg-void">
      <GridRules />
      <Nav />
      <Reveal />

      <main className="relative z-10">
        {/* ══ 01 · THE SIGNAL PATH ═════════════════════════════════════════ */}
        <section className="mx-auto flex min-h-[100dvh] max-w-[1240px] items-center px-5 pb-20 pt-28 md:px-6 md:pt-32">
          <div className="grid w-full gap-14 md:grid-cols-12 md:gap-6">
            {/* on mobile the module leads: the proof belongs on the first
                screen, where the audience actually is */}
            <div className="order-1 md:order-2 md:col-span-5">
              <Settlement />
            </div>

            <div className="order-2 md:order-1 md:col-span-7">
              <div data-enter="rise">
                <Eyebrow tone="signal">LIVE · US ONLY · USD</Eyebrow>
              </div>
              <h1
                data-enter="rise"
                style={{ '--i': 1 } as React.CSSProperties}
                className="mt-7 font-display text-display-xl font-semibold text-fg"
              >
                She posts the video.
                <br />
                The video is
                <br />
                the store.
              </h1>
              <p
                data-enter="rise"
                style={{ '--i': 2 } as React.CSSProperties}
                className="mt-8 max-w-[46ch] text-body-l text-fg-muted"
              >
                Upload one vertical video. Tag it with a price. Share one link. Buyers watch
                full-screen and tap once — Apple Pay, no account, no app. Drip buys the USPS label
                and emails the tracking. You pack the box.
              </p>
              <div
                data-enter="rise"
                style={{ '--i': 3 } as React.CSSProperties}
                className="mt-10 flex flex-wrap items-center gap-3"
              >
                <PrimaryCta />
                <a
                  href="#working-end"
                  className="bezel inline-flex rounded-full px-6 py-3 text-[0.9375rem] text-fg-muted transition-colors duration-[180ms] ease-state hover:text-fg"
                >
                  See a live drop
                </a>
              </div>
              <p
                data-enter="rise"
                style={{ '--i': 4 } as React.CSSProperties}
                className="mt-7 font-mono text-mono-s tracking-mono-label text-fg-faint"
              >
                0% DRIP COMMISSION · 2.9% + 30¢ CARD PROCESSING · FOUNDING SELLERS
              </p>
            </div>
          </div>
        </section>

        {/* ══ 02 · THE RAIL ════════════════════════════════════════════════ */}
        <section className="border-y border-edge-1">
          <div className="mx-auto max-w-[1240px] px-5 md:px-6">
            <Rail />
          </div>
        </section>

        {/* ══ 03 · THE FILM ════════════════════════════════════════════════ */}
        <section className="mx-auto max-w-[1240px] px-5 py-24 md:px-6 md:py-32">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <div data-enter="rise">
                <Eyebrow>03 · THE FILM</Eyebrow>
              </div>
              <h2
                data-enter="rise"
                style={{ '--i': 1 } as React.CSSProperties}
                className="mt-7 max-w-[18ch] font-display text-display-l font-semibold text-fg"
              >
                The whole product, in thirty-five seconds.
              </h2>
            </div>
            <p
              data-enter="rise"
              style={{ '--i': 2 } as React.CSSProperties}
              className="font-mono text-mono-s tracking-mono-label text-fg-faint"
            >
              35s · NO SOUND
            </p>
          </div>
          <div data-enter="lift" style={{ '--i': 3 } as React.CSSProperties} className="mt-12">
            <Film />
          </div>
        </section>

        {/* ══ 03 · THREE BAYS ══════════════════════════════════════════════ */}
        <section id="mechanism" className="mx-auto max-w-[1240px] px-5 py-24 md:px-6 md:py-40">
          <div data-enter="rise">
            <Eyebrow>04 · THE MECHANISM</Eyebrow>
          </div>
          <h2
            data-enter="rise"
            style={{ '--i': 1 } as React.CSSProperties}
            className="mt-7 max-w-[18ch] font-display text-display-l font-semibold text-fg"
          >
            Three steps. Then you are just packing boxes.
          </h2>
          <div data-enter="lift" style={{ '--i': 2 } as React.CSSProperties} className="mt-14">
            <Bays />
          </div>
        </section>

        {/* ══ 04 · THE STATEMENT (bone chapter) ════════════════════════════ */}
        <section id="statement" className="relative bg-bone text-bone-ink">
          {/* hard cut into paper — never a gradient fade */}
          <div className="h-px w-full bg-signal" aria-hidden />
          <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-6 md:py-40">
            <span className="font-mono text-mono-s tracking-mono-eyebrow text-bone-faint">
              05 · THE STATEMENT
            </span>
            <h2 className="mt-6 max-w-[20ch] font-display text-display-l font-semibold text-bone-ink">
              What a sale costs, to the cent.
            </h2>
            <p className="mt-6 max-w-[62ch] font-serif text-[1.125rem] leading-[1.65] text-bone-muted">
              Card processing takes 2.9% plus 30 cents — the same rate anywhere a card is
              accepted. Drip takes nothing. Founding sellers pay 0% Drip commission, and we
              will not call that free, because the card network is real and you should see it.
              Drag the price to your own number; the arithmetic holds.
            </p>
            <div className="mt-16">
              <Ledger />
            </div>
          </div>
        </section>

        {/* ══ 05 · THE WORKING END ═════════════════════════════════════════ */}
        <section id="working-end" className="mx-auto max-w-[1240px] px-5 py-24 md:px-6 md:py-48">
          <div data-enter="rise">
            <Eyebrow>06 · THE WORKING END</Eyebrow>
          </div>
          <h2
            data-enter="rise"
            style={{ '--i': 1 } as React.CSSProperties}
            className="mt-7 max-w-[20ch] font-display text-display-l font-semibold text-fg"
          >
            One link in your bio. A working checkout behind it.
          </h2>
          <div className="mt-16">
            <WorkingEnd />
          </div>
        </section>

        {/* ══ 06 · THE TAIL ════════════════════════════════════════════════ */}
        <section className="border-t border-edge-1">
          <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-6 md:py-40">
            <div data-enter="rise">
              <Eyebrow>07 · AFTER THE TAP</Eyebrow>
            </div>
            <h2
              data-enter="rise"
              style={{ '--i': 1 } as React.CSSProperties}
              className="mt-7 max-w-[22ch] font-display text-display-l font-semibold text-fg"
            >
              The part other tools leave to you.
            </h2>
            <div className="mt-16">
              <Tail />
            </div>
          </div>
        </section>

        {/* ══ 07 · THE PLATES ══════════════════════════════════════════════ */}
        <section className="mx-auto max-w-[1240px] px-5 py-24 md:px-6 md:py-32">
          <div data-enter="rise">
            <Eyebrow>08 · OPERATING LIMITS</Eyebrow>
          </div>
          <h2
            data-enter="rise"
            style={{ '--i': 1 } as React.CSSProperties}
            className="mt-7 max-w-[20ch] font-display text-display-l font-semibold text-fg"
          >
            No feed. No stall. No middleman.
          </h2>
          <p
            data-enter="rise"
            style={{ '--i': 2 } as React.CSSProperties}
            className="mt-6 max-w-[62ch] text-body-l text-fg-muted"
          >
            Drip is not a marketplace. There is no discovery page to get buried in, no algorithm
            deciding who sees your work, and no percentage taken because a platform brought the
            crowd. You brought the crowd. Buyers never make an account.
          </p>

          <div
            data-enter="lift"
            style={{ '--i': 3 } as React.CSSProperties}
            className="bezel mt-14 rounded-shell bg-s2 p-2 shadow-module"
          >
            <div
              className="grid grid-cols-1 rounded-core bg-s3 md:grid-cols-3"
              style={{ boxShadow: 'var(--inset-core)' }}
            >
              {PARTNERS.map((p, i) => (
                <div
                  key={p.name}
                  className={`border-b border-edge-1 p-7 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0 ${
                    p.mid ? 'bg-s4' : ''
                  }`}
                  style={{ '--i': i } as React.CSSProperties}
                >
                  <div className="font-display text-[1.0625rem] font-medium text-fg">{p.name}</div>
                  <div className="mt-2 font-mono text-mono-s tracking-mono-label text-fg-faint">
                    {p.line}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <p
            data-enter="rise"
            style={{ '--i': 4 } as React.CSSProperties}
            className="mt-8 font-mono text-mono-s tracking-mono-label text-fg-faint"
          >
            US ONLY · USD ONLY · NO BUYER ACCOUNTS · 60s MAX · PROHIBITED ITEMS POLICY APPLIES
          </p>
        </section>

        {/* ══ 08 · THE BOOKEND ═════════════════════════════════════════════ */}
        <section className="border-t border-edge-1">
          <div className="mx-auto grid max-w-[1240px] gap-12 px-5 py-24 md:grid-cols-12 md:px-6 md:py-40">
            <div className="md:col-span-8">
              <h2
                data-enter="mask"
                className="max-w-[16ch] font-display text-display-l font-semibold text-fg"
              >
                <span>Your next post can take payment.</span>
              </h2>
              <div
                data-enter="rise"
                style={{ '--i': 1 } as React.CSSProperties}
                className="mt-10 flex flex-wrap items-baseline gap-6"
              >
                <PrimaryCta />
                <span className="font-mono text-mono-s tracking-mono-label text-fg-faint">
                  NO CONTRACT · NO MONTHLY
                </span>
              </div>
            </div>
            <div className="md:col-span-4">
              <div className="bezel rounded-plate bg-s2 p-1">
                <div className="rounded-plate-core bg-s3 p-5" style={{ boxShadow: 'var(--inset-core)' }}>
                  <div className="font-mono text-mono-s tracking-mono-label text-fg-faint">
                    ON A $48 SALE
                  </div>
                  <dl className="mt-4 space-y-2 font-mono text-mono">
                    {[
                      ['SALE', '$48.00', ''],
                      ['PROCESSING', '−$1.69', ''],
                      ['DRIP', '$0.00', 'text-signal'],
                      ['YOU RECEIVE', '$46.31', 'text-fg'],
                    ].map(([k, v, cls]) => (
                      <div key={k} className="flex items-baseline justify-between gap-3">
                        <dt className="text-fg-faint">{k}</dt>
                        <dd data-num className={cls || 'text-fg-muted'}>
                          {v}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ══ 09 · THE FOOTER ══════════════════════════════════════════════ */}
        <footer className="border-t border-edge-1">
          <div className="mx-auto max-w-[1240px] px-5 py-14 md:px-6">
            <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="font-display text-[1.375rem] font-semibold tracking-[-0.03em] text-fg">
                  Drip
                </div>
                <p className="mt-4 max-w-[46ch] text-body text-fg-muted">
                  Payments by Stripe. Postage by the United States Postal Service.{' '}
                  <span className="text-fg">Sellers keep their audience.</span>
                </p>
              </div>
              <nav className="flex gap-6 font-mono text-mono-s tracking-mono-label text-fg-faint">
                <a href="/legal/terms" className="transition-colors hover:text-fg">
                  TERMS
                </a>
                <a href="/legal/privacy" className="transition-colors hover:text-fg">
                  PRIVACY
                </a>
                <a href="/legal/prohibited-items" className="transition-colors hover:text-fg">
                  PROHIBITED ITEMS
                </a>
              </nav>
            </div>

            <div className="mt-12 flex items-center gap-2 border-t border-edge-1 pt-6">
              <span className="h-[5px] w-[5px] rounded-full bg-signal" />
              <span className="font-mono text-mono-s tracking-mono-label text-fg-faint">
                SYSTEMS NOMINAL
              </span>
              <Clock className="ml-auto text-fg-faint" />
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
