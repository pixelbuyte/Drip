import { createBrowserClient } from '@supabase/ssr';

// Fallbacks keep `next build` working without live credentials (CI/prerender).
// Real values are inlined at build time on Vercel / from .env.local.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'placeholder-anon-key'
  );
}
