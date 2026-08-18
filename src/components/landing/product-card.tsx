import { SCENES, type Product } from './products';
import SaveButton from './save-button';

export function ProductArt({
  product,
  glyphScale = 1,
  className = '',
}: {
  product: Product;
  glyphScale?: number;
  className?: string;
}) {
  const scene = SCENES[product.category];
  return (
    <div
      className={`art rounded-art ${className}`}
      style={{ background: `linear-gradient(135deg, ${scene.from}, ${scene.to})`, containerType: 'inline-size' }}
      role="img"
      aria-label={product.name}
    >
      <span
        className="absolute left-1/2 top-[55%] select-none"
        style={{
          fontSize: `${52 * glyphScale}cqw`,
          transform: `translate(-50%, -50%) rotate(${product.tilt}deg)`,
          filter: `drop-shadow(0 16px 18px ${scene.shadow})`,
          lineHeight: 1,
        }}
        aria-hidden
      >
        {product.glyph}
      </span>
    </div>
  );
}

function Badge({ product }: { product: Product }) {
  // One badge per card, maximum. Priority: price drop > restock > new.
  if (product.wasPrice)
    return (
      <span className="absolute left-2.5 top-2.5 rounded-full bg-coral/10 px-2.5 py-1 text-[12px] font-bold text-coral-deep backdrop-blur-sm" style={{ background: 'rgba(255,255,255,0.85)' }}>
        ↓ ${product.wasPrice - product.price} off
      </span>
    );
  if (product.badge === 'restock')
    return (
      <span className="absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 text-[12px] font-semibold text-ink">
        <span className="anim-dot h-1.5 w-1.5 rounded-full bg-cobalt" /> Back in stock
      </span>
    );
  if (product.badge === 'new')
    return (
      <span className="absolute left-2.5 top-2.5 rounded-full bg-lime px-2.5 py-1 text-[12px] font-bold text-ink">
        NEW
      </span>
    );
  return null;
}

export default function ProductCard({
  product,
  rank,
  showShop = false,
}: {
  product: Product;
  rank?: number;
  showShop?: boolean;
}) {
  return (
    <div
      className="group rounded-card bg-card p-1.5 shadow-card transition-[transform,box-shadow] duration-300 ease-out hover:-translate-y-1 hover:shadow-card-hover">
      <div className="relative">
        <ProductArt product={product} className="aspect-[4/5] w-full overflow-hidden" />
        {rank ? (
          <span className="absolute left-2.5 top-2.5 rounded-full bg-white/90 px-2.5 py-1 text-[12px] font-extrabold text-ink">
            #{rank}
          </span>
        ) : (
          <Badge product={product} />
        )}
        <div className="absolute right-2.5 top-2.5">
          <SaveButton label={product.name} />
        </div>
        {showShop && (
          <span className="absolute bottom-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-ink px-4 py-1.5 text-[13px] font-bold text-cream opacity-100 transition-all duration-200 md:translate-y-2 md:opacity-0 md:group-hover:translate-y-0 md:group-hover:opacity-100">
            Shop now
          </span>
        )}
      </div>

      <div className="p-2.5 pt-3">
        {product.sponsored ? (
          <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted">
            Sponsored · Suncourt
          </div>
        ) : product.creator ? (
          <div className="text-[12px] font-medium text-violet">{product.creator}</div>
        ) : null}
        <div className="mt-0.5 truncate text-[14px] font-medium text-ink">{product.name}</div>
        <div className="mt-1 flex items-baseline gap-2">
          <span data-num className="text-[17px] font-extrabold text-ink">
            ${product.price}
          </span>
          {product.wasPrice && (
            <span data-num className="text-[13px] text-muted line-through decoration-[1.5px]">
              ${product.wasPrice}
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-1 text-[12px]">
          <span className="text-amber" aria-hidden>★</span>
          <span className="font-semibold text-ink">{product.rating}</span>
          <span className="text-muted">({product.reviews})</span>
        </div>
      </div>
    </div>
  );
}
