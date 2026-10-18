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

/** Reads the process switch once, so call sites stay one-liners. */
export function governedRecallSuppressionEnabled(): boolean {
  return governedMemoryLifecycleEnabled(process.env.MEMORY_GOVERNANCE_LIFECYCLE);
}
