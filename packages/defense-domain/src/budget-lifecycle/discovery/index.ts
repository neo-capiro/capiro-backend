/**
 * Phase 8 Session 8 — live official-source discovery domain.
 *
 * Pure logic only: robots policy, request pacing, sitemap and listing
 * extraction, GovInfo package URL algebra, and fail-closed candidate resolution.
 * No HTTP, no database, no funding amount, and no GPU dependency.
 */

export * from './robots.js';
export * from './rate-limit.js';
export * from './sitemap.js';
export * from './govinfo-packages.js';
export * from './listing-extract.js';
export * from './candidate-resolution.js';
export * from './crawl-cursor.js';
export * from './publisher-native-kinds.js';
export * from './expected-source-resolution.js';
