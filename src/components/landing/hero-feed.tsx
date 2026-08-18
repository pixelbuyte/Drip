import { byId, SCENES, type Product } from './products';
import SaveButton from './save-button';

// The hero's proof: three drifting columns of product cards, depth carried by
// scale + shadow grading (never blur), plus floating app-UI notification
// cards. All ambient motion is keyframes, disabled under reduced motion with
// composed static offsets so the frozen frame is art-directed, not accidental.

function HeroCard({ product, front = false, shadowVar }: { product: Product; front?: boolean; shadowVar: string }) {
  const scene = SCENES[product.category];
  return (
    <li className="w-full rounded-card bg-card p-1.5" style={{ boxShadow: `var(${shadowVar})` }}>
      <div
        className="art relative aspect-[4/5] w-full overflow-hidden rounded-art"
        style={{ background: `linear-gradient(135deg, ${scene.from}, ${scene.to})`, containerType: 'inline-size' }}
      >
        <span
          className="absolute left-1/2 top-[55%] select-none"
          style={{
            fontSize: '50cqw',
            transform: `translate(-50%,-50%) rotate(${product.tilt}deg)`,
            filter: `drop-shadow(0 12px 14px ${scene.shadow})`,
            lineHeight: 1,
          }}
          aria-hidden
        >
          {product.glyph}
        </span>
        {product.wasPrice && (
          <span className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-bold text-coral-deep">
            ↓ ${product.wasPrice - product.price} off
          </span>
        )}
        {product.badge === 'new' && (
          <span className="absolute left-2 top-2 rounded-full bg-lime px-2 py-0.5 text-[11px] font-bold text-ink">NEW</span>
        )}
        {front && (
          <div className="absolute right-2 top-2 scale-90">
            <SaveButton label={product.name} />
          </div>
        )}
      </div>
      <div className="p-2 pt-2.5">
        <div className="truncate text-[12px] font-medium text-ink">{product.name}</div>
        <div className="mt-0.5 flex items-center justify-between">
          <span data-num className="text-[14px] font-extrabold text-ink">${product.price}</span>
          <span className="text-[11px]">
            <span className="text-amber" aria-hidden>★</span>{' '}
            <span className="font-semibold text-ink">{product.rating}</span>
          </span>
        </div>
      </div>
    </li>
  );
}

function Column({
  ids,
  className = '',
  style,
  listClass,
  listStyle,
  front = false,
  shadowVar,
}: {
  ids: string[];
  className?: string;
  style?: React.CSSProperties;
  listClass: string;
  listStyle?: React.CSSProperties;
  front?: boolean;
  shadowVar: string;
}) {
  const products = ids.map(byId);
  return (
    <div className={`absolute -bottom-10 -top-10 ${className}`} style={style} aria-hidden={!front}>
      <ul className={`flex flex-col gap-4 ${listClass}`} style={listStyle}>
        {[...products, ...products].map((p, i) => (
          <HeroCard key={`${p.id}-${i}`} product={p} front={front} shadowVar={shadowVar} />
        ))}
      </ul>
    </div>
  );
}

function FloatCard({
  children,
  className = '',
  tilt,
  dur,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  tilt: number;
  dur: number;
  delay?: number;
}) {
  return (
    <div
      className={`anim-float absolute z-40 flex items-center gap-2 rounded-full bg-card px-3.5 py-2 shadow-float ${className}`}
      style={{ '--tilt': `${tilt}deg`, '--float-dur': `${dur}s`, animationDelay: `${delay}s`, transform: `rotate(${tilt}deg)` } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

export default function HeroFeed() {
  return (
    <div
      className="relative mx-auto h-[440px] w-full max-w-[540px] md:h-[640px]"
      style={{
        maskImage: 'linear-gradient(to bottom, transparent, black 8%, black 92%, transparent)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 8%, black 92%, transparent)',
      }}
    >
      {/* back column — desktop only */}
      <Column
        ids={['halo', 'crescent', 'candle', 'loop']}
        className="hidden w-[200px] md:block"
        style={{ left: 0, transform: 'rotate(-5deg) scale(0.9)', opacity: 0.8, zIndex: 10 }}
        listClass="anim-drift-rev"
        listStyle={{ '--drift-dur': '62s', '--drift-from': '-48px' } as React.CSSProperties}
        shadowVar="--shadow-back"
      />
      {/* middle column */}
      <Column
        ids={['glaze', 'gripwell', 'pixelpad', 'dewpoint']}
        className="left-[4%] w-[46%] md:left-[170px] md:w-[200px]"
        style={{ transform: 'rotate(-4deg) scale(0.95)', zIndex: 20 }}
        listClass="anim-drift"
        listStyle={{ '--drift-dur': '48s', '--drift-from': '-140px' } as React.CSSProperties}
        shadowVar="--shadow-mid"
      />
      {/* front column */}
      <Column
        ids={['ace', 'pebble', 'crescent', 'fleet']}
        className="left-[52%] w-[46%] md:left-[340px] md:w-[200px]"
        style={{ transform: 'rotate(4deg)', zIndex: 30 }}
        listClass="anim-drift"
        listStyle={{ '--drift-dur': '40s', '--drift-from': '-84px' } as React.CSSProperties}
        front
        shadowVar="--shadow-card"
      />

      {/* floating app-UI notifications (depicted interface, not page claims) */}
      <FloatCard className="right-2 top-[14%] md:-right-3" tilt={6} dur={6}>
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
          <path
            d="M12 21C12 21 4 15.5 4 9.8C4 6.6 6.4 4.5 9 4.5C10.3 4.5 11.4 5.1 12 6C12.6 5.1 13.7 4.5 15 4.5C17.6 4.5 20 6.6 20 9.8C20 15.5 12 21 12 21Z"
            fill="var(--color-pink)"
          />
        </svg>
        <span className="whitespace-nowrap text-[13px] font-semibold text-ink">Saved to your list</span>
      </FloatCard>

      <FloatCard className="bottom-[20%] left-2 md:-left-4" tilt={-4} dur={7} delay={0.8}>
        <span className="text-[13px] font-bold text-sale" aria-hidden>↓</span>
        <span data-num className="whitespace-nowrap text-[13px] font-semibold text-ink">
          Price drop · <s className="text-muted">$79</s> <b className="text-sale">$59</b>
        </span>
      </FloatCard>

      <FloatCard className="right-[2%] top-[52%] hidden md:flex" tilt={3} dur={6.5} delay={0.4}>
        <span className="grid h-6 w-6 place-items-center rounded-full bg-violet/10 text-[10px] font-bold text-violet ring-[1.5px] ring-violet">
          MF
        </span>
        <span className="whitespace-nowrap text-[13px] font-semibold text-ink">
          @maya.finds · curated 3 finds
        </span>
      </FloatCard>

      <FloatCard className="left-2 top-[36%] hidden md:flex md:-left-2" tilt={-3} dur={7.5} delay={1.2}>
        <span className="anim-dot h-1.5 w-1.5 rounded-full bg-cobalt" />
        <span className="whitespace-nowrap text-[13px] font-semibold text-ink">
          Crescent Crossbody is back
        </span>
      </FloatCard>
    </div>
  );
}
