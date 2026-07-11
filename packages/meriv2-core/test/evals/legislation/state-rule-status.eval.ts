import { deriveRuleLifecycleStage, isRuleCommentOpen } from '@capiro/shared';
import type { EvalCase } from '../types';

/**
 * Phase 1 M4.2 / W5.6 (D-15) — `get_state_rule_status` ANTI-FABRICATION
 * mechanism gate. Deterministic, DB-free. Pins the two invariants the tool's
 * description promises and that a client-facing rule/notice surface must never
 * violate:
 *
 *   1. The lifecycle STAGE (notice/nprm/comment_closed/final/effective) is
 *      DERIVED from the document type + comment/effective dates — never guessed.
 *      An unknown/empty type resolves to the safe `notice` floor, never a
 *      fabricated higher stage (a rule is never claimed "final"/"effective"
 *      without the dated evidence for it).
 *   2. `isOpen` (comment window) is gated to comment-ACCEPTING stages AND a real,
 *      currently-live dated window (W4.5). A notice-stage rule with a live
 *      window IS open (the bug this replaced gated on `stage === 'nprm'` alone);
 *      a `final`/`effective` rule is NEVER open regardless of a lingering date;
 *      and with NO end date there is no provable window, so `isOpen=false` — the
 *      tool reports open only on evidence, never fabricates a deadline.
 *
 * Exercises the SHARED pure functions (`deriveRuleLifecycleStage`,
 * `isRuleCommentOpen`) that back the apps/api tool — apps/api is not importable
 * here, so the mechanism is pinned one abstraction up (same contract as the
 * committee-roster / state-bill-status cases). Seed flips one input to prove the
 * gate can go red if the isOpen gating regresses.
 */
export const stateRuleStatusCase: EvalCase = {
  id: 'legislation.state-rule-status.no-fabrication',
  category: 'legislation',
  description:
    'get_state_rule_status derives stage from type+dates (never guessed) and reports isOpen only for a comment-accepting stage with a real live window (never fabricates an open deadline)',
  async run() {
    const problems: string[] = [];
    const seed = process.env.MERIV2_EVAL_SEED_FAILURE === '1';
    const today = new Date('2026-01-15T00:00:00Z');
    const d = (s: string) => new Date(`${s}T00:00:00Z`);

    // ── (1) Stage derivation is fact-driven, never guessed ──────────────────
    // Proposed rule, comment deadline still ahead → nprm (open comment period).
    if (
      deriveRuleLifecycleStage({
        documentType: 'PROPOSED_RULE',
        commentEndDate: d('2026-02-01'),
        effectiveDate: null,
        today,
      }) !== 'nprm'
    ) {
      problems.push('PROPOSED_RULE with a future comment deadline did not derive nprm');
    }
    // Same proposed rule after the deadline → comment_closed (not still-nprm).
    if (
      deriveRuleLifecycleStage({
        documentType: 'PROPOSED_RULE',
        commentEndDate: d('2026-01-01'),
        effectiveDate: null,
        today,
      }) !== 'comment_closed'
    ) {
      problems.push('PROPOSED_RULE past its comment deadline did not derive comment_closed');
    }
    // Final rule, effective date not yet arrived → final; arrived → effective.
    if (
      deriveRuleLifecycleStage({
        documentType: 'RULE',
        commentEndDate: null,
        effectiveDate: d('2026-03-01'),
        today,
      }) !== 'final'
    ) {
      problems.push('RULE before its effective date did not derive final');
    }
    if (
      deriveRuleLifecycleStage({
        documentType: 'RULE',
        commentEndDate: null,
        effectiveDate: d('2026-01-01'),
        today,
      }) !== 'effective'
    ) {
      problems.push('RULE on/after its effective date did not derive effective');
    }
    // Unknown / empty type → the safe `notice` floor, NEVER a fabricated
    // higher stage. This is the core "never guess a rule's status" guarantee.
    for (const t of [null, undefined, '', 'SOMETHING_NEW']) {
      const stage = deriveRuleLifecycleStage({
        documentType: t,
        commentEndDate: null,
        effectiveDate: null,
        today,
      });
      if (stage !== 'notice') {
        problems.push(`unknown documentType ${JSON.stringify(t)} fabricated stage "${stage}"`);
      }
    }

    // ── (2) isOpen gating (W4.5): stage-accepting AND a real live window ────
    // A NOTICE-stage rule with a live window IS open (the exact W4.5 fix —
    // seed flips the end date into the past to prove the gate reddens if a
    // genuinely-open notice is reported closed).
    const noticeOpen = isRuleCommentOpen({
      stage: 'notice',
      commentStartDate: d('2026-01-01'),
      commentEndDate: seed ? d('2026-01-10') : d('2026-02-01'),
      today,
    });
    if (!noticeOpen) {
      problems.push('a notice-stage rule with a live comment window was not reported open (W4.5)');
    }
    // nprm with a live window → open.
    if (
      !isRuleCommentOpen({
        stage: 'nprm',
        commentStartDate: null,
        commentEndDate: d('2026-02-01'),
        today,
      })
    ) {
      problems.push('an nprm with a live window was not reported open');
    }
    // A FINAL rule is never open, even with a lingering future date.
    if (
      isRuleCommentOpen({
        stage: 'final',
        commentStartDate: null,
        commentEndDate: d('2026-02-01'),
        today,
      })
    ) {
      problems.push('a final-stage rule was reported open (not a comment-accepting stage)');
    }
    // No end date → not provably open → false (never fabricate a deadline).
    if (
      isRuleCommentOpen({
        stage: 'notice',
        commentStartDate: d('2026-01-01'),
        commentEndDate: null,
        today,
      })
    ) {
      problems.push('a rule with NO comment-end date was reported open (fabricated window)');
    }
    // Window already elapsed → closed.
    if (
      isRuleCommentOpen({
        stage: 'nprm',
        commentStartDate: d('2025-12-01'),
        commentEndDate: d('2026-01-01'),
        today,
      })
    ) {
      problems.push('a rule past its comment-end date was reported open');
    }
    // Window not yet begun (future start) → closed.
    if (
      isRuleCommentOpen({
        stage: 'nprm',
        commentStartDate: d('2026-02-01'),
        commentEndDate: d('2026-03-01'),
        today,
      })
    ) {
      problems.push('a rule whose comment window has not started was reported open');
    }

    return {
      pass: problems.length === 0,
      detail:
        problems.length === 0
          ? 'State rule status sound: stage derived from type+dates (notice floor for unknowns), isOpen gated to comment-accepting stages with a real live window — no fabricated status/deadline'
          : `state-rule-status FAILURES: ${problems.join('; ')}`,
    };
  },
};
