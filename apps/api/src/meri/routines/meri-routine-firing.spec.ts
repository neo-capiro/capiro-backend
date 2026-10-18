import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash, generateKeyPairSync, verify as nodeVerify, type KeyObject } from 'node:crypto';
import { BadRequestException, ForbiddenException, ServiceUnavailableException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { createInProcessEd25519Signer } from '../../auth/core-ed25519-signer.js';
import { isMeriRoutineUnattendedGrantPost } from '../../auth/meri-execution-request.js';
import { nativeCanonicalSha256 } from '../native-approvals/native-approval.contract.js';
import { ROUTINE_FIRE_AUDIENCE, ROUTINE_FIRE_TOKEN_TYPE, routineConsentEvent } from './meri-routine-firing.js';
import { MeriRoutinesService } from './meri-routines.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const otherActor = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const scheduleId = '66666666-6666-4666-8666-666666666666';
const intentId = '77777777-7777-4777-8777-777777777777';
const revision = 'a'.repeat(64);
const SECRET = 'synthetic-service-secret';
const LIMITS = { maxCostMicrousd: 2_000_000, maxRuntimeSeconds: 900, retryLimit: 0 };
const principal = { tenantId, actorId };
const scopes = [{ tenantId, kind: 'client', resourceId: clientId, policyRevision: revision }];
const binding = {
  tenantId, actorId, conversationId: '88888888-8888-4888-8888-888888888888', runId: '99999999-9999-4999-8999-999999999999',
  attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', writerFence: 2,
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
afterEach(() => { delete process.env.MERI_ROUTINE_MAX_COST_MICROUSD; delete process.env.MERI_ROUTINE_MAX_RUNTIME_SECONDS; });

function projection(overrides: Record<string, unknown> = {}) {
  return {
    scheduleId, owner: principal, temporalScheduleId: `routines/${scheduleId}`, timezone: 'America/New_York', scopes, state: 'active',
    maxCostMicrousd: 1_000_000, maxRuntimeSeconds: 600, retryLimit: 0, destinationId: 'meri-inbox', createdAt: '2026-10-18T06:00:00.000Z',
    ...overrides,
  };
}
function intent(operation = 'schedule_task', overrides: Record<string, unknown> = {}) {
  return {
    intentId, operation, expectedGeneration: 0, generation: 1, previousProjectionSha256: null, projection: projection(),
    configuration: { policy: { paused: false } }, cancel: null, ...overrides,
  };
}
function approval(i: Record<string, unknown>, now: number, overrides: Record<string, unknown> = {}) {
  return {
    proposalId: i.intentId, commandSha256: nativeCanonicalSha256(i), decision: 'approved',
    decidedAt: new Date(now - 10_000).toISOString(), expiresAt: new Date(now + 600_000).toISOString(),
    approver: principal, policyRevision: revision, ...overrides,
  };
}
function scheduleBinding(i: Record<string, unknown>, now: number, approvalOverrides: Record<string, unknown> = {}) {
  const call = { intent: i, approval: approval(i, now, approvalOverrides), callerIdentity: principal, deadlineMs: now + 30_000 };
  return { ...call, bindingSha256: nativeCanonicalSha256(call) };
}
function selection(operation: string, sb: unknown, phase = 'before_claim') {
  return {
    phase, operation, request: operation === 'cancel_scheduled_task'
      ? { scheduleId, mode: 'pause', note: 'stop', running: 'request_cancel', runs: [] }
      : { taskInstruction: 'Summarize hearings', policy: { paused: false }, destinationReference: 'meri-inbox',
        requestedLimits: { maxCostMicrousd: 1_000_000, maxRuntimeSeconds: 600, retryLimit: 0 }, ...(operation === 'update_scheduled_task' ? { scheduleId } : {}) },
    currentSchedule: null, proposal: null, current: { binding, scopes, selectedClientId: clientId }, scheduleBinding: sb,
  };
}

/** Port of Meri `routines-firing-grant.mjs` `verifyRoutineFiringGrant` (11b90c7f); Meri's own code is run in the cross-check. */
function meriVerifyFire(token: string, trust: { issuer: string; kid: string; key: KeyObject }, nowMs: number) {
  const [h, p, sig] = token.split('.');
  if (Buffer.from(h!, 'base64url').toString() !== JSON.stringify({ alg: 'EdDSA', typ: ROUTINE_FIRE_TOKEN_TYPE, kid: trust.kid })) throw new Error('header');
  if (!nodeVerify(null, Buffer.from(`${h}.${p}`, 'ascii'), trust.key, Buffer.from(sig!, 'base64url'))) throw new Error('signature');
  const text = Buffer.from(p!, 'base64url').toString('utf8');
  const v = JSON.parse(text);
  if (canonicalizeCoreRetainedJson(v) !== text || Object.keys(v).sort().join() !== 'aud,exp,fire,iat,iss,jti,nbf') throw new Error('payload');
  const now = Math.floor(nowMs / 1000);
  if (v.iss !== trust.issuer || v.aud !== ROUTINE_FIRE_AUDIENCE || v.nbf !== v.iat || v.iat > now || v.exp <= now || v.exp - v.iat > 30) throw new Error('time');
  const c = v.fire;
  if (Object.keys(c).sort().join() !== ['consentExpiresAtS', 'consentId', 'consentIssuedAtS', 'generation', 'intentSha256', 'limits', 'membershipRevision',
    'occurrenceKey', 'ownerActorId', 'phase', 'projectionSha256', 'scheduleId', 'scopes', 'tenantId'].join()) throw new Error('claims');
  if (c.consentExpiresAtS - c.consentIssuedAtS > 30 * 86400 || v.exp > c.consentExpiresAtS) throw new Error('consent');
  if (Object.keys(c.limits).sort().join() !== 'maxCostMicrousd,maxRuntimeSeconds,retryLimit') throw new Error('limits');
  return v;
}

function verifiedRequest(verified = true): Request {
  const req = { headers: { 'x-internal-service-secret': verified ? SECRET : 'wrong' }, method: 'POST', path: '/x' } as unknown as Request;
  new ToolServiceSecretGuard({ get: (k: string) => (k === 'NODE_ENV' ? 'development' : k === 'INTERNAL_SERVICE_SECRET' ? SECRET : false) } as never)
    .canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext);
  return req;
}

function world(options: { withFireSigner?: boolean } = {}) {
  const state = {
    consents: [] as Array<Record<string, any>>,
    revocations: [] as Array<Record<string, any>>,
    grants: [] as Array<Record<string, any>>,
    membership: { id: 'm1', tenantId, userId: actorId, status: 'active', role: 'standard_user', tenant: { status: 'active' } } as Record<string, any> | null,
    visible: true,
    clockShiftMs: 0,
    signed: 0,
  };
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('pg_advisory_xact_lock')) return [{ locked: '' }];
      if (sql.includes('clock_timestamp() AS db_now')) return [{ db_now: new Date(Date.now() + state.clockShiftMs) }];
      if (sql.includes('FROM clients')) return state.visible ? (values[1] as string[]).map((id) => ({ id })) : [];
      throw new Error(`unexpected SQL ${sql}`);
    }),
    clioMeriRoutineConsent: {
      createMany: jest.fn(async ({ data }: any) => {
        for (const row of data) if (!state.consents.some((c) => c.intentId === row.intentId && c.decisionSha256 === row.decisionSha256)) state.consents.push(clone(row));
        return { count: 1 };
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const rows = (state.consents.map((c) => ({ ...c, issuedAt: new Date(c.issuedAt), expiresAt: new Date(c.expiresAt) })) as Array<Record<string, any>>)
          .filter((c) => c.tenantId === where.tenantId && c.ownerUserId === where.ownerUserId && c.scheduleId === where.scheduleId &&
            c.generation === where.generation && c.intentSha256 === where.intentSha256 && c.projectionSha256 === where.projectionSha256 &&
            c.expiresAt > where.expiresAt.gt)
          .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
        return rows[0] ?? null;
      }),
    },
    clioMeriRoutineConsentRevocation: {
      createMany: jest.fn(async ({ data }: any) => { for (const row of data) if (!state.revocations.some((r) => r.intentId === row.intentId)) state.revocations.push(row); return { count: 1 }; }),
      findFirst: jest.fn(async ({ where }: any) => state.revocations.find((r) => r.scheduleId === where.scheduleId && r.revokedAt >= where.revokedAt.gte) ?? null),
    },
    clioMeriRoutineFireGrant: { create: jest.fn(async ({ data }: any) => { expect(state.signed).toBe(0); state.grants.push(data); return data; }) },
    tenantMembership: { findFirst: jest.fn(async () => (state.membership ? { ...state.membership } : null)) },
  };
  const prisma = {
    withTenant: jest.fn(async (_t: string, fn: (t: typeof tx) => unknown) => fn(tx)),
    withTenantUser: jest.fn(async (_t: string, _u: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const membershipService = { read: jest.fn(async () => ({ tenantId, actorId, clientIds: [clientId], expiresAtMs: Date.now() + 50_000 })) };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const inner = createInProcessEd25519Signer({ issuer: 'capiro-core:routine-fire:v1', kid: 'routine-fire-synthetic-1', privateKey });
  const fireSigner = { issuer: inner.issuer, kid: inner.kid, sign: async (m: Buffer) => { state.signed++; const out = await inner.sign(m, {}); state.signed = 0; return out; } };
  const service = new MeriRoutinesService(prisma as never, membershipService as never, null, options.withFireSigner === false ? null : fireSigner as never);
  const trust = { issuer: inner.issuer, kid: inner.kid, key: publicKey };
  return { state, service, trust };
}
const ctx = { tenantId, userId: actorId } as TenantContext;
const body = (s: Record<string, unknown>) => ({ selection: s, selectionSha256: nativeCanonicalSha256(s) });
function fireRequest(overrides: Record<string, unknown> = {}) {
  const i = intent();
  return {
    tenantId, ownerActorId: actorId, scheduleId, generation: 1, intentSha256: nativeCanonicalSha256(i),
    projectionSha256: nativeCanonicalSha256(i.projection), occurrenceKey: 'e'.repeat(64), phase: 'before_admission', ...overrides,
  };
}
async function consent(w: ReturnType<typeof world>, now = Date.now()) {
  process.env.MERI_ROUTINE_MAX_COST_MICROUSD = '2000000';
  process.env.MERI_ROUTINE_MAX_RUNTIME_SECONDS = '900';
  return w.service.policyCheck(verifiedRequest(), ctx, body(selection('schedule_task', scheduleBinding(intent(), now))));
}

describe('routine consent from the attended Execute (wire A before_claim)', () => {
  const now = Date.now();
  const event = (s: Record<string, unknown>, limits: typeof LIMITS | null = LIMITS) =>
    routineConsentEvent({ selection: s, principal, scopes, limits, nowMs: now });

  it('derives the consent from the approved intent, its projection and the approval', () => {
    const i = intent();
    const e = event(selection('schedule_task', scheduleBinding(i, now)));
    expect(e).toEqual({ kind: 'consent', consent: {
      scheduleId, intentId, generation: 1, intentSha256: nativeCanonicalSha256(i), projectionSha256: nativeCanonicalSha256(i.projection),
      decisionSha256: nativeCanonicalSha256(approval(i, now)), scopes, limits: { maxCostMicrousd: 1_000_000, maxRuntimeSeconds: 600, retryLimit: 0 },
      policyRevision: revision,
    } });
    expect(event(selection('schedule_task', null))).toBeNull();
    expect(event(selection('schedule_task', scheduleBinding(i, now), 'resolve'))).toBeNull();
    expect(event(selection('list_scheduled_tasks', scheduleBinding(i, now)))).toBeNull();
  });

  it('turns an attended pause/delete, or an update to a non-active projection, into a revocation', () => {
    const pause = intent('cancel_scheduled_task', { cancel: { mode: 'pause', note: 'n', running: 'request_cancel', runs: [] } });
    expect(event(selection('cancel_scheduled_task', scheduleBinding(pause, now)))).toEqual({ kind: 'revoke', scheduleId, intentId, reason: 'paused' });
    const del = intent('cancel_scheduled_task', { cancel: { mode: 'delete', note: 'n', running: 'request_cancel', runs: [] } });
    expect(event(selection('cancel_scheduled_task', scheduleBinding(del, now)))).toMatchObject({ kind: 'revoke', reason: 'deleted' });
    const paused = intent('update_scheduled_task', { projection: projection({ state: 'paused' }) });
    expect(event(selection('update_scheduled_task', scheduleBinding(paused, now)))).toMatchObject({ kind: 'revoke', reason: 'paused' });
  });

  it.each([
    ['a binding digest that is not the call', () => ({ ...scheduleBinding(intent(), now), bindingSha256: 'f'.repeat(64) })],
    ['an approval by another actor', () => scheduleBinding(intent(), now, { approver: { tenantId, actorId: otherActor } })],
    ['an expired approval', () => scheduleBinding(intent(), now, { expiresAt: new Date(now - 1).toISOString() })],
    ['an approval of another intent', () => scheduleBinding(intent(), now, { commandSha256: 'f'.repeat(64) })],
    ['another owner', () => scheduleBinding(intent('schedule_task', { projection: projection({ owner: { tenantId, actorId: otherActor } }) }), now)],
    ['other scopes than the attended context', () => scheduleBinding(intent('schedule_task', { projection: projection({ scopes: [{ ...scopes[0], resourceId: '55555555-5555-4555-8555-555555555555' }] }) }), now)],
    ['limits above the configured maxima', () => scheduleBinding(intent('schedule_task', { projection: projection({ maxCostMicrousd: 2_000_001 }) }), now)],
  ] as Array<[string, () => unknown]>)('refuses %s', (_label, make) => {
    expect(() => event(selection('schedule_task', make()))).toThrow(ForbiddenException);
  });

  it('records the consent once (<= 30 days) and the revocation through the policy check', async () => {
    const w = world();
    const at = Date.now();
    await consent(w, at);
    await consent(w, at); // the same approval replayed: one consent
    expect(w.state.consents).toHaveLength(1);
    const c = w.state.consents[0]!;
    expect(new Date(c.expiresAt).getTime() - new Date(c.issuedAt).getTime()).toBe(30 * 86_400_000);
    expect(c).toMatchObject({ tenantId, ownerUserId: actorId, scheduleId, generation: 1, intentId });
    const pause = intent('cancel_scheduled_task', { cancel: { mode: 'pause', note: 'n', running: 'request_cancel', runs: [] } });
    await w.service.policyCheck(verifiedRequest(), ctx, body(selection('cancel_scheduled_task', scheduleBinding(pause, Date.now()))));
    expect(w.state.revocations).toEqual([expect.objectContaining({ scheduleId, reason: 'paused', revokedByUserId: actorId })]);
  });
});

describe('unattended firing grant (wire C, POST /api/clio/routines/unattended-grant)', () => {
  it("issues a grant Meri's verifier accepts, bound to the consent, ledger first", async () => {
    const w = world();
    await consent(w);
    const out = await w.service.unattendedGrant(verifiedRequest(), fireRequest());
    expect(Object.keys(out)).toEqual(['grant', 'jti', 'expiresAtMs']);
    const v = meriVerifyFire(out.grant, w.trust, Date.now());
    expect(v.jti).toBe(out.jti);
    expect(out.expiresAtMs).toBe(v.exp * 1000);
    expect(v.fire).toMatchObject({ ...fireRequest(), scopes, consentId: w.state.consents[0]!.consentId,
      limits: { maxCostMicrousd: 1_000_000, maxRuntimeSeconds: 600, retryLimit: 0 } });
    expect(v.exp - v.iat).toBeLessThanOrEqual(30);
    expect(w.state.grants).toEqual([expect.objectContaining({ jti: out.jti, consentId: w.state.consents[0]!.consentId, phase: 'before_admission' })]);
  });

  it('refuses without consent, after a pause, after membership or wall loss, past the consent, or for another generation', async () => {
    const cases: Array<[string, (w: ReturnType<typeof world>) => Promise<unknown>, unknown]> = [
      ['no consent', (w) => w.service.unattendedGrant(verifiedRequest(), fireRequest()), ForbiddenException],
      ['paused after consent', async (w) => { await consent(w); w.state.revocations.push({ scheduleId, intentId: 'x', revokedAt: new Date(Date.now() + 1) }); return w.service.unattendedGrant(verifiedRequest(), fireRequest()); }, ForbiddenException],
      ['membership lost', async (w) => { await consent(w); w.state.membership = null; return w.service.unattendedGrant(verifiedRequest(), fireRequest()); }, ForbiddenException],
      ['client wall changed', async (w) => { await consent(w); w.state.visible = false; return w.service.unattendedGrant(verifiedRequest(), fireRequest()); }, ForbiddenException],
      ['consent expired', async (w) => { await consent(w); w.state.clockShiftMs = 30 * 86_400_000 + 1; return w.service.unattendedGrant(verifiedRequest(), fireRequest()); }, ForbiddenException],
      ['another generation', async (w) => { await consent(w); return w.service.unattendedGrant(verifiedRequest(), fireRequest({ generation: 2 })); }, ForbiddenException],
      ['no service identity', async (w) => { await consent(w); return w.service.unattendedGrant(verifiedRequest(false), fireRequest()); }, ForbiddenException],
      ['a malformed body', async (w) => w.service.unattendedGrant(verifiedRequest(), { ...fireRequest(), extra: 1 }), BadRequestException],
      ['no firing key', async () => world({ withFireSigner: false }).service.unattendedGrant(verifiedRequest(), fireRequest()), ServiceUnavailableException],
    ];
    for (const [name, run, type] of cases) {
      const w = world();
      await expect(run(w)).rejects.toBeInstanceOf(type as never);
      expect({ name, grants: w.state.grants.length }).toEqual({ name, grants: 0 });
    }
  });

  it('still lets the owner\'s run stop (before_stop) after a pause or membership loss, inside the consent window', async () => {
    const w = world();
    await consent(w);
    w.state.revocations.push({ scheduleId, intentId: 'x', revokedAt: new Date(Date.now() + 1) });
    w.state.membership = null;
    const out = await w.service.unattendedGrant(verifiedRequest(), fireRequest({ phase: 'before_stop' }));
    expect(meriVerifyFire(out.grant, w.trust, Date.now()).fire.phase).toBe('before_stop');
  });

  it('is admitted by the tenant middleware only as an exact bearer-less POST', () => {
    const req = (path: string, extra: Record<string, unknown> = {}) =>
      ({ method: 'POST', path, originalUrl: path, headers: {}, ...extra }) as unknown as Request;
    expect(isMeriRoutineUnattendedGrantPost(req('/api/clio/routines/unattended-grant'))).toBe(true);
    expect(isMeriRoutineUnattendedGrantPost(req('/api/clio/routines/unattended-grant', { headers: { authorization: 'Bearer x' } }))).toBe(false);
    expect(isMeriRoutineUnattendedGrantPost(req('/api/clio/routines/unattended-grant', { method: 'GET' }))).toBe(false);
    expect(isMeriRoutineUnattendedGrantPost(req('/api/clio/routines/unattended-grant', { originalUrl: '/api/clio/routines/unattended-grant?x=1' }))).toBe(false);
    expect(isMeriRoutineUnattendedGrantPost(req('/api/clio/routines/policy/check'))).toBe(false);
    expect(createHash('sha256').update('x').digest('hex')).toHaveLength(64);
  });
});
