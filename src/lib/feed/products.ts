import type { FeedProduct, VariantGroup } from './types';

/**
 * Shared between the naive feed (`slice.ts`) and the ranked feed
 * (`pool.ts`/`ranked-slice.ts`) so both compute a video's sellable products —
 * and its `minPriceCents` — identically. Originally lived only in
 * `slice.ts`; extracted so the two paths cannot drift on what "buyable"
 * means, which would otherwise show a viewer different eligibility rules
 * depending on which feed variant they landed in.
 */

export type ProductRow = {
  position: number;
  pinned_at_second: number | null;
  products: {
    id: string;
    title: string;
    price_cents: number;
    compare_at_price_cents: number | null;
    inventory_count: number;
    low_stock_threshold: number;
    images: string[] | null;
    variants: unknown;
    status: string;
  } | null;
};

export function toVariantGroups(raw: unknown): VariantGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((g): VariantGroup[] => {
    if (!g || typeof g !== 'object') return [];
    const group = g as Record<string, unknown>;
    if (typeof group.name !== 'string' || !Array.isArray(group.options)) return [];
    return [
      {
        id: typeof group.id === 'string' ? group.id : group.name,
        name: group.name,
        options: group.options.flatMap((o): VariantGroup['options'] => {
          if (!o || typeof o !== 'object') return [];
          const opt = o as Record<string, unknown>;
          const value =
            typeof opt.value === 'string' ? opt.value : typeof opt.name === 'string' ? opt.name : null;
          if (!value) return [];
          return [
            {
              id: typeof opt.id === 'string' ? opt.id : `${group.name}:${value}`,
              value,
              priceDeltaCents: Number(opt.price_delta_cents ?? 0) || 0,
              inventoryCount: Number(opt.inventory_count ?? 0) || 0,
              sku: typeof opt.sku === 'string' ? opt.sku : null,
            },
          ];
        }),
      },
    ];
  });
}

/**
 * "At least one attached product with status active AND inventory > 0" —
 * the spec's hard filter, applied identically by both feed paths. Sorted by
 * `position`, capped at 5 (a video sells 1-5 products).
 */
export function shapeSellableProducts(rows: readonly ProductRow[] | null | undefined): FeedProduct[] {
  return (rows ?? [])
    .filter((vp) => vp.products && vp.products.status === 'active' && vp.products.inventory_count > 0)
    .sort((a, b) => a.position - b.position)
    .slice(0, 5)
    .map((vp) => {
      const p = vp.products!;
      return {
        id: p.id,
        title: p.title,
        priceCents: p.price_cents,
        compareAtPriceCents: p.compare_at_price_cents,
        inventoryCount: p.inventory_count,
        lowStockThreshold: p.low_stock_threshold,
        images: p.images ?? [],
        variants: toVariantGroups(p.variants),
        position: vp.position,
        pinnedAtSecond: vp.pinned_at_second,
      };
    });
}

/**
 * The minimum price across a video's currently-sellable products, in cents.
 * `null` when the video has no sellable product at all (the caller should
 * treat that as ineligible — both feed paths already drop such videos).
 */
export function minSellablePriceCents(rows: readonly ProductRow[] | null | undefined): number | null {
  const products = shapeSellableProducts(rows);
  if (products.length === 0) return null;
  return Math.min(...products.map((p) => p.priceCents));
}
