import { buyLabel, type ShippingAddress } from './easypost';
import { sendSellerLabelEmail, sendBuyerConfirmation } from './emails';
import { getStripe } from './stripe';
import { createAdminClient } from './supabase-admin';

type AdminClient = ReturnType<typeof createAdminClient>;

export type FulfillResult = {
  ok: boolean;
  label_created: boolean;
  error?: string;
};

type OrderRow = {
  id: string;
  seller_id: string;
  stripe_session_id: string | null;
  buyer_email: string;
  buyer_name: string;
  shipping_address: ShippingAddress | null;
  amount_cents: number;
  shipping_cents: number;
  status: string;
  tracking_code: string | null;
  label_url: string | null;
  drop_id?: string | null;
};

type ItemInfo = {
  title: string;
  variantLabel: string | null;
  parcel: { length_in: number; width_in: number; height_in: number; weight_oz: number };
};

const PGRST_UNDEFINED_COLUMN = new Set(['PGRST204', '42703', 'PGRST100', '42P01']);

/**
 * SCHEMA-ADAPTIVE, same contract as the webhook that calls it: this code
 * deploys before the migration chain is applied to production, so it must
 * work against the legacy schema (orders.drop_id -> drops carries the title
 * and parcel dimensions) AND the migrated one (order_items carries the
 * title/variant snapshot; parcel dimensions come from the product's shipping
 * profile). The legacy select names drop_id explicitly, so it is attempted
 * second, only when the modern read comes back empty-handed.
 */
async function loadOrder(
  supabase: AdminClient,
  orderId: string
): Promise<{ order: OrderRow; modern: boolean } | null> {
  const modern = await supabase
    .from('orders')
    .select(
      'id, seller_id, stripe_session_id, buyer_email, buyer_name, shipping_address, amount_cents, shipping_cents, status, tracking_code, label_url'
    )
    .eq('id', orderId)
    .single();

  if (modern.error || !modern.data) return null;

  // Which world are we in? The legacy schema has orders.drop_id; asking for
  // it tells us. (A dedicated select rather than including it above, so the
  // main read never fails on either schema.)
  const probe = await supabase.from('orders').select('drop_id').eq('id', orderId).single();
  if (!probe.error && probe.data) {
    return {
      order: { ...(modern.data as OrderRow), drop_id: (probe.data as { drop_id: string | null }).drop_id },
      modern: false,
    };
  }
  if (probe.error && !PGRST_UNDEFINED_COLUMN.has(probe.error.code ?? '')) {
    console.error(`Order ${orderId}: drop_id probe failed unexpectedly:`, probe.error.message);
  }
  return { order: modern.data as OrderRow, modern: true };
}

/** Title, variant label and parcel dimensions for the order's item. */
async function loadItemInfo(
  supabase: AdminClient,
  order: OrderRow,
  modern: boolean
): Promise<ItemInfo | null> {
  if (!modern && order.drop_id) {
    const { data: drop } = await supabase
      .from('drops')
      .select('title, weight_oz, dimensions')
      .eq('id', order.drop_id)
      .single();
    if (!drop) return null;

    // Variant selection lives in the Checkout session metadata.
    let variantLabel: string | null = null;
    if (order.stripe_session_id) {
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
    }

    const dims = (drop.dimensions ?? {}) as Record<string, unknown>;
    return {
      title: drop.title,
      variantLabel,
      parcel: {
        length_in: Number(dims.length_in ?? 6),
        width_in: Number(dims.width_in ?? 6),
        height_in: Number(dims.height_in ?? 4),
        weight_oz: Number(drop.weight_oz) || 8,
      },
    };
  }

  // Migrated schema: the order_items snapshot is the source of truth for the
  // title/variant, and the product's shipping profile for the parcel.
  const { data: item } = await supabase
    .from('order_items')
    .select('title_snapshot, variant_snapshot, product_id')
    .eq('order_id', order.id)
    .limit(1)
    .maybeSingle();

  let parcel = { length_in: 6, width_in: 6, height_in: 4, weight_oz: 8 };
  if (item?.product_id) {
    const { data: product } = await supabase
      .from('products')
      .select('shipping_profile_id')
      .eq('id', item.product_id)
      .maybeSingle();
    if (product?.shipping_profile_id) {
      const { data: profile } = await supabase
        .from('shipping_profiles')
        .select('weight_oz, length_in, width_in, height_in')
        .eq('id', product.shipping_profile_id)
        .maybeSingle();
      if (profile) {
        parcel = {
          length_in: Number(profile.length_in ?? 6),
          width_in: Number(profile.width_in ?? 6),
          height_in: Number(profile.height_in ?? 4),
          weight_oz: Number(profile.weight_oz) || 8,
        };
      }
    }
  }

  return {
    title: item?.title_snapshot ?? 'Item',
    variantLabel: item?.variant_snapshot ?? null,
    parcel,
  };
}

// Buys the shipping label for a paid order and sends seller/buyer emails.
// Loads everything from the order row (+ order_items or the legacy drops
// row), so it works from the checkout webhook, the payment-intent webhook,
// and the dashboard "retry label" button.
// Never throws; label/email failures leave the order 'paid' for retry.
export async function fulfillOrder(
  supabase: AdminClient,
  orderId: string,
  opts: { sendBuyerEmail: boolean } = { sendBuyerEmail: true }
): Promise<FulfillResult> {
  try {
    const loaded = await loadOrder(supabase, orderId);
    if (!loaded) return { ok: false, label_created: false, error: 'Order not found' };
    const { order, modern } = loaded;

    if (order.status === 'refunded') {
      return { ok: false, label_created: false, error: 'Order was refunded' };
    }

    const [itemInfo, { data: seller }, { data: sellerPayments }, { data: sellerUser }] =
      await Promise.all([
        loadItemInfo(supabase, order, modern),
        // Identity and address are separate tables: from_address is on
        // `seller_payments`, not `profiles`, because profiles is publicly
        // readable and this is the seller's physical address. Do not move it back.
        supabase.from('profiles').select('handle, display_name').eq('id', order.seller_id).single(),
        supabase
          .from('seller_payments')
          .select('from_address')
          .eq('seller_id', order.seller_id)
          .maybeSingle(),
        supabase.auth.admin.getUserById(order.seller_id),
      ]);

    // `seller` needs its own check now that the address lives elsewhere — the
    // old guard narrowed it only as a side effect of reading from_address off it.
    if (!itemInfo || !seller || !sellerPayments?.from_address) {
      return { ok: false, label_created: false, error: 'Missing item or seller address' };
    }

    const emailData = {
      orderId: order.id,
      dropTitle: itemInfo.title,
      variantLabel: itemInfo.variantLabel,
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
        const bought = await buyLabel(
          sellerPayments.from_address,
          order.shipping_address,
          itemInfo.parcel
        );

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
