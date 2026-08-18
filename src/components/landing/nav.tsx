'use client';

import { useEffect, useRef, useState } from 'react';
import Clock from './clock';

const LINKS = [
  { href: '#mechanism', label: 'How it works' },
  { href: '#statement', label: 'What it costs' },
  { href: '/auth/login', label: 'Sign in' },
];

function ArrowGlyph() {
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

export default function Nav() {
  const [stuck, setStuck] = useState(false);
  const [open, setOpen] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  // The pill never resizes on scroll — width is a layout property and
  // animating it is banned. It materialises: only opacity and a background
  // on a fixed element, which is where backdrop-blur is legal.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), {
      threshold: 0,
    });
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
      <div ref={sentinel} className="absolute top-0 h-10 w-full" aria-hidden />

      <header className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-5">
        <div
          className={`bezel pointer-events-auto mt-5 hidden w-max rounded-full p-1 transition-[background-color,box-shadow,opacity] duration-[400ms] ease-instrument md:block ${
            stuck ? 'bg-s2/70 shadow-module backdrop-blur-xl' : 'bg-transparent'
          }`}
          style={stuck ? { boxShadow: 'var(--inset-core)' } : undefined}
        >
          <nav className="flex items-center gap-1 rounded-full pl-5 pr-1">
            <a href="/" className="font-display text-[1.0625rem] font-semibold tracking-[-0.03em]">
              Drip
            </a>
            <span className="mx-3 h-4 w-px bg-edge-2" aria-hidden />
            <span className="font-mono text-mono-s tracking-mono-label text-fg-faint">US · USD</span>
            <span className="mx-3 h-4 w-px bg-edge-2" aria-hidden />
            {LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="rounded-full px-3 py-2 text-[0.875rem] text-fg-muted transition-colors duration-[180ms] ease-state hover:text-fg"
              >
                {l.label}
              </a>
            ))}
            <a
              href="/auth/signup"
              className="group ml-2 inline-flex items-center gap-3 rounded-full bg-fg py-1.5 pl-5 pr-1.5 text-[0.875rem] font-medium text-void transition-transform duration-[180ms] ease-state active:scale-[0.985]"
            >
              Claim your handle
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black/[0.08] transition-transform duration-[240ms] ease-state group-hover:translate-x-[2px] group-hover:-translate-y-[1px] group-hover:scale-105">
                <ArrowGlyph />
              </span>
            </a>
          </nav>
        </div>

        {/* Mobile: wordmark + hamburger that morphs to a true X */}
        <div
          className={`bezel pointer-events-auto mt-4 flex w-full items-center justify-between rounded-full p-1 pl-5 transition-[background-color] duration-[400ms] ease-instrument md:hidden ${
            stuck ? 'bg-s2/80 backdrop-blur-xl' : 'bg-transparent'
          }`}
        >
          <a href="/" className="font-display text-[1.0625rem] font-semibold tracking-[-0.03em]">
            Drip
          </a>
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            className="relative flex h-11 w-11 items-center justify-center"
          >
            <span
              className={`absolute h-px w-5 bg-fg transition-transform duration-[320ms] ease-quick ${
                open ? 'rotate-45' : '-translate-y-[3px]'
              }`}
            />
            <span
              className={`absolute h-px w-5 bg-fg transition-transform duration-[320ms] ease-quick ${
                open ? '-rotate-45' : 'translate-y-[3px]'
              }`}
            />
          </button>
        </div>
      </header>

      {/* Full-screen overlay with staggered link reveal */}
      <div
        className={`fixed inset-0 z-40 bg-void/90 backdrop-blur-3xl transition-opacity duration-[320ms] ease-quick md:hidden ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <div className="flex h-full flex-col justify-center gap-2 px-8">
          {[...LINKS, { href: '/auth/signup', label: 'Claim your handle' }].map((l, i) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className={`py-3 font-display text-display-m font-semibold transition-all duration-[420ms] ease-instrument ${
                open ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0'
              }`}
              style={{ transitionDelay: `${100 + i * 50}ms` }}
            >
              {l.label}
            </a>
          ))}
          <div className="mt-8 flex items-center gap-2 font-mono text-mono-s tracking-mono-label text-fg-faint">
            <span className="h-[5px] w-[5px] rounded-full bg-signal" />
            SYSTEMS NOMINAL <Clock className="text-fg-faint" />
          </div>
        </div>
      </div>
    </>
  );
}
