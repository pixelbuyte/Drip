import { describe, expect, it } from 'vitest';
import { bucketValue } from '../bucket';

describe('bucketValue', () => {
  it('is deterministic: same anonId -> same value, every call', () => {
    const a = bucketValue('11111111-1111-1111-1111-111111111111');
    const b = bucketValue('11111111-1111-1111-1111-111111111111');
    expect(a).toBe(b);
  });

  it('is always in [0, 1)', () => {
    for (const id of ['a', 'b', 'c', '', 'x'.repeat(200), '11111111-1111-1111-1111-111111111111']) {
      const v = bucketValue(id);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('different anon ids usually land at different values', () => {
    const values = new Set<string>();
    for (let i = 0; i < 200; i++) {
      values.add(String(bucketValue(`viewer-${i}`)));
    }
    // Collisions on 32-bit hashes over 200 inputs should be effectively zero.
    expect(values.size).toBe(200);
  });

  it('spreads roughly uniformly across [0,1) over many inputs', () => {
    const buckets = new Array(10).fill(0);
    const n = 5000;
    for (let i = 0; i < n; i++) {
      const v = bucketValue(`anon-${i}`);
      buckets[Math.min(9, Math.floor(v * 10))] += 1;
    }
    // Loose bound: each decile should get roughly n/10, not concentrate.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(n / 10 - n * 0.05);
      expect(count).toBeLessThan(n / 10 + n * 0.05);
    }
  });

  it('a salt changes the bucket independently of the base anonId', () => {
    const id = '22222222-2222-2222-2222-222222222222';
    const unsalted = bucketValue(id);
    const salted = bucketValue(id, 'search_ranking');
    expect(salted).not.toBe(unsalted);
  });

  it('salt is deterministic too: same id + same salt -> same value', () => {
    const id = '33333333-3333-3333-3333-333333333333';
    const a = bucketValue(id, 'ranked_v2');
    const b = bucketValue(id, 'ranked_v2');
    expect(a).toBe(b);
  });
});
