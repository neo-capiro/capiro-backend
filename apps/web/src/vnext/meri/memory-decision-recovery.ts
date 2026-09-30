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
};

const PREFIX = 'capiro:meri-memory-decision:v1:';

function key(scope: string, input: PersistedMemoryDecision['input']): string {
  return `${PREFIX}${encodeURIComponent(scope)}:${input.id}:${input.decision}:${input.resolution ?? 'none'}`;
}

const DECISIONS = new Set(['approve', 'reject', 'request-changes', 'resolve-conflict']);
const RESOLUTIONS = new Set([
  'duplicate',
  'corroborate_existing',
  'supersede_existing',
  'conflict_requires_review',
]);

function isPersistedMemoryDecision(value: unknown): value is PersistedMemoryDecision {
  if (!value || typeof value !== 'object') return false;
  const input = (value as { input?: unknown }).input;
  if (!input || typeof input !== 'object') return false;
  const candidate = input as Record<string, unknown>;
  const decisionIsValid =
    typeof candidate.decision === 'string' && DECISIONS.has(candidate.decision);
  const resolutionIsValid =
    candidate.decision === 'resolve-conflict'
      ? typeof candidate.resolution === 'string' && RESOLUTIONS.has(candidate.resolution)
      : candidate.resolution === undefined;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.reviewRequestId === 'string' &&
    candidate.reviewRequestId.length > 0 &&
    decisionIsValid &&
    resolutionIsValid
  );
}

export function readMemoryDecisionRecoveries(scope: string): PersistedMemoryDecision[] {
  if (typeof sessionStorage === 'undefined') return [];
  const recoveries: PersistedMemoryDecision[] = [];
  try {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const storageKey = sessionStorage.key(index);
      if (!storageKey?.startsWith(`${PREFIX}${encodeURIComponent(scope)}:`)) continue;
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (!raw) continue;
        const parsed: unknown = JSON.parse(raw);
        if (isPersistedMemoryDecision(parsed) && storageKey === key(scope, parsed.input)) {
          recoveries.push({ input: parsed.input });
        }
      } catch {
        // A malformed sibling entry must not hide other recoverable decisions.
      }
    }
  } catch {
    // Storage may be unavailable; return any entries already read.
  }
  return recoveries;
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
