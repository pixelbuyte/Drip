// Step 8 of the build order, v2. NOTHING imports this at runtime yet — the
// ranker stays feature-flagged off until step 6 has produced real event data.
// See types.ts for why.
//
// This barrel is the module's whole public surface. Two invariants hold across
// every file it re-exports, and both are load-bearing for the offline
// simulation rather than stylistic:
//
//   1. Purity. No function here reads a clock or a global random source. Time
//      arrives as an explicit `now: Date`; randomness as an explicit
//      `Rng` (./rng). A run that cannot be replayed byte-for-byte cannot be
//      used to argue a weight change helped.
//   2. Rate signals are gated. Bayesian smoothing shrinks an estimate but not
//      your confidence in it, so every rate-based signal passes through
//      `evidenceGate` after smoothing and after 2.5x-category-median
//      normalisation. See normalize.ts.
//
// Ordered foundation-first: each group depends only on the groups above it.

// Foundation — vocabulary, determinism primitives, scalar maths.
export * from './types';
export * from './rng';
export * from './normalize';

// Signals — per-candidate scoring inputs and the composite score.
export * from './velocity';
export * from './signals';
export * from './score';

// Pipeline — pool in, ranked slice out.
export * from './candidates';
export * from './select';

// Viewer and session state feeding back into the pipeline.
export * from './affinity';
export * from './session';

// Measurement — the guardrails a simulation run is judged against.
export * from './guardrails';

// Adapters — the only impure-adjacent files here, and even these never throw
// on the request path: each loads its DB-backed config and falls back to a
// shipped default rather than failing the feed over a missing refinement.
export * from './medians';
export * from './weights';
