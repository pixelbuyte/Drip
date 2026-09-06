import { useId } from 'react';

/**
 * Landing-page illustration system.
 *
 * Every product/category visual on the landing page is a hand-authored SVG
 * "sticker": gradient-filled shapes lit from one top-left light source, a
 * soft white specular highlight, a thick cream sticker outline (paint-order:
 * stroke, so the outline renders BEHIND the fill without duplicating paths),
 * and a hue-tinted blurred contact shadow underneath. One vocabulary,
 * reused everywhere — the category cards, the phone's video card, creator
 * picks and the drops grid all draw from the same six objects, which is what
 * makes the page read as one product rather than a collage.
 *
 * Gradient ids are namespaced with useId(): the same sticker renders many
 * times on one page, and SVG gradient ids are document-global.
 */

export type StickerKind = 'sneaker' | 'earbuds' | 'lipoil' | 'armchair' | 'mug' | 'plant';

type StickerProps = {
  kind: StickerKind;
  /** CSS size; the SVG is square. */
  size?: number | string;
  className?: string;
  /** Rotation in degrees, applied to the object only (the shadow stays flat). */
  tilt?: number;
  title?: string;
};

const OUTLINE = { stroke: '#fff9f2', strokeWidth: 5, strokeLinejoin: 'round' as const, paintOrder: 'stroke' as const };

export function Sticker({ kind, size = 96, className = '', tilt = 0, title }: StickerProps) {
  const uid = useId().replace(/:/g, '');
  const g = (name: string) => `${uid}-${name}`;
  const url = (name: string) => `url(#${g(name)})`;

  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <filter id={g('blur')} x="-30%" y="-60%" width="160%" height="220%">
          <feGaussianBlur stdDeviation="3.2" />
        </filter>
        {/* per-object gradients */}
        <linearGradient id={g('coral')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff8f74" />
          <stop offset="1" stopColor="#f0391f" />
        </linearGradient>
        <linearGradient id={g('sole')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff7ee" />
          <stop offset="1" stopColor="#efd6c2" />
        </linearGradient>
        <linearGradient id={g('cobalt')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6f92ff" />
          <stop offset="1" stopColor="#2247d9" />
        </linearGradient>
        <linearGradient id={g('cobaltLid')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#b7c8ff" />
          <stop offset="1" stopColor="#5b82ff" />
        </linearGradient>
        <linearGradient id={g('bud')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#dbe3ff" />
        </linearGradient>
        <linearGradient id={g('pink')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff8fc6" />
          <stop offset="1" stopColor="#f01e84" />
        </linearGradient>
        <linearGradient id={g('pinkCap')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffe1ef" />
          <stop offset="1" stopColor="#ffb0d3" />
        </linearGradient>
        <linearGradient id={g('amber')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffd67a" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
        <linearGradient id={g('amberLite')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff0c2" />
          <stop offset="1" stopColor="#ffcf6b" />
        </linearGradient>
        <linearGradient id={g('clay')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f5a98d" />
          <stop offset="1" stopColor="#c9603a" />
        </linearGradient>
        <linearGradient id={g('clayLite')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffd2bf" />
          <stop offset="1" stopColor="#ee9670" />
        </linearGradient>
        <linearGradient id={g('leaf')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b5e86a" />
          <stop offset="1" stopColor="#3f9a2a" />
        </linearGradient>
        <linearGradient id={g('leafDark')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8fd351" />
          <stop offset="1" stopColor="#2f7f22" />
        </linearGradient>
      </defs>

      {/* contact shadow — flat, does not tilt with the object */}
      <ellipse cx="60" cy="103" rx="36" ry="6" fill={SHADOW[kind]} opacity="0.55" filter={`url(#${g('blur')})`} />

      <g transform={tilt ? `rotate(${tilt} 60 60)` : undefined}>
        {kind === 'sneaker' && (
          <>
            <path d="M15 76 Q13 92 28 93 L100 93 Q112 93 111 82 L109 76 Z" fill={url('sole')} {...OUTLINE} />
            <path
              d="M18 76 C20 58 33 44 52 39 C60 37 66 43 74 47 C85 52 97 56 106 66 L109 76 Z"
              fill={url('coral')}
              {...OUTLINE}
            />
            <path d="M18 76 C22 62 31 51 44 46 C41 58 35 68 32 76 Z" fill="#ffc2ae" opacity="0.85" />
            <path d="M40 75 C58 71 80 66 103 68" stroke="#fff" strokeOpacity="0.55" strokeWidth="3" strokeLinecap="round" fill="none" />
            <g stroke="#fff" strokeWidth="3" strokeLinecap="round">
              <path d="M57 50 L67 54" />
              <path d="M53 56 L64 60" />
              <path d="M49 62 L61 66" />
            </g>
            <rect x="93" y="58" width="9" height="12" rx="3" fill="#b83a1c" />
            <ellipse cx="66" cy="50" rx="20" ry="6" fill="#fff" opacity="0.28" transform="rotate(-16 66 50)" />
          </>
        )}

        {kind === 'earbuds' && (
          <>
            <rect x="30" y="46" width="60" height="50" rx="18" fill={url('cobalt')} {...OUTLINE} />
            <rect x="30" y="34" width="60" height="28" rx="14" fill={url('cobaltLid')} {...OUTLINE} />
            <path d="M32 61 H88" stroke="#1d3ab0" strokeOpacity="0.55" strokeWidth="2" />
            <ellipse cx="58" cy="41" rx="22" ry="5" fill="#fff" opacity="0.35" />
            <circle cx="60" cy="74" r="3.2" fill="#c7f03c" />
            <g {...OUTLINE}>
              <path d="M18 40 a9 9 0 1 1 18 0 v2 h-18z" fill={url('bud')} />
              <rect x="20" y="40" width="9" height="18" rx="4.5" fill={url('bud')} />
              <path d="M84 30 a9 9 0 1 1 18 0 v2 h-18z" fill={url('bud')} />
              <rect x="91" y="30" width="9" height="18" rx="4.5" fill={url('bud')} />
            </g>
            <circle cx="24" cy="38" r="3" fill="#c9d3ff" />
            <circle cx="90" cy="28" r="3" fill="#c9d3ff" />
          </>
        )}

        {kind === 'lipoil' && (
          <>
            <path d="M60 99 c0 6 -7 7 -7 13 a7 7 0 0 0 14 0 c0 -6 -7 -7 -7 -13z" fill="#ff2e93" {...OUTLINE} />
            <rect x="43" y="34" width="34" height="66" rx="15" fill={url('pink')} {...OUTLINE} />
            <rect x="43" y="16" width="34" height="26" rx="9" fill={url('pinkCap')} {...OUTLINE} />
            <rect x="43" y="38" width="34" height="6" fill="#d6246e" />
            <rect x="49" y="48" width="6" height="40" rx="3" fill="#fff" opacity="0.45" />
            <rect x="52" y="68" width="18" height="11" rx="4" fill="#fff" opacity="0.9" />
            <circle cx="61" cy="73.5" r="2.4" fill="#ff2e93" />
            <ellipse cx="60" cy="22" rx="12" ry="3" fill="#fff" opacity="0.5" />
          </>
        )}

        {kind === 'armchair' && (
          <>
            <rect x="28" y="28" width="64" height="52" rx="18" fill={url('amber')} {...OUTLINE} />
            <rect x="16" y="56" width="22" height="34" rx="11" fill="#f0930a" {...OUTLINE} />
            <rect x="82" y="56" width="22" height="34" rx="11" fill="#f0930a" {...OUTLINE} />
            <rect x="34" y="66" width="52" height="26" rx="11" fill={url('amberLite')} {...OUTLINE} />
            <rect x="30" y="90" width="9" height="12" rx="3" fill="#7a4a12" />
            <rect x="81" y="90" width="9" height="12" rx="3" fill="#7a4a12" />
            <ellipse cx="52" cy="38" rx="18" ry="5" fill="#fff" opacity="0.35" transform="rotate(-10 52 38)" />
            <path d="M40 72 Q60 66 80 72" stroke="#c97d06" strokeOpacity="0.35" strokeWidth="2" fill="none" />
          </>
        )}

        {kind === 'mug' && (
          <>
            <g stroke="#fff" strokeOpacity="0.8" strokeWidth="3" strokeLinecap="round" fill="none">
              <path d="M44 32 c5 -6 -5 -10 0 -17" />
              <path d="M58 28 c5 -6 -5 -10 0 -17" />
              <path d="M72 32 c5 -6 -5 -10 0 -17" />
            </g>
            <path d="M86 56 a15 15 0 0 1 0 30" stroke="#c9603a" strokeWidth="10" strokeLinecap="round" fill="none" />
            <path d="M86 56 a15 15 0 0 1 0 30" stroke={url('clayLite')} strokeWidth="5" strokeLinecap="round" fill="none" />
            <path d="M30 46 h56 v40 q0 12 -12 12 h-32 q-12 0 -12 -12z" fill={url('clay')} {...OUTLINE} />
            <ellipse cx="58" cy="46" rx="28" ry="7" fill="#fff5ea" {...OUTLINE} />
            <ellipse cx="58" cy="47" rx="22" ry="4.5" fill="#5c3020" />
            <ellipse cx="52" cy="46.5" rx="8" ry="1.6" fill="#fff" opacity="0.35" />
            <rect x="36" y="54" width="6" height="30" rx="3" fill="#fff" opacity="0.3" />
          </>
        )}

        {kind === 'plant' && (
          <>
            <g {...OUTLINE}>
              <ellipse cx="60" cy="44" rx="11" ry="23" fill={url('leafDark')} transform="rotate(-48 60 66)" />
              <ellipse cx="60" cy="44" rx="11" ry="23" fill={url('leafDark')} transform="rotate(48 60 66)" />
              <ellipse cx="60" cy="40" rx="11" ry="24" fill={url('leaf')} transform="rotate(-22 60 66)" />
              <ellipse cx="60" cy="40" rx="11" ry="24" fill={url('leaf')} transform="rotate(22 60 66)" />
              <ellipse cx="60" cy="36" rx="11" ry="26" fill={url('leaf')} />
            </g>
            <g stroke="#e9ffd0" strokeOpacity="0.55" strokeWidth="1.6" strokeLinecap="round" fill="none">
              <path d="M60 60 V18" />
              <path d="M60 62 L45 30" />
              <path d="M60 62 L75 30" />
            </g>
            <path d="M34 74 L86 74 L80 103 Q60 108 40 103 Z" fill={url('clay')} {...OUTLINE} />
            <rect x="30" y="64" width="60" height="13" rx="5" fill={url('clayLite')} {...OUTLINE} />
            <rect x="40" y="80" width="5" height="18" rx="2.5" fill="#fff" opacity="0.28" />
          </>
        )}
      </g>
    </svg>
  );
}

const SHADOW: Record<StickerKind, string> = {
  sneaker: '#ff4b2e',
  earbuds: '#2e5cff',
  lipoil: '#ff2e93',
  armchair: '#f59e0b',
  mug: '#c9603a',
  plant: '#3f9a2a',
};

/**
 * The pastel scene behind each sticker. Kept next to the stickers so a
 * category, a product card and the phone's video card all agree on the hue
 * that belongs to an object.
 */
export const SCENE: Record<StickerKind, { from: string; to: string; glow: string }> = {
  sneaker:  { from: '#ffe4d9', to: '#ffc7b3', glow: 'rgba(255,75,46,0.28)' },
  earbuds:  { from: '#e1e9ff', to: '#c6d4ff', glow: 'rgba(46,92,255,0.26)' },
  lipoil:   { from: '#ffdcec', to: '#ffbfd9', glow: 'rgba(255,46,147,0.26)' },
  armchair: { from: '#fff0cf', to: '#ffdca6', glow: 'rgba(245,158,11,0.3)' },
  mug:      { from: '#ffe6d9', to: '#f7c9b3', glow: 'rgba(201,96,58,0.28)' },
  plant:    { from: '#e8f7d6', to: '#cdecb0', glow: 'rgba(63,154,42,0.26)' },
};

/* ────────────────────────────────────────────────────────────────────────────
   UI glyphs — one consistent 24px stroke set for app chrome (nav, phone
   mockup, cards). Rounded caps/joins, 1.8 stroke; filled variants for the
   "active"/"saved" states.
   ──────────────────────────────────────────────────────────────────────── */

type GlyphProps = { size?: number; className?: string; strokeWidth?: number; filled?: boolean };

const base = (size: number, className: string, sw: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: sw,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className,
  'aria-hidden': true,
});

export const Glyph = {
  Search: ({ size = 20, className = '', strokeWidth = 1.9 }: GlyphProps) => (
    <svg {...base(size, className, strokeWidth)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.2 4.2" />
    </svg>
  ),
  Heart: ({ size = 20, className = '', strokeWidth = 1.9, filled = false }: GlyphProps) => (
    <svg {...base(size, className, strokeWidth)} fill={filled ? 'currentColor' : 'none'}>
      <path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z" />
    </svg>
  ),
  Comment: ({ size = 20, className = '', strokeWidth = 1.9 }: GlyphProps) => (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z" />
    </svg>
  ),
  Bookmark: ({ size = 20, className = '', strokeWidth = 1.9, filled = false }: GlyphProps) => (
    <svg {...base(size, className, strokeWidth)} fill={filled ? 'currentColor' : 'none'}>
      <path d="M6.5 4.5h11v16l-5.5-3.6L6.5 20.5z" />
    </svg>
  ),
  Share: ({ size = 20, className = '', strokeWidth = 1.9 }: GlyphProps) => (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M14 5.5l6 5.5-6 5.5V13c-4.5 0-8 1.5-10.5 5 1-5.5 4-9.5 10.5-10.3z" />
    </svg>
  ),
  Home: ({ size = 20, className = '', strokeWidth = 1.9, filled = false }: GlyphProps) => (
    <svg {...base(size, className, strokeWidth)} fill={filled ? 'currentColor' : 'none'}>
      <path d="M4 10.5L12 4l8 6.5V20h-5.5v-5h-5v5H4z" />
    </svg>
  ),
  Cart: ({ size = 20, className = '', strokeWidth = 1.9 }: GlyphProps) => (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M3 4h2.2l1.8 11h11l1.8-7.5H7.1" />
      <circle cx="9" cy="19.5" r="1.4" />
      <circle cx="17" cy="19.5" r="1.4" />
    </svg>
  ),
  User: ({ size = 20, className = '', strokeWidth = 1.9 }: GlyphProps) => (
    <svg {...base(size, className, strokeWidth)}>
      <circle cx="12" cy="8.5" r="4" />
      <path d="M4.5 20.5c1.2-4 4-6 7.5-6s6.3 2 7.5 6" />
    </svg>
  ),
  Bell: ({ size = 20, className = '', strokeWidth = 1.9 }: GlyphProps) => (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
  ),
  Bag: ({ size = 20, className = '', strokeWidth = 1.9 }: GlyphProps) => (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M5.5 8.5h13l-.9 11.5H6.4z" />
      <path d="M9 8.5V7a3 3 0 0 1 6 0v1.5" />
    </svg>
  ),
  Play: ({ size = 20, className = '', strokeWidth = 1.9, filled = true }: GlyphProps) => (
    <svg {...base(size, className, strokeWidth)} fill={filled ? 'currentColor' : 'none'}>
      <path d="M8 5.5v13l10-6.5z" />
    </svg>
  ),
  Star: ({ size = 16, className = '' }: GlyphProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
      <path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.5 1.2 6.4L12 17.3l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z" />
    </svg>
  ),
  Truck: ({ size = 16, className = '', strokeWidth = 1.9 }: GlyphProps) => (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M3 6.5h11v9H3zM14 10h4l3 3v2.5h-7z" />
      <circle cx="7" cy="17.5" r="1.7" />
      <circle cx="17" cy="17.5" r="1.7" />
    </svg>
  ),
  Check: ({ size = 16, className = '', strokeWidth = 2.4 }: GlyphProps) => (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ),
  Arrow: ({ size = 18, className = '', strokeWidth = 2 }: GlyphProps) => (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" />
    </svg>
  ),
  Bolt: ({ size = 16, className = '' }: GlyphProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
      <path d="M13.5 2.5L5 13.5h6l-1 8 8.5-11h-6z" />
    </svg>
  ),
  Plus: ({ size = 16, className = '', strokeWidth = 2.2 }: GlyphProps) => (
    <svg {...base(size, className, strokeWidth)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  Apple: ({ size = 18, className = '' }: GlyphProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
      <path d="M16.4 12.7c0-2.4 2-3.5 2-3.6-1.1-1.6-2.8-1.8-3.4-1.9-1.4-.1-2.8.9-3.5.9-.7 0-1.9-.8-3.1-.8-1.6 0-3.1.9-3.9 2.4-1.7 2.9-.4 7.2 1.2 9.5.8 1.2 1.7 2.4 3 2.4 1.2 0 1.7-.8 3.1-.8 1.5 0 1.9.8 3.1.8 1.3 0 2.1-1.2 2.9-2.4.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.7-1-2.7-3.8zM14.1 5.7c.6-.8 1.1-1.9.9-3-.9.1-2 .6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1.1.1 2.1-.5 2.8-1.3z" />
    </svg>
  ),
  Android: ({ size = 18, className = '' }: GlyphProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
      <path d="M6 9.5h12v7.5a1.5 1.5 0 0 1-1.5 1.5H16v3h-2v-3h-4v3H8v-3h-.5A1.5 1.5 0 0 1 6 17zM6.4 8.5a5.7 5.7 0 0 1 11.2 0zM9.3 4.6l-1-1.6.6-.4 1 1.6a6.4 6.4 0 0 1 4.2 0l1-1.6.6.4-1 1.6zM4 10h1.5v6H4zm14.5 0H20v6h-1.5z" />
      <circle cx="9.5" cy="6.5" r=".6" fill="#fff9f2" />
      <circle cx="14.5" cy="6.5" r=".6" fill="#fff9f2" />
    </svg>
  ),
};

/** iOS-style status glyphs for the phone mockup. */
export function StatusGlyphs({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} aria-hidden>
      <svg width="16" height="11" viewBox="0 0 16 11" fill="currentColor">
        <rect x="0" y="7" width="3" height="4" rx="0.8" />
        <rect x="4.3" y="5" width="3" height="6" rx="0.8" />
        <rect x="8.6" y="2.5" width="3" height="8.5" rx="0.8" />
        <rect x="12.9" y="0" width="3" height="11" rx="0.8" />
      </svg>
      <svg width="15" height="11" viewBox="0 0 15 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M1.5 4a9 9 0 0 1 12 0M4 6.6a5.5 5.5 0 0 1 7 0M6.4 9.2a2 2 0 0 1 2.2 0" />
      </svg>
      <svg width="24" height="11" viewBox="0 0 24 11" fill="none">
        <rect x="0.7" y="0.7" width="19" height="9.6" rx="2.6" stroke="currentColor" strokeOpacity="0.45" />
        <rect x="2.2" y="2.2" width="14.5" height="6.6" rx="1.4" fill="currentColor" />
        <path d="M21.5 3.5v4a2 2 0 0 0 0-4z" fill="currentColor" fillOpacity="0.45" />
      </svg>
    </span>
  );
}

/** Hand-drawn annotation arrow (hero). */
export function HandArrow({ className = '', direction = 'down' }: { className?: string; direction?: 'down' | 'left' }) {
  if (direction === 'left') {
    // starts under the note (top-right), swoops down-left, head lands on the target
    return (
      <svg viewBox="0 0 150 70" width="150" height="70" className={className} fill="none" aria-hidden>
        <path d="M142 10 C122 2 92 6 64 20 C48 28 30 36 14 40" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M27 43 L13 40 L18 28" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 120 80" width="120" height="80" className={className} fill="none" aria-hidden>
      <path d="M6 12 C30 8 70 6 92 30 C104 44 106 58 100 70" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M90 62 L100 72 L110 60" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
