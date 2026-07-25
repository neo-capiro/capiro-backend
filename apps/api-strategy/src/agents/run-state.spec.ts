import { describe, expect, it } from '@jest/globals';
import {
  MISSION_STATES,
  MISSION_TRANSITIONS,
  RUN_FAILURE_STATES,
  RUN_STATES,
  RUN_STATE_POLICY,
  RUN_SUPERSEDABLE_STATES,
  RUN_TERMINAL_STATES,
  RUN_TRANSITIONS,
  assertMissionTransition,
  assertTransition,
  isActionAllowed,
  isLegalMissionTransition,
  isLegalTransition,
  isStranded,
  reasonForState,
  type MissionStateValue,
  type RunStateValue,
} from './run-state.js';

/*
 * Exhaustive transition-matrix tests. EXPECTED_RUN / EXPECTED_MISSION
 * re-document the legal moves INDEPENDENTLY of run-state.ts (spelled out
 * pair-by-pair here, not derived from the module), so a silent edit to
 * RUN_TRANSITIONS / MISSION_TRANSITIONS fails this spec instead of being
 * re-asserted against itself. Every (from, to) pair is table-driven — 8×8 for
 * runs, 6×6 for missions — no spot checks.
 */

const EXPECTED_RUN: Record<RunStateValue, readonly RunStateValue[]> = {
  queued: ['planning', 'canceled'],
  // planning -> ready_for_review is the Stage F check-run shape: a suggest-only
  // Watcher check has no executing phase (see run-state.ts).
  planning: [
    'executing',
    'ready_for_review',
    'waiting_for_input',
    'failed_recoverable',
    'failed_terminal',
    'canceled',
  ],
  waiting_for_input: [
    'planning',
    'executing',
    'ready_for_review',
    'failed_recoverable',
    'failed_terminal',
    'canceled',
    'superseded',
  ],
  executing: [
    'staged',
    'ready_for_review',
    'waiting_for_input',
    'failed_recoverable',
    'failed_terminal',
    'canceled',
  ],
  // ready_for_review -> executing / waiting_for_input are the Stage G Do-mode
  // edges: a REVIEWED execution plan proceeds to staging (executing) once
  // approved, or parks (waiting_for_input) when the interactive bearer is
  // absent. -> approved is the P0-3 approval-bound entry.
  ready_for_review: [
    'approved',
    'executing',
    'waiting_for_input',
    'staged',
    'completed',
    'failed_recoverable',
    'failed_terminal',
    'canceled',
    'superseded',
  ],
  // P0-2 states.
  approved: ['executing', 'waiting_for_input', 'failed_recoverable', 'failed_terminal', 'canceled'],
  staged: [
    'completed',
    'ready_for_review',
    'waiting_for_input',
    'failed_recoverable',
    'failed_terminal',
    'canceled',
  ],
  // failed_recoverable keeps OUTGOING edges on purpose: reconciliation drives it
  // to staged/completed once it establishes an artifact really exists, or to
  // failed_terminal when nothing can be recovered.
  failed_recoverable: [
    'planning',
    'executing',
    'staged',
    'completed',
    'failed_terminal',
    'canceled',
    'superseded',
  ],
  completed: [],
  // LEGACY: retained for pre-P0-2 rows, terminal, and no longer a target.
  failed: [],
  failed_terminal: [],
  canceled: [],
  superseded: [],
};

const EXPECTED_MISSION: Record<MissionStateValue, readonly MissionStateValue[]> = {
  draft: ['active', 'canceled'],
  active: ['paused', 'completed', 'failed', 'canceled'],
  paused: ['active', 'completed', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

const RUN_TERMINALS: readonly RunStateValue[] = [
  'completed',
  'failed',
  'failed_terminal',
  'canceled',
  'superseded',
];
const MISSION_TERMINALS: readonly MissionStateValue[] = ['completed', 'failed', 'canceled'];

const runPairs: Array<[RunStateValue, RunStateValue]> = RUN_STATES.flatMap((from) =>
  RUN_STATES.map((to) => [from, to] as [RunStateValue, RunStateValue]),
);
const missionPairs: Array<[MissionStateValue, MissionStateValue]> = MISSION_STATES.flatMap((from) =>
  MISSION_STATES.map((to) => [from, to] as [MissionStateValue, MissionStateValue]),
);

describe('run transition matrix', () => {
  it('the matrix is exhaustive: 13 states, 169 (from,to) pairs, and the module map covers every state', () => {
    expect(RUN_STATES).toHaveLength(13);
    expect(runPairs).toHaveLength(169);
    expect([...RUN_STATES].sort()).toEqual(Object.keys(EXPECTED_RUN).sort());
    expect([...RUN_STATES].sort()).toEqual(Object.keys(RUN_TRANSITIONS).sort());
  });

  // Every single (from, to) pair: isLegalTransition must agree with the
  // documented map, and assertTransition must throw exactly on the illegal ones.
  it.each(runPairs)('isLegalTransition(%s -> %s) matches the documented map', (from, to) => {
    const legal = EXPECTED_RUN[from].includes(to);
    expect(isLegalTransition(from, to)).toBe(legal);
    if (legal) {
      expect(() => assertTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertTransition(from, to)).toThrow();
    }
  });

  it('terminal run states allow NOTHING — including self-loops', () => {
    expect([...RUN_TERMINAL_STATES].sort()).toEqual([...RUN_TERMINALS].sort());
    for (const from of RUN_TERMINALS) {
      for (const to of RUN_STATES) {
        expect(isLegalTransition(from, to)).toBe(false);
        expect(() => assertTransition(from, to)).toThrow(/terminal/);
        expect(() => assertTransition(from, to)).toThrow(new RegExp(from));
      }
    }
  });

  it('assertTransition names BOTH states (and the legal alternatives) on an illegal non-terminal move', () => {
    expect(() => assertTransition('queued', 'executing')).toThrow(
      /Cannot transition run from 'queued' to 'executing'/,
    );
    expect(() => assertTransition('queued', 'executing')).toThrow(/planning, canceled/);
    expect(() => assertTransition('executing', 'completed')).toThrow(
      /Cannot transition run from 'executing' to 'completed'/,
    );
    // executing must go through `staged` — "an artifact exists" is a separate
    // fact from "the run finished" (P0-2 / audit P1-13).
    expect(isLegalTransition('executing', 'staged')).toBe(true);
    expect(isLegalTransition('staged', 'completed')).toBe(true);
  });

  it('an unknown from-state is never legal and the error names it', () => {
    expect(isLegalTransition('warp', 'queued')).toBe(false);
    expect(() => assertTransition('warp', 'queued')).toThrow(/Unknown run state 'warp'/);
  });
});

describe('mission transition matrix', () => {
  it('the matrix is exhaustive: 6 states, 36 (from,to) pairs, and the module map covers every state', () => {
    expect(MISSION_STATES).toHaveLength(6);
    expect(missionPairs).toHaveLength(36);
    expect([...MISSION_STATES].sort()).toEqual(Object.keys(EXPECTED_MISSION).sort());
    expect([...MISSION_STATES].sort()).toEqual(Object.keys(MISSION_TRANSITIONS).sort());
  });

  it.each(missionPairs)(
    'isLegalMissionTransition(%s -> %s) matches the documented map',
    (from, to) => {
      const legal = EXPECTED_MISSION[from].includes(to);
      expect(isLegalMissionTransition(from, to)).toBe(legal);
      if (legal) {
        expect(() => assertMissionTransition(from, to)).not.toThrow();
      } else {
        expect(() => assertMissionTransition(from, to)).toThrow();
      }
    },
  );

  it('terminal mission states (completed/failed/canceled) allow NOTHING — including self-loops', () => {
    for (const from of MISSION_TERMINALS) {
      expect(MISSION_TRANSITIONS[from]).toHaveLength(0);
      for (const to of MISSION_STATES) {
        expect(isLegalMissionTransition(from, to)).toBe(false);
        expect(() => assertMissionTransition(from, to)).toThrow(/terminal/);
        expect(() => assertMissionTransition(from, to)).toThrow(new RegExp(from));
      }
    }
  });

  it('assertMissionTransition names BOTH states on an illegal non-terminal move', () => {
    expect(() => assertMissionTransition('draft', 'paused')).toThrow(
      /Cannot transition mission from 'draft' to 'paused'/,
    );
    expect(() => assertMissionTransition('draft', 'paused')).toThrow(/active, canceled/);
  });

  it('an unknown mission from-state is never legal and the error names it', () => {
    expect(isLegalMissionTransition('warp', 'active')).toBe(false);
    expect(() => assertMissionTransition('warp', 'active')).toThrow(/Unknown mission state 'warp'/);
  });
});

describe('no dead states', () => {
  // Guards against unreachable enum values: every state except the initial one
  // must be the TARGET of at least one legal transition, otherwise it can only
  // exist via a direct DB write that bypasses the state machine.
  it('every non-initial mission state is reachable (failed included)', () => {
    const targets = new Set(Object.values(MISSION_TRANSITIONS).flat());
    for (const state of MISSION_STATES.filter((s) => s !== 'draft')) {
      expect(targets.has(state)).toBe(true);
    }
  });

  // `failed` is the ONE deliberate exception: P0-2 split failures into
  // failed_recoverable / failed_terminal, so nothing transitions into the old
  // value any more. It stays in the enum because pre-P0-2 rows carry it (dropping
  // an enum value Postgres cannot drop would orphan them), and it reads as
  // terminal. Asserted explicitly so it can never become an accident.
  it('every non-initial run state is reachable, except the legacy `failed` value', () => {
    const targets = new Set(Object.values(RUN_TRANSITIONS).flat());
    for (const state of RUN_STATES.filter((s) => s !== 'queued' && s !== 'failed')) {
      expect(targets.has(state)).toBe(true);
    }
    expect(targets.has('failed')).toBe(false);
  });
});

/*
 * P0-2 per-state policy. The audit requires that EVERY nonterminal state carry a
 * timeout, an allowed-next-actions list and a user-readable reason — these tests
 * make that structural rather than aspirational.
 */
describe('P0-2 run-state policy', () => {
  it('covers every state exactly once', () => {
    expect(Object.keys(RUN_STATE_POLICY).sort()).toEqual([...RUN_STATES].sort());
  });

  it('policy.terminal agrees with the transition table', () => {
    for (const state of RUN_STATES) {
      expect(RUN_STATE_POLICY[state].terminal).toBe(RUN_TRANSITIONS[state].length === 0);
    }
  });

  it('every state has a non-empty, user-readable reason', () => {
    for (const state of RUN_STATES) {
      const reason = RUN_STATE_POLICY[state].reason;
      expect(reason.length).toBeGreaterThan(10);
      // Plain words, not the raw enum value leaking into the UI.
      expect(reason).not.toBe(state);
    }
    expect(reasonForState('queued')).toMatch(/waiting for an agent worker/i);
    expect(reasonForState('not_a_state')).toMatch(/unrecognised state/i);
  });

  it('every state offers at least one action', () => {
    for (const state of RUN_STATES) {
      expect(RUN_STATE_POLICY[state].actions.length).toBeGreaterThan(0);
    }
  });

  it('every ACTIVE (agent-owned) state has a timeout so it cannot strand silently', () => {
    for (const state of ['queued', 'planning', 'approved', 'executing'] as const) {
      expect(RUN_STATE_POLICY[state].timeoutMinutes).toBeGreaterThan(0);
    }
  });

  it('states parked on a HUMAN have NO timeout — waiting on a person is not a fault', () => {
    for (const state of [
      'waiting_for_input',
      'ready_for_review',
      'staged',
      'failed_recoverable',
    ] as const) {
      expect(RUN_STATE_POLICY[state].timeoutMinutes).toBeNull();
    }
  });

  it('terminal states never carry a timeout', () => {
    for (const state of RUN_STATES.filter((s) => RUN_STATE_POLICY[s].terminal)) {
      expect(RUN_STATE_POLICY[state].timeoutMinutes).toBeNull();
    }
  });

  it('the audit-required recovery controls are reachable from the states that need them', () => {
    // "Every run has retry, cancel, and reconcile behavior."
    expect(isActionAllowed('failed_recoverable', 'retry')).toBe(true);
    expect(isActionAllowed('failed_recoverable', 'reconcile')).toBe(true);
    expect(isActionAllowed('failed_recoverable', 'mark_failed')).toBe(true);
    expect(isActionAllowed('waiting_for_input', 'resolve_input')).toBe(true);
    expect(isActionAllowed('waiting_for_input', 'reconcile')).toBe(true);
    expect(isActionAllowed('executing', 'reconcile')).toBe(true);
    expect(isActionAllowed('staged', 'open_artifact')).toBe(true);
    expect(isActionAllowed('completed', 'open_artifact')).toBe(true);
    // Every non-terminal state can be canceled.
    for (const state of RUN_STATES.filter((s) => !RUN_STATE_POLICY[s].terminal)) {
      expect(isActionAllowed(state, 'cancel')).toBe(true);
    }
    // ...and no terminal state can be.
    for (const state of RUN_STATES.filter((s) => RUN_STATE_POLICY[s].terminal)) {
      expect(isActionAllowed(state, 'cancel')).toBe(false);
    }
  });

  it('a completed run cannot be executed, resumed or marked failed', () => {
    for (const action of ['execute', 'resume', 'mark_failed'] as const) {
      expect(isActionAllowed('completed', action)).toBe(false);
    }
  });

  it('an unknown state permits nothing', () => {
    expect(isActionAllowed('warp', 'cancel')).toBe(false);
  });

  it('only the still-OPEN states are supersedable by a retry', () => {
    expect([...RUN_SUPERSEDABLE_STATES].sort()).toEqual([
      'failed_recoverable',
      'ready_for_review',
      'waiting_for_input',
    ]);
    // Retrying a genuinely terminal run must not rewrite that row.
    for (const state of ['completed', 'failed_terminal', 'canceled'] as const) {
      expect(RUN_SUPERSEDABLE_STATES.has(state)).toBe(false);
    }
  });

  it('all three failure states carry the error reason', () => {
    expect([...RUN_FAILURE_STATES].sort()).toEqual([
      'failed',
      'failed_recoverable',
      'failed_terminal',
    ]);
  });
});

describe('isStranded (P0-2 timeout detection)', () => {
  const T0 = Date.parse('2026-07-25T12:00:00.000Z');
  const minsAgo = (n: number) => new Date(T0 - n * 60_000);

  it('strands an executing run past its 15-minute budget', () => {
    expect(isStranded('executing', minsAgo(16), T0)).toBe(true);
  });

  it('does NOT strand an executing run inside its budget', () => {
    expect(isStranded('executing', minsAgo(14), T0)).toBe(false);
  });

  it('never strands a state parked on a human, however old', () => {
    for (const state of ['waiting_for_input', 'ready_for_review', 'staged', 'failed_recoverable']) {
      expect(isStranded(state, minsAgo(60 * 24 * 30), T0)).toBe(false);
    }
  });

  it('never strands a terminal run', () => {
    for (const state of ['completed', 'failed', 'failed_terminal', 'canceled', 'superseded']) {
      expect(isStranded(state, minsAgo(60 * 24 * 30), T0)).toBe(false);
    }
  });

  it('does not strand a run it cannot date (null timestamp) — guessing would fail runs at random', () => {
    expect(isStranded('executing', null, T0)).toBe(false);
    expect(isStranded('executing', undefined, T0)).toBe(false);
  });

  it('accepts an ISO string as well as a Date', () => {
    expect(isStranded('executing', minsAgo(20).toISOString(), T0)).toBe(true);
  });

  it('an unknown state never strands', () => {
    expect(isStranded('warp', minsAgo(9999), T0)).toBe(false);
  });
});
