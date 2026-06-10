'use client';

import MuxUploader from '@mux/mux-uploader-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type VariantDimension = { name: string; options: string[] };

const inputClass =
  'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

export default function NewDropPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // null until the drop is created; then we show the uploader.
  const [uploadUrl, setUploadUrl] = useState<string | null>(null);
  const [uploadDone, setUploadDone] = useState(false);

  const [form, setForm] = useState({
    title: '',
    description: '',
    price: '',
    inventory: '',
    weight_oz: '',
    length_in: '',
    width_in: '',
    height_in: '',
  });
  const [variants, setVariants] = useState<VariantDimension[]>([]);

  const set = (name: string, value: string) => setForm((f) => ({ ...f, [name]: value }));

  const addVariant = () => {
    if (variants.length < 2) setVariants((v) => [...v, { name: '', options: [''] }]);
  };

  const updateVariant = (i: number, patch: Partial<VariantDimension>) => {
    setVariants((v) => v.map((dim, idx) => (idx === i ? { ...dim, ...patch } : dim)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const cleanedVariants = variants
        .map((dim) => ({
          name: dim.name.trim(),
          options: dim.options.map((o) => o.trim()).filter(Boolean),
        }))
        .filter((dim) => dim.name && dim.options.length > 0);

      const res = await fetch('/api/drops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          description: form.description || undefined,
          price_cents: Math.round(parseFloat(form.price) * 100),
          inventory: parseInt(form.inventory, 10),
          weight_oz: parseFloat(form.weight_oz),
          dimensions: {
            length_in: parseFloat(form.length_in),
            width_in: parseFloat(form.width_in),
            height_in: parseFloat(form.height_in),
          },
          variants: cleanedVariants.length > 0 ? cleanedVariants : undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create drop');

      setUploadUrl(data.upload_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Phase 2: video upload
  if (uploadUrl) {
    return (
      <div className="min-h-screen bg-gray-50 px-4 py-8">
        <div className="mx-auto max-w-lg space-y-6">
          <h1 className="text-2xl font-bold text-gray-900">Upload your video</h1>
          <p className="text-gray-600">
            Max 60 seconds, vertical works best. Your drop goes live automatically once the video
            finishes processing.
          </p>

          <MuxUploader
            endpoint={uploadUrl}
            onSuccess={() => setUploadDone(true)}
            onUploadError={() => setError('Upload failed. Please try again.')}
          />

          {error && (
            <div className="rounded-md bg-red-50 p-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {uploadDone && (
            <div className="space-y-4">
              <div className="rounded-md bg-green-50 p-4">
                <p className="text-sm text-green-800">
                  Upload complete! We're processing your video — your drop will go live in a minute
                  or two.
                </p>
              </div>
              <button
                onClick={() => router.push('/dashboard/drops')}
                className="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white hover:bg-blue-700"
              >
                Go to My Drops
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Phase 1: product details
  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-lg">
        <h1 className="text-2xl font-bold text-gray-900">Create a drop</h1>
        <p className="mt-1 text-gray-600">Product details first, then upload your video.</p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-5">
          {error && (
            <div className="rounded-md bg-red-50 p-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-900">Title</label>
            <input
              type="text"
              required
              maxLength={100}
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              className={inputClass}
              placeholder="Vintage denim jacket"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-900">
              Description <span className="text-gray-400">({280 - form.description.length} left)</span>
            </label>
            <textarea
              maxLength={280}
              rows={3}
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              className={inputClass}
              placeholder="Tell buyers what makes it special"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-900">Price (USD)</label>
              <input
                type="number"
                required
                min="1"
                step="0.01"
                value={form.price}
                onChange={(e) => set('price', e.target.value)}
                className={inputClass}
                placeholder="25.00"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-900">Inventory</label>
              <input
                type="number"
                required
                min="1"
                step="1"
                value={form.inventory}
                onChange={(e) => set('inventory', e.target.value)}
                className={inputClass}
                placeholder="10"
              />
            </div>
          </div>

          <fieldset className="rounded-lg border border-gray-200 p-4">
            <legend className="px-1 text-sm font-medium text-gray-900">Shipping package</legend>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-700">Weight (oz)</label>
                <input
                  type="number"
                  required
                  min="0.1"
                  step="0.1"
                  value={form.weight_oz}
                  onChange={(e) => set('weight_oz', e.target.value)}
                  className={inputClass}
                  placeholder="12"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Length (in)</label>
                <input
                  type="number"
                  required
                  min="0.1"
                  step="0.1"
                  value={form.length_in}
                  onChange={(e) => set('length_in', e.target.value)}
                  className={inputClass}
                  placeholder="10"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Width (in)</label>
                <input
                  type="number"
                  required
                  min="0.1"
                  step="0.1"
                  value={form.width_in}
                  onChange={(e) => set('width_in', e.target.value)}
                  className={inputClass}
                  placeholder="8"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Height (in)</label>
                <input
                  type="number"
                  required
                  min="0.1"
                  step="0.1"
                  value={form.height_in}
                  onChange={(e) => set('height_in', e.target.value)}
                  className={inputClass}
                  placeholder="4"
                />
              </div>
            </div>
          </fieldset>

          <fieldset className="rounded-lg border border-gray-200 p-4">
            <legend className="px-1 text-sm font-medium text-gray-900">
              Variants <span className="font-normal text-gray-400">(optional)</span>
            </legend>

            {variants.map((dim, i) => (
              <div key={i} className="mb-4 space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    maxLength={20}
                    value={dim.name}
                    onChange={(e) => updateVariant(i, { name: e.target.value })}
                    className={inputClass}
                    placeholder={i === 0 ? 'Size' : 'Color'}
                  />
                  <button
                    type="button"
                    onClick={() => setVariants((v) => v.filter((_, idx) => idx !== i))}
                    className="shrink-0 text-sm text-red-600 hover:text-red-700"
                  >
                    Remove
                  </button>
                </div>
                <input
                  type="text"
                  value={dim.options.join(',')}
                  onChange={(e) => updateVariant(i, { options: e.target.value.split(',') })}
                  className={inputClass}
                  placeholder="Comma-separated, e.g. S,M,L (max 5)"
                />
              </div>
            ))}

            {variants.length < 2 && (
              <button
                type="button"
                onClick={addVariant}
                className="text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                + Add {variants.length === 0 ? 'a variant (size, color...)' : 'another variant'}
              </button>
            )}
            <p className="mt-2 text-xs text-gray-500">
              All variants share the same price. Up to 2 dimensions, 5 options each.
            </p>
          </fieldset>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isSubmitting ? 'Creating...' : 'Continue to Video Upload'}
          </button>
        </form>
      </div>
    </div>
  );
}
