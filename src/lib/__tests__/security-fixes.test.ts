import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { safeNextPath } from '../safe-redirect';
import { verifyEasyPostSignature } from '../easypost';

const BASE = 'https://drip.test/auth/callback?code=abc';

describe('safeNextPath (audit C-4.2: /auth/callback open redirect)', () => {
  it('keeps same-site paths, with query and hash', () => {
    expect(safeNextPath('/feed', BASE, '/onboarding')).toBe('/feed');
    expect(safeNextPath('/s/abc?x=1#top', BASE, '/onboarding')).toBe('/s/abc?x=1#top');
  });

  it('falls back when absent or empty', () => {
    expect(safeNextPath(null, BASE, '/onboarding')).toBe('/onboarding');
    expect(safeNextPath('', BASE, '/onboarding')).toBe('/onboarding');
  });

  it.each([
    'https://evil.example/',
    '//evil.example/',
    '/\\evil.example/',
    '\\\\evil.example',
    'javascript:alert(1)',
    '/\t/evil.example',
    '/\n/evil.example',
    'evil.example',
    '/' + 'a'.repeat(3000),
  ])('rejects %j', (next) => {
    expect(safeNextPath(next, BASE, '/onboarding')).toBe('/onboarding');
  });
});

describe('EasyPost webhook (audit C-4.1: fails open without a secret)', () => {
  const body = JSON.stringify({ id: 'evt_1', description: 'tracker.updated', result: { id: 't' } });
  const sign = (key: string) =>
    `hmac-sha256-hex=${crypto.createHmac('sha256', key).update(body, 'utf8').digest('hex')}`;

  it('never verifies against an empty key', () => {
    expect(verifyEasyPostSignature(body, sign(''), '')).toBe(false);
  });

  it('still verifies a correct signature and rejects a wrong one', () => {
    expect(verifyEasyPostSignature(body, sign('s3cret'), 's3cret')).toBe(true);
    expect(verifyEasyPostSignature(body, sign('other'), 's3cret')).toBe(false);
  });

  let original: string | undefined;
  beforeEach(() => {
    original = process.env.EASYPOST_WEBHOOK_SECRET;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.EASYPOST_WEBHOOK_SECRET;
    else process.env.EASYPOST_WEBHOOK_SECRET = original;
    vi.restoreAllMocks();
  });

  it('route refuses every request while the secret is unset, before touching the DB', async () => {
    delete process.env.EASYPOST_WEBHOOK_SECRET;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('@/app/api/webhooks/easypost/route');
    const res = await POST(
      new NextRequest('https://drip.test/api/webhooks/easypost', {
        method: 'POST',
        body,
        headers: { 'x-hmac-signature': sign('') },
      })
    );
    expect(res.status).toBe(503);
  });
});
