import { deriveStateBillStatus, classifyStateVoteMotion } from '@capiro/shared';
import type { EvalCase } from '../types';

/**
 * State Legislation Platform S6.4 — THE STATE TWIN OF H.R. 8800, pinned in the
 * CI gate.
 *
 * A state bill can carry a misleadingly soft latest-action text ("Referred to
 * Committee on State Affairs") while the fact that actually governs its fate
 * is that the legislature adjourned sine die with the bill never reaching a
 * terminal outcome — i.e. it died at crossover. The truth layer must resolve
 * `dead_by_deadline` once the session's sine-die date has passed and no hard
 * terminal (enacted/veto_overridden/vetoed/failed/to_governor) matched, and
 * must never let committee-ish text or an engrossed/passed-chamber signal
 * outrank that fact. Deterministic mechanism test — mirrors
 * legislation.bill-status.hr8800-rule-failed one abstraction up (DD8).
 */
export const stateBillStatusCase: EvalCase = {
  id: 'legislation.state-bill-status.crossover-dead',
  category: 'legislation',
  description:
    'A state bill whose latest action is only "referred to committee" but whose session adjourned sine die resolves to dead_by_deadline, never committee/passed_chamber',
  async run() {
    const problems: string[] = [];
    const seed = process.env.MERIV2_EVAL_SEED_FAILURE === '1';

    const CROSSOVER_ACTION = 'Referred to Committee on State Affairs';

    // Naive (no sine-die date on record): reads the text at face value —
    // committee. NOT dead, because nothing yet says the session is over.
    const naive = deriveStateBillStatus({ legiscanStatus: 1, latestActionText: CROSSOVER_ACTION });
    if (naive.status !== 'committee') {
      problems.push(
        `bare "referred to committee" (no sine-die) → ${naive.status}, expected committee`,
      );
    }

    // The pinned crossover-dead fixture (state-bill-status.spec.ts TRAP 6):
    // sine-die has passed and no terminal matched → dead_by_deadline. Seed
    // flips sessionSineDie to the future to prove the gate can go red if the
    // deadline-precedence logic regresses.
    const truthful = deriveStateBillStatus({
      legiscanStatus: 1,
      latestActionText: CROSSOVER_ACTION,
      sessionSineDie: seed ? '2099-01-01' : '2025-05-30',
      today: '2026-01-01',
    });
    if (truthful.status !== 'dead_by_deadline') {
      problems.push(`session adjourned sine die → ${truthful.status}, expected dead_by_deadline`);
    }
    if (truthful.status === 'committee' || truthful.status === 'passed_chamber') {
      problems.push(
        'committee-ish text/engrossed status was read as still-alive — the exact state-twin bug',
      );
    }

    // Enrolled (to_governor) is a hard terminal and must outrank a passed
    // sine-die date — a bill on the governor's desk is not "dead" just
    // because the legislature has since adjourned.
    if (
      deriveStateBillStatus({
        legiscanStatus: 3, // Enrolled
        sessionSineDie: '2025-05-30',
        today: '2026-01-01',
      }).status !== 'to_governor'
    ) {
      problems.push('enrolled (to_governor) did not outrank a passed sine-die date');
    }

    // A real failed floor vote is likewise a hard terminal and must outrank
    // sine-die too (failed beats dead_by_deadline, not the other way round).
    if (
      deriveStateBillStatus({
        failedChamber: true,
        sessionSineDie: '2025-05-30',
        today: '2026-01-01',
      }).status !== 'failed'
    ) {
      problems.push('a real failed floor vote did not outrank a passed sine-die date');
    }

    // classifyStateVoteMotion must exclude committee/amendment motions even
    // when they contain passage-like words — a procedural vote must never
    // masquerade as final passage.
    if (classifyStateVoteMotion('Committee Amendment adopted') !== false) {
      problems.push(
        'classifyStateVoteMotion("Committee Amendment adopted") did not read as non-final',
      );
    }
    if (classifyStateVoteMotion('Third Reading') !== true) {
      problems.push('classifyStateVoteMotion("Third Reading") did not read as final passage');
    }

    return {
      pass: problems.length === 0,
      detail:
        problems.length === 0
          ? 'State bill truth layer sound: crossover-dead resolves before committee-ish text, enrolled/failed outrank sine-die, vote motion classified'
          : `state-bill-status FAILURES: ${problems.join('; ')}`,
    };
  },
};
