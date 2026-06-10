'use client';

import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

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
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold">Drip</h1>
          <p className="mt-2 text-sm text-gray-600">Video commerce made simple</p>
        </div>

        <Auth
          supabaseClient={supabase}
          view="sign_in"
          appearance={{ theme: ThemeSupa }}
          theme="light"
          redirectTo={`${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`}
          onlyThirdPartyProviders={false}
          providers={['google']}
        />

        <p className="text-center text-sm text-gray-600">
          Don't have an account?{' '}
          <a href="/auth/signup" className="font-semibold text-blue-600 hover:text-blue-500">
            Sign up
          </a>
        </p>
      </div>
    </div>
  );
}
