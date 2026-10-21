import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getMux } from '@/lib/mux';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { slugify } from '@/lib/validation';
import { createListingSchema, toStoredVariants, VIDEO_PASSTHROUGH_PREFIX } from '@/lib/listings';

/**
 * POST /api/videos — creates a listing on the feed content model and a Mux
 * direct-upload URL. The Mux webhook publishes the video (status 'live')
 * once the asset is ready, which is what puts it in the feed.
 *
 * Requires the 00006+ schema. It replaces the retired `/api/drops` (now 410)
 * for both the iOS app and the web composer.
 *
 * Writes go through the caller's own session, so the owner RLS policies
 * (00007) still bind: every row is created as, and only as, this seller.
 * guard_video_status pins the new video to 'processing'.
 */
export async function POST(request: NextRequest) {
  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // seller_payments grants sellers nothing (platform-attested Stripe state),
  // so it is read with the service role, scoped to the verified user id.
  const { data: payments } = await createAdminClient()
    .from('seller_payments')
    .select('charges_enabled, from_address')
    .eq('seller_id', user.id)
    .maybeSingle();
  if (!payments?.charges_enabled) {
    return NextResponse.json(
      { error: 'Set up payouts before listing something', code: 'payouts_required' },
      { status: 403 }
    );
  }
  if (!payments.from_address) {
    return NextResponse.json(
      { error: 'Add your ship-from address before listing something', code: 'from_address_required' },
      { status: 400 }
    );
  }

  const parsed = createListingSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid input' },
      { status: 400 }
    );
  }
  const input = parsed.data;

  const { data: category } = await supabase
    .from('categories')
    .select('id')
    .eq('slug', input.category_slug)
    .maybeSingle();
  if (!category) {
    return NextResponse.json({ error: 'Unknown category' }, { status: 400 });
  }

  // Slug unique per seller (UNIQUE(seller_id, slug)).
  const base = slugify(input.title);
  const { data: existing } = await supabase
    .from('products')
    .select('slug')
    .eq('seller_id', user.id)
    .like('slug', `${base}%`);
  const taken = new Set((existing ?? []).map((p: { slug: string }) => p.slug));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;

  // The upload is created first, under an id chosen here, so the video row is
  // inserted complete: authenticated sellers cannot UPDATE mux_upload_id.
  const videoId = randomUUID();
  const mux = getMux();
  let upload: { id: string; url: string };
  try {
    const created = await mux.video.uploads.create({
      cors_origin: process.env.NEXT_PUBLIC_APP_URL ?? '*',
      new_asset_settings: {
        playback_policy: ['public'],
        passthrough: `${VIDEO_PASSTHROUGH_PREFIX}${videoId}`,
        video_quality: 'basic',
      },
    });
    if (!created.url) throw new Error('Mux returned no upload URL');
    upload = { id: created.id, url: created.url };
  } catch (err) {
    console.error('Mux upload creation failed:', err);
    return NextResponse.json({ error: 'Failed to create video upload' }, { status: 502 });
  }

  const created: { shippingProfileId?: string; productId?: string; video?: boolean } = {};
  try {
    const { data: shipping, error: shippingError } = await supabase
      .from('shipping_profiles')
      .insert({
        seller_id: user.id,
        name: input.title.slice(0, 40),
        weight_oz: input.weight_oz,
        length_in: input.dimensions.length_in,
        width_in: input.dimensions.width_in,
        height_in: input.dimensions.height_in,
      })
      .select('id')
      .single();
    if (shippingError || !shipping) throw shippingError ?? new Error('no shipping profile');
    created.shippingProfileId = shipping.id;

    const { data: product, error: productError } = await supabase
      .from('products')
      .insert({
        seller_id: user.id,
        slug,
        title: input.title,
        description: input.description ?? null,
        price_cents: input.price_cents,
        compare_at_price_cents: input.compare_at_price_cents ?? null,
        inventory_count: input.inventory,
        variants: toStoredVariants(input.variants, input.inventory),
        shipping_profile_id: shipping.id,
        category_id: category.id,
      })
      .select('id')
      .single();
    if (productError || !product) throw productError ?? new Error('no product');
    created.productId = product.id;

    const { error: videoError } = await supabase.from('videos').insert({
      id: videoId,
      seller_id: user.id,
      category_id: category.id,
      mux_upload_id: upload.id,
      caption: input.caption ?? null,
      hashtags: input.hashtags ?? [],
    });
    if (videoError) throw videoError;
    created.video = true;

    const { error: linkError } = await supabase.from('video_products').insert({
      video_id: videoId,
      product_id: product.id,
      seller_id: user.id,
      position: 0,
    });
    if (linkError) throw linkError;

    return NextResponse.json(
      { video: { id: videoId }, product: { id: product.id, slug }, upload_url: upload.url },
      { status: 201 }
    );
  } catch (err) {
    console.error('Listing creation failed:', err);
    // Leave nothing half-made that the seller can't see or finish.
    if (created.video) await supabase.from('videos').delete().eq('id', videoId);
    if (created.productId) await supabase.from('products').delete().eq('id', created.productId);
    if (created.shippingProfileId) {
      await supabase.from('shipping_profiles').delete().eq('id', created.shippingProfileId);
    }
    await mux.video.uploads.cancel(upload.id).catch(() => {});
    return NextResponse.json({ error: 'Failed to create listing' }, { status: 500 });
  }
}
