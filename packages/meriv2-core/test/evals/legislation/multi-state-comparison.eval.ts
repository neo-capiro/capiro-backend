import { deriveStateBillStatus, computeStateDeadlineRisk } from '@capiro/shared';
import type { EvalCase } from '../types';

/**
 * Phase 1 M4.3/M4-D — "compare the data-privacy bills moving in our 8
 * facility states" MECHANISM gate: multi-state comparison determinism.
 * `deriveStateBillStatus`/`computeStateDeadlineRisk` are pure per-bill
 * functions with no shared mutable state — this pins that processing a
 * BATCH of different states' bills together is always order-independent
 * (no cross-state contamination) and that repeat calls on the SAME input are
 * bit-identical, so a cross-jurisdiction comparison can never silently swap
 * one state's deadline/status onto another's.
 */

interface StateBillFixture {
  state: string;
  status: Parameters<typeof deriveStateBillStatus>[0];
  session: Parameters<typeof computeStateDeadlineRisk>[0]['session'];
  today: string;
}

const FIXTURES: StateBillFixture[] = [
  {
    state: 'FL',
    status: { latestActionText: 'Referred to Committee on Judiciary' },
    session: { committeeCutoffDate: '2026-03-13', sineDie: '2026-05-01' },
    today: '2026-03-01',
  },
  {
    state: 'CA',
    status: { passedChamber: true },
    session: { secondCommitteeCutoffDate: '2026-07-10', sineDie: '2026-09-30' },
    today: '2026-06-01',
  },
  {
    state: 'GA',
    status: { legiscanStatus: 6 }, // Failed
    session: { sineDie: '2026-04-04' },
    today: '2026-04-10',
  },
  {
    state: 'VA',
    status: { latestActionText: 'reported favorably out of committee' },
    session: { crossoverDate: '2026-02-16', sineDie: '2026-03-08' },
    today: '2026-02-01',
  },
];

function runBatch(fixtures: StateBillFixture[]) {
  return fixtures.map((f) => {
    const status = deriveStateBillStatus({ ...f.status, today: f.today });
    const risk = computeStateDeadlineRisk({
      status: status.status,
      session: f.session,
      today: f.today,
    });
    return { state: f.state, status, risk };
  });
}

export const multiStateComparisonCase: EvalCase = {
  id: 'legislation.multi-state-comparison.order-independent',
  category: 'legislation',
  description:
    "A batch of different states' bills processed together resolves IDENTICALLY regardless of processing order — no cross-state contamination in a multi-state comparison",
  async run() {
    const problems: string[] = [];
    const seed = process.env.MERIV2_EVAL_SEED_FAILURE === '1';

    const forward = runBatch(FIXTURES);
    // Seed mutates ONE fixture's session out from under the reversed pass to
    // prove the gate can go red if a future change makes these functions
    // share mutable state across calls in a batch.
    const reversedFixtures = seed
      ? [...FIXTURES].reverse().map((f, i) => (i === 0 ? { ...f, session: {} } : f))
      : [...FIXTURES].reverse();
    const reversed = runBatch(reversedFixtures);

    for (const fwd of forward) {
      const rev = reversed.find((r) => r.state === fwd.state);
      if (!rev) {
        problems.push(`${fwd.state} missing from the reversed-order pass`);
        continue;
      }
      if (JSON.stringify(fwd.status) !== JSON.stringify(rev.status)) {
        problems.push(
          `${fwd.state} status changed with processing order: ${JSON.stringify(fwd.status)} vs ${JSON.stringify(rev.status)}`,
        );
      }
      if (JSON.stringify(fwd.risk) !== JSON.stringify(rev.risk)) {
        problems.push(
          `${fwd.state} deadline risk changed with processing order: ${JSON.stringify(fwd.risk)} vs ${JSON.stringify(rev.risk)}`,
        );
      }
    }

    // Repeat-call determinism: calling the batch twice in the SAME order
    // must be bit-identical (no incidental Date.now()/hidden-state leakage).
    const repeat = runBatch(FIXTURES);
    for (let i = 0; i < forward.length; i++) {
      if (JSON.stringify(forward[i]) !== JSON.stringify(repeat[i])) {
        problems.push(`${forward[i]!.state} was not repeat-call deterministic`);
      }
    }

    return {
      pass: problems.length === 0,
      detail:
        problems.length === 0
          ? `${FIXTURES.length}-state batch resolves identically forward, reversed, and repeated — no cross-state contamination`
          : `multi-state-comparison FAILURES: ${problems.join('; ')}`,
    };
  },
};
