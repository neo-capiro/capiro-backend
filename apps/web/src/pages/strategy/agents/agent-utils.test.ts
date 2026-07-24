/*
 * Stage F agent-surface pure helpers — risk ladder, op → readable diff, run
 * findings flattening and the tolerant normalizers. Matches the Stage D/E
 * context-utils test idiom (pure logic, no jsdom render).
 */
import { describe, expect, it } from 'vitest';
import {
  canShowWatchRail,
  classifyWaitingReason,
  EXECUTION_MISSION_NAME,
  extractExecutionTasks,
  extractRunFindings,
  findExecutionMission,
  findWatchMission,
  httpStatus,
  WATCH_MISSION_NAME,
  isAwaitingSendApproval,
  isPriorApprovalInvalidated,
  isStaleApplyConflict,
  normalizeChangeSets,
  normalizeExecutionRuns,
  normalizeMissions,
  normalizeRunCheck,
  opDiff,
  requiresImpactSummary,
  riskColors,
  sendApprovalTask,
} from './agent-utils.js';
import type { ChangeSetRisk, ExecutionRun, StrategyNode } from '../types.js';

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
  targetRef: null,
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

  it('name-scopes the two finders so one strategy can carry BOTH a Watch and an Execution mission with no cross-match', () => {
    const missions = normalizeMissions([
      { id: 'w1', strategyId: 's1', name: WATCH_MISSION_NAME, state: 'active', cadence: 'daily' },
      { id: 'e1', strategyId: 's1', name: EXECUTION_MISSION_NAME, state: 'active' },
    ]);
    // Each finder returns ONLY its own mandate. Without the name predicate the
    // Watch rail would pause / run-check the Stage G execution mission (and the
    // node-agent affordance would anchor its run on the Watch mission).
    expect(findWatchMission(missions, 's1')?.id).toBe('w1');
    expect(findExecutionMission(missions, 's1')?.id).toBe('e1');
  });

  it('findExecutionMission skips terminal missions, reuses a live one, and never crosses strategy or the Watch mandate', () => {
    const missions = normalizeMissions([
      { id: 'e0', strategyId: 's1', name: EXECUTION_MISSION_NAME, state: 'completed' },
      { id: 'e1', strategyId: 's1', name: EXECUTION_MISSION_NAME, state: 'paused' },
      { id: 'w2', strategyId: 's2', name: WATCH_MISSION_NAME, state: 'active' },
    ]);
    // Terminal 'completed' skipped; the live (paused) mandate is reusable — the
    // editor activates it before planning.
    expect(findExecutionMission(missions, 's1')?.id).toBe('e1');
    // A different strategy's Watch mission is never returned as an execution one,
    // and a strategy with no execution mandate resolves to null (create-on-demand).
    expect(findExecutionMission(missions, 's2')).toBeNull();
    expect(findExecutionMission(missions, 's3')).toBeNull();
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

// ---- Stage G: execution helpers ---------------------------------------------

describe('classifyWaitingReason (execution blocked-state, precise reason preserved)', () => {
  it('routes each parked reason to its kind + label and carries the verbatim reason', () => {
    expect(classifyWaitingReason('awaiting send approval').kind).toBe('send_approval');
    expect(classifyWaitingReason('Execution requires an interactive session')).toMatchObject({
      kind: 'interactive_session',
      reason: 'Execution requires an interactive session',
    });
    expect(classifyWaitingReason('open material conflict blocks this').kind).toBe('material_conflict');
    expect(classifyWaitingReason('plan changed since planning (version drift)').kind).toBe(
      'version_drift',
    );
    expect(classifyWaitingReason('node is ineligible for execution').kind).toBe('ineligible');
  });

  it('degrades an unknown/empty reason to "other" with a sane default (never a blank blocked state)', () => {
    const empty = classifyWaitingReason(null);
    expect(empty.kind).toBe('other');
    expect(empty.reason).toBe('Waiting for input.');
    expect(classifyWaitingReason('something odd').kind).toBe('other');
  });
});

describe('extractExecutionTasks', () => {
  it('lifts tasks from a { tasks: [...] } envelope and drops non-task values', () => {
    const out = extractExecutionTasks({
      summary: 'x',
      tasks: [
        { type: 'workspace_draft', title: 'WP', status: 'staged', artifactRef: 'ws-1' },
        { type: 'await_send_approval', send: { subject: 'Hi', recipients: ['a', 'b'] } },
        { type: 'not-a-type' },
        42,
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: 'workspace_draft', status: 'staged', artifactRef: 'ws-1' });
    // await_send_approval carries a normalized send preview; title falls back to subject.
    expect(out[1]!.type).toBe('await_send_approval');
    expect(out[1]!.title).toBe('Hi');
    expect(out[1]!.send?.recipients).toEqual(['a', 'b']);
  });

  it('accepts a bare array, assigns fallback ids, and defaults unknown status to planned', () => {
    const out = extractExecutionTasks([{ type: 'outreach_record' }]);
    expect(out[0]!.id).toBe('task-0');
    expect(out[0]!.status).toBe('planned');
    expect(extractExecutionTasks(null)).toEqual([]);
  });

  // The SHIPPED backend contract (execution.service.ts): reviewed tasks are only
  // { type, nodeId, detail } — the outcome lands under findings.results[
  // `nodeId:type`] and a pending send's preview under findings.sendApproval.
  // Before the cross-reference fix every row read 'planned'/'Untitled task' with
  // no artifact link, and the send preview was 'unavailable'.
  it('reads status/artifactRef/title off findings.results, not inline on the task', () => {
    const out = extractExecutionTasks({
      tasks: [
        { type: 'workspace_draft', nodeId: 'N1', detail: { docTitle: 'FY27 white paper', product: 'appropriations' } },
        { type: 'outreach_record', nodeId: 'N2', detail: { title: 'Sign-on ask', subject: 'member' } },
      ],
      results: {
        'N1:workspace_draft': { status: 'already_staged', artifactRef: 'ws-9' },
        'N2:outreach_record': { status: 'staged', artifactRef: 'out-9' },
      },
    });
    expect(out).toHaveLength(2);
    // already_staged folds to the terminal 'staged'; title comes from detail.docTitle.
    expect(out[0]).toMatchObject({
      type: 'workspace_draft',
      title: 'FY27 white paper',
      status: 'staged',
      artifactRef: 'ws-9',
    });
    expect(out[1]).toMatchObject({
      type: 'outreach_record',
      title: 'Sign-on ask',
      status: 'staged',
      artifactRef: 'out-9',
    });
  });

  it('lifts the await_send_approval preview from findings.sendApproval (input.* + token)', () => {
    const [send] = extractExecutionTasks({
      tasks: [{ type: 'await_send_approval', nodeId: 'N2', detail: { subject: 'member' } }],
      results: { 'N2:await_send_approval': { status: 'awaiting_send_approval' } },
      sendApproval: {
        token: 'sha-abc',
        tokenRunId: 'run-1',
        input: {
          message: 'Outreach regarding: FY27 sign-on',
          recipients: ['member', 'committee'],
          ask: 'Co-sign the FY27 letter',
          windowStart: '2026-08-01',
          windowEnd: '2026-08-15',
        },
        artifactRef: 'out-9',
        status: 'pending',
        sendEnabled: false,
      },
    });
    // awaiting_send_approval → the display 'awaiting_approval' status.
    expect(send!.status).toBe('awaiting_approval');
    // The preview is wired from input.* (message → body, joined window) + token.
    expect(send!.send).toMatchObject({
      body: 'Outreach regarding: FY27 sign-on',
      recipients: ['member', 'committee'],
      ask: 'Co-sign the FY27 letter',
      window: '2026-08-01 – 2026-08-15',
      approvalToken: 'sha-abc',
      contentHash: 'sha-abc',
      approvedContentHash: null,
    });
  });

  it('surfaces a do-not-contact block: blocked outreach + skipped send with reasons', () => {
    const out = extractExecutionTasks({
      tasks: [
        { type: 'outreach_record', nodeId: 'N3', detail: { title: 'Ask', subject: 'member' } },
        { type: 'await_send_approval', nodeId: 'N3', detail: { subject: 'member' } },
      ],
      results: {
        'N3:outreach_record': { status: 'blocked', reason: 'client constraint: "do not contact"' },
        'N3:await_send_approval': { status: 'skipped', reason: 'outreach blocked' },
      },
    });
    expect(out[0]).toMatchObject({ status: 'blocked', blockedReason: 'client constraint: "do not contact"' });
    expect(out[1]).toMatchObject({ status: 'skipped', blockedReason: 'outreach blocked' });
    // No sendApproval on the findings ⇒ the skipped send carries no preview.
    expect(out[1]!.send).toBeNull();
  });

  it('a projected run parks a usable send-approval task (sendApprovalTask non-null)', () => {
    const [run] = normalizeExecutionRuns([
      {
        id: 'exec-9',
        missionId: 'm1',
        strategyId: 's1',
        state: 'waiting_for_input',
        trigger: 'manual',
        waitingReason: 'awaiting send approval',
        findings: {
          execution: { kind: 'outreach', nodeId: 'N2' },
          tasks: [
            { type: 'outreach_record', nodeId: 'N2', detail: { title: 'Sign-on ask', subject: 'member' } },
            { type: 'await_send_approval', nodeId: 'N2', detail: { subject: 'member' } },
          ],
          results: {
            'N2:outreach_record': { status: 'staged', artifactRef: 'out-9' },
            'N2:await_send_approval': { status: 'awaiting_send_approval' },
          },
          sendApproval: {
            token: 'sha-xyz',
            input: { message: 'Outreach regarding: X', recipients: ['member'], ask: 'Co-sign', windowStart: '2026-08-01', windowEnd: null },
          },
        },
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    ]);
    expect(isAwaitingSendApproval(run as ExecutionRun)).toBe(true);
    const task = sendApprovalTask(run as ExecutionRun);
    expect(task).not.toBeNull();
    expect(task!.send?.body).toBe('Outreach regarding: X');
    // A one-sided window degrades to the single bound (no dangling en-dash).
    expect(task!.send?.window).toBe('2026-08-01');
    // The staged outreach row links out (artifactRef lifted from results).
    expect(run!.tasks[0]!.artifactRef).toBe('out-9');
  });
});

describe('normalizeExecutionRuns + send-approval helpers', () => {
  const runRow = {
    id: 'exec-1',
    missionId: 'm1',
    strategyId: 's1',
    state: 'waiting_for_input',
    trigger: 'manual',
    waitingReason: 'awaiting send approval',
    findings: {
      summary: 'Stage the ask',
      tasks: [
        {
          type: 'await_send_approval',
          title: 'Sign-on ask',
          status: 'awaiting_approval',
          send: {
            subject: 'Co-sign',
            recipients: [{ name: 'Office A' }, 'Office B'],
            contentHash: 'h2',
            approvedContentHash: 'h1',
          },
        },
      ],
    },
    createdAt: '2026-07-24T00:00:00.000Z',
  };

  it('projects a run row with its tasks + summary lifted out of findings', () => {
    const [run] = normalizeExecutionRuns({ runs: [runRow] });
    expect(run!.summary).toBe('Stage the ask');
    expect(run!.tasks).toHaveLength(1);
    // Recipients coerce {name}|string → string[].
    expect(run!.tasks[0]!.send?.recipients).toEqual(['Office A', 'Office B']);
    expect(normalizeExecutionRuns(null)).toEqual([]);
  });

  it('isAwaitingSendApproval + sendApprovalTask key off the parked reason', () => {
    const [run] = normalizeExecutionRuns([runRow]);
    expect(isAwaitingSendApproval(run as ExecutionRun)).toBe(true);
    expect(sendApprovalTask(run as ExecutionRun)?.type).toBe('await_send_approval');
  });

  it('isPriorApprovalInvalidated: true only when a prior approval hash differs from the current content', () => {
    const [run] = normalizeExecutionRuns([runRow]);
    // approvedContentHash 'h1' !== contentHash 'h2' ⇒ prior approval stale.
    expect(isPriorApprovalInvalidated(sendApprovalTask(run as ExecutionRun)!.send)).toBe(true);
    expect(isPriorApprovalInvalidated({ ...sendApprovalTask(run as ExecutionRun)!.send!, approvedContentHash: null })).toBe(
      false,
    );
    expect(isPriorApprovalInvalidated(null)).toBe(false);
  });
});
