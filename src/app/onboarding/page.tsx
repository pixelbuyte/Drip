'use client';

import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { z } from 'zod';

const profileSchema = z.object({
  handle: z
    .string()
    .min(3, 'Handle must be at least 3 characters')
    .max(30, 'Handle must be at most 30 characters')
    .regex(/^[a-z0-9_]+$/, 'Handle can only contain lowercase letters, numbers, and underscores'),
  display_name: z
    .string()
    .min(1, 'Display name is required')
    .max(50, 'Display name must be at most 50 characters'),
});

type ProfileForm = z.infer<typeof profileSchema>;

export default function OnboardingPage() {
  const router = useRouter();
  const supabase = createClient();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<ProfileForm>({
    handle: '',
    display_name: '',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      // Validate form
      const validated = profileSchema.parse(formData);

      // Get current user
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        throw new Error('Not authenticated');
      }

      // Create profile
      const { error: profileError } = await supabase.from('profiles').insert({
        id: user.id,
        handle: validated.handle,
        display_name: validated.display_name,
      });

      if (profileError) {
        if (profileError.code === '23505') {
          throw new Error('Handle is already taken');
        }
        throw profileError;
      }

      // Redirect to Stripe onboarding
      router.push('/onboarding/stripe');
    } catch (err) {
      if (err instanceof z.ZodError) {
        setError(err.errors[0].message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('An error occurred');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold">Set up your profile</h1>
          <p className="mt-2 text-sm text-gray-600">Choose your seller handle and display name</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="rounded-md bg-red-50 p-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          <div>
            <label htmlFor="handle" className="block text-sm font-medium text-gray-900">
              Handle (@username)
            </label>
            <input
              id="handle"
              name="handle"
              type="text"
              required
              value={formData.handle}
              onChange={handleChange}
              className="mt-2 block w-full rounded-lg border border-gray-300 px-4 py-2 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="my_handle"
            />
            <p className="mt-1 text-xs text-gray-500">
              This will be your public URL: drip.app/@your_handle
            </p>
          </div>

          <div>
            <label htmlFor="display_name" className="block text-sm font-medium text-gray-900">
              Display Name
            </label>
            <input
              id="display_name"
              name="display_name"
              type="text"
              required
              value={formData.display_name}
              onChange={handleChange}
              className="mt-2 block w-full rounded-lg border border-gray-300 px-4 py-2 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Your Name"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isLoading ? 'Setting up...' : 'Continue to Stripe'}
          </button>
        </form>
      </div>
    </div>
  );
}
