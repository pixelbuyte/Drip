import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Public category list for GET /api/categories (Explore tiles, the listing
 * composer's picker).
 *
 * Read with the anon client: 00007 grants anon/authenticated SELECT on
 * exactly (id, slug, name, sort_order), and its RLS policy only matches
 * `is_active` rows. Two consequences worth keeping:
 *
 *   - The query must not mention `is_active` or `live_video_count`, not even
 *     in a filter. Postgres needs SELECT privilege on every column a WHERE
 *     references, so `.eq('is_active', true)` would fail with "permission
 *     denied" for anon. The policy already does that filtering.
 *   - live_video_count stays private: it tells a gamer which category still
 *     carries the thin-supply freshness multiplier (see the comment beside
 *     the GRANT in 00007).
 *
 * `CATEGORY_SLUGS` in listings.ts is the composer's compile-time copy of the
 * same seed; this reads the table so a category switched off in the database
 * disappears from clients without a release.
 */

export type PublicCategory = { slug: string; name: string };

export const CATEGORIES_CACHE_CONTROL =
  'public, s-maxage=300, stale-while-revalidate=3600';

type CategoryRow = { slug: string; name: string; sort_order: number | null };

export async function loadPublicCategories(db: SupabaseClient): Promise<PublicCategory[]> {
  const { data, error } = (await db
    .from('categories')
    .select('slug, name, sort_order')
    .order('sort_order', { ascending: true })) as {
    data: CategoryRow[] | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`categories query failed: ${error.message}`);
  return (data ?? []).map((row) => ({ slug: row.slug, name: row.name }));
}
