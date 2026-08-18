import type { FeedItem } from '@/lib/feed/types';

/**
 * Spec step 2 builds the shell "with a hardcoded video list", before the feed
 * endpoint exists. This is that list — it also stays useful as the surface for
 * exercising scroll, playback handoff and event emission without a database.
 */
const SELLERS = [
  { handle: 'maya.finds', name: 'Maya' },
  { handle: 'theo.builds', name: 'Theo' },
  { handle: 'sundaysoph', name: 'Sofia' },
  { handle: 'rune.vintage', name: 'Rune' },
  { handle: 'atlas.gear', name: 'Atlas' },
  { handle: 'juno.ceramics', name: 'Juno' },
];

const PRODUCTS = [
  { title: 'Suncourt Ace Low — Cream/Coral', price: 11800, was: null, stock: 12 },
  { title: 'Glaze Lip Oil — Guava', price: 2200, was: null, stock: 40 },
  { title: 'Pebble Buds Mini — Matte Clay', price: 5900, was: 7900, stock: 3 },
  { title: 'Crescent Crossbody — Butter', price: 7200, was: null, stock: 2 },
  { title: 'Halo Desk Lamp — Tangerine', price: 5400, was: null, stock: 25 },
  { title: 'Gripwell Studio Mat — Sage', price: 4800, was: null, stock: 9 },
];

const CAPTIONS = [
  'restocked the cream colorway, last run sold out in a day',
  'two coats, no stickiness, lasts through lunch',
  'these actually stay in when you run',
  'the butter one is back in stock',
  'warm light for the desk, dimmable',
  'grippy even when things get sweaty',
];

export const DEMO_ITEMS: FeedItem[] = SELLERS.map((s, i) => ({
  videoId: `00000000-0000-4000-8000-00000000000${i}`,
  playbackId: null, // no real Mux asset: the poster/placeholder path renders
  durationSeconds: 12 + i,
  aspectRatio: '9:16',
  thumbnailUrl: null,
  caption: CAPTIONS[i],
  hashtags: ['drip', 'find'],
  categorySlug: ['footwear', 'beauty', 'tech-gadgets', 'jewelry-accessories', 'home-decor', 'fitness'][i],
  seller: { id: `seller-${i}`, handle: s.handle, displayName: s.name, avatarUrl: null },
  products: [
    {
      id: `product-${i}`,
      title: PRODUCTS[i].title,
      priceCents: PRODUCTS[i].price,
      compareAtPriceCents: PRODUCTS[i].was,
      inventoryCount: PRODUCTS[i].stock,
      lowStockThreshold: 5,
      images: [],
      variants: [],
      position: 0,
      pinnedAtSecond: null,
    },
  ],
  lane: 'chrono',
  position: i,
}));
