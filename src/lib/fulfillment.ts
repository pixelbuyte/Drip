import { buyLabel } from './easypost';
import { sendSellerLabelEmail, sendBuyerConfirmation } from './emails';
import { getStripe } from './stripe';
import { createAdminClient } from './supabase-admin';

type AdminClient = ReturnType<typeof createAdminClient>;

export type FulfillResult = {
  ok: boolean;
  label_created: boolean;
  error?: string;
};

// Buys the shipping label for a paid order and sends seller/buyer emails.
// Loads everything from the order row + Stripe session, so it works both
// from the checkout webhook and the dashboard "retry label" button.
// Never throws; label/email failures leave the order 'paid' for retry.
export async function fulfillOrder(
  supabase: AdminClient,
  orderId: string,
  opts: { sendBuyerEmail: boolean } = { sendBuyerEmail: true }
): Promise<FulfillResult> {
  try {
    const { data: order } = await supabase
      .from('orders')
      .select(
        'id, drop_id, seller_id, stripe_session_id, buyer_email, buyer_name, shipping_address, amount_cents, shipping_cents, status, tracking_code, label_url'
      )
      .eq('id', orderId)
      .single();

    if (!order) return { ok: false, label_created: false, error: 'Order not found' };
    if (order.status === 'refunded') {
      return { ok: false, label_created: false, error: 'Order was refunded' };
    }

    const [{ data: drop }, { data: seller }, { data: sellerUser }] = await Promise.all([
      supabase
        .from('drops')
        .select('title, weight_oz, dimensions, slug')
        .eq('id', order.drop_id)
        .single(),
      supabase
        .from('profiles')
        .select('handle, display_name, from_address')
        .eq('id', order.seller_id)
        .single(),
      supabase.auth.admin.getUserById(order.seller_id),
    ]);

    if (!drop || !seller?.from_address) {
      return { ok: false, label_created: false, error: 'Missing drop or seller address' };
    }

    // Variant selection lives in the Checkout session metadata.
    let variantLabel: string | null = null;
    try {
      const session = await getStripe().checkout.sessions.retrieve(order.stripe_session_id);
      const raw = session.metadata?.drip_variant_selection;
      if (raw) {
        const selection = JSON.parse(raw);
        if (selection && typeof selection === 'object') {
          variantLabel = Object.values(selection).join(' / ') || null;
        }
      }
    } catch {
      // Metadata unavailable; emails just omit the variant suffix.
    }

    const emailData = {
      orderId: order.id,
      dropTitle: drop.title,
      variantLabel,
      amountCents: order.amount_cents,
      shippingCents: order.shipping_cents,
      buyerName: order.buyer_name,
      buyerEmail: order.buyer_email,
      shippingAddress: order.shipping_address,
      sellerDisplayName: seller.display_name,
      sellerHandle: seller.handle,
    };

    let label: {
      tracking_code: string;
      label_url: string;
      carrier: string;
      service: string;
    } | null = null;

    if (order.status === 'paid' && order.shipping_address) {
      try {
        const bought = await buyLabel(seller.from_address, order.shipping_address, {
          length_in: drop.dimensions?.length_in ?? 6,
          width_in: drop.dimensions?.width_in ?? 6,
          height_in: drop.dimensions?.height_in ?? 4,
          weight_oz: Number(drop.weight_oz) || 8,
        });

        await supabase
          .from('orders')
          .update({
            easypost_shipment_id: bought.shipment_id,
            tracking_code: bought.tracking_code,
            label_url: bought.label_url,
            status: 'label_created',
          })
          .eq('id', order.id);

        label = bought;
      } catch (labelErr) {
        console.error(`Label purchase failed for order ${order.id}:`, labelErr);
      }
    } else if (order.tracking_code && order.label_url) {
      // Label already exists (e.g. retry after a failed email).
      label = {
        tracking_code: order.tracking_code,
        label_url: order.label_url,
        carrier: 'USPS',
        service: '',
      };
    }

    const sellerEmail = sellerUser?.user?.email;
    if (sellerEmail && label) {
      await sendSellerLabelEmail(sellerEmail, emailData, label);
    }

    if (opts.sendBuyerEmail && order.buyer_email) {
      await sendBuyerConfirmation(
        emailData,
        label ? { tracking_code: label.tracking_code, carrier: label.carrier } : null
      );
    }

    return { ok: true, label_created: label !== null };
  } catch (err) {
    console.error(`Fulfillment failed for order ${orderId}:`, err);
    return { ok: false, label_created: false, error: 'Fulfillment failed' };
  }
}
