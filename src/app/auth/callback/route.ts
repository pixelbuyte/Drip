import { createServerClient_ } from '@/lib/supabase-server';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') || '/onboarding';

  if (code) {
    const supabase = await createServerClient_();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      return NextResponse.redirect(new URL(next, request.url));
    }
  }

  // Return to login with an error
  return NextResponse.redirect(new URL('/auth/login?error=auth_failed', request.url));
}
