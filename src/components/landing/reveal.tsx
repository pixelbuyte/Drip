'use client';

import { useEffect } from 'react';

// One observer for the whole page. Every element carrying [data-enter] gets
// .is-in when it crosses the threshold, and the CSS transition does the rest.
// Gated in JS as well as CSS: without the JS gate we would still build
// observers and animate things nobody asked to see.
export default function Reveal() {
  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-enter]'));
    if (!nodes.length) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    if (reduced.matches) {
      nodes.forEach((n) => n.classList.add('is-in'));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-in');
          io.unobserve(entry.target); // fires once, then stops
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' }
    );

    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, []);

  return null;
}
