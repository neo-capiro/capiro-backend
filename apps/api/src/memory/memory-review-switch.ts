import { governedMemoryEnforcementEnabled } from './memory-authorization.helpers.js';
import { governedMemoryLifecycleEnabled } from './memory-governance-lifecycle.helpers.js';

/** Exact parser for the grant-aware review/withdrawal surface. Truthy-looking values stay off. */
export function clientMemoryReviewEnabled(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === 'enforce';
}

/**
 * The review and proposer-withdrawal UI is available only after the migration,
 * lifecycle, and canonical authorization paths are all explicitly armed.
 */
export function memoryReviewSurfaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    clientMemoryReviewEnabled(env.MEMORY_CLIENT_REVIEW) &&
    governedMemoryLifecycleEnabled(env.MEMORY_GOVERNANCE_LIFECYCLE) &&
    governedMemoryEnforcementEnabled(env.MEMORY_GOVERNANCE_ENFORCE)
  );
}
