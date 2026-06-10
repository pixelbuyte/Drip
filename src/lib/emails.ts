import { Resend } from 'resend';

let resendClient: Resend | null = null;

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

const FROM = process.env.RESEND_FROM_EMAIL ?? 'Drip <onboarding@resend.dev>';

// Best-effort sender: email failures are logged, never thrown — a missing
// email must not fail order/label processing.
async function send(to: string, subject: string, html: string) {
  const resend = getResend();
  if (!resend) {
    console.warn(`RESEND_API_KEY not set; skipping email "${subject}" to ${to}`);
    return;
  }
  try {
    await resend.emails.send({ from: FROM, to, subject, html });
  } catch (err) {
    console.error(`Failed to send "${subject}" to ${to}:`, err);
  }
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type OrderEmailData = {
  orderId: string;
  dropTitle: string;
  variantLabel?: string | null;
  amountCents: number;
  shippingCents: number;
  buyerName: string;
  buyerEmail: string;
  shippingAddress: {
    name?: string | null;
    street1?: string | null;
    street2?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
  } | null;
  sellerDisplayName: string;
  sellerHandle: string;
};

function addressHtml(a: OrderEmailData['shippingAddress']): string {
  if (!a) return '<p>No address on file</p>';
  return `<p>${[a.name, a.street1, a.street2, `${a.city}, ${a.state} ${a.zip}`]
    .filter(Boolean)
    .join('<br/>')}</p>`;
}

export async function sendSellerLabelEmail(
  sellerEmail: string,
  order: OrderEmailData,
  label: { tracking_code: string; label_url: string; carrier: string; service: string }
) {
  const item = order.variantLabel
    ? `${order.dropTitle} (${order.variantLabel})`
    : order.dropTitle;

  await send(
    sellerEmail,
    `🎉 New sale: ${item} — label inside`,
    `
    <h2>You made a sale!</h2>
    <p><strong>${order.buyerName || order.buyerEmail}</strong> bought <strong>${item}</strong> for ${money(order.amountCents)}.</p>
    <p><a href="${label.label_url}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Print shipping label (PDF)</a></p>
    <p>Carrier: ${label.carrier} ${label.service} · Tracking: ${label.tracking_code}</p>
    <hr/>
    <h3>Packing slip</h3>
    <table cellpadding="6" style="border-collapse:collapse;border:1px solid #ddd">
      <tr><td><strong>Order</strong></td><td>${order.orderId.slice(0, 8)}</td></tr>
      <tr><td><strong>Item</strong></td><td>${item}</td></tr>
      <tr><td><strong>Total</strong></td><td>${money(order.amountCents)} (incl. ${money(order.shippingCents)} shipping)</td></tr>
      <tr><td><strong>Ship to</strong></td><td>${addressHtml(order.shippingAddress)}</td></tr>
    </table>
    <p style="color:#888;font-size:12px">Powered by Drip</p>
    `
  );
}

export async function sendBuyerConfirmation(
  order: OrderEmailData,
  tracking: { tracking_code: string; carrier: string } | null
) {
  const item = order.variantLabel
    ? `${order.dropTitle} (${order.variantLabel})`
    : order.dropTitle;

  await send(
    order.buyerEmail,
    `Order confirmed: ${item}`,
    `
    <h2>Thanks for your order!</h2>
    <p>You bought <strong>${item}</strong> from <strong>@${order.sellerHandle}</strong> for ${money(order.amountCents)}.</p>
    ${
      tracking
        ? `<p>Tracking number: <strong>${tracking.tracking_code}</strong> (${tracking.carrier}). We'll email you when it's delivered.</p>`
        : `<p>You'll get a tracking number as soon as your order ships.</p>`
    }
    <h3>Shipping to</h3>
    ${addressHtml(order.shippingAddress)}
    <p style="color:#888;font-size:12px">Sold by ${order.sellerDisplayName} · Powered by Drip</p>
    `
  );
}

export async function sendBuyerDelivered(
  buyerEmail: string,
  dropTitle: string,
  sellerHandle: string
) {
  await send(
    buyerEmail,
    `Delivered: ${dropTitle}`,
    `
    <h2>Your order was delivered! 📦</h2>
    <p><strong>${dropTitle}</strong> from <strong>@${sellerHandle}</strong> has arrived.</p>
    <p style="color:#888;font-size:12px">Powered by Drip</p>
    `
  );
}

export async function sendBackInStock(
  email: string,
  dropTitle: string,
  dropUrl: string,
  sellerHandle: string
) {
  await send(
    email,
    `Back in stock: ${dropTitle}`,
    `
    <h2>It's back! 🔥</h2>
    <p><strong>${dropTitle}</strong> from <strong>@${sellerHandle}</strong> is back in stock — but it won't last.</p>
    <p><a href="${dropUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Buy it now</a></p>
    <p style="color:#888;font-size:12px">You're getting this because you joined the waitlist. Powered by Drip</p>
    `
  );
}
