import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { systemDelay, systemRandom } from '@capiro/shared';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { lockObjectiveStrategyIntakeWithinTx } from '@capiro/shared/objective-strategy-intake';
import { PrismaService as CorePrismaService } from '../../api/src/prisma/prisma.service.js';
import { createPrismaObjectiveIssuancePort } from '../../api/src/auth/workload-authority/objective-workload-issuance-prisma.js';
import type { ApplicationAuthorityIdentityProof } from '../../api/src/auth/application-authority.js';
import type { TenantContextMiddleware } from '../../api/src/tenant/tenant-context.middleware.js';
import { ObjectiveWorkService } from '../../api/src/clients/objectives/work/objective-work.service.js';
import { ObjectiveStrategyWorkOwner } from '../../api/src/clients/objectives/work/objective-strategy-work-owner.js';
import { parseObjectiveStrategySelection, objectiveStrategySelectionDigest,
  objectiveStrategyRequestCodec } from '../../api/src/clients/objectives/work/objective-strategy-selection.js';
import { workDigest } from '../../api/src/clients/objectives/work/objective-work-command.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma-client/index.js';
import type { Prisma as CorePrisma } from '@prisma/client';
import { DraftJobService } from '../src/meri/draft-job.service.js';
import { DraftJobWorkerService } from '../src/meri/draft-job-worker.service.js';
import type { MeriService } from '../src/meri/meri.service.js';
import type { StrategyOrchestratorClient } from '../src/meri/strategy-orchestrator.client.js';
import type { StrategyContextPlaneClient } from '../src/meri/strategy-context-plane.client.js';
import { objectivePersistence, ObjectiveLeaseLost } from '../src/meri/objective-generation-completion.js';
import type { DraftJobInput } from '../src/meri/draft-job.types.js';
import { ObjectiveCanonicalProducerService } from '../src/meri/objective-canonical-producer.service.js';
import { ObjectiveCanonicalWorkloadAuthority } from '../src/planner/objective-canonical-authority.js';
import { buildSnapshot } from '../src/strategy/versioning.js';
import { buildObjectivePlannerNativeFixture, seedObjectivePlannerNativeReadyWithinTx,
  type ObjectivePlannerNativeFixture } from './objective-planner-native-fixture.js';
import { objectivePlannerNativeOptIn, objectivePlannerNativeTarget, requireObjectivePlannerNativeCatalog,
  requireObjectivePlannerNativePostmaster, type ObjectivePlannerNativeTarget } from './objective-planner-native-target.js';

/** Real native SQL/services on the separately reviewed disposable target only.
 * Identity/ready-source fixtures are synthetic; no accepted Meri facts, provider
 * result, canonical admission, enabled delegation or workload grant is seeded.
 * Request-local proof below remains an explicitly synthetic TEST boundary.
 * The reviewed runner alone provisions SQL, roles, credentials and cleanup.
 * Without opt-in no client, file observation, process probe or SQL is started. */
const native = objectivePlannerNativeOptIn(process.env) ? describe : describe.skip;
type Json = Record<string, any>;

native('selected Strategy intake on the reviewed native target', () => {
  const workspaceRoot = resolve(__dirname, '../../..');
  let target: Extract<ObjectivePlannerNativeTarget, { enabled: true }>;
  let prisma: PrismaService;
  let core: CorePrismaService;
  const transport = Object.freeze({ fixture: 'synthetic-native-selected-request-proof' }) as unknown as Request;

  async function verifyCatalog(db: PrismaService | CorePrismaService) {
    const rows = await db.$queryRaw<Array<{ databaseName: string; databaseOid: number; roleName: string;
      serverPort: number; databaseComment: string | null; postmasterStartedAtSeconds: string;
      superuser: boolean; bypassRls: boolean; inherits: boolean; createDb: boolean; createRole: boolean }>>`
      SELECT current_database()::text AS "databaseName",d.oid::integer AS "databaseOid",current_user::text AS "roleName",
        inet_server_port() AS "serverPort",shobj_description(d.oid,'pg_database') AS "databaseComment",
        floor(extract(epoch FROM pg_postmaster_start_time()))::text AS "postmasterStartedAtSeconds",
        r.rolsuper AS superuser,r.rolbypassrls AS "bypassRls",r.rolinherit AS inherits,
        r.rolcreatedb AS "createDb",r.rolcreaterole AS "createRole"
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`;
    expect(rows).toHaveLength(1);
    requireObjectivePlannerNativeCatalog(target, rows[0]!);
    expect([rows[0]!.inherits, rows[0]!.createDb, rows[0]!.createRole]).toEqual([false, false, false]);
    const owners = await db.$queryRaw<Array<{ owns: boolean; member: boolean }>>`
      SELECT (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owns,
        pg_has_role(current_user,c.relowner,'MEMBER') AS member
      FROM pg_class c WHERE c.oid='public.sp_draft_job'::regclass`;
    expect(owners).toEqual([{ owns: false, member: false }]);
  }

  beforeAll(async () => {
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'apps', 'packages', 'scripts'],
      { cwd: workspaceRoot, encoding: 'utf8' });
    if (dirty.trim()) throw Error('Native Strategy qualification requires committed clean application source');
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8' }).trim();
    const manifest = JSON.parse(await readFile(resolve(workspaceRoot, '.objective-planner-native/owned-target.json'), 'utf8'));
    const checked = objectivePlannerNativeTarget(process.env, manifest, { workspaceRoot, sourceHead, nowMs: Date.now() });
    if (!checked.enabled || checked.manifest.port !== 56455) throw Error('Native Strategy qualification requires its reviewed private port');
    target = checked;
    let processAlive = false;
    try { process.kill(target.manifest.processId, 0); processAlive = true; } catch { /* A dead owner refuses. */ }
    requireObjectivePlannerNativePostmaster(target, {
      workspaceRealPath: await realpath(workspaceRoot), dataDirectoryRealPath: await realpath(target.manifest.dataDirectory),
      pgVersion: await readFile(resolve(target.manifest.dataDirectory, 'PG_VERSION'), 'utf8'),
      postmasterPid: await readFile(resolve(target.manifest.dataDirectory, 'postmaster.pid'), 'utf8'), processAlive,
    });
    prisma = new PrismaService({ datasources: { db: { url: target.databaseUrl } } });
    core = new CorePrismaService({ datasources: { db: { url: target.databaseUrl } } });
    await prisma.$connect(); await core.$connect();
    await verifyCatalog(prisma); await verifyCatalog(core);
  }, 30_000);
  afterAll(async () => { await core?.$disconnect(); await prisma?.$disconnect(); });

  async function ready() {
    await verifyCatalog(prisma); await verifyCatalog(core);
    const clocks = await prisma.$queryRaw<Array<{ ms: string }>>`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms`;
    const f = buildObjectivePlannerNativeFixture(Number(clocks[0]!.ms));
    await prisma.withTenant(f.tenantId, async tx => {
      await seedObjectivePlannerNativeReadyWithinTx(tx, f);
      await tx.$executeRaw`UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{objectiveStrategyIntake}',
        '{"enabled":true}'::jsonb) WHERE id=${f.tenantId}::uuid`;
    });
    return f;
  }
  const context = (f: ObjectivePlannerNativeFixture) => ({ tenantId: f.tenantId, clerkUserId: f.clerkUserId,
    userId: f.actorUserId, role: 'standard_user' as const, tenantSlug: `objective-planner-qa-${f.tenantId}` });
  /** TEST-only observation of the real WorkService transaction. Only its
   * withTenant call uses this adapter; native identity rereads and the owner's
   * withSystem port keep their original Prisma client. No query is replaced. */
  class SelectedWriteWitness {
    private readonly active = new AsyncLocalStorage<{ tenantId: string; tx: CorePrisma.TransactionClient }>();
    readonly observed: Array<{ intakeId: string; consentId: string; receiptId: string; jobId: string }> = [];
    readonly prisma: Pick<CorePrismaService, 'withTenant'>;
    constructor(db: CorePrismaService) {
      this.prisma = { withTenant: <T>(tenantId: string, run: (tx: CorePrisma.TransactionClient) => Promise<T>,
        options?: { timeoutMs?: number }) => db.withTenant(tenantId,
        tx => this.active.run({ tenantId, tx }, () => run(tx)), options) };
    }
    async afterActualWrites(f: ObjectivePlannerNativeFixture): Promise<boolean> {
      const active = this.active.getStore();
      if (!active || active.tenantId !== f.tenantId) return false;
      const request = selectedRequest(f);
      const rows = await active.tx.$queryRaw<Array<{ intake: Json; consent: Json; receipt: Json; job: Json;
        insertedHere: boolean }>>`SELECT to_jsonb(i) AS intake,to_jsonb(c) AS consent,to_jsonb(r) AS receipt,to_jsonb(j) AS job,
        (i.xmin::text=pg_current_xact_id_if_assigned()::text AND c.xmin::text=pg_current_xact_id_if_assigned()::text
          AND r.xmin::text=pg_current_xact_id_if_assigned()::text AND j.xmin::text=pg_current_xact_id_if_assigned()::text) AS "insertedHere"
        FROM client_objective_strategy_intakes i
        JOIN client_objective_work_consents c ON c.tenant_id=i.tenant_id AND c.client_id=i.client_id
          AND c.objective_id=i.objective_id AND c.work_action=i.work_action AND c.control_id=i.control_id AND c.id=i.consent_id
        JOIN client_objective_work_command_receipts r ON r.tenant_id=i.tenant_id AND r.client_id=i.client_id
          AND r.objective_id=i.objective_id AND r.work_action=i.work_action AND r.control_id=i.control_id AND r.id=i.command_receipt_id
        JOIN client_objective_work_controls k ON k.tenant_id=i.tenant_id AND k.client_id=i.client_id
          AND k.objective_id=i.objective_id AND k.work_action=i.work_action AND k.id=i.control_id
          AND k.current_consent_id=c.id AND k.version=i.control_version AND k.cancelled_at IS NULL
        JOIN sp_draft_job j ON j.tenant_id=i.tenant_id AND j.client_id=i.client_id AND j.id=i.generation_job_id
          AND j.owner_user_id=i.original_clerk_user_id AND j.request_key=i.job_request_key
        WHERE i.tenant_id=${f.tenantId}::uuid AND i.client_id=${f.source.clientId}::uuid
          AND i.objective_id=${f.source.objectiveId}::uuid AND i.work_action='objective.strategy.draft'
          AND i.command_request_id=${request.work.command.requestId}::uuid`;
      if (rows.length === 0) return false;
      expect(rows).toHaveLength(1);
      const { intake, consent, receipt, job, insertedHere } = rows[0]!;
      // Fresh insertion in THIS transaction, rather than an earlier recovery
      // read or a committed replay, is required before pausing/refusing release.
      expect(insertedHere).toBe(true);
      expect(intake).toMatchObject({ actor_user_id: f.actorUserId, actor_membership_id: f.membershipId,
        original_clerk_user_id: f.clerkUserId, control_version: 1, selected_type: request.selection.type,
        generation_request_id: request.selection.generationRequestId, canonical_plan_id: f.canonical.canonicalPlanId,
        canonical_strategy_id: f.canonical.canonicalStrategyId, canonical_project_id: f.canonical.canonicalProjectId,
        canonical_epoch: f.canonical.epoch, canonical_binding_version: f.canonical.bindingVersion,
        root_intent_id: f.canonical.requestedIntentId, source_revision_id: f.source.objectiveRevisionId,
        source_objective_version: f.source.objectiveVersion, source_snapshot_hash: f.canonical.snapshotHash,
        root_actor_user_id: f.actorUserId, wrapper_sha256: objectiveStrategySelectionDigest(request) });
      expect(intake.wrapper).toEqual({ schemaVersion: 2, command: request.work.command, selection: request.selection });
      expect(consent).toMatchObject({ id: intake.consent_id, command_receipt_id: receipt.id,
        command_request_id: request.work.command.requestId, consenting_actor_user_id: f.actorUserId,
        consenting_membership_id: f.membershipId, previous_consent_id: null, payload_digest: workDigest(request.work) });
      expect(receipt).toMatchObject({ request_id: request.work.command.requestId, created_consent_id: consent.id,
        result_consent_id: consent.id, target_consent_id: null, command_kind: 'retry', outcome: 'reconsent_recorded',
        actor_user_id: f.actorUserId, actor_membership_id: f.membershipId, control_version_before: 0,
        control_version_after: 1, payload_digest: consent.payload_digest });
      expect(receipt.command).toEqual(request.work.command);
      expect(job).toMatchObject({ status: 'queued', attempt: 1, claimed_by: null, claimed_at: null, strategy_id: null });
      expect(job.input.objectiveCanonicalReservation).toEqual({ schemaVersion: 1, intakeId: intake.id,
        consentId: consent.id, commandReceiptId: receipt.id, wrapperSha256: objectiveStrategySelectionDigest(request) });
      expect(Object.hasOwn(job.input, 'canonicalGeneration')).toBe(false);
      this.observed.push({ intakeId: intake.id, consentId: consent.id, receiptId: receipt.id, jobId: job.id });
      return true;
    }
  }
  async function selectedClient(f: ObjectivePlannerNativeFixture, failRelease = false, durationMs = 600000,
    releaseBarrier?: () => Promise<void>, db: CorePrismaService = core) {
    const ctx = context(f) as TenantContext;
    const clocks = await core.$queryRaw<Array<{ ms: string }>>`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms`;
    const evidence = { principal: { tenantId: f.tenantId, actorId: f.actorUserId },
      expiresAtMs: Number(clocks[0]!.ms) + 120_000,
      identityRevision: workDigest({ fixture: 'SYNTHETIC_NATIVE_REQUEST_PROOF', actor: f.actorUserId, member: f.membershipId }) };
    const writeWitness = new SelectedWriteWitness(db);
    const proof: ApplicationAuthorityIdentityProof = { ...evidence, recheckCurrent: async () => {
      const rows = await core.withTenant(f.tenantId, tx => tx.$queryRaw<Array<{ id: string }>>`
        SELECT m.id::text AS id FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id
        WHERE m.tenant_id=${f.tenantId}::uuid AND m.id=${f.membershipId}::uuid AND m.user_id=${f.actorUserId}::uuid
          AND m.status::text='active' AND m.role::text='standard_user' AND u.clerk_user_id=${f.clerkUserId}
          AND t.status::text='active'`);
      if (rows.length !== 1) throw Error('Synthetic request-local proof refused release');
      if ((failRelease || releaseBarrier) && await writeWitness.afterActualWrites(f)) {
        if (releaseBarrier) await releaseBarrier();
        if (failRelease) throw Error('Synthetic request-local proof refused release after actual native writes');
      }
      return evidence;
    } };
    const tenant = { readApplicationAuthority: async (req: Request, current: TenantContext) => {
      expect(req).toBe(transport); expect(current).toEqual(ctx); return proof;
    } } as unknown as TenantContextMiddleware;
    // WorkService only calls withTenant; the adapter delegates to the supplied
    // actual client (including NonUtcCore) and never supplies SQL return values.
    const work = new ObjectiveWorkService(writeWitness.prisma as CorePrismaService, tenant, new ObjectiveStrategyWorkOwner({
      OBJECTIVE_STRATEGY_INTAKE_ENABLED: 'true', OBJECTIVE_STRATEGY_CONSENT_DURATION_MS: String(durationMs),
    }, db));
    return { work, ctx, writeWitness };
  }
  const selectedRequest = (f: ObjectivePlannerNativeFixture) => parseObjectiveStrategySelection(f.source.clientId,
    f.source.objectiveId, { schemaVersion: 2, command: { schemaVersion: 1, requestId: f.id('selected-command'),
      command: 'retry', workAction: 'objective.strategy.draft', expectedObjectiveVersion: f.source.objectiveVersion,
      expectedControlVersion: 0, expectedCanonicalBindingVersion: f.canonical.bindingVersion, targetAuthorizationRequestId: null },
    selection: { type: 'coalition', generationRequestId: f.id('selected-generation-request') } });
  async function audit(f: ObjectivePlannerNativeFixture) {
    return core.withTenant(f.tenantId, async tx => ({
      intakes: (await tx.$queryRaw<Array<{ record: Json }>>`SELECT to_jsonb(i) AS record FROM client_objective_strategy_intakes i
        WHERE tenant_id=${f.tenantId}::uuid ORDER BY id`).map(r => r.record),
      commands: (await tx.$queryRaw<Array<{ record: Json }>>`SELECT to_jsonb(r) AS record FROM client_objective_work_command_receipts r
        WHERE tenant_id=${f.tenantId}::uuid ORDER BY id`).map(r => r.record),
      consents: (await tx.$queryRaw<Array<{ record: Json }>>`SELECT to_jsonb(c) AS record FROM client_objective_work_consents c
        WHERE tenant_id=${f.tenantId}::uuid ORDER BY id`).map(r => r.record),
      controls: (await tx.$queryRaw<Array<{ record: Json }>>`SELECT to_jsonb(c) AS record FROM client_objective_work_controls c
        WHERE tenant_id=${f.tenantId}::uuid ORDER BY id`).map(r => r.record),
      jobs: (await tx.$queryRaw<Array<{ record: Json }>>`SELECT to_jsonb(j) AS record FROM sp_draft_job j
        WHERE tenant_id=${f.tenantId}::uuid ORDER BY id`).map(r => r.record),
      custody: (await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM sp_planner_resources
        WHERE tenant_id=${f.tenantId}::uuid ORDER BY id`),
      delegations: (await tx.$queryRaw<Array<{ enabled: boolean }>>`SELECT enabled FROM client_objective_workload_delegations
        WHERE tenant_id=${f.tenantId}::uuid`),
    }));
  }
  const drafts = () => new DraftJobService(prisma, { delay: systemDelay, random: systemRandom });
  function worker() {
    // These external ports are unreachable in claim/sweep and reservation
    // refusal. Throwing records accidental dispatch; no model or HTTP runs.
    let externalCalls = 0;
    const deny = async () => { externalCalls++; throw Error('Native reservation test attempted external work'); };
    const actual = new DraftJobWorkerService(prisma, { draft: deny } as unknown as MeriService,
      { configured: false } as StrategyOrchestratorClient, new ConfigService({ STRATEGY_DRAFT_JOB_STALE_MS: '1' }),
      { recheckObjective: deny } as unknown as StrategyContextPlaneClient);
    return Object.assign(actual, { externalCalls: () => externalCalls }) as unknown as {
      claimNext(): Promise<Json | null>; reclaimStale(): Promise<void>; failExpired(): Promise<void>;
      processJob(job: Json): Promise<void>; externalCalls(): number;
    };
  }

  async function selected(durationMs = 600000) {
    const f = await ready(), client = await selectedClient(f, false, durationMs), request = selectedRequest(f);
    const receipt = await client.work.selectedStrategyCommand(client.ctx, transport, request);
    const rows = await audit(f);
    expect(rows.intakes).toHaveLength(1); expect(rows.jobs).toHaveLength(1);
    return { f, client, request, receipt, rows, intake: rows.intakes[0]!, job: rows.jobs[0]! };
  }
  async function manualStrategy(tx: Prisma.TransactionClient, f: ObjectivePlannerNativeFixture, id: string) {
    // A manual output-gate control, never a claimed Objective generation.
    return tx.$executeRaw`INSERT INTO public.sp_strategy
      (id,tenant_id,client_id,title,type,owner_user_id,created_by_user_id,updated_at)
      VALUES (${id}::uuid,${f.tenantId}::uuid,${f.source.clientId}::uuid,'Native manual gate control','authorization',
        ${f.clerkUserId},${f.clerkUserId},clock_timestamp())`;
  }
  async function manualVersion(tx: Prisma.TransactionClient, f: ObjectivePlannerNativeFixture, strategyId: string, id: string) {
    const snapshot = buildSnapshot({ ...f.strategy, id: strategyId, title: 'Native manual gate control', meriSummary: null }, []);
    return tx.$executeRaw`INSERT INTO public.sp_version
      (id,tenant_id,strategy_id,snapshot,author_kind,author_user_id,note,coalescible)
      VALUES (${id}::uuid,${f.tenantId}::uuid,${strategyId}::uuid,${JSON.stringify(snapshot)}::jsonb,
        'person',${f.clerkUserId},'Native manual gate control',false)`;
  }

  test('actual selected approval commits v1 consent receipt and one exact immutable intake/reserved job atomically', async () => {
    const { f, client, request, receipt, intake, job, rows } = await selected();
    expect(receipt.schemaVersion).toBe(2); expect(receipt.selection).toEqual(request.selection);
    const command = receipt.commandReceipt;
    expect(command.schemaVersion).toBe(1); expect(command.outcome).toBe('reconsent_recorded');
    expect(command.workAction).toBe('objective.strategy.draft');
    expect(command.controlVersionBefore).toBe(0); expect(command.controlVersionAfter).toBe(1);
    expect(command.payloadDigest).toBe(workDigest(request.work));
    expect(rows.commands).toHaveLength(1); expect(rows.consents).toHaveLength(1); expect(rows.controls).toHaveLength(1);
    expect(rows.commands[0]!.command).toEqual(request.work.command);
    expect(intake.wrapper).toEqual({ schemaVersion: 2, command: request.work.command, selection: request.selection });
    expect(intake.wrapper_sha256).toBe(objectiveStrategySelectionDigest(request));
    expect(intake.selected_type).toBe('coalition');
    expect(intake.command_receipt_id).toBe(command.receiptId); expect(intake.consent_id).toBe(command.authorizationRequestId);
    expect(intake.actor_user_id).toBe(f.actorUserId); expect(intake.actor_membership_id).toBe(f.membershipId);
    expect(intake.original_clerk_user_id).toBe(f.clerkUserId);
    expect(intake.source_revision_id).toBe(f.source.objectiveRevisionId);
    expect(intake.source_snapshot_hash).toBe(f.canonical.snapshotHash);
    expect(job.id).toBe(intake.generation_job_id); expect(job.status).toBe('queued'); expect(job.attempt).toBe(1);
    expect(job.claimed_by).toBeNull(); expect(job.claimed_at).toBeNull(); expect(job.strategy_id).toBeNull();
    expect(job.owner_user_id).toBe(f.clerkUserId); expect(job.input.bearer).toBeNull();
    expect(job.input.objectiveGeneration.request).toEqual(intake.typed_request);
    expect(job.input.objectiveGeneration.fingerprint).toBe(intake.request_fingerprint);
    expect(intake.request_fingerprint).toBe(objectiveStrategyRequestCodec.digest(intake.typed_request));
    expect(intake.job_request_key).toBe(objectiveStrategyRequestCodec.requestKey(f.tenantId, f.clerkUserId,
      request.selection.generationRequestId));
    expect(job.request_key).toBe(intake.job_request_key);
    expect(job.input.dto).toEqual({ clientId: f.source.clientId, type: 'coalition', goal: f.objectiveSnapshot.outcome });
    expect(job.input.objectiveCanonicalReservation).toEqual({ schemaVersion: 1, intakeId: intake.id,
      consentId: command.authorizationRequestId, commandReceiptId: command.receiptId,
      wrapperSha256: objectiveStrategySelectionDigest(request) });
    expect(Object.hasOwn(job.input, 'canonicalGeneration')).toBe(false);
    const savedJob = await prisma.withTenant(f.tenantId, tx => tx.spDraftJob.findFirst({ where: { id: job.id } }));
    expect(savedJob?.deadlineAt.getTime()).toBe(Date.parse(intake.original_deadline_at));
    expect(savedJob!.deadlineAt.getTime()).toBeLessThanOrEqual(Date.parse(command.consent!.expiresAt));
    expect(rows.custody).toEqual([]); expect(rows.delegations).toEqual([]);
    expect(await client.work.selectedStrategyCommand(client.ctx, transport, request)).toEqual(receipt);
    expect(await audit(f)).toEqual(rows);
  });

  test('same request identity cannot replace the immutable selected type or generation request', async () => {
    const { f, client, request, rows } = await selected();
    for (const selection of [{ ...request.selection, type: 'regulatory' as const },
      { ...request.selection, generationRequestId: f.id('replacement-generation-request') }]) {
      await expect(client.work.selectedStrategyCommand(client.ctx, transport, { ...request, selection }))
        .rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
      expect(await audit(f)).toEqual(rows);
    }
  });

  test('non-UTC native transaction preserves the original consent/intake/job deadline epoch', async () => {
    const f = await ready();
    // A real Prisma client/transaction with one extra local session setting;
    // no SQL/current reader or application transition is substituted.
    class NonUtcCore extends CorePrismaService {
      override async withTenant<T>(tenantId: string, run: (tx: CorePrisma.TransactionClient) => Promise<T>,
        options?: { timeoutMs?: number }): Promise<T> {
        return super.withTenant(tenantId, async tx => {
          await tx.$executeRaw`SET LOCAL TIME ZONE 'America/New_York'`;
          const zone = await tx.$queryRaw<Array<{ zone: string }>>`SELECT current_setting('TimeZone') AS zone`;
          expect(zone).toEqual([{ zone: 'America/New_York' }]);
          return run(tx);
        }, options);
      }
    }
    const nonUtc = new NonUtcCore({ datasources: { db: { url: target.databaseUrl } } });
    try {
      await nonUtc.$connect(); await verifyCatalog(nonUtc);
      const client = await selectedClient(f, false, 600000, undefined, nonUtc);
      const receipt = await client.work.selectedStrategyCommand(client.ctx, transport, selectedRequest(f));
      const observed = await nonUtc.withTenant(f.tenantId, tx => tx.$queryRaw<Array<{
        jobId: string; jobMs: string; intakeMs: string; consentMs: string;
      }>>`SELECT j.id::text AS "jobId",
        floor(extract(epoch FROM (j.deadline_at AT TIME ZONE 'UTC'))*1000)::text AS "jobMs",
        floor(extract(epoch FROM i.original_deadline_at)*1000)::text AS "intakeMs",
        floor(extract(epoch FROM c.expires_at)*1000)::text AS "consentMs"
        FROM client_objective_strategy_intakes i JOIN sp_draft_job j ON j.id=i.generation_job_id AND j.tenant_id=i.tenant_id
        JOIN client_objective_work_consents c ON c.id=i.consent_id AND c.tenant_id=i.tenant_id
        WHERE i.tenant_id=${f.tenantId}::uuid AND i.command_receipt_id=${receipt.commandReceipt.receiptId}::uuid`);
      expect(observed).toHaveLength(1);
      const expected = String(Date.parse(receipt.commandReceipt.consent!.expiresAt));
      expect(observed[0]!.jobMs).toBe(expected); expect(observed[0]!.intakeMs).toBe(expected);
      expect(observed[0]!.consentMs).toBe(expected);
      const job = await prisma.withTenant(f.tenantId, tx => tx.spDraftJob.findFirst({ where: { id: observed[0]!.jobId } }));
      expect(job?.deadlineAt.getTime()).toBe(Number(expected));
    } finally { await nonUtc.$disconnect(); }
  });

  test('release refusal rolls back native control, consent, receipt, intake and actual reserved job together', async () => {
    const f = await ready(), client = await selectedClient(f, true), before = await audit(f);
    await expect(client.work.selectedStrategyCommand(client.ctx, transport, selectedRequest(f)))
      .rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(client.writeWitness.observed).toHaveLength(1);
    const after = await audit(f);
    for (const key of ['commands', 'consents', 'controls', 'intakes', 'jobs'] as const) {
      expect(before[key]).toEqual([]); expect(after[key]).toEqual([]);
    }
    expect(after).toEqual(before);
  });

  test('concurrent identical selected approvals recover exactly one native receipt/intake/job', async () => {
    const f = await ready(), a = await selectedClient(f), b = await selectedClient(f), request = selectedRequest(f);
    const results = await Promise.all([a.work.selectedStrategyCommand(a.ctx, transport, request),
      b.work.selectedStrategyCommand(b.ctx, transport, request)]);
    expect(results[0]).toEqual(results[1]);
    const rows = await audit(f);
    for (const key of ['commands', 'consents', 'controls', 'intakes', 'jobs'] as const) expect(rows[key]).toHaveLength(1);
  });

  test('actual intake remains invisible to legacy claim until its marked job and receipt commit together', async () => {
    const f = await ready(), before = await audit(f);
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    // This pauses only the declared TEST request-proof release boundary after
    // real source writes. Neither native SQL nor the worker is replaced.
    const client = await selectedClient(f, false, 600000, async () => { entered(); await releasePromise; });
    const pending = client.work.selectedStrategyCommand(client.ctx, transport, selectedRequest(f));
    try {
      await Promise.race([enteredPromise, pending.then(() => { throw Error('Intake committed without the release barrier'); })]);
      expect(client.writeWitness.observed).toHaveLength(1);
      expect(await audit(f)).toEqual(before);
      expect(await worker().claimNext()).toBeNull();
      const gate = await prisma.withTenant(f.tenantId, tx => tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${`capiro.objective-strategy.job-creators:v1:${f.tenantId}`},0)) AS acquired`);
      expect(gate).toEqual([{ acquired: false }]);
    } finally { release(); await pending; }
    const committed = await audit(f);
    expect(committed.intakes).toHaveLength(1); expect(committed.jobs).toHaveLength(1);
    expect(committed.jobs[0]!.input.objectiveCanonicalReservation.intakeId).toBe(committed.intakes[0]!.id);
    expect(await worker().claimNext()).toBeNull();
  });

  test('real reserved job is excluded from legacy claim, sweeps, dispatch and persistence', async () => {
    const { f, job, rows } = await selected(), w = worker();
    await w.failExpired(); await w.reclaimStale();
    expect(await w.claimNext()).toBeNull();
    const savedJob = await prisma.withTenant(f.tenantId, tx => tx.spDraftJob.findFirst({ where: { id: job.id } }));
    expect(savedJob).not.toBeNull();
    const claimed = { id: job.id, tenantId: f.tenantId, ownerUserId: f.clerkUserId,
      claimToken: '', attempt: job.attempt, input: job.input as DraftJobInput, streamPreview: null,
      deadlineAt: savedJob!.deadlineAt };
    await w.processJob(claimed);
    expect(w.externalCalls()).toBe(0);
    const external = { recheckObjective: async () => { throw Error('Reserved job reached external context'); } } as unknown as StrategyContextPlaneClient;
    const persistence = objectivePersistence(claimed, external, () => undefined);
    await expect(persistence.beforeTransaction!()).rejects.toBeInstanceOf(ObjectiveLeaseLost);
    await expect(prisma.withTenant(f.tenantId, tx => persistence.beforeWrite(tx))).rejects.toBeInstanceOf(ObjectiveLeaseLost);
    expect(await audit(f)).toEqual(rows);
  });

  test('actual expiry does not let either deadline sweep consume a reserved Objective job', async () => {
    const { f, job, rows } = await selected(3000);
    const stopAt = Date.now() + 10_000;
    let expired = false;
    while (!expired && Date.now() < stopAt) {
      const clocks = await prisma.withTenant(f.tenantId, tx => tx.$queryRaw<Array<{ expired: boolean }>>`
        SELECT clock_timestamp()>=deadline_at AS expired FROM sp_draft_job WHERE tenant_id=${f.tenantId}::uuid AND id=${job.id}::uuid`);
      expired = clocks[0]?.expired === true;
      if (!expired) await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(expired).toBe(true);
    await worker().failExpired();
    expect(await audit(f)).toEqual(rows);
  }, 20_000);

  test('closed actual workload authority cannot promote a reservation or fabricate a canonical admission', async () => {
    const { f, job, rows } = await selected();
    const producer = new ObjectiveCanonicalProducerService(prisma, new ObjectiveCanonicalWorkloadAuthority());
    const refused: unknown = await producer.capture(transport, { schemaVersion: 1, generationJobId: job.id })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(503);
    expect((refused as HttpException).getResponse()).toEqual({ schemaVersion: 1, code: 'AUTHORITY_UNAVAILABLE',
      message: 'Objective generation evidence is unavailable.', outcome: 'unconfirmed' });
    expect(await audit(f)).toEqual(rows);
    const fences = await core.$queryRaw<Array<{ definition: string }>>`SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='client_objective_workload_delegations'::regclass AND contype='c'`;
    expect(fences.some(row => /enabled\s*=\s*false/i.test(row.definition))).toBe(true);
  });

  test('native immutable/association guards reject type replacement, legacy claim and reserved job deletion', async () => {
    const { f, intake, job, rows } = await selected();
    await expect(core.withTenant(f.tenantId, tx => tx.$executeRaw`
      UPDATE client_objective_strategy_intakes SET selected_type='regulatory' WHERE tenant_id=${f.tenantId}::uuid AND id=${intake.id}::uuid`))
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '42501' } });
    // This is an adversarial UPDATE, not an adopted worker claim or authority.
    await expect(prisma.withTenant(f.tenantId, tx => tx.$executeRaw`
      UPDATE sp_draft_job SET status='running',attempt=2,claimed_by='untrusted-native-negative',claimed_at=clock_timestamp()
      WHERE tenant_id=${f.tenantId}::uuid AND id=${job.id}::uuid`))
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
    await expect(prisma.withTenant(f.tenantId, tx => tx.$executeRaw`
      DELETE FROM sp_draft_job WHERE tenant_id=${f.tenantId}::uuid AND id=${job.id}::uuid`))
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
    expect(await audit(f)).toEqual(rows);
  });

  test('another tenant cannot read the actual selected intake through the Core native port', async () => {
    const { f, intake, rows } = await selected(), other = await ready();
    const hidden = await core.withTenant(other.tenantId, tx => tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id FROM client_objective_strategy_intakes WHERE id=${intake.id}::uuid AND tenant_id=${f.tenantId}::uuid`);
    expect(hidden).toEqual([]);
    expect(await audit(f)).toEqual(rows);
  });

  test('writer-first automatic Strategy/version gate makes the actual Core approval refuse immediately', async () => {
    const f = await ready(), client = await selectedClient(f), before = await audit(f);
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const writer = prisma.withTenant(f.tenantId, async tx => {
      await manualStrategy(tx, f, f.canonical.canonicalStrategyId);
      await manualVersion(tx, f, f.canonical.canonicalStrategyId, f.id('writer-first-version'));
      entered(); await releasePromise;
    }, { timeoutMs: 10_000 });
    try {
      await Promise.race([enteredPromise, writer.then(() => { throw Error('Writer ended before Core contention'); })]);
      await expect(client.work.selectedStrategyCommand(client.ctx, transport, selectedRequest(f)))
        .rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
      expect(await audit(f)).toEqual(before);
    } finally { release(); await writer; }
  });

  test('Core-first actual approval gate rejects Strategy/version inserts and identity moves across RLS scopes', async () => {
    const f = await ready(), foreign = await ready(), oldId = foreign.id('unreserved-manual-strategy'),
      oldVersion = foreign.id('unreserved-manual-version');
    await prisma.withTenant(foreign.tenantId, async tx => {
      await manualStrategy(tx, foreign, oldId); await manualVersion(tx, foreign, oldId, oldVersion);
    });
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const client = await selectedClient(f, false, 600000, async () => { entered(); await releasePromise; });
    const pending = client.work.selectedStrategyCommand(client.ctx, transport, selectedRequest(f));
    try {
      await Promise.race([enteredPromise, pending.then(() => { throw Error('Core ended before writer contention'); })]);
      expect(client.writeWitness.observed).toHaveLength(1);
      for (const write of [
        (tx: Prisma.TransactionClient) => manualStrategy(tx, foreign, f.canonical.canonicalStrategyId),
        (tx: Prisma.TransactionClient) => manualVersion(tx, foreign, f.canonical.canonicalStrategyId, foreign.id('refused-target-version')),
        (tx: Prisma.TransactionClient) => tx.$executeRaw`UPDATE public.sp_strategy SET id=${f.canonical.canonicalStrategyId}::uuid
          WHERE tenant_id=${foreign.tenantId}::uuid AND id=${oldId}::uuid`,
        (tx: Prisma.TransactionClient) => tx.$executeRaw`UPDATE public.sp_version SET strategy_id=${f.canonical.canonicalStrategyId}::uuid
          WHERE tenant_id=${foreign.tenantId}::uuid AND id=${oldVersion}::uuid`,
      ]) await expect(prisma.withTenant(foreign.tenantId, write))
        .rejects.toMatchObject({ code: 'P2010', meta: { code: '55P03' } });
    } finally { release(); await pending; }
    const rows = await audit(f);
    expect(rows.intakes).toHaveLength(1); expect(rows.jobs).toHaveLength(1);
    const old = await prisma.withTenant(foreign.tenantId, tx => tx.spVersion.findFirst({ where: { id: oldVersion } }));
    expect(old?.strategyId).toBe(oldId);
  });

  test('a preexisting foreign same-ID output remains hidden by RLS and still refuses native selected approval', async () => {
    const f = await ready(), foreign = await ready(), client = await selectedClient(f), before = await audit(f);
    await prisma.withTenant(foreign.tenantId, async tx => {
      await manualStrategy(tx, foreign, f.canonical.canonicalStrategyId);
      await manualVersion(tx, foreign, f.canonical.canonicalStrategyId, foreign.id('foreign-same-id-version'));
    });
    const hidden = await core.withTenant(f.tenantId, tx => tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id FROM public.sp_strategy WHERE id=${f.canonical.canonicalStrategyId}::uuid`);
    expect(hidden).toEqual([]);
    await expect(client.work.selectedStrategyCommand(client.ctx, transport, selectedRequest(f)))
      .rejects.toMatchObject({ code: 'OUTCOME_UNCONFIRMED' });
    expect(await audit(f)).toEqual(before);
  });

  test('unrelated output UUIDs proceed concurrently while Strategy/version writers reenter their same transaction gate', async () => {
    const f = await ready(), firstId = f.id('unreserved-first-strategy'), secondId = f.id('unreserved-second-strategy');
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const first = prisma.withTenant(f.tenantId, async tx => {
      await manualStrategy(tx, f, firstId); await manualVersion(tx, f, firstId, f.id('unreserved-first-version'));
      const reentered = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT public.objective_strategy_output_gate(${firstId}::uuid) AS locked`;
      expect(reentered).toEqual([{ locked: true }]); entered(); await releasePromise;
    }, { timeoutMs: 10_000 });
    try {
      await Promise.race([enteredPromise, first.then(() => { throw Error('First writer ended before concurrency'); })]);
      await prisma.withTenant(f.tenantId, async tx => {
        await manualStrategy(tx, f, secondId); await manualVersion(tx, f, secondId, f.id('unreserved-second-version'));
      });
    } finally { release(); await first; }
    const actual = await prisma.withTenant(f.tenantId, tx => tx.spVersion.findMany({
      where: { strategyId: { in: [firstId, secondId] } }, select: { strategyId: true }, orderBy: { strategyId: 'asc' },
    }));
    expect(actual).toEqual([firstId, secondId].sort().map(strategyId => ({ strategyId })));
  });

  test('restricted role reads actual immutable issuer ledgers without UPDATE privilege', async () => {
    const f = await ready();
    const names = ['client_objective_workload_issue_decisions', 'client_objective_workload_issuances',
      'client_objective_workload_proof_uses', 'client_objective_strategy_intakes'];
    const privileges = await core.$queryRaw<Array<{ name: string; select: boolean; update: boolean; delete: boolean }>>`
      SELECT name,has_table_privilege(current_user,'public.'||name,'SELECT') AS select,
        has_table_privilege(current_user,'public.'||name,'UPDATE') AS update,
        has_table_privilege(current_user,'public.'||name,'DELETE') AS delete
      FROM unnest(${names}::text[]) AS name ORDER BY name`;
    expect(privileges).toEqual([...names].sort().map(name => ({ name, select: true, update: false, delete: false })));
    const port = createPrismaObjectiveIssuancePort(core, { enabled: false, policyRevision: 'a'.repeat(64) });
    await port.withTenantTransaction(f.tenantId, async tx => {
      expect(await tx.findDecision(f.id('absent-operation'))).toBeNull();
      expect(await tx.findIssuance(f.id('absent-operation'))).toBeNull();
      expect(await tx.findProofUse('urn:objective-strategy-native:test', f.id('absent-proof'))).toBeNull();
    });
    await expect(core.withTenant(f.tenantId, tx => tx.$queryRaw`
      SELECT operation_id FROM client_objective_workload_issue_decisions FOR SHARE`))
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '42501' } });
  });

  test('real legacy submission and claim retain their ordinary unreserved path', async () => {
    const f = await ready();
    const job = await drafts().submit(context(f), undefined, { clientId: f.source.clientId,
      type: 'authorization', goal: 'Unreserved native worker control' });
    const claimed = await worker().claimNext();
    expect(claimed?.id).toBe(job.jobId);
    expect(claimed?.attempt).toBe(2);
    expect(Object.hasOwn(claimed!.input, 'objectiveCanonicalReservation')).toBe(false);
    const row = await prisma.withTenant(f.tenantId, tx => tx.spDraftJob.findFirst({ where: { id: job.jobId } }));
    expect(row?.status).toBe('running');
    expect(row?.claimedBy).toBe(claimed!.claimToken);
    await prisma.withTenant(f.tenantId, tx => tx.spDraftJob.update({ where: { id: job.jobId },
      data: { status: 'failed', errorMessage: 'Native unreserved control finished' } }));
  });

  test('complete tenant job locking refuses actual NOWAIT contention', async () => {
    const f = await ready();
    const job = await drafts().submit(context(f), undefined, { clientId: f.source.clientId,
      type: 'authorization', goal: 'Native row contention control' });
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const holder = prisma.withTenant(f.tenantId, async tx => {
      await tx.$queryRaw`SELECT id FROM sp_draft_job WHERE tenant_id=${f.tenantId}::uuid AND id=${job.jobId}::uuid FOR UPDATE`;
      entered(); await releasePromise;
    }, { timeoutMs: 10_000 });
    try {
      await Promise.race([enteredPromise, holder.then(() => { throw Error('Native holder ended before contention'); })]);
      await expect(core.withTenant(f.tenantId, tx => lockObjectiveStrategyIntakeWithinTx(tx, f.tenantId)))
        .rejects.toMatchObject({ code: 'P2010', meta: { code: '55P03' } });
    } finally {
      release(); await holder;
      await prisma.withTenant(f.tenantId, tx => tx.spDraftJob.update({ where: { id: job.jobId },
        data: { status: 'failed', errorMessage: 'Native contention control finished' } }));
    }
  });
});
