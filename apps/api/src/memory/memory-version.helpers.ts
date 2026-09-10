export const MEMORY_VERSION_KINDS = [
  'correction',
  'restore',
  'contradiction',
  // Phase 27D: a governed decision on a learning-signal-derived candidate
  // that already carries Phase 27C's contradictsMemoryItemId/conflictStatus
  // lineage against active memory. Never reachable through parsePayload/
  // insertCandidate (those still only ever see the original three kinds) —
  // only ImmutableMemoryVersionService.decideLearningSignalCandidate
  // constructs a version row with this kind, and it never calls
  // classifyMemoryVersionActivation (the reviewer picks the outcome
  // explicitly instead of the text-diff auto-classifier).
  'learning_signal',
] as const;
export type MemoryVersionKind = (typeof MEMORY_VERSION_KINDS)[number];

/**
 * Phase 27D — the governed outcomes a human reviewer may pick for a
 * learning-signal-derived MemoryCandidate that Phase 27C flagged with an
 * open conflict against active memory (contradictsMemoryItemId set,
 * conflictStatus='open'). `approve_new` and `reject` are handled entirely
 * by the existing MemoryCandidateService.approve()/reject() — they never
 * reach ImmutableMemoryVersionService — so LEARNING_SIGNAL_CONFLICT_RESOLUTIONS
 * below is the narrower set ImmutableMemoryVersionService.
 * decideLearningSignalCandidate actually implements.
 */
export const LEARNING_SIGNAL_GOVERNANCE_DECISIONS = [
  'approve_new',
  'reject',
  'duplicate',
  'corroborate_existing',
  'supersede_existing',
  'conflict_requires_review',
] as const;
export type LearningSignalGovernanceDecision =
  (typeof LEARNING_SIGNAL_GOVERNANCE_DECISIONS)[number];

export function isLearningSignalGovernanceDecision(
  value: unknown,
): value is LearningSignalGovernanceDecision {
  return (LEARNING_SIGNAL_GOVERNANCE_DECISIONS as readonly unknown[]).includes(value);
}

export const LEARNING_SIGNAL_CONFLICT_RESOLUTIONS = [
  'duplicate',
  'corroborate_existing',
  'supersede_existing',
  'conflict_requires_review',
] as const;
export type LearningSignalConflictResolution =
  (typeof LEARNING_SIGNAL_CONFLICT_RESOLUTIONS)[number];

export function isLearningSignalConflictResolution(
  value: unknown,
): value is LearningSignalConflictResolution {
  return (LEARNING_SIGNAL_CONFLICT_RESOLUTIONS as readonly unknown[]).includes(value);
}

export type MemoryCandidateKind =
  | 'standard'
  | 'correction'
  | 'restore'
  | 'contradiction'
  | 'learning_signal_conflict';

const VERSION_SOURCE_KIND_TO_CANDIDATE_KIND: Record<string, MemoryCandidateKind> = {
  memory_correction: 'correction',
  memory_restore: 'restore',
  memory_contradiction: 'contradiction',
};

export function candidateKindForSource(sourceKind: string): MemoryCandidateKind {
  return VERSION_SOURCE_KIND_TO_CANDIDATE_KIND[sourceKind] ?? 'standard';
}

/**
 * Phase 27D-aware kind classifier — pure, dependency-free (this module has no
 * service/Prisma imports) so both memory-candidate-review.service.ts and
 * memory-review-workflow.service.ts can share it without creating the
 * circular import those two files would otherwise have between them. A
 * learning_signal-sourced candidate routes to governed conflict resolution
 * only when Phase 27C actually flagged an open conflict on THIS candidate;
 * a learning_signal candidate without that flag is still 'standard' — there
 * is nothing for governance to resolve.
 */
export function candidateKindFor(input: {
  sourceKind: string;
  contradictsMemoryItemId: string | null;
  conflictStatus: string | null;
}): MemoryCandidateKind {
  if (
    input.sourceKind === 'learning_signal' &&
    input.contradictsMemoryItemId &&
    input.conflictStatus === 'open'
  ) {
    return 'learning_signal_conflict';
  }
  return candidateKindForSource(input.sourceKind);
}

export type MemoryVersionActivationDecision = 'duplicate' | 'replace' | 'conflict';

/** Normalize only for deterministic equality checks; never use this as stored content. */
export function normalizeMemoryVersionText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Explicit correction/restore proposals replace the controlling version. An explicit
 * contradiction preserves both sides and opens a conflict. Exact content never creates
 * another controlling row, regardless of proposal kind.
 */
export function classifyMemoryVersionActivation(
  kind: MemoryVersionKind,
  proposedText: string,
  controllingText: string | null,
): MemoryVersionActivationDecision {
  if (
    controllingText !== null &&
    normalizeMemoryVersionText(proposedText) === normalizeMemoryVersionText(controllingText)
  ) {
    return 'duplicate';
  }
  return kind === 'contradiction' ? 'conflict' : 'replace';
}

/** Stable, bounded slug for a new immutable version. */
export function immutableMemoryVersionSlug(baseSlug: string, candidateId: string): string {
  const root = baseSlug.replace(/~(?:c|v)[a-z0-9-]+$/i, '');
  const identity = candidateId.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!identity) throw new Error('immutableMemoryVersionSlug requires a stable candidate id');

  // Keep the full UUID entropy (32 hex characters). Truncate the ROOT, never the
  // suffix: slicing the combined string allowed a 200-character source slug to
  // discard the version identity entirely and collide with the controlling row.
  const suffix = `~v${identity.slice(0, 32)}`;
  const rootBudget = Math.max(0, 200 - suffix.length);
  return `${root.slice(0, rootBudget)}${suffix}`;
}

export function isMemoryVersionKind(value: unknown): value is MemoryVersionKind {
  return (MEMORY_VERSION_KINDS as readonly unknown[]).includes(value);
}
