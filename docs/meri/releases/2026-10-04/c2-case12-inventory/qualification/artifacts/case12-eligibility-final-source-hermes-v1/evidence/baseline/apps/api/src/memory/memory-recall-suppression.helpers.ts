import {
  governedRecallEligibilitySql,
  governedRecallSuppressionSql,
  TERMINAL_GOVERNED_STATUSES,
} from '@capiro/meriv2-core';
import { governedMemoryLifecycleEnabled } from './memory-governance-lifecycle.helpers.js';

/**
 * The memory_items suppression predicate and the terminal vocabulary are defined
 * ONCE, in packages/meriv2-core/src/memory/governance.ts, because
 * apps/meriv2-orchestrator reads memory_items directly too and a second copy of a
 * security predicate is a drift waiting to happen. Re-exported here so apps/api
 * call sites keep a single local import.
 */
export { governedRecallEligibilitySql, governedRecallSuppressionSql, TERMINAL_GOVERNED_STATUSES };
const SAFE_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Suppression predicate for a `clio_memory` read.
 *
 * clio_memory has NO governed_status column — and no status column at all — so
 * terminal state is unrepresentable there, yet clio IS the DEFAULT recall backing
 * (MEMORY_RECALL_SOURCE defaults to 'clio'). The only governed handle is the
 * memory_items projection written by MemoryIngestService.projectClioMemory, keyed
 * `type='note', slug='clio:'||id`, which the existing
 * memory_items_tenant_type_slug_unique index serves — so this adds no index.
 *
 * HONEST LIMITATION: projectClioMemory is best-effort and never throws. A clio row
 * with NO projection has nothing to suppress and therefore still recalls. This
 * predicate fails OPEN on the highest-traffic recall path; it is a real narrowing,
 * not a guarantee. Suppression today still also relies on physically deleting the
 * clio row (the forget/correct verbs and the cleanup outbox).
 */
export function governedClioSuppressionSql(enabled: boolean, alias = 'clio_memory'): string {
  if (!enabled) return '';
  if (!SAFE_ALIAS.test(alias)) {
    throw new Error(`governedClioSuppressionSql: unsafe alias ${JSON.stringify(alias)}`);
  }
  return `\n           AND NOT EXISTS (
             SELECT 1 FROM memory_items mi_sup
             WHERE mi_sup.tenant_id = ${alias}.tenant_id
               AND mi_sup.type = 'note'
               AND mi_sup.slug = 'clio:' || ${alias}.id::text
               AND NOT ${governedRecallEligibilitySql('mi_sup')}
           )`;
}

/** Reads the process switch once, so call sites stay one-liners. */
export function governedRecallSuppressionEnabled(): boolean {
  return governedMemoryLifecycleEnabled(process.env.MEMORY_GOVERNANCE_LIFECYCLE);
}
