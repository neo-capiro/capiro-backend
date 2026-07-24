import { describe, expect, it } from '@jest/globals';
import {
  MISSION_STATES,
  MISSION_TRANSITIONS,
  RUN_STATES,
  RUN_TERMINAL_STATES,
  RUN_TRANSITIONS,
  assertMissionTransition,
  assertTransition,
  isLegalMissionTransition,
  isLegalTransition,
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
  planning: ['executing', 'waiting_for_input', 'failed', 'canceled'],
  waiting_for_input: ['planning', 'executing', 'failed', 'canceled'],
  executing: ['ready_for_review', 'waiting_for_input', 'failed', 'canceled'],
  ready_for_review: ['completed', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

const EXPECTED_MISSION: Record<MissionStateValue, readonly MissionStateValue[]> = {
  draft: ['active', 'canceled'],
  active: ['paused', 'completed', 'failed', 'canceled'],
  paused: ['active', 'completed', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

const RUN_TERMINALS: readonly RunStateValue[] = ['completed', 'failed', 'canceled'];
const MISSION_TERMINALS: readonly MissionStateValue[] = ['completed', 'failed', 'canceled'];

const runPairs: Array<[RunStateValue, RunStateValue]> = RUN_STATES.flatMap((from) =>
  RUN_STATES.map((to) => [from, to] as [RunStateValue, RunStateValue]),
);
const missionPairs: Array<[MissionStateValue, MissionStateValue]> = MISSION_STATES.flatMap(
  (from) => MISSION_STATES.map((to) => [from, to] as [MissionStateValue, MissionStateValue]),
);

describe('run transition matrix', () => {
  it('the matrix is exhaustive: 8 states, 64 (from,to) pairs, and the module map covers every state', () => {
    expect(RUN_STATES).toHaveLength(8);
    expect(runPairs).toHaveLength(64);
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

  it('terminal run states (completed/failed/canceled) allow NOTHING — including self-loops', () => {
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
    expect(() => assertMissionTransition('warp', 'active')).toThrow(
      /Unknown mission state 'warp'/,
    );
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

  it('every non-initial run state is reachable', () => {
    const targets = new Set(Object.values(RUN_TRANSITIONS).flat());
    for (const state of RUN_STATES.filter((s) => s !== 'queued')) {
      expect(targets.has(state)).toBe(true);
    }
  });
});
