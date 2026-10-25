import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { EngagementService } from '../../engagement/engagement.service.js';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { NativeApprovalController } from '../native-approvals/native-approval.controller.js';
import { NativeApprovalService } from '../native-approvals/native-approval.service.js';
import { NativeApprovalMetadataVerifier } from '../native-approvals/native-approval-metadata.js';
import { NativeExecutionService } from '../native-approvals/native-execution.service.js';
import { nativeCanonicalSha256 as hash } from '../native-approvals/native-approval.contract.js';
import { MeriExecutionReceiverService } from './meri-execution-receiver.service.js';

const id = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const config = { get: (key: string) => key === 'INTERNAL_SERVICE_SECRET' ? 'synthetic-secret' : key === 'NODE_ENV' ? 'production' : true };
function fixture(update = false, general = false, personal = false) {
  const state = { now: NOW, member: true, wall: true, session: true, conversation: true, bootstrap: true, revoked: false, complete: true, loseResponse: false };
  const ctx: any = { tenantId: id(1), userId: id(2), clerkUserId: 'user_fixture', tenantSlug: 'fixture', role: 'standard_user' };
  const binding = { tenantId: id(1), actorId: id(2), conversationId: id(3), runId: id(4), attemptId: id(5), workerId: id(6), writerFence: 1 };
  const selectedClientId = general ? null : id(7), taskClientId = personal ? null : id(7);
  const command: any = { contractVersion: update ? '0.2.0' : '0.1.0', commandId: id(8), binding, action: update ? 'task.update' : 'task.create',
    arguments: update ? { taskId: id(10), mode: 'unconditional_patch', patch: { title: 'Updated title', status: 'done' } }
      : { title: 'Follow up', clientId: taskClientId, dueDate: null }, attachments: [],
    scopes: [{ tenantId: id(1), kind: general ? 'private-user' : 'client', resourceId: general ? id(2) : id(7), policyRevision: 'policy1' }], idempotencyKey: 'task-fixture' };
  const proposal = { proposalId: id(9), command, commandSha256: hash(command), createdAt: new Date(NOW - 10000).toISOString(),
    expiresAt: new Date(NOW + 30000).toISOString(), requiredApprover: { tenantId: id(1), actorId: id(2) } };
  const decision: any = { tenantId: id(1), proposalId: proposal.proposalId, commandSha256: proposal.commandSha256, decision: 'approved',
    decidedAt: new Date(NOW - 5000), expiresAt: new Date(proposal.expiresAt), approverUserId: id(2), policyRevision: 'policy1', bindingActorUserId: id(2), conversationId: id(3), runId: id(4) };
  const tasks = new Map<string, any>(), receipts = new Map<string, any>();
  const seed = { id: id(10), tenantId: id(1), clientId: taskClientId, title: 'Original title', status: 'todo', dueDate: null,
    ownerUserId: id(2), createdByUserId: id(2), createdAt: new Date(NOW - 20000), updatedAt: new Date(NOW - 10000), sourceType: null, sourceId: null };
  if (update) tasks.set(seed.id, structuredClone(seed));
  const tx: any = {
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql.join('?');
      if (text.includes('clock_timestamp')) return [{ db_now: new Date(state.now) }];
      if (text.includes('SELECT c.id')) return state.wall ? (values[1] as string[]).map(id => ({ id })) : [];
      return [];
    }),
    tenantMembership: { findFirst: jest.fn(async () => state.member ? { role: 'standard_user', tenant: { status: 'active' } } : null) },
    clioConversation: { findFirst: jest.fn(async () => state.conversation ? { id: id(3), tenantId: id(1), userId: id(2), clientId: selectedClientId, status: 'active', metadata: null, archivedAt: null } : null) },
    clioConversationBootstrapReceipt: { findFirst: jest.fn(async () => state.bootstrap ? { requestId: id(99) } : null) },
    clioMeriApprovalDecision: { findUnique: jest.fn(async () => decision) },
    clioMeriApprovalRevocation: { findUnique: jest.fn(async () => state.revoked ? {} : null) },
    clioMeriExecutionConsumption: {
      findUnique: jest.fn(async () => receipts.get('receipt') ?? null),
      create: jest.fn(async ({ data }: any) => { const row = { ...data, state: 'CLAIMED', result: null, completedAt: null }; receipts.set('receipt', row); return row; }),
      updateMany: jest.fn(async ({ data }: any) => { if (!state.complete) return { count: 0 }; Object.assign(receipts.get('receipt'), data); return { count: 1 }; }),
    },
    engagementTask: {
      create: jest.fn(async ({ data }: any) => { const task = { ...seed, ...data, id: id(10), createdAt: new Date(state.now), updatedAt: new Date(state.now) }; tasks.set(task.id, task); return task; }),
      findFirst: jest.fn(async ({ where }: any) => { const task = tasks.get(where.id); return task?.tenantId === where.tenantId ? task : null; }),
      findUnique: jest.fn(async ({ where }: any) => tasks.get(where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => { const task = { ...tasks.get(where.id), ...data, updatedAt: new Date(state.now) }; tasks.set(task.id, task); return task; }),
    },
  };
  const prisma: any = { withTenant: jest.fn(async (_tenant: string, fn: (tx: any) => Promise<any>) => {
    const beforeTasks = structuredClone(tasks), beforeReceipts = structuredClone(receipts);
    try { return await fn(tx); } catch (error) { tasks.clear(); receipts.clear(); beforeTasks.forEach((v, k) => tasks.set(k, v)); beforeReceipts.forEach((v, k) => receipts.set(k, v)); throw error; }
  }) };
  // Exercise the real domain write methods; a nested transaction is a test failure.
  const engagement = Object.assign(Object.create(EngagementService.prototype), { prisma: { withTenant: () => { throw new Error('Unexpected nested transaction'); } } });
  const approvals: any = { verifyPrepared: jest.fn(async () => {
    if (state.loseResponse && receipts.size) throw new Error('Response lost after commit');
    return { selectedClientId, policyRevision: 'policy1', expiresAtMs: state.now + 60000 };
  }) };
  const tenant: any = { readApplicationAuthoritySession: jest.fn(async () => ({ readCurrent: jest.fn(async () => {
    if (!state.session) throw new Error('Session revoked');
    return { principal: { tenantId: id(1), actorId: id(2) }, identityRevision: 'a'.repeat(64), expiresAtMs: state.now + 60000 };
  }) })) };
  const service = new MeriExecutionReceiverService(prisma, engagement, null, approvals, tenant);
  const req: any = { headers: { 'x-internal-service-secret': 'synthetic-secret' }, method: 'POST', path: '/api/clio/approvals/native/execute' };
  new ToolServiceSecretGuard(config as never).canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as never);
  const body = { proposal, binding };
  return { state, ctx, binding, command, proposal, decision, tasks, receipts, tx, prisma, approvals, tenant, service, req, body,
    execute: () => service.nativeTask(req, ctx, body, 'execute'), read: () => service.nativeTask(req, ctx, body, 'read') };
}

describe('native task execution and historical receipt owner', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());
  it.each([[false, false], [true, false], [false, true], [true, true]])('executes and replays canonical update=%s General=%s', async (update, general) => {
    const f = fixture(update, general), first: any = await f.execute();
    expect(first.status).toBe('observed');
    expect(first.outcome.execution).toMatchObject({ kind: 'native-task', binding: f.binding, commandSha256: f.proposal.commandSha256, completedAt: new Date(NOW).toISOString() });
    expect(first.outcome.result).toEqual(expect.objectContaining({ id: id(10), title: update ? 'Updated title' : 'Follow up', status: update ? 'done' : 'todo' }));
    expect(await f.read()).toEqual({ state: 'OUTCOME', outcome: first.outcome });
    expect(await f.execute()).toEqual(first);
    expect(f.tx.engagementTask[update ? 'update' : 'create']).toHaveBeenCalledTimes(1);
    expect(f.receipts.get('receipt').jti).toBeNull();
  });
  it.each([false, true])('keeps omitted-client tasks personal and actor owned in General=%s', async general => {
    const f = fixture(false, general, true), result: any = await f.execute();
    expect(result.outcome.result.clientId).toBeNull(); expect(f.tasks.get(id(10)).ownerUserId).toBe(id(2));
  });
  it('replays an immutable historical result after expiry/revocation and later task changes', async () => {
    const f = fixture(), first = await f.execute();
    f.state.revoked = true; f.state.now += 60000; f.tasks.get(id(10)).title = 'Later title';
    expect(await f.execute()).toEqual(first);
    expect((await f.read() as any).outcome).toEqual((first as any).outcome);
    expect(f.tx.engagementTask.create).toHaveBeenCalledTimes(1);
  });
  it('recovers a committed effect after a lost response without executing again', async () => {
    const f = fixture(); f.state.loseResponse = true;
    await expect(f.execute()).rejects.toThrow('Response lost');
    expect(f.receipts.get('receipt').state).toBe('COMPLETED');
    f.state.loseResponse = false; expect((await f.read() as any).state).toBe('OUTCOME');
    await f.execute(); expect(f.tx.engagementTask.create).toHaveBeenCalledTimes(1);
  });
  it('executes a live approved task whose immutable initial preparation has expired, started and been superseded', async () => {
    const f = fixture(false, true, true);
    const record = { schemaVersion: 1, state: 'ADMITTED', binding: f.binding, selectedClientId: null,
      policyRevision: 'policy1', versions: { imageDigest: `sha256:${'a'.repeat(64)}`, sdk: '1.2.3', cli: '1.2.3',
        contracts: '0.1.0', skillsDigest: 'b'.repeat(64), checkpointFormat: '0.1.0' },
      configurationSha256: 'c'.repeat(64), createdAtMs: NOW - 20000, expiresAtMs: NOW - 1 };
    const metadata = { record: { operation: { id: 'create_task', version: '0.2.0' }, action: f.command.action,
      binding: f.binding, request: { title: 'Follow up' }, inputSha256: hash({ arguments: f.command.arguments, attachments: [] }),
      commandId: f.command.commandId, idempotencyKey: f.command.idempotencyKey, proposalId: f.proposal.proposalId,
      scopes: f.command.scopes, createdAt: f.proposal.createdAt, expiresAt: f.proposal.expiresAt, requiredApprover: f.proposal.requiredApprover },
      commandContext: { binding: f.binding, clientResolution: null }, commandSha256: f.proposal.commandSha256 };
    const retained = { schemaVersion: 1, commandSha256: f.proposal.commandSha256, metadata,
      preparation: { kind: 'initial-binding', record, recordSha256: hash(record), generation: 1, latestGeneration: 2, started: true } };
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(retained), { status: 200 }));
    const verifier = new NativeApprovalMetadataVerifier({ get: (key: string) => key === 'MERI_CONTROL_ORIGIN' ? 'https://control.example.test' : 'synthetic-secret' } as ConfigService);
    const approvals = new NativeApprovalService(f.prisma, verifier, { read: async () => ({ principal: { tenantId: f.ctx.tenantId, actorId: f.ctx.userId },
      conversationId: f.binding.conversationId, selectedClientId: null, expiresAtMs: NOW + 60000 }) } as any);
    f.approvals.verifyPrepared.mockImplementation((req: any, ctx: any, proposal: any) => approvals.verifyPrepared(req, ctx, proposal));
    expect((await f.execute() as any).status).toBe('observed');
    expect(f.receipts.get('receipt').state).toBe('COMPLETED');
    expect(f.tx.engagementTask.create).toHaveBeenCalledTimes(1);
  });
  it.each(['wall', 'owner'])('withholds a committed General result after %s changes during final metadata I/O', async kind => {
    const f = fixture(false, true, kind === 'owner');
    f.approvals.verifyPrepared.mockImplementationOnce(async () => ({ selectedClientId: null, policyRevision: 'policy1', expiresAtMs: NOW + 60000 }));
    f.approvals.verifyPrepared.mockImplementationOnce(async () => {
      if (kind === 'wall') f.state.wall = false; else f.tasks.get(id(10)).ownerUserId = id(99);
      return { selectedClientId: null, policyRevision: 'policy1', expiresAtMs: NOW + 60000 };
    });
    await expect(f.execute()).rejects.toThrow();
    expect(f.receipts.get('receipt').state).toBe('COMPLETED');
    expect(f.tx.engagementTask.create).toHaveBeenCalledTimes(1);
  });
  it('reads an absent receipt without execution, including after proposal expiry', async () => {
    const f = fixture(); f.state.now += 60000;
    expect(await f.read()).toBeNull(); expect(f.tasks.size).toBe(0);
    await expect(f.execute()).rejects.toThrow(); expect(f.receipts.size).toBe(0);
  });
  it.each(['revoked', 'expired', 'rejected', 'future-decision'])('refuses fresh %s commands without a receipt or task', async kind => {
    const f = fixture(); if (kind === 'revoked') f.state.revoked = true;
    if (kind === 'expired') f.state.now += 60000; if (kind === 'rejected') f.decision.decision = 'rejected';
    if (kind === 'future-decision') f.decision.decidedAt = new Date(NOW + 1);
    await expect(f.execute()).rejects.toThrow(); expect(f.receipts.size).toBe(0); expect(f.tasks.size).toBe(0);
  });
  it.each(['member', 'wall', 'session', 'conversation', 'bootstrap'])('denies current %s loss before execution and historical release', async field => {
    const f = fixture(false, field === 'bootstrap'), first = await f.execute();
    (f.state as any)[field] = false;
    await expect(f.read()).rejects.toThrow(); await expect(f.execute()).rejects.toThrow();
    expect(f.receipts.get('receipt').result).toEqual((first as any).outcome);
    expect(f.tx.engagementTask.create).toHaveBeenCalledTimes(1);
  });
  it.each(['tenant', 'client', 'owner', 'private-source'])('refuses update of a task with wrong %s', async kind => {
    const f = fixture(true, false, kind === 'owner' || kind === 'private-source'), task = f.tasks.get(id(10));
    if (kind === 'tenant') task.tenantId = id(90); if (kind === 'client') task.clientId = id(90);
    if (kind === 'owner') task.ownerUserId = id(90);
    if (kind === 'private-source') { task.sourceType = 'research_portfolio_action'; task.createdByUserId = id(90); }
    await expect(f.execute()).rejects.toThrow(); expect(f.tx.engagementTask.update).not.toHaveBeenCalled(); expect(f.receipts.size).toBe(0);
  });
  it.each([false, true])('rolls back real task methods when receipt completion fails, update=%s', async update => {
    const f = fixture(update); f.state.complete = false;
    await expect(f.execute()).rejects.toThrow('outcome unavailable');
    expect(f.receipts.size).toBe(0); expect(update ? f.tasks.get(id(10)).title : f.tasks.size).toBe(update ? 'Original title' : 0);
  });
  it('never executes an orphaned CLAIMED receipt', async () => {
    const f = fixture(); f.receipts.set('receipt', { jti: null, commandSha256: f.proposal.commandSha256, argumentsSha256: hash(f.command.arguments), state: 'CLAIMED' });
    await expect(f.execute()).rejects.toThrow('outcome unknown'); await expect(f.read()).rejects.toThrow('outcome unknown');
    expect(f.tasks.size).toBe(0);
  });
  it.each(['binding', 'decision-hash', 'completedAt', 'command', 'legacy-jti'])('refuses corrupted historical %s', async kind => {
    const f = fixture(); await f.execute(); const row = f.receipts.get('receipt');
    if (kind === 'binding') row.result.execution.binding.workerId = id(99);
    if (kind === 'decision-hash') row.result.execution.approvalDecisionSha256 = '0'.repeat(64);
    if (kind === 'completedAt') row.result.execution.completedAt = new Date(NOW - 20000).toISOString();
    if (kind === 'command') row.commandSha256 = '0'.repeat(64);
    if (kind === 'legacy-jti') row.jti = id(90);
    await expect(f.read()).rejects.toThrow(); expect(f.tx.engagementTask.create).toHaveBeenCalledTimes(1);
  });
  it('requires actual service identity and exact immutable executor binding', async () => {
    const f = fixture();
    await expect(f.service.nativeTask({ headers: f.req.headers } as never, f.ctx, f.body, 'execute')).rejects.toThrow();
    await expect(f.service.nativeTask(f.req, f.ctx, { ...f.body, binding: { ...f.binding, writerFence: 2 } }, 'execute')).rejects.toThrow();
    expect(f.prisma.withTenant).not.toHaveBeenCalled();
  });
  it('mounts the exact execute/read routes with real service and role guards', async () => {
    const f = fixture(), module = await Test.createTestingModule({ controllers: [NativeApprovalController], providers: [
      RolesGuard, ToolServiceSecretGuard, { provide: ConfigService, useValue: config },
      { provide: NativeApprovalService, useValue: {} }, { provide: NativeExecutionService, useValue: {} },
      { provide: MeriExecutionReceiverService, useValue: f.service },
    ] }).compile();
    const app = module.createNestApplication(); app.setGlobalPrefix('api'); app.use((req: any, _res: unknown, next: () => void) => { req.tenantContext = f.ctx; next(); }); await app.init();
    try {
      await request(app.getHttpServer()).post('/api/clio/approvals/native/execute').send(f.body).expect(403);
      const sent = await request(app.getHttpServer()).post('/api/clio/approvals/native/execute').set('x-internal-service-secret', 'synthetic-secret').send(f.body).expect(200);
      const found = await request(app.getHttpServer()).post('/api/clio/approvals/native/execution/read').set('x-internal-service-secret', 'synthetic-secret').send(f.body).expect(200);
      expect(found.body).toEqual({ state: 'OUTCOME', outcome: sent.body.outcome });
    } finally { await app.close(); }
  });
});
