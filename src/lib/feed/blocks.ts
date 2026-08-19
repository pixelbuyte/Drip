import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Shared between the naive feed and the ranked feed: a viewer who said
 * not_interested on a video or a seller must never see them again (spec
 * 2.2), on either path. Extracted from `slice.ts` so both compute this
 * identically rather than risking the `expires_at` predicate drifting
 * between two copies.
 */
export type ViewerBlocks = {
  blockedVideos: ReadonlySet<string>;
  blockedSellers: ReadonlySet<string>;
};

export async function loadViewerBlocks(db: SupabaseClient, anonId: string): Promise<ViewerBlocks> {
  const { data: blocks } = await db
    .from('viewer_blocks')
    .select('subject_type, subject_id')
    .eq('anon_id', anonId)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);

  const blockedVideos = new Set<string>();
  const blockedSellers = new Set<string>();
  for (const b of blocks ?? []) {
    if (b.subject_type === 'video') blockedVideos.add(b.subject_id as string);
    if (b.subject_type === 'seller') blockedSellers.add(b.subject_id as string);
  }
  return { blockedVideos, blockedSellers };
}
