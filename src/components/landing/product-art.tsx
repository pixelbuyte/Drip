import Image from 'next/image';
import type { Art } from './products';

/**
 * One product object on its scene tile — shared by the drops grid and the
 * creators' pick strips so a product looks the same wherever it appears.
 *
 * Every render is a transparent cutout that floats over an ambient pool of
 * its own colour. The object is never allowed past `art.render` (≤1.3× its
 * intrinsic width), so it stays sharp on a big card; below that ceiling the
 * padded box scales it down with the tile.
 *
 * `sizes` defaults to that ceiling because that is the widest the image can
 * ever be laid out — but a caller that lays it out much smaller (the creators'
 * pick strips put it in a ~68px box) must pass its own, or the browser picks a
 * candidate several times bigger than the box it lands in.
 */
export default function ProductArt({
  art,
  alt = '',
  className = '',
  inset = '',
  sizes,
  align = 'center',
}: {
  art: Art;
  alt?: string;
  className?: string;
  /** padding utilities that decide how much air the object gets */
  inset?: string;
  /** real laid-out width of the image at each breakpoint */
  sizes?: string;
  /** `end` stands the object on the floor of its padded box */
  align?: 'center' | 'end';
}) {
  const maxW = art.render;
  const maxH = Math.round((art.render * art.h) / art.w);

  return (
    <div className={`relative overflow-hidden ${className}`} style={{ background: art.tile }}>
      {/* softbox — one light source, top-left, on every tile */}
      <span
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(70% 56% at 26% 18%, rgba(255,255,255,0.5), transparent 64%)' }}
      />
      <span
        className="pointer-events-none absolute inset-x-[18%] bottom-[6%] h-[14%] rounded-full opacity-80 blur-xl"
        style={{ background: art.glow }}
      />

      <div
        className={`absolute inset-0 flex justify-center ${
          align === 'end' ? 'items-end' : 'items-center'
        } ${inset || 'px-[15%] py-[13%]'}`}
      >
        <Image
          src={art.src}
          alt={alt}
          aria-hidden={alt ? undefined : true}
          width={art.w}
          height={art.h}
          sizes={sizes ?? `${maxW}px`}
          className="object-contain transition-transform duration-[420ms] ease-out will-change-transform group-hover:scale-[1.05]"
          style={{
            // grow to the sharpness ceiling, then shrink with the tile —
            // width drives, max-height catches the tall renders. Because
            // width is specified, a clamped max-height would squash the
            // element, so object-contain keeps the render's own ratio.
            width: `min(100%, ${maxW}px)`,
            height: 'auto',
            maxHeight: `min(100%, ${maxH}px)`,
          }}
        />
      </div>
    </div>
  );
}
