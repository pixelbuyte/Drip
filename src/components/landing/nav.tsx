'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const LINKS = [
  { href: '#categories', label: 'Categories' },
  { href: '#creators', label: 'Creators' },
  { href: '#drops', label: 'Drops' },
  { href: '/feed/demo', label: 'How it works' },
];

function Magnifier() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.75" />
      <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

/** Used by /search (and available to any surface that wants a search box). */
export function SearchField({
  className = '',
  initialValue = '',
}: {
  className?: string;
  /** Seed the box with the active query (the /search results page passes the
   *  current q so refining a search starts from it, not from empty). */
  initialValue?: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);

  const submit = () => {
    const q = value.trim();
    if (!q) return;
    router.push(`/search?q=${encodeURIComponent(q)}`);
  };

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={`flex h-11 items-center gap-2.5 rounded-full border border-hairline-strong bg-card px-4 text-muted transition-[border-color,box-shadow] duration-200 focus-within:border-coral focus-within:shadow-[0_0_0_4px_rgba(255,75,46,0.18)] ${className}`}
    >
      <Magnifier />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="What are you looking for?"
        className="w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
        aria-label="Search products"
      />
    </form>
  );
}

function Wordmark({ className = '' }: { className?: string }) {
  return (
    <a href="/" className={`shrink-0 font-display font-extrabold tracking-[-0.04em] text-ink ${className}`}>
      Drip<span className="text-coral">.</span>
    </a>
  );
}

/**
 * Sticky, glass-on-scroll. Transparent over the hero so the page's first
 * screen is the product, not the chrome; once the sentinel scrolls out it
 * picks up a frosted surface and a hairline shadow.
 */
export default function Nav() {
  const [stuck, setStuck] = useState(false);
  const [open, setOpen] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <>
      <div ref={sentinel} className="absolute top-0 h-6 w-full" aria-hidden />

      <header
        className={`fixed inset-x-0 top-0 z-50 transition-[background-color,box-shadow,backdrop-filter] duration-300 ${
          stuck ? 'bg-cream/85 shadow-nav backdrop-blur-xl' : 'bg-transparent'
        }`}
      >
        <div className="mx-auto flex h-[68px] max-w-[1240px] items-center gap-6 px-5 md:px-6">
          <Wordmark className="text-[24px]" />

          <nav className="mx-auto hidden items-center gap-1 md:flex" aria-label="Primary">
            {LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="rounded-full px-3.5 py-2 text-[14.5px] font-semibold text-ink/75 transition-[background-color,color] duration-200 hover:bg-ink/[0.06] hover:text-ink"
              >
                {l.label}
              </a>
            ))}
          </nav>

          <div className="hidden items-center gap-2 md:flex">
            <a
              href="/auth/login"
              className="rounded-full px-3.5 py-2 text-[14.5px] font-semibold text-ink/80 transition-colors duration-150 hover:text-ink"
            >
              Sign in
            </a>
            <a
              href="/auth/signup"
              className="rounded-full bg-coral px-5 py-2.5 text-[14.5px] font-bold text-ink shadow-cta transition-[transform,filter] duration-[350ms] ease-spring hover:brightness-105 active:scale-[0.96]"
            >
              Get the app
            </a>
          </div>

          <button
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            className="relative ml-auto flex h-11 w-11 items-center justify-center rounded-full md:hidden"
          >
            <span className={`absolute h-[2px] w-5 rounded bg-ink transition-transform duration-300 ${open ? 'rotate-45' : '-translate-y-[4px]'}`} />
            <span className={`absolute h-[2px] w-5 rounded bg-ink transition-transform duration-300 ${open ? '-rotate-45' : 'translate-y-[4px]'}`} />
          </button>
        </div>
      </header>

      {/* mobile overlay */}
      <div
        className={`fixed inset-0 z-40 bg-cream/95 backdrop-blur-xl transition-opacity duration-300 md:hidden ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <div className="flex h-full flex-col justify-center gap-1 px-8">
          {[...LINKS, { href: '/auth/login', label: 'Sign in' }].map((l, i) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className={`py-3 font-display text-[2rem] font-extrabold tracking-[-0.02em] text-ink transition-all duration-[420ms] ease-out ${
                open ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'
              }`}
              style={{ transitionDelay: `${100 + i * 50}ms` }}
            >
              {l.label}
            </a>
          ))}
          <a
            href="/auth/signup"
            onClick={() => setOpen(false)}
            className={`mt-4 w-max rounded-full bg-coral px-7 py-3.5 text-[17px] font-bold text-ink shadow-cta transition-all duration-[420ms] ${
              open ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'
            }`}
            style={{ transitionDelay: '350ms' }}
          >
            Get the app
          </a>
        </div>
      </div>
    </>
  );
}
