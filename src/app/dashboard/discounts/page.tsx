'use client';

import { useEffect, useState } from 'react';

type Discount = {
  id: string;
  code: string;
  percent_off: number;
  active: boolean;
  created_at: string;
};

const inputClass =
  'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

export default function DiscountsPage() {
  const [discounts, setDiscounts] = useState<Discount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [percentOff, setPercentOff] = useState('');

  const load = async () => {
    const res = await fetch('/api/discounts');
    if (res.ok) {
      const data = await res.json();
      setDiscounts(data.discounts ?? []);
    }
    setIsLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCreating(true);
    setError(null);

    try {
      const res = await fetch('/api/discounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, percent_off: parseInt(percentOff, 10) }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create code');

      setCode('');
      setPercentOff('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeactivate = async (id: string) => {
    await fetch(`/api/discounts?id=${id}`, { method: 'DELETE' });
    await load();
  };

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-lg">
        <h1 className="text-2xl font-bold text-gray-900">Discount Codes</h1>
        <p className="mt-1 text-gray-600">
          Buyers enter these at checkout. Codes apply to all your drops.
        </p>

        <form onSubmit={handleCreate} className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
          {error && (
            <div className="mb-4 rounded-md bg-red-50 p-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-sm text-gray-700">Code</label>
              <input
                type="text"
                required
                minLength={3}
                maxLength={20}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                className={inputClass}
                placeholder="SAVE10"
              />
            </div>
            <div className="w-28">
              <label className="block text-sm text-gray-700">% off</label>
              <input
                type="number"
                required
                min="1"
                max="100"
                value={percentOff}
                onChange={(e) => setPercentOff(e.target.value)}
                className={inputClass}
                placeholder="10"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isCreating}
            className="mt-4 w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isCreating ? 'Creating...' : 'Create Code'}
          </button>
        </form>

        <div className="mt-6 space-y-2">
          {discounts.length === 0 && (
            <p className="text-center text-sm text-gray-500">No discount codes yet.</p>
          )}
          {discounts.map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-4"
            >
              <div>
                <span className={`font-mono font-semibold ${d.active ? 'text-gray-900' : 'text-gray-400 line-through'}`}>
                  {d.code}
                </span>
                <span className="ml-2 text-sm text-gray-600">{d.percent_off}% off</span>
              </div>
              {d.active ? (
                <button
                  onClick={() => handleDeactivate(d.id)}
                  className="text-sm text-red-600 hover:text-red-700"
                >
                  Deactivate
                </button>
              ) : (
                <span className="text-xs text-gray-400">Inactive</span>
              )}
            </div>
          ))}
        </div>

        <a href="/dashboard" className="mt-8 inline-block text-sm text-blue-600 hover:text-blue-700">
          ← Back to dashboard
        </a>
      </div>
    </div>
  );
}
