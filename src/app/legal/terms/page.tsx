export const metadata = { title: 'Terms of Service — Drip' };

// TEMPLATE: review with an attorney before public launch.
export default function TermsPage() {
  return (
    <article>
      <h1>Terms of Service</h1>
      <p className="text-sm text-gray-500">Last updated: June 2026</p>

      <h2>1. What Drip is</h2>
      <p>
        Drip is a technology tool that lets sellers create video product listings and accept
        payments through their own Stripe account. <strong>Sellers are the merchant of record
        for their sales.</strong> Drip is not a marketplace, does not take ownership of items,
        and is not a party to the transaction between seller and buyer.
      </p>

      <h2>2. Seller obligations</h2>
      <ul>
        <li>You must be 18 or older and complete Stripe identity verification.</li>
        <li>You are solely responsible for the accuracy of your listings, fulfilling orders
          promptly, and the quality and legality of the items you sell.</li>
        <li>
          <strong>Taxes:</strong> you are responsible for determining, collecting, and remitting
          any sales tax or other taxes that apply to your sales. Drip does not collect or remit
          taxes on your behalf.
        </li>
        <li>You may not list anything on our <a href="/legal/prohibited-items">Prohibited
          Items</a> list.</li>
        <li>Chargebacks and refunds on your sales are your responsibility; Drip may recover
          associated amounts and fees from your connected account.</li>
      </ul>

      <h2>3. Buyers</h2>
      <p>
        Purchases are made from the seller, not from Drip. Refund and return questions go to
        the seller. US shipping addresses only; all prices in USD.
      </p>

      <h2>4. Content & DMCA</h2>
      <p>
        Sellers retain ownership of uploaded videos but grant Drip a license to host, stream,
        and display them. You must own or have rights to all content you upload.
      </p>
      <p>
        If you believe content on Drip infringes your copyright, send a takedown notice under
        17 U.S.C. §512(c) to our designated agent at{' '}
        <strong>dmca@drip.app</strong> including: identification of the work, the infringing
        URL, your contact information, a good-faith statement, and a statement under penalty
        of perjury that you are authorized to act. We will remove infringing content and
        terminate repeat infringers.
      </p>

      <h2>5. Termination</h2>
      <p>
        We may suspend or terminate accounts that violate these terms, list prohibited items,
        accumulate excessive disputes, or harm buyers or the platform.
      </p>

      <h2>6. Disclaimers</h2>
      <p>
        Drip is provided "as is". To the maximum extent permitted by law, Drip disclaims all
        warranties and limits its liability to the fees you paid Drip in the past 12 months.
      </p>
    </article>
  );
}
