import { notFound, permanentRedirect } from 'next/navigation';
import { createPublicClient } from '@/lib/supabase-public';
import { resolveLegacyDropVideoId } from '@/lib/legacy-drop-link';
import { sharedVideoPath } from '@/lib/feed/shared-video';

// Resolve on every request: whether the product still has a live video changes.
export const dynamic = 'force-dynamic';

type Params = { handle: string; slug: string };

// Legacy shared drop links (/@handle/slug) predate the feed content model.
// public.drops is gone, so instead of a storefront this page forwards to the
// product's live video at /v/[videoId], and 404s when there is none.
export default async function LegacyDropPage({ params }: { params: Promise<Params> }) {
  const videoId = await resolveLegacyDropVideoId(createPublicClient(), await params);
  if (!videoId) notFound();
  permanentRedirect(sharedVideoPath(videoId));
}
