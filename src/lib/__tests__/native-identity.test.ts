import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { bearerToken } from '../bearer';
import { ANON_TOKEN_HEADER, resolveSignedAnonId } from '../anon-request';
import { mintAnonId } from '../anon-id';
import { parseUuidList } from '../validation';

/**
 * The native app has no cookie jar shared with the proxy, so it authenticates
 * with `Authorization: Bearer` and carries its viewer identity in a header.
 * These tests pin the property that makes that safe: the header path trusts
 * exactly what the cookie path trusts, and nothing more.
 */

const VALID_SECRET = 'y'.repeat(48);
let original: string | undefined;
beforeEach(() => {
  original = process.env.ANON_ID_SECRET;
  process.env.ANON_ID_SECRET = VALID_SECRET;
});
afterEach(() => {
  if (original === undefined) delete process.env.ANON_ID_SECRET;
  else process.env.ANON_ID_SECRET = original;
});

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';

describe('bearerToken', () => {
  const h = (v?: string) => new Headers(v === undefined ? {} : { authorization: v });

  it('extracts a JWT-shaped bearer token', () => {
    expect(bearerToken(h(`Bearer ${JWT}`))).toBe(JWT);
    expect(bearerToken(h(`bearer   ${JWT}`))).toBe(JWT);
  });

  it('ignores absent, non-bearer, and malformed values', () => {
    expect(bearerToken(h())).toBeNull();
    expect(bearerToken(h(`Basic ${JWT}`))).toBeNull();
    expect(bearerToken(h('Bearer not-a-jwt'))).toBeNull();
    expect(bearerToken(h(`Bearer ${JWT} extra`))).toBeNull();
    expect(bearerToken(h(`Bearer ${'a'.repeat(3000)}.${'b'.repeat(1200)}.c`))).toBeNull();
  });
});

function request(init: { cookie?: string; token?: string; legacy?: string }) {
  const headers = new Headers();
  if (init.cookie) headers.set('cookie', `drip_aid=${init.cookie}`);
  if (init.token) headers.set(ANON_TOKEN_HEADER, init.token);
  if (init.legacy) headers.set('x-drip-anon-id', init.legacy);
  return new NextRequest('https://drip.test/api/events', { headers });
}

describe('resolveSignedAnonId', () => {
  it('accepts the signed cookie (browsers, unchanged)', async () => {
    const m = (await mintAnonId())!;
    expect(await resolveSignedAnonId(request({ cookie: m.cookieValue }))).toBe(m.anonId);
  });

  it('accepts the same signed value in the native header', async () => {
    const m = (await mintAnonId())!;
    expect(await resolveSignedAnonId(request({ token: m.cookieValue }))).toBe(m.anonId);
  });

  it('prefers the cookie when both are present', async () => {
    const a = (await mintAnonId())!;
    const b = (await mintAnonId())!;
    expect(await resolveSignedAnonId(request({ cookie: a.cookieValue, token: b.cookieValue })))
      .toBe(a.anonId);
  });

  it('never trusts an unsigned id, in either header', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(await resolveSignedAnonId(request({ token: id }))).toBeNull();
    expect(await resolveSignedAnonId(request({ legacy: id }))).toBeNull();
    expect(await resolveSignedAnonId(request({ token: `v1.${id}.forged` }))).toBeNull();
  });

  it('fails closed when the secret is unset', async () => {
    const m = (await mintAnonId())!;
    delete process.env.ANON_ID_SECRET;
    expect(await resolveSignedAnonId(request({ token: m.cookieValue }))).toBeNull();
  });
});

describe('POST /api/session/anon', () => {
  it('mints a token that the header path then verifies', async () => {
    const { POST } = await import('../../app/api/session/anon/route');
    const res = await POST(new NextRequest('https://drip.test/api/session/anon', {
      method: 'POST', headers: { 'x-forwarded-for': '203.0.113.7' },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(await resolveSignedAnonId(request({ token: body.token }))).toBe(body.anonId);
  });

  it('returns the same identity to a client that already holds one', async () => {
    const { POST } = await import('../../app/api/session/anon/route');
    const m = (await mintAnonId())!;
    const res = await POST(new NextRequest('https://drip.test/api/session/anon', {
      method: 'POST', headers: { [ANON_TOKEN_HEADER]: m.cookieValue },
    }));
    expect(await res.json()).toEqual({ anonId: m.anonId, token: m.cookieValue });
  });

  it('answers 503, not 500, when identity is unconfigured', async () => {
    delete process.env.ANON_ID_SECRET;
    const { POST } = await import('../../app/api/session/anon/route');
    const res = await POST(new NextRequest('https://drip.test/api/session/anon', {
      method: 'POST', headers: { 'x-forwarded-for': '203.0.113.8' },
    }));
    expect(res.status).toBe(503);
  });
});

describe('parseUuidList', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  it('parses, trims and de-duplicates', () => {
    expect(parseUuidList(` ${a},${b},${a} `, 10)).toEqual([a, b]);
  });
  it('treats absent as empty and rejects junk or oversize lists', () => {
    expect(parseUuidList(null, 10)).toEqual([]);
    expect(parseUuidList(`${a},nope`, 10)).toBeNull();
    expect(parseUuidList(`${a},${b}`, 1)).toBeNull();
  });
});

describe('createBearerClient', () => {
  it('verifies the pinned token when routes call auth.getUser() with no argument', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.test';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    const seen: Array<{ url: string; auth: string | null }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
      seen.push({ url, auth: headers.get('authorization') });
      return new Response(JSON.stringify({ id: 'u1', aud: 'authenticated', email: 'a@b.c' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { createBearerClient } = await import('../supabase-server');
      const client = createBearerClient(JWT);
      const { data } = await client.auth.getUser();
      expect(data.user?.id).toBe('u1');
      const call = seen.find((c) => c.url.endsWith('/auth/v1/user'));
      expect(call?.auth).toBe(`Bearer ${JWT}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('proxy', () => {
  it('does not mint a second identity for a native request carrying a signed token', async () => {
    const { proxy } = await import('../../proxy');
    const m = (await mintAnonId())!;
    const res = await proxy(new NextRequest('https://drip.test/api/feed?session_id=x', {
      headers: { [ANON_TOKEN_HEADER]: m.cookieValue },
    }));
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('mints for a cookie-less, token-less browser request', async () => {
    const { proxy } = await import('../../proxy');
    const res = await proxy(new NextRequest('https://drip.test/feed'));
    expect(res.headers.get('set-cookie')).toMatch(/^drip_aid=v1\./);
  });

  it('covers search, so a first visit there is not identity-less', async () => {
    const { config } = await import('../../proxy');
    expect(config.matcher).toEqual(expect.arrayContaining(['/search', '/api/search']));
  });
});
