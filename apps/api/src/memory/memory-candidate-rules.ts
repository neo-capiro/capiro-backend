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
// Phase 4 write-confidence gate lives in memory-confidence.helpers (single
// source of truth); re-exported below for the rule + its existing spec importers.
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
  isAdmin: boolean;
  /** Phase 4: how the write originated. Only 'model_extraction' is gated on
   *  confidence; explicit human saves are unaffected. Absent = human/explicit. */
  sourceKind?: string;
  /** Phase 4: extraction confidence [0,1] when the source scored it. */
  confidence?: number | null;
  /** Phase 4: floor for the model_extraction low-confidence rule (default 0.7). */
  minConfidence?: number;
}

interface MemoryCandidateRule {
  readonly id: string;
  readonly outcome: MemoryCandidateOutcome;
  readonly reason: string;
  readonly matches: (input: MemoryCandidateRuleInput) => boolean;
}

/**
 * Seed ruleset. Preserves both halves of the pre-Phase-1 behavior exactly:
 * personal memory always committed immediately, and an admin's own
 * firm-scope save committed immediately (an admin is trusted to self-approve
 * — this is not a new capability, it's what saveMemory already did before a
 * candidate/approval concept existed). The ONLY behavior change is the third
 * rule: a non-admin's firm-scope save used to be a dead-end rejection
 * message; it now creates a real, reviewable pending candidate.
 */
const MEMORY_CANDIDATE_RULES: readonly MemoryCandidateRule[] = [
  // Phase 4 (FIRST — first-match-wins): a MODEL-extracted memory below the
  // confidence floor never auto-commits, it lands in the review queue. Gated
  // strictly to sourceKind='model_extraction' with a numeric confidence, so
  // every existing caller (explicit human saves, which pass no sourceKind/
  // confidence) is unaffected — this rule is inert until governed ingestion
  // (Phase 6) routes machine extractions through the candidate flow.
  {
    id: 'memory.model_extraction.low_confidence_requires_approval',
    outcome: 'WARN',
    reason:
      'Low-confidence machine-extracted memory requires an authorized reviewer before it is stored.',
    matches: (i) =>
      i.sourceKind === 'model_extraction' &&
      typeof i.confidence === 'number' &&
      Number.isFinite(i.confidence) &&
      !passesWriteConfidenceGate(i.confidence, i.minConfidence ?? DEFAULT_MIN_WRITE_CONFIDENCE),
  },
  {
    id: 'memory.personal.auto_commit',
    outcome: 'PASS',
    reason: 'Personal memory is private to the requesting user; no approval needed.',
    matches: (i) => i.scope === 'personal',
  },
  {
    id: 'memory.firm.admin_auto_commit',
    outcome: 'PASS',
    reason: 'An admin proposing firm-wide memory is trusted to commit it directly.',
    matches: (i) => i.scope === 'firm' && i.isAdmin,
  },
  {
    id: 'memory.firm.requires_approval',
    outcome: 'WARN',
    reason: 'Firm-wide memory requires an authorized reviewer before it becomes shared truth.',
    matches: (i) => i.scope === 'firm',
  },
  // G2 client scope: client strategic memory (approved positions, red lines)
  // is shared truth for everyone serving that client — same trust posture as
  // firm scope (blueprint §4.6.2: "client lead or authorized team;
  // reviewable"), so admins self-commit and everyone else lands pending.
  {
    id: 'memory.client.admin_auto_commit',
    outcome: 'PASS',
    reason: 'An admin proposing client-scope memory is trusted to commit it directly.',
    matches: (i) => i.scope === 'client' && i.isAdmin,
  },
  {
    id: 'memory.client.requires_approval',
    outcome: 'WARN',
    reason: 'Client-scope memory requires an authorized reviewer before it steers client work.',
    matches: (i) => i.scope === 'client',
  },
];

/** First matching rule wins. Fail-safe fallback (unreachable today — the two
 *  scope values are exhaustive) still requires approval, never auto-commits. */
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
