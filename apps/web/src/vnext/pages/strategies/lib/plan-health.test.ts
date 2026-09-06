import { describe, expect, it } from 'vitest';
import type { StrategyDetail, StrategyNode } from '../../../../pages/strategy/types.js';
import { computePlanHealth } from './plan-health.js';

const plan = (nodes: Partial<StrategyNode>[]) => ({ nodes } as StrategyDetail);

describe('Plan health date semantics', () => {
  it('counts a due-today step as on time for the whole UTC calendar day', () => {
    const result = computePlanHealth(plan([
      { startsOn: '2026-09-06', status: 'draft', kind: 'action', ownerUserId: 'u1' },
      { startsOn: '2026-09-05', status: 'active', kind: 'action', ownerUserId: 'u1' },
    ]), new Date('2026-09-06T23:59:59Z'));
    expect(result).toMatchObject({ datedSteps: 2, overdueSteps: 1 });
  });

  it('does not dilute timeliness with ongoing steps or invalid dates', () => {
    const result = computePlanHealth(plan([
      { startsOn: '2026-09-05', status: 'draft' },
      { startsOn: '2025-01-01', openEnded: true },
      { startsOn: 'invalid' },
    ]), new Date('2026-09-06T12:00:00Z'));
    expect(result).toMatchObject({ datedSteps: 1, overdueSteps: 1 });
  });
});
