import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LEASE_LOST_REASON } from '../src/hillday/hillday-job-state.js';
import type { JobUnit } from '../src/hillday/hillday.types.js';

const repoRoot = resolve(__dirname, '../../..');
const helper = require(join(repoRoot, 'scripts/testing/a1-disposable-postgres.cjs')) as {
  nativePostgresReadiness(options: { repoRoot: string }): { available: boolean; reason: string };
  createDisposableSchema(options: {
    repoRoot: string; coreSchemaPath: string; workspaceSchemaPath: string; extraModels: string;
  }): Promise<{ url: string; schema: string; cleanup(): Promise<void> }>;
};
const readiness = helper.nativePostgresReadiness({ repoRoot });
// Registered even when skipped: a missing disposable PG16 is never a native pass.
const native = readiness.available ? describe : describe.skip;

type Runtime = typeof import('./support/hillday-job-postgres-harness.js');
type Harness = Awaited<ReturnType<Runtime['createHillDayJobHarness']>>;

/**
 * WS-10 real-PostgreSQL cases: the conditional claim, lease expiry, request
 * identity uniqueness, restart recovery (a parked unit is never re-run),
 * cancellation and deliberate retry.
 *
 * `executions` counts writes to ws_hillday_meeting rows — one per executed unit,
 * and therefore one per provider call that WOULD have been issued. The model
 * credential is null in this fixture, so no provider is ever contacted and the
 * "no duplicate charge" property is measured rather than asserted rhetorically.
 */
native(`WS-10 Hill Day durable job lifecycle PostgreSQL16${readiness.available ? '' : ` [SKIP: ${readiness.reason}]`}`, () => {
  let database: Awaited<ReturnType<typeof helper.createDisposableSchema>> | undefined;
  let h: Harness | undefined;
  let runtime: Runtime;

  beforeAll(async () => {
    database = await helper.createDisposableSchema({
      repoRoot,
      coreSchemaPath: join(repoRoot, 'apps/api/prisma/schema.prisma'),
      workspaceSchemaPath: join(repoRoot, 'apps/workspace/prisma/schema.prisma'),
      extraModels: await readFile(join(__dirname, 'support/ws-source-action.fixture.prisma'), 'utf8'),
    });
    runtime = require('./support/hillday-job-postgres-harness.js') as Runtime;
    h = await runtime.createHillDayJobHarness(database.url);
  }, 240_000);

  afterAll(async () => {
    try { await h?.close(); } finally { await database?.cleanup(); }
  }, 60_000);

  beforeEach(async () => {
    await h!.db.wsHillDayJob.deleteMany({});
    h!.executions.length = 0;
  });

  const unit = (meetingId: string, state: JobUnit['state']): JobUnit =>
    ({ meetingId, state, sectionId: meetingId, reason: null, at: new Date().toISOString() });

  test('two replicas race one claim: exactly one wins, the other is busy', async () => {
    const { documentId, tenantId } = h!.ids;
    const job = await h!.db.wsHillDayJob.create({
      data: { tenantId, documentId, actorId: h!.owner, status: 'queued', units: [unit(`${documentId.slice(0, -1)}e1`, 'queued')] as never },
    });
    const [a, b] = await Promise.all([
      h!.worker.claim(job.id),
      h!.secondWorker.claim(job.id),
    ]);
    expect([a, b].filter((r) => r === 'busy')).toHaveLength(1);
    const row = await h!.leaseOf(job.id);
    expect(row?.attemptCount).toBe(1);
    expect(row?.leaseHolder).toBeTruthy();
  });

  test('a queued job is only claimable by one worker until its lease lapses', async () => {
    const { documentId, tenantId } = h!.ids;
    const job = await h!.db.wsHillDayJob.create({
      data: { tenantId, documentId, actorId: h!.owner, status: 'queued', units: [unit(`${documentId.slice(0, -1)}e1`, 'queued')] as never },
    });
    expect(await h!.worker.claim(job.id)).not.toBe('busy');
    // The job is now terminal, so a second claim cannot take it at all.
    expect(await h!.secondWorker.claim(job.id)).toBe('busy');
  });

  test('an expired lease lets another worker re-claim the job', async () => {
    const { documentId, tenantId } = h!.ids;
    const job = await h!.db.wsHillDayJob.create({
      data: {
        tenantId, documentId, actorId: h!.owner, status: 'running',
        leaseHolder: 'dead-worker-1', leaseExpiresAt: new Date(Date.now() - 60_000),
        attemptCount: 1, units: [unit('00000000-0000-4000-8000-0000000000e2', 'queued')] as never,
      },
    });
    expect(await h!.secondWorker.claim(job.id)).not.toBe('busy');
    const row = await h!.leaseOf(job.id);
    expect(row?.attemptCount).toBe(2);
    expect(row?.leaseHolder).not.toBe('dead-worker-1');
  });

  test('a unit left in flight by a dead holder is parked as unknown and its call is NOT re-issued', async () => {
    const { documentId, tenantId } = h!.ids;
    const interrupted = '00000000-0000-4000-8000-0000000000e1';
    const job = await h!.db.wsHillDayJob.create({
      data: {
        tenantId, documentId, actorId: h!.owner, status: 'running',
        leaseHolder: 'dead-worker-1', leaseExpiresAt: new Date(Date.now() - 60_000), attemptCount: 1,
        units: [unit(interrupted, 'running'), unit('00000000-0000-4000-8000-0000000000e2', 'queued')] as never,
      },
    });
    expect(await h!.secondWorker.claim(job.id)).not.toBe('busy');
    const row = await h!.leaseOf(job.id);
    const units = row!.units as unknown as JobUnit[];
    const parked = units.find((u) => u.meetingId === interrupted)!;
    expect(parked.state).toBe('unknown');
    expect(parked.reason).toBe(LEASE_LOST_REASON);
    // The interrupted unit was never executed again; the queued one was.
    expect(h!.executions).not.toContain(interrupted);
    expect(h!.executions).toContain('00000000-0000-4000-8000-0000000000e2');
  });

  test('a unit already done survives a restart and is never regenerated', async () => {
    const { documentId, tenantId } = h!.ids;
    const done = '00000000-0000-4000-8000-0000000000e1';
    const job = await h!.db.wsHillDayJob.create({
      data: {
        tenantId, documentId, actorId: h!.owner, status: 'running',
        leaseHolder: 'dead-worker-1', leaseExpiresAt: new Date(Date.now() - 60_000), attemptCount: 1,
        units: [unit(done, 'done'), unit('00000000-0000-4000-8000-0000000000e2', 'queued')] as never,
      },
    });
    await h!.secondWorker.claim(job.id);
    const row = await h!.leaseOf(job.id);
    expect((row!.units as unknown as JobUnit[]).find((u) => u.meetingId === done)!.state).toBe('done');
    expect(h!.executions).not.toContain(done);
  });

  test('exact start identity: replaying a request returns the same job, not a second one', async () => {
    const { documentId, tenantId, requestId } = h!.ids;
    const first = await h!.generation.start(tenantId, h!.owner, documentId, requestId);
    const replay = await h!.generation.start(tenantId, h!.owner, documentId, requestId);
    expect(replay.jobId).toBe(first.jobId);
    expect(await h!.db.wsHillDayJob.count({})).toBe(1);
    expect(first.status).toBe('queued');
  });

  test('request identity is unique per document: a duplicate is refused by the database', async () => {
    const { documentId, tenantId, requestId } = h!.ids;
    await h!.db.wsHillDayJob.create({
      data: { tenantId, documentId, actorId: h!.owner, status: 'queued', requestId, units: [] as never },
    });
    await expect(h!.db.wsHillDayJob.create({
      data: { tenantId, documentId, actorId: h!.owner, status: 'queued', requestId, units: [] as never },
    })).rejects.toThrow();
    // The same request id under a different document is still allowed.
    await expect(h!.db.wsHillDayJob.create({
      data: { tenantId, documentId: h!.ids.otherDocumentId, actorId: h!.owner, status: 'queued', requestId, units: [] as never },
    })).resolves.toBeTruthy();
  });

  test('cancelling a queued job cancels it outright; cancelling a running job only records the request', async () => {
    const { documentId, tenantId } = h!.ids;
    const queued = await h!.db.wsHillDayJob.create({
      data: { tenantId, documentId, actorId: h!.owner, status: 'queued', units: [unit('00000000-0000-4000-8000-0000000000e1', 'queued')] as never },
    });
    const cancelled = await h!.generation.requestCancel(tenantId, h!.owner, documentId, queued.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelRequestedAt).not.toBeNull();

    const running = await h!.db.wsHillDayJob.create({
      data: {
        tenantId, documentId, actorId: h!.owner, status: 'running',
        leaseHolder: 'live-worker-1', leaseExpiresAt: new Date(Date.now() + 60_000),
        units: [unit('00000000-0000-4000-8000-0000000000e2', 'running')] as never,
      },
    });
    const requested = await h!.generation.requestCancel(tenantId, h!.owner, documentId, running.id);
    // Honest: the in-flight provider call cannot be recalled, so the job stays running.
    expect(requested.status).toBe('running');
    expect(requested.cancelRequestedAt).not.toBeNull();
  });

  test('a claimed job with cancellation requested starts no further unit and reports cancelled', async () => {
    const { documentId, tenantId } = h!.ids;
    const job = await h!.db.wsHillDayJob.create({
      data: {
        tenantId, documentId, actorId: h!.owner, status: 'running',
        leaseHolder: 'dead-worker-1', leaseExpiresAt: new Date(Date.now() - 60_000), attemptCount: 1,
        cancelRequestedAt: new Date(),
        units: [unit('00000000-0000-4000-8000-0000000000e1', 'queued'), unit('00000000-0000-4000-8000-0000000000e2', 'queued')] as never,
      },
    });
    const result = await h!.secondWorker.claim(job.id);
    expect(result).toBe('cancelled');
    expect(h!.executions).toEqual([]);
    expect((await h!.leaseOf(job.id))?.status).toBe('cancelled');
  });

  test('deliberate retry re-queues only failed/unknown units and preserves done', async () => {
    const { documentId, tenantId } = h!.ids;
    const done = '00000000-0000-4000-8000-0000000000e1';
    const job = await h!.db.wsHillDayJob.create({
      data: {
        tenantId, documentId, actorId: h!.owner, status: 'complete', quality: 0.34,
        units: [unit(done, 'done'), unit('00000000-0000-4000-8000-0000000000e2', 'failed'), {
          ...unit('00000000-0000-4000-8000-0000000000e3', 'unknown'), reason: LEASE_LOST_REASON,
        }] as never,
      },
    });
    const retried = await h!.generation.retryFailedUnits(tenantId, h!.owner, documentId, job.id);
    expect(retried.status).toBe('queued');
    const states = retried.units.map((u) => [u.meetingId, u.state]);
    expect(states).toEqual([
      [done, 'done'],
      ['00000000-0000-4000-8000-0000000000e2', 'queued'],
      ['00000000-0000-4000-8000-0000000000e3', 'queued'],
    ]);
    expect(await h!.leaseOf(job.id)).toMatchObject({ status: 'queued', quality: null });
  });

  test('retry is refused while the job is still active and is a no-op when nothing failed', async () => {
    const { documentId, tenantId } = h!.ids;
    const active = await h!.db.wsHillDayJob.create({
      data: { tenantId, documentId, actorId: h!.owner, status: 'running', units: [unit('00000000-0000-4000-8000-0000000000e1', 'running')] as never },
    });
    await expect(h!.generation.retryFailedUnits(tenantId, h!.owner, documentId, active.id)).rejects.toMatchObject({ status: 409 });

    const clean = await h!.db.wsHillDayJob.create({
      data: { tenantId, documentId, actorId: h!.owner, status: 'complete', units: [unit('00000000-0000-4000-8000-0000000000e1', 'done')] as never },
    });
    const unchanged = await h!.generation.retryFailedUnits(tenantId, h!.owner, documentId, clean.id);
    expect(unchanged.status).toBe('complete');
    expect((await h!.leaseOf(clean.id))?.status).toBe('complete');
  });

  test('the latest-job read returns the active job and never crosses the tenant boundary', async () => {
    const { documentId, tenantId, otherDocumentId, otherTenantId } = h!.ids;
    const active = await h!.db.wsHillDayJob.create({
      data: { tenantId, documentId, actorId: h!.owner, status: 'queued', units: [] as never },
    });
    const latest = await h!.generation.latestJob(tenantId, h!.owner, documentId);
    expect(latest.job?.jobId).toBe(active.id);
    // A foreign tenant's document is not admissible at all.
    await expect(h!.generation.latestJob(otherTenantId, h!.owner, documentId)).rejects.toMatchObject({ status: 404 });
    await expect(h!.generation.latestJob(tenantId, h!.owner, otherDocumentId)).resolves.toMatchObject({ job: null });
  });
});
