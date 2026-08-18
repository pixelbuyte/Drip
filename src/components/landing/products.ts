// The demo catalog. Every product is fictional; prices are chosen to feel
// real. Activity numbers (saves, bought-today) appear ONLY inside these
// depicted app-UI cards, never as claims about the platform.

export type Category =
  | 'sneakers' | 'fashion' | 'beauty' | 'gaming'
  | 'tech' | 'home' | 'fitness' | 'gifts';

export type Product = {
  id: string;
  name: string;
  price: number;          // dollars
  wasPrice?: number;      // struck-through sale price
  rating: number;
  reviews: string;        // display string, e.g. "2.1k"
  glyph: string;          // emoji product stand-in
  category: Category;
  tilt: number;           // glyph rotation, degrees
  badge?: 'new' | 'drop' | 'restock';
  creator?: string;       // "@handle" attribution
  sponsored?: boolean;
};

// 135° pastel duotones per category — all in the light band so ink text
// stays readable on top; plus the hue-tinted contact shadow for the glyph.
export const SCENES: Record<Category, { from: string; to: string; shadow: string }> = {
  sneakers: { from: '#ffe3d8', to: '#ffc9b5', shadow: 'rgba(255,75,46,0.35)' },
  fashion:  { from: '#ffdcec', to: '#ffc2dd', shadow: 'rgba(255,46,147,0.32)' },
  beauty:   { from: '#f3e4ff', to: '#e3ccff', shadow: 'rgba(109,74,255,0.28)' },
  gaming:   { from: '#e4dcff', to: '#cdc2ff', shadow: 'rgba(109,74,255,0.32)' },
  tech:     { from: '#dde7ff', to: '#c4d5ff', shadow: 'rgba(46,92,255,0.3)' },
  home:     { from: '#ffedd2', to: '#ffddb0', shadow: 'rgba(255,176,31,0.4)' },
  fitness:  { from: '#e7f5d8', to: '#d2ecb9', shadow: 'rgba(122,180,60,0.35)' },
  gifts:    { from: '#ffe0e8', to: '#ffd9c4', shadow: 'rgba(255,75,46,0.3)' },
};

export const PRODUCTS: Product[] = [
  { id: 'ace',      name: 'Suncourt Ace Low — Cream/Coral',   price: 118, rating: 4.9, reviews: '3.4k', glyph: '👟', category: 'sneakers', tilt: -8, creator: '@maya.finds', sponsored: true },
  { id: 'fleet',    name: 'Fleetfoot Featherlite — Sorbet',    price: 96,  rating: 4.7, reviews: '1.8k', glyph: '👟', category: 'sneakers', tilt: 6 },
  { id: 'glaze',    name: 'Glaze Lip Oil — Guava',             price: 22,  rating: 4.8, reviews: '5.2k', glyph: '💄', category: 'beauty',   tilt: -5, badge: 'new' },
  { id: 'dewpoint', name: 'Dewpoint Skin Tint SPF 30',         price: 34,  rating: 4.6, reviews: '2.9k', glyph: '🧴', category: 'beauty',   tilt: 7 },
  { id: 'pebble',   name: 'Pebble Buds Mini — Matte Clay',     price: 59,  wasPrice: 79, rating: 4.8, reviews: '4.1k', glyph: '🎧', category: 'tech', tilt: -6 },
  { id: 'loop',     name: 'Loop Micro Speaker — Cherry',       price: 45,  rating: 4.5, reviews: '980',  glyph: '🔊', category: 'tech',     tilt: 8 },
  { id: 'kindling', name: 'Kindling Ceramic Pour-Over Set',    price: 68,  rating: 4.9, reviews: '1.2k', glyph: '☕', category: 'home',     tilt: -4, creator: '@sundaysoph' },
  { id: 'candle',   name: 'Golden Hour Candle — Amber No. 3',  price: 28,  rating: 4.7, reviews: '3.7k', glyph: '🕯️', category: 'home',    tilt: 5 },
  { id: 'gripwell', name: 'Gripwell Studio Mat — Sage',        price: 48,  rating: 4.8, reviews: '2.3k', glyph: '🧘', category: 'fitness',  tilt: -7 },
  { id: 'crescent', name: 'Crescent Crossbody — Butter',       price: 72,  rating: 4.9, reviews: '1.6k', glyph: '👜', category: 'gifts',    tilt: 6, badge: 'restock' },
  { id: 'halo',     name: 'Halo Desk Lamp — Tangerine',        price: 54,  rating: 4.6, reviews: '740',  glyph: '🛋️', category: 'home',    tilt: -5, creator: '@theo.builds' },
  { id: 'pixelpad', name: 'PixelPad Pro Controller',           price: 64,  rating: 4.7, reviews: '1.1k', glyph: '🎮', category: 'gaming',   tilt: 7 },
];

export const byId = (id: string) => PRODUCTS.find((p) => p.id === id)!;

export const CREATORS = [
  {
    handle: '@maya.finds',
    name: 'Maya',
    initials: 'MF',
    bio: 'Finds under $60, five days a week.',
    quote: 'If it’s on my page, it’s already in my cart.',
    picks: ['ace', 'glaze', 'crescent'],
  },
  {
    handle: '@theo.builds',
    name: 'Theo',
    initials: 'TB',
    bio: 'Desks, tech, and things that earn their counter space.',
    quote: 'Buy it once, love it daily.',
    picks: ['halo', 'pebble', 'loop'],
  },
  {
    handle: '@sundaysoph',
    name: 'Sofia',
    initials: 'SS',
    bio: 'Cozy home, slow Sundays, zero clutter.',
    quote: 'I only post what survives the 30-day test.',
    picks: ['kindling', 'candle', 'gripwell'],
  },
];
