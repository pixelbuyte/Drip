import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deleteAccount } from '../account-deletion';

/** Minimal admin-client double: orders count + auth.admin.deleteUser. */
function admin(opts: { orders?: number; countError?: boolean; deleteError?: boolean }) {
  const deleteUser = vi.fn(async () => ({ error: opts.deleteError ? { message: 'boom' } : null }));
  const eq = vi.fn(async () => ({
    count: opts.orders ?? 0,
    error: opts.countError ? { message: 'db down' } : null,
  }));
  const client = {
    from: vi.fn(() => ({ select: vi.fn(() => ({ eq })) })),
    auth: { admin: { deleteUser } },
  } as unknown as SupabaseClient;
  return { client, deleteUser, eq };
}

describe('deleteAccount', () => {
  it('deletes a buyer (no seller orders)', async () => {
    const a = admin({ orders: 0 });
    expect(await deleteAccount(a.client, 'u1')).toEqual({ ok: true });
    expect(a.eq).toHaveBeenCalledWith('seller_id', 'u1');
    expect(a.deleteUser).toHaveBeenCalledWith('u1');
  });

  it('refuses a seller with orders, without deleting anything', async () => {
    const a = admin({ orders: 3 });
    expect(await deleteAccount(a.client, 'u1')).toEqual({ ok: false, reason: 'seller_has_orders' });
    expect(a.deleteUser).not.toHaveBeenCalled();
  });

  it('fails closed when the order check errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = admin({ countError: true });
    expect(await deleteAccount(a.client, 'u1')).toEqual({ ok: false, reason: 'failed' });
    expect(a.deleteUser).not.toHaveBeenCalled();
  });

  it('reports a failed auth deletion', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = admin({ deleteError: true });
    expect(await deleteAccount(a.client, 'u1')).toEqual({ ok: false, reason: 'failed' });
  });
});
