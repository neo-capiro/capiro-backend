import { describe, expect, it } from '@jest/globals';
import { computeReportHealth } from './report-health.js';
import { computeStrategyHealth, hasLinkedStrategyEvidence, isStrategyStepOverdue, strategyStepDueDate } from '@capiro/strategy-verifier';
import type { ReportNode } from './report.types.js';

const AS_OF = new Date('2026-09-08T23:59:59.999Z');
function node(overrides: Partial<ReportNode> = {}): ReportNode {
  return {
    id: 'node', kind: 'action', subject: 'deliverable', title: 'Plan step', note: null,
    ownerAssigned: true, ownerName: 'Owner', status: 'in_progress', startsOn: '2026-08-15',
    endsOn: '2026-09-15', openEnded: false, dependsOnIds: [], sources: [], targetLabel: null,
    ...overrides,
  };
}

describe('shared plan health and due-date policy', () => {
  it('does not claim evidence or timeliness in empty and no-gate plans', () => {
    expect(computeReportHealth([], AS_OF)).toMatchObject({ score: 0, label: 'No steps', groundingPct: null, timelinessPct: null, totalGates: 0 });
    expect(computeReportHealth([node()], AS_OF)).toMatchObject({ score: 100, groundingPct: null, totalGates: 0, datedNodes: 1 });
    expect(computeReportHealth([node({ status: 'completed' })], AS_OF)).toMatchObject({ groundingPct: null, timelinessPct: null, datedNodes: 0, overdueNodes: 0 });
  });

  it('counts source links, not arbitrary labels, and uses identical weighting for an identical evidence set', () => {
    const nodes = [
      node({ id: 'a', kind: 'gate', sources: [{ section: 'Approved source', ref: 'fact:fact-1' }] }),
      node({ id: 'b', kind: 'gate', ownerAssigned: false, endsOn: '2026-09-07', sources: [{ section: 'Unsupported label', ref: null }] }),
      node({ id: 'c', kind: 'risk', openEnded: true, ownerAssigned: false }),
    ];
    const result = computeReportHealth(nodes, AS_OF);
    expect(result).toEqual(computeStrategyHealth(nodes.map((n) => ({ ...n, hasLinkedEvidence: hasLinkedStrategyEvidence(n.sources) })), AS_OF));
    expect(result).toMatchObject({ score: 43, coveragePct: 33, groundingPct: 50, timelinessPct: 50, totalNodes: 3, groundedGates: 1, totalGates: 2, datedNodes: 2, overdueNodes: 1 });
    expect(hasLinkedStrategyEvidence([{ section: 'Calendar label', ref: 'congress:2026-floor' }])).toBe(false);
    expect(computeReportHealth([node({ kind: 'gate', sources: [{ section: 'Approved fact', ref: 'heading:Established facts', resolved: true }] })], AS_OF).groundedGates).toBe(1);
  });

  it('normalizes timestamp offsets to UTC and rejects invalid calendar timestamps', () => {
    const due = (startsOn: string | Date) => strategyStepDueDate({ startsOn, status: 'active' });
    expect(due('2026-09-08T00:00:00.000Z')).toBe(due(new Date('2026-09-08T00:00:00.000Z')));
    expect(due('2026-09-07T23:30:00-04:00')).toBe(Date.parse('2026-09-08T00:00:00Z'));
    expect(due('2026-09-08T00:30:00+02:00')).toBe(Date.parse('2026-09-07T00:00:00Z'));
    expect(due('2026-02-30T00:00:00.000Z')).toBeNull();
    expect(due('2026-09-07T00:00:00')).toBeNull();
    expect(due('2026-09-07T25:00:00.000Z')).toBeNull();
  });

  it('uses UTC days, end/start fallback, and only unfinished commitments in the dated denominator', () => {
    const nodes = [
      node({ id: 'today', endsOn: '2026-09-08' }),
      node({ id: 'single-day', startsOn: '2026-09-07', endsOn: null }),
      node({ id: 'active', status: 'active', endsOn: '2026-09-07' }),
      node({ id: 'draft', status: 'draft', endsOn: '2026-09-07' }),
      node({ id: 'suggested', status: 'suggested', endsOn: '2026-09-07' }),
      node({ id: 'completed', status: 'completed', endsOn: '2026-09-07' }),
      node({ id: 'ongoing', openEnded: true, endsOn: '2026-09-07' }),
      node({ id: 'invalid', endsOn: '2026-02-30' }),
      node({ id: 'invalid-end-no-fallback', endsOn: 'invalid', startsOn: '2026-09-07' }),
    ];
    expect(nodes.filter((n) => isStrategyStepOverdue(n, AS_OF)).map((n) => n.id)).toEqual(['single-day', 'active', 'draft']);
    expect(computeReportHealth(nodes, AS_OF)).toMatchObject({ datedNodes: 4, overdueNodes: 3, timelinessPct: 25 });
    expect(isStrategyStepOverdue({ ...nodes[1], archivedAt: '2026-09-01' }, AS_OF)).toBe(false);
    expect(isStrategyStepOverdue(nodes[1]!, new Date('invalid'))).toBe(false);
  });
});
