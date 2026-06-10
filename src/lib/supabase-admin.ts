import { createClient } from '@supabase/supabase-js';

// Service-role client for webhook handlers and server-side jobs.
// Bypasses RLS — never import this into client components.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
