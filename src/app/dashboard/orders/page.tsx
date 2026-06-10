'use client';

import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Order = {
  id: string;
  created_at: string;
  buyer_name: string;
  buyer_email: string;
  amount_cents: number;
  status: string;
  tracking_code: string | null;
  label_url: string | null;
  drops: { title: string } | { title: string }[] | null;
};

const statusStyles: Record<string, string> = {
  paid: 'bg-amber-100 text-amber-800',
  label_created: 'bg-blue-100 text-blue-800',
  shipped: 'bg-purple-100 text-purple-800',
  delivered: 'bg-green-100 text-green-800',
  refunded: 'bg-red-100 text-red-800',
};

const statusLabels: Record<string, string> = {
  paid: 'Paid — needs label',
  label_created: 'Label created',
  shipped: 'Shipped',
  delivered: 'Delivered',
  refunded: 'Refunded',
};

function dropTitle(o: Order): string {
  if (!o.drops) return '';
  return Array.isArray(o.drops) ? (o.drops[0]?.title ?? '') : o.drops.title;
}

export default function OrdersPage() {
  const router = useRouter();
  const supabase = createClient();
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      router.push('/auth/login');
      return;
    }

    const { data } = await supabase
      .from('orders')
      .select(
        'id, created_at, buyer_name, buyer_email, amount_cents, status, tracking_code, label_url, drops(title)'
      )
      .eq('seller_id', user.id)
      .order('created_at', { ascending: false });

    setOrders((data as Order[]) ?? []);
    setIsLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retryLabel = async (orderId: string) => {
    setRetryingId(orderId);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/retry-label`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Retry failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setRetryingId(null);
    }
  };

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">Orders</h1>
          {orders.length > 0 && (
            <a
              href="/api/orders/export"
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Export CSV
            </a>
          )}
        </div>

        {error && (
          <div className="mt-4 rounded-md bg-red-50 p-4">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {orders.length === 0 ? (
          <div className="mt-12 rounded-lg border border-dashed border-gray-300 bg-white p-12 text-center">
            <p className="text-gray-600">No orders yet. Share your drop links!</p>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {orders.map((order) => (
              <div
                key={order.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-gray-900">{dropTitle(order)}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[order.status] ?? ''}`}
                    >
                      {statusLabels[order.status] ?? order.status}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-gray-600">
                    {order.buyer_name || order.buyer_email} ·{' '}
                    ${(order.amount_cents / 100).toFixed(2)} ·{' '}
                    {new Date(order.created_at).toLocaleDateString()}
                  </p>
                  {order.tracking_code && (
                    <a
                      href={`https://tools.usps.com/go/TrackConfirmAction?tLabels=${order.tracking_code}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-block text-sm text-blue-600 hover:underline"
                    >
                      Track: {order.tracking_code}
                    </a>
                  )}
                </div>

                <div className="flex shrink-0 gap-2">
                  {order.label_url && (
                    <a
                      href={order.label_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      Print label
                    </a>
                  )}
                  {order.status === 'paid' && (
                    <button
                      onClick={() => retryLabel(order.id)}
                      disabled={retryingId === order.id}
                      className="rounded-lg border border-amber-400 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                    >
                      {retryingId === order.id ? 'Buying label...' : 'Buy label'}
                    </button>
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
