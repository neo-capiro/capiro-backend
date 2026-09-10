import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';
import { ClientProfileFillWorkflowService } from './client-profile-fill-workflow.service.js';

jest.mock('./client-profile-fill.service.js', () => ({ ClientProfileFillService: class {} }));
jest.mock('../intelligence/intelligence.service.js', () => ({ IntelligenceService: class {} }));
jest.mock('./client-facilities.service.js', () => ({ ClientFacilitiesService: class {} }));
jest.mock('./client-advocacy-matter.service.js', () => ({ ClientAdvocacyMatterService: class {} }));
jest.mock('../engagement/engagement.service.js', () => ({ EngagementService: class {} }));
jest.mock('../intelligence/client-prepopulation.service.js', () => ({
  ClientPrepopulationService: class {},
}));
jest.mock('./client-profile-fill-context-plane.service.js', () => ({
  ClientProfileFillContextPlaneService: class {},
}));
jest.mock('./governed-client-profile-fill.factory.js', () => ({
  runWithGovernedCrmFillBundle: jest.fn(),
}));

const databaseUrl = process.env.FILL_RETRY_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const CORE = 'client_profile_fill_task';
const EXTENSION = 'client_profile_fill_extension_task';

// Real PostgreSQL executes the production claim/retry/finalization SQL. Each
// case owns temporary tables in one connection; no application data is used.
describeDatabase('Fill retry leases and recovery in PostgreSQL', () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  async function sandbox(check: (state: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
    await db.$transaction(
      async (tx) => {
        await check(await setup(tx));
      },
      { timeout: 30_000 },
    );
  }

  async function setup(tx: Prisma.TransactionClient) {
    await tx.$executeRawUnsafe(`CREATE TEMP TABLE client_profile_fill_run (
      id uuid PRIMARY KEY, tenant_id uuid, client_id uuid, workflow_version int DEFAULT 2,
      status text DEFAULT 'running', stage text DEFAULT 'research', created_by_user_id uuid,
      completed_at timestamptz, cancelled_at timestamptz, last_progress_at timestamptz,
      updated_at timestamptz DEFAULT now(), summary_jsonb jsonb DEFAULT '{}', error text
    ) ON COMMIT DROP`);
    for (const [table, dependencyType] of [
      [CORE, 'uuid'],
      [EXTENSION, 'text'],
    ]) {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE ${table} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid, tenant_id uuid, client_id uuid,
        task_type text, task_key text, status text DEFAULT 'queued', depends_on ${dependencyType}[] DEFAULT '{}',
        attempt int DEFAULT 0, max_attempts int DEFAULT 3,
        input_jsonb jsonb DEFAULT '{}', output_summary_jsonb jsonb DEFAULT '{}',
        error_code text, error_message text, worker_id text, claimed_at timestamptz, heartbeat_at timestamptz,
        next_attempt_at timestamptz DEFAULT now(), completed_at timestamptz,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      ) ON COMMIT DROP`);
    }
    await tx.$executeRawUnsafe(`CREATE TEMP TABLE client_profile_fill_finding (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid, tenant_id uuid, client_id uuid,
      kind text, target_key text, source text, fact_kind text, current_value_jsonb jsonb,
      proposed_value_jsonb jsonb, evidence_jsonb jsonb, confidence double precision,
      status text, content_hash text, applied_at timestamptz, updated_at timestamptz DEFAULT now(),
      UNIQUE (run_id, content_hash)
    ) ON COMMIT DROP`);
    const runId = randomUUID(),
      tenantId = randomUUID(),
      clientId = randomUUID(),
      userId = randomUUID();
    const ctx = { tenantId, userId } as any;
    await tx.$executeRawUnsafe(
      `INSERT INTO client_profile_fill_run (id, tenant_id, client_id, created_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      runId,
      tenantId,
      clientId,
      userId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO client_profile_fill_finding (run_id, tenant_id, kind, status, proposed_value_jsonb, applied_at)
       SELECT $1::uuid, $2::uuid, 'profile_field', 'accepted', to_jsonb(value), now()
         FROM (VALUES ('Saved website'), ('Saved overview')) AS saved(value)`,
      runId,
      tenantId,
    );
    const prisma = {
      withSystem: (fn: any) => fn(tx),
      withTenant: (_tenant: string, fn: any) => fn(tx),
      withTenantUser: (_tenant: string, _user: string, fn: any) =>
        fn({ client: { findFirst: async () => ({ id: clientId }) } }),
    };
    const workflow = new ClientProfileFillWorkflowService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    ) as any;
    const completion = new ClientProfileFillCompletionService(
      prisma as any,
      workflow,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    ) as any;
    workflow.requestSweep = jest.fn();
    workflow.syncSourceState = jest.fn();
    workflow.getRun = jest.fn().mockResolvedValue({ id: runId });
    workflow.logger = { warn: jest.fn() };
    completion.requestTaskSweep = jest.fn();
    completion.getRun = jest.fn().mockResolvedValue({ id: runId });
    async function insert(table: string, type: string, status = 'queued') {
      const id = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO ${table} (id, run_id, tenant_id, client_id, task_type, task_key, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $5, $6)`,
        id,
        runId,
        tenantId,
        clientId,
        type,
        status,
      );
      return id;
    }
    async function row(table: string, id: string) {
      const rows = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM ${table} WHERE id = $1::uuid`,
        id,
      );
      return rows[0];
    }
    async function accepted() {
      return tx.$queryRawUnsafe<any[]>(
        "SELECT * FROM client_profile_fill_finding WHERE status = 'accepted' ORDER BY id",
      );
    }
    return { tx, ctx, runId, tenantId, clientId, workflow, completion, insert, row, accepted };
  }

  it.each([CORE, EXTENSION])(
    'ignores stale callbacks after the same worker reclaims %s',
    async (table) => {
      await sandbox(async ({ tx, runId, workflow, completion, insert, row }) => {
        const id = await insert(table, table === CORE ? 'bill_tracker' : 'federal_market');
        const service = table === CORE ? workflow : completion;
        const [first] = await service.claimTasks();
        if (table === CORE) await workflow.failTask(first, 'test_retry', 'Retry', true);
        else await completion.deferTask(first, 'Waiting');
        await tx.$executeRawUnsafe(
          `UPDATE ${table} SET next_attempt_at = now() WHERE id = $1::uuid`,
          id,
        );
        const [second] = await service.claimTasks();
        expect(second.workerId).not.toEqual(first.workerId);
        await tx.$executeRawUnsafe(
          `UPDATE ${table} SET heartbeat_at = '2000-01-01' WHERE id = $1::uuid`,
          id,
        );
        await tx.$executeRawUnsafe(
          `UPDATE client_profile_fill_run SET last_progress_at = '2000-01-01' WHERE id = $1::uuid`,
          runId,
        );
        const current = await row(table, id);
        const currentRun = await row('client_profile_fill_run', runId);
        if (table === CORE) {
          await workflow.completeTask(first, 99);
          await workflow.failTask(first, 'late_error', 'Stale failure', false);
        } else {
          await completion.finishTask(first, 'completed', { count: 99 });
          await completion.deferTask(first, 'Stale deferral');
          await completion.failTask(first, new Error('Stale failure'));
        }
        await service.heartbeat(first);
        expect(await row(table, id)).toEqual(current);
        expect(await row('client_profile_fill_run', runId)).toEqual(currentRun);
        if (table === CORE) await workflow.completeTask(second, 2);
        else await completion.finishTask(second, 'completed', { count: 2 });
        expect(await row(table, id)).toMatchObject({
          status: 'completed',
          worker_id: null,
          output_summary_jsonb: { count: 2 },
        });
      });
    },
  );

  it('does not resurrect cancelled tasks or alter accepted findings when workers finish late', async () => {
    await sandbox(async ({ ctx, runId, clientId, workflow, completion, insert, row, accepted }) => {
      const coreId = await insert(CORE, 'bill_tracker');
      const extensionId = await insert(EXTENSION, 'federal_market');
      const [core] = await workflow.claimTasks();
      const [extension] = await completion.claimTasks();
      const saved = await accepted();
      await completion.cancelRun(ctx, clientId, runId);
      await workflow.completeTask(core, 99);
      await workflow.failTask(core, 'late_error', 'Stale failure', true);
      await completion.finishTask(extension, 'completed', { count: 99 });
      await completion.deferTask(extension, 'Stale deferral');
      await completion.failTask(extension, new Error('Stale failure'));
      expect(await row(CORE, coreId)).toMatchObject({ status: 'cancelled', worker_id: null });
      expect(await row(EXTENSION, extensionId)).toMatchObject({
        status: 'cancelled',
        worker_id: null,
      });
      expect(await row('client_profile_fill_run', runId)).toMatchObject({ status: 'cancelled' });
      expect(await accepted()).toEqual(saved);
    });
  });

  it.each(['completed', 'running'])(
    'refreshes %s verification after a core retry and finishes the run',
    async (reviewStatus) => {
      await sandbox(
        async ({
          tx,
          ctx,
          runId,
          tenantId,
          clientId,
          workflow,
          completion,
          insert,
          row,
          accepted,
        }) => {
          const coreId = await insert(CORE, 'bill_tracker', 'failed');
          const reviewId = await insert(EXTENSION, 'reconciliation', reviewStatus);
          const auditId = await insert(EXTENSION, 'completion_audit', 'completed');
          await tx.$executeRawUnsafe(`UPDATE ${EXTENSION} SET output_summary_jsonb = '{"count":99}',
        worker_id = 'old-review-lease', completed_at = now()`);
          await tx.$executeRawUnsafe(
            `UPDATE ${EXTENSION} SET depends_on = ARRAY['reconciliation'] WHERE id = $1::uuid`,
            auditId,
          );
          const saved = await accepted();
          await workflow.retryTask(ctx, clientId, runId, coreId);
          await completion.finishTask(
            { id: reviewId, runId, tenantId, workerId: 'old-review-lease' },
            'completed',
            { count: 99 },
          );
          for (const id of [reviewId, auditId]) {
            expect(await row(EXTENSION, id)).toMatchObject({
              status: 'queued',
              worker_id: null,
              completed_at: null,
              output_summary_jsonb: {},
            });
          }
          await expect(
            completion.assertCoreDependencies({ runId, tenantId, taskType: 'reconciliation' }),
          ).rejects.toThrow('Waiting for prerequisite Fill specialists');
          const [core] = await workflow.claimTasks();
          await workflow.completeTask(core, 2);
          const [review] = await completion.claimTasks();
          expect(review.id).toBe(reviewId);
          await completion.finishTask(review, 'completed', { count: 2 });
          const [audit] = await completion.claimTasks();
          expect(audit.id).toBe(auditId);
          const auditFinding = {
            kind: 'profile_completion',
            targetKey: 'profile-completion',
            source: 'completion_audit',
            factKind: 'fact',
            currentValue: null,
            proposedValue: { score: 87 },
            confidence: 1,
            status: 'informational',
            evidence: [],
          };
          await expect(
            completion.addFinding(tenantId, clientId, runId, auditFinding, audit),
          ).resolves.toBe(true);
          await expect(
            completion.addFinding(
              tenantId,
              clientId,
              runId,
              { ...auditFinding, proposedValue: { score: 40 } },
              { id: auditId, workerId: 'old-review-lease' },
            ),
          ).resolves.toBe(false);
          const audits = await tx.$queryRawUnsafe<any[]>(
            "SELECT proposed_value_jsonb FROM client_profile_fill_finding WHERE source = 'completion_audit'",
          );
          expect(audits).toEqual([{ proposed_value_jsonb: { score: 87 } }]);
          await completion.finishTask(audit, 'completed', { count: 1 });
          await completion.finalizeRuns();
          expect(await row('client_profile_fill_run', runId)).toMatchObject({
            status: 'completed',
            stage: 'review_ready',
          });
          expect(await accepted()).toEqual(saved);
        },
      );
    },
  );
});
