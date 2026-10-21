import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Resolves a legacy shared drop link, `/@handle/slug`, to the live video that
 * now sells that product, so the old URL can redirect to `/v/[videoId]`.
 *
 * public.drops was dropped by 00007_feed_content_model.sql. Its backfill kept
 * each drop's slug on `products.slug` (unique per seller) and linked the
 * product to a video through `video_products`, so handle + slug still
 * identifies one product, and the product identifies its videos.
 *
 * Meant for the anon (public) client: RLS already hides archived products,
 * sellers who cannot take payments, and video_products rows whose video is not
 * live. The `status = 'live'` filter on videos is repeated so the rule does not
 * depend on which client the caller passes.
 *
 * Never throws. Any lookup failure reads as "no such link" (null), so the page
 * renders a 404 rather than a 500.
 */
export async function resolveLegacyDropVideoId(
  db: SupabaseClient,
  params: { handle: string; slug: string }
): Promise<string | null> {
  try {
    let handleParam: string;
    try {
      handleParam = decodeURIComponent(params.handle);
    } catch {
      return null;
    }
    if (!handleParam.startsWith('@')) return null;
    const handle = handleParam.slice(1);
    if (!handle || !params.slug) return null;

    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('id')
      .eq('handle', handle)
      .maybeSingle();
    if (profileError || !profile) return null;

    const { data: product, error: productError } = await db
      .from('products')
      .select('id')
      .eq('seller_id', profile.id)
      .eq('slug', params.slug)
      .maybeSingle();
    if (productError || !product) return null;

    const { data: links, error: linksError } = await db
      .from('video_products')
      .select('video_id')
      .eq('product_id', product.id);
    if (linksError) return null;
    const videoIds = [...new Set((links ?? []).map((l: { video_id: string }) => l.video_id))];
    if (videoIds.length === 0) return null;

    // A product can appear in several videos; the most recently published
    // live one is the best stand-in for the old single-video drop page.
    const { data: video, error: videoError } = await db
      .from('videos')
      .select('id')
      .in('id', videoIds)
      .eq('status', 'live')
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (videoError || !video) return null;

    return video.id as string;
  } catch (err) {
    console.error('legacy drop link lookup failed:', err);
    return null;
  }
}
