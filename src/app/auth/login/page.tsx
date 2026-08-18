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
      <div className="flex min-h-dvh items-center justify-center bg-cream">
        <span className="font-display text-lg font-bold text-ink">
          Drip<span className="text-coral">.</span>
        </span>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-cream px-5 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 h-[26rem] w-[44rem] -translate-x-1/2 rounded-full opacity-40 blur-[110px]"
        style={{ background: 'radial-gradient(closest-side, rgba(255,75,46,0.18), transparent)' }}
      />

      <div className="relative z-10 w-full max-w-sm">
        <div className="text-center">
          <a href="/" className="inline-flex items-baseline gap-2">
            <span className="font-display text-[28px] font-extrabold tracking-[-0.03em] text-ink">
              Drip<span className="text-coral">.</span>
            </span>
          </a>
          <h1 className="mt-6 font-display text-[22px] font-bold tracking-[-0.02em] text-ink">
            Welcome back
          </h1>
          <p className="mt-2 text-[14px] text-muted">Sign in to your seller dashboard.</p>
        </div>

        <div className="mt-8 rounded-[20px] bg-card p-6 shadow-card">
          <Auth
            supabaseClient={supabase}
            view="sign_in"
            appearance={authAppearance}
            theme="default"
            redirectTo={`${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`}
            onlyThirdPartyProviders={false}
            providers={['google']}
          />
        </div>

        <p className="mt-6 text-center text-[14px] text-muted">
          New here?{' '}
          <a
            href="/auth/signup"
            className="font-semibold text-coral-deep underline-offset-4 hover:underline"
          >
            Create an account
          </a>
        </p>
      </div>
    </div>
  );
}
