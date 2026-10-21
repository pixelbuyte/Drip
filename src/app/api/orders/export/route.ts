import { NextResponse } from 'next/server';
import { createServerClient_ } from '@/lib/supabase-server';

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV export of all the seller's orders (research must-have: sellers
// import these into Shopify, Notion, spreadsheets, etc).
export async function GET() {
  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { data: orders, error } = await supabase
    .from('orders')
    .select(
      // order_items replaced orders.drop_id (00007): one row per item, with the
      // title and variant snapshotted at purchase time.
      'id, created_at, buyer_name, buyer_email, shipping_address, amount_cents, total_cents, shipping_cents, status, tracking_code, order_items(title_snapshot, variant_snapshot, quantity)'
    )
    .eq('seller_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 });
  }

  const header = [
    'order_id',
    'date',
    'item',
    'buyer_name',
    'buyer_email',
    'ship_to_street',
    'ship_to_city',
    'ship_to_state',
    'ship_to_zip',
    'total_usd',
    'shipping_usd',
    'status',
    'tracking_code',
  ];

  const rows = (orders ?? []).map((o) => {
    const addr = (o.shipping_address ?? {}) as Record<string, string | null>;
    const item = (o.order_items ?? [])
      .map((i) => {
        const label = i.variant_snapshot ? `${i.title_snapshot} (${i.variant_snapshot})` : i.title_snapshot;
        return i.quantity > 1 ? `${label} x${i.quantity}` : label;
      })
      .join('; ');
    return [
      o.id,
      new Date(o.created_at).toISOString(),
      item,
      o.buyer_name,
      o.buyer_email,
      [addr.street1, addr.street2].filter(Boolean).join(' '),
      addr.city ?? '',
      addr.state ?? '',
      addr.zip ?? '',
      // total_cents is backfilled from amount_cents (00007); prefer it.
      ((o.total_cents || o.amount_cents || 0) / 100).toFixed(2),
      ((o.shipping_cents ?? 0) / 100).toFixed(2),
      o.status,
      o.tracking_code ?? '',
    ]
      .map(csvEscape)
      .join(',');
  });

  const csv = [header.join(','), ...rows].join('\n');

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="drip-orders-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
