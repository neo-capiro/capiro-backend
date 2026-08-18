/**
 * Budget-line intelligence classifiers — committee posture, procurement runway,
 * acquisition maturity, budget anomalies — and the `buildIntelligence` verdict
 * that combines them.
 *
 * Every file in this directory is a VERBATIM copy of its counterpart under
 * `apps/api/src/program-element/intelligence/`. They are pure (no Nest, no
 * Prisma, no I/O): the read service coerces Prisma Decimals to numbers and hands
 * plain rows in. They live here so `apps/defense-api` can serve
 * `GET /program-elements/:peCode/intelligence` with the SAME verdicts instead of
 * the reduced cache-only payload it previously returned.
 *
 * Kept byte-identical on purpose. The Session 3 parity suite imports both copies
 * and asserts identical verdicts over a fixture matrix, so an edit to either side
 * that is not mirrored fails a gate.
 */
export * from './committee-posture.js';
export * from './procurement-runway.js';
export * from './acquisition-maturity.js';
export * from './budget-anomaly.js';
export * from './build-intelligence.js';
export * from './bill-stage.js';
