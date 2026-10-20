import { memoryGovernanceSelectedForCurrentTenant } from './memory-governance-tenant-scope.js';

export {
  MEMORY_PERMISSIONS,
  evaluateGovernedMemoryAuthorization,
} from './memory-authorization.policy.js';
export type {
  MemoryPermission,
  MemoryOperation,
  MemoryAuthorizationSubject,
  MemoryAuthorizationFacts,
  MemoryAuthorizationDecision,
} from './memory-authorization.policy.js';

/**
 * Arms governed-memory authority enforcement only for an authenticated tenant
 * selected by `MEMORY_GOVERNANCE_TENANTS` (or the explicit GA value `all`).
 *
 * The exact `enforce` parser remains fail closed. A background/operator path
 * without tenant request scope can be armed only by `all`. This keeps lifecycle
 * and authority on the same internal-tenant canary and prevents a global ceiling
 * change from altering every tenant's reviewer/grant behavior.
 */
export function governedMemoryEnforcementEnabled(raw: string | undefined): boolean {
  return (
    String(raw ?? '')
      .trim()
      .toLowerCase() === 'enforce' &&
    memoryGovernanceSelectedForCurrentTenant(process.env.MEMORY_GOVERNANCE_TENANTS)
  );
}
