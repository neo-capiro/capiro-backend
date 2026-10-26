import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LEASE_LOST_REASON, PROVIDER_UNCERTAIN_REASON } from '../src/hillday/hillday-job-state.js';
import type { JobUnit } from '../src/hillday/hillday.types.js';

const repoRoot = resolve(__dirname, '../../..');
/** The accepted Core137 base this PR stacks on. */
const BASE_COMMIT = 'c739cdfd580b88d9ec131aff9dc17248a4b65eb6';
const MIGRATION_SQL = join(
  repoRoot,
  'apps/workspace/prisma/migrations/20261026120000_ws_hillday_job_lifecycle/migration.sql',
);

const helper = require(join(repoRoot, 'scripts/testing/a1-disposable-postgres.cjs')) as {
  nativePostgresReadiness(options: { repoRoot: string }): { available: boolean; reason: string };
  createDisposableSchema(options: {
    repoRoot: string; coreSchemaPath: string; workspaceSchemaPath: string; extraModels: string;
  }): Promise<{ url: string; schema: string; cleanup(): Promise<void> }>;
};

/**
 * A safely quoted identifier for the fixture's OWNED schema.
 *
 * The disposable helper generates `a1_native_<24 hex>`; anything that does not
 * look like a plain identifier is REFUSED rather than interpolated into SQL.
 * The installed pg Client ignores Prisma's `?schema=` parameter, so this is what
 * actually binds a raw seed/migration session to the intended schema.
 */
function ownedSchema(schema: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error(`refusing to bind unexpected schema name: ${schema}`);
  }
  return `"${schema}"`;
}

const readiness = helper.nativePostgresReadiness({ repoRoot });
// Registered even when skipped: a missing disposable PG16 is never a native pass.
const native = readiness.available ? describe : describe.skip;

type Runtime = typeof import('./support/hillday-job-postgres-harness.js');
type Harness = Awaited<ReturnType<Runtime['createHillDayJobHarness']>>;

/**
 * WS-10 real-PostgreSQL cases.
 *
 * Shape of the fixture (this is what makes it a rollout test rather than a
 * snapshot test):
 *   1. ONE disposable schema is created from the ACCEPTED BASE datamodel, so it
 *      has the pre-migration columns and no lease/request columns at all.
 *   2. Representative PRE-migration rows are seeded into it through the ordinary
 *      role — including a `running` job with NO lease, which is exactly the row
 *      the removed in-process Set used to strand or replay.
 *   3. This PR's exact migration SQL is applied ONCE through the ordinary role.
 *   4. That SAME schema carries every case below: claim race, lease expiry,
 *      legacy null-lease recovery, request binding, two-connection late result,
 *      accepted-then-dropped provider uncertainty, cancellation and retry.
 *
 * The model provider is an injected synthetic boundary, so "how many provider
 * calls were issued" is measured directly rather than inferred from a write.
 *
 * Release owns this slot: it is NOT executed by the author.
 */
native(`WS-10 Hill Day durable job lifecycle PostgreSQL16${readiness.available ? '' : ` [SKIP: ${readiness.reason}]`}`, () => {
  let database: Awaited<ReturnType<typeof helper.createDisposableSchema>> | undefined;
  let seed: {
    query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
    connect(): Promise<void>;
    end(): Promise<void>;
  };
  let h: Harness | undefined;
  let runtime: Runtime;

  beforeAll(async () => {
    // 1. Accepted base datamodel, both schemas, read from the pinned commit.
    const base = mkdtempSync(join(tmpdir(), 'ws10-base-'));
    const gitFile = (path: string, into: string) => {
      writeFileSync(into, execFileSync('git', ['show', `${BASE_COMMIT}:${path}`], { cwd: repoRoot, encoding: 'utf8' }));
    };
    gitFile('apps/api/prisma/schema.prisma', join(base, 'core.prisma'));
    gitFile('apps/workspace/prisma/schema.prisma', join(base, 'workspace.prisma'));

    database = await helper.createDisposableSchema({
      repoRoot,
      coreSchemaPath: join(base, 'core.prisma'),
      workspaceSchemaPath: join(base, 'workspace.prisma'),
      extraModels: readFileSync(join(__dirname, 'support/ws-source-action.fixture.prisma'), 'utf8'),
    });

    // 2. Pre-migration rows, ordinary role, base columns only.
    //
    // The installed pg Client does NOT forward Prisma's `?schema=` URL parameter
    // (confirmed: schemaParameterForwarded=false, startupOptions=null), so this
    // raw session must be bound to the fixture's OWNED schema explicitly. The
    // schema name is validated before it is quoted into SQL, and the binding is
    // verified with `current_schema()` rather than assumed.
    const { Client } = require(require.resolve('pg', { paths: [join(repoRoot, 'apps/api')] }));
    seed = new Client({ connectionString: database.url }) as never;
    try {
      await seed.connect();
      await seed.query(`SET search_path TO ${ownedSchema(database.schema)}`);
      const bound = await seed.query('SELECT current_schema() AS schema');
      const current = (bound.rows[0] as { schema: string }).schema;
      if (current !== database.schema) {
        throw new Error(`raw session bound to ${current}, expected ${database.schema}`);
      }
      const { WS10_IDS } = require('./support/hillday-job-postgres-harness.js') as Runtime;
      const { tenantId, documentId, meeting1, meeting2, legacyJobId } = WS10_IDS;
      const legacyUnits = JSON.stringify([
        { meetingId: meeting1, state: 'running', sectionId: meeting1, reason: null, at: new Date().toISOString() },
        { meetingId: meeting2, state: 'queued', sectionId: meeting2, reason: null, at: new Date().toISOString() },
      ]);
      await seed.query(
        `INSERT INTO ws_hillday_job (id, tenant_id, document_id, actor_id, status, units, events, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'user_ws10_owner', 'running', $4::jsonb, '[]'::jsonb, NOW() - INTERVAL '1 hour', NOW())`,
        [legacyJobId, tenantId, documentId, legacyUnits],
      );
      await seed.query(
        `INSERT INTO ws_hillday_job (id, tenant_id, document_id, actor_id, status, units, events, created_at, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'user_ws10_owner', 'queued', '[]'::jsonb, '[]'::jsonb, NOW(), NOW())`,
        [tenantId, documentId],
      );
      await seed.query(
        `INSERT INTO ws_hillday_job (id, tenant_id, document_id, actor_id, status, units, events, created_at, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'user_ws10_owner', 'complete', '[]'::jsonb, '[]'::jsonb, NOW(), NOW())`,
        [tenantId, documentId],
      );

      // 3. The exact additive SQL, once, through the ordinary role.
      await seed.query(readFileSync(MIGRATION_SQL, 'utf8'));
    } finally {
      // Closed on setup FAILURE as well as success: a half-seeded schema must not
      // leave the session holding this disposable database open.
      await seed.end().catch(() => undefined);
    }

    // 4. The same schema, now carrying both legacy rows and the new columns.
    runtime = require('./support/hillday-job-postgres-harness.js') as Runtime;
    h = await runtime.createHillDayJobHarness(database.url);
  }, 240_000);

  afterAll(async () => {
    try { await h?.close(); } finally { await database?.cleanup(); }
  }, 60_000);

  beforeEach(async () => {
    // Only the jobs created by a case are cleared; the seeded legacy row is
    // re-armed in place so its pre-migration provenance survives.
    await h!.db.wsHillDayJob.deleteMany({ where: { NOT: { id: h!.ids.legacyJobId } } });
    h!.dispatches.length = 0;
    h!.providerRecovers();
  });

  const unitState = (units: unknown, meetingId: string) =>
    (units as JobUnit[]).find((u) => u.meetingId === meetingId)!;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A real second connection, bound to this fixture's OWNED schema. */
  async function rawSession() {
    const { Client } = require(require.resolve('pg', { paths: [join(repoRoot, 'apps/api')] }));
    const client = new Client({ connectionString: h!.url });
    await client.connect();
    await client.query(`SET search_path TO ${ownedSchema(database!.schema)}`);
    return client as { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>; end(): Promise<void> };
  }

  /**
   * Wait until the service's REAL section write is genuinely blocked on a lock —
   * i.e. its publication transaction holds the claim row and is waiting for the
   * meeting row. This is a readiness probe on the same database, not a delay.
   */
  async function publicationIsBlocked(on: { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { rows } = await on.query(
        `SELECT count(*)::int AS blocked FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query ILIKE '%ws_hillday_meeting%'`,
      );
      if ((rows[0]!.blocked as number) > 0) return true;
      await sleep(25);
    }
    return false;
  }

  test('the migration applied to the accepted base schema adds every new column and index', async () => {
    const columns = await h!.db.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
      SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'ws_hillday_job' AND column_name IN
         ('request_id', 'request_ids', 'lease_holder', 'lease_expires_at', 'attempt_count', 'cancel_requested_at')
    `;
    expect(columns.map((c) => c.column_name).sort()).toEqual(
      ['attempt_count', 'cancel_requested_at', 'lease_expires_at', 'lease_holder', 'request_id', 'request_ids'].sort(),
    );
    const indexes = await h!.db.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'ws_hillday_job'
    `;
    expect(indexes.map((i) => i.indexname)).toEqual(
      expect.arrayContaining(['ws_hillday_job_request_key', 'ws_hillday_job_claim_idx']),
    );
  });

  test('the exact claim and renewal statements execute and produce a future expiry', async () => {
    const job = await h!.createJob();
    const before = new Date();
    const claim = await h!.worker.claim(job.id);
    expect(claim).not.toBe('busy');
    const row = await h!.leaseOf(job.id);
    expect(row!.leaseHolder).toBeTruthy();
    expect(row!.attemptCount).toBe(1);
    // A real 300-second interval, not a placeholder inside a quoted literal.
    expect(row!.leaseExpiresAt!.getTime()).toBeGreaterThan(before.getTime() + 240_000);
  });

  test('two replicas race one claim: exactly one wins, the other is busy', async () => {
    const job = await h!.createJob({ units: [h!.unit(h!.ids.meeting1, 'queued')] as never });
    const [a, b] = await Promise.all([h!.worker.claim(job.id), h!.secondWorker.claim(job.id)]);
    expect([a, b].filter((r) => r === 'busy')).toHaveLength(1);
    expect((await h!.leaseOf(job.id))!.attemptCount).toBe(1);
  });

  test('an expired lease on a genuinely RUNNING job lets another worker re-claim it', async () => {
    // A real in-flight attempt: claiming it first would run it to a terminal
    // state, and terminal jobs are intentionally not claimable — so the stalled
    // attempt is seeded as the running row it would be in production.
    const job = await h!.createJob({
      status: 'running', leaseHolder: 'stalled-worker-1', attemptCount: 4,
      leaseExpiresAt: new Date(Date.now() - 5_000),
      units: [h!.unit(h!.ids.meeting1, 'running'), h!.unit(h!.ids.meeting2, 'queued')] as never,
    });
    const before = await h!.leaseOf(job.id);
    expect(before!.status).toBe('running');
    expect(before!.leaseExpiresAt!.getTime()).toBeLessThan(Date.now());

    expect(await h!.secondWorker.claim(job.id)).not.toBe('busy');

    const after = await h!.leaseOf(job.id);
    expect(after!.attemptCount).toBe(5);
    expect(after!.leaseHolder).toBeTruthy();
    // The expired holder's in-flight unit is parked, never re-issued...
    expect(unitState(after!.units, h!.ids.meeting1).state).toBe('unknown');
    expect(h!.dispatches.some((body) => body.includes('WS10 meeting 1'))).toBe(false);
    // ...while the queued unit runs once under the new holder.
    expect(h!.dispatches.filter((body) => body.includes('WS10 meeting 2'))).toHaveLength(1);
  });

  test('a pre-migration running row with NO lease is recoverable, and its in-flight unit is never replayed', async () => {
    // The legacy row was seeded before the migration; it has never had a lease.
    const legacy = await h!.db.wsHillDayJob.findUnique({ where: { id: h!.ids.legacyJobId } });
    expect(legacy!.leaseExpiresAt).toBeNull();

    expect(await h!.secondWorker.claim(h!.ids.legacyJobId)).not.toBe('busy');

    const row = await h!.leaseOf(h!.ids.legacyJobId);
    // The unit that was in flight is parked as UNKNOWN, never re-issued...
    expect(unitState(row!.units, h!.ids.meeting1).state).toBe('unknown');
    expect(unitState(row!.units, h!.ids.meeting1).reason).toBe(LEASE_LOST_REASON);
    expect(h!.dispatches.some((body) => body.includes('WS10 meeting 1'))).toBe(false);
    // ...while the work that never started still runs, exactly once.
    expect(h!.dispatches.filter((body) => body.includes('WS10 meeting 2'))).toHaveLength(1);
    expect(unitState(row!.units, h!.ids.meeting2).state).toBe('done');
  });

  test('a unit left in flight by a dead holder is parked, and its call is not re-issued', async () => {
    const job = await h!.createJob({
      units: [h!.unit(h!.ids.meeting1, 'running'), h!.unit(h!.ids.meeting2, 'queued')] as never,
      status: 'running', leaseHolder: 'dead-worker-1', leaseExpiresAt: new Date(Date.now() - 60_000), attemptCount: 1,
    });
    expect(await h!.secondWorker.claim(job.id)).not.toBe('busy');
    const row = await h!.leaseOf(job.id);
    expect(unitState(row!.units, h!.ids.meeting1).state).toBe('unknown');
    expect(h!.dispatches.some((body) => body.includes('WS10 meeting 1'))).toBe(false);
    expect(h!.dispatches.some((body) => body.includes('WS10 meeting 2'))).toBe(true);
  });

  test('an accepted-then-dropped provider call is issued once and parked unknown, and only a deliberate retry replays it', async () => {
    const job = await h!.createJob({ units: [h!.unit(h!.ids.meeting1, 'queued')] as never });
    h!.providerAcceptsThenDrops();
    await h!.worker.claim(job.id);

    // ONE dispatch, no automatic second call.
    expect(h!.dispatches).toHaveLength(1);
    expect(unitState((await h!.leaseOf(job.id))!.units, h!.ids.meeting1).state).toBe('unknown');

    // A deliberate retry is the only thing that re-runs it.
    h!.providerRecovers();
    const retried = await h!.generation.retryFailedUnits(h!.ids.tenantId, h!.owner, h!.ids.documentId, job.id);
    expect(retried.units[0]!.state).toBe('queued');
    await h!.secondWorker.claim(job.id);
    expect(h!.dispatches).toHaveLength(2);
    expect(unitState((await h!.leaseOf(job.id))!.units, h!.ids.meeting1).state).toBe('done');
  });

  test('request identity: replaying a request returns the same job, and one answered by an active job stays replayable', async () => {
    const first = await h!.generation.start(h!.ids.tenantId, h!.owner, h!.ids.documentId, h!.ids.requestId);
    const replay = await h!.generation.start(h!.ids.tenantId, h!.owner, h!.ids.documentId, h!.ids.requestId);
    expect(replay.jobId).toBe(first.jobId);

    // A SECOND identity arriving while the first is active is bound to it.
    const bound = await h!.generation.start(h!.ids.tenantId, h!.owner, h!.ids.documentId, h!.ids.replayRequestId);
    expect(bound.jobId).toBe(first.jobId);
    expect((await h!.leaseOf(first.jobId))!.requestIds).toEqual(
      expect.arrayContaining([h!.ids.requestId, h!.ids.replayRequestId]),
    );

    // Finish it, then replay the second identity: same job, no new work.
    await h!.db.wsHillDayJob.update({ where: { id: first.jobId }, data: { status: 'complete' } });
    const afterCompletion = await h!.generation.start(h!.ids.tenantId, h!.owner, h!.ids.documentId, h!.ids.replayRequestId);
    expect(afterCompletion.jobId).toBe(first.jobId);
    expect(afterCompletion.status).toBe('complete');
  });

  test('request identity is unique per document: a duplicate is refused by the database', async () => {
    const { tenantId, documentId, requestId, otherDocumentId } = h!.ids;
    await h!.db.wsHillDayJob.create({ data: { tenantId, documentId, actorId: h!.owner, status: 'queued', requestId, units: [] as never } });
    await expect(h!.db.wsHillDayJob.create({
      data: { tenantId, documentId, actorId: h!.owner, status: 'queued', requestId, units: [] as never },
    })).rejects.toThrow();
    // The same identity under a DIFFERENT document is allowed.
    await expect(h!.db.wsHillDayJob.create({
      data: { tenantId, documentId: otherDocumentId, actorId: h!.owner, status: 'queued', requestId, units: [] as never },
    })).resolves.toBeTruthy();
  });

  test('a late provider result is dropped once another worker has taken the claim over', async () => {
    const job = await h!.createJob({ units: [h!.unit(h!.ids.meeting1, 'queued')] as never });

    // While A's provider call is out, its lease is taken over by B, which
    // completes the job and parks A's in-flight unit as unknown.
    h!.whileProviderCallIsOut(async () => {
      await h!.expireLease(job.id);
      await h!.secondWorker.claim(job.id);
    });

    const aResult = await h!.worker.claim(job.id);

    // A published nothing: the persisted record is B's.
    expect(aResult).toBe('running');
    const row = await h!.leaseOf(job.id);
    expect(row!.status).toBe('complete');
    expect(unitState(row!.units, h!.ids.meeting1).state).toBe('unknown');
    const unitDoneEvents = (row!.events as Array<{ event: string; data: Record<string, unknown> }>)
      .filter((e) => e.data.meetingId === h!.ids.meeting1 && e.data.state === 'done');
    expect(unitDoneEvents).toHaveLength(0);
  });

  test('cancelling a queued job cancels it outright; cancelling a running job only records the request', async () => {
    const queued = await h!.createJob();
    const cancelled = await h!.generation.requestCancel(h!.ids.tenantId, h!.owner, h!.ids.documentId, queued.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelRequestedAt).not.toBeNull();

    const running = await h!.createJob({
      status: 'running', leaseHolder: 'live-worker-1', leaseExpiresAt: new Date(Date.now() + 60_000),
      units: [h!.unit(h!.ids.meeting1, 'running')] as never,
    });
    const requested = await h!.generation.requestCancel(h!.ids.tenantId, h!.owner, h!.ids.documentId, running.id);
    expect(requested.status).toBe('running');
    expect(requested.cancelRequestedAt).not.toBeNull();
  });

  test('a claimed job with cancellation requested dispatches nothing and reports cancelled', async () => {
    const job = await h!.createJob({
      status: 'running', leaseHolder: 'dead-worker-1', leaseExpiresAt: new Date(Date.now() - 60_000),
      attemptCount: 1, cancelRequestedAt: new Date(),
    });
    expect(await h!.secondWorker.claim(job.id)).toBe('cancelled');
    expect(h!.dispatches).toEqual([]);
    expect((await h!.leaseOf(job.id))!.status).toBe('cancelled');
  });

  test('deliberate retry re-queues only failed/unknown units and preserves done', async () => {
    const job = await h!.createJob({
      status: 'complete', quality: 0.5,
      units: [
        h!.unit(h!.ids.meeting1, 'done'),
        { ...h!.unit(h!.ids.meeting2, 'unknown'), reason: PROVIDER_UNCERTAIN_REASON },
      ] as never,
    });
    const retried = await h!.generation.retryFailedUnits(h!.ids.tenantId, h!.owner, h!.ids.documentId, job.id);
    expect(retried.status).toBe('queued');
    expect(unitState(retried.units, h!.ids.meeting1).state).toBe('done');
    expect(unitState(retried.units, h!.ids.meeting2).state).toBe('queued');
  });

  test('retry is refused while the job is still active and is a no-op when nothing failed', async () => {
    const active = await h!.createJob({
      status: 'running', leaseHolder: 'live', leaseExpiresAt: new Date(Date.now() + 60_000),
      units: [h!.unit(h!.ids.meeting1, 'running')] as never,
    });
    await expect(h!.generation.retryFailedUnits(h!.ids.tenantId, h!.owner, h!.ids.documentId, active.id))
      .rejects.toMatchObject({ status: 409 });

    const clean = await h!.createJob({ status: 'complete', units: [h!.unit(h!.ids.meeting1, 'done')] as never });
    const unchanged = await h!.generation.retryFailedUnits(h!.ids.tenantId, h!.owner, h!.ids.documentId, clean.id);
    expect(unchanged.status).toBe('complete');
  });

  test('the latest-job read returns the active job and never crosses the tenant boundary', async () => {
    const active = await h!.createJob({ units: [] as never });
    const latest = await h!.generation.latestJob(h!.ids.tenantId, h!.owner, h!.ids.documentId);
    expect(latest.job?.jobId).toBe(active.id);
    await expect(h!.generation.latestJob(h!.ids.otherTenantId, h!.owner, h!.ids.documentId))
      .rejects.toMatchObject({ status: 404 });
  });

  test('two concurrent starts with the SAME request produce one job', async () => {
    const { tenantId, owner, documentId, requestId } = { tenantId: h!.ids.tenantId, owner: h!.owner, documentId: h!.ids.documentId, requestId: h!.ids.requestId };
    const [first, second] = await Promise.all([
      h!.generation.start(tenantId, owner, documentId, requestId),
      h!.generation.start(tenantId, owner, documentId, requestId),
    ]);
    expect(first.jobId).toBe(second.jobId);
    const rows = await h!.db.wsHillDayJob.findMany({ where: { documentId, requestId } });
    expect(rows).toHaveLength(1);
  });

  test('two concurrent starts with DIFFERENT requests produce one job bound to both identities', async () => {
    const { tenantId, owner, documentId } = { tenantId: h!.ids.tenantId, owner: h!.owner, documentId: h!.ids.documentId };
    const [first, second] = await Promise.all([
      h!.generation.start(tenantId, owner, documentId, h!.ids.requestId),
      h!.generation.start(tenantId, owner, documentId, h!.ids.replayRequestId),
    ]);
    expect(first.jobId).toBe(second.jobId);
    expect((await h!.leaseOf(first.jobId))!.requestIds).toEqual(
      expect.arrayContaining([h!.ids.requestId, h!.ids.replayRequestId]),
    );
  });

  test('a queued cancellation racing a claim never dispatches and ends cancelled', async () => {
    const job = await h!.createJob({ units: [h!.unit(h!.ids.meeting1, 'queued')] as never });
    const [cancel, claim] = await Promise.all([
      h!.generation.requestCancel(h!.ids.tenantId, h!.owner, h!.ids.documentId, job.id),
      h!.worker.claim(job.id),
    ]);
    // Whichever order the two writers win in, the job is cancelled and the
    // provider is never called for work that was cancelled.
    expect(['cancelled', 'running']).toContain(cancel.status);
    expect(claim === 'busy').toBe(false);
    expect(h!.dispatches).toEqual([]);
    expect((await h!.leaseOf(job.id))!.status).toBe('cancelled');
  });

  test('a deliberate retry hands the re-queued work to exactly one claim', async () => {
    const job = await h!.createJob({
      status: 'complete', quality: 0.5,
      units: [{ ...h!.unit(h!.ids.meeting1, 'failed'), reason: 'provider_error' }] as never,
    });
    const retried = await h!.generation.retryFailedUnits(h!.ids.tenantId, h!.owner, h!.ids.documentId, job.id);
    expect(retried.status).toBe('queued');

    // The conditional re-queue is what makes the row claimable again, and only
    // one of two racing replicas may take it.
    const [a, b] = await Promise.all([h!.worker.claim(job.id), h!.secondWorker.claim(job.id)]);
    expect([a, b].filter((r) => r === 'busy')).toHaveLength(1);
    expect(h!.dispatches.filter((body) => body.includes('WS10 meeting 1'))).toHaveLength(1);
    expect(unitState((await h!.leaseOf(job.id))!.units, h!.ids.meeting1).state).toBe('done');
  });

  test('a manual edit made while the provider call is out wins over the generated text', async () => {
    const job = await h!.createJob({ units: [h!.unit(h!.ids.meeting1, 'queued')] as never });
    h!.whileProviderCallIsOut(async () => {
      await h!.db.wsHillDayMeeting.update({
        where: { id: h!.ids.meeting1 },
        data: {
          section: {
            sectionId: h!.ids.meeting1, focus: 'HAND EDIT', background: 'HAND EDIT', unsupported: [],
            edited: { focus: true, background: true, at: new Date().toISOString() },
          } as never,
        },
      });
    });

    await h!.worker.claim(job.id);

    const meeting = await h!.db.wsHillDayMeeting.findUnique({ where: { id: h!.ids.meeting1 } });
    expect((meeting!.section as { focus?: string }).focus).toBe('HAND EDIT');
    expect(unitState((await h!.leaseOf(job.id))!.units, h!.ids.meeting1).reason).toBe('edited_preserved');
  });

  test('publication is serialized with takeover: a successor cannot claim the job while the section write waits', async () => {
    const job = await h!.createJob({ units: [h!.unit(h!.ids.meeting1, 'queued')] as never });
    const locker = await rawSession();
    const probe = await rawSession();
    let locked = false;
    try {
      // An independent transaction takes the meeting row the publication needs,
      // and A's lease is expired while A is still inside its provider call.
      h!.whileProviderCallIsOut(async () => {
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM ws_hillday_meeting WHERE id = $1::uuid FOR UPDATE', [h!.ids.meeting1]);
        locked = true;
        await h!.expireLease(job.id);
      });

      const runA = h!.worker.claim(job.id);
      // Wait until A's REAL section write is blocked on that row: A now holds
      // the claim row inside its publication transaction.
      expect(locked).toBe(true);
      expect(await publicationIsBlocked(probe)).toBe(true);

      let takeoverSettled = false;
      const takeover = h!.secondWorker.claim(job.id).then((result) => {
        takeoverSettled = true;
        return result;
      });
      // The takeover changes the claim row, so it must WAIT for that
      // transaction: it cannot slip between the claim check and the write.
      await sleep(250);
      expect(takeoverSettled).toBe(false);

      await locker.query('COMMIT');
      locked = false;
      const aResult = await runA;
      const takeoverResult = await takeover;

      // A published while it still held the claim...
      const meeting = await h!.db.wsHillDayMeeting.findUnique({ where: { id: h!.ids.meeting1 } });
      expect((meeting!.section as { focus?: string }).focus).toBe('Synthetic focus');
      // ...the successor then took the claim over and parked A's in-flight unit
      // without ever re-issuing its provider call.
      expect(aResult).toBe('running');
      expect(takeoverResult).not.toBe('busy');
      expect(h!.dispatches.filter((body) => body.includes('WS10 meeting 1'))).toHaveLength(1);
      const row = await h!.leaseOf(job.id);
      expect(row!.attemptCount).toBe(2);
      expect(unitState(row!.units, h!.ids.meeting1).state).toBe('unknown');
      expect(unitState(row!.units, h!.ids.meeting1).reason).toBe(LEASE_LOST_REASON);
    } finally {
      if (locked) await locker.query('COMMIT').catch(() => undefined);
      await locker.end().catch(() => undefined);
      await probe.end().catch(() => undefined);
    }
  });
});
