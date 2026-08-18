'use client';

import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function DashboardPage() {
  const router = useRouter();
  const supabase = createClient();
  const [isLoading, setIsLoading] = useState(true);
  const [profile, setProfile] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{
    total_revenue_cents: number;
    total_sales: number;
    pending_payout_cents: number;
    available_payout_cents: number;
  } | null>(null);

  useEffect(() => {
    const loadProfile = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          router.push('/auth/login');
          return;
        }

        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', user.id)
          .single();

        if (error) throw error;

        setProfile(data);

        // Check if Stripe onboarding is complete
        if (!data.charges_enabled) {
          router.push('/onboarding/stripe');
          return;
        }

        // Revenue/payout stats are non-blocking.
        fetch('/api/dashboard/stats')
          .then((res) => (res.ok ? res.json() : null))
          .then((s) => s && setStats(s))
          .catch(() => {});
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setIsLoading(false);
      }
    };

    loadProfile();
  }, [supabase, router]);

  if (isLoading) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-red-600">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">
              Welcome, {profile?.display_name}
            </h1>
            <p className="mt-1 text-gray-600">@{profile?.handle}</p>
          </div>
          <button
            onClick={() => supabase.auth.signOut()}
            className="rounded-lg bg-gray-600 px-4 py-2 text-white hover:bg-gray-700"
          >
            Sign Out
          </button>
        </div>

        {!profile?.from_address && (
          <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm text-amber-900">
              ⚠️ Add your{' '}
              <a href="/dashboard/settings" className="font-semibold underline">
                ship-from address
              </a>{' '}
              before creating your first drop — it's required for shipping labels.
            </p>
          </div>
        )}

        {/* Revenue / payout stats */}
        <div className="mt-8 grid grid-cols-3 gap-4">
          <div className="rounded-lg border border-gray-200 bg-white p-4 text-center">
            <div className="text-2xl font-bold text-gray-900">
              {stats ? `$${(stats.total_revenue_cents / 100).toFixed(2)}` : '—'}
            </div>
            <div className="mt-1 text-xs font-medium uppercase tracking-wide text-gray-500">
              Revenue
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-4 text-center">
            <div className="text-2xl font-bold text-gray-900">
              {stats ? stats.total_sales : '—'}
            </div>
            <div className="mt-1 text-xs font-medium uppercase tracking-wide text-gray-500">
              Sales
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-4 text-center">
            <div className="text-2xl font-bold text-gray-900">
              {stats ? `$${(stats.pending_payout_cents / 100).toFixed(2)}` : '—'}
            </div>
            <div className="mt-1 text-xs font-medium uppercase tracking-wide text-gray-500">
              Pending payout
            </div>
          </div>
        </div>

        <div className="mt-8 grid gap-6 md:grid-cols-2">
          <a
            href="/dashboard/drops"
            className="rounded-lg border border-gray-200 bg-white p-6 hover:border-blue-300 hover:shadow-sm"
          >
            <h2 className="text-lg font-semibold text-gray-900">My Drops</h2>
            <p className="mt-2 text-gray-600">Create and manage your video listings</p>
          </a>

          <a
            href="/dashboard/orders"
            className="rounded-lg border border-gray-200 bg-white p-6 hover:border-blue-300 hover:shadow-sm"
          >
            <h2 className="text-lg font-semibold text-gray-900">Orders</h2>
            <p className="mt-2 text-gray-600">Sales, labels, tracking, CSV export</p>
          </a>

          <a
            href="/dashboard/discounts"
            className="rounded-lg border border-gray-200 bg-white p-6 hover:border-blue-300 hover:shadow-sm"
          >
            <h2 className="text-lg font-semibold text-gray-900">Discount Codes</h2>
            <p className="mt-2 text-gray-600">Create promo codes for your buyers</p>
          </a>

          <a
            href="/dashboard/settings"
            className="rounded-lg border border-gray-200 bg-white p-6 hover:border-blue-300 hover:shadow-sm"
          >
            <h2 className="text-lg font-semibold text-gray-900">Settings</h2>
            <p className="mt-2 text-gray-600">Ship-from address for your labels</p>
          </a>
        </div>
      </div>
    </div>
  );
}
