'use client';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md space-y-4 text-center">
        <div className="text-5xl">😵</div>
        <h1 className="text-2xl font-bold text-gray-900">Something went wrong</h1>
        <p className="text-gray-600">An unexpected error occurred. Please try again.</p>
        <button
          onClick={reset}
          className="rounded-lg bg-blue-600 px-6 py-2.5 font-medium text-white hover:bg-blue-700"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
