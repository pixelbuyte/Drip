export const metadata = { title: 'Prohibited Items — Drip' };

// Mirrors Stripe's Prohibited & Restricted Businesses list; listing any of
// these risks immediate account termination and Stripe account closure.
export default function ProhibitedItemsPage() {
  return (
    <article>
      <h1>Prohibited Items</h1>
      <p>
        The following may not be sold on Drip. Listings are reviewed and violations result in
        removal and account termination. This list mirrors Stripe's Prohibited &amp; Restricted
        Businesses policy — selling these would also get your payout account shut down.
      </p>

      <ul>
        <li>Illegal drugs, drug paraphernalia, CBD, tobacco, vaping products, and alcohol</li>
        <li>Weapons: firearms, ammunition, parts, knives marketed as weapons, explosives</li>
        <li>Adult content and services</li>
        <li>Counterfeit or unauthorized replica goods, bootlegs</li>
        <li>Stolen goods or items you don't have the right to sell</li>
        <li>Recalled, hazardous, or unsafe items</li>
        <li>Live animals</li>
        <li>Prescription drugs, medical devices, or items making medical claims</li>
        <li>Gift cards, currency, gambling, lottery tickets, raffles</li>
        <li>Anything requiring a license to sell that you don't hold</li>
      </ul>

      <p>
        See something that shouldn't be here? Every drop page has a <strong>Report</strong>{' '}
        link — reports go straight to our moderation queue.
      </p>
    </article>
  );
}
