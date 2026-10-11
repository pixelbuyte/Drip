import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient } from '@/lib/supabase-public';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { CATEGORIES_CACHE_CONTROL, loadPublicCategories } from '@/lib/categories';

export const dynamic = 'force-dynamic';

/**
 * GET /api/categories → { categories: [{ slug, name }] }, active only, in
 * sort_order. Public and identical for every caller, so the CDN caches it;
 * the anon client keeps the read inside 00007's column grant. See
 * src/lib/categories.ts.
 */
export async function GET(request: NextRequest) {
  if (!rateLimit(`categories:${clientIp(request)}`, 120, 60_000)) {
    return NextResponse.json({ error: 'Slow down a moment.' }, { status: 429 });
  }

  try {
    const categories = await loadPublicCategories(createPublicClient());
    return NextResponse.json(
      { categories },
      { headers: { 'Cache-Control': CATEGORIES_CACHE_CONTROL } }
    );
  } catch (err) {
    console.error('categories read failed:', err);
    return NextResponse.json({ error: 'Could not load categories' }, { status: 500 });
  }
}
