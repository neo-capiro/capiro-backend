/**
 * MR-04 renewal half — the mounted attended renewal route and the shared
 * transaction-local consent writer.
 *
 * These specs exercise the REAL mounted attended route (`POST
 * /api/clio/routines/consent/renew`, global prefix, real `RolesGuard`, real
 * `ToolServiceSecretGuard`, real `CurrentTenant`), the real service method, the
 * real `routineConsentEvent` owner and the real shared writer. A helper-only
 * checkpoint would not prove the route is mounted behind the existing attended
 * guards, that the caller's body reaches the writer, or that the write happens
 * inside one transaction with the pinned-consent check.
 *
 * Synthetic rows, a mocked local Prisma protocol and a fake membership receipt
 * only: no DATABASE_URL, no live schema read, no model/provider/browser/network.
 */
import { EventEmitter } from 'node:events';
import { GUARDS_METADATA, HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { ForbiddenException, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../../auth/roles.guard.js';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { nativeCanonicalSha256 } from '../native-approvals/native-approval.contract.js';
import { ROUTINE_CONSENT_MAX_SECONDS } from './meri-routine-firing.js';
import { MERI_ROUTINE_CANCEL_SIGNER, MERI_ROUTINE_FIRE_SIGNER, MeriRoutinesService } from './meri-routines.service.js';
import { MeriRoutinesController } from './meri-routines.controller.js';
import { parseRoutineConsentRenewalRequest } from './meri-routine-consent-renewal.js';

const SECRET = 'synthetic-tool-service-secret';
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const TENANT = id(1), OWNER = id(2), SCHEDULE = id(3), INTENT_ID = id(4), CLIENT_A = id(5), CLIENT_B = id(6), FOREIGN = id(7);
const GEN = 4, POLICY = 'policy-1';
const WINDOW_MS = ROUTINE_CONSENT_MAX_SECONDS * 1000;
const NOW = Date.now();

const scope = (resourceId: string, patch: Record<string, unknown> = {}) =>
  ({ tenantId: TENANT, kind: 'client', resourceId, policyRevision: POLICY, ...patch });
const limits = { maxCostMicrousd: 500, maxRuntimeSeconds: 60, retryLimit: 1 };
const projection = () => ({
  scheduleId: SCHEDULE, owner: { tenantId: TENANT, actorId: OWNER }, scopes: [scope(CLIENT_A), scope(CLIENT_B)],
  state: 'active', maxCostMicrousd: 500, maxRuntimeSeconds: 60, retryLimit: 1,
});
/** The immutable intent bytes the trusted control service holds in custody. */
const intent = (patch: Record<string, unknown> = {}) => ({
  intentId: INTENT_ID, operation: 'schedule_task', generation: GEN, projection: projection(), taskInstructionSha256: 'f'.repeat(64), ...patch,
});
const approval = (patch: Record<string, unknown> = {}) => ({
  proposalId: INTENT_ID, commandSha256: nativeCanonicalSha256(intent()), decision: 'approved',
  decidedAt: new Date(NOW - 1_000).toISOString(), expiresAt: new Date(NOW + 3_600_000).toISOString(),
  approver: { tenantId: TENANT, actorId: OWNER }, policyRevision: POLICY, ...patch,
});
/** The wire-A `before_claim` envelope Meri already builds for an attended Execute. */
function selection(patch: Record<string, unknown> = {}, ap = approval()) {
  // `intent` is a test-helper input (the immutable bytes), not a selection member:
  // the closed envelope allows exactly phase/operation/proposal/scheduleBinding.
  const { intent: itPatch, ...rest } = patch;
  const it0 = itPatch ?? intent();
  const call = { intent: it0, approval: ap, callerIdentity: { tenantId: TENANT, actorId: OWNER }, deadlineMs: NOW + 3_600_000 };
  return {
    phase: 'before_claim', operation: 'schedule_task',
    proposal: { operation: 'schedule_task', status: 'approval_required', proposalId: INTENT_ID,
      intentSha256: nativeCanonicalSha256(it0), taskInstruction: null, projection: (it0 as { projection: unknown }).projection, policy: null, cancel: null },
    scheduleBinding: { ...call, bindingSha256: nativeCanonicalSha256(call) },
    ...rest,
  };
}
const body = (patch: Record<string, unknown> = {}, ap = approval()) => ({ schemaVersion: 1, selection: selection(patch, ap) });
const decision = (ap: Record<string, unknown>) => nativeCanonicalSha256(ap);

interface ConsentRow {
  consentId: string; tenantId: string; ownerUserId: string; scheduleId: string; intentId: string; generation: number;
  intentSha256: string; projectionSha256: string; decisionSha256: string; scopes: unknown[]; limits: unknown;
  policyRevision: string; issuedAt: Date; expiresAt: Date;
}
const consentRow = (patch: Partial<ConsentRow> = {}): ConsentRow => ({
  consentId: id(90), tenantId: TENANT, ownerUserId: OWNER, scheduleId: SCHEDULE, intentId: INTENT_ID, generation: GEN,
  intentSha256: nativeCanonicalSha256(intent()), projectionSha256: nativeCanonicalSha256(projection()),
  decisionSha256: decision(approval({ decidedAt: new Date(NOW - 10 * 86_400_000).toISOString() })),
  scopes: [scope(CLIENT_A), scope(CLIENT_B)], limits, policyRevision: POLICY,
  issuedAt: new Date(NOW - 100_000), expiresAt: new Date(NOW + 100_000), ...patch,
});

interface State {
  now: number; rows: ConsentRow[]; member: { role: string; status: string; tenantStatus: string } | null;
  receipt: { actorId: string } | null; visibleClients: string[] | null; revokedAt: number | null;
  hiddenDecisions: Set<string>; clockFails: boolean; consentReadFails: boolean; revocationReadFails: boolean;
  calls: string[]; writes: string[]; tenants: string[];
}

function fixture() {
  const state: State = {
    now: NOW, rows: [consentRow()], member: { role: 'standard_user', status: 'active', tenantStatus: 'active' },
    receipt: null, visibleClients: null, revokedAt: null, hiddenDecisions: new Set(),
    clockFails: false, consentReadFails: false, revocationReadFails: false, calls: [], writes: [], tenants: [],
  };
  // The tenant wall: rows of another tenant are never visible to a scoped read.
  const inTenant = (args: { where?: { tenantId?: string } }) => args?.where?.tenantId === TENANT;
  const consentRead = (args: { where?: Record<string, string> }) => {
    if (!inTenant(args)) return null;
    state.calls.push('consent');
    if (state.consentReadFails) throw new Error('consent read unavailable');
    const where = args?.where ?? {};
    const hidden = where.decisionSha256 !== undefined && state.hiddenDecisions.has(where.decisionSha256);
    if (hidden) return null;
    // A scoped read also applies the row's own tenant (the query's tenantId is the
    // wall): another tenant's row is never returned for this session's tenant.
    const matching = state.rows.filter((row) => row.tenantId === where.tenantId && (!where.ownerUserId || row.ownerUserId === where.ownerUserId) &&
      (!where.scheduleId || row.scheduleId === where.scheduleId) && (!where.intentId || row.intentId === where.intentId) &&
      (!where.decisionSha256 || row.decisionSha256 === where.decisionSha256));
    return [...matching].sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime())[0] ?? null;
  };
  const tx: any = {
    $queryRaw: jest.fn(async (strings: readonly string[], ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('pg_advisory_xact_lock')) { state.calls.push('lock'); return []; }
      if (sql.includes('clock_timestamp')) {
        state.calls.push('clock');
        if (state.clockFails) throw new Error('database clock unavailable');
        return [{ db_now: new Date(state.now) }];
      }
      if (sql.includes('FROM clients')) {
        state.calls.push('clients');
        const ids = (values.find((v) => Array.isArray(v)) ?? []) as string[];
        return ids.filter((clientId) => state.visibleClients === null || state.visibleClients.includes(clientId)).map((clientId) => ({ id: clientId }));
      }
      throw new Error(`unexpected sql: ${sql}`);
    }),
    clioMeriRoutineConsent: {
      findFirst: jest.fn((args: never) => Promise.resolve(consentRead(args as never))),
      // The real unique key (tenantId, intentId, decisionSha256) with skipDuplicates:
      // an exact replay inserts nothing and the first row's window stands.
      createMany: jest.fn(async (args: { data: any[] }) => {
        state.writes.push('consent.createMany');
        for (const row of args.data) {
          const duplicate = state.rows.some((existing) => existing.intentId === row.intentId && existing.decisionSha256 === row.decisionSha256);
          if (duplicate) continue;
          state.hiddenDecisions.delete(row.decisionSha256);
          state.rows.push({ ...row, consentId: row.consentId ?? id(91) } as ConsentRow);
        }
        return { count: 1 };
      }),
      create: jest.fn(async () => { state.writes.push('consent.create'); return {}; }),
      updateMany: jest.fn(async () => { state.writes.push('consent.updateMany'); return {}; }),
      deleteMany: jest.fn(async () => { state.writes.push('consent.deleteMany'); return {}; }),
    },
    clioMeriRoutineConsentRevocation: {
      findFirst: jest.fn(async (args: { where?: { tenantId?: string; revokedAt?: { gte?: Date } } }) => {
        if (!inTenant(args)) return null;
        state.calls.push('revocation');
        if (state.revocationReadFails) throw new Error('revocation read unavailable');
        if (state.revokedAt === null) return null;
        const since = args?.where?.revokedAt?.gte;
        if (since instanceof Date && state.revokedAt < since.getTime()) return null;
        return { revokedAt: new Date(state.revokedAt) };
      }),
      createMany: jest.fn(async () => { state.writes.push('revocation.createMany'); return {}; }),
    },
    clioMeriRoutineFireGrant: { create: jest.fn(async () => { state.writes.push('fireGrant.create'); return {}; }) },
    clioMeriRoutineApproval: { createMany: jest.fn(async () => { state.writes.push('approval.createMany'); return {}; }) },
    tenantMembership: {
      findFirst: jest.fn(async (args: never) => {
        if (!inTenant(args)) return null;
        state.calls.push('membership');
        return state.member === null ? null : { tenantId: TENANT, userId: OWNER, role: state.member.role,
          status: state.member.status, tenant: { status: state.member.tenantStatus } };
      }),
    },
  };
  const prisma: any = {
    withTenant: jest.fn(async (tenant: string, fn: (client: unknown) => unknown) => { state.tenants.push(tenant); return fn(tx); }),
    withTenantUser: jest.fn(async () => { throw new Error('renewal must not open a per-user transaction'); }),
  };
  const membership = {
    read: jest.fn(async (_req: unknown, ctx: { tenantId: string; userId: string }) => ({
      tenantId: TENANT, actorId: state.receipt?.actorId ?? ctx.userId, clientIds: [CLIENT_A, CLIENT_B],
      membershipRevision: 'a'.repeat(64), expiresAtMs: state.now + 10_000,
    })),
  };
  const service = new MeriRoutinesService(prisma, membership as never, null, null);
  const ctx: TenantContext = { tenantId: TENANT, tenantSlug: 'synthetic', userId: OWNER, clerkUserId: 'user_synthetic', role: 'standard_user' };
  const req = verifiedRequest();
  return { state, tx, service, membership, prisma, ctx, req };
}

/** The real guard records the request-local service identity only on its matching branch. */
function verifiedRequest(verified = true) {
  const req = Object.assign(new EventEmitter(), {
    headers: { 'x-internal-service-secret': verified ? SECRET : 'wrong' }, method: 'POST', path: '/api/clio/routines/consent/renew',
  }) as unknown as { headers: Record<string, string> };
  new ToolServiceSecretGuard({ get: (key: string) => (key === 'NODE_ENV' ? 'test' : key === 'INTERNAL_SERVICE_SECRET' ? SECRET : false) } as never)
    .canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as never);
  return req as never;
}

const config = () => ({ get: (key: string) =>
  (key === 'NODE_ENV' ? 'test' : key === 'INTERNAL_SERVICE_SECRET' ? SECRET : key === 'MERI_TOOLS_REQUIRE_SERVICE_SECRET' ? false : undefined) } as never);

async function mounted(f: ReturnType<typeof fixture>) {
  const module = await Test.createTestingModule({
    controllers: [MeriRoutinesController],
    providers: [RolesGuard, ToolServiceSecretGuard, { provide: ConfigService, useValue: config() },
      { provide: MeriRoutinesService, useValue: f.service }, { provide: MERI_ROUTINE_CANCEL_SIGNER, useValue: null },
      { provide: MERI_ROUTINE_FIRE_SIGNER, useValue: null }],
  }).compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('api');
  // The real TenantContextMiddleware is what sets `req.tenantContext`; this stands in
  // for it so the spec can also send a request that never passed through it.
  app.use((req: { tenantContext?: unknown; headers: Record<string, string> }, _res: unknown, next: () => void) => {
    if (req.headers['no-context'] !== '1') req.tenantContext = f.ctx;
    next();
  });
  await app.init();
  return app;
}

describe('MR-04 routine consent renewal (attended, real writer)', () => {
  beforeAll(() => {
    process.env.MERI_ROUTINE_MAX_COST_MICROUSD = '2000000';
    process.env.MERI_ROUTINE_MAX_RUNTIME_SECONDS = '900';
    process.env.MERI_ROUTINE_RETRY_LIMIT = '1';
  });
  afterAll(() => {
    delete process.env.MERI_ROUTINE_MAX_COST_MICROUSD;
    delete process.env.MERI_ROUTINE_MAX_RUNTIME_SECONDS;
    delete process.env.MERI_ROUTINE_RETRY_LIMIT;
  });

  it('mounts the renewal behind the existing attended guards and refuses a caller without the service identity', async () => {
    expect(Reflect.getMetadata(PATH_METADATA, MeriRoutinesController.prototype.consentRenew)).toBe('consent/renew');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, MeriRoutinesController.prototype.consentRenew)).toBe(200);
    // The existing attended guard pair, not a new protected transport.
    expect(Reflect.getMetadata(GUARDS_METADATA, MeriRoutinesController)).toEqual([RolesGuard, ToolServiceSecretGuard]);
    const f = fixture(), app = await mounted(f);
    try {
      const http = request(app.getHttpServer());
      await http.post('/api/clio/routines/consent/renew').send(body()).expect(403);
      expect(f.state.writes).toEqual([]);
      const renewed = await http.post('/api/clio/routines/consent/renew').set('x-internal-service-secret', SECRET).send(body()).expect(200);
      expect(renewed.body).toEqual({ schemaVersion: 1, state: 'active', generation: GEN, policyRevision: POLICY,
        issuedAtMs: NOW, expiresAtMs: NOW + WINDOW_MS, observedAtMs: NOW, idempotent: false });
      expect(f.state.tenants).toEqual([TENANT]);
      // A route reached without the tenant middleware is denied, and so is a
      // request without the service identity: the identity is the private boundary.
      await http.post('/api/clio/routines/consent/renew').set('x-internal-service-secret', SECRET).set('no-context', '1').send(body()).expect(403);
    } finally { await app.close(); }
  });

  it('is attended: the same body without a tenant context is denied and never reaches the writer', async () => {
    const f = fixture(), module = await Test.createTestingModule({
      controllers: [MeriRoutinesController],
      providers: [RolesGuard, ToolServiceSecretGuard, { provide: ConfigService, useValue: config() },
        { provide: MeriRoutinesService, useValue: f.service }, { provide: MERI_ROUTINE_CANCEL_SIGNER, useValue: null },
        { provide: MERI_ROUTINE_FIRE_SIGNER, useValue: null }],
    }).compile();
    const app = module.createNestApplication(); app.setGlobalPrefix('api'); await app.init();
    try {
      await request(app.getHttpServer()).post('/api/clio/routines/consent/renew').set('x-internal-service-secret', SECRET).send(body()).expect(403);
      expect(f.state.calls).toEqual([]); expect(f.state.writes).toEqual([]);
    } finally { await app.close(); }
  });

  it('renews an expired owner consent as a new row through the same writer, without any grant', async () => {
    const f = fixture();
    f.state.rows = [consentRow({ issuedAt: new Date(NOW - 40 * 86_400_000), expiresAt: new Date(NOW - 10 * 86_400_000) })];
    const renewed = await f.service.consentRenew(f.req, f.ctx, body());
    expect(renewed).toEqual({ schemaVersion: 1, state: 'active', generation: GEN, policyRevision: POLICY,
      issuedAtMs: NOW, expiresAtMs: NOW + WINDOW_MS, observedAtMs: NOW, idempotent: false });
    // One new row, pinned to the unchanged approved intent and the same owner, and
    // nothing else written: no fire grant, no approval, no revocation, no signing.
    expect(f.state.rows).toHaveLength(2);
    expect(f.state.rows[1]).toMatchObject({ tenantId: TENANT, ownerUserId: OWNER, scheduleId: SCHEDULE, intentId: INTENT_ID,
      generation: GEN, intentSha256: nativeCanonicalSha256(intent()), projectionSha256: nativeCanonicalSha256(projection()),
      policyRevision: POLICY, limits, scopes: [scope(CLIENT_A), scope(CLIENT_B)],
      issuedAt: new Date(NOW), expiresAt: new Date(NOW + WINDOW_MS) });
    expect(f.state.writes).toEqual(['consent.createMany']);
    // One transaction: lock, clock, the pinned consent and its fences, then the
    // shared writer (same lock, same clock) and the stored-window read-back.
    expect(f.state.calls).toEqual(['lock', 'clock', 'consent', 'revocation', 'membership', 'clients', 'consent', 'lock', 'clock', 'consent']);
  });

  it('treats the same approval as a replay: no second row and no extension of the stored window', async () => {
    const f = fixture();
    const first = await f.service.consentRenew(f.req, f.ctx, body());
    expect(first).toMatchObject({ issuedAtMs: NOW, expiresAtMs: NOW + WINDOW_MS, idempotent: false });
    // Time passes: a renewal that minted a new window would move both instants.
    f.state.now = NOW + 60_000;
    const replay = await f.service.consentRenew(f.req, f.ctx, body());
    expect(replay).toEqual({ schemaVersion: 1, state: 'active', generation: GEN, policyRevision: POLICY,
      issuedAtMs: NOW, expiresAtMs: NOW + WINDOW_MS, observedAtMs: NOW + 60_000, idempotent: true });
    expect(f.state.rows).toHaveLength(2);
    // Replaying an approval whose recorded window already closed reports expired,
    // never active: a replay cannot extend a consent that lapsed.
    f.state.rows = [consentRow(), consentRow({ decisionSha256: decision(approval()), issuedAt: new Date(NOW - 40 * 86_400_000),
      expiresAt: new Date(NOW - 10 * 86_400_000) })];
    expect(await f.service.consentRenew(f.req, f.ctx, body())).toMatchObject({ state: 'expired', idempotent: true,
      issuedAtMs: NOW - 40 * 86_400_000, expiresAtMs: NOW - 10 * 86_400_000 });
  });

  it('keeps one row when two renewals of the same approval race past the idempotency pre-read', async () => {
    const f = fixture();
    const raced = consentRow({ decisionSha256: decision(approval()), issuedAt: new Date(NOW - 5_000), expiresAt: new Date(NOW + WINDOW_MS - 5_000) });
    f.state.rows = [consentRow(), raced];
    // The competing transaction commits the decision row after this call read the
    // table but before it inserted: the unique decision key still yields one row.
    f.state.hiddenDecisions.add(decision(approval()));
    const renewed = await f.service.consentRenew(f.req, f.ctx, body());
    expect(renewed).toEqual({ schemaVersion: 1, state: 'active', generation: GEN, policyRevision: POLICY,
      issuedAtMs: NOW - 5_000, expiresAtMs: NOW + WINDOW_MS - 5_000, observedAtMs: NOW, idempotent: false });
    expect(f.state.rows).toHaveLength(2);
    expect(f.state.rows.filter((row) => row.decisionSha256 === decision(approval()))).toHaveLength(1);
  });

  it.each([
    ['a stale approval', () => body({}, approval({ expiresAt: new Date(NOW - 1).toISOString() }))],
    ['an approval decided in the future', () => body({}, approval({ decidedAt: new Date(NOW + 60_000).toISOString() }))],
    ['a declined decision', () => body({}, approval({ decision: 'declined' }))],
    ['a foreign approver actor', () => body({}, approval({ approver: { tenantId: TENANT, actorId: FOREIGN } }))],
    ['a foreign approver tenant', () => body({}, approval({ approver: { tenantId: FOREIGN, actorId: OWNER } }))],
    ['a changed policy revision', () => body({}, approval({ policyRevision: 'policy-2' }))],
    ['an approval bound to another intent digest', () => body({}, approval({ commandSha256: 'a'.repeat(64) }))],
    ['an approval for another proposal', () => body({}, approval({ proposalId: FOREIGN }))],
  ])('refuses %s before it opens a transaction', async (_name, build) => {
    const f = fixture();
    await expect(f.service.consentRenew(f.req, f.ctx, build())).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.state.tenants).toEqual([]); expect(f.state.calls).toEqual([]); expect(f.state.writes).toEqual([]);
  });

  it.each([
    ['a proposal whose projection differs from the intent', { projection: { ...projection(), scheduleId: FOREIGN } }],
    ['a proposal that is not awaiting approval', { status: 'approved' }],
    ['a proposal bound to another intent digest', { intentSha256: 'a'.repeat(64) }],
    ['a proposal for another intent id', { proposalId: FOREIGN }],
    ['a proposal for another operation', { operation: 'update_scheduled_task' }],
  ])('refuses %s: the consent must bind the proposal as well as the call', async (_name, patch) => {
    const f = fixture();
    const value = body();
    Object.assign(value.selection.proposal, patch);
    await expect(f.service.consentRenew(f.req, f.ctx, value)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.state.tenants).toEqual([]); expect(f.state.writes).toEqual([]);
  });

  it('refuses a changed intent, generation, projection, scopes, limits or policy revision against the stored consent', async () => {
    const cases: Array<[string, () => ReturnType<typeof fixture>, Record<string, unknown>?]> = [
      ['a newer generation intent', () => { const f = fixture(); f.state.rows = [consentRow({ generation: GEN - 1 })]; return f; }],
      ['a changed intent digest', () => { const f = fixture(); f.state.rows = [consentRow({ intentSha256: 'a'.repeat(64) })]; return f; }],
      ['a changed projection digest', () => { const f = fixture(); f.state.rows = [consentRow({ projectionSha256: 'b'.repeat(64) })]; return f; }],
      ['another intent id', () => { const f = fixture(); f.state.rows = [consentRow({ intentId: FOREIGN })]; return f; }],
      ['another owner', () => { const f = fixture(); f.state.rows = [consentRow({ ownerUserId: FOREIGN })]; return f; }],
      ['a second client scope', () => { const f = fixture(); f.state.rows = [consentRow({ scopes: [scope(CLIENT_A)] })]; return f; }],
      ['a widened limit', () => { const f = fixture(); f.state.rows = [consentRow({ limits: { ...limits, maxCostMicrousd: 501 } })]; return f; }],
      ['a moved policy revision', () => { const f = fixture(); f.state.rows = [consentRow({ policyRevision: 'policy-0' })]; return f; }],
      ['a consent issued in the future', () => { const f = fixture(); f.state.rows = [consentRow({ issuedAt: new Date(NOW + 1) })]; return f; }],
    ];
    for (const [name, build] of cases) {
      const f = build();
      await expect(f.service.consentRenew(f.req, f.ctx, body())).rejects.toBeInstanceOf(ForbiddenException);
      expect([name, f.state.writes]).toEqual([name, []]);
    }
    // The projection limits may never exceed the currently configured maxima.
    const raised = fixture();
    raised.state.rows = [consentRow({ limits: { ...limits, maxRuntimeSeconds: 901 } })];
    await expect(raised.service.consentRenew(raised.req, raised.ctx, body({ intent: intent({ projection: { ...projection(), maxRuntimeSeconds: 901, retryLimit: 0 } }) })))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(raised.state.writes).toEqual([]);
  });

  it('denies a paused projection, a cancel intent, a missing consent, a lost membership and a lost client scope', async () => {
    const paused = fixture();
    const cancelled = intent({ projection: { ...projection(), state: 'paused' } });
    await expect(paused.service.consentRenew(paused.req, paused.ctx, body({ intent: cancelled }))).rejects.toBeInstanceOf(ForbiddenException);
    // A cancel intent is not a renewal shape at all.
    await expect(paused.service.consentRenew(paused.req, paused.ctx, body({ operation: 'cancel_scheduled_task' }))).rejects.toBeInstanceOf(BadRequestException);
    expect(paused.state.writes).toEqual([]);
    // The same routine, unpaused, renews: the refusal was the projection's state.
    expect(await paused.service.consentRenew(paused.req, paused.ctx, body())).toMatchObject({ state: 'active' });
    expect(paused.state.writes).toEqual(['consent.createMany']);

    const none = fixture(); none.state.rows = [];
    await expect(none.service.consentRenew(none.req, none.ctx, body())).rejects.toBeInstanceOf(ForbiddenException);
    expect(none.state.calls).toEqual(['lock', 'clock', 'consent']);
    expect(none.state.writes).toEqual([]);

    for (const member of [null, { role: 'viewer', status: 'active', tenantStatus: 'active' }, { role: 'standard_user', status: 'active', tenantStatus: 'suspended' }]) {
      const f = fixture(); f.state.member = member as never;
      await expect(f.service.consentRenew(f.req, f.ctx, body())).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.state.writes).toEqual([]);
    }

    const walled = fixture(); walled.state.visibleClients = [CLIENT_A];
    await expect(walled.service.consentRenew(walled.req, walled.ctx, body())).rejects.toBeInstanceOf(ForbiddenException);
    expect(walled.state.writes).toEqual([]);

    const receipt = fixture(); receipt.state.receipt = { actorId: FOREIGN };
    await expect(receipt.service.consentRenew(receipt.req, receipt.ctx, body())).rejects.toBeInstanceOf(ForbiddenException);
    expect(receipt.state.tenants).toEqual([]); expect(receipt.state.writes).toEqual([]);
  });

  it('denies an attended pause/delete revocation for the schedule and grants nothing back', async () => {
    const f = fixture();
    f.state.revokedAt = NOW - 1;
    await expect(f.service.consentRenew(f.req, f.ctx, body())).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.state.writes).toEqual([]);
    // A revocation older than the stored consent is not a revocation of it.
    f.state.revokedAt = NOW - 200_000;
    await expect(f.service.consentRenew(f.req, f.ctx, body())).resolves.toMatchObject({ state: 'active' });
    expect(f.state.writes).toEqual(['consent.createMany']);
  });

  it('never signs a firing grant and answers a closed response', async () => {
    const f = fixture();
    const renewed = await f.service.consentRenew(f.req, f.ctx, body());
    expect(Object.keys(renewed).sort()).toEqual(['expiresAtMs', 'generation', 'idempotent', 'issuedAtMs', 'observedAtMs', 'policyRevision', 'schemaVersion', 'state']);
    expect(f.state.writes).not.toContain('fireGrant.create');
    expect(f.state.writes).not.toContain('approval.createMany');
    expect(f.state.writes).not.toContain('revocation.createMany');
    expect(f.prisma.withTenantUser).not.toHaveBeenCalled();
  });

  it('never converts an unavailable clock, consent read, revocation read or client wall into a renewal', async () => {
    for (const break_ of [(f: ReturnType<typeof fixture>) => { f.state.clockFails = true; },
      (f: ReturnType<typeof fixture>) => { f.state.consentReadFails = true; },
      (f: ReturnType<typeof fixture>) => { f.state.revocationReadFails = true; },
      (f: ReturnType<typeof fixture>) => { f.tx.$queryRaw = jest.fn(async (strings: readonly string[]) =>
        (strings.join('?').includes('clock_timestamp') ? [{ db_now: 'not-a-date' }] : [])); },
      (f: ReturnType<typeof fixture>) => { f.tx.$queryRaw = jest.fn(async (strings: readonly string[]) =>
        { if (strings.join('?').includes('FROM clients')) throw new Error('client wall unavailable'); return []; }); }]) {
      const f = fixture(); break_(f);
      await expect(f.service.consentRenew(f.req, f.ctx, body())).rejects.toThrow();
      expect(f.state.writes).toEqual([]);
    }
  });

  it('answers 503 while the configured maxima are absent and never renews without them', async () => {
    const saved = { cost: process.env.MERI_ROUTINE_MAX_COST_MICROUSD, runtime: process.env.MERI_ROUTINE_MAX_RUNTIME_SECONDS, retry: process.env.MERI_ROUTINE_RETRY_LIMIT };
    delete process.env.MERI_ROUTINE_MAX_COST_MICROUSD; delete process.env.MERI_ROUTINE_MAX_RUNTIME_SECONDS; delete process.env.MERI_ROUTINE_RETRY_LIMIT;
    try {
      const f = fixture();
      await expect(f.service.consentRenew(f.req, f.ctx, body())).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(f.state.writes).toEqual([]); expect(f.membership.read).not.toHaveBeenCalled();
    } finally {
      process.env.MERI_ROUTINE_MAX_COST_MICROUSD = saved.cost; process.env.MERI_ROUTINE_MAX_RUNTIME_SECONDS = saved.runtime;
      process.env.MERI_ROUTINE_RETRY_LIMIT = saved.retry;
    }
  });

  it.each([
    ['an extra key', { schemaVersion: 1, selection: selection(), extra: true }],
    ['a missing selection', { schemaVersion: 1 }],
    ['a different schema version', { ...body(), schemaVersion: 2 }],
    ['a phase that is not before_claim', { schemaVersion: 1, selection: { ...selection(), phase: 'after_start' } }],
    ['a cancel operation', { schemaVersion: 1, selection: { ...selection(), operation: 'cancel_scheduled_task' } }],
    ['an intent that contradicts the operation', { schemaVersion: 1, selection: selection({ intent: intent({ operation: 'update_scheduled_task' }) }) }],
    ['a bad intent id', { schemaVersion: 1, selection: selection({ intent: intent({ intentId: 'not-a-uuid' }) }) }],
    ['a generation below one', { schemaVersion: 1, selection: selection({ intent: intent({ generation: 0 }) }) }],
    ['a fractional generation', { schemaVersion: 1, selection: selection({ intent: intent({ generation: 1.5 }) }) }],
    ['a bad schedule id', { schemaVersion: 1, selection: selection({ intent: intent({ projection: { ...projection(), scheduleId: 'x' } }) }) }],
    ['no scopes', { schemaVersion: 1, selection: selection({ intent: intent({ projection: { ...projection(), scopes: [] } }) }) }],
    ['a non-string approval expiry', { schemaVersion: 1, selection: selection({}, approval({ expiresAt: 123 as never })) }],
    ['a missing binding digest', { schemaVersion: 1, selection: (() => { const s = selection(); delete (s.scheduleBinding as { bindingSha256?: unknown }).bindingSha256; return s; })() }],
  ])('rejects a malformed private-protocol body: %s', async (_name, value) => {
    expect(() => parseRoutineConsentRenewalRequest(value)).toThrow(BadRequestException);
  });

  it('rejects a malformed body at the mounted route without touching the database', async () => {
    const f = fixture(), app = await mounted(f);
    try {
      const http = request(app.getHttpServer());
      await http.post('/api/clio/routines/consent/renew').set('x-internal-service-secret', SECRET).send({ schemaVersion: 1, selection: { ...selection(), operation: 'cancel_scheduled_task' } }).expect(400);
      await http.post('/api/clio/routines/consent/renew').set('x-internal-service-secret', SECRET).send({ schemaVersion: 2, selection: selection() }).expect(400);
      await http.post('/api/clio/routines/consent/renew').set('x-internal-service-secret', SECRET).send({ ...body(), selection: { ...selection(), scheduleBinding: null } }).expect(400);
      expect(f.state.calls).toEqual([]); expect(f.state.writes).toEqual([]);
    } finally { await app.close(); }
  });

  it('reads the caller-visible pins back from the stored row and keeps the tenant wall', async () => {
    const f = fixture();
    const renewed = await f.service.consentRenew(f.req, f.ctx, body());
    expect(renewed.generation).toBe(GEN);
    expect(f.state.tenants).toEqual([TENANT]);
    // A row of another tenant is invisible even when the caller supplies its bytes.
    const foreign = fixture();
    foreign.state.rows = [{ ...consentRow(), tenantId: FOREIGN }];
    await expect(foreign.service.consentRenew(foreign.req, foreign.ctx, body())).rejects.toBeInstanceOf(ForbiddenException);
    expect(foreign.state.writes).toEqual([]);
  });
});
