import { permanentRedirect } from 'next/navigation';

// The legacy "My Drops" list read public.drops, which 00007_feed_content_model.sql
// dropped. Studio Videos lists the seller's videos and products (including sold-out
// state) on the feed content model, so this route forwards there.
export default function DropsPage() {
  permanentRedirect('/studio/videos');
}
