export type PersistedMemoryDecision = {
  input: {
    id: string;
    reviewRequestId: string;
    decision: 'approve' | 'reject' | 'request-changes' | 'resolve-conflict';
    resolution?:
      | 'duplicate'
      | 'corroborate_existing'
      | 'supersede_existing'
      | 'conflict_requires_review';
  };
  accepted: boolean;
  acceptedResult?: Record<string, unknown>;
};

const PREFIX = 'capiro:meri-memory-decision:v1:';

function key(scope: string, input: PersistedMemoryDecision['input']): string {
  return `${PREFIX}${encodeURIComponent(scope)}:${input.id}:${input.decision}:${input.resolution ?? 'none'}`;
}

export function readMemoryDecisionRecovery(scope: string): PersistedMemoryDecision | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const storageKey = sessionStorage.key(index);
      if (!storageKey?.startsWith(`${PREFIX}${encodeURIComponent(scope)}:`)) continue;
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as PersistedMemoryDecision;
      if (
        parsed?.input &&
        typeof parsed.input.id === 'string' &&
        typeof parsed.input.reviewRequestId === 'string' &&
        typeof parsed.input.decision === 'string' &&
        typeof parsed.accepted === 'boolean'
      ) {
        return parsed;
      }
    }
  } catch {
    // Storage may be unavailable or contain stale data; recovery remains user-driven.
  }
  return null;
}

export function writeMemoryDecisionRecovery(
  scope: string,
  recovery: PersistedMemoryDecision,
): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    clearMemoryDecisionRecovery(scope, recovery.input);
    sessionStorage.setItem(key(scope, recovery.input), JSON.stringify(recovery));
  } catch {
    // A visible in-memory lock still prevents an automatic replay in this mount.
  }
}

export function clearMemoryDecisionRecovery(
  scope: string,
  input: PersistedMemoryDecision['input'],
): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(key(scope, input));
  } catch {
    // Ignore unavailable storage.
  }
}
