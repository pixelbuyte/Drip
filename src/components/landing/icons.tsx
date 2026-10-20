/* ────────────────────────────────────────────────────────────────────────────
   UI glyphs — one consistent 24px stroke set for the landing chrome (nav,
   chips, cards, CTAs). Rounded caps/joins, 1.9 stroke; filled variants for
   the "active"/"saved" states.

   The page's product and category art is no longer drawn here: every object
   is now one of the founder's rendered cutouts in public/landing/, served
   through next/image. The hand-authored SVG sticker set that used to live in
   this file (Sticker / SCENE / StickerKind), the phone-mockup status glyphs
   and the hand-drawn hero arrow all went with it.
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
