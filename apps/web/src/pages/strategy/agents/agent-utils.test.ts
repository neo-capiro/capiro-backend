/*
 * Stage F agent-surface pure helpers — risk ladder, op → readable diff, run
 * findings flattening and the tolerant normalizers. Matches the Stage D/E
 * context-utils test idiom (pure logic, no jsdom render).
 */
import { describe, expect, it } from 'vitest';
import {
  canShowWatchRail,
  extractRunFindings,
  findWatchMission,
  httpStatus,
  isStaleApplyConflict,
  normalizeChangeSets,
  normalizeMissions,
  normalizeRunCheck,
  opDiff,
  requiresImpactSummary,
  riskColors,
} from './agent-utils.js';
import type { ChangeSetRisk, StrategyNode } from '../types.js';

const node = (over: Partial<StrategyNode>): StrategyNode => ({
  id: 'n1',
  strategyId: 's1',
  kind: 'action',
  subject: 'deliverable',
  title: 'Submit the white paper',
  note: null,
  ownerUserId: 'u1',
  status: 'draft',
  startsOn: '2026-08-01',
  endsOn: '2026-08-15',
  openEnded: false,
  dependsOnIds: [],
  provenance: null,
  meriAuthored: false,
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
  ...over,
});

describe('risk ladder', () => {
  it('maps each risk to a distinct badge palette (low green / medium amber / high orange / critical red)', () => {
    const risks: ChangeSetRisk[] = ['low', 'medium', 'high', 'critical'];
    const fgs = risks.map((r) => riskColors(r).fg);
    expect(new Set(fgs).size).toBe(4);
    expect(riskColors('low').fg).toBe('var(--success)');
    expect(riskColors('medium').fg).toBe('var(--notable)');
    expect(riskColors('high').fg).toBe('#A14D12'); // orange (no orange Chip tone)
    expect(riskColors('critical').fg).toBe('var(--critical)');
  });

  it('requires an impact summary ONLY for critical (13_agent_permissions ladder)', () => {
    expect(requiresImpactSummary('critical')).toBe(true);
    expect(requiresImpactSummary('high')).toBe(false);
    expect(requiresImpactSummary('medium')).toBe(false);
    expect(requiresImpactSummary('low')).toBe(false);
  });
});

describe('opDiff', () => {
  const nodes = new Map([['n1', node({})]]);

  it('update: derives before-values from the current node and elides unchanged fields', () => {
    const d = opDiff(
      { op: 'update', nodeId: 'n1', title: 'Submit the FINAL white paper', status: 'draft' },
      nodes,
    );
    expect(d.verb).toBe('Update');
    expect(d.nodeTitle).toBe('Submit the white paper');
    expect(d.unknownNode).toBe(false);
    // status is unchanged (draft → draft) — elided; title shows before → after.
    expect(d.changes).toEqual([
      { field: 'Title', before: 'Submit the white paper', after: 'Submit the FINAL white paper' },
    ]);
  });

  it('retime: shows both date moves with before/after', () => {
    const d = opDiff({ op: 'retime', nodeId: 'n1', startsOn: '2026-09-01', endsOn: '2026-09-15' }, nodes);
    expect(d.verb).toBe('Re-time');
    expect(d.changes).toEqual([
      { field: 'Starts', before: '2026-08-01', after: '2026-09-01' },
      { field: 'Ends', before: '2026-08-15', after: '2026-09-15' },
    ]);
  });

  it('add: after-only changes, title taken from the op', () => {
    const d = opDiff(
      { op: 'add', title: 'Flag a CR risk', kind: 'risk', startsOn: '2026-10-01', dependsOn: ['n1'] },
      nodes,
    );
    expect(d.verb).toBe('Add step');
    expect(d.nodeTitle).toBe('Flag a CR risk');
    expect(d.changes).toContainEqual({ field: 'Title', before: null, after: 'Flag a CR risk' });
    expect(d.changes).toContainEqual({ field: 'Depends on', before: null, after: '1 dependency' });
    expect(d.changes.every((c) => c.before === null)).toBe(true);
  });

  it('remove: no field changes; a node missing from the CURRENT plan flags unknownNode', () => {
    const removed = opDiff({ op: 'remove', nodeId: 'n1' }, nodes);
    expect(removed.verb).toBe('Remove');
    expect(removed.changes).toEqual([]);

    const gone = opDiff({ op: 'update', nodeId: 'n-gone', title: 'New title' }, nodes);
    expect(gone.unknownNode).toBe(true);
    expect(gone.nodeTitle).toBe('New title'); // falls back to the op's title
    // Before-side is not derivable — renders after-only.
    expect(gone.changes).toEqual([{ field: 'Title', before: null, after: 'New title' }]);
  });

  it('formats null → em-dash and booleans → yes/no', () => {
    const d = opDiff({ op: 'update', nodeId: 'n1', endsOn: null, openEnded: true }, nodes);
    expect(d.changes).toContainEqual({ field: 'Ends', before: '2026-08-15', after: '—' });
    expect(d.changes).toContainEqual({ field: 'Ongoing', before: 'no', after: 'yes' });
  });
});

describe('extractRunFindings', () => {
  it('flattens a keyed findings object: arrays of violation-shaped items + string notes', () => {
    const out = extractRunFindings({
      violations: [
        { code: 'DEADLINE_PAST', severity: 'error', message: 'Ask lands after the markup', nodeIds: ['n1'] },
        { severity: 'warning', message: 'Two steps overlap', suggestion: 'Stagger them' },
      ],
      summary: 'One hard deadline problem.',
    });
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      code: 'DEADLINE_PAST',
      severity: 'error',
      message: 'Ask lands after the markup',
      nodeIds: ['n1'],
    });
    expect(out[1]!.suggestion).toBe('Stagger them');
    expect(out[2]).toEqual({ code: 'summary', severity: 'info', message: 'One hard deadline problem.' });
  });

  it("maps a watcher 'critical' finding to the top display tier, not info", () => {
    // Watcher scale is 'info'|'warning'|'critical' (see api-strategy
    // watcher-checks FINDING_SEVERITIES); critical must NOT degrade to info.
    const out = extractRunFindings({
      checks: [
        { code: 'firm-calendar-review', severity: 'critical', message: 'Recess window moved' },
        { code: 'stale-step', severity: 'info', message: 'Step untouched for 30 days' },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      code: 'firm-calendar-review',
      severity: 'error',
      message: 'Recess window moved',
    });
    expect(out[1]!.severity).toBe('info');
  });

  it("skips the watcher envelope's checkedOn date instead of faking an info finding", () => {
    // WatcherService persists { checkedOn: 'YYYY-MM-DD', findings: […] } — the
    // date is envelope metadata, not a finding, and must not lead the review
    // queue's findings block as a bare-date bullet.
    const out = extractRunFindings({
      checkedOn: '2026-07-24',
      findings: [{ code: 'stale-step', severity: 'info', message: 'Step untouched for 30 days' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toBe('Step untouched for 30 days');
    expect(out.some((f) => f.message === '2026-07-24')).toBe(false);
    // Zero-findings run: nothing to show, not one date row.
    expect(extractRunFindings({ checkedOn: '2026-07-24', findings: [] })).toEqual([]);
  });

  it('accepts a bare array, defaults unknown severity to info, and degrades junk to []', () => {
    const out = extractRunFindings([{ message: 'note', severity: 'weird' }, 'plain string', 42]);
    expect(out).toHaveLength(2);
    expect(out[0]!.severity).toBe('info');
    expect(out[1]).toEqual({ code: null, severity: 'info', message: 'plain string' });
    expect(extractRunFindings(null)).toEqual([]);
    expect(extractRunFindings('nope')).toEqual([]);
  });
});

describe('normalizeChangeSets', () => {
  const row = {
    id: 'cs1',
    strategyId: 's1',
    runId: 'r1',
    summary: 'Push the ask a quarter',
    ops: [{ op: 'retime', nodeId: 'n1', startsOn: '2026-09-01' }],
    approvedOps: null,
    risk: 'medium',
    status: 'proposed',
    strategyVersionId: 'v1',
    createdByUserId: null,
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
  };

  it('accepts a bare array and envelopes; drops rows without id/strategyId', () => {
    expect(normalizeChangeSets([row])).toHaveLength(1);
    expect(normalizeChangeSets({ changeSets: [row] })).toHaveLength(1);
    expect(normalizeChangeSets({ items: [row] })).toHaveLength(1);
    expect(normalizeChangeSets([{ id: 'x' }, 42, null])).toEqual([]);
    expect(normalizeChangeSets(null)).toEqual([]);
  });

  it('degrades an UNKNOWN risk up to critical (forces the impact confirmation), unknown status to proposed', () => {
    const [out] = normalizeChangeSets([{ ...row, risk: 'bogus', status: 'bogus' }]);
    expect(out!.risk).toBe('critical');
    expect(out!.status).toBe('proposed');
  });

  it('tolerates non-array ops and keeps the approvedOps subset', () => {
    const [out] = normalizeChangeSets([{ ...row, ops: 'junk', approvedOps: [{ op: 'remove', nodeId: 'n1' }] }]);
    expect(out!.ops).toEqual([]);
    expect(out!.approvedOps).toHaveLength(1);
  });
});

describe('normalizeRunCheck', () => {
  it('accepts a { run, changeSets } envelope and lifts ids + findings', () => {
    const out = normalizeRunCheck({
      run: { id: 'r1', missionId: 'm1', state: 'ready_for_review', findings: { notes: ['ok'] } },
      changeSets: [{ id: 'cs1' }, { id: 'cs2' }, { notId: 'x' }],
    });
    expect(out.run?.id).toBe('r1');
    expect(out.changeSetIds).toEqual(['cs1', 'cs2']);
    expect(out.findings).toEqual([{ code: 'notes', severity: 'info', message: 'ok' }]);
  });

  it('accepts the shipped endpoint shape { runId, findings, changeSetsProposed }', () => {
    // WatcherService.runCheckNow's verbatim response — no `run` row, ids under
    // `changeSetsProposed`. The rail's queued-proposals notice keys off these.
    const out = normalizeRunCheck({
      runId: 'r1',
      findings: [{ code: 'deadline', severity: 'warning', message: 'FY27 markup in 5 days' }],
      changeSetsProposed: ['cs1', 'cs2', 42],
    });
    // `runId` must lift into a run row (the drift bug left run null here).
    expect(out.run?.id).toBe('r1');
    // The endpoint's findings ARRAY must not leak onto the run row (that field
    // is the sp_agent_run.findings OBJECT shape).
    expect(out.run?.findings).toBeNull();
    expect(out.changeSetIds).toEqual(['cs1', 'cs2']);
    expect(out.findings).toEqual([
      { code: 'deadline', severity: 'warning', message: 'FY27 markup in 5 days' },
    ]);
  });

  it('accepts a bare run row (findings read off the run) and degrades junk', () => {
    const out = normalizeRunCheck({ id: 'r2', missionId: 'm1', state: 'completed', findings: { summary: 'fine' } });
    expect(out.run?.state).toBe('completed');
    expect(out.findings[0]!.message).toBe('fine');
    expect(out.changeSetIds).toEqual([]);
    expect(normalizeRunCheck(null)).toEqual({ run: null, findings: [], changeSetIds: [] });
  });
});

describe('missions', () => {
  it('normalizes envelopes and finds the newest NON-TERMINAL watch mission for a strategy', () => {
    const missions = normalizeMissions({
      missions: [
        { id: 'm3', strategyId: 's1', name: 'Keep this strategy on track', state: 'canceled' },
        { id: 'm2', strategyId: 's1', name: 'Keep this strategy on track', state: 'paused', cadence: 'daily' },
        { id: 'm1', strategyId: 's2', name: 'Other', state: 'active' },
      ],
    });
    expect(missions).toHaveLength(3);
    // m3 is terminal → skipped; m2 (list order) wins for s1.
    expect(findWatchMission(missions, 's1')?.id).toBe('m2');
    expect(findWatchMission(missions, 's1')?.cadence).toBe('daily');
    expect(findWatchMission(missions, 's9')).toBeNull();
  });

  it('defaults unknown mission state to draft and non-cadence values to null', () => {
    const [m] = normalizeMissions([{ id: 'm1', name: 'X', state: 'bogus', cadence: 'hourly' }]);
    expect(m!.state).toBe('draft');
    expect(m!.cadence).toBeNull();
  });
});

describe('canShowWatchRail (Watch-rail visibility contract)', () => {
  it('shown only when agenticMeri AND strategyWatcher are both on', () => {
    expect(canShowWatchRail({ agenticMeri: true, strategyWatcher: true })).toBe(true);
  });

  it('hidden when strategyWatcher is off/unset even with agenticMeri on — the lying-toggle bug: run-check stacks StrategyWatcherGuard (403s) and the scheduler skips quietly', () => {
    expect(canShowWatchRail({ agenticMeri: true })).toBe(false);
    expect(canShowWatchRail({ agenticMeri: true, strategyWatcher: false })).toBe(false);
  });

  it('hidden when agenticMeri is off even with strategyWatcher on (class-level AgenticGuard)', () => {
    expect(canShowWatchRail({ strategyWatcher: true })).toBe(false);
  });

  it('degrades to hidden on an older cached /me shape (features absent)', () => {
    expect(canShowWatchRail(undefined)).toBe(false);
    expect(canShowWatchRail({})).toBe(false);
  });
});

describe('httpStatus', () => {
  it('reads a duck-typed axios error and returns null otherwise', () => {
    expect(httpStatus({ response: { status: 409 } })).toBe(409);
    expect(httpStatus(new Error('nope'))).toBeNull();
    expect(httpStatus(null)).toBeNull();
  });
});

describe('isStaleApplyConflict (apply-409 disambiguation by response body)', () => {
  const conflict = (message: string) => ({
    response: { status: 409, data: { message, error: 'Conflict', statusCode: 409 } },
  });

  it('true for the stale-head 409 (fresh mark and the already-stale status read)', () => {
    expect(isStaleApplyConflict(conflict('plan changed since this was proposed — regenerate'))).toBe(true);
    expect(isStaleApplyConflict(conflict('Change-set is stale — approve it before applying'))).toBe(true);
  });

  it('false when a concurrent reviewer won the race — applied/rejected must NOT read as "regenerate"', () => {
    expect(isStaleApplyConflict(conflict('Change-set is applied — approve it before applying'))).toBe(false);
    expect(isStaleApplyConflict(conflict('Change-set is rejected — approve it before applying'))).toBe(false);
    expect(isStaleApplyConflict(conflict('Change-set is proposed — approve it before applying'))).toBe(false);
  });

  it('false for a bodyless 409 (never claim staleness the server did not assert)', () => {
    expect(isStaleApplyConflict({ response: { status: 409 } })).toBe(false);
    expect(
      isStaleApplyConflict({ response: { status: 409 }, message: 'Request failed with status code 409' }),
    ).toBe(false);
  });

  it('false for non-409s even with a stale-looking body, and for non-errors', () => {
    expect(
      isStaleApplyConflict({
        response: { status: 500, data: { message: 'plan changed since this was proposed — regenerate' } },
      }),
    ).toBe(false);
    expect(isStaleApplyConflict(new Error('plan changed'))).toBe(false);
    expect(isStaleApplyConflict(null)).toBe(false);
  });
});
