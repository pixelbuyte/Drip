import { byId } from './products';
import ProductCard from './product-card';

// Masonry as explicit columns for control of the stagger and the ragged
// bottom; the fade at the section edge says "this keeps going".

function ReasonChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-2 inline-block rounded-full bg-violet/10 px-3 py-1 text-[12px] font-semibold text-violet">
      {children}
    </span>
  );
}

export default function ForYou() {
  return (
    <div className="relative">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
        <div className="flex flex-col gap-3 md:gap-4">
          <div data-enter="rise">
            <ProductCard product={byId('crescent')} />
          </div>
          <div data-enter="rise" style={{ '--i': 1 } as React.CSSProperties}>
            <ProductCard product={byId('fleet')} />
          </div>
        </div>

        <div className="flex flex-col gap-3 md:mt-12 md:gap-4">
          <div data-enter="rise" className="rounded-card bg-card p-6 shadow-card">
            <p className="font-display text-[22px] font-bold leading-snug tracking-[-0.01em] text-ink">
              “Okay, the feed found my whole fall fit.”
            </p>
            <p className="mt-3 text-[13px] font-semibold text-violet">@maya.finds</p>
          </div>
          <div data-enter="rise" style={{ '--i': 1 } as React.CSSProperties}>
            <ProductCard product={byId('halo')} />
          </div>
        </div>

        <div className="hidden flex-col gap-4 md:flex">
          <div data-enter="rise">
            <ReasonChip>Because you saved Suncourt Ace Low</ReasonChip>
            <ProductCard product={byId('pebble')} />
          </div>
          <div data-enter="rise" style={{ '--i': 1 } as React.CSSProperties}>
            <ProductCard product={byId('kindling')} />
          </div>
        </div>
      </div>

      {/* ragged bottom → infinite */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-cream to-transparent" />
    </div>
  );
}
