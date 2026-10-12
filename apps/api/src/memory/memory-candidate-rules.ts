// Phase 1 (1B) — memory candidate governance rules. Pure, DB-free.
//
// Deliberately mirrors the SHAPE of packages/meriv2-core's ComplianceRule
// engine (declarative rule list, first-match-wins, every decision carries the
// id of the rule that produced it) rather than importing it directly: that
// engine's types are bound to a tool-call MeriContext (tool name + registry
// input), whereas this decision is "should this memory write auto-commit or
// wait for approval" — a question evaluated identically regardless of which
// surface originated the call. In practice there is only ONE call site today:
// MeriToolsService.saveMemory (apps/api). The MeriV2 orchestrator's
// `save_memory` write tool is a DELEGATED tool (write-tools.catalog.ts) that
// forwards to `POST /api/clio/tools/save_memory`, which dispatches to the
// exact same method — so this function is already invoked identically from
// both surfaces by construction, not by a duplicated implementation.
//
// Confidence helpers remain exported for explicit extraction/evaluation callers,
// but Phase 0 governance never lets model extraction auto-promote merely because
// a model assigned itself a high score.
import {
  DEFAULT_MIN_WRITE_CONFIDENCE,
  passesWriteConfidenceGate,
} from '../meri/memory-confidence.helpers.js';
export { DEFAULT_MIN_WRITE_CONFIDENCE, passesWriteConfidenceGate };

export type MemoryCandidateOutcome = 'PASS' | 'WARN';

export interface MemoryCandidateDecision {
  outcome: MemoryCandidateOutcome;
  ruleId: string;
  reason: string;
}

export interface MemoryCandidateRuleInput {
  scope: 'personal' | 'firm' | 'client';
  /**
   * Recorded on the candidate for the review queue. **Intentionally does not
   * affect the decision** — see the segregation-of-duties note on
   * MEMORY_CANDIDATE_RULES. Do not add a rule that grants PASS on this field.
   */
  isAdmin: boolean;
  /** Machine extraction is always review-only in Phase 0. Absent = explicit human save. */
  sourceKind?: string;
  /** Extraction confidence [0,1], retained for review context, never auto-authority. */
  confidence?: number | null;
  /** Retained for compatibility with evaluation callers; not an auto-promotion threshold. */
  minConfidence?: number;
}

interface MemoryCandidateRule {
  readonly id: string;
  readonly outcome: MemoryCandidateOutcome;
  readonly reason: string;
  readonly matches: (input: MemoryCandidateRuleInput) => boolean;
}

/**
 * Personal saves keep their immediate behavior. Shared proposals always start
 * pending; machine extraction is pending for every scope.
 *
 * `memory.firm.admin_auto_commit` and `memory.client.admin_auto_commit` used to
 * return PASS for `isAdmin`, promoting a shared proposal in the same request.
 * That automatic promotion remains prohibited. Proposal creation and approval
 * are separate operations, including for administrators.
 *
 * The existing approval policy allows authorized user_admin and capiro_admin
 * reviewers to approve their own pending shared proposals. Other client-scope
 * reviewers must differ from the proposer and satisfy current grant and
 * assignment requirements; ordinary grants do not permit firm approval.
 * Current tenant/client/wall authorization still applies. This description
 * grants no authority and does not extend the exception to shared self-rejection
 * or withdrawing another person's proposal.
 *
 * `isAdmin` remains unused by these creation rules: it must not bypass pending
 * creation. Canonical review authorization belongs to the existing review
 * services, not this rule table. Automated candidates remain review-only.
 * Rollback of creation behavior is documented in
 * docs/runbooks/meriv2-memory-context-assurance-rollback.md.
 */
const MEMORY_CANDIDATE_RULES: readonly MemoryCandidateRule[] = [
  // Phase 27B: every candidate LearningSignalCandidateService proposes must
  // land pending, regardless of scope — a personal-scope learning-signal
  // candidate must NOT hit memory.personal.auto_commit below and silently
  // become active memory. Checked first, same reasoning as
  // model_extraction: automated generation is always review-only, never
  // auto-commit, no matter how the evidence classifies.
  {
    id: 'memory.learning_signal.requires_review',
    outcome: 'WARN',
    reason:
      'Candidates generated from a LearningSignal always require an authorized reviewer — ' +
      'candidate generation proposes, it never promotes.',
    matches: (i) => i.sourceKind === 'learning_signal',
  },
  {
    id: 'memory.model_extraction.requires_review',
    outcome: 'WARN',
    reason:
      'Machine-extracted memory requires an authorized reviewer before it becomes active memory.',
    matches: (i) => i.sourceKind === 'model_extraction',
  },
  {
    id: 'memory.personal.auto_commit',
    outcome: 'PASS',
    reason: 'Personal memory is private to the requesting user; no approval needed.',
    matches: (i) => i.scope === 'personal',
  },
  {
    id: 'memory.firm.requires_approval',
    outcome: 'WARN',
    reason:
      'Firm-wide memory remains pending until an authorized administrator approves it. ' +
      'An authorized administrator may approve their own proposal.',
    matches: (i) => i.scope === 'firm',
  },
  // G2 client scope: client strategic memory (approved positions, red lines) is
  // shared truth for everyone serving that client — the same trust posture as
  // firm scope (blueprint §4.6.2: "client lead or authorized team; reviewable"),
  // so creation stays pending for authorized approval under the existing policy.
  {
    id: 'memory.client.requires_approval',
    outcome: 'WARN',
    reason:
      'Client-scope memory remains pending until authorized approval. ' +
      'An authorized administrator may approve their own proposal; other reviewers must be ' +
      'different from the proposer and satisfy the existing grant and assignment requirements.',
    matches: (i) => i.scope === 'client',
  },
];

/** First matching rule wins. Fail-safe fallback still requires approval. */
export function evaluateMemoryCandidate(input: MemoryCandidateRuleInput): MemoryCandidateDecision {
  for (const rule of MEMORY_CANDIDATE_RULES) {
    if (rule.matches(input)) {
      return { outcome: rule.outcome, ruleId: rule.id, reason: rule.reason };
    }
  }
  return {
    outcome: 'WARN',
    ruleId: 'memory.fallback.requires_approval',
    reason: 'Unrecognized memory scope; requires approval by default.',
  };
}
