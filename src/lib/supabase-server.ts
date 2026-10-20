import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies, headers } from 'next/headers';
import { bearerToken } from './bearer';

export async function createServerClient_() {
  // Native clients send `Authorization: Bearer <access token>` instead of the
  // SSR auth cookies. Browsers never send it, so their path below is
  // unchanged.
  const token = bearerToken(await headers());
  if (token) return createBearerClient(token);

  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Handle errors during cookie setting
          }
        },
      },
    }
  );
}

/**
 * An anon-key client acting as the token's user: PostgREST receives the JWT,
 * so RLS applies exactly as it does for a cookie session.
 *
 * Every API route resolves the caller with `supabase.auth.getUser()` (no
 * argument), which reads a *stored* session — and a bearer client has none.
 * Pinning the token as getUser's default keeps those call sites untouched
 * while still verifying the token against Supabase Auth on each request.
 */
export function createBearerClient(token: string) {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }
  );
  const getUser = client.auth.getUser.bind(client.auth);
  client.auth.getUser = (jwt?: string) => getUser(jwt ?? token);
  return client;
}
