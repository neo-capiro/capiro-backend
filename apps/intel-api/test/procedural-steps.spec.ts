/**
 * Gate D phase b (§4.3). The summary prompt used to ask the model for "the
 * immediate next step in the legislative process" from a stage label and an
 * action string, with no allowed-step set, no chamber, no rule outcome and no
 * calendar state. This suite locks the deterministic replacement.
 *
 * The invariant that matters: `nextPossibleSteps: []` means the model may not
 * assert a next step. Every unmatched, terminal, or blocked state must produce
 * an empty array — never a plausible guess.
 */
import {
  proceduralOutlook,
  proceduralStateFromAlert,
  STEPS_IN_COMMITTEE,
  STEPS_REPORTED,
  STEPS_RULE_GRANTED,
  STEPS_RULE_FAILED,
  STEPS_PASSED_ONE_CHAMBER,
  STEPS_IN_CONFERENCE,
  STEPS_TO_EXECUTIVE,
  BLOCKED_RULE_FAILED,
  BLOCKED_TERMINAL,
  type ProceduralState,
} from '../src/tracker/procedural-steps.js';

const base = (over: Partial<ProceduralState> = {}): ProceduralState => ({
  canonicalStatus: null,
  chamber: null,
  changeType: 'unknown_change',
  ruleOutcome: null,
  voteResult: null,
  hasCompanion: false,
  inConference: false,
  jurisdiction: 'US',
  ...over,
});

/** b-7 case 1 — one case per row of the b-2 transition table. */
describe('proceduralOutlook — the transition table', () => {
  it('introduced / referred → committee steps', () => {
    expect(proceduralOutlook(base({ canonicalStatus: 'introduced' })).nextPossibleSteps).toEqual(
      STEPS_IN_COMMITTEE,
    );
    expect(proceduralOutlook(base({ canonicalStatus: 'referred' })).nextPossibleSteps).toEqual(
      STEPS_IN_COMMITTEE,
    );
    expect(proceduralOutlook(base({ changeType: 'bill_markup' })).nextPossibleSteps).toEqual(
      STEPS_IN_COMMITTEE,
    );
  });

  it('reported from committee → rules / scheduling / floor vote', () => {
    for (const changeType of ['bill_reported', 'state_bill_reported']) {
      expect(proceduralOutlook(base({ changeType })).nextPossibleSteps).toEqual(STEPS_REPORTED);
    }
  });

  it('rule granted → floor debate / floor vote', () => {
    expect(proceduralOutlook(base({ ruleOutcome: 'granted' })).nextPossibleSteps).toEqual(
      STEPS_RULE_GRANTED,
    );
    for (const changeType of ['bill_rule_reported', 'bill_rule_adopted', 'bill_floor_scheduled']) {
      expect(proceduralOutlook(base({ changeType })).nextPossibleSteps).toEqual(
        STEPS_RULE_GRANTED,
      );
    }
  });

  it('passed one chamber → other chamber / conference (companion only when one exists)', () => {
    const withCompanion = proceduralOutlook(
      base({ changeType: 'bill_passed_chamber', hasCompanion: true }),
    );
    expect(withCompanion.nextPossibleSteps).toEqual(STEPS_PASSED_ONE_CHAMBER);

    const without = proceduralOutlook(base({ changeType: 'bill_passed_chamber' }));
    expect(without.nextPossibleSteps).not.toContain('Companion bill consideration');
    expect(without.nextPossibleSteps).toEqual([
      'Referral in the other chamber',
      'Conference to resolve differences',
    ]);
  });

  it('in conference → conference report steps', () => {
    expect(proceduralOutlook(base({ inConference: true })).nextPossibleSteps).toEqual(
      STEPS_IN_CONFERENCE,
    );
    expect(
      proceduralOutlook(base({ changeType: 'state_bill_resolving' })).nextPossibleSteps,
    ).toEqual(STEPS_IN_CONFERENCE);
  });

  it('to the executive → signature / veto / becomes law without signature', () => {
    // The same three acts apply to a governor, so the state rail reuses them.
    for (const changeType of ['bill_to_president', 'state_bill_to_governor']) {
      expect(proceduralOutlook(base({ changeType })).nextPossibleSteps).toEqual(
        STEPS_TO_EXECUTIVE,
      );
    }
  });
});

/** b-7 case 2 — the audit's motivating example. */
describe('proceduralOutlook — a failed governing rule', () => {
  it('blocks floor consideration and never licenses a floor vote', () => {
    const out = proceduralOutlook(base({ changeType: 'bill_rule_failed' }));
    expect(out.blockedBy).toEqual([BLOCKED_RULE_FAILED]);
    expect(out.blockedBy.length).toBeGreaterThan(0);
    expect(out.nextPossibleSteps).toEqual(STEPS_RULE_FAILED);
    expect(out.nextPossibleSteps).not.toContain('Floor vote');
    expect(out.nextPossibleSteps).not.toContain('Floor debate');
  });

  it('an explicit failed rule outcome outranks any other signal', () => {
    // A rule can fail without its own change type arriving.
    const out = proceduralOutlook(
      base({ changeType: 'bill_reported', ruleOutcome: 'failed', canonicalStatus: 'floor' }),
    );
    expect(out.nextPossibleSteps).not.toContain('Floor vote');
    expect(out.blockedBy).toEqual([BLOCKED_RULE_FAILED]);
  });
});

/** b-7 case 3 — terminal statuses license nothing. */
describe('proceduralOutlook — terminal states', () => {
  it.each([
    'bill_enacted',
    'bill_failed',
    'state_bill_enacted',
    'state_bill_vetoed',
    'state_bill_failed',
  ])('%s → no next step at all', (changeType) => {
    const out = proceduralOutlook(base({ changeType }));
    expect(out.nextPossibleSteps).toEqual([]);
    expect(out.blockedBy).toEqual([BLOCKED_TERMINAL]);
  });

  it('a state bill past a cutoff names the cutoff', () => {
    const out = proceduralOutlook(
      base({ changeType: 'state_bill_dead_by_deadline', cutoffType: 'crossover day' }),
    );
    expect(out.nextPossibleSteps).toEqual([]);
    expect(out.blockedBy).toEqual(['Past its crossover day deadline for this session']);
  });

  it('…and stays honest when the cutoff type is unknown', () => {
    const out = proceduralOutlook(base({ changeType: 'state_bill_dead_by_deadline' }));
    expect(out.blockedBy).toEqual(['Past its deadline for this session']);
  });
});

/** b-7 case 4 — an unmatched state is silence plus a recorded uncertainty. */
describe('proceduralOutlook — unmatched states never guess', () => {
  it('returns [] and one uncertainty entry', () => {
    const out = proceduralOutlook(base({ changeType: 'a_change_type_that_does_not_exist' }));
    expect(out.nextPossibleSteps).toEqual([]);
    expect(out.uncertainty).toEqual([
      'Canonical status did not match a known procedural state',
    ]);
    expect(out.blockedBy).toEqual([]);
  });

  it('the non-procedural change types the detector emits license nothing', () => {
    // These change the record without moving the bill to a new stage.
    for (const changeType of [
      'bill_amendment',
      'bill_hearing',
      'bill_hearing_scheduled',
      'bill_fiscal_note',
      'bill_text_changed',
      'bill_cosponsor_momentum',
      'bill_new_match',
      'state_bill_vote_recorded',
      'state_companion_moved',
      'state_bill_deadline_approaching',
      'state_bill_veto_overridden',
    ]) {
      expect(proceduralOutlook(base({ changeType })).nextPossibleSteps).toEqual([]);
    }
  });
});

describe('proceduralStateFromAlert', () => {
  it('derives the rule outcome from the change type', () => {
    expect(proceduralStateFromAlert({ changeType: 'bill_rule_failed' }).ruleOutcome).toBe('failed');
    expect(proceduralStateFromAlert({ changeType: 'bill_rule_adopted' }).ruleOutcome).toBe(
      'granted',
    );
    expect(proceduralStateFromAlert({ changeType: 'bill_amendment' }).ruleOutcome).toBeNull();
  });

  it('never invents a chamber (no emitted alert carries one)', () => {
    expect(proceduralStateFromAlert({ changeType: 'bill_passed_chamber' }).chamber).toBeNull();
  });

  it('defaults jurisdiction to US and carries a state code through', () => {
    expect(proceduralStateFromAlert({ changeType: 'x' }).jurisdiction).toBe('US');
    expect(proceduralStateFromAlert({ changeType: 'x', jurisdiction: 'CA' }).jurisdiction).toBe(
      'CA',
    );
  });

  it('end-to-end: a real rule_failed alert yields no floor vote', () => {
    const out = proceduralOutlook(proceduralStateFromAlert({ changeType: 'bill_rule_failed' }));
    expect(out.nextPossibleSteps).not.toContain('Floor vote');
    expect(out.blockedBy).toEqual([BLOCKED_RULE_FAILED]);
  });
});
