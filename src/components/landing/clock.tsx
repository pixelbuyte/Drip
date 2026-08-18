'use client';

import { useEffect, useState } from 'react';

// The only thing on this page that moves forever. It is a readout, not
// decoration. Renders a stable placeholder on the server so hydration matches.
export default function Clock({ className = '' }: { className?: string }) {
  const [time, setTime] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      setTime(
        `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <span className={`font-mono text-mono-s tabular-nums ${className}`} suppressHydrationWarning>
      {time ?? '--:--:-- UTC'}
    </span>
  );
}
