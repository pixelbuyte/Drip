import type { StickerKind } from './icons';

// The demo catalog behind the landing page. Every product, creator and
// number here is fictional and appears only inside depicted app UI — never
// as a claim about the platform. Prices are chosen to feel real.

export type Product = {
  id: string;
  name: string;
  price: number; // dollars
  oldPrice?: number;
  rating: number;
  reviews: string; // display string
  sticker: StickerKind;
  tilt: number;
  creator: string; // "@handle"
  shipping: string;
  /** share of the drop already claimed, 0-100 */
  claimed: number;
  left?: number;
  badge?: 'new' | 'restock';
};

export const PRODUCTS: Product[] = [
  { id: 'ace',      name: 'Suncourt Ace Low — Cream/Coral',  price: 118, oldPrice: 148, rating: 4.9, reviews: '3.4k', sticker: 'sneaker',  tilt: -8, creator: '@maya.finds',  shipping: 'Free 2-day shipping', claimed: 83, left: 12 },
  { id: 'pebble',   name: 'Pebble Buds Mini — Matte Clay',   price: 59,  oldPrice: 79,  rating: 4.8, reviews: '4.1k', sticker: 'earbuds',  tilt: -6, creator: '@theo.builds', shipping: 'Free shipping',       claimed: 91, left: 6 },
  { id: 'glaze',    name: 'Glaze Lip Oil — Guava',           price: 22,  oldPrice: 28,  rating: 4.8, reviews: '5.2k', sticker: 'lipoil',   tilt: 7,  creator: '@maya.finds',  shipping: 'Ships tomorrow',      claimed: 64, badge: 'new' },
  { id: 'halo',     name: 'Halo Lounge Chair — Mustard',     price: 249, oldPrice: 320, rating: 4.7, reviews: '740',  sticker: 'armchair', tilt: 4,  creator: '@sundaysoph',  shipping: 'Free delivery',       claimed: 72, left: 9 },
  { id: 'kindling', name: 'Kindling Ceramic Mug — Set of 2', price: 38,  oldPrice: 48,  rating: 4.9, reviews: '1.2k', sticker: 'mug',      tilt: -5, creator: '@sundaysoph',  shipping: 'Free 2-day shipping', claimed: 88, left: 4 },
  { id: 'monstera', name: 'Little Monstera — 6" Terracotta', price: 34,  oldPrice: 42,  rating: 4.8, reviews: '2.3k', sticker: 'plant',    tilt: 5,  creator: '@rootedrae',   shipping: 'Ships in 2 days',     claimed: 57, badge: 'new' },
];

export const byId = (id: string) => PRODUCTS.find((p) => p.id === id)!;

export type CategoryCard = {
  name: string;
  sticker: StickerKind;
  drops: string;
  tilt: number;
  isNew?: boolean;
};

export const CATEGORIES: CategoryCard[] = [
  { name: 'Electronics', sticker: 'earbuds',  drops: '1,240 drops', tilt: -6 },
  { name: 'Fashion',     sticker: 'sneaker',  drops: '2,860 drops', tilt: -8 },
  { name: 'Beauty',      sticker: 'lipoil',   drops: '1,930 drops', tilt: 7 },
  { name: 'Home',        sticker: 'armchair', drops: '980 drops',   tilt: 4 },
  { name: 'Kitchen',     sticker: 'mug',      drops: '640 drops',   tilt: -5, isNew: true },
  { name: 'Plants',      sticker: 'plant',    drops: '410 drops',   tilt: 5,  isNew: true },
];

export type Creator = {
  handle: string;
  name: string;
  initials: string;
  niche: string;
  tags: string[];
  blurb: string;
  followers: string;
  drops: string;
  cta: string;
  /** avatar duotone + accent */
  from: string;
  to: string;
  accent: 'violet' | 'pink' | 'cobalt' | 'coral';
  picks: string[];
};

export const CREATORS: Creator[] = [
  {
    handle: '@maya.finds',
    name: 'Maya Okafor',
    initials: 'MO',
    niche: 'Fashion · Under $60',
    tags: ['Sneakers', 'Everyday fits'],
    blurb: 'Five finds a week, all under sixty. If it’s on her feed, it’s already in her cart.',
    followers: '128k',
    drops: '342',
    cta: 'Shop her feed',
    from: '#ff8f74',
    to: '#ff2e93',
    accent: 'pink',
    picks: ['ace', 'glaze', 'pebble'],
  },
  {
    handle: '@theo.builds',
    name: 'Theo Lindqvist',
    initials: 'TL',
    niche: 'Tech · Desk setups',
    tags: ['Audio', 'Workspace'],
    blurb: 'Buys it, lives with it for 30 days, then tells you whether it earned the counter space.',
    followers: '96k',
    drops: '210',
    cta: 'Shop his feed',
    from: '#6f92ff',
    to: '#6d4aff',
    accent: 'violet',
    picks: ['pebble', 'halo', 'kindling'],
  },
  {
    handle: '@sundaysoph',
    name: 'Sophie Marchetti',
    initials: 'SM',
    niche: 'Home · Slow living',
    tags: ['Kitchen', 'Cozy corners'],
    blurb: 'Warm homes, zero clutter. Every drop passes a real Sunday before it passes to you.',
    followers: '204k',
    drops: '518',
    cta: 'Shop her feed',
    from: '#ffd67a',
    to: '#f0930a',
    accent: 'coral',
    picks: ['kindling', 'halo', 'monstera'],
  },
  {
    handle: '@rootedrae',
    name: 'Rae Nakamura',
    initials: 'RN',
    niche: 'Plants · Small spaces',
    tags: ['Low light', 'Beginner-proof'],
    blurb: 'Grows it on a north-facing sill first. If it survives Rae’s apartment, it survives yours.',
    followers: '71k',
    drops: '156',
    cta: 'Shop their feed',
    from: '#b5e86a',
    to: '#2e5cff',
    accent: 'cobalt',
    picks: ['monstera', 'kindling', 'glaze'],
  },
];
