/**
 * MR-04 visibility half — the mounted read-only consent observation.
 *
 * These specs exercise the REAL mounted controller route (global prefix, real
 * `InternalServiceGuard`, real service method, real helper) as well as the
 * service method directly; a helper-only checkpoint would not prove the route
 * exists, is protected the same way the other internal routines reads are, or
 * that the caller's body actually reaches the observation.
 *
 * Synthetic rows and a fake transaction only: no DATABASE_URL, no live schema
 * read, no browser, network, provider or model.
 */
import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ForbiddenException } from '@nestjs/common';
import { InternalServiceGuard } from '../../auth/internal-service.guard.js';
import { RetainedReadDispatcher } from '../retained-read-dispatch.js';
import { MeriRoutineReadController } from './meri-routines.controller.js';
import { MeriRoutinesService } from './meri-routines.service.js';
import type { RoutineConsentObservation } from './meri-routine-consent-observation.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const TENANT = id(1), OWNER = id(2), SCHEDULE = id(3), OTHER_OWNER = id(4), CLIENT_A = id(5), CLIENT_B = id(6);
const GEN = 4, NOW = 5_000_000;
const INTENT = 'a'.repeat(64), PROJECTION = 'b'.repeat(64), OTHER_INTENT = 'c'.repeat(64), OTHER_PROJECTION = 'd'.repeat(64);
const scope = (kind: string, resourceId: string) => ({ tenantId: TENANT, kind, resourceId, policyRevision: 'policy-1' });
const body = {
  schemaVersion: 1, tenantId: TENANT, ownerActorId: OWNER, scheduleId: SCHEDULE,
  generation: GEN, intentSha256: INTENT, projectionSha256: PROJECTION,
};

interface ConsentRow {
  tenantId: string; ownerUserId: string; scheduleId: string;
  generation: number; intentSha256: string; projectionSha256: string; scopes: unknown[];
  issuedAt: Date; expiresAt: Date;
}

const consentRow = (patch: Partial<ConsentRow> = {}): ConsentRow => ({
  tenantId: TENANT, ownerUserId: OWNER, scheduleId: SCHEDULE,
  generation: GEN, intentSha256: INTENT, projectionSha256: PROJECTION,
  scopes: [scope('client', CLIENT_A), scope('client', CLIENT_B)],
  issuedAt: new Date(NOW - 100_000), expiresAt: new Date(NOW + 100_000), ...patch,
});

interface State {
  now: number; rows: ConsentRow[]; approvalOwner: string | null; revokedAt: number | null;
  member: { role: string; status: string; tenantStatus: string } | null;
  visibleClients: string[] | null; clockFails: boolean; consentReadFails: boolean;
  calls: string[]; writes: string[]; tenants: string[];
}

const fixture = () => {
  const state: State = {
    now: NOW, rows: [consentRow()], approvalOwner: OWNER, revokedAt: null,
    member: { role: 'standard_user', status: 'active', tenantStatus: 'active' },
    visibleClients: null, clockFails: false, consentReadFails: false, calls: [], writes: [], tenants: [],
  };
  // The tenant wall this observation must stay inside: rows of another tenant are never visible.
  const inTenant = (args: { where?: { tenantId?: string } }) => args?.where?.tenantId === TENANT;
  // The real owner filter, including the owner wall's `not` form; an emulated-but-ignored
  // filter would let the owner wall pass here and fail against a real database.
  const ownerMatches = (filter: unknown, owner: string) => (filter === undefined || (typeof filter === 'object' && filter !== null
    ? (filter as { not?: string }).not === undefined || owner !== (filter as { not?: string }).not : owner === filter));
  const write = (name: string) => jest.fn(async () => { state.writes.push(name); return {}; });
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
        const visible = ids.filter((clientId) => state.visibleClients === null || state.visibleClients.includes(clientId));
        return visible.map((clientId) => ({ id: clientId }));
      }
      throw new Error(`unexpected sql: ${sql}`);
    }),
    clioMeriRoutineApproval: {
      findFirst: jest.fn(async (args: { where?: { tenantId?: string; ownerUserId?: unknown } }) =>
        (inTenant(args) && state.approvalOwner !== null && ownerMatches(args?.where?.ownerUserId, state.approvalOwner)
          ? { ownerUserId: state.approvalOwner } : null)),
      create: write('approval.create'),
    },
    clioMeriRoutineConsent: {
      // Applies the filters this module really sends (owner, schedule and the three pins);
      // a mock that ignored them would answer from an unrelated row.
      findFirst: jest.fn(async (args: { where?: Record<string, unknown> }) => {
        if (!inTenant(args)) return null;
        if (state.consentReadFails) throw new Error('consent read unavailable');
        const where = args?.where ?? {};
        const matching = state.rows.filter((row) => row.tenantId === where.tenantId && row.scheduleId === where.scheduleId &&
          ownerMatches(where.ownerUserId, row.ownerUserId) &&
          (where.generation === undefined || row.generation === where.generation) &&
          (where.intentSha256 === undefined || row.intentSha256 === where.intentSha256) &&
          (where.projectionSha256 === undefined || row.projectionSha256 === where.projectionSha256));
        const [found] = [...matching].sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
        return found === undefined ? null : { id: id(90), intentId: id(91), decisionSha256: 'e'.repeat(64), ...found };
      }),
      createMany: write('consent.createMany'), updateMany: write('consent.updateMany'), deleteMany: write('consent.deleteMany'),
    },
    clioMeriRoutineConsentRevocation: {
      // Applies the real predicate: the query's `revokedAt >= consent.issuedAt` is emulated, not ignored.
      findFirst: jest.fn(async (args: { where?: { tenantId?: string; revokedAt?: { gte?: Date } } }) => {
        if (!inTenant(args) || state.revokedAt === null) return null;
        const since = args?.where?.revokedAt?.gte;
        if (since instanceof Date && state.revokedAt < since.getTime()) return null;
        return { revokedAt: new Date(state.revokedAt) };
      }),
      createMany: write('revocation.createMany'),
    },
    tenantMembership: {
      findFirst: jest.fn(async (args: never) => (!inTenant(args) || state.member === null ? null : { tenantId: TENANT, userId: OWNER,
        role: state.member.role, status: state.member.status, tenant: { status: state.member.tenantStatus } })),
      update: write('membership.update'),
    },
  };
  const prisma: any = { withTenant: jest.fn(async (tenant: string, fn: (client: unknown) => unknown) => {
    state.tenants.push(tenant);
    return fn(tx);
  }) };
  const service = new MeriRoutinesService(prisma, { get: () => 'synthetic-test-secret' } as never, null, null);
  const req: any = Object.assign(new EventEmitter(), { headers: { 'x-internal-service-secret': 'synthetic-test-secret' } });
  new InternalServiceGuard({ get: () => 'synthetic-test-secret' } as never)
    .canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as never);
  return { state, tx, service, req, dispatcher: { dispatch: jest.fn() } as never };
};

describe('Mer04 routine read-consent observation (read-only)', () => {
  it('mounts the route behind the existing internal service guard and no other protection', async () => {
    const f = fixture(), module = await Test.createTestingModule({ controllers: [MeriRoutineReadController], providers: [
      InternalServiceGuard, { provide: ConfigService, useValue: { get: () => 'synthetic-test-secret' } },
      { provide: MeriRoutinesService, useValue: f.service }, { provide: RetainedReadDispatcher, useValue: f.dispatcher },
    ] }).compile();
    const app = module.createNestApplication(); app.setGlobalPrefix('api'); await app.init();
    try {
      await request(app.getHttpServer()).post('/api/internal/routines/consent').send(body).expect(403);
      expect(f.state.calls).toEqual([]);
      const observed = await request(app.getHttpServer()).post('/api/internal/routines/consent')
        .set('x-internal-service-secret', 'synthetic-test-secret').send(body).expect(200);
      expect(observed.body).toMatchObject({ schemaVersion: 1, state: 'active', pinsMatched: true, generation: GEN,
        consentGeneration: GEN, observedAtMs: NOW, cause: null });
      expect(observed.body.scopeCount).toBe(2);
      expect(f.state.calls).toEqual(['lock', 'clock', 'clients']);
      await request(app.getHttpServer()).post('/api/internal/routines/consent')
        .set('x-internal-service-secret', 'synthetic-test-secret').send({ ...body, scopes: [scope('client', CLIENT_B)] }).expect(400);
      await request(app.getHttpServer()).post('/api/internal/routines/consent')
        .set('x-internal-service-secret', 'synthetic-test-secret').send({ ...body, tenantId: 'A0B1C2D3-0000-4000-8000-000000000000' }).expect(400);
    } finally { await app.close(); }
  });

  it('answers active only from the matched current generation, without any consent payload or identity', async () => {
    const f = fixture(), observed: RoutineConsentObservation = await f.service.consentObservation(body, f.req);
    expect(Object.keys(observed).sort()).toEqual(['cause', 'consentGeneration', 'expiresAtMs', 'generation', 'issuedAtMs',
      'observedAtMs', 'pinsMatched', 'rightsSha256', 'schemaVersion', 'scopeCount', 'state']);
    expect(observed).toEqual({ schemaVersion: 1, state: 'active', pinsMatched: true, observedAtMs: NOW, generation: GEN,
      consentGeneration: GEN, issuedAtMs: NOW - 100_000, expiresAtMs: NOW + 100_000, scopeCount: 2, cause: null,
      rightsSha256: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown as string });
    expect(f.state.calls).toEqual(['lock', 'clock', 'clients']);
  });

  it('reports expired for a consent whose window closed while the owner still holds it', async () => {
    const f = fixture();
    f.state.rows = [consentRow({ expiresAt: new Date(NOW), issuedAt: new Date(NOW - 200_000) })];
    const observed = await f.service.consentObservation(body, f.req);
    expect(observed).toMatchObject({ state: 'expired', pinsMatched: true, cause: null, rightsSha256: null, scopeCount: 2,
      issuedAtMs: NOW - 200_000, expiresAtMs: NOW });
    expect(f.state.calls).toEqual(['lock', 'clock']);
  });

  it('never reports a row that does not pin the request as active, and names the row it found instead', async () => {
    const f = fixture();
    f.state.rows = [consentRow({ generation: GEN - 1, intentSha256: OTHER_INTENT, projectionSha256: OTHER_PROJECTION })];
    expect(await f.service.consentObservation(body, f.req)).toMatchObject({ state: 'absent', pinsMatched: false,
      consentGeneration: GEN - 1, cause: null, rightsSha256: null });
    f.state.rows = [consentRow({ projectionSha256: OTHER_PROJECTION })];
    expect(await f.service.consentObservation(body, f.req)).toMatchObject({ state: 'absent', pinsMatched: false, consentGeneration: GEN });
    // The named row is diagnosis only: an absence for these pins carries its window and
    // count, never its state, and never runs the rights check for it.
    expect(await f.service.consentObservation(body, f.req)).toEqual({ schemaVersion: 1, state: 'absent', pinsMatched: false,
      observedAtMs: NOW, generation: GEN, consentGeneration: GEN, issuedAtMs: NOW - 100_000, expiresAtMs: NOW + 100_000,
      scopeCount: 2, cause: null, rightsSha256: null });
    expect(f.state.calls.filter((call) => call === 'clients')).toEqual([]);
  });

  it('answers from the unexpired row that pins the request even when a newer row carries other pins', async () => {
    const f = fixture();
    // The canonical reader and the firing grant select by generation and projection, not
    // by recency: the row that pins this request governs, so a newer row for other pins
    // is neither this request's consent nor a reason to call it absent.
    f.state.rows = [consentRow({ issuedAt: new Date(NOW - 300_000) }), consentRow({ generation: GEN - 1, issuedAt: new Date(NOW - 10_000) })];
    expect(await f.service.consentObservation(body, f.req)).toMatchObject({ state: 'active', pinsMatched: true,
      consentGeneration: GEN, issuedAtMs: NOW - 300_000, expiresAtMs: NOW + 100_000 });
    // Two rows pinning the request: the newest is the one the answer describes.
    f.state.rows = [consentRow({ issuedAt: new Date(NOW - 10_000) }), consentRow({ issuedAt: new Date(NOW - 300_000) })];
    expect(await f.service.consentObservation(body, f.req)).toMatchObject({ state: 'active', pinsMatched: true, issuedAtMs: NOW - 10_000 });
    // A pinned row that lapsed is still expired against these pins, never absent.
    f.state.rows = [consentRow({ expiresAt: new Date(NOW - 1) }), consentRow({ generation: GEN - 1, issuedAt: new Date(NOW - 10_000) })];
    expect(await f.service.consentObservation(body, f.req)).toMatchObject({ state: 'expired', pinsMatched: true });
  });

  it('reports absent when this owner has no consent row for the schedule', async () => {
    const f = fixture();
    f.state.rows = [];
    expect(await f.service.consentObservation(body, f.req)).toEqual({ schemaVersion: 1, state: 'absent', pinsMatched: false,
      observedAtMs: NOW, generation: GEN, consentGeneration: null, issuedAtMs: null, expiresAtMs: null, scopeCount: null,
      cause: null, rightsSha256: null });
    f.state.approvalOwner = null;
    expect((await f.service.consentObservation(body, f.req)).state).toBe('absent');
  });

  it('reports revoked for an attended pause/delete at or after the consent, and ignores an earlier one', async () => {
    const f = fixture();
    f.state.revokedAt = NOW - 100_000;
    expect(await f.service.consentObservation(body, f.req)).toMatchObject({ state: 'revoked', pinsMatched: true, cause: 'revocation' });
    f.state.revokedAt = NOW - 100_001;
    expect(await f.service.consentObservation(body, f.req)).toMatchObject({ state: 'active', cause: null });
    f.state.revokedAt = NOW;
    f.state.rows = [consentRow({ expiresAt: new Date(NOW - 1) })];
    expect(await f.service.consentObservation(body, f.req)).toMatchObject({ state: 'revoked', cause: 'revocation' });
  });

  it.each([null, { role: 'standard_user', status: 'active', tenantStatus: 'suspended' }, { role: 'viewer', status: 'active', tenantStatus: 'active' }])(
    'reports revoked when the owner membership no longer carries the original rights (%s)', async (member) => {
      const f = fixture();
      f.state.member = member as never;
      expect(await f.service.consentObservation(body, f.req)).toMatchObject({ state: 'revoked', pinsMatched: true, cause: 'membership' });
      expect(f.state.calls).toEqual(['lock', 'clock']);
    });

  it('reports revoked when any original client scope left the owner client wall', async () => {
    const f = fixture();
    f.state.visibleClients = [CLIENT_A];
    expect(await f.service.consentObservation(body, f.req)).toMatchObject({ state: 'revoked', cause: 'client-scope' });
    expect(f.state.calls).toEqual(['lock', 'clock', 'clients']);
    f.state.visibleClients = [CLIENT_A, CLIENT_B];
    expect((await f.service.consentObservation(body, f.req)).state).toBe('active');
  });

  it('refuses a matched row whose saved scopes lost this tenant or were issued in the future', async () => {
    const f = fixture();
    f.state.rows = [consentRow({ scopes: [scope('client', CLIENT_A), { ...scope('client', CLIENT_B), tenantId: id(77) }] })];
    await expect(f.service.consentObservation(body, f.req)).rejects.toThrow();
    f.state.rows = [consentRow({ issuedAt: new Date(NOW + 1) })];
    await expect(f.service.consentObservation(body, f.req)).rejects.toThrow();
    f.state.rows = [consentRow({ scopes: [] })];
    await expect(f.service.consentObservation(body, f.req)).rejects.toThrow();
    expect(f.state.writes).toEqual([]);
  });

  it('refuses a foreign owner claim for a schedule Core recorded under another owner', async () => {
    const f = fixture();
    f.state.approvalOwner = OTHER_OWNER;
    await expect(f.service.consentObservation(body, f.req)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.state.calls).toEqual(['lock', 'clock']);
    f.state.approvalOwner = OWNER;
    expect((await f.service.consentObservation(body, f.req)).state).toBe('active');
  });

  it('refuses a foreign owner claim from the stored consent alone, with no approval row at all', async () => {
    const f = fixture();
    // The schedule carries another owner's legitimate current consent and Core holds no
    // cancel approval for it. The wall is the schedule's own consent identity, so this is
    // a foreign request — never this caller's absence, and never answered as one.
    f.state.approvalOwner = null;
    f.state.rows = [{ ...consentRow(), ownerUserId: OTHER_OWNER }];
    await expect(f.service.consentObservation(body, f.req)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.state.calls).toEqual(['lock', 'clock']);
    expect(f.state.writes).toEqual([]);
    // Once the schedule's stored consent is this owner's, and only then, it answers.
    f.state.rows = [{ ...consentRow(), ownerUserId: OWNER }];
    expect((await f.service.consentObservation(body, f.req)).state).toBe('active');
    // The negative (`not`) owner filter is what makes that wall deterministic; a plain
    // owner equality would depend on whichever row the database happened to return.
    expect(f.state.calls).toEqual(['lock', 'clock', 'lock', 'clock', 'clients']);
  });

  it('stays inside the requested tenant and can never report another tenant rows', async () => {
    const f = fixture();
    const foreign = { ...body, tenantId: id(77) };
    expect(await f.service.consentObservation(foreign, f.req)).toEqual({ schemaVersion: 1, state: 'absent', pinsMatched: false,
      observedAtMs: NOW, generation: GEN, consentGeneration: null, issuedAtMs: null, expiresAtMs: null, scopeCount: null,
      cause: null, rightsSha256: null });
    // Scoped through the requested tenant only, and the other tenant's rows stay invisible.
    expect(f.state.tenants).toEqual([id(77)]);
    expect(f.state.calls).toEqual(['lock', 'clock']);
    expect((await f.service.consentObservation(body, f.req)).state).toBe('active');
  });

  it.each([
    ['scopes', { scopes: [scope('client', CLIENT_B)] }],
    ['clientId', { clientId: CLIENT_B }],
    ['selector', { selector: { kind: 'client', entityId: CLIENT_B } }],
    ['tenantId', { tenantId: 'not-a-uuid' }],
    ['ownerActorId', { ownerActorId: 'A0B1C2D3-0000-4000-8000-000000000000' }],
    ['scheduleId', { scheduleId: SCHEDULE.slice(0, 8) }],
    ['generation', { generation: 0 }],
    ['generation', { generation: 1.5 }],
    ['intentSha256', { intentSha256: INTENT.toUpperCase() }],
    ['projectionSha256', { projectionSha256: 'b'.repeat(63) }],
    ['schemaVersion', { schemaVersion: 2 }],
  ])('rejects a caller-supplied %s instead of letting it widen or misstate the approved scope', async (_field, patch) => {
    const f = fixture();
    await expect(f.service.consentObservation({ ...body, ...patch }, f.req)).rejects.toThrow();
    const { projectionSha256: _dropped, ...missing } = body;
    await expect(f.service.consentObservation(missing, f.req)).rejects.toThrow();
    await expect(f.service.consentObservation(null, f.req)).rejects.toThrow();
    expect(f.state.calls).toEqual([]);
    expect(f.state.writes).toEqual([]);
  });

  it('never converts an unavailable clock, consent read or client wall into a fabricated absence', async () => {
    const f = fixture();
    f.state.clockFails = true;
    await expect(f.service.consentObservation(body, f.req)).rejects.toThrow();
    f.state.clockFails = false; f.state.consentReadFails = true;
    await expect(f.service.consentObservation(body, f.req)).rejects.toThrow();
    f.state.consentReadFails = false;
    f.tx.$queryRaw = jest.fn(async (strings: readonly string[]) => {
      if (strings.join('?').includes('clock_timestamp')) return [{ db_now: 'not-a-date' }];
      return [];
    });
    await expect(f.service.consentObservation(body, f.req)).rejects.toThrow();
  });

  it('writes nothing on any answered path', async () => {
    const f = fixture();
    const observe = () => f.service.consentObservation(body, f.req);
    expect((await observe()).state).toBe('active');
    f.state.rows = [];
    expect((await observe()).state).toBe('absent');
    f.state.rows = [consentRow({ expiresAt: new Date(NOW - 1) })];
    expect((await observe()).state).toBe('expired');
    f.state.rows = [consentRow({ generation: GEN - 1 })];
    expect((await observe()).state).toBe('absent');
    f.state.rows = [consentRow()]; f.state.revokedAt = NOW; f.state.visibleClients = [CLIENT_A];
    expect((await observe()).state).toBe('revoked');
    expect(f.state.writes).toEqual([]);
    expect(f.state.calls).toEqual(['lock', 'clock', 'clients', 'lock', 'clock', 'lock', 'clock', 'lock', 'clock', 'lock', 'clock']);
  });
});
