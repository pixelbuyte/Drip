import Nav from '@/components/landing/nav';
import Reveal from '@/components/landing/reveal';
import Hero from '@/components/landing/hero';
import Categories from '@/components/landing/categories';
import Creators from '@/components/landing/creators';
import Drops from '@/components/landing/drops';
import FinalCta from '@/components/landing/final-cta';

// Server component; the authenticated redirect lives in src/proxy.ts.

function SectionHead({
  eyebrow,
  title,
  sub,
  aside,
}: {
  eyebrow: string;
  title: React.ReactNode;
  sub?: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-col gap-6 md:mb-12 md:flex-row md:items-end md:justify-between">
      <div>
        <div data-enter="rise">
          <span className="inline-flex items-center gap-2 rounded-full bg-coral/10 px-3.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.08em] text-coral-deep">
            {eyebrow}
          </span>
        </div>
        <h2
          data-enter="rise"
          style={{ '--i': 1 } as React.CSSProperties}
          className="mt-4 max-w-[18ch] font-display text-section font-extrabold text-ink"
        >
          {title}
        </h2>
        {sub && (
          <p
            data-enter="rise"
            style={{ '--i': 2 } as React.CSSProperties}
            className="mt-3 max-w-[52ch] text-sub text-muted"
          >
            {sub}
          </p>
        )}
      </div>
      {aside && (
        <div data-enter="rise" style={{ '--i': 2 } as React.CSSProperties} className="shrink-0">
          {aside}
        </div>
      )}
    </div>
  );
}

function SectionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 rounded-full border border-hairline-strong bg-card px-4 py-2 text-[14px] font-semibold text-ink transition-colors duration-150 hover:border-coral/40 hover:text-coral-deep"
    >
      {children}
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" />
      </svg>
    </a>
  );
}

export default function Home() {
  return (
    <div className="relative min-h-[100dvh] overflow-x-clip bg-cream">
      <Nav />
      <Reveal />

      <main>
        <Hero />

        {/* ══ CATEGORIES ═══════════════════════════════════════════════════ */}
        <section id="categories" className="mx-auto max-w-[1240px] scroll-mt-24 px-5 py-16 md:px-6 md:py-24">
          <SectionHead
            eyebrow="Categories"
            title="Every category, on camera."
            sub="Pick a lane or let the feed find you. Every drop is a video first and a listing second."
            aside={<SectionLink href="/feed">Browse the feed</SectionLink>}
          />
          <Categories />
        </section>

        {/* ══ CREATORS ═════════════════════════════════════════════════════ */}
        <section id="creators" className="mx-auto max-w-[1240px] scroll-mt-24 px-5 py-16 md:px-6 md:py-24">
          <SectionHead
            eyebrow="Creators"
            title="Shop through people with taste."
            sub="Real people with real carts. Follow the taste, skip the guesswork."
            aside={<SectionLink href="/auth/signup">Become a creator</SectionLink>}
          />
          <Creators />
        </section>

        {/* ══ DROPS ════════════════════════════════════════════════════════ */}
        <section id="drops" className="mx-auto max-w-[1240px] scroll-mt-24 px-5 py-16 md:px-6 md:py-24">
          <SectionHead
            eyebrow="Trending"
            title="Drops selling out this week."
            sub="Small runs, short windows. Catch them mid-rise or watch them go."
            aside={<SectionLink href="/feed">See all drops</SectionLink>}
          />
          <Drops />
        </section>

        {/* ══ FINAL CTA ════════════════════════════════════════════════════ */}
        <section className="mx-auto max-w-[1240px] px-5 pb-8 pt-8 md:px-6 md:pb-16 md:pt-16">
          <FinalCta />
        </section>

        {/* ══ FOOTER ═══════════════════════════════════════════════════════ */}
        <footer className="border-t border-hairline">
          <div className="mx-auto max-w-[1240px] px-5 py-14 md:px-6">
            <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="font-display text-[28px] font-extrabold tracking-[-0.04em] text-ink">
                  Drip<span className="text-coral">.</span>
                </div>
                <p className="mt-3 max-w-[36ch] text-[14px] leading-[1.5] text-muted">
                  Video-first shopping. See it, want it, buy it — without leaving the video.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
                {[
                  { head: 'Shop', links: [['Feed', '/feed'], ['Categories', '#categories'], ['Drops', '#drops'], ['Search', '/search']] },
                  { head: 'Creators', links: [['Become a creator', '/auth/signup'], ['Creator feeds', '#creators'], ['Studio', '/studio']] },
                  { head: 'Company', links: [['About', '/'], ['Brand partnerships', '/']] },
                  { head: 'Legal', links: [['Terms', '/legal/terms'], ['Privacy', '/legal/privacy'], ['Prohibited items', '/legal/prohibited-items']] },
                ].map((col) => (
                  <div key={col.head}>
                    <div className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">{col.head}</div>
                    <ul className="mt-3 space-y-2">
                      {col.links.map(([label, href]) => (
                        <li key={label}>
                          <a href={href} className="text-[13.5px] font-semibold text-ink transition-colors hover:text-coral-deep">
                            {label}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-6 text-[12.5px] text-muted">
              <span>© 2026 Drip</span>
              <span>Made for thumbs.</span>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
