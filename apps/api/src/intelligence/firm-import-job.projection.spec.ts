import {
  IMPORT_JOB_STALE_AFTER_SECONDS,
  importRequestSha256,
  normalizeImportSelection,
  projectImportJob,
  type ImportItemProjectionInput,
} from './firm-import-job.contracts.js';

const item = (ldaClientId: number, outcome: ImportItemProjectionInput['outcome']) => ({
  ldaClientId,
  outcome,
});

describe('firm import job projection', () => {
  const now = new Date('2026-10-30T12:00:00.000Z');

  it('derives terminal completion and counts from item rows only', () => {
    const projection = projectImportJob(
      {
        status: 'running',
        updatedAt: new Date('2026-10-30T11:59:00.000Z'),
        items: [item(10, 'created'), item(11, 'created'), item(12, 'already_present')],
      },
      now,
    );

    expect(projection).toMatchObject({
      status: 'completed',
      terminal: true,
      stale: false,
      total: 3,
      processed: 3,
      successful: 3,
      rejected: 0,
      outstanding: 0,
      created: 2,
      alreadyPresent: 1,
    });
  });

  it('reports partial results truthfully when some items are rejected', () => {
    const projection = projectImportJob(
      {
        status: 'running',
        updatedAt: now,
        items: [item(10, 'created'), item(11, 'rejected'), item(12, 'already_present')],
      },
      now,
    );

    expect(projection.status).toBe('partially_completed');
    expect(projection.terminal).toBe(true);
    expect(projection.processed).toBe(3);
    expect(projection.successful).toBe(2);
    expect(projection.rejected).toBe(1);
  });

  it('is failed only when every item was rejected', () => {
    const projection = projectImportJob(
      {
        status: 'running',
        updatedAt: now,
        items: [item(10, 'rejected'), item(11, 'rejected')],
      },
      now,
    );
    expect(projection.status).toBe('failed');
    expect(projection.terminal).toBe(true);
  });

  it('never turns unfinished or crashed work into a terminal state', () => {
    const projection = projectImportJob(
      {
        // A persisted terminal status cannot be trusted while rows are pending.
        status: 'completed',
        updatedAt: new Date('2026-10-30T10:00:00.000Z'),
        items: [item(10, 'created'), item(11, 'pending')],
      },
      now,
    );

    expect(projection.status).toBe('running');
    expect(projection.terminal).toBe(false);
    expect(projection.outstanding).toBe(1);
    expect(projection.processed).toBe(1);
    expect(projection.successful).toBe(1);
  });

  it('keeps an admitted-but-unstarted job queued', () => {
    const projection = projectImportJob(
      { status: 'queued', updatedAt: now, items: [item(10, 'pending')] },
      now,
    );
    expect(projection.status).toBe('queued');
    expect(projection.terminal).toBe(false);
  });

  it('flags staleness only for non-terminal jobs', () => {
    const old = new Date(now.getTime() - (IMPORT_JOB_STALE_AFTER_SECONDS + 1) * 1000);
    const stale = projectImportJob(
      { status: 'running', updatedAt: old, items: [item(10, 'pending')] },
      now,
    );
    const finished = projectImportJob(
      { status: 'completed', updatedAt: old, items: [item(10, 'created')] },
      now,
    );

    expect(stale.stale).toBe(true);
    expect(stale.terminal).toBe(false);
    expect(finished.stale).toBe(false);
    expect(finished.terminal).toBe(true);
  });

  it('normalises the exact selection and binds the request hash to the registrant', () => {
    expect(normalizeImportSelection([12, 10, 12, Number.NaN, -1, 10.5])).toEqual([10, 12]);
    const first = importRequestSha256(7, [10, 12]);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(importRequestSha256(7, [12, 10])).toBe(first);
    expect(importRequestSha256(8, [10, 12])).not.toBe(first);
    expect(importRequestSha256(7, [10, 12, 13])).not.toBe(first);
  });
});
