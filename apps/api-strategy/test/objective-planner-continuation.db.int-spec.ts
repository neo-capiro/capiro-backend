import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { readFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PlannerService } from '../src/planner/planner.service.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import { ObjectiveCanonicalApplicationService } from '../src/planner/objective-canonical-application.service.js';
import { ObjectiveCanonicalWorkloadAuthority } from '../src/planner/objective-canonical-authority.js';
import { ObjectivePlannerContinuationRuntime } from '../src/planner/objective-planner-continuation.runtime.js';
import { ObjectivePlannerContinuationWorker } from '../src/planner/objective-planner-continuation.worker.js';
import { PLANNER_CONTINUATION_OPERATION, plannerContinuationOperationId,
  readPlannerContinuationOperationWithinTx } from '../src/planner/objective-planner-continuation.store.js';
import { applicationHash, applicationHeadId, applicationReceiptId } from '../src/planner/objective-canonical-application.js';
import { buildObjectivePlannerNativeFixture, seedObjectivePlannerNativeFixture,
  cancelObjectivePlannerNativeFixtureConsent, type ObjectivePlannerNativeFixture } from './objective-planner-native-fixture.js';
import { objectivePlannerNativeOptIn, objectivePlannerNativeTarget, requireObjectivePlannerNativePostmaster,
  requireObjectivePlannerNativeCatalog, type ObjectivePlannerNativeTarget } from './objective-planner-native-target.js';

/** Prepared native suite. With opt-in absent, it constructs NO Prisma client,
 * reads NO target/manifest and executes NO SQL. The source fixture tests run
 * separately. It creates no cluster, migration, role, credential or AWS client. */
const optedIn = objectivePlannerNativeOptIn(process.env);
const native = optedIn ? describe : describe.skip;
const config = (enabled: boolean) => new ConfigService({ OBJECTIVE_PLANNER_CONTINUATION_ENABLED: enabled ? 'true' : 'false' });

test('ordinary default-off worker startup and both runtime entry points perform no database work', async () => {
  const unavailable = new Proxy({}, { get() { throw Error('Default-off continuation must remain inert'); } });
  const runtime = new ObjectivePlannerContinuationRuntime(unavailable as PrismaService,
    unavailable as ObjectiveCanonicalApplicationService, config(false));
  const worker = new ObjectivePlannerContinuationWorker(unavailable as PrismaService, runtime);
  jest.useFakeTimers();
  try {
    worker.onModuleInit(); expect(jest.getTimerCount()).toBe(0);
    await worker.tick(); await runtime.consumeTenant('not-an-admitted-tenant');
    expect(await runtime.consumeJob({ tenantId: 'not-an-admitted-tenant', clerkUserId: '', generationJobId: '' }))
      .toEqual({ outcome: 'disabled' });
  } finally { worker.onModuleDestroy(); jest.useRealTimers(); }
});

native('Objective Planner concrete runtime on task-owned native PostgreSQL', () => {
  let target: Extract<ObjectivePlannerNativeTarget, { enabled: true }>;
  let prisma: PrismaService;
  const extraClients: PrismaService[] = [];
  const workspaceRoot = resolve(__dirname, '../../..');
  function application(db = prisma) {
    return new ObjectiveCanonicalApplicationService(db,
      new PlannerService(db, { validate: async () => undefined } as unknown as PlannerLinksService),
      // The local runtime must never invoke this external rejecting authority.
      // Concrete native consent/fences remain in the runtime owner transaction.
      new ObjectiveCanonicalWorkloadAuthority());
  }
  const runtime = (db = prisma, app = application(db)) => new ObjectivePlannerContinuationRuntime(db, app, config(true));
  async function verifyCatalog() {
    const rows = await prisma.$queryRaw<Array<{ databaseName: string; databaseOid: number; roleName: string;
      serverPort: number; databaseComment: string | null; postmasterStartedAtSeconds: string;
      superuser: boolean; bypassRls: boolean }>>`
      SELECT current_database()::text AS "databaseName",d.oid::integer AS "databaseOid",current_user::text AS "roleName",
        inet_server_port() AS "serverPort",shobj_description(d.oid,'pg_database') AS "databaseComment",
        floor(extract(epoch FROM pg_postmaster_start_time()))::text AS "postmasterStartedAtSeconds",
        r.rolsuper AS superuser,r.rolbypassrls AS "bypassRls"
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`;
    expect(rows).toHaveLength(1); requireObjectivePlannerNativeCatalog(target, rows[0]!);
  }
  beforeAll(async () => {
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'apps', 'packages', 'scripts'],
      { cwd: workspaceRoot, encoding: 'utf8' });
    if (dirty.trim()) throw Error('Native qualification requires committed, clean application source');
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8' }).trim();
    const manifest = JSON.parse(await readFile(resolve(workspaceRoot, '.objective-planner-native/owned-target.json'), 'utf8'));
    const checked = objectivePlannerNativeTarget(process.env, manifest, { workspaceRoot, sourceHead, nowMs: Date.now() });
    if (!checked.enabled) throw Error('Native suite requires explicit opt-in');
    target = checked;
    let processAlive = false;
    try { process.kill(target.manifest.processId, 0); processAlive = true; } catch { /* A dead PID never authorizes a target. */ }
    requireObjectivePlannerNativePostmaster(target, {
      workspaceRealPath: await realpath(workspaceRoot), dataDirectoryRealPath: await realpath(target.manifest.dataDirectory),
      pgVersion: await readFile(resolve(target.manifest.dataDirectory, 'PG_VERSION'), 'utf8'),
      postmasterPid: await readFile(resolve(target.manifest.dataDirectory, 'postmaster.pid'), 'utf8'), processAlive });
    // First Prisma construction occurs only after the complete pure + local
    // ownership guard. This connection performs read-only identity checks next.
    prisma = new PrismaService({ datasources: { db: { url: target.databaseUrl } } });
    await prisma.$connect(); await verifyCatalog();
  }, 30_000);
  afterAll(async () => {
    await Promise.all(extraClients.map(db => db.$disconnect()));
    await prisma?.$disconnect();
    // Synthetic audit history is retained. Dispose only the separately owned
    // cluster through its owner; this suite never purges historical evidence.
  });
  async function fixture(options: Parameters<typeof buildObjectivePlannerNativeFixture>[1] = {}) {
    await verifyCatalog();
    const rows = await prisma.$queryRaw<Array<{ ms: string }>>`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms`;
    const f = buildObjectivePlannerNativeFixture(Number(rows[0]!.ms), options);
    return seedObjectivePlannerNativeFixture(prisma, f);
  }
  async function state(f: ObjectivePlannerNativeFixture) {
    return prisma.withTenant(f.tenantId, async tx => ({
      operations: await tx.spPlannerResource.findMany({ where: { tenantId: f.tenantId, kind: PLANNER_CONTINUATION_OPERATION } }),
      applications: await tx.spPlannerResource.findMany({ where: { tenantId: f.tenantId, kind: 'objective_canonical_application_receipt' } }),
      projects: await tx.spPlannerProject.findMany({ where: { tenantId: f.tenantId } }),
      tasks: await tx.spPlannerTask.findMany({ where: { tenantId: f.tenantId } }),
      head: await tx.spPlannerResource.findFirst({ where: { tenantId: f.tenantId, id: applicationHeadId(f.canonical) } }),
    }));
  }
  test('durable tenant discovery continues a completed generation without a browser and commits paired accounting', async () => {
    const { fixture: f, work } = await fixture();
    await runtime().consumeTenant(f.tenantId);
    const s = await state(f);
    expect(s.operations).toHaveLength(1); expect(s.applications).toHaveLength(1);
    expect(s.projects).toHaveLength(1); expect(s.tasks).toHaveLength(f.normalized.nodeIds.length);
    expect(s.projects[0]!.id).toBe(f.canonical.canonicalProjectId);
    const operation = await prisma.withTenant(f.tenantId, tx => readPlannerContinuationOperationWithinTx(tx,
      { tenantId: f.tenantId, clerkUserId: f.clerkUserId, operationId: plannerContinuationOperationId(work) }));
    expect(operation?.data.state).toBe('applied');
    expect(operation?.data.terminal?.receiptId).toBe(applicationReceiptId(f.tenantId, f.clerkUserId, work.applicationRequestId));
    expect(operation?.data.original.originalDeadlineAt).toBe(new Date(Math.min(f.plannerExpiresAtMs,
      f.admission.effectExpiresAtMs, f.acceptance.issuance.expiresAtMs)).toISOString());
    expect(s.head).not.toBeNull();
  }, 30_000);
  test('two independent native clients contend for one operation and create one output set', async () => {
    const { fixture: f } = await fixture();
    const second = new PrismaService({ datasources: { db: { url: target.databaseUrl } } });
    extraClients.push(second); await second.$connect();
    const results = await Promise.allSettled([runtime().consumeJob(f.scope), runtime(second).consumeJob(f.scope)]);
    expect(results.some(r => r.status === 'fulfilled' && r.value.outcome === 'applied')).toBe(true);
    const s = await state(f);
    expect(s.operations).toHaveLength(1); expect(s.applications).toHaveLength(1);
    expect(s.projects).toHaveLength(1); expect(s.tasks).toHaveLength(f.normalized.nodeIds.length);
  }, 30_000);
  test('throwing after actual application writes rolls back outputs and receipt before operation accounting', async () => {
    const { fixture: f } = await fixture(), app = application();
    const prepare = app.prepareWithinOwnerTransaction.bind(app);
    let sawUncommittedEffects = false;
    app.prepareWithinOwnerTransaction = async (...args) => {
      const result = await prepare(...args);
      const [tx, request] = args;
      const receipt = await tx.spPlannerResource.findFirst({ where: { tenantId: f.tenantId,
        id: applicationReceiptId(f.tenantId, f.clerkUserId, request.applicationRequestId) } });
      const project = await tx.spPlannerProject.findFirst({ where: { tenantId: f.tenantId, id: f.canonical.canonicalProjectId } });
      sawUncommittedEffects = !!receipt && !!project && !!result;
      throw Error('Synthetic failure after native application writes and before accounting');
    };
    await expect(runtime(prisma, app).consumeJob(f.scope)).rejects.toBeDefined();
    expect(sawUncommittedEffects).toBe(true);
    const s = await state(f);
    expect(s.projects).toHaveLength(0); expect(s.tasks).toHaveLength(0); expect(s.applications).toHaveLength(0); expect(s.head).toBeNull();
    expect(s.operations).toHaveLength(1);
    expect((s.operations[0]!.data as { state: string }).state).toBe('leased');
  }, 30_000);
  test('discarded committed caller reply recovers the exact original operation from a fresh runtime', async () => {
    const { fixture: f } = await fixture();
    await expect((async () => { expect((await runtime().consumeJob(f.scope)).outcome).toBe('applied');
      throw Error('Synthetic caller discarded the committed reply'); })()).rejects.toThrow('discarded');
    const before = await state(f), original = (before.operations[0]!.data as { original: unknown }).original;
    const recovered = await runtime().consumeJob(f.scope);
    expect(recovered.outcome).toBe('applied');
    if (recovered.outcome === 'applied') expect(recovered.recovered).toBe(true);
    const after = await state(f);
    expect(applicationHash((after.operations[0]!.data as { original: unknown }).original)).toBe(applicationHash(original));
    expect(after.operations).toHaveLength(1); expect(after.projects).toHaveLength(1); expect(after.applications).toHaveLength(1);
    expect(after.tasks).toHaveLength(f.normalized.nodeIds.length);
  }, 30_000);
  test('actual expiry after accounting rolls back accounting and outputs at the final native release fence', async () => {
    const clocks = await prisma.$queryRaw<Array<{ ms: string }>>`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms`;
    const deadline = Number(clocks[0]!.ms) + 8_000;
    const { fixture: f } = await fixture({ plannerExpiresAtMs: deadline });
    let observedUncommittedAccounting = false;
    const delayed = new Proxy(prisma, { get(db, key) {
      if (key !== 'withTenant') { const value = Reflect.get(db, key); return typeof value === 'function' ? value.bind(db) : value; }
      return (tenant: string, run: (tx: any) => Promise<unknown>, opts: any) => db.withTenant(tenant, async tx => {
        const resources = new Proxy(tx.spPlannerResource, { get(delegate, member) {
          if (member !== 'updateMany') { const value = Reflect.get(delegate, member); return typeof value === 'function' ? value.bind(delegate) : value; }
          return async (args: any) => {
            const changed = await delegate.updateMany(args);
            if (args.data?.data?.state === 'applied' && !observedUncommittedAccounting) {
              const row = await delegate.findFirst({ where: { tenantId: f.tenantId, id: args.where.id } });
              observedUncommittedAccounting = (row?.data as { state?: string })?.state === 'applied';
              // Native DB clock and real elapsed time, not a mocked clock. The
              // bounded wait occurs only in explicitly enabled qualification.
              const wait = await tx.$queryRaw<Array<{ seconds: number }>>`SELECT GREATEST(0.0,
                (${deadline}::double precision-extract(epoch FROM clock_timestamp())*1000+100)/1000) AS seconds`;
              const seconds = Number(wait[0]!.seconds);
              if (!Number.isFinite(seconds) || seconds < 0 || seconds > 9) throw Error('Unbounded native expiry fixture wait');
              await tx.$executeRaw`SELECT pg_sleep(${seconds}::double precision)`;
            }
            return changed;
          };
        } });
        return run(new Proxy(tx, { get(inner, member) { return member === 'spPlannerResource' ? resources : Reflect.get(inner, member); } }));
      }, opts);
    } });
    await expect(runtime(delayed).consumeJob(f.scope)).rejects.toBeDefined();
    expect(observedUncommittedAccounting).toBe(true);
    const s = await state(f);
    expect(s.projects).toHaveLength(0); expect(s.tasks).toHaveLength(0); expect(s.applications).toHaveLength(0); expect(s.head).toBeNull();
    expect(s.operations).toHaveLength(1); expect((s.operations[0]!.data as { state: string }).state).toBe('leased');
  }, 30_000);
  test('expired original Planner consent cannot be extended into a new operation', async () => {
    // The complete expired consent/receipt pair is still valid historical data.
    const rows = await prisma.$queryRaw<Array<{ ms: string }>>`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms`;
    const { fixture: f } = await fixture({ plannerExpiresAtMs: Number(rows[0]!.ms) - 1_000 });
    await expect(runtime().consumeJob(f.scope)).rejects.toBeDefined();
    const s = await state(f); expect(s.projects).toHaveLength(0); expect(s.tasks).toHaveLength(0); expect(s.applications).toHaveLength(0);
  }, 30_000);
  test('retained recovery preserves actual human Planner edits and reports their current versions', async () => {
    const { fixture: f } = await fixture();
    expect((await runtime().consumeJob(f.scope)).outcome).toBe('applied');
    const original = await state(f), project = original.projects[0]!, task = original.tasks[0]!;
    const planner = new PlannerService(prisma, { validate: async () => undefined } as unknown as PlannerLinksService);
    const actor = { tenantId: f.tenantId, clerkUserId: f.clerkUserId, role: 'standard_user' };
    await planner.saveProject(actor, project.id, { version: project.version, data: { name: 'Human edited project' } });
    await planner.saveTask(actor, task.id, { version: task.version, data: { name: 'Human edited task' } });
    const result = await runtime().consumeJob(f.scope);
    expect(result.outcome).toBe('applied');
    if (result.outcome === 'applied') {
      expect(result.recovered).toBe(true);
      expect(result.observation.current.projects[0]!.output.currentVersion).toBeGreaterThan(project.version);
      expect(result.observation.current.tasks[0]!.output.currentVersion).toBeGreaterThan(task.version);
    }
    const after = await state(f);
    expect((after.projects[0]!.data as { name: string }).name).toBe('Human edited project');
    expect((after.tasks[0]!.data as { name: string }).name).toBe('Human edited task');
    expect(after.applications).toHaveLength(1);
  }, 30_000);
  test('actual reciprocal consent cancellation denies a new effect without changing generation evidence', async () => {
    const { fixture: f } = await fixture();
    await cancelObjectivePlannerNativeFixtureConsent(prisma, f);
    await expect(runtime().consumeJob(f.scope)).rejects.toBeDefined();
    const s = await state(f); expect(s.projects).toHaveLength(0); expect(s.applications).toHaveLength(0);
    const job = await prisma.withTenant(f.tenantId, tx => tx.spDraftJob.findFirst({ where: { tenantId: f.tenantId, id: f.scope.generationJobId } }));
    expect(job?.status).toBe('completed'); expect(applicationHash(job?.input)).toBe(applicationHash(f.input));
  }, 30_000);
  test('fresh native membership and client-wall revocation deny retained reads of committed effects', async () => {
    for (const revoke of ['membership', 'wall'] as const) {
      const { fixture: f } = await fixture();
      expect((await runtime().consumeJob(f.scope)).outcome).toBe('applied');
      await prisma.withTenant(f.tenantId, async tx => {
        if (revoke === 'membership') await tx.$executeRaw`UPDATE tenant_memberships SET status='removed'
          WHERE tenant_id=${f.tenantId}::uuid AND id=${f.membershipId}::uuid`;
        else await tx.$executeRaw`DELETE FROM client_memory_access WHERE tenant_id=${f.tenantId}::uuid AND id=${f.id('wall-grant')}::uuid`;
      });
      await expect(runtime().consumeJob(f.scope)).rejects.toBeDefined();
      const s = await state(f); expect(s.projects).toHaveLength(1); expect(s.applications).toHaveLength(1);
    }
  }, 30_000);
  test('native tenant opt-out denies effects despite process opt-in', async () => {
    const { fixture: f } = await fixture({ tenantEnabled: false });
    await expect(runtime().consumeJob(f.scope)).rejects.toBeDefined();
    expect((await state(f)).projects).toHaveLength(0);
  }, 30_000);
  test('reserved generation delegation still refuses enabled=true for otherwise complete fixture scope', async () => {
    const { fixture: f } = await fixture();
    await expect(prisma.withTenant(f.tenantId, tx => tx.$executeRaw`INSERT INTO client_objective_workload_delegations
      (delegation_ref,tenant_id,client_id,objective_id,work_action,control_id,consent_id,control_version,generation_job_id,
       generation_request_id,generation_request_fingerprint,job_request_key,clerk_user_id,service_subject,audience,
       policy_revision,issued_at,absolute_expires_at,enabled)
      VALUES(${f.id('disabled-delegation-check')}::uuid,${f.tenantId}::uuid,${f.source.clientId}::uuid,${f.source.objectiveId}::uuid,
        'objective.strategy.draft',${f.id('generation-control')}::uuid,${f.admission.consentId}::uuid,1,${f.scope.generationJobId}::uuid,
        ${f.admission.generationRequestId}::uuid,${f.input.objectiveGeneration!.fingerprint},
        ${`objective-v1:${applicationHash([f.tenantId, f.clerkUserId, f.admission.generationRequestId])}`},${f.clerkUserId},
        'capiro-objective-generation-worker:v1','capiro:objective-strategy-api:v1',${applicationHash('synthetic-native-policy')},
        clock_timestamp(),clock_timestamp()+INTERVAL '10 minutes',true)`))
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
  }, 30_000);
  test('native tenant isolation and immutable revision privileges are checked through the actual runtime role', async () => {
    const { fixture: a } = await fixture(), { fixture: b } = await fixture();
    await prisma.withTenant(a.tenantId, async tx => {
      const hidden = await tx.$queryRaw<unknown[]>`SELECT id FROM sp_planner_resources WHERE tenant_id=${b.tenantId}::uuid`;
      expect(hidden).toHaveLength(0);
      const privileges = await tx.$queryRaw<Array<{ revisionUpdate: boolean; revisionDelete: boolean; rls: boolean; forceRls: boolean }>>`
        SELECT has_table_privilege(current_user,'client_objective_revisions','UPDATE') AS "revisionUpdate",
          has_table_privilege(current_user,'client_objective_revisions','DELETE') AS "revisionDelete",
          relrowsecurity AS rls,relforcerowsecurity AS "forceRls" FROM pg_class
          WHERE oid='sp_planner_resources'::regclass`;
      expect(privileges).toEqual([{ revisionUpdate: false, revisionDelete: false, rls: true, forceRls: true }]);
    });
  }, 30_000);
});
