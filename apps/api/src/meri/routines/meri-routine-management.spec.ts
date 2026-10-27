import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { nativeCanonicalSha256 as hash } from '../native-approvals/native-approval.contract.js';
import { routineManagementCurrent, decideRoutineManagementPolicy } from './meri-routine-management.js';
import { MeriRoutinesController } from './meri-routines.controller.js';
import { MeriRoutinesService } from './meri-routines.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111', actorId = '22222222-2222-4222-8222-222222222222';
const clientId = '44444444-4444-4444-8444-444444444444', scheduleId = '66666666-6666-4666-8666-666666666666';
const intentId = '77777777-7777-4777-8777-777777777777', foreign = '33333333-3333-4333-8333-333333333333';
const principal = { tenantId, actorId }, NOW = Date.parse('2026-10-27T12:00:00Z'), policyRevision = 'a'.repeat(64);
const membership = { ...principal, clientIds: [clientId], membershipRevision: 'b'.repeat(64), expiresAtMs: NOW + 60_000 };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function current(selectedClientId: string | null = clientId) {
  const { checkedAtMs: _at, expiresAtMs: _until, ...value } = routineManagementCurrent({ body: { clientId: selectedClientId, policyRevision }, principal, membership, nowMs: NOW });
  return value;
}
function projection() { return { scheduleId, owner: principal, temporalScheduleId: 'routines/' + scheduleId, timezone: 'UTC', scopes: current().scopes,
  state: 'active', maxCostMicrousd: 1000, maxRuntimeSeconds: 60, retryLimit: 0, destinationId: 'meri-inbox', createdAt: '2026-10-27T00:00:00Z' }; }
function selection(operation = 'list_scheduled_tasks', request?: Record<string, unknown>) {
  const p = projection();
  return { phase: 'resolve', operation, request: request ?? (operation === 'cancel_scheduled_task' ? { scheduleId, mode: 'pause', note: 'Stop future firings', running: 'leave', runs: [] } : {}),
    currentSchedule: operation === 'cancel_scheduled_task' ? { projection: p, generation: 1, projectionSha256: hash(p) } : null,
    proposal: null as unknown, current: current(), scheduleBinding: null as unknown };
}
const body = (value: unknown) => ({ selection: value, selectionSha256: hash(value) });
const decide = (value: unknown, facts = membership) => decideRoutineManagementPolicy({ body: body(value), principal, membership: facts, nowMs: NOW });
afterEach(() => { jest.restoreAllMocks(); });

describe('cold routine-management authority', () => {
  it.each([clientId, null])('observes current %s scope without a conversation, execution limits or generated run identity', selectedClientId => {
    const receipt = routineManagementCurrent({ body: { clientId: selectedClientId, policyRevision }, principal, membership, nowMs: NOW });
    expect(receipt).toMatchObject({ kind: 'routine-management', principal, selectedClientId, checkedAtMs: NOW, expiresAtMs: NOW + 30_000 });
    expect(Object.keys(receipt).sort()).toEqual(['checkedAtMs', 'contextRevision', 'expiresAtMs', 'kind', 'membershipRevision', 'principal', 'scopes', 'selectedClientId']);
    expect(receipt.scopes).toEqual([{ kind: selectedClientId === null ? 'private-user' : 'client', tenantId, resourceId: selectedClientId ?? actorId, policyRevision }]);
  });
  it('refuses a foreign/walled client, changed principal, expired membership and extra run selectors', () => {
    for (const facts of [{ ...membership, clientIds: [] }, { ...membership, actorId: foreign }, { ...membership, tenantId: foreign }, { ...membership, expiresAtMs: NOW }]) {
      expect(() => routineManagementCurrent({ body: { clientId, policyRevision }, principal, membership: facts, nowMs: NOW })).toThrow(ForbiddenException);
    }
    expect(() => routineManagementCurrent({ body: { clientId, policyRevision, runId: foreign }, principal, membership, nowMs: NOW })).toThrow(BadRequestException);
  });
  it('admits list and future-only pause/delete with no model configuration', () => {
    expect(decide(selection())).toMatchObject({ authorized: true, limits: null, destinationResolution: null, current: current() });
    for (const mode of ['pause', 'delete']) expect(decide(selection('cancel_scheduled_task', { scheduleId, mode, note: 'Stop future firings', running: 'leave', runs: [] })).authorized).toBe(true);
  });
  it('uses the canonical scope policyRevision ceiling at bootstrap', () => {
    expect(routineManagementCurrent({ body: { clientId, policyRevision: 'p'.repeat(128) }, principal, membership, nowMs: NOW }).scopes[0]!.policyRevision).toHaveLength(128);
    expect(() => routineManagementCurrent({ body: { clientId, policyRevision: 'p'.repeat(129) }, principal, membership, nowMs: NOW })).toThrow(BadRequestException);
  });
  it('reauthorizes every legacy resource scope while keeping the client anchor narrow and General exact', () => {
    const value = selection('cancel_scheduled_task'), legacy = [...current().scopes, { ...current().scopes[0]!, resourceId: foreign }];
    value.currentSchedule!.projection.scopes = legacy; value.currentSchedule!.projectionSha256 = hash(value.currentSchedule!.projection);
    const allowed = { ...membership, clientIds: [clientId, foreign] };
    expect(decide(value, allowed).current.scopes).toEqual(current().scopes);
    expect(() => decide(value, membership)).toThrow(ForbiddenException);
    value.currentSchedule!.projection.scopes = [legacy[1]!]; value.currentSchedule!.projectionSha256 = hash(value.currentSchedule!.projection);
    expect(() => decide(value, allowed)).toThrow(ForbiddenException);
    value.current = current(null); value.currentSchedule!.projection.scopes = [...current(null).scopes, ...legacy]; value.currentSchedule!.projectionSha256 = hash(value.currentSchedule!.projection);
    expect(() => decide(value, allowed)).toThrow(ForbiddenException);
  });
  it.each(['schedule_task', 'update_scheduled_task'])('refuses execution operation %s', operation => expect(() => decide(selection(operation))).toThrow(BadRequestException));
  it('refuses current-work cancellation, selected runs and a fake execution binding', () => {
    expect(() => decide(selection('cancel_scheduled_task', { scheduleId, mode: 'pause', note: 'Stop future firings', running: 'request_cancel', runs: [] }))).toThrow(BadRequestException);
    expect(() => decide(selection('cancel_scheduled_task', { scheduleId, mode: 'pause', note: 'Stop future firings', running: 'leave', runs: [{ runId: foreign }] }))).toThrow(BadRequestException);
    const value = selection(); Object.assign(value.current, { binding: { tenantId, actorId } });
    expect(() => decide(value)).toThrow(BadRequestException);
    const nested = selection('cancel_scheduled_task');
    nested.scheduleBinding = { intent: { intentId, operation: 'cancel_scheduled_task', projection: projection(),
      cancel: { mode: 'pause', note: 'Stop future firings', running: 'request_cancel', runs: [] } } };
    expect(() => decide(nested)).toThrow(BadRequestException);
    const mismatch = selection('cancel_scheduled_task');
    mismatch.proposal = { operation: 'cancel_scheduled_task', status: 'approval_required', proposalId: intentId,
      intentSha256: 'd'.repeat(64), taskInstruction: null, projection: projection(), policy: null,
      cancel: { mode: 'delete', note: 'Stop future firings', running: 'leave', runs: [] } };
    expect(() => decide(mismatch)).toThrow(BadRequestException);
    const wrongSchedule = selection('cancel_scheduled_task');
    wrongSchedule.scheduleBinding = { intent: { intentId, operation: 'cancel_scheduled_task', projection: { ...projection(), scheduleId: foreign },
      cancel: { mode: 'pause', note: 'Stop future firings', running: 'leave', runs: [] } } };
    expect(() => decide(wrongSchedule)).toThrow(BadRequestException);
  });
  it('binds current membership, selected scope, context revision and every described row before release', () => {
    expect(() => decide(selection(), { ...membership, membershipRevision: 'c'.repeat(64) })).toThrow(ForbiddenException);
    const value = selection(); value.current.contextRevision = 'c'.repeat(64); expect(() => decide(value)).toThrow(ForbiddenException);
    for (const resource of [{ ...projection(), owner: { tenantId, actorId: foreign } }, { ...projection(), scopes: current(null).scopes }]) {
      const row = selection(); row.phase = 'before_describe_schedule'; row.scheduleBinding = { resource };
      expect(() => decide(row)).toThrow(ForbiddenException);
    }
    const cancel = selection('cancel_scheduled_task'); cancel.currentSchedule!.projection.owner = { tenantId, actorId: foreign };
    cancel.currentSchedule!.projectionSha256 = hash(cancel.currentSchedule!.projection);
    expect(() => decide(cancel)).toThrow(ForbiddenException);
  });
  it('rejects a changed digest and scopes even when their own context digest is recomputed', () => {
    const value = selection();
    expect(() => decideRoutineManagementPolicy({ body: { ...body(value), selectionSha256: '0'.repeat(64) }, principal, membership, nowMs: NOW })).toThrow(BadRequestException);
    value.current.scopes[0]!.resourceId = foreign;
    const { contextRevision: _old, ...pin } = value.current; value.current.contextRevision = hash(pin);
    expect(() => decide(value)).toThrow(ForbiddenException);
  });
});

function verifiedRequest() {
  const secret = 'synthetic-management-service', request = { headers: { 'x-internal-service-secret': secret }, method: 'POST', path: '/x' } as unknown as Request;
  new ToolServiceSecretGuard({ get: (key: string) => key === 'NODE_ENV' ? 'development' : key === 'INTERNAL_SERVICE_SECRET' ? secret : false } as never)
    .canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext);
  return request;
}
describe('guarded management route and existing consent owner', () => {
  const ctx = { tenantId, userId: actorId } as TenantContext;
  function fixture() {
    const member = { read: jest.fn(async () => membership) }, revocations: unknown[] = [];
    const tx = { $queryRaw: jest.fn(async () => [{ db_now: new Date(NOW) }]), clioMeriRoutineConsentRevocation: { createMany: jest.fn(async (v: { data: unknown[] }) => { revocations.push(...v.data); }) } };
    const prisma = { withTenant: jest.fn(async (_tenant: string, operation: (value: typeof tx) => unknown) => operation(tx)) };
    return { member, revocations, prisma, service: new MeriRoutinesService(prisma as never, member as never, null) };
  }
  it('mounts exact guarded routes and denies unsigned service calls before membership', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MeriRoutinesController)).toContain(ToolServiceSecretGuard);
    expect(Reflect.getMetadata(PATH_METADATA, MeriRoutinesController.prototype.managementCurrent)).toBe('management/current');
    expect(Reflect.getMetadata(PATH_METADATA, MeriRoutinesController.prototype.managementPolicyCheck)).toBe('management/policy/check');
    const f = fixture(); await expect(f.service.managementCurrent({} as Request, ctx, { clientId, policyRevision })).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.member.read).not.toHaveBeenCalled();
  });
  it('rejects execution before membership and preserves fresh no-run current observation', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW); const f = fixture(), request = verifiedRequest();
    await expect(f.service.managementPolicyCheck(request, ctx, body(selection('schedule_task')))).rejects.toBeInstanceOf(BadRequestException);
    expect(f.member.read).not.toHaveBeenCalled();
    expect(await f.service.managementCurrent(request, ctx, { clientId, policyRevision })).toMatchObject({ kind: 'routine-management', principal });
    expect(f.member.read).toHaveBeenCalledTimes(1); expect(f.prisma.withTenant).not.toHaveBeenCalled();
  });
  it.each<["pause" | "delete", boolean]>([['pause', false], ['delete', false], ['pause', true], ['delete', true]])('records only existing exact approved %s consent revocation at before_claim (legacy scopes=%s)', async (mode, legacy) => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW); const f = fixture(), value = selection('cancel_scheduled_task', { scheduleId, mode, note: 'Stop future firings', running: 'leave', runs: [] });
    const resourceScopes = legacy ? [...current().scopes, { ...current().scopes[0]!, resourceId: foreign }] : current().scopes;
    if (legacy) { f.member.read.mockResolvedValue({ ...membership, clientIds: [clientId, foreign] }); value.currentSchedule!.projection.scopes = resourceScopes; value.currentSchedule!.projectionSha256 = hash(value.currentSchedule!.projection); }
    const p = { ...projection(), scopes: resourceScopes, state: mode === 'pause' ? 'paused' : 'cancelled' };
    const intent = { intentId, operation: value.operation, expectedGeneration: 1, generation: 2, previousProjectionSha256: hash(projection()), projection: p,
      configuration: null, cancel: { mode, note: 'Stop future firings', running: 'leave', runs: [] } };
    const approval = { proposalId: intentId, commandSha256: hash(intent), decision: 'approved', decidedAt: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + 10000).toISOString(), approver: principal, policyRevision };
    const call = { intent, approval, callerIdentity: principal, deadlineMs: NOW + 10000 };
    value.proposal = { operation: value.operation, status: 'approval_required', proposalId: intentId, intentSha256: hash(intent), taskInstruction: null, projection: p, policy: null, cancel: intent.cancel };
    value.scheduleBinding = { ...call, bindingSha256: hash(call) };
    await f.service.managementPolicyCheck(verifiedRequest(), ctx, body(value)); expect(f.revocations).toHaveLength(0);
    value.phase = 'before_claim'; await f.service.managementPolicyCheck(verifiedRequest(), ctx, body(value));
    expect(f.revocations).toEqual([expect.objectContaining({ tenantId, intentId, scheduleId, revokedByUserId: actorId, reason: mode === 'pause' ? 'paused' : 'deleted' })]);
    const bad = clone(value); (bad.scheduleBinding as { approval: { approver: { actorId: string } } }).approval.approver.actorId = foreign;
    await expect(f.service.managementPolicyCheck(verifiedRequest(), ctx, body(bad))).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.revocations).toHaveLength(1);
    if (legacy) { f.member.read.mockResolvedValue(membership); await expect(f.service.managementPolicyCheck(verifiedRequest(), ctx, body(value))).rejects.toBeInstanceOf(ForbiddenException); expect(f.revocations).toHaveLength(1); }
  });
});
