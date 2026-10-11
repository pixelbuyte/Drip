import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createPublicClient } from '@/lib/supabase-public';
import {
  formatPriceCents,
  loadSharedVideo,
  sharedVideoPath,
  sharedVideoPoster,
  sharedVideoSummary,
} from '@/lib/feed/shared-video';

// A shared link must show current state: a removed video or a sold-out
// product disappears from the page the moment it does from the feed.
export const dynamic = 'force-dynamic';

type Params = { videoId: string };

// generateMetadata and the page both need the video; one query per request.
// Read with the anon client so RLS (live videos only, products of sellers who
// can take payment) applies on top of the helper's own live filter. Any
// failure — including the legacy production schema with no `videos` table —
// resolves to null, i.e. a 404, never a 500.
const getVideo = cache((videoId: string) => loadSharedVideo(createPublicClient(), videoId));

function siteUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { videoId } = await params;
  const item = await getVideo(videoId);
  if (!item) {
    return { title: 'Video not found — Drip', robots: { index: false } };
  }

  const { title, description } = sharedVideoSummary(item);
  const poster = sharedVideoPoster(item);
  const base = siteUrl();
  const url = base ? `${base}${sharedVideoPath(item.videoId)}` : undefined;

  return {
    title,
    description,
    ...(url ? { alternates: { canonical: url } } : {}),
    openGraph: {
      title,
      description,
      ...(url ? { url } : {}),
      siteName: 'Drip',
      type: 'video.other',
      ...(poster ? { images: [{ url: poster, alt: item.caption ?? title }] } : {}),
    },
    twitter: {
      card: poster ? 'summary_large_image' : 'summary',
      title,
      description,
      ...(poster ? { images: [poster] } : {}),
    },
  };
}

export default async function SharedVideoPage({ params }: { params: Promise<Params> }) {
  const { videoId } = await params;
  const item = await getVideo(videoId);
  if (!item) notFound();

  const poster = sharedVideoPoster(item);
  const product = item.products[0];
  const extra = item.products.length - 1;
  const onSale =
    product?.compareAtPriceCents != null && product.compareAtPriceCents > product.priceCents;
  // The web feed has no "open at this video" parameter yet; it opens on the
  // viewer's For you feed. The native app (universal link) opens this video.
  const watchHref = '/feed';

  return (
    <main className="relative flex min-h-dvh flex-col items-center overflow-hidden bg-cream px-4 py-8">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 h-[26rem] w-[44rem] -translate-x-1/2 rounded-full opacity-40 blur-[110px]"
        style={{ background: 'radial-gradient(closest-side, rgba(255,75,46,0.18), transparent)' }}
      />

      <div className="relative z-10 w-full max-w-sm">
        <header className="text-center">
          <a href="/" className="inline-flex items-baseline">
            <span className="font-display text-[28px] font-extrabold tracking-[-0.03em] text-ink">
              Drip<span className="text-coral">.</span>
            </span>
          </a>
        </header>

        <a
          href={watchHref}
          aria-label={`Watch @${item.seller.handle}'s video on Drip`}
          className="group relative mt-6 block aspect-[9/16] w-full overflow-hidden rounded-[22px] bg-ink shadow-card"
        >
          {poster ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={poster}
              alt={item.caption ?? `Video by @${item.seller.handle}`}
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : null}
          <span
            aria-hidden
            className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/60"
          />
          <span
            aria-hidden
            className="absolute left-1/2 top-1/2 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/90 shadow-float transition group-hover:scale-105"
          >
            <svg viewBox="0 0 24 24" className="ml-1 h-7 w-7 fill-ink">
              <path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5Z" />
            </svg>
          </span>
          <span className="absolute inset-x-0 bottom-0 p-4 text-left">
            <span className="block text-[15px] font-semibold text-white">@{item.seller.handle}</span>
            {item.caption ? (
              <span className="mt-1 line-clamp-3 block text-[14px] leading-snug text-white/90">
                {item.caption}
              </span>
            ) : null}
          </span>
        </a>

        {product ? (
          <div className="mt-4 flex items-center gap-3 rounded-[18px] bg-card p-3 shadow-card">
            {product.images[0] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={product.images[0]}
                alt=""
                width={48}
                height={48}
                className="h-12 w-12 shrink-0 rounded-[12px] object-cover"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold text-ink">{product.title}</p>
              <p className="text-[14px]">
                <span className={onSale ? 'font-semibold text-sale' : 'font-semibold text-ink'}>
                  {formatPriceCents(product.priceCents)}
                </span>
                {onSale ? (
                  <span className="ml-2 text-muted line-through">
                    {formatPriceCents(product.compareAtPriceCents!)}
                  </span>
                ) : null}
                {extra > 0 ? (
                  <span className="ml-2 text-muted">+{extra} more in this video</span>
                ) : null}
              </p>
            </div>
          </div>
        ) : null}

        <a
          href={watchHref}
          className="mt-6 flex min-h-[52px] w-full items-center justify-center rounded-full bg-coral px-6 text-[16px] font-semibold text-ink shadow-cta transition hover:brightness-105"
        >
          Watch on Drip
        </a>
        <p className="mt-3 text-center text-[13px] text-muted">
          Shop it straight from the video, from people with taste.
        </p>
      </div>
    </main>
  );
}
