export type MemoryAutoLearnSkipReason =
  | 'disabled'
  | 'empty_user_message'
  | 'aborted'
  | 'compliance_refusal'
  | 'execution_error'
  | 'grounding_caveat'
  | 'no_source_message';

export type MemoryAutoLearnDecision =
  | { attempt: true }
  | { attempt: false; reason: MemoryAutoLearnSkipReason };

export interface MemoryAutoLearnTurn {
  enabled: boolean;
  userMessage: string;
  sourceMessageId?: string | null;
  aborted?: boolean;
  complianceRefusal?: boolean;
  executionError?: boolean;
  groundingSeverity?: string | null;
}

/**
 * Fail-closed preflight for post-turn learning. Assistant response text is
 * intentionally not an input: it may help an extractor understand context, but
 * it can never be the factual source of a persistent candidate.
 */
export function decideMemoryAutoLearn(turn: MemoryAutoLearnTurn): MemoryAutoLearnDecision {
  if (!turn.enabled) return { attempt: false, reason: 'disabled' };
  if (!turn.userMessage.trim()) return { attempt: false, reason: 'empty_user_message' };
  if (!turn.sourceMessageId) return { attempt: false, reason: 'no_source_message' };
  if (turn.aborted) return { attempt: false, reason: 'aborted' };
  if (turn.complianceRefusal) return { attempt: false, reason: 'compliance_refusal' };
  if (turn.executionError) return { attempt: false, reason: 'execution_error' };
  const severity = turn.groundingSeverity?.trim().toLowerCase();
  if (severity === 'high' || severity === 'critical') {
    return { attempt: false, reason: 'grounding_caveat' };
  }
  return { attempt: true };
}

/** Source excerpts must be exact, bounded substrings of the user-authored text. */
export function exactUserExcerpt(userMessage: string, candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  const excerpt = candidate.trim();
  if (!excerpt || excerpt.length > 4_000) return null;
  return userMessage.includes(excerpt) ? excerpt : null;
}
