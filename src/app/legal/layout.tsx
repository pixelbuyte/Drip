export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white px-4 py-12">
      <div className="prose mx-auto max-w-2xl prose-headings:text-gray-900 prose-p:text-gray-700">
        {children}
        <hr className="my-8" />
        <p className="text-sm text-gray-500">
          <a href="/legal/terms">Terms of Service</a> ·{' '}
          <a href="/legal/privacy">Privacy Policy</a> ·{' '}
          <a href="/legal/prohibited-items">Prohibited Items</a> ·{' '}
          <a href="/">Drip home</a>
        </p>
      </div>
    </div>
  );
}
