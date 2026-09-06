// The demo catalog behind the landing page. Every product, creator and
// number here is fictional and appears only inside depicted app UI — never
// as a claim about the platform. Prices are chosen to feel real.
//
// Imagery is the founder's asset set in public/landing/. The six trending
// products all draw from the same family of small transparent renders
// (`cat-*.webp`), so every card is a real cutout floating on its own pastel
// scene tile — no screen crops, no picture-in-a-picture. Every render is
// displayed at or below 1.3× its intrinsic pixel size, which is the whole
// reason each entry carries its own `render` width.

export type Art = {
  src: string;
  /** intrinsic pixels — next/image needs the real numbers to reserve space */
  w: number;
  h: number;
  /** rendered width at the largest breakpoint, ≤1.3× `w` so it stays sharp */
  render: number;
  /** flat scene-tile colour behind the object */
  tile: string;
  /** ambient glow pooled under the object inside the tile */
  glow: string;
};

export type Product = {
  id: string;
  name: string;
  price: number; // dollars
  oldPrice?: number;
  rating: number;
  reviews: string; // display string
  creator: string; // "@handle"
  shipping: string;
  /** share of the drop already claimed, 0-100 */
  claimed: number;
  left?: number;
  badge?: 'new' | 'restock';
  art: Art;
};

export const PRODUCTS: Product[] = [
  {
    id: 'aurora',
    name: 'Aurora Studio Over-Ear — Onyx',
    price: 189, oldPrice: 249, rating: 4.9, reviews: '3.4k',
    creator: '@kenji.tests', shipping: 'Free 2-day shipping', claimed: 87, left: 9,
    art: { src: '/landing/cat-headphones.webp', w: 87, h: 108, render: 110, tile: '#fee4d8', glow: 'rgba(201,96,58,0.22)' },
  },
  {
    id: 'margot',
    name: 'Margot Mini Bag — Fuchsia',
    price: 128, oldPrice: 165, rating: 4.8, reviews: '1.9k',
    creator: '@lena.wears', shipping: 'Free shipping', claimed: 93, left: 5,
    art: { src: '/landing/cat-handbag.webp', w: 93, h: 114, render: 110, tile: '#fde3e6', glow: 'rgba(214,36,110,0.20)' },
  },
  {
    id: 'monstera',
    name: 'Little Monstera — 6" Stone Pot',
    price: 34, oldPrice: 42, rating: 4.8, reviews: '2.3k',
    creator: '@maya.finds', shipping: 'Ships in 2 days', claimed: 54, badge: 'new',
    art: { src: '/landing/cat-plant.webp', w: 87, h: 102, render: 113, tile: '#dff3d5', glow: 'rgba(63,154,42,0.22)' },
    // (113 is both this render's optical width and its 1.3x sharpness ceiling.)
  },
  {
    id: 'velvet',
    name: 'Velvet Matte Lip — Rosewood',
    price: 24, oldPrice: 30, rating: 4.7, reviews: '4.6k',
    creator: '@maya.finds', shipping: 'Ships tomorrow', claimed: 76, left: 18,
    // The big sticker cutout, not the 41px-wide cat-lipstick render: at the
    // row's shared optical weight that narrow one could only reach 85px and
    // read as a speck floating in its tile.
    art: { src: '/landing/sticker-lipstick.webp', w: 200, h: 218, render: 117, tile: '#fee1e4', glow: 'rgba(214,36,110,0.20)' },
  },
  {
    id: 'halo',
    name: 'Halo Lounge Chair — Camel',
    price: 249, oldPrice: 320, rating: 4.7, reviews: '740',
    creator: '@dario.athome', shipping: 'Free delivery', claimed: 68, left: 14,
    art: { src: '/landing/cat-armchair.webp', w: 111, h: 100, render: 129, tile: '#fee6d4', glow: 'rgba(201,96,58,0.22)' },
  },
  {
    id: 'weeknight',
    name: 'Weeknight Dutch Pot — 4 qt',
    price: 96, oldPrice: 130, rating: 4.9, reviews: '1.2k',
    creator: '@dario.athome', shipping: 'Free 2-day shipping', claimed: 82, left: 11,
    art: { src: '/landing/cat-pot.webp', w: 113, h: 90, render: 137, tile: '#fdedce', glow: 'rgba(191,140,20,0.22)' },
  },
];

export const byId = (id: string) => PRODUCTS.find((p) => p.id === id)!;

// ── categories ────────────────────────────────────────────────────────────
// The big sticker cutouts. Each one ships with its own baked contact shadow
// tinted to the tile colour in the manifest, so the tile stays flat and the
// object keeps its own light.

export type CategoryCard = {
  name: string;
  drops: string;
  isNew?: boolean;
  art: {
    src: string;
    w: number;
    h: number;
    tile: string;
    glow: string;
    /**
     * Share of the tile width this object takes. Not a constant: a wide, short
     * render (the pot) and a tall, narrow one (the lipstick) drawn to the same
     * WIDTH read as wildly different sizes, so each object gets the width that
     * puts its geometric mean (√w·h) on the same optical footing as the rest
     * of the row.
     */
    scale: number;
  };
};

export const CATEGORIES: CategoryCard[] = [
  { name: 'Electronics', drops: '1,240 drops', art: { src: '/landing/sticker-headphones.webp', w: 236, h: 224, tile: '#fee1d6', glow: 'rgba(255,75,46,0.24)',   scale: 0.705 } },
  { name: 'Fashion',     drops: '2,860 drops', art: { src: '/landing/sticker-sneaker.webp',    w: 302, h: 176, tile: '#ede3fe', glow: 'rgba(109,74,255,0.22)', scale: 0.90 } },
  { name: 'Beauty',      drops: '1,930 drops', art: { src: '/landing/sticker-lipstick.webp',   w: 200, h: 218, tile: '#fedae7', glow: 'rgba(255,46,147,0.22)', scale: 0.66 } },
  { name: 'Home',        drops: '980 drops',   art: { src: '/landing/sticker-armchair.webp',   w: 272, h: 218, tile: '#dff6dd', glow: 'rgba(63,154,42,0.22)',  scale: 0.77 } },
  { name: 'Kitchen',     drops: '640 drops',   isNew: true, art: { src: '/landing/sticker-pot.webp',      w: 300, h: 208, tile: '#fef0c6', glow: 'rgba(191,140,20,0.24)', scale: 0.825 } },
  { name: 'Plants',      drops: '410 drops',   isNew: true, art: { src: '/landing/sticker-monstera.webp', w: 284, h: 248, tile: '#d8f6de', glow: 'rgba(63,154,42,0.22)',  scale: 0.735 } },
];

// ── creators ──────────────────────────────────────────────────────────────

export type Creator = {
  handle: string;
  name: string;
  niche: string;
  /** the two-or-three words that say what following them gets you */
  descriptor: string;
  tags: string[];
  blurb: string;
  followers: string;
  drops: string;
  cta: string;
  avatar: string;
  /** card wash */
  tint: string;
  /** ring around the avatar + the chip wash, same hue, more saturated */
  ring: string;
  chip: string;
  picks: string[];
};

export const CREATORS: Creator[] = [
  {
    handle: '@maya.finds',
    name: 'Maya J.',
    niche: 'Beauty · Skincare',
    descriptor: 'honest reviews',
    tags: ['Skincare', 'Makeup', 'Self care'],
    blurb: 'Tests everything for a full cycle before it gets a word. If Maya reshoots it, it worked.',
    followers: '2.1M',
    drops: '512',
    cta: 'Shop her feed',
    avatar: '/landing/avatar-maya.webp',
    tint: '#feeeef',
    ring: 'rgba(255,46,147,0.28)',
    chip: 'rgba(255,46,147,0.10)',
    picks: ['velvet', 'monstera', 'margot'],
  },
  {
    handle: '@kenji.tests',
    name: 'Kenji T.',
    niche: 'Tech · Gadgets',
    // The manifest's descriptor for Kenji is "under $100", but this catalog's
    // only tech object is the $189 Aurora, so a price ceiling printed over his
    // pick strip would be a claim the picks contradict. His handle is
    // @kenji.tests, so the promise stays his and stops being a number.
    descriptor: '30-day tests',
    tags: ['Tech', 'Gadgets', 'Smart home'],
    blurb: 'Thirty days on the desk before anything gets a verdict. If it survives his commute, it survives yours.',
    followers: '890k',
    drops: '318',
    cta: 'Shop his feed',
    avatar: '/landing/avatar-kenji.webp',
    tint: '#eff8ef',
    ring: 'rgba(63,154,42,0.28)',
    chip: 'rgba(63,154,42,0.10)',
    picks: ['aurora', 'weeknight', 'monstera'],
  },
  {
    handle: '@lena.wears',
    name: 'Lena R.',
    niche: 'Fashion',
    descriptor: 'thrifted fits, new drops',
    tags: ['Outfits', 'Thrifting', 'New drops'],
    blurb: 'Half vintage rack, half brand-new drop — styled together in one take, on camera.',
    followers: '1.4M',
    drops: '604',
    cta: 'Shop her feed',
    avatar: '/landing/avatar-lena.webp',
    tint: '#f8effd',
    ring: 'rgba(109,74,255,0.26)',
    chip: 'rgba(109,74,255,0.10)',
    picks: ['margot', 'velvet', 'aurora'],
  },
  {
    handle: '@dario.athome',
    name: 'Dario M.',
    niche: 'Home & kitchen',
    descriptor: 'tiny-space finds',
    tags: ['Home', 'Kitchen', 'Small spaces'],
    blurb: 'Cooks and rearranges a 38 m² flat on camera. Everything has to earn its shelf.',
    followers: '640k',
    drops: '241',
    cta: 'Shop his feed',
    avatar: '/landing/avatar-dario.webp',
    tint: '#fdf5e2',
    ring: 'rgba(191,140,20,0.30)',
    chip: 'rgba(191,140,20,0.12)',
    picks: ['halo', 'weeknight', 'monstera'],
  },
];
