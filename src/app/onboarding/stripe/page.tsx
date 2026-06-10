'use client';

import { useEffect, useState } from 'react';

export default function StripeOnboardingPage() {
  const [isLoading, setIsLoading] = useState(false);

  const handleStartOnboarding = async () => {
    setIsLoading(true);
    try {
      // Step 2 will implement the Stripe Connect flow
      const response = await fetch('/api/stripe/onboarding/start', {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to start onboarding');
      }

      const data = await response.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      console.error('Onboarding error:', err);
      setIsLoading(false);
    }
  };

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
