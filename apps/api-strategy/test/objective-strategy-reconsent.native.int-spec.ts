import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import type { Prisma as CorePrisma } from '@prisma/client';
import { readObjectiveStrategyJobSubjectWithinTx } from '@capiro/shared/objective-strategy-intake';
import { PrismaService as CorePrismaService } from '../../api/src/prisma/prisma.service.js';
import type { ApplicationAuthorityIdentityProof } from '../../api/src/auth/application-authority.js';
import type { TenantContextMiddleware } from '../../api/src/tenant/tenant-context.middleware.js';
import { ObjectiveWorkService } from '../../api/src/clients/objectives/work/objective-work.service.js';
import { ObjectiveStrategyWorkOwner, objectiveGenerationLedgerId } from '../../api/src/clients/objectives/work/objective-strategy-work-owner.js';
import { parseObjectiveStrategySelection } from '../../api/src/clients/objectives/work/objective-strategy-selection.js';
import { workDigest } from '../../api/src/clients/objectives/work/objective-work-command.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { InternalServiceGuard } from '../src/auth/internal-service.guard.js';
import { ObjectiveCanonicalWorkloadAuthority } from '../src/planner/objective-canonical-authority.js';
import { ObjectiveCanonicalProducerService } from '../src/meri/objective-canonical-producer.service.js';
import { ObjectiveNativeReader } from '../src/meri/objective-native-reader.js';
import { buildObjectivePlannerNativeFixture, seedObjectivePlannerNativeReadyWithinTx } from './objective-planner-native-fixture.js';

/** The actual selected Core owner creates every consent, receipt, intake and
 * job. Actual Strategy admission is optional. This owned Docker target alone is
 * allowed; no historical qualification target is repointed. Synthetic identity
 * proof/ready rows are explicit fixtures. No model or accepted run is invoked. */
const native = process.env.OBJECTIVE_STRATEGY_RECONSENT_NATIVE === '1' ? describe : describe.skip;
type Json = Record<string, any>;
native('fresh Strategy consent after proven unpublished expiry on owned PG16', () => {
  let core: CorePrismaService, prisma: PrismaService, producer: ObjectiveCanonicalProducerService, transport: Request;
  let target: { sourceHead: string; containerId: string; databaseOid: number; databaseComment: string;
    postmasterStartedAtSeconds: string; expiresAtMs: number };
  const root = resolve(__dirname, '../../..');
  async function catalog(db: PrismaService | CorePrismaService) {
    const rows = await db.$queryRaw<Array<Json>>`SELECT current_database()::text AS name,d.oid::integer AS oid,
      shobj_description(d.oid,'pg_database') AS comment,floor(extract(epoch FROM pg_postmaster_start_time()))::text AS started,
      inet_server_port() AS port,current_user::text AS role,r.rolsuper AS superuser,r.rolbypassrls AS bypass,
      r.rolinherit AS inherits,r.rolcreatedb AS "createDb",r.rolcreaterole AS "createRole"
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`;
    expect(rows).toEqual([{ name: 'objective_qa', oid: target.databaseOid, comment: target.databaseComment,
      started: target.postmasterStartedAtSeconds, port: 5432, role: 'capiro_app', superuser: false,
      bypass: false, inherits: false, createDb: false, createRole: false }]);
    const owners = await db.$queryRaw<Array<Json>>`SELECT c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns,
      pg_has_role(current_user,c.relowner,'MEMBER') AS member,c.relrowsecurity AS rls FROM pg_class c
      WHERE c.oid IN ('public.sp_draft_job'::regclass,'public.client_objective_work_consents'::regclass)`;
    expect(owners).toEqual([{ owns: false, member: false, rls: true }, { owns: false, member: false, rls: true }]);
  }
  beforeAll(async () => {
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'apps', 'packages', 'scripts'],
      { cwd: root, encoding: 'utf8' }).trim()).toBe('');
    target = JSON.parse(await readFile(process.env.OBJECTIVE_STRATEGY_RECONSENT_TARGET_FILE!, 'utf8'));
    expect(target.sourceHead).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
    expect(target.expiresAtMs).toBeGreaterThan(Date.now()); expect(target.expiresAtMs).toBeLessThan(Date.now() + 86400000);
    expect(target.databaseComment).toMatch(/^task-owned:objective-strategies-20261106:[a-f0-9]{48}$/);
    const owned = JSON.parse(execFileSync('docker', ['inspect', 'codex-objective-retry-pg-20261106'], { encoding: 'utf8' }))[0];
    expect(owned.Id).toBe(target.containerId); expect(owned.Config.Labels['codex.task']).toBe('objective-strategies-20261106');
    expect(owned.State.Running).toBe(true);
    expect(owned.NetworkSettings.Ports['5432/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: '55492' }]);
    const databaseUrl = (await readFile(process.env.OBJECTIVE_STRATEGY_RECONSENT_DATABASE_URL_FILE!, 'utf8')).trim(), url = new URL(databaseUrl);
    expect([url.protocol, url.hostname, url.port, url.pathname, url.username]).toEqual(
      ['postgresql:', '127.0.0.1', '55492', '/objective_qa', 'capiro_app']);
    expect([...url.searchParams.keys()].every(key => ['schema', 'connection_limit', 'pool_timeout'].includes(key))).toBe(true);
    core = new CorePrismaService({ datasources: { db: { url: databaseUrl } } });
    prisma = new PrismaService({ datasources: { db: { url: databaseUrl } } });
    await core.$connect(); await prisma.$connect(); await catalog(core); await catalog(prisma);
    const config = new ConfigService({ INTERNAL_SERVICE_SECRET: 'synthetic-reconsent-test-only' });
    transport = { headers: { 'x-internal-service-secret': 'synthetic-reconsent-test-only' } } as unknown as Request;
    expect(new InternalServiceGuard(config).canActivate({ switchToHttp: () => ({ getRequest: () => transport }) } as ExecutionContext)).toBe(true);
    producer = new ObjectiveCanonicalProducerService(prisma, new ObjectiveCanonicalWorkloadAuthority(prisma, new ObjectiveNativeReader(config)));
  }, 30_000);
  afterAll(async () => { await core?.$disconnect(); await prisma?.$disconnect(); });

  async function selected(admit = false) {
    await catalog(core);
    const clocks = await core.$queryRaw<Array<{ ms: string }>>`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms`;
    const f = buildObjectivePlannerNativeFixture(Number(clocks[0]!.ms));
    await prisma.withTenant(f.tenantId, async tx => {
      await seedObjectivePlannerNativeReadyWithinTx(tx, f);
      await tx.$executeRaw`UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{objectiveStrategyIntake}',
        '{"enabled":true}'::jsonb) WHERE id=${f.tenantId}::uuid`;
    });
    const ctx: TenantContext = { tenantId: f.tenantId, clerkUserId: f.clerkUserId, userId: f.actorUserId,
      role: 'standard_user', tenantSlug: `objective-planner-qa-${f.tenantId}` };
    const evidence = { principal: { tenantId: f.tenantId, actorId: f.actorUserId }, expiresAtMs: f.nowMs + 120000,
      identityRevision: workDigest({ fixture: 'SYNTHETIC_RECONSENT_REQUEST', actor: f.actorUserId, member: f.membershipId }) };
    // Observe actual new rows only to inject a request-local release refusal.
    // All SQL and transaction behavior remain the real Prisma implementation.
    const active = new AsyncLocalStorage<CorePrisma.TransactionClient>();
    const witness = { denyRelease: false, observed: 0 };
    const observedCore = { withTenant: <T>(tenantId: string, run: (tx: CorePrisma.TransactionClient) => Promise<T>,
      options?: { timeoutMs?: number }) => core.withTenant(tenantId, tx => active.run(tx, () => run(tx)), options) };
    const proof: ApplicationAuthorityIdentityProof = { ...evidence, recheckCurrent: async () => {
      const members = await core.withTenant(f.tenantId, tx => tx.$queryRaw<Array<{ id: string }>>`
        SELECT m.id::text AS id FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id
        WHERE m.tenant_id=${f.tenantId}::uuid AND m.id=${f.membershipId}::uuid AND m.user_id=${f.actorUserId}::uuid
          AND m.status::text='active' AND m.role::text='standard_user' AND u.clerk_user_id=${f.clerkUserId} AND t.status::text='active'`);
      expect(members).toEqual([{ id: f.membershipId }]);
      const tx = active.getStore();
      if (witness.denyRelease && tx) {
        const writes = await tx.$queryRaw<Array<{ insertedHere: boolean }>>`SELECT
          (i.xmin::text=pg_current_xact_id_if_assigned()::text AND c.xmin::text=pg_current_xact_id_if_assigned()::text
            AND r.xmin::text=pg_current_xact_id_if_assigned()::text AND j.xmin::text=pg_current_xact_id_if_assigned()::text) AS "insertedHere"
          FROM client_objective_strategy_intakes i JOIN client_objective_work_consents c ON c.tenant_id=i.tenant_id AND c.id=i.consent_id
          JOIN client_objective_work_command_receipts r ON r.tenant_id=i.tenant_id AND r.id=i.command_receipt_id
          JOIN sp_draft_job j ON j.tenant_id=i.tenant_id AND j.id=i.generation_job_id
          WHERE i.tenant_id=${f.tenantId}::uuid AND i.control_version=2`;
        if (writes.length) {
          expect(writes).toEqual([{ insertedHere: true }]); witness.observed++;
          throw Error('Synthetic request-local release denied after actual retry writes');
        }
      }
      return evidence;
    } };
    const tenant = { readApplicationAuthority: async (req: Request, current: TenantContext) => {
      expect(req).toBe(transport); expect(current).toEqual(ctx); return proof;
    } } as unknown as TenantContextMiddleware;
    const service = (duration = 3000) => new ObjectiveWorkService(observedCore as CorePrismaService, tenant, new ObjectiveStrategyWorkOwner({
      OBJECTIVE_STRATEGY_INTAKE_ENABLED: 'true', OBJECTIVE_STRATEGY_CONSENT_DURATION_MS: String(duration),
    }, core));
    const command = (name: string, version: number, consentId: string | null) => parseObjectiveStrategySelection(f.source.clientId,
      f.source.objectiveId, { schemaVersion: 2, command: { schemaVersion: 1, requestId: f.id(`${name}-command`), command: 'retry',
        workAction: 'objective.strategy.draft', expectedObjectiveVersion: 2, expectedControlVersion: version,
        expectedCanonicalBindingVersion: 1, targetAuthorizationRequestId: consentId },
      selection: { type: 'coalition', generationRequestId: f.id(`${name}-generation`) } });
    const original = command('original', 0, null), receipt = await service().selectedStrategyCommand(ctx, transport, original);
    const body = { schemaVersion: 1 as const, generationJobId: receipt.generationJobId };
    if (admit) await producer.capture(transport, body);
    const retry = (name = 'retry') => command(name, 1, receipt.commandReceipt.authorizationRequestId);
    const submit = (request = retry()) => service(60000).selectedStrategyCommand(ctx, transport, request);
    const audit = () => core.withTenant(f.tenantId, async tx => {
      const rows = await tx.$queryRaw<Array<Json>>`SELECT
        (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM client_objective_strategy_intakes i WHERE tenant_id=${f.tenantId}::uuid) AS intakes,
        (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM client_objective_work_consents c WHERE tenant_id=${f.tenantId}::uuid) AS consents,
        (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM client_objective_work_command_receipts r WHERE tenant_id=${f.tenantId}::uuid) AS receipts,
        (SELECT coalesce(jsonb_agg(to_jsonb(k) ORDER BY k.id),'[]'::jsonb) FROM client_objective_work_controls k WHERE tenant_id=${f.tenantId}::uuid) AS controls,
        (SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY j.id),'[]'::jsonb) FROM sp_draft_job j WHERE tenant_id=${f.tenantId}::uuid) AS jobs,
        (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM sp_planner_resources p WHERE tenant_id=${f.tenantId}::uuid) AS resources`;
      expect(rows).toHaveLength(1); return rows[0]!;
    });
    async function expire() {
      for (let n = 0; n < 50; n++) {
        const rows = await core.withTenant(f.tenantId, tx => tx.$queryRaw<Array<{ expired: boolean }>>`
          SELECT clock_timestamp() >= original_deadline_at AS expired FROM client_objective_strategy_intakes
          WHERE tenant_id=${f.tenantId}::uuid AND generation_job_id=${receipt.generationJobId}::uuid`);
        if (rows[0]?.expired) return;
        await new Promise(done => setTimeout(done, 100));
      }
      throw Error('Original native consent did not expire within bounded observation');
    }
    return { f, ctx, service, command, original, receipt, body, retry, submit, audit, expire, witness };
  }

  test.each([false, true])('fresh consent advances CAS and preserves old receipt/job/admission; admitted=%s', async admitted => {
    const s = await selected(admitted), before = await s.audit();
    await expect(s.submit()).rejects.toMatchObject({ code: 'OUTCOME_UNCONFIRMED' });
    expect(await s.audit()).toEqual(before);
    await s.expire();
    const next = await s.submit(); expect(next.generationJobId).not.toBe(s.receipt.generationJobId);
    expect(next.commandReceipt).toMatchObject({ controlVersionBefore: 1, controlVersionAfter: 2,
      targetAuthorizationRequestId: s.receipt.commandReceipt.authorizationRequestId, outcome: 'reconsent_recorded' });
    const after = await s.audit();
    for (const key of ['intakes', 'consents', 'receipts', 'jobs', 'resources']) {
      for (const original of before[key]) expect(after[key].find((row: Json) => row.id === original.id)).toEqual(original);
    }
    expect(after.intakes).toHaveLength(2); expect(after.jobs).toHaveLength(2);
    const intake = after.intakes.find((row: Json) => row.generation_job_id === next.generationJobId);
    expect(intake).toMatchObject({ control_version: 2, canonical_plan_id: s.f.canonical.canonicalPlanId,
      source_revision_id: s.f.source.objectiveRevisionId, consent_id: next.commandReceipt.authorizationRequestId });
    expect(after.consents.find((row: Json) => row.id === intake.consent_id).previous_consent_id)
      .toBe(s.receipt.commandReceipt.authorizationRequestId);
    expect(await s.service(60000).selectedStrategyCommand(s.ctx, transport, s.original)).toEqual(s.receipt);
    expect(await s.submit()).toEqual(next); expect(await s.audit()).toEqual(after);
    await expect(core.withTenant(s.f.tenantId, tx => readObjectiveStrategyJobSubjectWithinTx(tx, {
      tenantId: s.f.tenantId, generationJobId: s.receipt.generationJobId, effect: true }))).rejects.toThrow();
    await expect(producer.capture(transport, s.body)).rejects.toThrow();
    // Fresh source still uses the ordinary canonical producer and can be admitted.
    await expect(producer.capture(transport, { schemaVersion: 1, generationJobId: next.generationJobId })).resolves.toMatchObject({
      sourceAdmission: { consentId: next.commandReceipt.authorizationRequestId, controlVersion: 2 } });
  }, 30000);
  test.each(['request', 'acceptance', 'normalization', 'producer'])('renamed %s evidence blocks even an expired queued attempt', async kind => {
    const s = await selected(true), key = objectiveGenerationLedgerId(`objective_canonical_generation_${kind}`, s.f.tenantId, s.f.clerkUserId, s.receipt.generationJobId);
    // Deliberately malformed negative fixture. Its body is not trusted; the
    // exact deterministic ledger identity itself prevents absence proof.
    await prisma.withTenant(s.f.tenantId, tx => tx.spPlannerResource.create({ data: {
      id: key, tenantId: s.f.tenantId, ownerId: s.f.clerkUserId, kind: 'renamed', data: {}, version: 1 } }));
    await s.expire(); const before = await s.audit();
    await expect(s.submit()).rejects.toMatchObject({ code: 'OUTCOME_UNCONFIRMED' }); expect(await s.audit()).toEqual(before);
  }, 30000);
  test('concurrent fresh commands commit exactly one next consent and preserve the losing CAS', async () => {
    const s = await selected(); await s.expire();
    const outcomes = await Promise.allSettled([s.submit(s.retry('left')), s.submit(s.retry('right'))]);
    expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(row => row.status === 'rejected')).toHaveLength(1);
    const after = await s.audit(); expect(after.intakes).toHaveLength(2); expect(after.jobs).toHaveLength(2);
    expect(after.controls.find((row: Json) => row.work_action === 'objective.strategy.draft').version).toBe(2);
  }, 30000);
  test('an old job row lock blocks retry before Core control writes', async () => {
    const s = await selected(); await s.expire(); const before = await s.audit();
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(done => { entered = done; }), held = new Promise<void>(done => { release = done; });
    const old = core.withTenant(s.f.tenantId, async tx => {
      await tx.$queryRaw`SELECT id FROM sp_draft_job WHERE tenant_id=${s.f.tenantId}::uuid AND id=${s.receipt.generationJobId}::uuid FOR UPDATE`;
      entered(); await held;
    });
    try { await waiting; await expect(s.submit()).rejects.toBeDefined(); } finally { release(); await old; }
    expect(await s.audit()).toEqual(before); await expect(s.submit()).resolves.toMatchObject({ commandReceipt: { controlVersionAfter: 2 } });
  }, 30000);
  test('final current-proof refusal rolls back all new retry rows and CAS', async () => {
    const s = await selected(); await s.expire(); const before = await s.audit(); s.witness.denyRelease = true;
    await expect(s.submit()).rejects.toMatchObject({ code: 'NOT_AVAILABLE' }); expect(s.witness.observed).toBe(1);
    expect(await s.audit()).toEqual(before); s.witness.denyRelease = false;
    await expect(s.submit()).resolves.toMatchObject({ commandReceipt: { controlVersionAfter: 2 } });
  }, 30000);
});
