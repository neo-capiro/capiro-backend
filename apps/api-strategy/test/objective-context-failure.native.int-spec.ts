import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService as CorePrismaService } from '../../api/src/prisma/prisma.service.js';
import type { ApplicationAuthorityIdentityProof } from '../../api/src/auth/application-authority.js';
import type { TenantContextMiddleware } from '../../api/src/tenant/tenant-context.middleware.js';
import { ObjectiveWorkService } from '../../api/src/clients/objectives/work/objective-work.service.js';
import { ObjectiveStrategyWorkOwner } from '../../api/src/clients/objectives/work/objective-strategy-work-owner.js';
import { parseObjectiveStrategySelection } from '../../api/src/clients/objectives/work/objective-strategy-selection.js';
import { workDigest } from '../../api/src/clients/objectives/work/objective-work-command.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma-client/index.js';
import { InternalServiceGuard } from '../src/auth/internal-service.guard.js';
import { ObjectiveCanonicalWorkloadAuthority, type CanonicalGenerationGrant,
  type CanonicalGenerationSubject } from '../src/planner/objective-canonical-authority.js';
import { applicationHash } from '../src/planner/objective-canonical-application.js';
import { ObjectiveCanonicalProducerService } from '../src/meri/objective-canonical-producer.service.js';
import { ObjectiveCanonicalRequestService } from '../src/meri/objective-canonical-request.service.js';
import { ObjectiveCanonicalOwnerDirectory } from '../src/meri/objective-canonical-owner-directory.js';
import { ObjectiveNativeReader } from '../src/meri/objective-native-reader.js';
import { StrategyContextPlaneClient } from '../src/meri/strategy-context-plane.client.js';
import { GENERATION_ADMISSION, GENERATION_REQUEST, canonicalGenerationAdmissionSha256 } from '../src/meri/objective-canonical-generation.js';
import { readGenerationLedger } from '../src/meri/objective-canonical-producer-ledger.js';
import { digest, type ObjectiveAdmission } from '../src/meri/objective-generation.types.js';
import { buildObjectivePlannerNativeFixture, seedObjectivePlannerNativeReadyWithinTx } from './objective-planner-native-fixture.js';

/** Bounded qualification of the existing owners, on a separately provisioned
 * task-owned Docker PG16 only. This does not repoint the historical port56455
 * runner. Ready identity/source rows and the request-local identity proof are
 * synthetic. Core reserves the real consent/job; Strategy captures the real
 * admission. Only Context Plane HTTP responses are synthetic. No accepted run,
 * publication, failure receipt or result is seeded, and no model is called. */
const native = process.env.OBJECTIVE_CONTEXT_FAILURE_NATIVE === '1' ? describe : describe.skip;
const task = 'objective-strategies-20261106';
const container = 'codex-objective-retry-pg-20261106';
const secret = 'synthetic-objective-context-native-test-secret';
type Json = Record<string, any>;

native('canonical Objective context failure on the owned PG16 target', () => {
  let prisma: PrismaService, core: CorePrismaService, server: Server;
  let authority: ObjectiveCanonicalWorkloadAuthority, contextPlane: StrategyContextPlaneClient;
  let config: ConfigService, transport: Request;
  let target: { sourceHead: string; containerId: string; databaseOid: number; databaseComment: string;
    postmasterStartedAtSeconds: string; expiresAtMs: number };
  const handlers = new Map<string, (path: string) => Promise<{ status: number; body: unknown }>>();
  const serverErrors: unknown[] = [];
  const originalFetch = global.fetch;

  async function catalog(db: PrismaService | CorePrismaService) {
    const rows = await db.$queryRaw<Array<{ name: string; oid: number; comment: string; started: string;
      port: number; role: string; superuser: boolean; bypass: boolean; inherits: boolean; createDb: boolean; createRole: boolean }>>`
      SELECT current_database()::text AS name,d.oid::integer AS oid,shobj_description(d.oid,'pg_database') AS comment,
        floor(extract(epoch FROM pg_postmaster_start_time()))::text AS started,inet_server_port() AS port,
        current_user::text AS role,r.rolsuper AS superuser,r.rolbypassrls AS bypass,r.rolinherit AS inherits,
        r.rolcreatedb AS "createDb",r.rolcreaterole AS "createRole"
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`;
    expect(rows).toEqual([{ name: 'objective_qa', oid: target.databaseOid, comment: target.databaseComment,
      started: target.postmasterStartedAtSeconds, port: 5432, role: 'capiro_app', superuser: false,
      bypass: false, inherits: false, createDb: false, createRole: false }]);
    const owners = await db.$queryRaw<Array<{ owns: boolean; member: boolean; rls: boolean }>>`
      SELECT c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns,
        pg_has_role(current_user,c.relowner,'MEMBER') AS member,c.relrowsecurity AS rls
      FROM pg_class c WHERE c.oid IN ('public.sp_draft_job'::regclass,'public.client_objective_work_consents'::regclass)`;
    expect(owners).toEqual([{ owns: false, member: false, rls: true }, { owns: false, member: false, rls: true }]);
  }

  beforeAll(async () => {
    const root = resolve(__dirname, '../../..');
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'apps', 'packages', 'scripts'],
      { cwd: root, encoding: 'utf8' }).trim()).toBe('');
    target = JSON.parse(await readFile(process.env.OBJECTIVE_CONTEXT_FAILURE_TARGET_FILE!, 'utf8'));
    expect(target.sourceHead).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
    expect(target.expiresAtMs).toBeGreaterThan(Date.now());
    expect(target.expiresAtMs).toBeLessThan(Date.now() + 24 * 60 * 60 * 1000);
    expect(target.databaseComment).toMatch(/^task-owned:objective-strategies-20261106:[a-f0-9]{48}$/);
    const owned = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
    expect(owned.Id).toBe(target.containerId);
    expect(owned.Config.Labels['codex.task']).toBe(task);
    expect(owned.State.Running).toBe(true);
    expect(owned.NetworkSettings.Ports['5432/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: '55492' }]);
    const databaseUrl = (await readFile(process.env.OBJECTIVE_CONTEXT_FAILURE_DATABASE_URL_FILE!, 'utf8')).trim();
    const url = new URL(databaseUrl);
    expect([url.protocol, url.hostname, url.port, url.pathname, url.username]).toEqual(
      ['postgresql:', '127.0.0.1', '55492', '/objective_qa', 'capiro_app']);
    expect([...url.searchParams.keys()].every(key => ['schema', 'connection_limit', 'pool_timeout'].includes(key))).toBe(true);
    prisma = new PrismaService({ datasources: { db: { url: databaseUrl } } });
    core = new CorePrismaService({ datasources: { db: { url: databaseUrl } } });
    await prisma.$connect(); await core.$connect(); await catalog(prisma); await catalog(core);
    server = createServer(async (req, res) => {
      try {
        expect(req.headers['x-internal-service-secret']).toBe(secret);
        let bytes = ''; for await (const chunk of req) { bytes += chunk; if (bytes.length > 65536) throw Error('fixture request limit'); }
        const body = JSON.parse(bytes), handler = handlers.get(body.generationRequestId);
        if (!handler) throw Error('unknown synthetic context request');
        const reply = await handler(req.url!);
        res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply.body));
      } catch (error) { serverErrors.push(error); res.writeHead(500); res.end('{}'); }
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture listener unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    // Node's fetch JSON decoder runs outside Jest's VM. Decode the actual HTTP
    // bytes in this VM so strict plain-object codecs see the production realm.
    // Status, headers, transport and cancellation remain the native fetch path.
    global.fetch = async (input, init) => {
      expect(new URL(String(input)).origin).toBe(origin);
      const result = await originalFetch(input, init);
      Object.defineProperty(result, 'json', { value: async () => JSON.parse(await result.text()) });
      return result;
    };
    config = new ConfigService({ INTERNAL_SERVICE_SECRET: secret, API_INTERNAL_URL: origin });
    transport = { headers: { 'x-internal-service-secret': secret } } as unknown as Request;
    const execution = { switchToHttp: () => ({ getRequest: () => transport }) } as unknown as ExecutionContext;
    expect(new InternalServiceGuard(config).canActivate(execution)).toBe(true);
    authority = new ObjectiveCanonicalWorkloadAuthority(prisma, new ObjectiveNativeReader(config));
    contextPlane = new StrategyContextPlaneClient(config);
  }, 30_000);
  afterAll(async () => {
    global.fetch = originalFetch;
    await core?.$disconnect(); await prisma?.$disconnect();
    if (server) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    expect(serverErrors).toEqual([]);
  });

  async function selected() {
    await catalog(prisma);
    const clocks = await prisma.$queryRaw<Array<{ ms: string }>>`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms`;
    const f = buildObjectivePlannerNativeFixture(Number(clocks[0]!.ms));
    await prisma.withTenant(f.tenantId, async tx => {
      await seedObjectivePlannerNativeReadyWithinTx(tx, f);
      await tx.$executeRaw`UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{objectiveStrategyIntake}',
        '{"enabled":true}'::jsonb) WHERE id=${f.tenantId}::uuid`;
    });
    const ctx: TenantContext = { tenantId: f.tenantId, clerkUserId: f.clerkUserId, userId: f.actorUserId,
      role: 'standard_user', tenantSlug: `objective-planner-qa-${f.tenantId}` };
    const evidence = { principal: { tenantId: f.tenantId, actorId: f.actorUserId }, expiresAtMs: f.nowMs + 120_000,
      identityRevision: workDigest({ fixture: 'SYNTHETIC_CONTEXT_FAILURE_REQUEST', actor: f.actorUserId, member: f.membershipId }) };
    const proof: ApplicationAuthorityIdentityProof = { ...evidence, recheckCurrent: async () => {
      const rows = await core.withTenant(f.tenantId, tx => tx.$queryRaw<Array<{ id: string }>>`
        SELECT m.id::text AS id FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id
        WHERE m.tenant_id=${f.tenantId}::uuid AND m.id=${f.membershipId}::uuid AND m.user_id=${f.actorUserId}::uuid
          AND m.status::text='active' AND m.role::text='standard_user' AND u.clerk_user_id=${f.clerkUserId} AND t.status::text='active'`);
      expect(rows).toEqual([{ id: f.membershipId }]); return evidence;
    } };
    const tenant = { readApplicationAuthority: async (req: Request, current: TenantContext) => {
      expect(req).toBe(transport); expect(current).toEqual(ctx); return proof;
    } } as unknown as TenantContextMiddleware;
    const work = new ObjectiveWorkService(core, tenant, new ObjectiveStrategyWorkOwner({
      OBJECTIVE_STRATEGY_INTAKE_ENABLED: 'true', OBJECTIVE_STRATEGY_CONSENT_DURATION_MS: '600000',
    }, core));
    const request = parseObjectiveStrategySelection(f.source.clientId, f.source.objectiveId, { schemaVersion: 2,
      command: { schemaVersion: 1, requestId: f.id('selected-command'), command: 'retry', workAction: 'objective.strategy.draft',
        expectedObjectiveVersion: 2, expectedControlVersion: 0, expectedCanonicalBindingVersion: 1, targetAuthorizationRequestId: null },
      selection: { type: 'coalition', generationRequestId: f.id('selected-generation-request') } });
    await work.selectedStrategyCommand(ctx, transport, request);
    const jobs = await prisma.withTenant(f.tenantId, tx => tx.spDraftJob.findMany({ where: { tenantId: f.tenantId } }));
    expect(jobs).toHaveLength(1);
    const body = { schemaVersion: 1 as const, generationJobId: jobs[0]!.id };
    const captured = await new ObjectiveCanonicalProducerService(prisma, authority).capture(transport, body);
    return { f, body, requestId: request.selection.generationRequestId, admission: captured.sourceAdmission };
  }
  type Selected = Awaited<ReturnType<typeof selected>>;
  const publisher = (a = authority) => new ObjectiveCanonicalRequestService(prisma, a, contextPlane, new ObjectiveCanonicalOwnerDirectory());
  const refusal = { status: 400, body: { code: 'OBJECTIVE_CONTEXT_INCOMPLETE',
    issues: [{ group: 'target_recommendations', code: 'REQUIRED_FIELDS_EXCEED_PACKET_BUDGET', message: 'private compiler detail' }] } };
  async function response(promise: Promise<unknown>) {
    try { return { status: 200, body: await promise }; }
    catch (error) { if (!(error instanceof HttpException)) throw error;
      return { status: error.getStatus(), body: error.getResponse() as Json }; }
  }
  async function audit(s: Selected) {
    return prisma.withTenant(s.f.tenantId, async tx => ({
      job: await tx.spDraftJob.findFirstOrThrow({ where: { id: s.body.generationJobId, tenantId: s.f.tenantId } }),
      ledger: await tx.spPlannerResource.findMany({ where: { tenantId: s.f.tenantId }, select: { kind: true, data: true } }),
      strategies: await tx.spStrategy.count({ where: { tenantId: s.f.tenantId } }),
      versions: await tx.spVersion.count({ where: { tenantId: s.f.tenantId } }),
      membership: await tx.$queryRaw<Array<{ status: string }>>`SELECT status::text FROM tenant_memberships
        WHERE tenant_id=${s.f.tenantId}::uuid AND id=${s.f.membershipId}::uuid`,
    }));
  }
  async function noOutputs(s: Selected, kinds = [GENERATION_ADMISSION]) {
    const state = await audit(s);
    expect(state.ledger.map(row => row.kind).sort()).toEqual([...kinds].sort());
    expect([state.strategies, state.versions]).toEqual([0, 0]);
    return state;
  }

  test('real failure write commits before409; lost response and repeat POST recover the identical saved receipt', async () => {
    const s = await selected(); let calls = 0;
    handlers.set(s.requestId, async () => { calls++; return refusal; });
    const post = await response(publisher().publish(transport, s.body));
    expect(post.status).toBe(409);
    expect(post.body).toMatchObject({ outcome: 'failed', generationJobId: s.body.generationJobId,
      sourceAdmissionSha256: canonicalGenerationAdmissionSha256(s.admission), objectiveReceipt: {
        requestId: s.requestId, source: s.f.source, result: null, failure: { code: 'OBJECTIVE_CONTEXT_INCOMPLETE' },
        context: { state: 'incomplete', issues: [{ group: 'target_recommendations', code: 'REQUIRED_FIELDS_EXCEED_PACKET_BUDGET' }] } } });
    expect((post.body as Json).objectiveReceiptSha256).toBe(applicationHash((post.body as Json).objectiveReceipt));
    expect(JSON.stringify(post.body)).not.toContain('private compiler detail');
    const state = await noOutputs(s);
    expect(state.job).toMatchObject({ status: 'failed', stage: 'failed', attempt: 1, claimedAt: null, claimedBy: null, strategyId: null });
    expect(await response(publisher().lookup(transport, s.body.generationJobId))).toEqual(post);
    expect(await response(publisher().publish(transport, s.body))).toEqual(post);
    expect(calls).toBe(1);
  }, 30_000);

  test('real final current denial after the failed row write rolls back the entire transaction', async () => {
    const s = await selected(), before = await audit(s); let revoked = 0;
    handlers.set(s.requestId, async () => refusal);
    class RevokeAfterWrite extends ObjectiveCanonicalWorkloadAuthority {
      override async assertGenerationCurrent(tx: Prisma.TransactionClient, grant: CanonicalGenerationGrant, subject: CanonicalGenerationSubject) {
        await super.assertGenerationCurrent(tx, grant, subject);
        const row = await tx.spDraftJob.findFirst({ where: { id: s.body.generationJobId, tenantId: s.f.tenantId } });
        if (row?.status === 'failed') {
          revoked += await tx.$executeRaw`UPDATE tenant_memberships SET status='removed'
            WHERE tenant_id=${s.f.tenantId}::uuid AND id=${s.f.membershipId}::uuid AND status::text='active'`;
          await super.assertGenerationCurrent(tx, grant, subject);
        }
      }
    }
    const result = await response(publisher(new RevokeAfterWrite(prisma, new ObjectiveNativeReader(config))).publish(transport, s.body));
    expect(result.status).toBe(503); expect(result.body).toMatchObject({ outcome: 'unconfirmed' }); expect(revoked).toBe(1);
    const after = await noOutputs(s);
    expect(after.job).toEqual(before.job); expect(after.membership).toEqual([{ status: 'active' }]);
  }, 30_000);

  function successPacket(s: Selected) {
    const prompt = 'Synthetic current Objective context for native publication contention.\n';
    const compiled: ObjectiveAdmission = JSON.parse(JSON.stringify(s.f.compiled));
    compiled.requestId = s.requestId; compiled.type = 'coalition';
    const coverage = { complete: true, truncated: false };
    compiled.context.coverageDigest = digest({ manifest: compiled.coverage, history: coverage, policy: 'objective-v1-required-lossless' });
    compiled.context.inputDigest = digest({ sourceDigest: compiled.context.sourceDigest, coverageDigest: compiled.context.coverageDigest,
      packetId: compiled.context.packetId, requestId: s.requestId, type: compiled.type, localDigest: compiled.localDigest,
      externalDigest: compiled.externalDigest, historyDigest: compiled.historyDigest, promptDigest: digest(prompt) });
    const typed = { schemaVersion: 1, tenantId: s.f.tenantId, clerkUserId: s.f.clerkUserId, requestId: s.requestId,
      source: compiled.source, intent: compiled.intent, snapshotSha256: s.f.canonical.snapshotHash,
      sourceDigest: compiled.context.sourceDigest, packetId: compiled.context.packetId, compiledAt: compiled.context.compiledAt,
      coverageDigest: compiled.context.coverageDigest, promptSha256: createHash('sha256').update(prompt).digest('hex'), evidence: [] };
    return { compile: { status: 200, body: { kind: 'governed_packet', objectiveAdmission: compiled, objectiveTypedContext: typed,
      governedContext: { version: 1, operationId: 'strategies.generate', prompt, contextPacket: { clientId: s.f.source.clientId,
        surface: 'strategy', persisted: true, packetId: compiled.context.packetId, compiledAt: compiled.context.compiledAt }, retrieval: { coverage } } } },
      check: { status: 200, body: { complete: true, tenantId: s.f.tenantId, clerkUserId: s.f.clerkUserId,
        requestId: s.requestId, source: compiled.source, sourceDigest: compiled.context.sourceDigest, localDigest: compiled.localDigest,
        externalDigest: compiled.externalDigest, historyDigest: compiled.historyDigest, checkedAt: new Date().toISOString() } } };
  }

  test.each(['publication', 'failure'] as const)('concurrent publication and failure preserve the first committed %s', async winner => {
    const s = await selected(), packets = successPacket(s);
    let release!: () => void, entered!: () => void, compileCalls = 0;
    const blocked = new Promise<void>(done => { release = done; }), waiting = new Promise<void>(done => { entered = done; });
    handlers.set(s.requestId, async path => {
      if (path.endsWith('/objective-check')) return packets.check;
      compileCalls++;
      if (compileCalls === 1) { entered(); await blocked; return winner === 'publication' ? refusal : packets.compile; }
      return winner === 'publication' ? packets.compile : refusal;
    });
    const losing = response(publisher().publish(transport, s.body));
    let winning: Awaited<ReturnType<typeof response>>;
    try { await waiting; winning = await response(publisher().publish(transport, s.body)); }
    finally { release(); }
    const late = await losing;
    expect(winning!.status).toBe(winner === 'publication' ? 200 : 409);
    expect(late).toEqual(winning!); expect(compileCalls).toBe(2);
    const state = await noOutputs(s, winner === 'publication' ? [GENERATION_ADMISSION, GENERATION_REQUEST] : [GENERATION_ADMISSION]);
    expect(state.job.status).toBe(winner === 'publication' ? 'queued' : 'failed');
    expect(await response(publisher().lookup(transport, s.body.generationJobId))).toEqual(winning!);
  }, 30_000);

  test('foreign tenant RLS/current reads and unauthenticated HTTP identity cannot release the failure', async () => {
    const s = await selected(), foreign = await selected();
    handlers.set(s.requestId, async () => refusal);
    expect((await response(publisher().publish(transport, s.body))).status).toBe(409);
    const subject: CanonicalGenerationSubject = { phase: 'request-read', generationJobId: s.body.generationJobId,
      requestSha256: applicationHash(s.body) };
    const grant = await authority.verifyGeneration(transport, subject);
    await prisma.withTenant(foreign.f.tenantId, async tx => {
      expect(await tx.spDraftJob.findFirst({ where: { id: s.body.generationJobId } })).toBeNull();
      expect(await readGenerationLedger(tx, GENERATION_ADMISSION, s.f.tenantId, s.f.clerkUserId, s.body.generationJobId)).toBeNull();
      await expect(authority.assertGenerationCurrent(tx, grant, subject)).rejects.toThrow();
    });
    const refused = await response(publisher().lookup({ headers: {} } as Request, s.body.generationJobId));
    expect(refused.status).toBe(503); expect(refused.body).toMatchObject({ outcome: 'unconfirmed' });
    expect(JSON.stringify(refused.body)).not.toContain('objectiveReceipt');
  }, 30_000);
});
