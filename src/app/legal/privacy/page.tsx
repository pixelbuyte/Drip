export const metadata = { title: 'Privacy Policy — Drip' };

// TEMPLATE: review with an attorney before public launch.
export default function PrivacyPage() {
  return (
    <article>
      <h1>Privacy Policy</h1>
      <p className="text-sm text-gray-500">Last updated: June 2026</p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Sellers:</strong> email, name, handle, ship-from address. Identity and
          payout details are collected by Stripe, not stored by Drip.</li>
        <li><strong>Buyers:</strong> name, email, and shipping address — collected at checkout
          and shared with the seller to fulfill your order. Payment card details go directly to
          Stripe; Drip never sees them.</li>
        <li><strong>Waitlist:</strong> your email, used only to notify you about that product.</li>
        <li>Basic usage analytics (video views via Mux).</li>
      </ul>

      <h2>How we use it</h2>
      <p>
        To process orders, generate shipping labels (via EasyPost), send transactional emails
        (via Resend), and operate the service. We do not sell personal data or send marketing
        email without consent.
      </p>

      <h2>Service providers</h2>
      <p>Stripe (payments), Mux (video), EasyPost (shipping), Resend (email), Supabase
        (database/auth), Vercel (hosting).</p>

      <h2>Your choices</h2>
      <p>
        Email <strong>privacy@drip.app</strong> to request access to or deletion of your data.
        Order records may be retained as required for tax, accounting, and dispute purposes.
      </p>
    </article>
  );
}
