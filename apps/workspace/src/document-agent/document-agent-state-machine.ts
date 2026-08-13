// Document Agent state machine — defines valid phase transitions.
//
// The phase flows linearly:
//   type → blueprint → design → goal → brief → context → outline → generate → draft → quality → complete
//
// Backward transitions are allowed for reopening phases (e.g. reopen brief,
// reopen outline). Status transitions are orthogonal to phase.

import type {
  DocumentAgentPhase,
  DocumentAgentStatus,
  DocumentAgentState,
} from './document-agent-state.js';

/** The canonical forward phase order. */
const PHASE_ORDER: readonly DocumentAgentPhase[] = [
  'type',
  'blueprint',
  'design',
  'goal',
  'brief',
  'context',
  'outline',
  'generate',
  'draft',
  'quality',
  'complete',
];

/** Allowed forward transitions. */
const FORWARD_TRANSITIONS: Readonly<Record<DocumentAgentPhase, DocumentAgentPhase | null>> = {
  type: 'blueprint',
  blueprint: 'design',
  design: 'goal',
  goal: 'brief',
  brief: 'context',
  context: 'outline',
  outline: 'generate',
  generate: 'draft',
  draft: 'quality',
  quality: 'complete',
  complete: null,
};

/**
 * Phases that can be reopened (jumped backward to). The user may reopen any
 * phase up to and including the outline. Generation and quality are NOT
 * directly reopenable — they are re-triggered through their endpoints.
 */
const REOPENABLE_PHASES: ReadonlySet<DocumentAgentPhase> = new Set([
  'type',
  'blueprint',
  'design',
  'goal',
  'brief',
  'context',
  'outline',
]);

/** Check if a phase transition is valid. */
export function canTransition(from: DocumentAgentPhase, to: DocumentAgentPhase): boolean {
  if (from === to) return true; // re-entering the same phase (status change)
  // 'complete' is terminal — no transitions out.
  if (from === 'complete') return false;
  const forward = FORWARD_TRANSITIONS[from];
  if (forward === to) return true;
  // Allow backward jumps to reopenable phases (only if the target is earlier).
  if (REOPENABLE_PHASES.has(to)) {
    const fromIdx = PHASE_ORDER.indexOf(from);
    const toIdx = PHASE_ORDER.indexOf(to);
    return toIdx < fromIdx;
  }
  return false;
}

/**
 * Apply a phase transition to a state. Returns a new state object (immutable).
 * Throws an Error if the transition is invalid.
 */
export function transitionPhase(
  state: DocumentAgentState,
  toPhase: DocumentAgentPhase,
  status?: DocumentAgentStatus,
): DocumentAgentState {
  if (!canTransition(state.phase, toPhase)) {
    throw new Error(
      `Invalid phase transition: ${state.phase} → ${toPhase}`,
    );
  }
  return {
    ...state,
    phase: toPhase,
    status: status ?? state.status,
    revision: state.revision + 1,
  };
}

/**
 * Apply a status-only change (no phase transition). Increments the revision.
 */
export function transitionStatus(
  state: DocumentAgentState,
  status: DocumentAgentStatus,
): DocumentAgentState {
  return {
    ...state,
    status,
    revision: state.revision + 1,
  };
}

/**
 * Apply a mutation to the agent state. Returns a new state with incremented
 * revision. The caller is responsible for phase/status validation.
 */
export function mutateState(
  state: DocumentAgentState,
  mutation: (draft: DocumentAgentState) => void,
): DocumentAgentState {
  const next: DocumentAgentState = {
    ...state,
    // Deep-shallow: we copy top-level fields but nested objects are shared
    // until the mutation replaces them. The mutation function MUST replace
    // any nested object it modifies (no in-place mutation of nested arrays).
    brief: { ...state.brief, assumptions: [...state.brief.assumptions], provenance: { ...state.brief.provenance } },
    contextPlan: {
      ...state.contextPlan,
      includedItemIds: [...state.contextPlan.includedItemIds],
      excludedItems: [...state.contextPlan.excludedItems],
      conflicts: [...state.contextPlan.conflicts],
      coverage: { ...state.contextPlan.coverage, missingClaims: [...state.contextPlan.coverage.missingClaims] },
    },
    outline: {
      ...state.outline,
      sections: [...state.outline.sections],
    },
    generation: { ...state.generation },
  };
  mutation(next);
  next.revision = state.revision + 1;
  return next;
}
