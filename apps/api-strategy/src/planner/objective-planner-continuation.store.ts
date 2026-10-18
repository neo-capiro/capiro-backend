import type { Prisma } from '../../generated/prisma-client/index.js';
import { parseCanonicalProducerRequest, type CanonicalProducerWork } from '../meri/objective-canonical-producer.js';
import { applicationHash, applicationJson, applicationUuid, CanonicalApplicationError } from './objective-canonical-application.js';
import type { CanonicalPlannerOriginalOperation } from './objective-canonical-continuation.js';

export const PLANNER_CONTINUATION_OPERATION = 'objective_planner_continuation_operation';
const NAMESPACE = 'capiro.objective-planner.continuation:v1';
const NAME = 'Objective Planner continuation operation';
type Tx = Pick<Prisma.TransactionClient, 'spPlannerResource'>;
export type PlannerContinuationState = 'queued' | 'leased' | 'applied' | 'cancelled' | 'failed';
export interface PlannerContinuationOperation {
  schemaVersion: 1;
  namespace: typeof NAMESPACE;
  tenantId: string;
  clerkUserId: string;
  membershipId: string;
  work: CanonicalProducerWork;
  original: CanonicalPlannerOriginalOperation;
  state: PlannerContinuationState;
  lease: { token: string; expiresAtMs: number } | null;
  terminal: { receiptId: string; recordedAtMs: number } | null;
}
export interface StoredPlannerContinuationOperation {
  id: string; tenantId: string; ownerId: string; version: number;
  data: PlannerContinuationOperation;
}
export interface PlannerContinuationOperationInput {
  work: CanonicalProducerWork; clerkUserId: string; membershipId: string;
  /** Owner-observed original consent deadline, never now + duration. */
  originalDeadlineAt: string;
}
export interface PlannerContinuationOperationScope { tenantId: string; clerkUserId: string; operationId: string }
export interface PlannerContinuationClaim {
  leaseToken: string; nowMs: number; leaseExpiresAtMs: number;
  /** Only the concrete application owner may select this, under the Planner
   * gate, after establishing its invariant: application outputs/receipt and
   * operation accounting always commit in the SAME native transaction. An
   * expired lease or absent application receipt alone is never that evidence. */
  reclaimExpiredLease?: false | 'application-and-operation-atomic';
}
export interface PlannerContinuationFinalization {
  state: 'applied' | 'cancelled' | 'failed'; terminalReceiptId: string;
  leaseToken: string | null; nowMs: number;
}

const fail = (code: CanonicalApplicationError['code'] = 'OUTCOME_UNCONFIRMED'): never => {
  throw new CanonicalApplicationError(code);
};
function closed(value: unknown, keys: string[]) {
  applicationHash(value); // Reject proxies, accessors and non-JSON before property reads.
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) return fail();
}
function copy<T>(value: T): T { return JSON.parse(applicationJson(value)) as T; }
function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}
function clerk(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 128; }
function uuid(value: unknown): string { try { return applicationUuid(value); } catch { return fail(); } }
function privateId(value: unknown) {
  const h = applicationHash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function parsedWork(raw: CanonicalProducerWork) {
  return parseCanonicalProducerRequest({ schemaVersion: 1, phase: 'prepare', work: raw }).work;
}
export function plannerContinuationOperationId(raw: CanonicalProducerWork): string {
  const work = parsedWork(raw);
  return privateId([NAMESPACE, work.applicationRequestId, work.consentId, applicationHash(work)]);
}
function original(input: PlannerContinuationOperationInput): CanonicalPlannerOriginalOperation {
  const operationId = plannerContinuationOperationId(input.work), workSha256 = applicationHash(input.work);
  return {
    operationId,
    attemptId: privateId([NAMESPACE, 'attempt', operationId]),
    runId: privateId([NAMESPACE, 'run', operationId]),
    requestFingerprint: applicationHash({ namespace: NAMESPACE, workSha256, clerkUserId: input.clerkUserId,
      membershipId: input.membershipId, originalDeadlineAt: input.originalDeadlineAt }),
    originalDeadlineAt: input.originalDeadlineAt, workSha256,
  };
}
function immutable(data: PlannerContinuationOperation) {
  const { state: _state, lease: _lease, terminal: _terminal, ...fixed } = data;
  return fixed;
}
export function newPlannerContinuationOperation(raw: PlannerContinuationOperationInput): PlannerContinuationOperation {
  closed(raw, ['work', 'clerkUserId', 'membershipId', 'originalDeadlineAt']);
  const input = copy(raw), work = parsedWork(input.work);
  uuid(input.membershipId);
  if (!clerk(input.clerkUserId) || typeof input.originalDeadlineAt !== 'string' ||
      !time(Date.parse(input.originalDeadlineAt)) ||
      new Date(input.originalDeadlineAt).toISOString() !== input.originalDeadlineAt) return fail();
  return { schemaVersion: 1, namespace: NAMESPACE, tenantId: work.canonical.tenantId,
    clerkUserId: input.clerkUserId, membershipId: input.membershipId, work,
    original: original({ ...input, work }), state: 'queued', lease: null, terminal: null };
}
export function parsePlannerContinuationOperation(raw: unknown): PlannerContinuationOperation {
  closed(raw, ['schemaVersion', 'namespace', 'tenantId', 'clerkUserId', 'membershipId', 'work', 'original', 'state', 'lease', 'terminal']);
  const data = copy(raw) as PlannerContinuationOperation;
  closed(data.original, ['operationId', 'attemptId', 'runId', 'requestFingerprint', 'originalDeadlineAt', 'workSha256']);
  const expected = newPlannerContinuationOperation({ work: data.work, clerkUserId: data.clerkUserId,
    membershipId: data.membershipId, originalDeadlineAt: data.original.originalDeadlineAt });
  if (applicationHash(immutable(data)) !== applicationHash(immutable(expected))) return fail();
  if (!['queued', 'leased', 'applied', 'cancelled', 'failed'].includes(data.state)) return fail();
  if (data.state === 'leased') {
    closed(data.lease, ['token', 'expiresAtMs']); uuid(data.lease!.token);
    if (!time(data.lease!.expiresAtMs) || data.lease!.expiresAtMs > Date.parse(data.original.originalDeadlineAt) ||
        data.terminal !== null) return fail();
  } else if (data.lease !== null) return fail();
  if (['applied', 'cancelled', 'failed'].includes(data.state)) {
    closed(data.terminal, ['receiptId', 'recordedAtMs']); uuid(data.terminal!.receiptId);
    if (!time(data.terminal!.recordedAtMs) || data.state === 'applied' &&
        data.terminal!.recordedAtMs >= Date.parse(data.original.originalDeadlineAt)) return fail();
  } else if (data.terminal !== null) return fail();
  return data;
}
function stored(raw: StoredPlannerContinuationOperation): StoredPlannerContinuationOperation {
  closed(raw, ['id', 'tenantId', 'ownerId', 'version', 'data']);
  const data = parsePlannerContinuationOperation(raw.data);
  if (raw.id !== data.original.operationId || raw.tenantId !== data.tenantId || raw.ownerId !== data.clerkUserId ||
      !Number.isInteger(raw.version) || raw.version < 1 || raw.version > 2147483647 ||
      (data.state === 'queued' ? raw.version !== 1 : raw.version < 2) ||
      data.state === 'applied' && raw.version < 3) return fail();
  return { id: raw.id, tenantId: raw.tenantId, ownerId: raw.ownerId, version: raw.version, data };
}

/** Caller holds the Planner advisory gate before taking job/Core locks. These
 * helpers open no transaction, acquire no advisory lock and perform no IO
 * beyond the supplied transaction. Every row statement pins the tenant. */
export async function readPlannerContinuationOperationWithinTx(tx: Tx,
  raw: PlannerContinuationOperationScope): Promise<StoredPlannerContinuationOperation | null> {
  closed(raw, ['tenantId', 'clerkUserId', 'operationId']);
  const scope = copy(raw); uuid(scope.tenantId); uuid(scope.operationId);
  if (!clerk(scope.clerkUserId)) return fail();
  const row = await tx.spPlannerResource.findFirst({ where: { tenantId: scope.tenantId, id: scope.operationId },
    select: { id: true, tenantId: true, ownerId: true, projectId: true, kind: true, name: true,
      data: true, version: true, archived: true, shareTokenHash: true } });
  if (!row) return null;
  // Test doubles and unexpected data must not smuggle a differently scoped row.
  if (row.tenantId !== scope.tenantId || row.id !== scope.operationId || row.ownerId !== scope.clerkUserId ||
      row.kind !== PLANNER_CONTINUATION_OPERATION || row.name !== NAME || row.projectId !== null ||
      row.archived !== false || row.shareTokenHash !== null) return fail();
  return stored({ id: row.id, tenantId: row.tenantId, ownerId: row.ownerId, version: row.version, data: row.data as unknown as PlannerContinuationOperation });
}
export async function insertPlannerContinuationOperationWithinTx(tx: Tx,
  raw: PlannerContinuationOperation): Promise<StoredPlannerContinuationOperation> {
  const data = parsePlannerContinuationOperation(raw);
  if (data.state !== 'queued') return fail();
  const old = await readPlannerContinuationOperationWithinTx(tx, { tenantId: data.tenantId,
    clerkUserId: data.clerkUserId, operationId: data.original.operationId });
  if (old) {
    if (applicationHash(immutable(old.data)) !== applicationHash(immutable(data))) return fail('REQUEST_CONFLICT');
    return old;
  }
  await tx.spPlannerResource.create({ data: { id: data.original.operationId, tenantId: data.tenantId,
    ownerId: data.clerkUserId, projectId: null, kind: PLANNER_CONTINUATION_OPERATION, name: NAME,
    version: 1, archived: false, shareTokenHash: null, data: data as unknown as Prisma.InputJsonValue } });
  return stored({ id: data.original.operationId, tenantId: data.tenantId, ownerId: data.clerkUserId, version: 1, data });
}
async function cas(tx: Tx, old: StoredPlannerContinuationOperation,
  data: PlannerContinuationOperation): Promise<StoredPlannerContinuationOperation> {
  if (old.version === 2147483647 || applicationHash(immutable(old.data)) !== applicationHash(immutable(data))) return fail();
  const next = stored({ ...old, version: old.version + 1, data });
  const changed = await tx.spPlannerResource.updateMany({ where: { id: old.id, tenantId: old.tenantId,
    ownerId: old.ownerId, kind: PLANNER_CONTINUATION_OPERATION, name: NAME, version: old.version,
    projectId: null, archived: false, shareTokenHash: null,
    data: { equals: old.data as unknown as Prisma.InputJsonValue } },
    data: { data: next.data as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
  if (changed.count !== 1) return fail();
  return next;
}
export async function claimPlannerContinuationOperationWithinTx(tx: Tx, raw: StoredPlannerContinuationOperation,
  claim: PlannerContinuationClaim): Promise<StoredPlannerContinuationOperation | null> {
  applicationHash(claim);
  const keys = ['leaseToken', 'nowMs', 'leaseExpiresAtMs'];
  closed(claim, Object.hasOwn(claim, 'reclaimExpiredLease') ? [...keys, 'reclaimExpiredLease'] : keys);
  const old = stored(raw), input = copy(claim); uuid(input.leaseToken);
  if (!time(input.nowMs) || !time(input.leaseExpiresAtMs) || input.leaseExpiresAtMs <= input.nowMs ||
      input.leaseExpiresAtMs > Date.parse(old.data.original.originalDeadlineAt) ||
      input.reclaimExpiredLease !== undefined && input.reclaimExpiredLease !== false &&
        input.reclaimExpiredLease !== 'application-and-operation-atomic') return fail();
  if (input.nowMs >= Date.parse(old.data.original.originalDeadlineAt) ||
      ['applied', 'cancelled', 'failed'].includes(old.data.state)) return null;
  if (old.data.state === 'leased' && (old.data.lease!.expiresAtMs > input.nowMs ||
      input.reclaimExpiredLease !== 'application-and-operation-atomic' || old.data.lease!.token === input.leaseToken)) return null;
  return cas(tx, old, { ...old.data, state: 'leased', lease: { token: input.leaseToken,
    expiresAtMs: input.leaseExpiresAtMs }, terminal: null });
}
/** Application effects, application receipt and this accounting CAS MUST share
 * the caller's one native transaction. A throw must roll every write back.
 * Cancellation/failure may account after historical expiry; applied may not. */
export async function finalizePlannerContinuationOperationWithinTx(tx: Tx, raw: StoredPlannerContinuationOperation,
  finalization: PlannerContinuationFinalization): Promise<StoredPlannerContinuationOperation> {
  closed(finalization, ['state', 'terminalReceiptId', 'leaseToken', 'nowMs']);
  const old = stored(raw), input = copy(finalization); uuid(input.terminalReceiptId);
  if (!['applied', 'cancelled', 'failed'].includes(input.state) || !time(input.nowMs)) return fail();
  if (input.leaseToken !== null) uuid(input.leaseToken);
  if (['applied', 'cancelled', 'failed'].includes(old.data.state)) {
    if (old.data.state !== input.state || old.data.terminal!.receiptId !== input.terminalReceiptId) return fail('REQUEST_CONFLICT');
    return old;
  }
  if (old.data.state === 'leased') {
    uuid(input.leaseToken);
    if (input.leaseToken !== old.data.lease!.token) return fail();
  } else if (input.leaseToken !== null || input.state === 'applied') return fail();
  if (input.state === 'applied' && (input.nowMs >= Date.parse(old.data.original.originalDeadlineAt) ||
      old.data.lease!.expiresAtMs <= input.nowMs)) return fail('AUTHORITY_UNAVAILABLE');
  return cas(tx, old, { ...old.data, state: input.state, lease: null,
    terminal: { receiptId: input.terminalReceiptId, recordedAtMs: input.nowMs } });
}
