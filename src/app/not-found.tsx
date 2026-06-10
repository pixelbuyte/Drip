export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md space-y-4 text-center">
        <div className="text-5xl">🔍</div>
        <h1 className="text-2xl font-bold text-gray-900">Drop not found</h1>
        <p className="text-gray-600">
          This drop may have been removed, or the link might be wrong.
        </p>
        <a
          href="/"
          className="inline-block rounded-lg bg-blue-600 px-6 py-2.5 font-medium text-white hover:bg-blue-700"
        >
          Go home
        </a>
      </div>
    </div>
  );
}
