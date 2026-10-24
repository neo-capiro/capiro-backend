import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { execFileSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TenantContext } from '@capiro/shared';
import type { ApplicationAuthorityIdentityProof } from '../../api/src/auth/application-authority.js';
import { PrismaService as CorePrismaService } from '../../api/src/prisma/prisma.service.js';
import type { TenantContextMiddleware } from '../../api/src/tenant/tenant-context.middleware.js';
import { ObjectiveWorkService } from '../../api/src/clients/objectives/work/objective-work.service.js';
import { ObjectivePlannerWorkOwner } from '../../api/src/clients/objectives/work/objective-planner-work-owner.js';
import { parseWorkCommand, workDigest, type WorkAction, type WorkRequest } from '../../api/src/clients/objectives/work/objective-work-command.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PlannerService } from '../src/planner/planner.service.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import { ObjectiveCanonicalApplicationService } from '../src/planner/objective-canonical-application.service.js';
import { ObjectivePlannerContinuationRuntime } from '../src/planner/objective-planner-continuation.runtime.js';
import { PLANNER_CONTINUATION_OPERATION } from '../src/planner/objective-planner-continuation.store.js';
import { applicationHash } from '../src/planner/objective-canonical-application.js';
import { buildObjectivePlannerNativeFixture, seedObjectivePlannerNativeFixture,
  type ObjectivePlannerNativeFixture } from './objective-planner-native-fixture.js';
import { advanceObjectivePlannerNativeReadySource, type ObjectivePlannerNativeReadySource } from './objective-planner-core-retry.native-fixture.js';
import { seedObjectivePlannerCoreNativeRegeneration } from './objective-planner-core-regeneration.native-fixture.js';
import { objectivePlannerNativeOptIn, objectivePlannerNativeTarget, requireObjectivePlannerNativePostmaster,
  requireObjectivePlannerNativeCatalog, type ObjectivePlannerNativeTarget } from './objective-planner-native-target.js';

/** Source qualification uses REAL Core/Strategy Prisma clients, transactions,
 * current native membership/wall/source readers, the concrete Core owner and
 * command kernel, and the actual Planner application runtime. The explicitly
 * synthetic request-local proof port below qualifies NONE of HTTP, JWT,
 * session custody, protected issuance, Meri SDK or provider execution.
 *
 * Absent opt-in, no Prisma client, manifest read or SQL is constructed/executed.
 * Cluster creation, migrations, roles, credentials and cleanup belong solely
 * to the separately reviewed exact-target runner. This suite creates none. */
const native = objectivePlannerNativeOptIn(process.env) ? describe : describe.skip;
const PLAN = 'objective.plan.prepare' as const;
const STRATEGY = 'objective.strategy.draft' as const;
type Json = Record<string, any>;
const settings = { OBJECTIVE_PLANNER_CONTINUATION_ENABLED: 'true', OBJECTIVE_PLANNER_CONSENT_DURATION_MS: '600000' };

native('Core Planner applied retry on the reviewed task-owned native target', () => {
  const workspaceRoot = resolve(__dirname, '../../..');
  let target: Extract<ObjectivePlannerNativeTarget, { enabled: true }>;
  let prisma: PrismaService;
  let core: CorePrismaService;
  // This opaque TEST transport carries no cookie, header, token or production
  // Request. Only the declared synthetic proof adapter consumes it.
  const transport = Object.freeze({ fixture: 'synthetic-request-local-proof' }) as unknown as Request;

  async function verifyCatalog(db: PrismaService | CorePrismaService) {
    const rows = await db.$queryRaw<Array<{ databaseName: string; databaseOid: number; roleName: string;
      serverPort: number; databaseComment: string | null; postmasterStartedAtSeconds: string;
      superuser: boolean; bypassRls: boolean }>>`
      SELECT current_database()::text AS "databaseName",d.oid::integer AS "databaseOid",current_user::text AS "roleName",
        inet_server_port() AS "serverPort",shobj_description(d.oid,'pg_database') AS "databaseComment",
        floor(extract(epoch FROM pg_postmaster_start_time()))::text AS "postmasterStartedAtSeconds",
        r.rolsuper AS superuser,r.rolbypassrls AS "bypassRls"
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`;
    expect(rows).toHaveLength(1); requireObjectivePlannerNativeCatalog(target, rows[0]!);
  }
  async function verifyImmutableLedgerPrivileges() {
    const rows = await core.$queryRaw<Array<{ tableName: string; canUpdate: boolean; canDelete: boolean }>>`
      SELECT names.table_name AS "tableName",
        has_table_privilege(current_user,'public.'||names.table_name,'UPDATE') AS "canUpdate",
        has_table_privilege(current_user,'public.'||names.table_name,'DELETE') AS "canDelete"
      FROM (VALUES ('client_objective_revisions'),('client_objective_work_command_receipts'),
        ('client_objective_work_consents'),('client_objective_work_intents')) AS names(table_name)
      ORDER BY names.table_name`;
    expect(rows).toEqual(['client_objective_revisions', 'client_objective_work_command_receipts',
      'client_objective_work_consents', 'client_objective_work_intents']
      .map(tableName => ({ tableName, canUpdate: false, canDelete: false })));
  }
  beforeAll(async () => {
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'apps', 'packages', 'scripts'],
      { cwd: workspaceRoot, encoding: 'utf8' });
    if (dirty.trim()) throw Error('Native Core retry qualification requires committed clean application source');
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8' }).trim();
    const manifest = JSON.parse(await readFile(resolve(workspaceRoot, '.objective-planner-native/owned-target.json'), 'utf8'));
    const checked = objectivePlannerNativeTarget(process.env, manifest, { workspaceRoot, sourceHead, nowMs: Date.now() });
    if (!checked.enabled) throw Error('Native Core suite requires explicit opt-in');
    target = checked;
    let processAlive = false;
    try { process.kill(target.manifest.processId, 0); processAlive = true; } catch { /* Dead PID refuses. */ }
    requireObjectivePlannerNativePostmaster(target, {
      workspaceRealPath: await realpath(workspaceRoot), dataDirectoryRealPath: await realpath(target.manifest.dataDirectory),
      pgVersion: await readFile(resolve(target.manifest.dataDirectory, 'PG_VERSION'), 'utf8'),
      postmasterPid: await readFile(resolve(target.manifest.dataDirectory, 'postmaster.pid'), 'utf8'), processAlive });
    // First construction follows pure target + actual local process ownership.
    prisma = new PrismaService({ datasources: { db: { url: target.databaseUrl } } });
    core = new CorePrismaService({ datasources: { db: { url: target.databaseUrl } } });
    await prisma.$connect(); await core.$connect();
    await verifyCatalog(prisma); await verifyCatalog(core);
    await verifyImmutableLedgerPrivileges();
  }, 30_000);
  afterAll(async () => { await core?.$disconnect(); await prisma?.$disconnect(); });

  const context = (f: ObjectivePlannerNativeFixture) => ({ tenantId: f.tenantId, userId: f.actorUserId,
    clerkUserId: f.clerkUserId, role: 'standard_user' }) as TenantContext;
  const application = () => new ObjectiveCanonicalApplicationService(new PlannerService(prisma, { validate: async () => undefined } as unknown as PlannerLinksService));
  const runtime = (app = application()) => new ObjectivePlannerContinuationRuntime(prisma, app,
    new ConfigService({ OBJECTIVE_PLANNER_CONTINUATION_ENABLED: 'true' }));
  async function fixture() {
    await verifyCatalog(prisma); await verifyCatalog(core);
    const clocks = await prisma.$queryRaw<Array<{ ms: string }>>`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms`;
    const f = buildObjectivePlannerNativeFixture(Number(clocks[0]!.ms));
    return seedObjectivePlannerNativeFixture(prisma, f);
  }
  async function audit(f: ObjectivePlannerNativeFixture) {
    return core.withTenant(f.tenantId, async tx => ({
      controls: (await tx.$queryRaw<Array<{ record: Json }>>`SELECT to_jsonb(c) AS record FROM client_objective_work_controls c
        WHERE tenant_id=${f.tenantId}::uuid ORDER BY id`).map(row => row.record),
      consents: (await tx.$queryRaw<Array<{ record: Json }>>`SELECT to_jsonb(c) AS record FROM client_objective_work_consents c
        WHERE tenant_id=${f.tenantId}::uuid ORDER BY id`).map(row => row.record),
      commands: (await tx.$queryRaw<Array<{ record: Json }>>`SELECT to_jsonb(r) AS record FROM client_objective_work_command_receipts r
        WHERE tenant_id=${f.tenantId}::uuid ORDER BY id`).map(row => row.record),
      resources: (await tx.$queryRaw<Array<{ record: Json }>>`SELECT to_jsonb(r) AS record FROM sp_planner_resources r
        WHERE tenant_id=${f.tenantId}::uuid AND (kind LIKE 'objective_planner_continuation_%' OR
          kind IN ('objective_canonical_application_receipt','objective_canonical_materialization_receipt','objective_canonical_application_head'))
        ORDER BY id`).map(row => row.record),
    }));
  }
  async function service(f: ObjectivePlannerNativeFixture, options: {
    failRelease?: () => boolean; db?: CorePrismaService; consentDurationMs?: number;
  } = {}) {
    const ctx = context(f);
    const clocks = await core.$queryRaw<Array<{ ms: string }>>`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms`;
    const expiresAtMs = Number(clocks[0]!.ms) + 120_000;
    const evidence = { principal: { tenantId: ctx.tenantId, actorId: ctx.userId }, expiresAtMs,
      identityRevision: workDigest({ kind: 'SYNTHETIC_NATIVE_REQUEST_PROOF', principal: ctx.userId, membershipId: f.membershipId }) };
    let rechecks = 0;
    const proof: ApplicationAuthorityIdentityProof = { ...evidence, recheckCurrent: async () => {
      rechecks++;
      // Native identity is re-read on the same exact owned target. No Clerk,
      // token validation, network request or current wall grant is fabricated.
      const rows = await core.withTenant(f.tenantId, tx => tx.$queryRaw<Array<{ id: string }>>`SELECT m.id::text AS id
        FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id
        WHERE m.tenant_id=${f.tenantId}::uuid AND m.id=${f.membershipId}::uuid AND m.user_id=${f.actorUserId}::uuid
          AND m.status::text='active' AND u.clerk_user_id=${f.clerkUserId} AND t.status::text='active'
          AND m.role::text='standard_user'`);
      if (rows.length !== 1 || options.failRelease?.())
        throw Error('Synthetic request proof no longer available');
      return evidence;
    } };
    const tenant = { readApplicationAuthority: async (req: Request, actual: TenantContext) => {
      expect(req).toBe(transport); expect(actual).toEqual(ctx); return proof;
    } } as unknown as TenantContextMiddleware;
    const work = new ObjectiveWorkService(options.db ?? core, tenant, new ObjectivePlannerWorkOwner({ ...settings,
      OBJECTIVE_PLANNER_CONSENT_DURATION_MS: String(options.consentDurationMs ?? 600000) }));
    return { work, ctx, expiresAtMs, proofRechecks: () => rechecks };
  }
  const request = (f: ObjectivePlannerNativeFixture, advanced?: ObjectivePlannerNativeReadySource, action: WorkAction = PLAN): WorkRequest =>
    parseWorkCommand(f.source.clientId, f.source.objectiveId, { schemaVersion: 1,
      requestId: f.id(`core-native-${advanced ? 'advanced' : 'same'}-${action}`), command: 'retry', workAction: action,
      expectedObjectiveVersion: advanced?.canonical.requestedObjectiveVersion ?? f.canonical.requestedObjectiveVersion,
      expectedCanonicalBindingVersion: advanced?.canonical.bindingVersion ?? f.canonical.bindingVersion,
      expectedControlVersion: 1, targetAuthorizationRequestId: action === PLAN ? f.plannerConsentId : f.admission.consentId });
  async function applied() {
    const seeded = await fixture(); expect((await runtime().consumeJob(seeded.fixture.scope)).outcome).toBe('applied');
    return seeded;
  }

  test('actual Core applied read then ready source advance records one Plan-only consent and exact idempotent receipt', async () => {
    const { fixture: f } = await applied(), client = await service(f);
    const read = await client.work.read(client.ctx, transport, { clientId: f.source.clientId, objectiveId: f.source.objectiveId, workAction: PLAN });
    expect(read.reconciliation).toBe('accounted');
    const before = await audit(f), advanced = await advanceObjectivePlannerNativeReadySource(core, client.ctx, f);
    const retry = request(f, advanced), receipt = await client.work.command(client.ctx, transport, retry);
    expect(receipt.outcome).toBe('reconsent_recorded'); expect(receipt.workAction).toBe(PLAN);
    expect(receipt.authorizationRequestId).not.toBe(f.plannerConsentId);
    expect(receipt.sourceRevision).toEqual({ id: advanced.source.objectiveRevisionId, version: advanced.source.objectiveVersion });
    expect(receipt.rootIntentId).toBe(advanced.canonical.requestedIntentId);
    expect(Date.parse(receipt.consent!.expiresAt)).toBeLessThanOrEqual(client.expiresAtMs);
    const after = await audit(f);
    expect(after.consents.filter(c => c.work_action === PLAN)).toHaveLength(2);
    expect(after.commands.filter(c => c.work_action === PLAN)).toHaveLength(2);
    expect(after.controls.find(c => c.work_action === PLAN)?.version).toBe(2);
    expect(after.controls.filter(c => c.work_action === STRATEGY)).toEqual(before.controls.filter(c => c.work_action === STRATEGY));
    expect(after.consents.filter(c => c.work_action === STRATEGY)).toEqual(before.consents.filter(c => c.work_action === STRATEGY));
    expect(after.resources).toEqual(before.resources);
    const replay = await client.work.command(client.ctx, transport, retry);
    expect(replay).toEqual(receipt); expect(await audit(f)).toEqual(after);
  }, 30_000);

  test('same-source applied retry and Strategy generation retry remain denied without native consent writes', async () => {
    const { fixture: f } = await applied(), client = await service(f), before = await audit(f);
    await expect(client.work.command(client.ctx, transport, request(f))).rejects.toMatchObject({ code: 'OUTCOME_UNCONFIRMED' });
    await expect(client.work.command(client.ctx, transport, request(f, undefined, STRATEGY))).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    expect(await audit(f)).toEqual(before);
  }, 30_000);

  test('leased original outcome remains uncertain after real Objective source advancement', async () => {
    const { fixture: f } = await fixture(), app = application();
    app.prepareWithinOwnerTransaction = async () => { throw Error('Synthetic stopped application after committed native lease'); };
    await expect(runtime(app).consumeJob(f.scope)).rejects.toBeDefined();
    const before = await audit(f), client = await service(f);
    expect(before.resources.find(r => r.kind === PLANNER_CONTINUATION_OPERATION)?.data.state).toBe('leased');
    const advanced = await advanceObjectivePlannerNativeReadySource(core, client.ctx, f);
    await expect(client.work.command(client.ctx, transport, request(f, advanced))).rejects.toMatchObject({ code: 'OUTCOME_UNCONFIRMED' });
    expect(await audit(f)).toEqual(before);
  }, 30_000);

  test('actual cancelled operation retains native historical proof after a new Core consent', async () => {
    const { fixture: f } = await fixture(), app = application(), client = await service(f);
    app.prepareWithinOwnerTransaction = async () => { throw Error('Synthetic stopped application after committed native lease'); };
    await expect(runtime(app).consumeJob(f.scope)).rejects.toBeDefined();
    const leased = await audit(f), originalOperation = leased.resources.find(r => r.kind === PLANNER_CONTINUATION_OPERATION)!;
    expect(originalOperation.data.state).toBe('leased');
    const cancel = parseWorkCommand(f.source.clientId, f.source.objectiveId, { schemaVersion: 1,
      requestId: f.id('core-native-historical-cancel'), command: 'cancel', workAction: PLAN,
      expectedObjectiveVersion: f.source.objectiveVersion, expectedCanonicalBindingVersion: f.canonical.bindingVersion,
      expectedControlVersion: 1, targetAuthorizationRequestId: f.plannerConsentId });
    const cancelled = await client.work.command(client.ctx, transport, cancel);
    expect(cancelled.outcome).toBe('cancellation_recorded'); expect(cancelled.controlVersionAfter).toBe(2);
    expect(await runtime().consumeJob(f.scope)).toEqual({ outcome: 'cancelled', terminalReceiptId: originalOperation.id });
    const settled = await audit(f), terminal = settled.resources.find(r => r.id === originalOperation.id)!;
    expect(terminal.data.state).toBe('cancelled'); expect(terminal.data.terminal.receiptId).toBe(terminal.id);
    expect(terminal.data.original).toEqual(originalOperation.data.original);
    expect(terminal.data.work).toEqual(originalOperation.data.work);
    const retry = parseWorkCommand(f.source.clientId, f.source.objectiveId, { schemaVersion: 1,
      requestId: f.id('core-native-historical-retry'), command: 'retry', workAction: PLAN,
      expectedObjectiveVersion: f.source.objectiveVersion, expectedCanonicalBindingVersion: f.canonical.bindingVersion,
      expectedControlVersion: 2, targetAuthorizationRequestId: f.plannerConsentId });
    const receipt = await client.work.command(client.ctx, transport, retry);
    expect(receipt.outcome).toBe('reconsent_recorded'); expect(receipt.controlVersionAfter).toBe(3);
    expect(receipt.authorizationRequestId).not.toBe(f.plannerConsentId);
    // This read has a current consent with no operation and a distinct, REAL
    // persisted cancelled original. The owner must read the historical native
    // consent/command/intent/revision under the unchanged restricted DB role.
    const read = await client.work.read(client.ctx, transport,
      { clientId: f.source.clientId, objectiveId: f.source.objectiveId, workAction: PLAN });
    expect(read.reconciliation).toBe('not_started');
    expect(read.control.currentAuthorizationRequestId).toBe(receipt.authorizationRequestId);
    const after = await audit(f);
    expect(after.resources).toEqual(settled.resources);
    expect(after.resources).toHaveLength(1);
    expect(after.consents.find(c => c.id === f.plannerConsentId)).toEqual(leased.consents.find(c => c.id === f.plannerConsentId));
    expect(after.commands.find(c => c.created_consent_id === f.plannerConsentId))
      .toEqual(leased.commands.find(c => c.created_consent_id === f.plannerConsentId));
    expect(after.consents.filter(c => c.work_action === PLAN)).toHaveLength(2);
    const outputs = await core.withTenant(f.tenantId, tx => tx.$queryRaw<Array<{ present: boolean }>>`SELECT
      EXISTS(SELECT 1 FROM sp_planner_projects WHERE tenant_id=${f.tenantId}::uuid AND id=${f.canonical.canonicalProjectId}::uuid) OR
      EXISTS(SELECT 1 FROM sp_planner_tasks WHERE tenant_id=${f.tenantId}::uuid AND ${f.canonical.canonicalProjectId}::uuid=ANY(project_ids)) AS present`);
    expect(outputs).toEqual([{ present: false }]);
  }, 30_000);

  test('current native membership and client-wall revocation deny advanced-source consent', async () => {
    for (const revoke of ['membership', 'wall'] as const) {
      const { fixture: f } = await applied(), client = await service(f);
      const advanced = await advanceObjectivePlannerNativeReadySource(core, client.ctx, f);
      await core.withTenant(f.tenantId, async tx => {
        if (revoke === 'membership') await tx.$executeRaw`UPDATE tenant_memberships SET status='removed'
          WHERE tenant_id=${f.tenantId}::uuid AND id=${f.membershipId}::uuid`;
        else await tx.$executeRaw`DELETE FROM client_memory_access
          WHERE tenant_id=${f.tenantId}::uuid AND id=${f.id('wall-grant')}::uuid`;
      });
      const before = await audit(f);
      await expect(client.work.command(client.ctx, transport, request(f, advanced))).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
      expect(await audit(f)).toEqual(before);
    }
  }, 30_000);

  test('release-proof loss rolls back actual inserted Core consent, control change and reciprocal receipt', async () => {
    const { fixture: f } = await applied(), ctx = context(f);
    const advanced = await advanceObjectivePlannerNativeReadySource(core, ctx, f), retry = request(f, advanced), before = await audit(f);
    let observedUncommittedPair = false;
    // Intercept only to observe genuine uncommitted rows. Every production SQL
    // call still executes on the real native Core transaction unchanged.
    const observed = new Proxy(core, { get(db, key) {
      if (key !== 'withTenant') { const value = Reflect.get(db, key); return typeof value === 'function' ? value.bind(db) : value; }
      return (tenant: string, run: (tx: any) => Promise<unknown>, opts: any) => db.withTenant(tenant, tx => run(new Proxy(tx, {
        get(inner, member) {
          if (member !== '$executeRaw') { const value = Reflect.get(inner, member); return typeof value === 'function' ? value.bind(inner) : value; }
          return async (parts: TemplateStringsArray, ...values: unknown[]) => {
            const result = await inner.$executeRaw(parts, ...values);
            if (parts.join('?').includes('INSERT INTO client_objective_work_command_receipts')) {
              const rows = await inner.$queryRaw<Array<{ id: string }>>`SELECT r.id::text AS id
                FROM client_objective_work_command_receipts r JOIN client_objective_work_consents c ON c.command_receipt_id=r.id
                JOIN client_objective_work_controls ctl ON ctl.current_consent_id=c.id AND ctl.id=c.control_id
                WHERE r.tenant_id=${f.tenantId}::uuid AND r.request_id=${retry.command.requestId}::uuid`;
              observedUncommittedPair = rows.length === 1;
            }
            return result;
          };
        },
      })), opts);
    } });
    // The receipt-miss read transaction also rechecks identity. Trigger only
    // after observing the REAL writer transaction's reciprocal pair.
    const client = await service(f, { db: observed, failRelease: () => observedUncommittedPair });
    await expect(client.work.command(client.ctx, transport, retry)).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(observedUncommittedPair).toBe(true); expect(client.proofRechecks()).toBeGreaterThanOrEqual(4);
    expect(await audit(f)).toEqual(before);
  }, 30_000);

  test('actual new Planner consent admits an accepted schema2 saved generation and native v3 Planner regeneration', async () => {
    const { fixture: f } = await applied(), client = await service(f), before = await audit(f);
    const originalOperation = before.resources.find(r => r.kind === PLANNER_CONTINUATION_OPERATION)!;
    const advanced = await advanceObjectivePlannerNativeReadySource(core, client.ctx, f);
    const receipt = await client.work.command(client.ctx, transport, request(f, advanced));
    // Explicit synthetic human edit to an existing native output identity;
    // immutable application/owner receipts and their head remain untouched.
    const editedProject = await prisma.withTenant(f.tenantId, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`planner:${f.tenantId}`},0))`;
      const project = await tx.spPlannerProject.findFirst({ where: { tenantId: f.tenantId, id: f.canonical.canonicalProjectId } });
      expect(project).not.toBeNull();
      return tx.spPlannerProject.update({ where: { id: project!.id }, data: {
        data: { ...(project!.data as Json), name: 'Human edited retained project' }, version: { increment: 1 } } });
    });
    const pending = await client.work.read(client.ctx, transport, { clientId: f.source.clientId,
      objectiveId: f.source.objectiveId, workAction: PLAN, requestId: receipt.requestId });
    expect(pending.reconciliation).toBe('not_started');
    expect(pending.control).toEqual({ version: receipt.controlVersionAfter,
      currentAuthorizationRequestId: receipt.authorizationRequestId, cancelledAt: null });
    expect(pending.consent).toMatchObject(receipt.consent!); expect(pending.commandReceipt).toEqual(receipt);
    expect(await prisma.withTenant(f.tenantId, tx => tx.spPlannerProject.findFirst({
      where: { tenantId: f.tenantId, id: editedProject.id } }))).toEqual(editedProject);
    const retained = await audit(f); expect(retained.resources).toEqual(before.resources);
    const extraRetry = parseWorkCommand(f.source.clientId, f.source.objectiveId, { schemaVersion: 1,
      requestId: f.id('core-native-retained-head-status-only'), command: 'retry', workAction: PLAN,
      expectedObjectiveVersion: advanced.source.objectiveVersion,
      expectedCanonicalBindingVersion: advanced.canonical.bindingVersion,
      expectedControlVersion: receipt.controlVersionAfter, targetAuthorizationRequestId: receipt.authorizationRequestId });
    await expect(client.work.command(client.ctx, transport, extraRetry)).rejects.toMatchObject({ code: 'OUTCOME_UNCONFIRMED' });
    expect(await audit(f)).toEqual(retained);
    const generated = await seedObjectivePlannerCoreNativeRegeneration(prisma, f, advanced, receipt);
    const requestRechecks = client.proofRechecks();
    // A separate server runtime consumes the durable accepted generation. It
    // receives no browser transport or request-local proof callback.
    const result = await runtime().consumeJob(generated.scope);
    expect(result.outcome).toBe('applied');
    expect(client.proofRechecks()).toBe(requestRechecks);
    const after = await audit(f), operations = after.resources.filter(r => r.kind === PLANNER_CONTINUATION_OPERATION);
    expect(operations).toHaveLength(2);
    expect(operations.find(r => r.id === originalOperation.id)).toEqual(originalOperation);
    const next = operations.find(r => r.id !== originalOperation.id)!;
    expect(next.data.work.consentId).toBe(receipt.authorizationRequestId);
    expect(next.data.work.canonical).toEqual(advanced.canonical);
    expect(next.data.state).toBe('applied');
    expect(next.data.original.originalDeadlineAt).not.toBe(originalOperation.data.original.originalDeadlineAt);
    expect(after.resources.filter(r => r.kind === 'objective_canonical_application_receipt')).toHaveLength(2);
    const owners = after.resources.filter(r => r.kind === 'objective_canonical_materialization_receipt');
    expect(owners.find(r => r.data.binding.canonical.bindingVersion === advanced.canonical.bindingVersion)?.data.receiptVersion).toBe(3);
    expect(applicationHash(originalOperation.data.original)).toBe(applicationHash(
      operations.find(r => r.id === originalOperation.id)!.data.original));
    // Positive Core v3 status requires the complete old/new applied ancestry
    // and each original native consent/command/intent/revision proof.
    const status = await client.work.read(client.ctx, transport, { clientId: f.source.clientId,
      objectiveId: f.source.objectiveId, workAction: PLAN, requestId: receipt.requestId });
    expect(status.reconciliation).toBe('accounted');
    expect(status.objective).toEqual({ id: f.source.objectiveId, status: 'ready',
      revision: { id: advanced.source.objectiveRevisionId, version: advanced.source.objectiveVersion } });
    expect(status.control).toEqual({ version: receipt.controlVersionAfter,
      currentAuthorizationRequestId: next.data.work.consentId, cancelledAt: null });
    expect(status.consent).toMatchObject(receipt.consent!);
    expect(status.commandReceipt).toEqual(receipt);
    expect(await audit(f)).toEqual(after);
    const projectAfter = await prisma.withTenant(f.tenantId, tx => tx.spPlannerProject.findFirst({
      where: { tenantId: f.tenantId, id: editedProject.id } }));
    expect((projectAfter!.data as Json).name).toBe('Human edited retained project');
    const outputRequest = { clientId: f.source.clientId, objectiveId: f.source.objectiveId, workAction: PLAN,
      source: { revision: { id: advanced.source.objectiveRevisionId, version: advanced.source.objectiveVersion },
        canonicalBindingVersion: advanced.canonical.bindingVersion } };
    const received = await client.work.outputs(client.ctx, transport, outputRequest);
    expect(received.scope).toBe('planner_project_receipts'); expect(received.taskDiscovery).toBe('unsupported');
    expect(received.selectedSource).toEqual(outputRequest.source);
    expect(received.observation.state).toBe('applied'); expect(received.observation.strategy).toEqual({ availability: 'unavailable' });
    const project = received.observation.planner.projects[0]!;
    const originalOwner = before.resources.find(r => r.kind === 'objective_canonical_materialization_receipt')!;
    const currentOwner = owners.find(r => r.data.binding.canonical.bindingVersion === advanced.canonical.bindingVersion)!;
    expect(project.creation).toEqual({ receiptVersion: 2, recordedAt: originalOwner.data.result.recordedAt,
      version: originalOwner.data.result.projects[0].output.createdVersion });
    expect(project.application).toEqual({ receiptVersion: 3, recordedAt: currentOwner.data.result.recordedAt });
    expect(project.current).toEqual({ selection: { kind: 'planner_project', id: editedProject.id },
      title: 'Human edited retained project', ownerVersion: { kind: 'counter', value: projectAfter!.version },
      observedAt: received.observedAt });
    expect(await audit(f)).toEqual(after);
    const originalFixtureSource = applicationHash({ canonical: f.canonical, source: f.source, plannerConsentId: f.plannerConsentId });
    const currentFixture = { ...f, canonical: advanced.canonical, source: advanced.source,
      plannerConsentId: receipt.authorizationRequestId! };
    const thirdReady = await advanceObjectivePlannerNativeReadySource(core, client.ctx, currentFixture);
    expect(applicationHash({ canonical: f.canonical, source: f.source, plannerConsentId: f.plannerConsentId })).toBe(originalFixtureSource);
    const thirdRequest = parseWorkCommand(f.source.clientId, f.source.objectiveId, { schemaVersion: 1,
      requestId: f.id('core-native-next-ready-after-v3'), command: 'retry', workAction: PLAN,
      expectedObjectiveVersion: thirdReady.source.objectiveVersion,
      expectedCanonicalBindingVersion: thirdReady.canonical.bindingVersion,
      expectedControlVersion: receipt.controlVersionAfter, targetAuthorizationRequestId: receipt.authorizationRequestId });
    const thirdReceipt = await client.work.command(client.ctx, transport, thirdRequest);
    expect(thirdReceipt.outcome).toBe('reconsent_recorded');
    expect(thirdReceipt.controlVersionAfter).toBe(receipt.controlVersionAfter + 1);
    const pendingV3 = await client.work.read(client.ctx, transport, { clientId: f.source.clientId,
      objectiveId: f.source.objectiveId, workAction: PLAN, requestId: thirdReceipt.requestId });
    expect(pendingV3.reconciliation).toBe('not_started');
    expect(pendingV3.control.currentAuthorizationRequestId).toBe(thirdReceipt.authorizationRequestId);
    expect(pendingV3.control.version).toBe(thirdReceipt.controlVersionAfter);
    expect(pendingV3.consent).toMatchObject(thirdReceipt.consent!); expect(pendingV3.commandReceipt).toEqual(thirdReceipt);
    const afterThird = await audit(f);
    expect(afterThird.resources).toEqual(after.resources);
    expect(afterThird.consents.filter(c => c.id !== thirdReceipt.authorizationRequestId)).toEqual(after.consents);
    expect(afterThird.commands.filter(c => c.id !== thirdReceipt.receiptId)).toEqual(after.commands);
    expect(afterThird.controls.filter(c => c.work_action === STRATEGY)).toEqual(after.controls.filter(c => c.work_action === STRATEGY));
    expect(await prisma.withTenant(f.tenantId, tx => tx.spPlannerProject.findFirst({
      where: { tenantId: f.tenantId, id: editedProject.id } }))).toEqual(projectAfter);
    // Mutable output access is a separate current observation. The archived
    // known identity still belongs to the full retained native ancestry; the
    // public read must nevertheless withhold its selector and metadata.
    await prisma.withTenant(f.tenantId, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`planner:${f.tenantId}`},0))`;
      await tx.spPlannerProject.update({ where: { id: editedProject.id },
        data: { archived: true, version: { increment: 1 } } });
    });
    const inaccessible = await client.work.outputs(client.ctx, transport, outputRequest);
    expect(inaccessible.requestedSource).toEqual({ revision: { id: thirdReady.source.objectiveRevisionId,
      version: thirdReady.source.objectiveVersion }, canonicalBindingVersion: thirdReady.canonical.bindingVersion });
    expect(inaccessible.selectedSource).toEqual(outputRequest.source);
    expect(inaccessible.observation.state).toBe('applied');
    expect(inaccessible.observation.planner).toEqual({ availability: 'unavailable', projects: [
      { availability: 'unavailable', creation: null, application: null, current: null },
    ] });
    expect(JSON.stringify(inaccessible.observation)).not.toContain(editedProject.id);
    expect(await audit(f)).toEqual(afterThird);
  }, 30_000);

  test('expired unused Planner consent permits a fresh human consent through its full retained chain and separate runtime', async () => {
    const { fixture: f } = await applied(), before = await audit(f);
    const originalOperation = before.resources.find(r => r.kind === PLANNER_CONTINUATION_OPERATION)!;
    const short = await service(f, { consentDurationMs: 2000 });
    const advanced = await advanceObjectivePlannerNativeReadySource(core, short.ctx, f);
    const firstRequest = request(f, advanced);
    const first = await short.work.command(short.ctx, transport, firstRequest);
    expect(first.outcome).toBe('reconsent_recorded');
    expect(Date.parse(first.consent!.expiresAt) - Date.parse(first.consent!.confirmedAt)).toBeLessThanOrEqual(2000);
    const afterFirst = await audit(f);
    expect(afterFirst.resources).toEqual(before.resources);
    // Use the real database clock and the REAL issuer's immutable short consent.
    // No timestamp, immutable ledger or captured generation ceiling is patched.
    const waitStarted = Date.now();
    for (;;) {
      const rows = await core.withTenant(f.tenantId, tx => tx.$queryRaw<Array<{ expired: boolean }>>`
        SELECT clock_timestamp() >= expires_at AS expired FROM client_objective_work_consents
        WHERE tenant_id=${f.tenantId}::uuid AND id=${first.authorizationRequestId}::uuid`);
      expect(rows).toHaveLength(1);
      if (rows[0]!.expired) break;
      if (Date.now() - waitStarted > 6000) throw Error('Native short consent did not expire within its bounded DB-clock wait');
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    const client = await service(f), secondRequest = parseWorkCommand(f.source.clientId, f.source.objectiveId, {
      schemaVersion: 1, requestId: f.id('core-native-expired-unused-renewal'), command: 'retry', workAction: PLAN,
      expectedObjectiveVersion: advanced.source.objectiveVersion,
      expectedCanonicalBindingVersion: advanced.canonical.bindingVersion,
      expectedControlVersion: first.controlVersionAfter, targetAuthorizationRequestId: first.authorizationRequestId });
    const second = await client.work.command(client.ctx, transport, secondRequest);
    expect(second.outcome).toBe('reconsent_recorded'); expect(second.targetAuthorizationRequestId).toBe(first.authorizationRequestId);
    expect(second.controlVersionAfter).toBe(first.controlVersionAfter + 1);
    expect(second.authorizationRequestId).not.toBe(first.authorizationRequestId);
    expect(Date.parse(second.consent!.confirmedAt)).toBeGreaterThanOrEqual(Date.parse(first.consent!.expiresAt));
    expect(Date.parse(second.consent!.expiresAt)).toBeLessThanOrEqual(client.expiresAtMs);
    const afterSecond = await audit(f);
    expect(afterSecond.resources).toEqual(before.resources);
    expect(afterSecond.consents.filter(c => c.id !== second.authorizationRequestId)).toEqual(afterFirst.consents);
    expect(afterSecond.commands.filter(c => c.id !== second.receiptId)).toEqual(afterFirst.commands);
    expect(afterSecond.controls.filter(c => c.work_action === STRATEGY)).toEqual(before.controls.filter(c => c.work_action === STRATEGY));
    const pending = await client.work.read(client.ctx, transport, { clientId: f.source.clientId,
      objectiveId: f.source.objectiveId, workAction: PLAN, requestId: second.requestId });
    expect(pending.reconciliation).toBe('not_started'); expect(pending.consent).toMatchObject(second.consent!);
    expect(pending.control.currentAuthorizationRequestId).toBe(second.authorizationRequestId);
    expect(pending.commandReceipt).toEqual(second); expect(await audit(f)).toEqual(afterSecond);
    expect(await client.work.command(client.ctx, transport, secondRequest)).toEqual(second);
    expect(await audit(f)).toEqual(afterSecond);
    await expect(client.work.command(client.ctx, transport, { ...secondRequest,
      command: { ...secondRequest.command, expectedControlVersion: second.controlVersionAfter } }))
      .rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
    expect(await audit(f)).toEqual(afterSecond);
    // A retained old success is readable; it does not extend its original
    // operation, admission or delegation and cannot create another effect.
    expect((await runtime().consumeJob(f.scope)).outcome).toBe('applied');
    expect(await audit(f)).toEqual(afterSecond);
    const generated = await seedObjectivePlannerCoreNativeRegeneration(prisma,
      { ...f, plannerConsentId: first.authorizationRequestId! }, advanced, second);
    const rechecks = client.proofRechecks();
    expect((await runtime().consumeJob(generated.scope)).outcome).toBe('applied');
    expect(client.proofRechecks()).toBe(rechecks);
    const afterApplied = await audit(f), operations = afterApplied.resources.filter(r => r.kind === PLANNER_CONTINUATION_OPERATION);
    expect(operations).toHaveLength(2); expect(operations.find(r => r.id === originalOperation.id)).toEqual(originalOperation);
    const current = operations.find(r => r.id !== originalOperation.id)!;
    expect(current.data.work.consentId).toBe(second.authorizationRequestId);
    expect(current.data.work.controlVersion).toBe(second.controlVersionAfter);
    expect(current.data.work.canonical).toEqual(advanced.canonical); expect(current.data.state).toBe('applied');
    const deadline = Date.parse(current.data.original.originalDeadlineAt);
    expect(deadline).toBeLessThanOrEqual(Date.parse(second.consent!.expiresAt));
    expect(deadline).toBeLessThanOrEqual(generated.admission.effectExpiresAtMs);
    expect(deadline).toBeLessThanOrEqual(generated.acceptance.effectExpiresAtMs);
    expect(deadline).toBeLessThanOrEqual(generated.publication.request.originalExpiresAtMs);
    expect(afterApplied.consents.filter(c => c.work_action === PLAN)).toEqual(afterSecond.consents.filter(c => c.work_action === PLAN));
    expect(afterApplied.commands.filter(c => c.work_action === PLAN)).toEqual(afterSecond.commands.filter(c => c.work_action === PLAN));
    for (const consent of afterSecond.consents) expect(afterApplied.consents.find(c => c.id === consent.id)).toEqual(consent);
    for (const command of afterSecond.commands) expect(afterApplied.commands.find(c => c.id === command.id)).toEqual(command);
    const status = await client.work.read(client.ctx, transport, { clientId: f.source.clientId,
      objectiveId: f.source.objectiveId, workAction: PLAN, requestId: second.requestId });
    expect(status.reconciliation).toBe('accounted'); expect(status.commandReceipt).toEqual(second);
    expect(status.control.currentAuthorizationRequestId).toBe(second.authorizationRequestId);
    expect(await audit(f)).toEqual(afterApplied);
  }, 30_000);
});
