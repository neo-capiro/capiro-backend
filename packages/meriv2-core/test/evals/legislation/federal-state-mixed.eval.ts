import { deriveBillStatus, deriveStateBillStatus } from '@capiro/shared';
import type { EvalCase } from '../types';

/**
 * Phase 1 M4.3/M4-E — "compare this federal bill to the analogous state
 * bills in our facility states" MECHANISM gate: the concrete federal
 * application of M4's cross-jurisdiction pattern. Re-runs the pinned H.R.
 * 8800 fixture (`bill-status.eval.ts`) and the pinned state crossover-dead
 * fixture (`state-bill-status.eval.ts`) INTERLEAVED, back to back, several
 * times — proving `deriveBillStatus` and `deriveStateBillStatus` share no
 * mutable state that could let computing one rail's status corrupt the
 * other's when a single comparison answer cites both side by side.
 */

const HR8800_ACTION = 'Rules Committee Resolution H. Res. 1398 Reported to House.';
const STATE_CROSSOVER_ACTION = 'Referred to Committee on State Affairs';

function federalCheck(): string | null {
  const out = deriveBillStatus({ latestActionText: HR8800_ACTION, ruleOutcome: 'failed' });
  return out.status === 'rule_failed'
    ? null
    : `federal side got ${out.status}, expected rule_failed`;
}

function stateCheck(): string | null {
  const out = deriveStateBillStatus({
    latestActionText: STATE_CROSSOVER_ACTION,
    sessionSineDie: '2025-05-30',
    today: '2026-01-01',
  });
  return out.status === 'dead_by_deadline'
    ? null
    : `state side got ${out.status}, expected dead_by_deadline`;
}

export const federalStateMixedCase: EvalCase = {
  id: 'legislation.federal-state-mixed.no-cross-contamination',
  category: 'legislation',
  description:
    "Federal (rule_failed) and state (dead_by_deadline) status derivation interleaved repeatedly both stay correct — a cross-jurisdiction comparison never lets one rail's computation corrupt the other's",
  async run() {
    const problems: string[] = [];
    const seed = process.env.MERIV2_EVAL_SEED_FAILURE === '1';

    // Interleave fed/state/fed/state/... — a shared-mutable-state bug would
    // most plausibly surface as the SECOND call of a pair clobbering the
    // first's result, which straight-through-then-straight-through calling
    // would not catch.
    for (let round = 0; round < 4; round++) {
      const fedProblem = federalCheck();
      if (fedProblem) problems.push(`round ${round}: ${fedProblem}`);
      const stateProblem = stateCheck();
      if (stateProblem) problems.push(`round ${round}: ${stateProblem}`);
    }

    // Neither status string is reachable from the OTHER function's return
    // type at all (TypeScript enforces this structurally — BillStatus has no
    // 'dead_by_deadline'/'to_governor', StateBillStatus has no
    // 'rule_failed'/'rule_pending'/'to_president'), so a Meri answer citing
    // both a federal and a state status side by side can never fabricate a
    // cross-rail status that doesn't exist for that rail. Seed flips which
    // fixture is checked, proving the gate can go red.
    const fedFinal = deriveBillStatus({ latestActionText: HR8800_ACTION, ruleOutcome: 'failed' });
    const bogusFederalOnlyStatuses = seed
      ? (['rule_failed'] as const)
      : (['dead_by_deadline', 'to_governor', 'veto_overridden'] as const);
    if ((bogusFederalOnlyStatuses as readonly string[]).includes(fedFinal.status)) {
      problems.push(
        `federal derivation produced a state-only status "${fedFinal.status}" — cross-rail contamination`,
      );
    }

    return {
      pass: problems.length === 0,
      detail:
        problems.length === 0
          ? 'federal+state mixed mechanism sound: 4 interleaved rounds both stayed correct, no cross-rail status leakage'
          : `federal-state-mixed FAILURES: ${problems.join('; ')}`,
    };
  },
};
