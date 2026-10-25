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
  const initial = { binding, scopes, versions: run.versions, selectedClientId: personal ? null : id(4),
    requestId: effect.requestId, inputSha256: 'e'.repeat(64), requestSha256: 'f'.repeat(64), allocatedAtMs: 100000, expiresAtMs: 900000 };
  Object.assign(row, { conversation_id: binding.conversationId, run_id: binding.runId, request_sha256: initial.requestSha256,
    initial_input: initial, initial_input_sha256: hash(initial), initial_input_state: 'ACCEPTED', accepted_request_sha256: initial.requestSha256,
    continuation: null, control: null, source_request_matches: false, target_request_matches: false, proof_matches: false, sequence_contiguous: false,
    outgoing_controls: [], next_run_reservation: null, next_run_reservation_sha256: null, next_run_state: null });
  const steps = [row];
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
      if (sql.includes('routine_resume_steps_v1')) return steps;
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
    for (const step of steps) { step.run_projection_sha256 = hash(step.run_projection);
      step.execution_record_sha256 = step.execution_record === null ? null : hash(step.execution_record);
      step.initial_input_sha256 = step.initial_input === null ? null : hash(step.initial_input);
      step.next_run_reservation_sha256 = step.next_run_reservation === null ? null : hash(step.next_run_reservation); } };
  const resume = (status = 'APPLIED', native = true) => {
    const parent = steps.at(-1)!, prior = parent.run_projection.binding, n = steps.length;
    parent.run_projection.state = 'paused'; parent.execution_record.phase = 'settled'; parent.execution_record.native = { state: 'paused', stopped: true };
    const binding = { ...prior, runId: id(100 + n), attemptId: id(200 + n), workerId: id(300 + n), writerFence: n + 1 };
    const input = { controlId: id(400 + n), intent: 'resume', checkpointId: prior.runId, checkpointSha256: '1'.repeat(64) };
    const target = { binding, scopes, selectedClientId: initial.selectedClientId, admissionReceiptId: id(500 + n),
      targetSessionId: null, expiresAtMs: 800000, versions: run.versions };
    const retirement = { binding: prior, retirementReceiptId: id(600 + n), expiresAtMs: 800000 };
    const continuation = { kind: 'native-session', mode: 'resume', controlId: input.controlId,
      sdkSession: { binding: prior, key: { projectKey: 'synthetic', sessionId: id(700 + n) }, ownerSha256: '2'.repeat(64), entriesCount: 1 },
      versions: run.versions, scopes, sourceRequestSha256: parent.request_sha256, contextSha256: '3'.repeat(64), targetSessionId: null };
    const control = { input, inputSha256: hash(input), sourceBinding: prior, scopes, sourceSelectedClientId: initial.selectedClientId,
      sourceRequestSha256: parent.request_sha256, contextSha256: continuation.contextSha256, versions: run.versions,
      captureSequence: 5, state: status, checkpointId: prior.runId, target, retirement };
    const next: any = { tenant_id: id(1), schedule_id: id(3), occurrence_key: key, conversation_id: binding.conversationId, run_id: binding.runId,
      run_projection: { ...run, binding, state: 'running', createdAt: new Date(150000 + n).toISOString() },
      request_sha256: n.toString(16).repeat(64), initial_input: null, initial_input_sha256: null, initial_input_state: null, accepted_request_sha256: null,
      continuation, control, source_request_matches: true, target_request_matches: true, proof_matches: true, sequence_contiguous: true,
      outgoing_controls: [], next_run_reservation: null, next_run_reservation_sha256: null, next_run_state: null,
      execution_record: native ? { ...execution, binding, executionKey: hash(binding), executionId: hash(binding), phase: 'started', native: null } : null,
      execution_key: native ? hash(binding) : null, execution_id: native ? hash(binding) : null };
    parent.outgoing_controls = [{ controlId: input.controlId, intent: 'resume', state: status, targetBinding: binding, retirementBinding: prior }];
    parent.next_run_reservation = { source: prior, target: binding, facts: { checkpoint: null, execution: { recordSha256: hash(parent.execution_record) } },
      scopes, versions: run.versions, policyRevision: run.policyRevision, reservedAt: next.run_projection.createdAt };
    parent.next_run_state = 'ACCEPTED'; row.current_writer = false; row.no_successor = false; steps.push(next); rehash();
    return next;
  };
  return { state, row, steps, initial, consent, membership, calls, tx, prisma, ctx, selection, body, req, execute, tools, service, dispatcher, rehash, resume };
}

describe('native routine saved-consent reads', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(200000));
  afterEach(() => jest.restoreAllMocks());
  it.each([false, true])('derives current principal and preserves typed paging in client/General mode %s', async personal => {
    const f = fixture(personal);
    expect(await f.service.current(f.selection, f.req)).toMatchObject({ actorId: id(2), consentId: id(6), effectExpiresAtMs: 900000 });
    expect(await f.service.read(f.body, f.req, f.dispatcher)).toEqual({ page: f.body.input, nextCursor: 'page-three' });
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ tenantId: id(1), userId: id(2), role: 'standard_user' }), 'search_public_web', f.body.input);
    expect(f.calls.some(q => /tool_run_allocations|tool_grant_bindings|current_admission_v1/.test(q))).toBe(false);
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
  it.each([false, true])('reads only the applied resumed head with original lifetime in client/General mode %s', async personal => {
    const f = fixture(personal); f.resume(); const head = f.resume();
    const selection = { ...f.selection, binding: head.run_projection.binding };
    const body = { ...f.body, ...selection, context: { ...f.ctx, binding: selection.binding } };
    const current = await f.service.current(selection, f.req);
    expect(current).toMatchObject({ binding: selection.binding, effectExpiresAtMs: 900000, clientIds: [id(4), id(10)] });
    expect(current).not.toHaveProperty('lineageSha256');
    expect(await f.service.read(body, f.req, f.dispatcher)).toEqual({ page: body.input, nextCursor: 'page-three' });
    await expect(f.service.read(f.body, f.req, f.dispatcher)).rejects.toThrow();
    await expect(f.service.current(f.selection, f.req)).rejects.toThrow();
    f.initial.expiresAtMs = 220000; f.rehash();
    expect((await f.service.current(selection, f.req)).effectExpiresAtMs).toBe(220000);
    f.state.now = 220000;
    await expect(f.service.read(body, f.req, f.dispatcher)).rejects.toThrow();
  });
  it('keeps lifecycle current separate from reads for a held source and committed DISPATCHING target', async () => {
    const f = fixture(); f.row.run_projection.state = 'paused'; f.rehash();
    expect((await f.service.current(f.selection, f.req)).binding).toEqual(f.selection.binding);
    await expect(f.service.read(f.body, f.req, f.dispatcher)).rejects.toThrow();
    const head = f.resume('DISPATCHING', false), selection = { ...f.selection, binding: head.run_projection.binding };
    expect((await f.service.current(selection, f.req)).binding).toEqual(selection.binding);
    expect((await f.service.current(f.selection, f.req)).binding).toEqual(f.selection.binding);
    const body = { ...f.body, ...selection, context: { ...f.ctx, binding: selection.binding } };
    await expect(f.service.read(body, f.req, f.dispatcher)).rejects.toThrow();
    head.control.state = 'APPLIED'; f.row.outgoing_controls[0].state = 'APPLIED';
    await expect(f.service.read(body, f.req, f.dispatcher)).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(['PENDING', 'DISPATCHING'])('refreshes only the latest held source during uncommitted %s resume', async state => {
    const f = fixture(true), head = f.resume(), binding = head.run_projection.binding;
    head.run_projection.state = 'waiting-for-approval';
    head.outgoing_controls = [{ controlId: id(999), intent: 'resume', state, targetBinding: null, retirementBinding: null }];
    f.rehash();
    expect((await f.service.current({ ...f.selection, binding }, f.req)).binding).toEqual(binding);
    await expect(f.service.current(f.selection, f.req)).rejects.toThrow();
    await expect(f.service.read({ ...f.body, binding, context: { ...f.ctx, binding } }, f.req, f.dispatcher)).rejects.toThrow();
    f.state.revoked = true;
    await expect(f.service.current({ ...f.selection, binding }, f.req)).rejects.toThrow();
    f.state.revoked = false; f.state.now = f.initial.expiresAtMs;
    await expect(f.service.current({ ...f.selection, binding }, f.req)).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([
    (f: ReturnType<typeof fixture>) => { f.row.outgoing_controls[0].controlId = 'invalid'; },
    (f: ReturnType<typeof fixture>) => { f.row.outgoing_controls[0].intent = 'fork'; },
    (f: ReturnType<typeof fixture>) => { f.row.outgoing_controls[0].state = 'UNKNOWN'; },
    (f: ReturnType<typeof fixture>) => { f.row.outgoing_controls[0].state = 'APPLIED'; },
    (f: ReturnType<typeof fixture>) => { f.row.outgoing_controls[0].targetBinding = f.selection.binding; },
    (f: ReturnType<typeof fixture>) => { f.row.outgoing_controls[0].retirementBinding = f.selection.binding; },
    (f: ReturnType<typeof fixture>) => { delete f.row.outgoing_controls[0].targetBinding; },
    (f: ReturnType<typeof fixture>) => { f.row.outgoing_controls.push({ ...f.row.outgoing_controls[0], controlId: id(998) }); },
    (f: ReturnType<typeof fixture>) => { f.row.next_run_state = 'RESERVED'; },
    (f: ReturnType<typeof fixture>) => { f.row.run_projection.state = 'running'; f.rehash(); },
  ])('refuses ambiguous or unrelated uncommitted current authority %#', async mutate => {
    const f = fixture(); f.row.run_projection.state = 'paused';
    f.row.outgoing_controls = [{ controlId: id(999), intent: 'resume', state: 'PENDING', targetBinding: null, retirementBinding: null }];
    f.rehash(); mutate(f);
    await expect(f.service.current(f.selection, f.req)).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(['completed', 'failed', 'paused', 'waiting-for-approval'])('refreshes committed %s target through APPLIED receipt readback without permitting reads', async state => {
    const f = fixture(), head = f.resume('DISPATCHING'), binding = head.run_projection.binding;
    head.run_projection.state = state; head.execution_record.phase = 'settled'; head.execution_record.native = { state };
    f.rehash();
    expect((await f.service.current({ ...f.selection, binding }, f.req)).binding).toEqual(binding);
    expect((await f.service.current(f.selection, f.req)).binding).toEqual(f.selection.binding);
    await expect(f.service.read({ ...f.body, binding, context: { ...f.ctx, binding } }, f.req, f.dispatcher)).rejects.toThrow();
    f.state.wall = false;
    await expect(f.service.current({ ...f.selection, binding }, f.req)).rejects.toThrow();
    f.state.wall = true; head.control.state = 'APPLIED'; f.row.outgoing_controls[0].state = 'APPLIED';
    expect((await f.service.current({ ...f.selection, binding }, f.req)).binding).toEqual(binding);
    await expect(f.service.current(f.selection, f.req)).rejects.toThrow();
    await expect(f.service.read({ ...f.body, binding, context: { ...f.ctx, binding } }, f.req, f.dispatcher)).rejects.toThrow();
    head.run_projection.state = 'cancelled'; head.execution_record.native.state = 'cancelled'; f.rehash();
    await expect(f.service.current({ ...f.selection, binding }, f.req)).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([
    (f: ReturnType<typeof fixture>, h: any) => { h.control.state = 'UNKNOWN'; f.row.outgoing_controls[0].state = 'UNKNOWN'; },
    (f: ReturnType<typeof fixture>, h: any) => { h.control.state = 'PENDING'; f.row.outgoing_controls[0].state = 'PENDING'; },
    (_f: ReturnType<typeof fixture>, h: any) => { h.continuation.mode = 'fork'; },
    (f: ReturnType<typeof fixture>) => { f.row.outgoing_controls.push({ ...f.row.outgoing_controls[0], controlId: id(999) }); },
    (f: ReturnType<typeof fixture>) => { f.row.next_run_state = 'RESERVED'; },
    (f: ReturnType<typeof fixture>) => { f.row.next_run_reservation.target = { ...f.row.next_run_reservation.target, runId: id(999) }; f.rehash(); },
    (f: ReturnType<typeof fixture>) => { f.row.next_run_reservation.facts.execution.recordSha256 = '0'.repeat(64); f.rehash(); },
    (_f: ReturnType<typeof fixture>, h: any) => { h.outgoing_controls.push({ controlId: id(999), intent: 'fork', state: 'PENDING', targetBinding: null, retirementBinding: null }); },
    (f: ReturnType<typeof fixture>, h: any) => { h.next_run_reservation = f.row.next_run_reservation; h.next_run_state = 'RESERVED'; f.rehash(); },
    (f: ReturnType<typeof fixture>, h: any) => { h.run_projection.binding.writerFence = 3; f.rehash(); },
    (f: ReturnType<typeof fixture>, h: any) => { h.run_projection.scopes = []; f.rehash(); },
    (_f: ReturnType<typeof fixture>, h: any) => { h.source_request_matches = false; },
    (_f: ReturnType<typeof fixture>, h: any) => { h.target_request_matches = false; },
    (_f: ReturnType<typeof fixture>, h: any) => { h.proof_matches = false; },
    (_f: ReturnType<typeof fixture>, h: any) => { h.sequence_contiguous = false; },
    (_f: ReturnType<typeof fixture>, h: any) => { h.continuation.sdkSession.binding = { ...h.continuation.sdkSession.binding, actorId: id(999) }; },
    (_f: ReturnType<typeof fixture>, h: any) => { h.control.retirement.binding = { ...h.control.retirement.binding, runId: id(999) }; },
    (f: ReturnType<typeof fixture>) => { f.row.execution_record.phase = 'stopping'; f.row.execution_record.native = null; f.rehash(); },
    (f: ReturnType<typeof fixture>) => { f.row.initial_input_state = 'RESERVED'; },
    (f: ReturnType<typeof fixture>) => { f.row.accepted_request_sha256 = '0'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.steps.push(structuredClone(f.steps[1])); },
    (f: ReturnType<typeof fixture>) => { while (f.steps.length < 101) f.steps.push(f.steps[1]); },
  ])('refuses corrupt, unresolved or unrelated resume lineage %# before reads', async mutate => {
    const f = fixture(), head = f.resume();
    const binding = structuredClone(head.run_projection.binding);
    mutate(f, head);
    const body = { ...f.body, binding, context: { ...f.ctx, binding } };
    await expect(f.service.read(body, f.req, f.dispatcher)).rejects.toThrow();
    await expect(f.service.current({ ...f.selection, binding }, f.req)).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('rechecks exact lineage after I/O even when its current binding and scopes stay the same', async () => {
    const f = fixture(), head = f.resume(), binding = head.run_projection.binding;
    f.execute.mockImplementation(async () => { head.control.target.admissionReceiptId = id(999); return {} as never; });
    await expect(f.service.read({ ...f.body, binding, context: { ...f.ctx, binding } }, f.req, f.dispatcher)).rejects.toThrow();
    expect(f.execute).toHaveBeenCalledTimes(1);
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
