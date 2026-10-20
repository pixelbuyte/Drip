import type { SupabaseClient } from '@supabase/supabase-js';

/** The body a client must send: `{ "confirm": "DELETE" }`. */
export const DELETE_CONFIRMATION = 'DELETE';

export type DeletionResult =
  | { ok: true }
  | { ok: false; reason: 'seller_has_orders' | 'failed' };

/**
 * Deletes an account (App Store guideline 5.1.1(v)).
 *
 * `profiles` cascades from `auth.users`, and `orders.seller_id` cascades from
 * `profiles` (00001_initial_schema.sql:3,37). Deleting a seller who has
 * received orders would therefore silently destroy those orders, paid and
 * unshipped ones included, and with them the buyers' only record. Such
 * accounts are refused here and closed by support once the orders settle.
 *
 * Everything else goes with the auth user:
 *   - profile, drops, videos, products, payouts row, follows of the seller:
 *     ON DELETE CASCADE from profiles;
 *   - orders the user placed as a buyer keep the seller's copy (needed for
 *     fulfilment, refunds and tax); `buyer_viewer_id` is SET NULL (00007:400);
 *   - device viewer identities are unlinked (`auth_user_id` SET NULL,
 *     00008:6), so on-device anonymous history no longer maps to a person.
 */
export async function deleteAccount(admin: SupabaseClient, userId: string): Promise<DeletionResult> {
  const { count, error: countError } = await admin
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('seller_id', userId);
  if (countError) {
    console.error('account deletion: order check failed:', countError);
    return { ok: false, reason: 'failed' };
  }
  if ((count ?? 0) > 0) return { ok: false, reason: 'seller_has_orders' };

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    console.error('account deletion: deleteUser failed:', error);
    return { ok: false, reason: 'failed' };
  }
  return { ok: true };
}
