'use client';

import { createClient } from '@/lib/supabase';
import { US_STATES } from '@/lib/validation';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const inputClass =
  'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

export default function SettingsPage() {
  const router = useRouter();
  const supabase = createClient();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({
    name: '',
    street1: '',
    street2: '',
    city: '',
    state: '',
    zip: '',
  });

  useEffect(() => {
    const load = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push('/auth/login');
        return;
      }

      // from_address is on `seller_payments`, not `profiles` — profiles is
      // publicly readable and this is the seller's physical address.
      // maybeSingle: no row yet just means nothing has been saved.
      const { data: payments } = await supabase
        .from('seller_payments')
        .select('from_address')
        .eq('seller_id', user.id)
        .maybeSingle();

      if (payments?.from_address) {
        const a = payments.from_address;
        setForm({
          name: a.name ?? '',
          street1: a.street1 ?? '',
          street2: a.street2 ?? '',
          city: a.city ?? '',
          state: a.state ?? '',
          zip: a.zip ?? '',
        });
      }
      setIsLoading(false);
    };

    load();
  }, [supabase, router]);

  const set = (name: string, value: string) => {
    setForm((f) => ({ ...f, [name]: value }));
    setSaved(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    try {
      const res = await fetch('/api/settings/address', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          street2: form.street2 || undefined,
          country: 'US',
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-lg">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

        <form onSubmit={handleSubmit} className="mt-6 space-y-5">
          <fieldset className="rounded-lg border border-gray-200 bg-white p-4">
            <legend className="px-1 text-sm font-medium text-gray-900">Ship-from address</legend>
            <p className="mb-4 text-sm text-gray-600">
              Used as the return address on every shipping label. US addresses only.
            </p>

            {error && (
              <div className="mb-4 rounded-md bg-red-50 p-4">
                <p className="text-sm text-red-800">{error}</p>
              </div>
            )}
            {saved && (
              <div className="mb-4 rounded-md bg-green-50 p-4">
                <p className="text-sm text-green-800">Address saved!</p>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-700">Full name</label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Street address</label>
                <input
                  type="text"
                  required
                  value={form.street1}
                  onChange={(e) => set('street1', e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm text-gray-700">
                  Apt, suite, etc. <span className="text-gray-400">(optional)</span>
                </label>
                <input
                  type="text"
                  value={form.street2}
                  onChange={(e) => set('street2', e.target.value)}
                  className={inputClass}
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-1">
                  <label className="block text-sm text-gray-700">City</label>
                  <input
                    type="text"
                    required
                    value={form.city}
                    onChange={(e) => set('city', e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">State</label>
                  <select
                    required
                    value={form.state}
                    onChange={(e) => set('state', e.target.value)}
                    className={inputClass}
                  >
                    <option value="">--</option>
                    {US_STATES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-700">ZIP</label>
                  <input
                    type="text"
                    required
                    pattern="\d{5}(-\d{4})?"
                    value={form.zip}
                    onChange={(e) => set('zip', e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>
            </div>
          </fieldset>

          <button
            type="submit"
            disabled={isSaving}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save Address'}
          </button>
        </form>

        <a href="/dashboard" className="mt-8 inline-block text-sm text-blue-600 hover:text-blue-700">
          ← Back to dashboard
        </a>
      </div>
    </div>
  );
}
