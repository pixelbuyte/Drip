'use client';

import { useState } from 'react';
import { PRODUCTS, type Category } from './products';
import ProductCard from './product-card';

const FILTERS: { label: string; value: Category | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Sneakers', value: 'sneakers' },
  { label: 'Beauty', value: 'beauty' },
  { label: 'Tech', value: 'tech' },
  { label: 'Home', value: 'home' },
  { label: 'Fitness', value: 'fitness' },
  { label: 'Gaming', value: 'gaming' },
];

export default function FeedPreview() {
  const [filter, setFilter] = useState<Category | 'all'>('all');
  const items = (filter === 'all' ? PRODUCTS.slice(0, 8) : PRODUCTS.filter((p) => p.category === filter));

  return (
    <div>
      <div className="rail md:flex-wrap md:overflow-visible" role="tablist" aria-label="Filter the feed">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={`whitespace-nowrap rounded-full px-4 py-2 text-[13px] font-bold transition-colors duration-150 ${
              filter === f.value
                ? 'bg-ink text-cream'
                : 'border border-hairline-strong bg-card text-ink hover:border-coral/30 hover:text-coral-deep'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        {items.map((p, i) => (
          <div key={p.id} data-enter="rise" style={{ '--i': i % 4 } as React.CSSProperties}>
            <ProductCard product={p} showShop />
          </div>
        ))}
      </div>
    </div>
  );
}
