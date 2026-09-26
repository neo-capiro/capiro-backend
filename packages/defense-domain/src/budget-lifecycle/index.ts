/**
 * Phase 8 Session 7 — Annual Defense Budget Cycle Controller and Defense Budget
 * Lifecycle Watcher domain.
 *
 * Control-plane/lifecycle automation only. Nothing here promotes a snapshot,
 * mutates canonical rows, takes production schedule ownership, or produces
 * funding amounts.
 */

export * from './types.js';
export * from './templates.js';
export * from './cycle.js';
export * from './classifier.js';
export * from './watcher.js';
export * from './ingestion-bridge.js';
export * from './signals.js';
export * from './progression.js';
export * from './health.js';
export * from './discovery/index.js';
export * from './schedule.js';
export * from './bundle/bundle-completeness.js';
export * from './coverage-inventory.js';
export * from './coverage-reconciliation.js';
