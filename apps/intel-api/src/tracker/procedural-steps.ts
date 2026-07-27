/**
 * §4.3: TrackerSummaryService asks the model for "the immediate next step in the
 * legislative process" from a stage label and an action string. That produces
 * plausible-but-procedurally-wrong steps — the motivating example being a bill
 * whose governing RULE was rejected, which the model happily reports as heading
 * to a floor vote. Derive the ALLOWED set deterministically here and let the
 * model only CHOOSE from it (or say it is uncertain).
 *
 * Pure — no I/O, no LLM, no Date. The transition table below is derived from the
 * change types `change-detector.util.ts` actually emits; nothing is invented. A
 * change type this file does not recognise yields `nextPossibleSteps: []`, which
 * the prompt turns into "the next procedural step is NOT established". Silence
 * is the correct answer when we do not know — a guess is what §4.3 is fixing.
 */

export interface ProceduralState {
  /** intel/congress bill status, when the caller has one. Refines `changeType`. */
  canonicalStatus: string | null;
  chamber: 'house' | 'senate' | null;
  changeType: string;
  ruleOutcome: 'granted' | 'failed' | null;
  voteResult: 'passed' | 'failed' | null;
  hasCompanion: boolean;
  inConference: boolean;
  /** 'US' or a 2-letter state code. */
  jurisdiction: string;
  /** State deadline label ('crossover day', 'sine die', …) when one applies. */
  cutoffType?: string | null;
}

export interface ProceduralOutlook {
  currentStage: string;
  priorStage: string | null;
  /** The ONLY steps the model may assert. Empty = the next step is not determinable. */
  nextPossibleSteps: string[];
  blockedBy: string[];
  uncertainty: string[];
}

// ── The allowed-step sets. Exported so the tests assert the exact strings and
// so no caller can hand the model a set this file did not author. ───────────
export const STEPS_IN_COMMITTEE = [
  'Committee markup',
  'Committee vote',
  'No further action this session',
];
export const STEPS_REPORTED = [
  'Rules Committee consideration',
  'Floor scheduling',
  'Floor vote',
];
export const STEPS_RULE_GRANTED = ['Floor debate', 'Floor vote'];
export const STEPS_RULE_FAILED = [
  'New rule from the Rules Committee',
  'Suspension of the rules',
  'No further floor action',
];
export const STEPS_PASSED_ONE_CHAMBER = [
  'Referral in the other chamber',
  'Companion bill consideration',
  'Conference to resolve differences',
];
export const STEPS_IN_CONFERENCE = [
  'Conference report filed',
  'Votes on the conference report in both chambers',
];
export const STEPS_TO_EXECUTIVE = ['Signature', 'Veto', 'Becomes law without signature'];

export const BLOCKED_RULE_FAILED =
  'The governing rule was rejected, so floor consideration cannot proceed under it';
export const BLOCKED_TERMINAL = 'Terminal status — no further procedural step';

/** The stage label reported back for each recognised state. */
const STAGE_LABEL: Record<string, string> = {
  in_committee: 'In committee',
  reported: 'Reported from committee',
  rule_granted: 'Rule granted',
  rule_failed: 'Rule failed',
  passed_chamber: 'Passed one chamber',
  in_conference: 'In conference',
  to_executive: 'Sent to the executive',
  terminal: 'Terminal',
  past_deadline: 'Past a session deadline',
  unknown: 'Unknown',
};

type StateKey = keyof typeof STAGE_LABEL;

/**
 * Which procedural state a change type puts the bill in. `null` means this file
 * does not recognise the event as a procedural transition — an amendment, a CBO
 * estimate, a cosponsor surge, a new watchlist match and a scheduled hearing all
 * land here on purpose: they change the record without moving the bill to a new
 * stage, so there is no next step to license.
 */
const STATE_BY_CHANGE_TYPE: Record<string, StateKey> = {
  // in committee
  bill_markup: 'in_committee',
  // reported from committee
  bill_reported: 'reported',
  state_bill_reported: 'reported',
  // a rule was granted / floor time exists
  bill_rule_reported: 'rule_granted',
  bill_rule_adopted: 'rule_granted',
  bill_floor_scheduled: 'rule_granted',
  state_bill_floor: 'rule_granted',
  // the governing rule was rejected — the §4.3 motivating case
  bill_rule_failed: 'rule_failed',
  // through one chamber
  bill_passed_chamber: 'passed_chamber',
  state_bill_passed_chamber: 'passed_chamber',
  // resolving differences between the chambers
  state_bill_resolving: 'in_conference',
  // on the executive's desk (president or governor — the acts are the same)
  bill_to_president: 'to_executive',
  state_bill_to_governor: 'to_executive',
  // terminal
  bill_enacted: 'terminal',
  bill_failed: 'terminal',
  state_bill_enacted: 'terminal',
  state_bill_vetoed: 'terminal',
  state_bill_failed: 'terminal',
  // terminal, but with a deadline-specific reason
  state_bill_dead_by_deadline: 'past_deadline',
};

/** Canonical-status refinement, used only when the change type is unrecognised. */
const STATE_BY_CANONICAL_STATUS: Record<string, StateKey> = {
  introduced: 'in_committee',
  referred: 'in_committee',
  committee: 'in_committee',
  reported: 'reported',
  floor: 'rule_granted',
  rule_failed: 'rule_failed',
  passed_chamber: 'passed_chamber',
  resolving: 'in_conference',
  conference: 'in_conference',
  to_governor: 'to_executive',
  to_president: 'to_executive',
  enacted: 'terminal',
  vetoed: 'terminal',
  failed: 'terminal',
  dead_by_deadline: 'past_deadline',
};

/** The stage that precedes each state, for `priorStage`. Null where ambiguous. */
const PRIOR_STAGE: Partial<Record<StateKey, string>> = {
  reported: STAGE_LABEL.in_committee,
  rule_granted: STAGE_LABEL.reported,
  rule_failed: STAGE_LABEL.reported,
  in_conference: STAGE_LABEL.passed_chamber,
  to_executive: STAGE_LABEL.passed_chamber,
};

function resolveState(state: ProceduralState): StateKey {
  // An explicit rule outcome always wins: it is the single signal the free-form
  // prompt got wrong, and it can arrive without its own change type.
  if (state.ruleOutcome === 'failed') return 'rule_failed';
  if (state.inConference) return 'in_conference';
  const byChange = STATE_BY_CHANGE_TYPE[state.changeType];
  if (byChange) return byChange;
  if (state.ruleOutcome === 'granted') return 'rule_granted';
  const byStatus = state.canonicalStatus
    ? STATE_BY_CANONICAL_STATUS[state.canonicalStatus]
    : undefined;
  return byStatus ?? 'unknown';
}

/**
 * The allowed next steps for a bill in this state. An empty
 * `nextPossibleSteps` is a real answer, not a failure — it means the model must
 * name no next step at all.
 */
export function proceduralOutlook(state: ProceduralState): ProceduralOutlook {
  const key = resolveState(state);
  const base: ProceduralOutlook = {
    currentStage: STAGE_LABEL[key] ?? STAGE_LABEL.unknown!,
    priorStage: PRIOR_STAGE[key] ?? null,
    nextPossibleSteps: [],
    blockedBy: [],
    uncertainty: [],
  };

  switch (key) {
    case 'in_committee':
      return { ...base, nextPossibleSteps: [...STEPS_IN_COMMITTEE] };
    case 'reported':
      return { ...base, nextPossibleSteps: [...STEPS_REPORTED] };
    case 'rule_granted':
      return { ...base, nextPossibleSteps: [...STEPS_RULE_GRANTED] };
    case 'rule_failed':
      return {
        ...base,
        nextPossibleSteps: [...STEPS_RULE_FAILED],
        blockedBy: [BLOCKED_RULE_FAILED],
      };
    case 'passed_chamber': {
      // "Companion bill consideration" is only a real option when one exists.
      const steps = state.hasCompanion
        ? [...STEPS_PASSED_ONE_CHAMBER]
        : STEPS_PASSED_ONE_CHAMBER.filter((s) => s !== 'Companion bill consideration');
      return {
        ...base,
        nextPossibleSteps: steps,
        uncertainty: state.chamber
          ? []
          : ['Originating chamber not established, so the receiving chamber is not named'],
      };
    }
    case 'in_conference':
      return { ...base, nextPossibleSteps: [...STEPS_IN_CONFERENCE] };
    case 'to_executive':
      return { ...base, nextPossibleSteps: [...STEPS_TO_EXECUTIVE] };
    case 'terminal':
      return { ...base, nextPossibleSteps: [], blockedBy: [BLOCKED_TERMINAL] };
    case 'past_deadline':
      return {
        ...base,
        nextPossibleSteps: [],
        blockedBy: [
          state.cutoffType
            ? `Past its ${state.cutoffType} deadline for this session`
            : 'Past its deadline for this session',
        ],
      };
    default:
      return {
        ...base,
        nextPossibleSteps: [],
        uncertainty: ['Canonical status did not match a known procedural state'],
      };
  }
}

/**
 * Build a `ProceduralState` from what an emitted alert actually carries. Still
 * pure. Every field this cannot establish is left null/false rather than
 * guessed — `proceduralOutlook` degrades to "not established", which is the
 * intended behaviour.
 */
export function proceduralStateFromAlert(input: {
  changeType: string;
  jurisdiction?: string | null;
  canonicalStatus?: string | null;
  /** From the alert's stored evidence (`extra.cutoffType`), when present. */
  cutoffType?: string | null;
  /** From the alert's stored evidence (`extra.relatedBillKey`), when present. */
  hasCompanion?: boolean;
}): ProceduralState {
  const ct = input.changeType;
  return {
    canonicalStatus: input.canonicalStatus ?? null,
    // No emitted alert carries the chamber today; naming one would be a guess.
    chamber: null,
    changeType: ct,
    ruleOutcome:
      ct === 'bill_rule_failed'
        ? 'failed'
        : ct === 'bill_rule_adopted' || ct === 'bill_rule_reported'
          ? 'granted'
          : null,
    voteResult:
      ct === 'bill_passed_chamber' || ct === 'state_bill_passed_chamber'
        ? 'passed'
        : ct === 'bill_failed' || ct === 'state_bill_failed'
          ? 'failed'
          : null,
    hasCompanion: input.hasCompanion ?? false,
    inConference: ct === 'state_bill_resolving',
    jurisdiction: input.jurisdiction ?? 'US',
    cutoffType: input.cutoffType ?? null,
  };
}
