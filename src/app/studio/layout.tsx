import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createServerClient_ } from '@/lib/supabase-server';
import { STUDIO_ROUTES, type StudioTab } from '@/lib/studio/types';

/**
 * The Studio shell.
 *
 * Studio is seller-only. The guard lives here rather than in each page so a
 * screen added later cannot forget it — an unauthenticated visitor never gets
 * as far as rendering a child.
 *
 * Mobile is the real target: a seller checks this on a phone between uploads.
 * Bottom tab bar under the thumb at every width below md, side rail above it.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Studio — Drip',
  description: 'What your videos earned, and what to do next.',
};

/**
 * Auth, defensively. `createServerClient_()` throws when Supabase env is
 * missing and `getUser()` throws when the auth service is unreachable —
 * neither should render a stack trace to a seller. Both mean "not signed in
 * as far as we can tell", and the honest response to that is the login page.
 */
async function currentSeller(): Promise<{ id: string; handle: string | null } | null> {
  try {
    const supabase = await createServerClient_();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    // The handle is chrome, not a gate: a failure here must not sign anyone
    // out, so it degrades to null and the rail simply omits it.
    const { data: profile } = await supabase
      .from('profiles')
      .select('handle')
      .eq('id', user.id)
      .maybeSingle();

    return { id: user.id, handle: profile?.handle ?? null };
  } catch {
    return null;
  }
}

type Tab = { key: StudioTab; label: string; href: string; icon: React.ReactNode };

const iconProps = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const TABS: Tab[] = [
  {
    key: 'home',
    label: 'Home',
    href: STUDIO_ROUTES.home,
    icon: (
      <svg {...iconProps}>
        <path d="M3.5 10.4 12 3.8l8.5 6.6" />
        <path d="M5.5 9.2V19a1.2 1.2 0 0 0 1.2 1.2h10.6A1.2 1.2 0 0 0 18.5 19V9.2" />
        <path d="M9.7 20.2v-5.4h4.6v5.4" />
      </svg>
    ),
  },
  {
    key: 'videos',
    label: 'Videos',
    href: STUDIO_ROUTES.videos,
    icon: (
      <svg {...iconProps}>
        <rect x="3.2" y="4.6" width="17.6" height="14.8" rx="3.4" />
        <path d="M10.4 9.6 15 12l-4.6 2.4Z" />
      </svg>
    ),
  },
  {
    key: 'money',
    label: 'Money',
    href: STUDIO_ROUTES.money,
    icon: (
      <svg {...iconProps}>
        <rect x="2.6" y="5.6" width="18.8" height="12.8" rx="2.6" />
        <circle cx="12" cy="12" r="2.6" />
        <path d="M6 9.4v5.2M18 9.4v5.2" />
      </svg>
    ),
  },
];

/**
 * Active-tab marking.
 *
 * The pathname is only knowable on the client, and this shell must stay a
 * single server file (the nav is specified to live in the layout), so the
 * marking is done by a small inline script rather than a `usePathname` client
 * component. It sets `aria-current="page"`, which is both the accessibility
 * contract and the styling hook, so extracting a proper client nav later is a
 * drop-in swap: keep `data-studio-tab` and `aria-current` and nothing else
 * changes.
 *
 * Three triggers cover every way the tab can change:
 *   - once at parse time, for the initial render and any full page load;
 *   - on capture-phase click, so a soft navigation highlights instantly
 *     rather than waiting for the route to resolve;
 *   - on popstate/pageshow, for back, forward and bfcache restores.
 *
 * Without JS the tabs still navigate; they just do not highlight.
 */
const TAB_SCRIPT = `(function(){
var K=[["/studio/videos","videos"],["/studio/money","money"]];
function key(p){for(var i=0;i<K.length;i++){if(p===K[i][0]||p.indexOf(K[i][0]+"/")===0)return K[i][1];}
return (p==="/studio"||p==="/studio/")?"home":"";}
function mark(k){var e=document.querySelectorAll("[data-studio-tab]");
for(var i=0;i<e.length;i++){if(e[i].getAttribute("data-studio-tab")===k){e[i].setAttribute("aria-current","page");}else{e[i].removeAttribute("aria-current");}}}
function sync(){mark(key(location.pathname));}
sync();
document.addEventListener("click",function(ev){
var t=ev.target;if(!t||!t.closest)return;var a=t.closest("[data-studio-tab]");if(a)mark(a.getAttribute("data-studio-tab"));},true);
addEventListener("popstate",sync);addEventListener("pageshow",sync);
})();`;

export default async function StudioLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const seller = await currentSeller();
  // Outside any try/catch: redirect() signals by throwing.
  if (!seller) redirect('/auth/login');

  return (
    <div className="flex min-h-[100dvh] flex-1 flex-col bg-cream">
      {/* ── Side rail, md+ ─────────────────────────────────────────────── */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[232px] flex-col border-r border-hairline bg-card px-4 py-7 md:flex">
        <Link
          href={STUDIO_ROUTES.home}
          className="px-3 font-display text-[23px] font-extrabold tracking-[-0.025em] text-ink"
        >
          Studio
        </Link>
        {seller.handle && (
          <p className="mt-1 px-3 text-[13px] font-medium text-muted">@{seller.handle}</p>
        )}

        <nav aria-label="Studio" className="mt-8">
          <ul className="grid grid-cols-1 gap-1">
            {TABS.map((tab) => (
              <li key={tab.key}>
                <Link
                  href={tab.href}
                  data-studio-tab={tab.key}
                  className="group flex min-h-[44px] items-center gap-3 rounded-full px-3 py-2.5 text-[15px] font-semibold text-muted transition-colors duration-150 hover:bg-cream hover:text-ink aria-[current=page]:bg-coral/10 aria-[current=page]:font-bold aria-[current=page]:text-coral-deep"
                >
                  {tab.icon}
                  {tab.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-auto px-3">
          <Link
            href={STUDIO_ROUTES.feed}
            className="text-[13px] font-semibold text-muted transition-colors duration-150 hover:text-coral-deep"
          >
            View the feed →
          </Link>
        </div>
      </aside>

      {/* ── Top bar, mobile only ───────────────────────────────────────── */}
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between border-b border-hairline bg-cream/90 px-5 backdrop-blur-md md:hidden">
        <span className="font-display text-[19px] font-extrabold tracking-[-0.025em] text-ink">
          Studio
        </span>
        {seller.handle && (
          <span className="text-[13px] font-semibold text-muted">@{seller.handle}</span>
        )}
      </header>

      {/* ── Content ────────────────────────────────────────────────────── */}
      <main className="flex-1 md:pl-[232px]">
        {/* Clears the fixed tab bar plus the home indicator on iOS. */}
        <div className="pb-[calc(84px+env(safe-area-inset-bottom,0px))] md:pb-16">
          {children}
        </div>
      </main>

      {/* ── Bottom tab bar, mobile only ────────────────────────────────── */}
      <nav
        aria-label="Studio"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-hairline bg-card shadow-nav md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom,0px)' }}
      >
        <ul className="grid grid-cols-3">
          {TABS.map((tab) => (
            <li key={tab.key}>
              <Link
                href={tab.href}
                data-studio-tab={tab.key}
                className="group flex min-h-[58px] flex-col items-center justify-center gap-1 py-2 text-muted transition-colors duration-150 aria-[current=page]:text-coral-deep"
              >
                <span className="flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-150 group-aria-[current=page]:bg-coral/10">
                  {tab.icon}
                </span>
                <span className="text-[11px] font-bold tracking-[0.01em] group-aria-[current=page]:font-extrabold">
                  {tab.label}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <script dangerouslySetInnerHTML={{ __html: TAB_SCRIPT }} />
    </div>
  );
}
