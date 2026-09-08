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

  it('preserves health when Prisma Date rows are serialized by the API', () => {
    const rows = [
      { startsOn: new Date('2026-09-07T00:00:00.000Z'), endsOn: null, status: 'active', kind: 'action', ownerUserId: 'u1' },
      { startsOn: new Date('2026-09-07T00:00:00.000Z'), endsOn: new Date('2026-09-08T00:00:00.000Z'), status: 'draft', kind: 'action', ownerUserId: 'u1' },
    ];
    const fromApi = JSON.parse(JSON.stringify({ nodes: rows })) as StrategyDetail;
    const dateOnly = plan(fromApi.nodes.map((node) => ({ ...node, startsOn: node.startsOn.slice(0, 10), endsOn: node.endsOn?.slice(0, 10) ?? null })));
    const asOf = new Date('2026-09-08T23:59:59.999Z');
    expect(computePlanHealth(fromApi, asOf)).toEqual(computePlanHealth(dateOnly, asOf));
    expect(computePlanHealth(fromApi, asOf)).toMatchObject({ datedSteps: 2, overdueSteps: 1, timelinessPct: 50 });
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

describe('Health evidence and lifecycle honesty', () => {
  it('does not credit a label as a linked source and reports no-gate coverage as N/A', () => {
    const health = computePlanHealth(plan([
      { kind: 'gate', ownerUserId: 'u', provenance: { sources: [{ section: 'Calendar', ref: 'congress:floor-2026' }] } },
      { kind: 'gate', ownerUserId: 'u', provenance: { sources: [{ section: 'Source', ref: 'https://example.gov/budget' }] } },
    ]));
    expect(health).toMatchObject({ totalGates: 2, groundedGates: 1, groundingPct: 50 });
    expect(computePlanHealth(plan([]))).toMatchObject({ groundingPct: null, timelinessPct: null, score: 0 });
  });

  it('matches the report adapter for the same live nodes and internal evidence', () => {
    expect(computePlanHealth(plan([
      { kind: 'gate', ownerUserId: 'u', startsOn: '2026-08-15', endsOn: '2026-09-15', status: 'in_progress', provenance: { sources: [{ section: 'Approved source', ref: 'fact:fact-1' }] } },
      { kind: 'gate', ownerUserId: null, startsOn: '2026-08-15', endsOn: '2026-09-07', status: 'in_progress', provenance: { sources: [{ section: 'Unsupported label' }] } },
      { kind: 'risk', openEnded: true, ownerUserId: null, status: 'in_progress' },
    ]), new Date('2026-09-08T23:59:59Z'))).toMatchObject({ score: 43, groundedGates: 1, totalGates: 2, datedSteps: 2, overdueSteps: 1 });
  });

  it('excludes suggestions and completed work from both overdue count and dated denominator', () => {
    expect(computePlanHealth(plan([
      { startsOn: '2026-09-07', status: 'suggested' },
      { startsOn: '2026-09-07', status: 'completed' },
      { startsOn: '2026-09-07', status: 'active' },
      { startsOn: '2026-09-08', status: 'draft' },
      { startsOn: '2026-02-30', status: 'draft' },
    ]), new Date('2026-09-08T23:59:59Z'))).toMatchObject({ datedSteps: 2, overdueSteps: 1, timelinessPct: 50 });
  });
});
