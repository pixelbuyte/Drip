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

/**
 * Mux's own public demo assets, not Drip content.
 *
 * These exist so /feed/demo actually plays. Until now every fixture carried
 * `playbackId: null`, which made feed-video render `src={undefined}` — so the
 * demo route showed the placeholder path and nothing ever moved. That is fine
 * for exercising layout and useless for judging the experience, and it read
 * from the outside as "video is broken" when in fact no video had ever been
 * attached.
 *
 * Using real playback ids rather than a full-URL escape hatch is deliberate:
 * feed-video builds `https://stream.mux.com/{id}/low.mp4` itself, so the demo
 * exercises the genuine Mux code path — the same URL construction, the same
 * poster handling, the same preload ladder — instead of bypassing it. A demo
 * that takes a different path than production proves less than it appears to.
 *
 * Each was verified to return 200 video/mp4 before being committed. Three
 * clips cycling across six slides is enough to see playback hand off between
 * slides, which one clip repeated would hide.
 *
 * Replace these the moment real seller uploads exist.
 */
const DEMO_PLAYBACK_IDS = [
  'DS00Spx1CV902MCtPj5WknGlR102V5HFkDe',
  'VZtzUzGRv02OhRnZCxcNg49OilvolTqdnFLEqBsTwaxU',
  'a4nOgmxGWg6gULfcBbAa00gXyfcwPnAFldF8RdsNyk8M',
];

/** Mux renders posters straight from the asset; smartcrop keeps the 9:16 frame sane. */
const posterFor = (id: string, atSecond: number) =>
  `https://image.mux.com/${id}/thumbnail.webp?width=390&height=694&fit_mode=smartcrop&time=${atSecond}`;

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
  playbackId: DEMO_PLAYBACK_IDS[i % DEMO_PLAYBACK_IDS.length],
  durationSeconds: 12 + i,
  aspectRatio: '9:16',
  // Offset per slide so two slides sharing a clip do not show an identical
  // poster — otherwise the feed looks like it failed to advance.
  thumbnailUrl: posterFor(DEMO_PLAYBACK_IDS[i % DEMO_PLAYBACK_IDS.length], 1 + i),
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
