'use client';

import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Drop = {
  id: string;
  title: string;
  slug: string;
  price_cents: number;
  inventory: number;
  status: string;
  created_at: string;
};

const statusStyles: Record<string, string> = {
  processing: 'bg-amber-100 text-amber-800',
  active: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
  archived: 'bg-gray-100 text-gray-600',
};

const statusLabels: Record<string, string> = {
  processing: 'Processing video',
  active: 'Live',
  rejected: 'Video rejected',
  archived: 'Archived',
};

export default function DropsPage() {
  const router = useRouter();
  const supabase = createClient();
  const [drops, setDrops] = useState<Drop[]>([]);
  const [handle, setHandle] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push('/auth/login');
        return;
      }

      const [{ data: profile }, { data: dropRows }] = await Promise.all([
        supabase.from('profiles').select('handle').eq('id', user.id).single(),
        supabase
          .from('drops')
          .select('id, title, slug, price_cents, inventory, status, created_at')
          .eq('seller_id', user.id)
          .order('created_at', { ascending: false }),
      ]);

      setHandle(profile?.handle ?? '');
      setDrops(dropRows ?? []);
      setIsLoading(false);
    };

    load();
  }, [supabase, router]);

  const dropUrl = (slug: string) =>
    `${window.location.origin}/@${handle}/${slug}`;

  const copyLink = async (drop: Drop) => {
    await navigator.clipboard.writeText(dropUrl(drop.slug));
    setCopiedId(drop.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const restock = async (drop: Drop) => {
    const answer = window.prompt(`New inventory for "${drop.title}"?`, '10');
    if (!answer) return;
    const inventory = parseInt(answer, 10);
    if (!Number.isFinite(inventory) || inventory < 1) return;

    const res = await fetch(`/api/drops/${drop.id}/restock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inventory }),
    });

    if (res.ok) {
      const data = await res.json();
      setDrops((ds) => ds.map((d) => (d.id === drop.id ? { ...d, inventory } : d)));
      if (data.waitlist_notified > 0) {
        window.alert(`Restocked! ${data.waitlist_notified} waitlisted buyer(s) notified.`);
      }
    }
  };

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">My Drops</h1>
          <a
            href="/dashboard/drops/new"
            className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
          >
            + New Drop
          </a>
        </div>

        {drops.length === 0 ? (
          <div className="mt-12 rounded-lg border border-dashed border-gray-300 bg-white p-12 text-center">
            <p className="text-gray-600">No drops yet. Create your first one!</p>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {drops.map((drop) => (
              <div
                key={drop.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-4"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-900">{drop.title}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[drop.status] ?? ''}`}
                    >
                      {statusLabels[drop.status] ?? drop.status}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-gray-600">
                    ${(drop.price_cents / 100).toFixed(2)} ·{' '}
                    {drop.inventory === 0 ? 'Sold out' : `${drop.inventory} in stock`}
                  </p>
                </div>

                <div className="flex gap-2">
                  {drop.status === 'active' && (
                    <>
                      <a
                        href={`/@${handle}/${drop.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        View
                      </a>
                      <button
                        onClick={() => copyLink(drop)}
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        {copiedId === drop.id ? 'Copied!' : 'Copy link'}
                      </button>
                      {drop.inventory === 0 && (
                        <button
                          onClick={() => restock(drop)}
                          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                        >
                          Restock
                        </button>
                      )}
                    </>
                  )}
                  {drop.status === 'rejected' && (
                    <span className="text-sm text-red-600">
                      Video failed or over 60s — create a new drop
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <a href="/dashboard" className="mt-8 inline-block text-sm text-blue-600 hover:text-blue-700">
          ← Back to dashboard
        </a>
      </div>
    </div>
  );
}
