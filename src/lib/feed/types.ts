// The wire contract between /api/feed and the shell. Deliberately flat and
// small: it is fetched on the critical path and again every 15 slides.

export type FeedProduct = {
  id: string;
  title: string;
  priceCents: number;
  compareAtPriceCents: number | null;
  inventoryCount: number;
  lowStockThreshold: number;
  images: string[];
  variants: VariantGroup[];
  position: number;
  pinnedAtSecond: number | null;
};

export type VariantGroup = {
  id: string;
  name: string;
  options: VariantOption[];
};

export type VariantOption = {
  id: string;
  value: string;
  priceDeltaCents: number;
  inventoryCount: number;
  sku: string | null;
};

export type FeedItem = {
  videoId: string;
  playbackId: string | null;
  durationSeconds: number;
  aspectRatio: string | null;
  thumbnailUrl: string | null;
  caption: string | null;
  hashtags: string[];
  categorySlug: string | null;
  seller: {
    id: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
  };
  products: FeedProduct[];
  /** Which candidate lane produced this item. 'chrono' until ranking is live. */
  lane: FeedLane;
  position: number;
};

export type FeedLane = 'chrono' | 'affinity' | 'trending' | 'fresh' | 'social' | 'random';

export type FeedSurface =
  | 'for_you' | 'following' | 'category' | 'seller_profile' | 'search' | 'shared_link';

export type FeedResponse = {
  items: FeedItem[];
  /** Echoed so the client can keep excluding what it has already seen. */
  sessionId: string;
  surface: FeedSurface;
  /** True when the candidate pool is empty — the shell shows "all caught up". */
  exhausted: boolean;
  /**
   * Echoed but not yet honored. Step 10 (within-session adaptation) reads it;
   * keeping it in the contract now means the client never has to change.
   */
  mode: 'default' | 'diversify';
  /** published_at cursor for the next slice; null when the tail is reached. */
  nextBefore: string | null;
};

/**
 * The SSR page's throwaway session id — "the client owns session identity;
 * this first render only needs content, and the shell re-requests with its
 * real session id" (see `feed/page.tsx`). Every anonymous visitor's first
 * render shares this same value, so nothing may be written to `feed_slices`
 * keyed on it: that would collide every visitor's SSR slice into one
 * (session_id, video_id) primary key.
 */
export const SSR_PLACEHOLDER_SESSION_ID = '00000000-0000-0000-0000-000000000000';

export const FEED_SLICE_SIZE = 20;
/** Fetch the next slice when the viewer reaches this index of the buffer. */
export const FEED_PREFETCH_AT = 15;
