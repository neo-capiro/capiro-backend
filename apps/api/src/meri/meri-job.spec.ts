import {
  MERI_JOB_STATUSES,
  meriJobDeliverables,
  meriJobKind,
  meriJobView,
  projectMeriJobStatus,
} from './meri-job.js';
import { RESEARCH_OBSERVER_STATUS } from './research-observer-projection.js';
import * as coordinatorModule from './meri-research-coordinator.js';

const now = new Date().toISOString();
const run = (status: string, extra: Record<string, unknown> = {}) => ({
  run: {
    id: 'run-1',
    leaseEpoch: 1,
    eventSequence: 0,
    phase: 'research',
    status,
    stage: 'Gathering evidence',
    startedAt: now,
    heartbeatAt: now,
    ...extra,
  },
});

describe('Meri job status projection (Stage 2 §5.1)', () => {
  it.each([
    ['a new session waiting for its first start', 'plan', run('interrupted', { phase: 'plan', readyToStart: true }), 'queued'],
    ['a session with no run state', 'plan', {}, 'queued'],
    ['planning', 'plan', run('running', { phase: 'plan' }), 'planning'],
    ['gathering evidence', 'researching', run('running'), 'executing'],
    ['writing the report', 'researching', run('running', { stage: RESEARCH_OBSERVER_STATUS.writingReport }), 'finalizing'],
    ['checking the report', 'researching', run('running', { stage: RESEARCH_OBSERVER_STATUS.checkingReport }), 'finalizing'],
    ['saving the report', 'researching', run('running', { stage: RESEARCH_OBSERVER_STATUS.savingReport }), 'finalizing'],
    // The observer's fallback note covers provider thinking and the bounded
    // child reviews, i.e. most of evidence gathering, not the end of the run.
    ['provider thinking while gathering', 'researching', run('running', { stage: RESEARCH_OBSERVER_STATUS.preparingReport }), 'executing'],
    ['clarifying questions', 'awaiting_clarification', run('awaiting_clarification', { phase: 'plan' }), 'waiting_for_user'],
    ['a stop that has not been observed', 'researching', run('cancel_requested'), 'cancel_requested'],
    ['an observed stop', 'cancelled', run('cancelled'), 'cancelled'],
    ['a stop recorded on the column only', 'cancelled', {}, 'cancelled'],
    ['a complete report', 'complete', run('complete'), 'completed'],
    ['a partial result', 'failed', run('partial'), 'partial'],
    ['a failed run', 'failed', run('failed'), 'failed'],
    ['a run interrupted by steering', 'researching', run('interrupted', { readyToStart: true }), 'queued'],
    ['a legacy researching row without a run', 'researching', {}, 'executing'],
    ['a legacy failed row without a run', 'failed', {}, 'failed'],
  ])('%s', (_label, status, metadata, expected) => {
    expect(projectMeriJobStatus({ status, metadata })).toBe(expected);
  });

  it('a run whose worker stopped heartbeating reads as queued, awaiting a signed-in resume', () => {
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    const view = meriJobView({
      status: 'researching',
      metadata: run('running', { heartbeatAt: stale }),
    });
    expect(view).toMatchObject({ status: 'queued', awaitingStart: true });
  });

  it('a step waiting for approval puts the job in waiting_for_user', () => {
    const spy = jest
      .spyOn(coordinatorModule, 'readDurableResearchCoordinator')
      .mockReturnValueOnce({ steps: [{ outcome: 'waiting_for_approval' }] } as never);
    expect(projectMeriJobStatus({ status: 'researching', metadata: run('interrupted') })).toBe(
      'waiting_for_user',
    );
    spy.mockRestore();
  });

  it.each([
    ['a running run', run('running'), 'executing'],
    ['a failed run', run('failed'), 'failed'],
  ])('an approval-gated proposal step does not mask %s', (_label, metadata, expected) => {
    const spy = jest
      .spyOn(coordinatorModule, 'readDurableResearchCoordinator')
      .mockReturnValue({ steps: [{ outcome: 'waiting_for_approval' }] } as never);
    expect(projectMeriJobStatus({ status: 'researching', metadata })).toBe(expected);
    spy.mockRestore();
  });

  it('a malformed coordinator never breaks the projection', () => {
    const metadata = { ...run('interrupted'), durableCoordinator: { version: 1, steps: 'junk' } };
    expect(projectMeriJobStatus({ status: 'researching', metadata })).toBe('queued');
  });

  it('only ever returns a declared status', () => {
    for (const status of ['plan', 'researching', 'complete', 'failed', 'cancelled', 'unknown'])
      for (const state of ['running', 'interrupted', 'complete', 'failed', 'bogus'])
        expect(MERI_JOB_STATUSES).toContain(projectMeriJobStatus({ status, metadata: run(state) }));
  });
});

describe('Meri job kind and deliverables', () => {
  it('unknown or missing kinds read as research', () => {
    expect(meriJobKind(undefined)).toBe('research');
    expect(meriJobKind('payroll')).toBe('research');
    expect(meriJobKind('deliverable')).toBe('deliverable');
  });

  it('keeps only well-formed deliverables', () => {
    expect(
      meriJobDeliverables([
        { format: 'docx', title: ' Office brief ', artifactId: 'a-1' },
        { format: 'xlsx', title: 'Marks comparison' },
        { format: 'exe', title: 'Nope' },
        { format: 'pptx', title: '' },
        'junk',
      ]),
    ).toEqual([
      { format: 'docx', title: 'Office brief', artifactId: 'a-1' },
      { format: 'xlsx', title: 'Marks comparison', artifactId: null },
    ]);
    expect(meriJobDeliverables({})).toEqual([]);
  });

  it('builds the job view from the stored columns', () => {
    expect(
      meriJobView({
        status: 'complete',
        metadata: run('complete'),
        kind: 'deliverable',
        goalRevision: 2,
        deliverables: [{ format: 'docx', title: 'Brief', artifactId: 'a-1' }],
      }),
    ).toEqual({
      kind: 'deliverable',
      status: 'completed',
      goalRevision: 2,
      deliverables: [{ format: 'docx', title: 'Brief', artifactId: 'a-1' }],
      awaitingStart: false,
    });
    expect(meriJobView({ status: 'plan', metadata: {}, goalRevision: -1 })).toMatchObject({
      kind: 'research',
      goalRevision: 0,
    });
  });
});
