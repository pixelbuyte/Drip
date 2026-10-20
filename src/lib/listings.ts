import { z } from 'zod';
import { variantDimensionSchema } from '@/lib/validation';

/**
 * Creator listings on the feed content model (00007): one product, one video,
 * linked through video_products. Replaces the legacy `drops` table, which
 * 00007 drops; the feed only ever reads `videos`.
 */

/** Seeded by 00007_feed_content_model.sql. The naive feed inner-joins
 *  categories, so every listing needs one; "other" is the default. */
export const CATEGORY_SLUGS = [
  'apparel',
  'footwear',
  'jewelry-accessories',
  'beauty',
  'home-decor',
  'vintage-thrift',
  'collectibles',
  'handmade-craft',
  'tech-gadgets',
  'pet',
  'fitness',
  'other',
] as const;

export const createListingSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(100),
    description: z.string().trim().max(1000, 'Description must be 1000 characters or less').optional(),
    price_cents: z.number().int().min(100, 'Minimum price is $1.00').max(99999900, 'Price too high'),
    compare_at_price_cents: z.number().int().min(100).max(99999900).optional(),
    inventory: z.number().int().min(1, 'Inventory must be at least 1').max(100000),
    weight_oz: z.number().min(0.1, 'Weight is required for shipping').max(1120),
    dimensions: z.object({
      length_in: z.number().min(0.1).max(108),
      width_in: z.number().min(0.1).max(108),
      height_in: z.number().min(0.1).max(108),
    }),
    variants: z.array(variantDimensionSchema).max(2, 'Max 2 variant dimensions').optional(),
    caption: z.string().trim().max(500, 'Caption must be 500 characters or less').optional(),
    hashtags: z.array(z.string().trim().min(1).max(30)).max(10, 'Max 10 hashtags').optional(),
    category_slug: z.enum(CATEGORY_SLUGS).default('other'),
  })
  .refine((v) => v.compare_at_price_cents === undefined || v.compare_at_price_cents > v.price_cents, {
    message: 'The “was” price must be higher than the price',
    path: ['compare_at_price_cents'],
  });

export type CreateListingInput = z.infer<typeof createListingSchema>;

/**
 * The stored `products.variants` shape that the feed (toVariantGroups) and
 * checkout (variant deltas by option `value`) both read. Stock is tracked per
 * product, not per option, so each option carries the product's count; an
 * option with 0 would render as sold out.
 */
export function toStoredVariants(
  dims: CreateListingInput['variants'],
  inventory: number
): Array<{
  id: string;
  name: string;
  options: Array<{ id: string; value: string; price_delta_cents: number; inventory_count: number; sku: null }>;
}> | null {
  if (!dims || dims.length === 0) return null;
  return dims.map((d) => ({
    id: d.name,
    name: d.name,
    options: [...new Set(d.options)].map((value) => ({
      id: `${d.name}:${value}`,
      value,
      price_delta_cents: 0,
      inventory_count: inventory,
      sku: null,
    })),
  }));
}

/** Mux passthrough for listings. Legacy drops pass a bare drop id. */
export const VIDEO_PASSTHROUGH_PREFIX = 'video:';

export type Passthrough = { kind: 'video'; id: string } | { kind: 'drop'; id: string } | null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePassthrough(raw: string | undefined | null): Passthrough {
  if (!raw) return null;
  if (raw.startsWith(VIDEO_PASSTHROUGH_PREFIX)) {
    const id = raw.slice(VIDEO_PASSTHROUGH_PREFIX.length);
    return UUID.test(id) ? { kind: 'video', id } : null;
  }
  return UUID.test(raw) ? { kind: 'drop', id: raw } : null;
}

/** Mux reports e.g. "9:16"; anything else is left NULL (CHECK ^\d{1,3}:\d{1,3}$). */
export function muxAspectRatio(raw: string | undefined): string | null {
  return raw && /^\d{1,3}:\d{1,3}$/.test(raw) ? raw : null;
}

export function muxThumbnailUrl(playbackId: string): string {
  return `https://image.mux.com/${playbackId}/thumbnail.jpg?time=1`;
}
