import { createClient } from '@supabase/supabase-js';

// Anon-key client for public, unauthenticated reads (drop pages).
// RLS still applies: only active drops and public profile fields.
export function createPublicClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'placeholder-anon-key',
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
