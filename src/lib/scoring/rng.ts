/**
 * A seeded PRNG, because v2's selector is stochastic and nothing in
 * src/lib/scoring may call Math.random.
 *
 * Two things depend on it. The offline simulation has to be reproducible — a
 * run that cannot be replayed byte-for-byte cannot be used to argue that a
 * weight change helped. And the softmax selector has to be unit-testable: a
 * test asserts an exact slice for an exact seed, which is impossible against a
 * global random source. So randomness, like the clock, is always an explicit
 * parameter.
 */

/** Returns a float in [0, 1). */
export type Rng = () => number;

/**
 * mulberry32 — 32-bit state, fast, and good enough for selection sampling
 * (it is not cryptographic and must never be used for anything security
 * bearing). Same seed, same sequence, on every platform.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
