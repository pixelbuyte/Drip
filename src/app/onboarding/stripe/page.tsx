'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function StripeOnboardingPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Already verified? Skip straight to the dashboard.
    const checkStatus = async () => {
      try {
        const res = await fetch('/api/stripe/onboarding/status');
        if (res.ok) {
          const data = await res.json();
          if (data.charges_enabled) {
            router.push('/dashboard');
            return;
          }
        }
      } catch {
        // Fall through to the onboarding CTA.
      }
      setIsChecking(false);
    };

    checkStatus();
  }, [router]);

  const handleStartOnboarding = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/stripe/onboarding/start', {
        method: 'POST',
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to start onboarding');
      }

      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setIsLoading(false);
    }
  };

  if (isChecking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md space-y-8 text-center">
        <div>
          <h1 className="text-3xl font-bold">Connect your payout account</h1>
          <p className="mt-2 text-gray-600">
            To start selling, we need to set up Stripe for your payouts. This process takes just a
            few minutes.
          </p>
        </div>

        {error && (
          <div className="rounded-md bg-red-50 p-4">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        <button
          onClick={handleStartOnboarding}
          disabled={isLoading}
          className="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isLoading ? 'Redirecting...' : 'Start Stripe Onboarding'}
        </button>

        <p className="text-sm text-gray-600">
          You'll be redirected to Stripe to complete your account setup. You'll return here when
          done.
        </p>
      </div>
    </div>
  );
}
