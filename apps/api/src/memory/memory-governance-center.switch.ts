import { governedMemoryEnforcementEnabled } from './memory-authorization.helpers.js';
import { governedMemoryLifecycleEnabled } from './memory-governance-lifecycle.helpers.js';

/**
 * Phase 15 administration surface release switch.
 *
 * The center reads governed columns and exposes governed mutations, so it may be
 * enabled only after both the lifecycle and authorization boundaries are armed.
 * A code deploy alone never exposes the surface.
 */
export function memoryGovernanceCenterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const center =
    String(env.MEMORY_GOVERNANCE_CENTER ?? '')
      .trim()
      .toLowerCase() === 'enforce';
  return (
    center &&
    governedMemoryLifecycleEnabled(env.MEMORY_GOVERNANCE_LIFECYCLE) &&
    governedMemoryEnforcementEnabled(env.MEMORY_GOVERNANCE_ENFORCE)
  );
}
