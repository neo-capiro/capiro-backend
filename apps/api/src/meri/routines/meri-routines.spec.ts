import { describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  type ExecutionContext,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { generateKeyPairSync } from 'node:crypto';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { createInProcessEd25519Signer } from '../../auth/core-ed25519-signer.js';
import { nativeCanonicalSha256 } from '../native-approvals/native-approval.contract.js';
import { ROUTINE_POLICY_LIMITS, decideRoutinePolicy } from './meri-routine-policy.js';
import {
  ROUTINE_CANCEL_MAX_TTL_SECONDS,
  cancellationCoversRun,
  checkApprovedCancellation,
  issueRoutineCancellationProof,
  verifyRoutineCancellationProof,
} from './meri-routine-cancellation-proof.js';
import { MeriRoutinesController } from './meri-routines.controller.js';
import { MeriRoutinesService } from './meri-routines.service.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const otherActor = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const otherClient = '55555555-5555-4555-8555-555555555555';
const scheduleId = '66666666-6666-4666-8666-666666666666';
const intentId = '77777777-7777-4777-8777-777777777777';
const revision = 'a'.repeat(64);
const NOW = Date.parse('2026-10-18T07:00:00.000Z');
const principal = { tenantId, actorId };
const membership = { tenantId, actorId, clientIds: [clientId], expiresAtMs: NOW + 50_000 };
const binding = {
  tenantId, actorId, conversationId: '88888888-8888-4888-8888-888888888888', runId: '99999999-9999-4999-8999-999999999999',
  attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', writerFence: 2,
};
const scopes = [{ tenantId, kind: 'client', resourceId: clientId, policyRevision: revision }];
const projection = {
  scheduleId, owner: principal, temporalScheduleId: `routines/${scheduleId}`, timezone: 'America/New_York', scopes, state: 'active',
  maxCostMicrousd: 1_000_000, maxRuntimeSeconds: 600, retryLimit: 0, destinationId: 'meri-inbox', createdAt: '2026-10-18T06:00:00.000Z',
};
const policy = { spec: { calendars: [{ hour: 7 }] }, overlap: 'skip', catchupWindowMs: 60000, pauseOnFailure: true, remainingActions: null, paused: false, note: 'n', runNow: false, runNowOverlap: 'skip' };
const requests: Record<string, unknown> = {
  schedule_task: { taskInstruction: 'Summarize hearings', policy, destinationReference: 'meri-inbox', requestedLimits: { maxCostMicrousd: 1_000_000, maxRuntimeSeconds: 600, retryLimit: 0 } },
  update_scheduled_task: { scheduleId, taskInstruction: 'Summarize hearings', policy, destinationReference: 'meri-inbox', requestedLimits: { maxCostMicrousd: 1_000_000, maxRuntimeSeconds: 600, retryLimit: 0 } },
  list_scheduled_tasks: { limit: 20 },
  cancel_scheduled_task: { scheduleId, mode: 'pause', note: 'stop', running: 'request_cancel', runs: [] },
};
function selection(operation: string, overrides: Record<string, unknown> = {}) {
  const currentSchedule = ['update_scheduled_task', 'cancel_scheduled_task'].includes(operation)
    ? { projection, generation: 3, projectionSha256: nativeCanonicalSha256(projection) } : null;
  return {
    phase: 'resolve', operation, request: clone(requests[operation]), currentSchedule, proposal: null,
    current: { binding, scopes, selectedClientId: clientId }, scheduleBinding: null, ...overrides,
  };
}
const body = (s: Record<string, unknown>) => ({ selection: s, selectionSha256: nativeCanonicalSha256(s) });

/** Oracle: Meri runtime-context.mjs policy() receipt checks (meri-greenfield 09781127). */
function meriAccepts(r: Record<string, unknown>, s: ReturnType<typeof selection>, started: number, now: number): boolean {
  const keys = ['authorized', 'selectionSha256', 'binding', 'scopes', 'selectedClientId', 'destinationResolution', 'limits', 'checkedAtMs', 'expiresAtMs'];
  const same = (a: unknown, b: unknown) => canonicalizeCoreRetainedJson(a) === canonicalizeCoreRetainedJson(b);
  if (Object.keys(r).length !== keys.length || keys.some((k) => !Object.hasOwn(r, k))) return false;
  if (r.authorized !== true || r.selectionSha256 !== nativeCanonicalSha256(s) || !same(r.binding, s.current.binding) || !same(r.scopes, s.current.scopes) ||
      r.selectedClientId !== s.current.selectedClientId || !Number.isSafeInteger(r.checkedAtMs) || (r.checkedAtMs as number) < started ||
      (r.checkedAtMs as number) > now || !Number.isSafeInteger(r.expiresAtMs) || (r.expiresAtMs as number) <= now) return false;
  if (['list_scheduled_tasks', 'cancel_scheduled_task'].includes(s.operation)) return r.destinationResolution === null && r.limits === null;
  const d = r.destinationResolution as Record<string, unknown>, l = r.limits as Record<string, number>;
  return Object.keys(d).length === 2 && d.reference === (s.request as { destinationReference: string }).destinationReference && d.destinationId === 'meri-inbox' &&
    Object.keys(l).length === 3 && ['maxCostMicrousd', 'maxRuntimeSeconds', 'retryLimit'].every((k) => Number.isSafeInteger(l[k]) && l[k]! >= (k === 'retryLimit' ? 0 : 1));
}

const decide = (s: Record<string, unknown>, o: Partial<{ principal: typeof principal; membership: typeof membership; body: unknown }> = {}) =>
  decideRoutinePolicy({ body: o.body ?? body(s), principal: o.principal ?? principal, membership: o.membership ?? membership, nowMs: NOW });

describe('Wire A — routine selection-policy receipt', () => {
  it.each(['schedule_task', 'update_scheduled_task', 'list_scheduled_tasks', 'cancel_scheduled_task'])("%s: passes Meri's own policy() receipt checks", (operation) => {
    const s = selection(operation);
    const receipt = decide(s);
    expect(meriAccepts(receipt as never, s, NOW, NOW)).toBe(true);
  });

  it('takes its limits from the pinned approved allocation and expires with the membership receipt or 30 s', () => {
    const receipt = decide(selection('schedule_task'));
    expect(receipt.limits).toEqual({ maxCostMicrousd: 2_000_000, maxRuntimeSeconds: 900, retryLimit: 0 });
    expect(ROUTINE_POLICY_LIMITS).toEqual(receipt.limits);
    expect(receipt.expiresAtMs).toBe(NOW + 30_000);
    expect(decide(selection('schedule_task'), { membership: { ...membership, expiresAtMs: NOW + 5_000 } }).expiresAtMs).toBe(NOW + 5_000);
  });

  it.each([
    ['another actor in the binding', selection('schedule_task', { current: { binding: { ...binding, actorId: otherActor }, scopes, selectedClientId: clientId } })],
    ['a foreign-tenant scope', selection('schedule_task', { current: { binding, scopes: [{ ...scopes[0], tenantId: 'f'.repeat(8) + '-1111-4111-8111-111111111111' }], selectedClientId: clientId } })],
    ['mixed policy revisions', selection('schedule_task', { current: { binding, scopes: [...scopes, { tenantId, kind: 'tenant', resourceId: tenantId, policyRevision: 'b'.repeat(64) }], selectedClientId: clientId } })],
    ['a client scope outside the membership', selection('schedule_task', { current: { binding, scopes: [{ ...scopes[0], resourceId: otherClient }], selectedClientId: null } })],
    ['a selected client outside the membership', selection('schedule_task', { current: { binding, scopes, selectedClientId: otherClient } })],
    ['another destination', selection('schedule_task', { request: { ...(requests.schedule_task as object), destinationReference: 'email' } })],
    ["another owner's schedule", selection('cancel_scheduled_task', { currentSchedule: (() => { const p = { ...projection, owner: { tenantId, actorId: otherActor } }; return { projection: p, generation: 3, projectionSha256: nativeCanonicalSha256(p) }; })() })],
  ] as Array<[string, Record<string, unknown>]>)('refuses %s', (_label, s) => {
    expect(() => decide(s)).toThrow(ForbiddenException);
  });

  it.each([
    ['a selection hash mismatch', { selection: selection('schedule_task'), selectionSha256: 'c'.repeat(64) }],
    ['an unknown selection key', body({ ...selection('schedule_task'), extra: 1 })],
    ['a request key set that is not the operation', body(selection('schedule_task', { request: requests.cancel_scheduled_task }))],
    ['a projection hash that is not its projection', body(selection('cancel_scheduled_task', { currentSchedule: { projection, generation: 3, projectionSha256: 'd'.repeat(64) } }))],
  ] as Array<[string, unknown]>)('rejects %s as malformed', (_label, raw) => {
    expect(() => decide(selection('schedule_task'), { body: raw })).toThrow(BadRequestException);
  });
});

const runs = [{ workflowId: `routines/${scheduleId}/occurrence-1`, runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }];
const intent = (overrides: Record<string, unknown> = {}) => ({
  intentId, operation: 'cancel_scheduled_task', expectedGeneration: 3, generation: 4, previousProjectionSha256: nativeCanonicalSha256(projection),
  projection: { ...projection, state: 'paused' }, configuration: null, cancel: { mode: 'pause', note: 'stop', running: 'request_cancel', runs }, ...overrides,
});
const decision = (i: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  proposalId: intentId, commandSha256: nativeCanonicalSha256(i), decision: 'approved', decidedAt: new Date(NOW - 10_000).toISOString(),
  expiresAt: new Date(NOW + 600_000).toISOString(), approver: principal, policyRevision: revision, ...overrides,
});
const cancelBody = (i = intent(), d: Record<string, unknown> = decision(i), targets: unknown[] = [binding]) =>
  ({ intent: i, intentSha256: nativeCanonicalSha256(i), decision: d, targets });

describe('Wire B — routine cancellation proof', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = createInProcessEd25519Signer({ issuer: 'capiro-core:routine-cancel:v1', kid: 'routine-cancel-synthetic-1', privateKey });
  const trust = (nowMs = NOW) => ({ issuer: signer.issuer, keys: { [signer.kid]: publicKey }, nowMs });
  const approve = (raw: unknown, p = principal) => checkApprovedCancellation({ body: raw, principal: p, membership, nowMs: NOW });

  it('binds the owner, the exact intent, the approving decision and the exact target runs', async () => {
    const approved = approve(cancelBody());
    const issued = await issueRoutineCancellationProof({ approved, jti: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', nowMs: NOW }, signer);
    expect(issued.exp - issued.iat).toBe(ROUTINE_CANCEL_MAX_TTL_SECONDS);
    const claims = verifyRoutineCancellationProof(issued.proof, trust());
    expect(claims).toMatchObject({ tenantId, ownerActorId: actorId, scheduleId, intentId, runs, intentSha256: nativeCanonicalSha256(intent()) });
    expect(cancellationCoversRun(claims, binding)).toBe(true);
    expect(cancellationCoversRun(claims, { ...binding, runId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })).toBe(false);
    expect(() => verifyRoutineCancellationProof(issued.proof, trust(NOW + 31_000))).toThrow('ROUTINE_CANCELLATION_PROOF_REFUSED');
    expect(() => verifyRoutineCancellationProof(issued.proof, { ...trust(), keys: { [signer.kid]: generateKeyPairSync('ed25519').publicKey } }))
      .toThrow('ROUTINE_CANCELLATION_PROOF_REFUSED');
  });

  it('never outlives the approving decision', async () => {
    const i = intent();
    const approved = approve(cancelBody(i, decision(i, { expiresAt: new Date(NOW + 5_000).toISOString() })));
    const issued = await issueRoutineCancellationProof({ approved, jti: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', nowMs: NOW }, signer);
    expect(issued.exp).toBe(Math.floor((NOW + 5_000) / 1000));
  });

  it.each([
    ['a rejected decision', () => { const i = intent(); return cancelBody(i, decision(i, { decision: 'rejected' })); }],
    ['a decision for another proposal', () => { const i = intent(); return cancelBody(i, decision(i, { proposalId: '12121212-1212-4121-8121-121212121212' })); }],
    ['an expired decision', () => { const i = intent(); return cancelBody(i, decision(i, { expiresAt: new Date(NOW - 1).toISOString() })); }],
    ['another approver', () => { const i = intent(); return cancelBody(i, decision(i, { approver: { tenantId, actorId: otherActor } })); }],
    ['a revision other than the intent scopes', () => { const i = intent(); return cancelBody(i, decision(i, { policyRevision: 'b'.repeat(64) })); }],
    ["a target that is not the owner's run", () => cancelBody(intent(), undefined, [{ ...binding, actorId: otherActor }])],
    ["another owner's intent", () => { const i = intent({ projection: { ...projection, owner: { tenantId, actorId: otherActor } } }); return cancelBody(i); }],
  ] as Array<[string, () => unknown]>)('refuses %s', (_label, make) => {
    expect(() => approve(make())).toThrow(ForbiddenException);
  });

  it.each([
    ['an intent hash mismatch', () => ({ ...cancelBody(), intentSha256: 'e'.repeat(64) })],
    ['a cancellation that leaves running work', () => cancelBody(intent({ cancel: { mode: 'pause', note: 'stop', running: 'leave', runs } }))],
    ['a non-cancel intent', () => cancelBody(intent({ operation: 'update_scheduled_task' }))],
    ['duplicate targets', () => cancelBody(intent(), undefined, [binding, binding])],
  ] as Array<[string, () => unknown]>)('rejects %s as malformed', (_label, make) => {
    expect(() => approve(make())).toThrow(BadRequestException);
  });
});

describe('MeriRoutinesService (draft, unmounted)', () => {
  const SECRET = 'synthetic-service-secret';
  function verifiedRequest(verified = true): Request {
    const req = { headers: { 'x-internal-service-secret': verified ? SECRET : 'wrong' }, method: 'POST', path: '/x' } as unknown as Request;
    const guard = new ToolServiceSecretGuard({ get: (key: string) => (key === 'NODE_ENV' ? 'development' : key === 'INTERNAL_SERVICE_SECRET' ? SECRET : false) } as never);
    guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext);
    return req;
  }
  const ctx = { tenantId, userId: actorId } as TenantContext;
  function fixture(withSigner = true) {
    const approvals = new Map<string, any>();
    const proofs: any[] = [];
    const order: string[] = [];
    const tx = {
      clioMeriRoutineApproval: {
        createMany: jest.fn(async ({ data }: any) => {
          for (const row of data) if (!approvals.has(row.intentId)) approvals.set(row.intentId, { ...row, unattendedEnabled: false });
          order.push('approval');
          return { count: 1 };
        }),
        findUnique: jest.fn(async ({ where }: any) => approvals.get(where.tenantId_intentId.intentId) ?? null),
      },
      clioMeriRoutineCancelProof: { create: jest.fn(async ({ data }: any) => { proofs.push(data); order.push('proof'); return data; }) },
    };
    const prisma = { withTenantUser: jest.fn(async (_t: string, _u: string, fn: (t: unknown) => unknown) => fn(tx)) };
    const membershipService = { read: jest.fn(async () => ({ ...membership, status: 'active', role: 'standard_user', permissions: [], membershipRevision: 'r', checkedAtMs: NOW })) };
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = withSigner ? createInProcessEd25519Signer({ issuer: 'capiro-core:routine-cancel:v1', kid: 'routine-cancel-synthetic-1', privateKey }) : null;
    const wrapped = signer ? { ...signer, sign: async (m: Uint8Array) => { order.push('sign'); return signer.sign(m); } } : null;
    return { service: new MeriRoutinesService(prisma as never, membershipService as never, wrapped as never), approvals, proofs, order, membershipService };
  }

  it('answers the policy check from the current membership, and only for the verified service identity', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const f = fixture();
      const s = selection('schedule_task');
      const receipt = await f.service.policyCheck(verifiedRequest(), ctx, body(s));
      expect(meriAccepts(receipt as never, s, NOW, NOW)).toBe(true);
      expect(f.membershipService.read).toHaveBeenCalledTimes(1);
      await expect(f.service.policyCheck(verifiedRequest(false), ctx, body(s))).rejects.toBeInstanceOf(ForbiddenException);
    } finally { jest.useRealTimers(); }
  });

  it('records the fenced consent row and the proof jti before signing', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const f = fixture();
      const out = await f.service.cancellationProof(verifiedRequest(), ctx, cancelBody());
      expect(f.order).toEqual(['approval', 'proof', 'sign']);
      expect(f.approvals.get(intentId)).toMatchObject({ operation: 'cancel_scheduled_task', ownerUserId: actorId, scheduleId, unattendedEnabled: false });
      expect(f.proofs[0]).toMatchObject({ jti: out.jti, intentId, expSeconds: BigInt(Math.floor(NOW / 1000) + 30) });
      expect(out.expiresAtMs).toBe((Math.floor(NOW / 1000) + 30) * 1000);
    } finally { jest.useRealTimers(); }
  });

  it('refuses a different decision for an already recorded intent, and answers 503 without a key', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const f = fixture();
      await f.service.cancellationProof(verifiedRequest(), ctx, cancelBody());
      const i = intent();
      await expect(f.service.cancellationProof(verifiedRequest(), ctx, cancelBody(i, decision(i, { decidedAt: new Date(NOW - 5_000).toISOString() }))))
        .rejects.toBeInstanceOf(ConflictException);
      expect(f.proofs).toHaveLength(1);
      await expect(fixture(false).service.cancellationProof(verifiedRequest(), ctx, cancelBody())).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally { jest.useRealTimers(); }
  });

  it('pins HTTP 200 on both routes', () => {
    for (const name of ['policyCheck', 'cancellationProof'] as const) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, MeriRoutinesController.prototype[name])).toBe(200);
    }
  });
});
