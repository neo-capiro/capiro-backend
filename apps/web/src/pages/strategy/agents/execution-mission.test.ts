/*
 * Stage G execution-mission resolution helpers (pure). Covers findExecutionMission
 * and the name-scoping that keeps it and findWatchMission from cross-matching —
 * the guard that lets a strategy carry BOTH a Watch and an Execution mission at
 * once without one finder claiming the other's mandate. Same pure-logic idiom as
 * agent-utils.test.ts (no jsdom render).
 */
import { describe, expect, it } from 'vitest';
import {
  EXECUTION_MISSION_NAME,
  WATCH_MISSION_NAME,
  findExecutionMission,
  findWatchMission,
  normalizeMissions,
} from './agent-utils.js';

describe('findExecutionMission', () => {
  it('returns the newest NON-TERMINAL Execution-named mission for the strategy', () => {
    const missions = normalizeMissions([
      { id: 'x2', strategyId: 's1', name: EXECUTION_MISSION_NAME, state: 'active' },
      { id: 'x1', strategyId: 's1', name: EXECUTION_MISSION_NAME, state: 'canceled' },
    ]);
    // Draft/active/paused are live; list order (newest first) wins.
    expect(findExecutionMission(missions, 's1')?.id).toBe('x2');
    expect(findExecutionMission(missions, 's2')).toBeNull();
  });

  it('skips terminal missions (completed/failed/canceled)', () => {
    const missions = normalizeMissions([
      { id: 'x1', strategyId: 's1', name: EXECUTION_MISSION_NAME, state: 'completed' },
    ]);
    expect(findExecutionMission(missions, 's1')).toBeNull();
  });
});

describe('name-scoping: the two finders never cross-match', () => {
  it('an Execution mission is NOT returned by findWatchMission (Watch rail cannot claim the execution mandate)', () => {
    const missions = normalizeMissions([
      { id: 'e1', strategyId: 's1', name: EXECUTION_MISSION_NAME, state: 'active' },
    ]);
    expect(findWatchMission(missions, 's1')).toBeNull();
    expect(findExecutionMission(missions, 's1')?.id).toBe('e1');
  });

  it('a Watch mission is NOT returned by findExecutionMission (and vice versa) when both exist', () => {
    const missions = normalizeMissions([
      { id: 'e1', strategyId: 's1', name: EXECUTION_MISSION_NAME, state: 'active' },
      { id: 'w1', strategyId: 's1', name: WATCH_MISSION_NAME, state: 'active', cadence: 'daily' },
    ]);
    expect(findWatchMission(missions, 's1')?.id).toBe('w1');
    expect(findExecutionMission(missions, 's1')?.id).toBe('e1');
  });
});
