import { deriveBillStatus, classifyVoteResult } from '@capiro/shared';
import type { EvalCase } from '../types';

/**
 * LegiWatch A6 — THE H.R. 8800 REGRESSION, pinned in the CI gate.
 *
 * Twice, Meri asserted the FY2027 NDAA was "pending floor vote / conference
 * imminent" when the rule (H.Res. 1398) had already FAILED 198–224 on 2026-06-30.
 * H.R. 8800's own latest action reads only "Rules Committee Resolution H. Res.
 * 1398 Reported to House" — which looks like it is advancing. The truth layer
 * must resolve rule_failed once the governing rule's outcome is known, and must
 * never read a failed rule as passage. Deterministic mechanism test.
 */
export const billStatusCase: EvalCase = {
  id: 'legislation.bill-status.hr8800-rule-failed',
  category: 'legislation',
  description:
    'A bill whose latest action is only "rule reported" but whose governing rule FAILED resolves to rule_failed (stalled), never advancing/passed',
  async run() {
    const problems: string[] = [];
    const seed = process.env.MERIV2_EVAL_SEED_FAILURE === '1';

    const HR8800_ACTION = 'Rules Committee Resolution H. Res. 1398 Reported to House.';

    // Naive (no rule outcome): rule_pending — granted, floor pending. NOT passed.
    const naive = deriveBillStatus({ latestActionText: HR8800_ACTION });
    if (naive.status !== 'rule_pending') {
      problems.push(`bare "rule reported" → ${naive.status}, expected rule_pending`);
    }
    if (naive.status === 'passed_chamber' || naive.status === 'enacted') {
      problems.push('"rule reported" was read as advancing/passed — the exact H.R. 8800 bug');
    }

    // With the governing rule FAILED → rule_failed (stalled). Seed flips the
    // input to prove the gate can go red.
    const truthful = deriveBillStatus({
      latestActionText: HR8800_ACTION,
      ruleOutcome: seed ? 'adopted' : 'failed',
    });
    if (truthful.status !== 'rule_failed') {
      problems.push(`governing rule failed → ${truthful.status}, expected rule_failed`);
    }

    // A real chamber-passage vote must outrank a failed rule.
    if (
      deriveBillStatus({
        latestActionText: HR8800_ACTION,
        ruleOutcome: 'failed',
        passedChamber: true,
      }).status !== 'passed_chamber'
    ) {
      problems.push('a real passage vote did not outrank a failed rule');
    }

    // classifyVoteResult must read "not agreed to" as fail (contains "agreed to").
    if (classifyVoteResult('Not agreed to') !== 'fail') {
      problems.push('classifyVoteResult("Not agreed to") did not read as fail');
    }
    if (classifyVoteResult('Agreed to') !== 'pass') {
      problems.push('classifyVoteResult("Agreed to") did not read as pass');
    }

    return {
      pass: problems.length === 0,
      detail:
        problems.length === 0
          ? 'H.R. 8800 truth layer sound: rule-reported→rule_pending, rule-failed→rule_failed, passage outranks, vote-result classified'
          : `bill-status FAILURES: ${problems.join('; ')}`,
    };
  },
};
