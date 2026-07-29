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
 * Personal saves keep their immediate behavior. Everything shared requires an
 * independent reviewer, and machine extraction is pending for every scope.
 *
 * **Segregation of duties (closeout §2.2).** `memory.firm.admin_auto_commit` and
 * `memory.client.admin_auto_commit` used to return PASS for `isAdmin`, which let
 * a single administrator turn their own proposal into firm- or client-wide
 * institutional truth in ONE request — the proposer and the approver were the
 * same person, and `requireIndependentReviewer` (memory-candidate.service.ts)
 * never ran because the candidate was never pending. Shared memory steers what
 * every other user in the tenant is later served as fact, so it now always lands
 * `pending` and a second authorized human has to approve it.
 *
 * `isAdmin` is deliberately no longer consulted anywhere in this list. An admin
 * is authorized to PROPOSE shared memory (and, being a different person from the
 * proposer, to REVIEW someone else's proposal) — never to ratify their own. The
 * field stays on the input type because callers still pass it and the review
 * queue records it; a rule that reads it again would reopen this hole.
 *
 * This is a deliberate behavior change with no feature flag: a flag defaulting
 * off would leave shared truth self-ratifiable in production, which is the exact
 * finding being closed. Rollback is a code revert, documented in
 * docs/runbooks/meriv2-memory-context-assurance-rollback.md.
 */
const MEMORY_CANDIDATE_RULES: readonly MemoryCandidateRule[] = [
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
      'Firm-wide memory requires an authorized reviewer other than the proposer before it ' +
      'becomes shared truth.',
    matches: (i) => i.scope === 'firm',
  },
  // G2 client scope: client strategic memory (approved positions, red lines) is
  // shared truth for everyone serving that client — the same trust posture as
  // firm scope (blueprint §4.6.2: "client lead or authorized team; reviewable"),
  // so it takes the same independent-review path.
  {
    id: 'memory.client.requires_approval',
    outcome: 'WARN',
    reason:
      'Client-scope memory requires an authorized reviewer other than the proposer before it ' +
      'steers client work.',
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
