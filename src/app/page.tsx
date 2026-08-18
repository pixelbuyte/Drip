import Nav, { SearchChips, SearchField } from '@/components/landing/nav';
import Reveal from '@/components/landing/reveal';
import HeroFeed from '@/components/landing/hero-feed';
import FeedPreview from '@/components/landing/feed-preview';
import CategoryTiles from '@/components/landing/category-tiles';
import ForYou from '@/components/landing/for-you';
import Creators from '@/components/landing/creators';
import ShoppingList from '@/components/landing/shopping-list';
import Campaign from '@/components/landing/campaign';
import Trending from '@/components/landing/trending';
import Activity from '@/components/landing/activity';
import Film from '@/components/landing/film';

// Server component; the authenticated redirect lives in src/proxy.ts.

function Eyebrow({
  children,
  tone = 'coral',
}: {
  children: React.ReactNode;
  tone?: 'coral' | 'violet' | 'pink';
}) {
  const tones = {
    coral: 'bg-coral/10 text-coral-deep',
    violet: 'bg-violet/10 text-violet',
    pink: 'bg-pink/10 text-pink-deep',
  };
  return (
    <span className={`inline-block rounded-full px-3.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.08em] ${tones[tone]}`}>
      {children}
    </span>
  );
}

function SectionHead({
  eyebrow,
  tone,
  title,
  sub,
}: {
  eyebrow: string;
  tone?: 'coral' | 'violet' | 'pink';
  title: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="mb-8 md:mb-12">
      <div data-enter="rise">
        <Eyebrow tone={tone}>{eyebrow}</Eyebrow>
      </div>
      <h2
        data-enter="rise"
        style={{ '--i': 1 } as React.CSSProperties}
        className="mt-4 max-w-[20ch] font-display text-section font-extrabold text-ink"
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
  );
}

export default function Home() {
  return (
    <div className="relative min-h-[100dvh] overflow-x-clip bg-cream">
      <Nav />
      <Reveal />

      <main>
        {/* ══ HERO ═════════════════════════════════════════════════════════ */}
        <section className="mx-auto max-w-[1240px] px-5 pb-14 pt-24 md:px-6 md:pt-32">
          <div className="grid items-center gap-10 md:grid-cols-12">
            <div className="md:col-span-6">
              <div data-enter="rise">
                <SearchField className="mb-4 flex md:hidden" />
                <SearchChips className="mb-8" />
              </div>
              <h1
                data-enter="rise"
                style={{ '--i': 1 } as React.CSSProperties}
                className="font-display text-hero font-extrabold text-ink"
              >
                Your new favorite way to <span className="text-coral">shop.</span>
              </h1>
              <p
                data-enter="rise"
                style={{ '--i': 2 } as React.CSSProperties}
                className="mt-6 max-w-[38ch] text-sub text-muted"
              >
                Scroll through things you actually want. Save what’s good, watch prices drop,
                shop straight from people with taste.
              </p>
              <div
                data-enter="rise"
                style={{ '--i': 3 } as React.CSSProperties}
                className="mt-9 flex flex-wrap items-center gap-3"
              >
                <a
                  href="/auth/signup"
                  className="rounded-full bg-coral px-7 py-3.5 text-[17px] font-bold text-ink shadow-cta transition-transform duration-[350ms] ease-spring active:scale-[0.96]"
                >
                  Start Shopping
                </a>
                <a
                  href="#feed"
                  className="rounded-full border border-hairline-strong bg-card px-6 py-3.5 text-[15px] font-semibold text-ink transition-colors duration-150 hover:border-coral/30 hover:text-coral-deep"
                >
                  Explore the Feed
                </a>
              </div>
            </div>

            <div className="md:col-span-6" data-enter="rise" style={{ '--i': 3 } as React.CSSProperties}>
              <HeroFeed />
            </div>
          </div>
        </section>

        {/* ══ FEED PREVIEW ═════════════════════════════════════════════════ */}
        <section id="feed" className="mx-auto max-w-[1240px] px-5 py-20 md:px-6 md:py-28">
          <SectionHead
            eyebrow="The Feed"
            title="The feed is the store."
            sub="One flick at a time — no aisles, no dead ends, just things you’ll want."
          />
          <FeedPreview />
        </section>

        {/* ══ CATEGORIES ═══════════════════════════════════════════════════ */}
        <section id="categories" className="mx-auto max-w-[1240px] px-5 py-20 md:px-6 md:py-28">
          <SectionHead
            eyebrow="Categories"
            title="Pick a lane. Or don’t."
            sub="Start anywhere. You’ll end up somewhere better."
          />
          <CategoryTiles />
        </section>

        {/* ══ MADE FOR YOU ═════════════════════════════════════════════════ */}
        <section className="mx-auto max-w-[1240px] px-5 py-20 md:px-6 md:py-28">
          <SectionHead
            eyebrow="For you"
            title="Made for you."
            sub="Because you liked those sneakers… the more you scroll, the better it gets."
          />
          <ForYou />
        </section>

        {/* ══ CREATORS ═════════════════════════════════════════════════════ */}
        <section id="creators" className="mx-auto max-w-[1240px] px-5 py-20 md:px-6 md:py-28">
          <SectionHead
            eyebrow="Creators"
            tone="violet"
            title="Shop what creators are loving."
            sub="Real people, real carts. Follow the taste, skip the guesswork."
          />
          <Creators />
        </section>

        {/* ══ SHOPPING LIST ════════════════════════════════════════════════ */}
        <section id="lists" className="mx-auto max-w-[1240px] px-5 py-20 md:px-6 md:py-28">
          <div className="grid items-center gap-10 md:grid-cols-12">
            <div className="md:col-span-5">
              <div data-enter="rise">
                <Eyebrow tone="pink">Lists</Eyebrow>
              </div>
              <h2
                data-enter="rise"
                style={{ '--i': 1 } as React.CSSProperties}
                className="mt-4 font-display text-section font-extrabold text-ink"
              >
                The list that shops back.
              </h2>
              <p
                data-enter="rise"
                style={{ '--i': 2 } as React.CSSProperties}
                className="mt-4 max-w-[40ch] text-sub text-muted"
              >
                Save anything. Drip watches prices and stock so you don’t have to — and tells
                you the moment it’s worth moving.
              </p>
            </div>
            <div className="md:col-span-7">
              <ShoppingList />
            </div>
          </div>
        </section>

        {/* ══ CAMPAIGN ═════════════════════════════════════════════════════ */}
        <section className="mx-auto max-w-[1240px] px-5 py-20 md:px-6 md:py-28">
          <Campaign />
        </section>

        {/* ══ TRENDING ═════════════════════════════════════════════════════ */}
        <section className="mx-auto max-w-[1240px] px-5 py-20 md:px-6 md:py-28">
          <SectionHead
            eyebrow="Trending"
            title="Trending right now."
            sub="Six finds having a moment. Catch them mid-rise."
          />
          <Trending />
        </section>

        {/* ══ ACTIVITY ═════════════════════════════════════════════════════ */}
        <section className="mx-auto max-w-[1240px] px-5 py-20 md:px-6 md:py-24">
          <SectionHead eyebrow="From the feed" title="Shopping is better together." />
          <Activity />
        </section>

        {/* ══ FILM ═════════════════════════════════════════════════════════ */}
        <section className="mx-auto max-w-[1240px] px-5 py-20 md:px-6 md:py-24">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <SectionHead eyebrow="The film" title="The whole idea, in half a minute." />
            <p className="mb-12 text-[13px] font-semibold text-muted">30s · no sound</p>
          </div>
          <div data-enter="lift">
            <Film />
          </div>
        </section>

        {/* ══ FINAL CTA ════════════════════════════════════════════════════ */}
        <section
          className="px-5 py-24 text-center md:py-32"
          style={{ background: 'radial-gradient(60% 50% at 50% 100%, rgba(255,75,46,0.08), transparent)' }}
        >
          <h2
            data-enter="rise"
            className="mx-auto max-w-[16ch] font-display text-[clamp(2.25rem,6vw,4rem)] font-extrabold leading-[0.98] tracking-[-0.025em] text-ink"
          >
            Ready when your thumb is.
          </h2>
          <p data-enter="rise" style={{ '--i': 1 } as React.CSSProperties} className="mt-4 text-sub text-muted">
            Free to browse. Dangerous to your wishlist.
          </p>
          <div
            data-enter="rise"
            style={{ '--i': 2 } as React.CSSProperties}
            className="mt-9 flex flex-wrap items-center justify-center gap-3"
          >
            <a
              href="/auth/signup"
              className="rounded-full bg-coral px-8 py-4 text-[17px] font-bold text-ink shadow-cta transition-transform duration-150 active:scale-[0.97]"
            >
              Start Shopping
            </a>
            <a
              href="#feed"
              className="rounded-full border border-hairline-strong bg-card px-6 py-4 text-[15px] font-semibold text-ink transition-colors duration-150 hover:border-coral/30 hover:text-coral-deep"
            >
              Just browsing, thanks
            </a>
          </div>
        </section>

        {/* ══ FOOTER ═══════════════════════════════════════════════════════ */}
        <footer className="border-t border-hairline">
          <div className="mx-auto max-w-[1240px] px-5 py-14 md:px-6">
            <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="font-display text-[28px] font-extrabold tracking-[-0.03em] text-ink">
                  Drip<span className="text-coral">.</span>
                </div>
                <p className="mt-3 max-w-[40ch] text-[14px] text-muted">
                  The fun part of wanting things.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
                {[
                  { head: 'Shop', links: [['Feed', '#feed'], ['Categories', '#categories'], ['Trending', '#feed'], ['Drops', '#feed']] },
                  { head: 'Creators', links: [['Become a creator', '/auth/signup'], ['Storefronts', '#creators']] },
                  { head: 'Company', links: [['About', '/'], ['Brand partnerships', '/']] },
                  { head: 'Legal', links: [['Terms', '/legal/terms'], ['Privacy', '/legal/privacy'], ['Prohibited items', '/legal/prohibited-items']] },
                ].map((col) => (
                  <div key={col.head}>
                    <div className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">{col.head}</div>
                    <ul className="mt-3 space-y-2">
                      {col.links.map(([label, href]) => (
                        <li key={label}>
                          <a href={href} className="text-[13px] font-semibold text-ink transition-colors hover:text-coral-deep">
                            {label}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-12 border-t border-hairline pt-6 text-[12px] text-muted">© 2026 Drip</div>
          </div>
        </footer>
      </main>
    </div>
  );
}
