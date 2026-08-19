import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The regression these tests exist for:
 *
 * ANON_ID_SECRET was unset in the Vercel production project. anon-id.ts threw
 * on a missing secret, and src/proxy.ts mints an id on every route in its
 * matcher — including `/`. One unset variable therefore returned 500 for the
 * landing page, the auth pages, and every feed route: 13 middleware crashes
 * across 4 real visitors, with the site simply gone.
 *
 * The contract now under test is deliberately asymmetric:
 *   - AVAILABILITY fails open. Nothing throws; the site serves.
 *   - TRUST fails closed. With no key we cannot tell a real cookie from one a
 *     client typed by hand, so we accept neither.
 *
 * Both halves matter. Failing open on trust would be a worse bug than the
 * outage — it would let anyone assert any viewer identity by editing a cookie.
 */

const VALID_SECRET = 'x'.repeat(48);
let original: string | undefined;

// The module memoises its "already warned" flag, and reads process.env at call
// time rather than import time, so a plain re-import per case is enough.
async function load() {
  return import('../anon-id');
}

beforeEach(() => {
  original = process.env.ANON_ID_SECRET;
});

afterEach(() => {
  if (original === undefined) delete process.env.ANON_ID_SECRET;
  else process.env.ANON_ID_SECRET = original;
});

describe('with a configured secret', () => {
  beforeEach(() => {
    process.env.ANON_ID_SECRET = VALID_SECRET;
  });

  it('mints a signed id that verifies back to itself', async () => {
    const { mintAnonId, verifyAnonId } = await load();
    const minted = await mintAnonId();
    expect(minted).not.toBeNull();
    expect(await verifyAnonId(minted!.cookieValue)).toBe(minted!.anonId);
  });

  it('rejects a forged signature', async () => {
    const { mintAnonId, verifyAnonId } = await load();
    const minted = await mintAnonId();
    const [v, id] = minted!.cookieValue.split('.');
    expect(await verifyAnonId(`${v}.${id}.notarealsignature`)).toBeNull();
  });

  it('rejects a swapped payload under a valid-length signature', async () => {
    // The attack the HMAC exists to stop: keep a legitimate signature, swap the
    // uuid it was issued for. Length matches, so a naive length-only check
    // would pass this.
    const { mintAnonId, verifyAnonId } = await load();
    const a = await mintAnonId();
    const b = await mintAnonId();
    const forged = `v1.${b!.anonId}.${a!.cookieValue.split('.')[2]}`;
    expect(await verifyAnonId(forged)).toBeNull();
  });

  it('rejects malformed shapes without throwing', async () => {
    const { verifyAnonId } = await load();
    for (const bad of ['', 'garbage', 'v1.x', 'v2.a.b', 'v1..sig', 'v1.not-a-uuid.sig']) {
      expect(await verifyAnonId(bad)).toBeNull();
    }
  });

  it('salts the ip hash with the secret', async () => {
    const { hashIp } = await load();
    const withSecret = await hashIp('203.0.113.7');
    process.env.ANON_ID_SECRET = 'y'.repeat(48);
    const withOther = await hashIp('203.0.113.7');
    expect(withSecret).not.toBeNull();
    expect(withSecret!.equals(withOther!)).toBe(false);
  });
});

describe('with the secret missing — the outage case', () => {
  beforeEach(() => {
    delete process.env.ANON_ID_SECRET;
  });

  it('reports itself unconfigured rather than throwing', async () => {
    const { isAnonIdentityConfigured } = await load();
    expect(isAnonIdentityConfigured()).toBe(false);
  });

  it('mintAnonId resolves null instead of throwing', async () => {
    // This exact call, in src/proxy.ts, is what 500'd every request.
    const { mintAnonId } = await load();
    await expect(mintAnonId()).resolves.toBeNull();
  });

  it('signAnonId resolves null instead of throwing', async () => {
    const { signAnonId } = await load();
    await expect(signAnonId('11111111-2222-3333-4444-555555555555')).resolves.toBeNull();
  });

  it('hashIp resolves null rather than hashing with an empty salt', async () => {
    // The old code did `ip + (process.env.ANON_ID_SECRET ?? '')`. An unsalted
    // sha256 over the IPv4 space is brute-forceable in seconds, so that
    // fallback stored raw addresses with extra steps.
    const { hashIp } = await load();
    await expect(hashIp('203.0.113.7')).resolves.toBeNull();
  });

  it('verifyAnonId fails CLOSED — trusts nothing it cannot check', async () => {
    // Mint a genuinely valid cookie, then remove the key. The cookie is real,
    // but unverifiable is treated exactly like forged: no key, no trust.
    process.env.ANON_ID_SECRET = VALID_SECRET;
    const { mintAnonId } = await load();
    const minted = await mintAnonId();

    delete process.env.ANON_ID_SECRET;
    const { verifyAnonId } = await load();
    await expect(verifyAnonId(minted!.cookieValue)).resolves.toBeNull();
  });

  it('never throws for any entry point', async () => {
    // The whole point: no path out of this module can take a route down.
    const mod = await load();
    await expect(
      Promise.all([
        mod.mintAnonId(),
        mod.signAnonId('11111111-2222-3333-4444-555555555555'),
        mod.verifyAnonId('v1.11111111-2222-3333-4444-555555555555.sig'),
        mod.hashIp('203.0.113.7'),
      ])
    ).resolves.toBeDefined();
  });
});

describe('with a too-short secret', () => {
  it('treats under 32 chars as unconfigured, not as a weak key', async () => {
    // Accepting a 4-character HMAC key would be worse than accepting none:
    // it looks configured on the dashboard while being trivially forgeable.
    process.env.ANON_ID_SECRET = 'short';
    const { isAnonIdentityConfigured, mintAnonId } = await load();
    expect(isAnonIdentityConfigured()).toBe(false);
    await expect(mintAnonId()).resolves.toBeNull();
  });

  it('accepts exactly 32 chars', async () => {
    process.env.ANON_ID_SECRET = 'a'.repeat(32);
    const { isAnonIdentityConfigured } = await load();
    expect(isAnonIdentityConfigured()).toBe(true);
  });
});
