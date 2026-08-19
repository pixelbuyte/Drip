// Deterministic anon-id -> [0,1) bucketing for `feed_weights`' A/B rollout
// (see ./weights). The same viewer must land in the same variant on every
// request, or `traffic_share` isn't actually controlling exposure — it's
// reshuffling viewers between variants on every page load.
//
// Not cryptographic. This is a uniformity requirement (spread anon ids evenly
// across [0,1)), not a secrecy one — the anon id is already visible to the
// caller, and predicting a viewer's own bucket has no attack value. FNV-1a is
// small, dependency-free, and synchronous, which a Web Crypto digest is not
// (subtle.digest is async, and `bucketValue` is needed at the top of a
// request, not after an awaited hash).

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Deterministic 32-bit FNV-1a hash of a string. Exported beyond `bucketValue`
 * because `ranked-slice.ts` needs the same "string -> deterministic uint32"
 * primitive to seed `mulberry32` from a session id — same rationale, same
 * algorithm, no reason to duplicate it.
 */
export function fnv1a32(value: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    // Multiply by FNV_PRIME using Math.imul so it wraps at 32 bits like the
    // reference algorithm expects, rather than losing precision above 2^53.
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0; // unsigned
}

/**
 * `anonId` (optionally salted with a purpose string, so the same viewer can
 * be bucketed independently for unrelated experiments) -> a value in [0,1).
 * Pure and total: every input string produces a value, there is no failure
 * mode that needs a fallback.
 */
export function bucketValue(anonId: string, salt = ''): number {
  return fnv1a32(salt ? `${salt}:${anonId}` : anonId) / 0x100000000;
}
