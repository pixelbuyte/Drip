'use client';

import { useEffect, useRef, useState } from 'react';

const CHIPS = ['chunky white sneakers', 'lip oil', 'desk setup glow-up', 'gifts under $50', 'airport outfit'];

function Magnifier() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.75" />
      <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export function SearchField({ className = '' }: { className?: string }) {
  return (
    <label
      className={`flex h-11 items-center gap-2.5 rounded-full border border-hairline-strong bg-card px-4 text-muted transition-[border-color,box-shadow] duration-200 focus-within:border-coral focus-within:shadow-[0_0_0_4px_rgba(255,75,46,0.18)] ${className}`}
    >
      <Magnifier />
      <input
        type="search"
        placeholder="What are you looking for?"
        className="w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
        aria-label="Search products"
      />
    </label>
  );
}

export function SearchChips({ className = '' }: { className?: string }) {
  return (
    <div className={`rail md:flex-wrap md:overflow-visible ${className}`}>
      {CHIPS.map((c) => (
        <button
          key={c}
          type="button"
          className="whitespace-nowrap rounded-full border border-hairline-strong bg-card px-3.5 py-1.5 text-[13px] font-semibold text-ink transition-colors duration-150 hover:border-coral/30 hover:bg-coral/10 hover:text-coral-deep"
        >
          {c}
        </button>
      ))}
    </div>
  );
}

const LINKS = [
  { href: '#feed', label: 'Feed' },
  { href: '#categories', label: 'Categories' },
  { href: '#creators', label: 'Creators' },
  { href: '#lists', label: 'My List' },
];

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
      <div ref={sentinel} className="absolute top-0 h-8 w-full" aria-hidden />

      <header
        className={`fixed inset-x-0 top-0 z-50 transition-[background-color,box-shadow] duration-300 ${
          stuck ? 'bg-card/90 shadow-nav backdrop-blur-md' : 'bg-transparent'
        }`}
      >
        <div className="mx-auto flex h-16 max-w-[1240px] items-center gap-4 px-5 md:px-6">
          <a href="/" className="shrink-0 font-display text-[22px] font-extrabold tracking-[-0.03em] text-ink">
            Drip<span className="text-coral">.</span>
          </a>

          <SearchField className="mx-2 hidden max-w-[560px] flex-1 md:flex" />

          <nav className="ml-auto hidden items-center gap-1 md:flex">
            {LINKS.slice(0, 3).map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="rounded-full px-3 py-2 text-[15px] font-semibold text-ink transition-colors duration-150 hover:text-coral-deep"
              >
                {l.label}
              </a>
            ))}
            <a
              href="/auth/login"
              className="rounded-full px-3 py-2 text-[15px] font-semibold text-ink transition-colors duration-150 hover:text-coral-deep"
            >
              Sign in
            </a>
            <a
              href="/auth/signup"
              className="ml-2 rounded-full bg-coral px-5 py-2.5 text-[15px] font-bold text-ink shadow-cta transition-transform duration-150 active:scale-[0.97]"
            >
              Start Shopping
            </a>
          </nav>

          <button
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            className="relative ml-auto flex h-11 w-11 items-center justify-center md:hidden"
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
            Start Shopping
          </a>
        </div>
      </div>
    </>
  );
}
