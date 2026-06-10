import type { NextRequest } from 'next/server';

// Per-instance in-memory sliding window. On serverless this only bounds a
// single warm instance, so it's a abuse speed bump, not a hard guarantee —
// swap for Upstash/Redis when traffic justifies it.
const buckets = new Map<string, number[]>();
const MAX_BUCKETS = 10000;

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();

  if (buckets.size > MAX_BUCKETS) buckets.clear();

  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }

  hits.push(now);
  buckets.set(key, hits);
  return true;
}

export function clientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}
