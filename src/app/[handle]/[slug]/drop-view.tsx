'use client';

import MuxPlayer from '@mux/mux-player-react';
import { useState } from 'react';

type VariantDimension = { name: string; options: string[] };

type Props = {
  drop: {
    id: string;
    title: string;
    description: string | null;
    price_cents: number;
    inventory: number;
    variants: VariantDimension[];
    mux_playback_id: string | null;
  };
  seller: { handle: string; display_name: string };
};

export default function DropView({ drop, seller }: Props) {
  const [muted, setMuted] = useState(true);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [isBuying, setIsBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitlistEmail, setWaitlistEmail] = useState('');
  const [waitlistState, setWaitlistState] = useState<'idle' | 'saving' | 'joined'>('idle');
  const [reportState, setReportState] = useState<'idle' | 'open' | 'sent'>('idle');
  const [reportReason, setReportReason] = useState('prohibited_item');

  const soldOut = drop.inventory <= 0;
  const lowStock = !soldOut && drop.inventory <= 5;
  const price = `$${(drop.price_cents / 100).toFixed(2)}`;
  const allSelected = drop.variants.every((d) => selection[d.name]);

  const handleBuy = async () => {
    setError(null);

    if (!allSelected) {
      const missing = drop.variants.find((d) => !selection[d.name]);
      setError(`Please select a ${missing?.name}`);
      return;
    }

    setIsBuying(true);
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          drop_id: drop.id,
          selection: drop.variants.length > 0 ? selection : undefined,
          code: code.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start checkout');

      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setIsBuying(false);
    }
  };

  const handleJoinWaitlist = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setWaitlistState('saving');
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drop_id: drop.id, email: waitlistEmail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not join the waitlist');
      setWaitlistState('joined');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setWaitlistState('idle');
    }
  };

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-ink">
      {/* Full-bleed vertical video */}
      {drop.mux_playback_id && (
        <MuxPlayer
          playbackId={drop.mux_playback_id}
          autoPlay="muted"
          muted={muted}
          loop
          playsInline
          className="absolute inset-0 h-full w-full"
          style={{
            '--controls': 'none',
            '--media-object-fit': 'cover',
            height: '100%',
            width: '100%',
          }}
        />
      )}

      {/* Tap to unmute */}
      <button
        onClick={() => setMuted((m) => !m)}
        aria-label={muted ? 'Unmute video' : 'Mute video'}
        className="absolute right-4 top-4 z-20 flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-xl text-white backdrop-blur-sm"
      >
        {muted ? '🔇' : '🔊'}
      </button>

      {/* Seller badge */}
      <div className="absolute left-4 top-4 z-20 rounded-full bg-black/50 px-3 py-1.5 font-mono text-xs text-paper backdrop-blur">
        @{seller.handle}
      </div>

      {/* Bottom overlay: product info + buy */}
      <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-4 pb-6 pt-16">
        <div className="mx-auto max-w-lg space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h1 className="font-display text-2xl font-bold leading-tight tracking-tight text-paper">{drop.title}</h1>
              {drop.description && (
                <p className="mt-1 text-sm leading-relaxed text-paper/70">{drop.description}</p>
              )}
            </div>
            <div className="text-right">
              <div className="font-mono text-2xl font-semibold text-paper">{price}</div>
              {lowStock && (
                <div className="font-mono text-xs uppercase tracking-wide text-ember">
                  Only {drop.inventory} left
                </div>
              )}
            </div>
          </div>

          {/* Variant pickers */}
          {!soldOut &&
            drop.variants.map((dim) => (
              <div key={dim.name}>
                <div className="mb-1.5 font-mono text-[0.65rem] uppercase tracking-[0.2em] text-paper/60">
                  {dim.name}
                </div>
                <div className="flex flex-wrap gap-2">
                  {dim.options.map((opt) => (
                    <button
                      key={opt}
                      onClick={() => setSelection((s) => ({ ...s, [dim.name]: opt }))}
                      className={`min-h-11 min-w-11 rounded-lg border px-4 py-2 text-sm font-medium transition ${
                        selection[dim.name] === opt
                          ? 'border-paper bg-paper text-ink'
                          : 'border-white/25 bg-white/5 text-paper/80 hover:border-white/50'
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
            ))}

          {/* Discount code */}
          {!soldOut && (
            <div>
              {showCode ? (
                <input
                  type="text"
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                  }
                  maxLength={20}
                  placeholder="DISCOUNT CODE"
                  className="w-full rounded-lg border border-white/25 bg-white/5 px-4 py-2.5 font-mono text-sm text-paper placeholder-paper/40 focus:border-acid focus:outline-none"
                  autoFocus
                />
              ) : (
                <button
                  onClick={() => setShowCode(true)}
                  className="text-sm text-paper/60 underline underline-offset-4 transition hover:text-paper"
                >
                  Have a discount code?
                </button>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-ember/50 bg-ember/15 px-4 py-2.5 text-sm font-medium text-paper">
              {error}
            </div>
          )}

          {/* Buy button — 44px+ tap target */}
          {soldOut ? (
            <div className="space-y-3">
              <div className="w-full rounded-xl border border-ember/40 bg-ember/10 px-4 py-4 text-center font-display text-lg font-bold text-ember">
                Sold Out
              </div>
              {waitlistState === 'joined' ? (
                <div className="rounded-lg border border-acid/40 bg-acid/10 px-4 py-2.5 text-center text-sm font-medium text-acid">
                  You're on the list! We'll email you if it restocks.
                </div>
              ) : (
                <form onSubmit={handleJoinWaitlist} className="flex gap-2">
                  <input
                    type="email"
                    required
                    value={waitlistEmail}
                    onChange={(e) => setWaitlistEmail(e.target.value)}
                    placeholder="you@email.com"
                    className="min-w-0 flex-1 rounded-lg border border-white/25 bg-white/5 px-4 py-2.5 text-sm text-paper placeholder-paper/40 focus:border-acid focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={waitlistState === 'saving'}
                    className="shrink-0 rounded-lg bg-acid px-4 py-2.5 text-sm font-bold text-ink transition hover:brightness-110 disabled:opacity-60"
                  >
                    {waitlistState === 'saving' ? '...' : 'Notify me'}
                  </button>
                </form>
              )}
            </div>
          ) : (
            <button
              onClick={handleBuy}
              disabled={isBuying}
              className="w-full rounded-xl bg-acid px-4 py-4 font-display text-lg font-bold text-ink transition hover:brightness-110 active:scale-[0.98] disabled:opacity-60"
            >
              {isBuying ? 'Starting checkout...' : `Buy now · ${price}`}
            </button>
          )}

          <p className="text-center font-mono text-[0.65rem] tracking-wide text-paper/45">
            Secure checkout by Stripe · Ships from the US · Powered by Drip
          </p>

          {/* Report flow (trust & safety) */}
          <div className="text-center">
            {reportState === 'sent' ? (
              <span className="font-mono text-[0.65rem] text-paper/45">Report received — thank you.</span>
            ) : reportState === 'open' ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await fetch('/api/report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ drop_id: drop.id, reason: reportReason }),
                  });
                  setReportState('sent');
                }}
                className="flex items-center justify-center gap-2"
              >
                <select
                  value={reportReason}
                  onChange={(e) => setReportReason(e.target.value)}
                  className="rounded border border-white/25 bg-ink px-2 py-1 text-xs text-paper"
                >
                  <option value="prohibited_item">Prohibited item</option>
                  <option value="copyright">Copyright</option>
                  <option value="scam">Scam / fraud</option>
                  <option value="other">Other</option>
                </select>
                <button type="submit" className="text-xs text-paper/70 underline underline-offset-2">
                  Submit
                </button>
              </form>
            ) : (
              <button
                onClick={() => setReportState('open')}
                className="font-mono text-[0.65rem] text-paper/35 underline underline-offset-2 transition hover:text-paper/70"
              >
                Report this drop
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
