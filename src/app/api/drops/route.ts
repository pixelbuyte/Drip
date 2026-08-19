import { NextRequest, NextResponse } from 'next/server';
import { getMux } from '@/lib/mux';
import { createServerClient_ } from '@/lib/supabase-server';
import { createDropSchema, slugify } from '@/lib/validation';

// Creates a drop (status: processing) and a Mux direct upload URL.
// The Mux webhook flips the drop to active when the video is ready.
export async function POST(request: NextRequest) {
  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Public identity and payment config are separate tables: charges_enabled
  // and from_address are on `seller_payments`, not `profiles`, because profiles
  // carries a public read policy and neither belongs in a publicly readable
  // table. Do not move them back.
  const [{ data: profile }, { data: payments }] = await Promise.all([
    supabase.from('profiles').select('id, handle').eq('id', user.id).single(),
    supabase
      .from('seller_payments')
      .select('charges_enabled, from_address')
      .eq('seller_id', user.id)
      .maybeSingle(),
  ]);

  if (!profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 400 });
  }

  // Hard gate: no listings until Stripe onboarding is complete. A missing
  // seller_payments row means onboarding never started, which gates the same.
  if (!payments?.charges_enabled) {
    return NextResponse.json(
      { error: 'Complete Stripe onboarding before creating a drop' },
      { status: 403 }
    );
  }

  // Shipping labels need a from-address; require it up front.
  if (!payments.from_address) {
    return NextResponse.json(
      { error: 'Add your ship-from address in Settings before creating a drop' },
      { status: 400 }
    );
  }

  let input;
  try {
    input = createDropSchema.parse(await request.json());
  } catch (err) {
    const message =
      err instanceof Error && 'errors' in err
        ? (err as { errors: { message: string }[] }).errors[0]?.message
        : 'Invalid input';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Generate a slug unique to this seller (UNIQUE(seller_id, slug)).
  const base = slugify(input.title);
  const { data: existing } = await supabase
    .from('drops')
    .select('slug')
    .eq('seller_id', user.id)
    .like('slug', `${base}%`);

  const taken = new Set((existing ?? []).map((d) => d.slug));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) {
    slug = `${base}-${i}`;
  }

  const { data: drop, error: insertError } = await supabase
    .from('drops')
    .insert({
      seller_id: user.id,
      title: input.title,
      slug,
      description: input.description ?? null,
      price_cents: input.price_cents,
      inventory: input.inventory,
      weight_oz: input.weight_oz,
      dimensions: input.dimensions,
      variants: input.variants && input.variants.length > 0 ? input.variants : null,
      status: 'processing',
    })
    .select()
    .single();

  if (insertError || !drop) {
    console.error('Drop insert failed:', insertError);
    return NextResponse.json({ error: 'Failed to create drop' }, { status: 500 });
  }

  try {
    const mux = getMux();
    const upload = await mux.video.uploads.create({
      cors_origin: process.env.NEXT_PUBLIC_APP_URL!,
      new_asset_settings: {
        playback_policy: ['public'],
        passthrough: drop.id,
        video_quality: 'basic',
      },
    });

    await supabase.from('drops').update({ mux_upload_id: upload.id }).eq('id', drop.id);

    return NextResponse.json({
      drop: { id: drop.id, slug: drop.slug },
      upload_url: upload.url,
    });
  } catch (err) {
    console.error('Mux upload creation failed:', err);
    // Don't leave an orphaned drop the seller can't see or finish.
    await supabase.from('drops').delete().eq('id', drop.id);
    return NextResponse.json({ error: 'Failed to create video upload' }, { status: 500 });
  }
}
