import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { InternalServiceGuard } from '../../auth/internal-service.guard.js';
import { nativeCanonicalSha256 as hash } from '../native-approvals/native-approval.contract.js';
import { RetainedReadDispatcher } from '../retained-read-dispatch.js';
import { MeriRoutinesService } from './meri-routines.service.js';
import { MeriRoutineReadController } from './meri-routines.controller.js';

const id = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const original = (key: string, label: string) => {
  const h = createHash('sha256').update(`meri.schedule.occurrence.v1\0${key}\0${label}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function fixture(personal = false) {
  const state = { now: 200000, member: true, wall: true, revoked: false, exists: true, clientIds: [id(4), id(10)] };
  const scopes = [{ tenantId: id(1), kind: personal ? 'private-user' : 'client', resourceId: personal ? id(2) : id(4), policyRevision: 'a'.repeat(64) }];
  const limits = { maxCostMicrousd: 2000000, maxRuntimeSeconds: 900, retryLimit: 0 };
  const projection = { scheduleId: id(3), owner: { tenantId: id(1), actorId: id(2) }, scopes, state: 'active',
    temporalScheduleId: 'synthetic-schedule', ...limits };
  const occurrence = { workflowId: 'synthetic-workflow', temporalScheduleId: projection.temporalScheduleId,
    scheduledAt: new Date(90000).toISOString(), projection, generation: 1, task: { taskId: id(5), version: 1, manifestSha256: 'b'.repeat(64) } };
  const key = hash({ tenantId: id(1), actorId: id(2), scheduleId: id(3), temporalScheduleId: occurrence.temporalScheduleId,
    generation: 1, workflowId: occurrence.workflowId, scheduledAt: occurrence.scheduledAt });
  const binding = { tenantId: id(1), actorId: id(2), conversationId: original(key, 'conversation'), runId: original(key, 'run'),
    attemptId: original(key, 'attempt'), workerId: original(key, 'worker'), writerFence: 1 };
  const effect = { binding, requestId: original(key, 'request'), eventId: original(key, 'event'),
    workflowId: `meri:${binding.tenantId}:${binding.conversationId}:${binding.runId}` };
  const run = { binding, state: 'running', scopes, createdAt: new Date(100000).toISOString(), policyRevision: scopes[0]!.policyRevision, versions: {} };
  const execution = { binding, executionKey: hash(binding), executionId: hash(binding), planSha256: 'c'.repeat(64),
    expiresAtMs: 900000, runtimeSessionId: 'synthetic-native-session-00000000000000', phase: 'started', native: null };
  const row: any = { tenant_id: id(1), schedule_id: id(3), occurrence_key: key, owner_actor_id: id(2), generation: '1',
    projection, projection_sha256: hash(projection), active_intent: null, occurrence, effect, effect_sha256: hash(effect), occurrence_state: 'OPEN',
    run_projection: run, run_projection_sha256: hash(run), execution_record: execution, execution_record_sha256: hash(execution),
    execution_key: execution.executionKey, execution_id: execution.executionId, current_writer: true, no_successor: true };
  const consent: any = { consentId: id(6), tenantId: id(1), ownerUserId: id(2), scheduleId: id(3), generation: 1,
    intentSha256: 'd'.repeat(64), projectionSha256: hash(projection), scopes, policyRevision: run.policyRevision, limits,
    issuedAt: new Date(50000), expiresAt: new Date(2000000) };
  const membership: any = { id: id(7), role: 'standard_user', tenant: { slug: 'synthetic', status: 'active' } };
  const calls: string[] = [];
  const tx: any = {
    $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join('?'); calls.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('clock_timestamp')) return [{ db_now: new Date(state.now) }];
      if (sql.includes('routine_runs_v1')) return state.exists ? [row] : [];
      if (sql.includes('FROM clients')) return state.wall ? state.clientIds.map(id => ({ id, revision: 'current' })) : [];
      throw Error('Unexpected SQL');
    }),
    clioMeriRoutineConsent: { findFirst: jest.fn(async () => consent.expiresAt.getTime() > state.now ? consent : null) },
    clioMeriRoutineConsentRevocation: { findFirst: jest.fn(async () => state.revoked ? {} : null) },
    tenantMembership: { findFirst: jest.fn(async () => state.member ? membership : null) },
    user: { findUnique: jest.fn(async () => ({ id: id(2), clerkUserId: 'user_synthetic' })) },
  };
  const prisma: any = { withTenant: jest.fn(async (_tenant, fn) => fn(tx)) };
  const ctx = { binding, subject: { kind: personal ? 'personal' : 'client', entityType: personal ? 'user' : 'client',
    entityIds: [personal ? id(2) : id(4)], tenantId: id(1), actorId: id(2), policyRevision: run.policyRevision, scopes, rosterVersionId: null },
    policyRevision: run.policyRevision, normalizationContext: null };
  const selection = { schemaVersion: 1, tenantId: id(1), scheduleId: id(3), occurrenceKey: key, binding };
  const body = { ...selection, operation: 'search_public_web', input: { query: 'synthetic', cursor: 'page-two' }, context: ctx };
  const req: any = Object.assign(new EventEmitter(), { headers: { 'x-internal-service-secret': 'synthetic-test-secret', 'x-meri-deadline-at': '800000' } });
  new InternalServiceGuard({ get: () => 'synthetic-test-secret' } as never)
    .canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as never);
  const execute = jest.fn(async (_ctx: unknown, _operation: string, input: unknown) => ({ page: input, nextCursor: 'page-three' }));
  const tools: any = { anthropicToolSchemas: () => [{ name: 'search_public_web', input_schema: { properties: {} } },
    { name: 'create_task', input_schema: { properties: {} } }], isSideEffecting: (op: string) => op === 'create_task', executeFromAuthenticatedUser: execute };
  const dispatcher = new RetainedReadDispatcher(prisma, tools, {} as never, { handles: () => false } as never);
  const service = new MeriRoutinesService(prisma, {} as never, null, null);
  const rehash = () => { row.projection_sha256 = hash(row.projection); row.effect_sha256 = hash(row.effect);
    row.run_projection_sha256 = hash(row.run_projection); row.execution_record_sha256 = hash(row.execution_record); };
  return { state, row, consent, membership, calls, tx, prisma, ctx, selection, body, req, execute, tools, service, dispatcher, rehash };
}

describe('native routine saved-consent reads', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(200000));
  afterEach(() => jest.restoreAllMocks());
  it.each([false, true])('derives current principal and preserves typed paging in client/General mode %s', async personal => {
    const f = fixture(personal);
    expect(await f.service.current(f.selection, f.req)).toMatchObject({ actorId: id(2), consentId: id(6), effectExpiresAtMs: 900000 });
    expect(await f.service.read(f.body, f.req, f.dispatcher)).toEqual({ page: f.body.input, nextCursor: 'page-three' });
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ tenantId: id(1), userId: id(2), role: 'standard_user' }), 'search_public_web', f.body.input);
    expect(f.calls.some(q => /allocation|reservation|current_admission_v1/.test(q))).toBe(false);
    expect(f.row.effect.workflowId).not.toBe(f.row.occurrence.workflowId);
  });
  it('returns General current wall-filtered clients and refuses a changed roster on release', async () => {
    const f = fixture(true);
    expect((await f.service.current(f.selection, f.req)).clientIds).toEqual([id(4), id(10)]);
    f.state.clientIds = [id(10)];
    expect((await f.service.current(f.selection, f.req)).clientIds).toEqual([id(10)]);
    f.execute.mockImplementation(async () => { f.state.clientIds = []; return {} as never; });
    await expect(f.service.read(f.body, f.req, f.dispatcher)).rejects.toThrow();
    f.state.clientIds = Array.from({ length: 4097 }, () => id(4));
    await expect(f.service.current(f.selection, f.req)).rejects.toThrow();
  });
  it('bounds General client-reference results by the current Core roster', async () => {
    const f = fixture(true), reads = { execute: jest.fn(async () => ({ ok: true, clientId: id(4) })) };
    const body = { ...f.body, operation: 'job.resolveClientReference', input: { ref: 'Visible client' } };
    expect(await f.service.read(body, f.req, reads as never)).toEqual({ ok: true, clientId: id(4) });
    reads.execute.mockResolvedValue({ ok: true, clientId: id(99) });
    await expect(f.service.read(body, f.req, reads as never)).rejects.toThrow();
  });
  it('requires real service identity and closed selectors before any DB access', async () => {
    const f = fixture();
    await expect(f.service.current(f.selection, { headers: f.req.headers } as never)).rejects.toThrow();
    await expect(f.service.current({ ...f.selection, actorId: id(99) }, f.req)).rejects.toThrow();
    await expect(f.service.read({ ...f.body, phase: 'before_stop' }, f.req, f.dispatcher)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  it('mounts current and reads with real service guard and dispatcher injection', async () => {
    const f = fixture(), module = await Test.createTestingModule({ controllers: [MeriRoutineReadController], providers: [
      InternalServiceGuard, { provide: ConfigService, useValue: { get: () => 'synthetic-test-secret' } },
      { provide: MeriRoutinesService, useValue: f.service }, { provide: RetainedReadDispatcher, useValue: f.dispatcher },
    ] }).compile();
    const app = module.createNestApplication(); app.setGlobalPrefix('api'); await app.init();
    try {
      await request(app.getHttpServer()).post('/api/internal/routines/current').send(f.selection).expect(403);
      expect(f.calls).toHaveLength(0);
      const current = await request(app.getHttpServer()).post('/api/internal/routines/current')
        .set('x-internal-service-secret', 'synthetic-test-secret').send(f.selection).expect(200);
      expect(current.body.consentId).toBe(id(6));
      const read = await request(app.getHttpServer()).post('/api/internal/routines/reads')
        .set('x-internal-service-secret', 'synthetic-test-secret').set('x-meri-deadline-at', '800000').send(f.body).expect(200);
      expect(read.body.nextCursor).toBe('page-three');
    } finally { await app.close(); }
  });
  it.each([false, true])('routes typed Mail through its existing receiver in client/General mode %s', async personal => {
    const f = fixture(personal), at = new Date(199000).toISOString(), readAt = new Date(200000).toISOString();
    // Actual Control producer appends current mailbox inventory to correlation,
    // while the saved run/consent remains client or personal scoped.
    f.ctx.subject.scopes = [...f.ctx.subject.scopes,
      { tenantId: id(1), kind: 'mailbox', resourceId: id(8), policyRevision: f.ctx.policyRevision }];
    const clientId = personal ? null : id(4);
    const result = { asOf: at, offset: 0, folder: 'all', queryScope: { asOf: at, folder: 'all', withinDays: null,
      query: null, from: null, participant: null, clientId }, timeWindow: { start: null, end: at },
      searchedMailboxes: [{ sourceProof: { version: 1, mailboxId: id(8), ownerTenantId: id(1), ownerActorId: id(2) }, status: 'active' }],
      totalMatches: 0, returned: 0, hasMore: false, nextOffset: null, messages: [] };
    f.tools.readRetainedMailSourceV02 = jest.fn(async () => ({ result, readAt }));
    const body = { ...f.body, operation: 'mail.list_messages', input: { input: {
      subject: personal ? { kind: 'personal' } : { kind: 'client', entityId: clientId },
      folder: 'all', withinDays: null, limit: 1, offset: 0, asOf: null }, metadata: null } };
    const page: any = await f.service.read(body, f.req, f.dispatcher);
    expect(page.operation).toEqual({ id: 'mail.list_messages', version: '0.2.0' });
    expect(page.messages).toEqual([]); expect(page.binding).toEqual(f.selection.binding);
    expect(f.execute).not.toHaveBeenCalled();
    await expect(f.service.read({ ...f.body, context: f.ctx }, f.req, f.dispatcher)).rejects.toThrow();
    f.tools.readRetainedMailSourceV02.mockImplementation(async () => { f.state.revoked = true; return { result, readAt }; });
    await expect(f.service.read(body, f.req, f.dispatcher)).rejects.toThrow();
  });
  it.each(['actorId', 'tenantId', 'conversationId', 'runId', 'attemptId', 'workerId', 'writerFence'] as const)('rejects changed %s', async field => {
    const f = fixture(), body = structuredClone(f.body);
    (body.binding as any)[field] = field === 'writerFence' ? 2 : id(99);
    await expect(f.service.read(body, f.req, f.dispatcher)).rejects.toThrow(); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([
    (f: ReturnType<typeof fixture>) => { f.state.member = false; },
    (f: ReturnType<typeof fixture>) => { f.state.wall = false; }, (f: ReturnType<typeof fixture>) => { f.state.revoked = true; }, (f: ReturnType<typeof fixture>) => { f.state.exists = false; },
    (f: ReturnType<typeof fixture>) => { f.membership.role = 'viewer'; }, (f: ReturnType<typeof fixture>) => { f.membership.tenant.status = 'inactive'; },
    (f: ReturnType<typeof fixture>) => { f.row.occurrence_state = 'DISPATCHED'; }, (f: ReturnType<typeof fixture>) => { f.row.occurrence_state = 'REFUSED'; },
    (f: ReturnType<typeof fixture>) => { f.row.active_intent = id(99); }, (f: ReturnType<typeof fixture>) => { f.row.current_writer = false; }, (f: ReturnType<typeof fixture>) => { f.row.no_successor = false; },
    (f: ReturnType<typeof fixture>) => { f.row.generation = '2'; }, (f: ReturnType<typeof fixture>) => { f.row.run_projection.state = 'paused'; f.rehash(); },
    (f: ReturnType<typeof fixture>) => { f.row.run_projection.state = 'waiting-for-approval'; f.rehash(); },
    (f: ReturnType<typeof fixture>) => { f.row.execution_record.phase = 'stopping'; f.rehash(); }, (f: ReturnType<typeof fixture>) => { f.row.execution_record.phase = 'settled'; f.rehash(); },
    (f: ReturnType<typeof fixture>) => { f.row.execution_record.expiresAtMs = f.state.now; f.rehash(); },
    (f: ReturnType<typeof fixture>) => { f.row.run_projection.createdAt = new Date(-900000).toISOString(); f.rehash(); },
    (f: ReturnType<typeof fixture>) => { f.consent.expiresAt = new Date(f.state.now); }, (f: ReturnType<typeof fixture>) => { f.consent.policyRevision = 'different'; },
    (f: ReturnType<typeof fixture>) => { f.consent.scopes = []; }, (f: ReturnType<typeof fixture>) => { f.consent.limits = { ...f.consent.limits, maxRuntimeSeconds: 901 }; },
    (f: ReturnType<typeof fixture>) => { f.row.effect.requestId = id(99); f.rehash(); }, (f: ReturnType<typeof fixture>) => { f.row.effect_sha256 = '0'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.row.effect.workflowId = f.row.occurrence.workflowId; f.rehash(); },
    (f: ReturnType<typeof fixture>) => { f.row.execution_record_sha256 = '0'.repeat(64); }, (f: ReturnType<typeof fixture>) => { f.row.projection_sha256 = '0'.repeat(64); },
  ])('refuses stale/corrupt/currently unauthorized source %#', async mutate => {
    const f = fixture(); mutate(f); await expect(f.service.read(f.body, f.req, f.dispatcher)).rejects.toThrow(); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(['member', 'wall', 'revoked'] as const)('does not release results after %s changes', async key => {
    const f = fixture(); f.execute.mockImplementation(async () => { f.state[key] = key === 'revoked'; return {} as never; });
    await expect(f.service.read(f.body, f.req, f.dispatcher)).rejects.toThrow(); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('rejects foreign context/scopes and client selectors before dispatch', async () => {
    for (const change of [(b: any) => { b.context.binding.actorId = id(99); },
      (b: any) => { b.context.subject.scopes[0].resourceId = id(99); }, (b: any) => { b.input.clientId = id(99); }]) {
      const f = fixture(), b = structuredClone(f.body); change(b);
      await expect(f.service.read(b, f.req, f.dispatcher)).rejects.toThrow(); expect(f.execute).not.toHaveBeenCalled();
    }
  });
  it('rejects writes and interactive attachment reads at the existing dispatcher', async () => {
    const f = fixture();
    for (const operation of ['create_task', 'read_chat_attachments']) await expect(f.service.read({ ...f.body, operation }, f.req, f.dispatcher)).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('checks original run deadline on release and honors an already-aborted request', async () => {
    const f = fixture(); f.execute.mockImplementation(async () => { f.state.now = 900000; return {} as never; });
    await expect(f.service.read(f.body, f.req, f.dispatcher)).rejects.toThrow();
    const g = fixture(); g.req.aborted = true;
    await expect(g.service.read(g.body, g.req, g.dispatcher)).rejects.toThrow(); expect(g.execute).not.toHaveBeenCalled();
  });
});
