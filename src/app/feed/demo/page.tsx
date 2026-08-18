import FeedShell from '@/components/feed/feed-shell';
import { DEMO_ITEMS } from './fixtures';

// Fixture-backed feed. Spec step 2: prove the shell — virtualization,
// snap, playback lifecycle, event emission — before ranking or even a
// database is involved.
export default function FeedDemoPage() {
  return <FeedShell initialItems={DEMO_ITEMS} surface="for_you" initialExhausted />;
}
