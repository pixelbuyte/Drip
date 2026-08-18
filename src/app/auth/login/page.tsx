'use client';

import { Auth } from '@supabase/auth-ui-react';
import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { authAppearance } from '../auth-appearance';

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkSession = async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        router.push('/dashboard');
      }
      setIsLoading(false);
    };

    checkSession();
  }, [supabase, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-ink">
        <span className="font-mono text-xs uppercase tracking-[0.3em] text-dim">Drip</span>
      </div>
    );
  }

  return (
    <div className="grain relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-ink px-5 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 h-[26rem] w-[44rem] -translate-x-1/2 rounded-full opacity-15 blur-[110px]"
        style={{ background: 'radial-gradient(closest-side, #d8ff3e, transparent)' }}
      />

      <div className="relative z-10 w-full max-w-sm">
        <div className="text-center">
          <a href="/" className="inline-flex items-baseline gap-2">
            <span className="font-display text-3xl font-extrabold tracking-tight text-paper">
              Drip
            </span>
            <span className="h-1.5 w-1.5 rounded-full bg-acid" />
          </a>
          <h1 className="mt-6 font-display text-2xl font-bold tracking-tight text-paper">
            Welcome back
          </h1>
          <p className="mt-2 text-sm text-dim">Sign in to your seller dashboard.</p>
        </div>

        <div className="mt-8 rounded-2xl border border-line bg-ink-raised p-6">
          <Auth
            supabaseClient={supabase}
            view="sign_in"
            appearance={authAppearance}
            theme="dark"
            redirectTo={`${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`}
            onlyThirdPartyProviders={false}
            providers={['google']}
          />
        </div>

        <p className="mt-6 text-center text-sm text-dim">
          New here?{' '}
          <a
            href="/auth/signup"
            className="font-semibold text-acid underline-offset-4 hover:underline"
          >
            Create an account
          </a>
        </p>
      </div>
    </div>
  );
}
