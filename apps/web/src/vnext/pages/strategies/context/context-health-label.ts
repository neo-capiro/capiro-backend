import type { ContextHealth } from '../../../../pages/strategy/types.js';
import type { ScopeBarStatus } from '../ScopeBar.js';

export function contextHealthStatus(health: ContextHealth | undefined, failed: boolean, loading: boolean, activeFacts?: number): ScopeBarStatus {
  if (loading) return { tone: 'gray', label: 'Checking context…' };
  if (failed || !health) return { tone: 'gray', label: 'Context health unavailable' };
  if (health.status === 'conflicted') return { tone: 'error', label: 'Conflicting information' };
  if (health.staleDocuments > 0) return { tone: 'warning', label: 'Sources need updating' };
  if (health.missingRequired.length > 0) return { tone: 'warning', label: 'Missing essential context' };
  if (health.assessment === 'not_assessed' || activeFacts === 0) return { tone: 'gray', label: 'Not assessed · extract facts to review' };
  return health.status === 'ok' ? { tone: 'success', label: 'Assessed · no material conflicts' } : { tone: 'warning', label: 'Needs review' };
}
