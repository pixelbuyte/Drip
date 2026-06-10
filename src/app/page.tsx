'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();
  const supabase = createClient();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session) {
        router.push('/dashboard');
      } else {
        setIsLoading(false);
      }
    };

    checkAuth();
  }, [router, supabase]);

  if (isLoading) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <div className="mx-auto max-w-7xl px-4 py-16">
        <div className="text-center">
          <h1 className="text-5xl font-bold text-gray-900">Drip</h1>
          <p className="mt-4 text-xl text-gray-600">
            Video commerce made simple. Upload a video, tag a product, get a shareable link.
          </p>

          <div className="mt-8 flex gap-4 justify-center">
            <a
              href="/auth/signup"
              className="rounded-lg bg-blue-600 px-8 py-3 font-semibold text-white hover:bg-blue-700"
            >
              Start Selling
            </a>
            <a
              href="/auth/login"
              className="rounded-lg border border-gray-300 px-8 py-3 font-semibold text-gray-900 hover:bg-gray-50"
            >
              Sign In
            </a>
          </div>
        </div>

        <div className="mt-20 grid gap-8 md:grid-cols-3">
          <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
            <div className="text-4xl font-bold text-blue-600">1</div>
            <h3 className="mt-4 text-lg font-semibold">Upload Video</h3>
            <p className="mt-2 text-gray-600">Post a 60-second product video</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
            <div className="text-4xl font-bold text-blue-600">2</div>
            <h3 className="mt-4 text-lg font-semibold">Tag Product</h3>
            <p className="mt-2 text-gray-600">Set price, inventory, and shipping</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
            <div className="text-4xl font-bold text-blue-600">3</div>
            <h3 className="mt-4 text-lg font-semibold">Share & Sell</h3>
            <p className="mt-2 text-gray-600">Post in your TikTok bio, earn instantly</p>
          </div>
        </div>

        <footer className="mt-20 border-t border-gray-200 pt-8 text-center text-sm text-gray-500">
          <a href="/legal/terms" className="hover:text-gray-700">Terms</a>
          {' · '}
          <a href="/legal/privacy" className="hover:text-gray-700">Privacy</a>
          {' · '}
          <a href="/legal/prohibited-items" className="hover:text-gray-700">Prohibited Items</a>
        </footer>
      </div>
    </div>
  );
}
