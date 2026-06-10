'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type OnboardingStatus = {
  connected: boolean;
  charges_enabled: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  requirements: string[];
  disabled_reason?: string | null;
};

// Human-readable labels for common Stripe requirement keys.
function formatRequirement(req: string): string {
  const labels: Record<string, string> = {
    'individual.verification.document': 'Identity document',
    'external_account': 'Bank account for payouts',
    'tos_acceptance.date': 'Stripe terms acceptance',
    'individual.ssn_last_4': 'SSN (last 4 digits)',
    'individual.dob.day': 'Date of birth',
    'individual.address.line1': 'Home address',
  };
  return labels[req] ?? req.replace(/[._]/g, ' ');
}

export default function StripeReturnPage() {
  const router = useRouter();
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRedirecting, setIsRedirecting] = useState(false);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch('/api/stripe/onboarding/status');
        if (!res.ok) throw new Error('Status check failed');
        const data: OnboardingStatus = await res.json();
        setStatus(data);

        if (data.charges_enabled) {
          setTimeout(() => router.push('/dashboard'), 1500);
        }
      } catch {
        setError('Could not verify your Stripe account status. Please try again.');
      }
    };

    checkStatus();
  }, [router]);

  const handleContinueOnboarding = async () => {
    setIsRedirecting(true);
    try {
      const res = await fetch('/api/stripe/onboarding/start', { method: 'POST' });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error();
      }
    } catch {
      setError('Could not restart onboarding. Please try again.');
      setIsRedirecting(false);
    }
  };

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-md space-y-4 text-center">
          <p className="text-red-600">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-600">Checking your Stripe account...</p>
      </div>
    );
  }

  if (status.charges_enabled) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-md space-y-4 text-center">
          <div className="text-5xl">🎉</div>
          <h1 className="text-2xl font-bold text-gray-900">You're ready to sell!</h1>
          <p className="text-gray-600">
            Your payout account is verified. Taking you to your dashboard...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md space-y-6 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Almost there</h1>
        <p className="text-gray-600">
          Stripe still needs a few things before you can accept payments
          {status.disabled_reason ? ` (${status.disabled_reason.replace(/_/g, ' ')})` : ''}:
        </p>

        {status.requirements.length > 0 && (
          <ul className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-left text-sm text-amber-900">
            {status.requirements.map((req) => (
              <li key={req} className="py-1">
                • {formatRequirement(req)}
              </li>
            ))}
          </ul>
        )}

        <button
          onClick={handleContinueOnboarding}
          disabled={isRedirecting}
          className="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isRedirecting ? 'Redirecting...' : 'Continue Stripe Setup'}
        </button>

        <p className="text-sm text-gray-500">
          Verification can take a few minutes after submitting. Refresh this page to re-check.
        </p>
      </div>
    </div>
  );
}
