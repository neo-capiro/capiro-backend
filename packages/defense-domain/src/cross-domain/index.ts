/**
 * Phase 8 Session 9 — cross-domain provider runtime domain.
 *
 * Pure logic only: deterministic provider selection, failure classification,
 * bounded deterministic retry, idempotency keys, concurrency gating and the audit
 * record shape. No HTTP, no AWS SDK, no database, no credential, no dollars.
 */

export * from './provider-selection.js';
export * from './provider-retry.js';
export * from './provider-audit.js';
