import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createPublicClient } from '@/lib/supabase-public';
import DropView from './drop-view';

// Always render fresh so inventory counts are accurate.
export const dynamic = 'force-dynamic';

type Params = { handle: string; slug: string };

async function loadDrop(params: Params) {
  const handleParam = decodeURIComponent(params.handle);
  if (!handleParam.startsWith('@')) return null;
  const handle = handleParam.slice(1);

  const supabase = createPublicClient();

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, handle, display_name, avatar_url')
    .eq('handle', handle)
    .single();

  if (!profile) return null;

  const { data: drop } = await supabase
    .from('drops')
    .select('id, title, slug, description, price_cents, inventory, variants, mux_playback_id, status')
    .eq('seller_id', profile.id)
    .eq('slug', params.slug)
    .eq('status', 'active')
    .single();

  if (!drop) return null;

  return { profile, drop };
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const data = await loadDrop(await params);
  if (!data) return { title: 'Drop not found — Drip' };

  const { profile, drop } = data;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const url = `${appUrl}/@${profile.handle}/${drop.slug}`;
  const price = `$${(drop.price_cents / 100).toFixed(2)}`;
  const title = `${drop.title} — ${price}`;
  const description =
    drop.description || `${drop.title} by @${profile.handle}. Tap to watch and buy.`;
  const ogImage = drop.mux_playback_id
    ? `https://image.mux.com/${drop.mux_playback_id}/thumbnail.jpg?width=1200&height=630&fit_mode=smartcrop`
    : undefined;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url,
      siteName: 'Drip',
      type: 'website',
      ...(ogImage ? { images: [{ url: ogImage, width: 1200, height: 630 }] } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      ...(ogImage ? { images: [ogImage] } : {}),
    },
  };
}

export default async function DropPage({ params }: { params: Promise<Params> }) {
  const data = await loadDrop(await params);
  if (!data) notFound();

  const { profile, drop } = data;

  return (
    <DropView
      drop={{
        id: drop.id,
        title: drop.title,
        description: drop.description,
        price_cents: drop.price_cents,
        inventory: drop.inventory,
        variants: drop.variants ?? [],
        mux_playback_id: drop.mux_playback_id,
      }}
      seller={{ handle: profile.handle, display_name: profile.display_name }}
    />
  );
}
