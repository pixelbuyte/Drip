import { Glyph, SCENE, StatusGlyphs, Sticker, type StickerKind } from './icons';

/**
 * The hero's anchor: one real app screen, top to bottom — status bar,
 * brand + search, category chips, the video card with its creator row and
 * buy chip, the right-hand action rail, and the bottom tab bar with the
 * home indicator. It is never cropped; the tab bar is part of the pitch
 * ("this is an app you'd actually live in"), so the whole frame is always
 * in view.
 *
 * Built in DOM + SVG rather than a raster screenshot so it stays crisp at
 * every density, inherits the page's real tokens, and can be swapped for a
 * real screenshot later by replacing the SCREEN block alone.
 */

const CHIPS: { label: string; kind?: StickerKind; active?: boolean }[] = [
  { label: 'For you', active: true },
  { label: 'Fashion', kind: 'sneaker' },
  { label: 'Beauty', kind: 'lipoil' },
  { label: 'Home', kind: 'armchair' },
  { label: 'Tech', kind: 'earbuds' },
];

function RailButton({ icon, count, tone = 'text-ink' }: { icon: React.ReactNode; count?: string; tone?: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className={`grid h-10 w-10 place-items-center rounded-full bg-white/92 shadow-[0_6px_16px_-6px_rgba(0,0,0,0.35)] backdrop-blur ${tone}`}>
        {icon}
      </span>
      {count && <span className="text-[10.5px] font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">{count}</span>}
    </div>
  );
}

function Tab({ icon, label, active = false, badge }: { icon: React.ReactNode; label: string; active?: boolean; badge?: string }) {
  return (
    <div className={`relative flex w-12 flex-col items-center gap-1 ${active ? 'text-coral' : 'text-ink/55'}`}>
      {icon}
      <span className={`text-[10px] font-semibold ${active ? 'text-coral-deep' : ''}`}>{label}</span>
      {badge && (
        <span className="absolute -top-1 right-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-coral px-1 text-[9.5px] font-extrabold text-ink ring-2 ring-white">
          {badge}
        </span>
      )}
    </div>
  );
}

export default function PhoneMockup({ className = '' }: { className?: string }) {
  const scene = SCENE.sneaker;
  return (
    <div className={`relative w-[292px] md:w-[320px] ${className}`} style={{ aspectRatio: '9 / 19' }} role="img" aria-label="The Drip app: a video feed where every video is shoppable">
      {/* ── frame ── */}
      <div
        className="absolute inset-0 rounded-[54px] bg-[#1a1512]"
        style={{
          boxShadow:
            '0 40px 90px -30px rgba(32,26,23,0.55), 0 18px 40px -20px rgba(32,26,23,0.35), inset 0 0 0 2px rgba(255,255,255,0.06)',
        }}
      >
        <span className="absolute inset-[3px] rounded-[51px] ring-1 ring-white/10" aria-hidden />
        {/* buttons */}
        <span className="absolute -left-[3px] top-[118px] h-7 w-[3px] rounded-l bg-[#2b2420]" aria-hidden />
        <span className="absolute -left-[3px] top-[164px] h-12 w-[3px] rounded-l bg-[#2b2420]" aria-hidden />
        <span className="absolute -left-[3px] top-[222px] h-12 w-[3px] rounded-l bg-[#2b2420]" aria-hidden />
        <span className="absolute -right-[3px] top-[186px] h-[72px] w-[3px] rounded-r bg-[#2b2420]" aria-hidden />
      </div>

      {/* ── SCREEN ── */}
      <div className="absolute inset-[10px] flex flex-col overflow-hidden rounded-[44px] bg-cream">
        {/* dynamic island */}
        <span className="absolute left-1/2 top-3 z-20 h-[26px] w-[96px] -translate-x-1/2 rounded-full bg-[#0f0c0b]" aria-hidden />

        {/* status bar */}
        <div className="flex items-center justify-between px-7 pt-[15px] text-[12.5px] font-semibold text-ink">
          <span data-num>9:41</span>
          <StatusGlyphs />
        </div>

        {/* brand row */}
        <div className="mt-3 flex items-center justify-between px-5">
          <span className="font-display text-[22px] font-extrabold tracking-[-0.04em] text-ink">
            Drip<span className="text-coral">.</span>
          </span>
          <div className="flex items-center gap-2 text-ink">
            <span className="relative grid h-9 w-9 place-items-center rounded-full bg-white shadow-[0_2px_8px_-2px_rgba(32,26,23,0.18)]">
              <Glyph.Bell size={18} />
              <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-coral ring-2 ring-white" />
            </span>
            <span className="grid h-9 w-9 place-items-center rounded-full bg-white shadow-[0_2px_8px_-2px_rgba(32,26,23,0.18)]">
              <Glyph.Bag size={18} />
            </span>
          </div>
        </div>

        {/* search */}
        <div className="mx-5 mt-3 flex h-10 items-center gap-2 rounded-full border border-hairline bg-white px-3.5 text-[13px] text-muted shadow-[0_2px_10px_-4px_rgba(32,26,23,0.12)]">
          <Glyph.Search size={16} />
          <span>Search drops, creators…</span>
        </div>

        {/* category chips */}
        <div className="mt-3 flex gap-2 overflow-hidden pl-5">
          {CHIPS.map((c) => (
            <span
              key={c.label}
              className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full pl-1.5 pr-3 text-[12px] font-bold ${
                c.active ? 'bg-ink text-cream pl-3' : 'bg-white text-ink shadow-[0_2px_8px_-3px_rgba(32,26,23,0.15)]'
              }`}
            >
              {c.kind && (
                <span
                  className="grid h-5 w-5 place-items-center rounded-full"
                  style={{ background: `linear-gradient(140deg, ${SCENE[c.kind].from}, ${SCENE[c.kind].to})` }}
                >
                  <Sticker kind={c.kind} size={16} />
                </span>
              )}
              {c.label}
            </span>
          ))}
        </div>

        {/* video card */}
        <div
          className="relative mx-4 mt-3 min-h-0 flex-1 overflow-hidden rounded-[24px]"
          style={{ background: `linear-gradient(160deg, ${scene.from} 0%, ${scene.to} 60%, #ffb39a 100%)` }}
        >
          <span
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(70% 50% at 30% 18%, rgba(255,255,255,0.6), transparent 60%)' }}
          />
          <div className="absolute left-1/2 top-[38%] w-[62%] -translate-x-1/2 -translate-y-1/2">
            <Sticker kind="sneaker" tilt={-12} className="h-full w-full drop-shadow-[0_18px_22px_rgba(255,75,46,0.35)]" />
          </div>

          {/* top pills */}
          <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 text-[10.5px] font-extrabold uppercase tracking-[0.06em] text-ink">
            <span className="anim-dot h-1.5 w-1.5 rounded-full bg-coral" />
            Live drop
          </span>
          <span data-num className="absolute right-3 top-3 rounded-full bg-black/35 px-2 py-1 text-[10.5px] font-bold text-white backdrop-blur">
            0:14
          </span>

          {/* action rail */}
          <div className="absolute bottom-[128px] right-3 flex flex-col gap-3">
            <RailButton icon={<Glyph.Heart size={19} filled />} count="12.4k" tone="text-pink" />
            <RailButton icon={<Glyph.Comment size={19} />} count="318" />
            <RailButton icon={<Glyph.Bookmark size={19} />} count="2.1k" />
            <RailButton icon={<Glyph.Share size={19} />} />
          </div>

          {/* bottom overlay */}
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-[62%] bg-gradient-to-t from-[#1a1512]/70 via-[#1a1512]/25 to-transparent" />
          <div className="absolute inset-x-3.5 bottom-3.5 pr-14">
            <div className="flex items-center gap-2">
              <span
                className="grid h-7 w-7 place-items-center rounded-full text-[10px] font-extrabold text-white ring-2 ring-white/90"
                style={{ background: 'linear-gradient(135deg,#ff8f74,#ff2e93)' }}
              >
                MO
              </span>
              <span className="text-[13px] font-bold text-white">@maya.finds</span>
              <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-cobalt text-white">
                <Glyph.Check size={9} strokeWidth={3.2} />
              </span>
              <span className="ml-auto rounded-full border border-white/70 px-2.5 py-0.5 text-[11px] font-bold text-white">
                Follow
              </span>
            </div>
            <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug text-white/90">
              the cream/coral ones are finally back — runs half a size big, size down
            </p>

            {/* the buy chip — the whole product in one row */}
            <div className="mt-2.5 flex items-center gap-2 rounded-full bg-white p-1 pr-1 shadow-[0_10px_24px_-8px_rgba(0,0,0,0.45)]">
              <span
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full"
                style={{ background: `linear-gradient(140deg, ${scene.from}, ${scene.to})` }}
              >
                <Sticker kind="sneaker" size={24} tilt={-8} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-bold leading-tight text-ink">Suncourt Ace Low</span>
                <span data-num className="block text-[11px] font-semibold leading-tight text-muted">
                  $118 · <s>$148</s>
                </span>
              </span>
              <span className="shrink-0 rounded-full bg-coral px-3.5 py-1.5 text-[12px] font-extrabold text-ink shadow-[0_4px_10px_-4px_rgba(255,75,46,0.6)]">
                Shop
              </span>
            </div>
          </div>
        </div>

        {/* bottom nav */}
        <div className="mt-2.5 shrink-0 border-t border-hairline bg-white/95 px-3 pt-2.5">
          <div className="flex items-start justify-between">
            <Tab icon={<Glyph.Home size={22} filled />} label="Feed" active />
            <Tab icon={<Glyph.Search size={22} />} label="Search" />
            <Tab icon={<Glyph.Cart size={22} />} label="Cart" badge="2" />
            <Tab icon={<Glyph.Bookmark size={22} />} label="Saved" />
            <Tab icon={<Glyph.User size={22} />} label="You" />
          </div>
          <span className="mx-auto mb-2 mt-2 block h-[5px] w-[110px] rounded-full bg-ink/85" aria-hidden />
        </div>
      </div>
    </div>
  );
}
