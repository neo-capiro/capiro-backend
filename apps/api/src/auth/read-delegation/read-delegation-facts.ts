import { ConflictException, ForbiddenException, GoneException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { readMeriAdmittedRun } from '../../meri/execution-capability/meri-admitted-run.reader.js';
import type { NativeRunBinding } from '../../meri/native-approvals/native-approval.contract.js';
import { canonicalSha256, isSha, isUuid, operationsDigest, type OperationRef } from './read-delegation.contract.js';
import { readDocumentTextOnlyAllocation, type DocumentTextOnlyAllocation } from './read-delegation-document-pricing.js';

type Tx = Prisma.TransactionClient;

/**
 * Meri's run facts (contract §4), read through the Meri-owned read-only views
 * in `meri_read_delegation_facts` (Meri migration
 * read-delegation/migrations/0001_read_delegation_facts.sql). Core never trusts
 * a caller digest for allocation, operations, deadline, allowance or fence:
 * every issuance, token issue, token use and release reads these rows in the
 * same transaction. Meri's view is read only after Core's canonical admission
 * snapshot takes the budget lock and verifies its exact original ADMITTED
 * grant set. A view row's existence is never authority (dot 6248061000).
 */
export interface RunFacts {
  /** Saved seven-field ADMITTED binding, verified under the admission lock.
   * Distinct from the six-field Option B run projection below. */
  admittedBinding?: NativeRunBinding;
  /** Projection of the exact locked original allocation, never caller metadata. */
  documentTextOnlyAllocation?: DocumentTextOnlyAllocation | null;
  runId: string;
  tenantId: string;
  conversationId: string;
  allocationSha256: string;
  allowedOperations: OperationRef[];
  maxToolCalls: number;
  reservedCalls: number;
  attempt: number;
  fence: number;
  policyRevision: string;
  admitted: boolean;
  admittedUntilMs: number | null;
  runState: string;
  runBinding: unknown;
  runScopes: unknown;
  dbNowMs: number;
}

/** The delegation facts every check compares against (a `meri_read_delegations` row). */
export interface DelegationFacts {
  id: string;
  mode: string;
  tenantId: string;
  userId: string;
  clientId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
  writerFence: number;
  actorId: string;
  budgetAttempt: number;
  budgetFence: number;
  budgetPolicyRev: string;
  allocationSha256: string;
  operationsDigest: string;
  policyRevision: string;
  state: string;
  expiresAt: Date;
}

const unavailable = () => new ServiceUnavailableException('Read delegation facts unavailable');
const denied = () => new ForbiddenException('Read delegation refused');
const changed = () => new ConflictException('Read delegation changed');
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const ACTIVE_RUN_STATES = Object.freeze(['queued', 'starting', 'running']);

const integer = (value: unknown): number => {
  const n = typeof value === 'bigint' ? Number(value) : typeof value === 'string' && /^-?\d{1,16}$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw unavailable();
  return n;
};
const ms = (value: unknown): number | null => (value === null ? null : integer(value));

function operations(value: unknown): OperationRef[] {
  if (!Array.isArray(value) || value.length > 256) throw unavailable();
  return value.map((op: unknown) => {
    const o = op as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || typeof o.id !== 'string' || typeof o.version !== 'string') throw unavailable();
    return { id: o.id, version: o.version };
  });
}

/** The view supplies the conversation id needed to address Core's snapshot;
 * this preliminary read grants no authority. It is read again under the
 * snapshot's budget FOR SHARE lock before any decision or write. */
async function conversationForSnapshot(tx: Tx, tenantId: string, runId: string): Promise<string> {
  let rows: Array<{ conversation_id: string }>;
  try {
    rows = await tx.$queryRaw<Array<{ conversation_id: string }>>`
      SELECT conversation_id::text AS conversation_id FROM meri_read_delegation_facts.run_facts_v1
       WHERE run_id = ${runId}::uuid AND tenant_id = ${tenantId} LIMIT 2`;
  } catch {
    throw unavailable();
  }
  if (rows.length !== 1 || !isUuid(rows[0]?.conversation_id)) throw changed();
  return rows[0]!.conversation_id;
}

/** The saved ADMITTED binding is the execution owner's seven-field binding.
 * Option B's six-field run projection omits workerId and its writerFence is a
 * distinct counter from Meri's budget fence. The existing admitted-run reader
 * validates this saved binding, all original grants and the budget lock. */
async function admittedBinding(tx: Tx, tenantId: string, conversationId: string, runId: string):
  Promise<{ binding: NativeRunBinding; policyRevision: string }> {
  let rows: Array<{ snapshot: unknown }>;
  try {
    rows = await tx.$queryRaw<Array<{ snapshot: unknown }>>`
      SELECT meri_core_authority.current_admission_v1(${tenantId}::uuid, ${conversationId}::uuid, ${runId}::uuid) AS snapshot`;
  } catch {
    throw unavailable();
  }
  const snapshot = rows[0]?.snapshot;
  if (rows.length !== 1 || !plain(snapshot)) throw changed();
  const run = snapshot.run;
  const admitted = snapshot.admitted;
  const binding = plain(admitted) ? admitted.binding : null;
  if (!plain(binding) || Object.keys(binding).length !== 7 ||
      !['tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'workerId', 'writerFence']
        .every((key) => Object.hasOwn(binding, key)) ||
      binding.tenantId !== tenantId || binding.conversationId !== conversationId || binding.runId !== runId ||
      !isUuid(binding.actorId) || !isUuid(binding.attemptId) || !isUuid(binding.workerId) ||
      !Number.isSafeInteger(binding.writerFence) || (binding.writerFence as number) < 1 ||
      !plain(run) || !isSha(run.policyRevision)) throw changed();
  return { binding: binding as unknown as NativeRunBinding, policyRevision: run.policyRevision as string };
}

/** One run's facts and the database clock, under the caller's transaction. */
async function readViewRunFacts(tx: Tx, tenantId: string, runId: string): Promise<RunFacts> {
  let rows: Record<string, unknown>[];
  try {
    rows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT run_id::text AS run_id, tenant_id::text AS tenant_id, conversation_id::text AS conversation_id,
             allocation_sha256::text AS allocation_sha256, allowed_operations, max_tool_calls::text AS max_tool_calls,
             reserved_calls::text AS reserved_calls, attempt::text AS attempt, fence::text AS fence,
             policy_revision::text AS policy_revision, admitted,
             floor(extract(epoch FROM admitted_until) * 1000)::bigint::text AS admitted_until_ms,
             run_state, run_binding, run_scopes,
             floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS db_now_ms
        FROM meri_read_delegation_facts.run_facts_v1
       WHERE run_id = ${runId}::uuid AND tenant_id = ${tenantId}
       LIMIT 2`;
  } catch {
    throw unavailable();
  }
  if (rows.length !== 1) throw changed();
  const r = rows[0]!;
  if (r.run_id !== runId || r.tenant_id !== tenantId || !isUuid(r.conversation_id) || !isSha(r.allocation_sha256) ||
      !isSha(r.policy_revision) || typeof r.admitted !== 'boolean' || typeof r.run_state !== 'string') throw unavailable();
  return {
    runId, tenantId, conversationId: r.conversation_id as string, allocationSha256: r.allocation_sha256 as string,
    allowedOperations: operations(r.allowed_operations), maxToolCalls: integer(r.max_tool_calls), reservedCalls: integer(r.reserved_calls),
    attempt: integer(r.attempt), fence: integer(r.fence), policyRevision: r.policy_revision as string, admitted: r.admitted,
    admittedUntilMs: ms(r.admitted_until_ms), runState: r.run_state, runBinding: r.run_binding, runScopes: r.run_scopes,
    dbNowMs: integer(r.db_now_ms),
  };
}

/** Every caller shares one fail-closed authority path. The first snapshot call
 * acquires the budget lock. readMeriAdmittedRun then checks the exact saved
 * ADMITTED grant set under that same transaction, before the view is reread. */
export async function readRunFacts(tx: Tx, tenantId: string, runId: string): Promise<RunFacts> {
  const conversationId = await conversationForSnapshot(tx, tenantId, runId);
  const { binding, policyRevision } = await admittedBinding(tx, tenantId, conversationId, runId);
  const admission = await readMeriAdmittedRun(tx, binding, policyRevision, { tenantId });
  const facts = await readViewRunFacts(tx, tenantId, runId);
  const projection = facts.runBinding;
  const allocation = admission.allocation;
  const manifest = plain(allocation) ? allocation.manifest : null;
  const budgets = plain(allocation) ? allocation.budgets : null;
  if (facts.conversationId !== conversationId || !facts.admitted || facts.admittedUntilMs === null ||
      !plain(projection) || projection.tenantId !== binding.tenantId || projection.actorId !== binding.actorId ||
      projection.conversationId !== binding.conversationId || projection.runId !== binding.runId ||
      projection.attemptId !== binding.attemptId ||
      facts.allocationSha256 !== admission.allocationSha256 ||
      facts.attempt !== admission.qualification.attempt || facts.fence !== admission.qualification.fence ||
      facts.policyRevision !== admission.qualification.policyRevision ||
      !plain(manifest) || !Array.isArray(manifest.allowedOperations) ||
      canonicalSha256(facts.allowedOperations) !== canonicalSha256(manifest.allowedOperations) ||
      !plain(budgets) || facts.maxToolCalls !== budgets.maxToolCalls ||
      facts.reservedCalls > facts.maxToolCalls) throw changed();
  facts.admittedUntilMs = Math.min(facts.admittedUntilMs, admission.deadlineMs);
  facts.admittedBinding = binding;
  facts.documentTextOnlyAllocation = readDocumentTextOnlyAllocation(allocation, admission.allocationSha256);
  if (facts.dbNowMs >= facts.admittedUntilMs) throw new GoneException('Read delegation expired');
  return facts;
}

export const runBindingOf = (d: Pick<DelegationFacts, 'tenantId' | 'actorId' | 'conversationId' | 'runId' | 'attemptId' | 'writerFence'>) => ({
  tenantId: d.tenantId, actorId: d.actorId, conversationId: d.conversationId, runId: d.runId, attemptId: d.attemptId, writerFence: d.writerFence,
});

/** The single client scope equal to the delegated client and policy; never wider. */
export function singleClientScope(scopes: unknown, clientId: string, policyRevision: string): boolean {
  if (!Array.isArray(scopes) || scopes.length !== 1) return false;
  const s = scopes[0] as Record<string, unknown> | null;
  return !!s && typeof s === 'object' && s.kind === 'client' && s.resourceId === clientId && s.policyRevision === policyRevision;
}

/**
 * Contract §4 at every check: admitted, an active run state, the pinned budget
 * attempt/fence/policy, the exact run binding, one client scope, the allocation
 * and operations, and `now < admitted_until`. Returns the hard expiry
 * `min(delegation expires_at, admitted_until)`. Throws 409 on drift, 410 at expiry.
 */
export function assertDelegationFacts(facts: RunFacts, d: DelegationFacts, options: { operation?: OperationRef } = {}): number {
  if (d.state !== 'active') throw changed();
  if (!facts.admitted || facts.admittedUntilMs === null || !ACTIVE_RUN_STATES.includes(facts.runState)) throw changed();
  if (facts.tenantId !== d.tenantId || facts.runId !== d.runId || facts.conversationId !== d.conversationId ||
      facts.attempt !== d.budgetAttempt || facts.fence !== d.budgetFence || facts.policyRevision !== d.budgetPolicyRev ||
      facts.allocationSha256 !== d.allocationSha256 || operationsDigest(facts.allowedOperations) !== d.operationsDigest ||
      canonicalSha256(facts.runBinding) !== canonicalSha256(runBindingOf(d)) ||
      !singleClientScope(facts.runScopes, d.clientId, d.policyRevision)) throw changed();
  if (options.operation && !facts.allowedOperations.some((op) => op.id === options.operation!.id && op.version === options.operation!.version)) {
    throw denied();
  }
  const hardExpiryMs = Math.min(d.expiresAt.getTime(), facts.admittedUntilMs);
  if (facts.dbNowMs >= hardExpiryMs) throw new GoneException('Read delegation expired');
  return hardExpiryMs;
}

/** Meri's own UNKNOWN reservation for this call key, operation and arguments (contract §4, `tool` tokens). */
export async function assertToolReservation(tx: Tx, runId: string, callKey: string, operation: OperationRef, argumentsSha256: string): Promise<void> {
  let rows: Record<string, unknown>[];
  try {
    rows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT invocation_id::text AS invocation_id, run_id::text AS run_id, operation, arguments_sha256::text AS arguments_sha256, state
        FROM meri_read_delegation_facts.reservations_v1 WHERE invocation_id = ${callKey} LIMIT 2`;
  } catch {
    throw unavailable();
  }
  const r = rows.length === 1 ? rows[0]! : null;
  const op = r?.operation as Record<string, unknown> | null | undefined;
  if (!r || r.invocation_id !== callKey || r.run_id !== runId || r.state !== 'UNKNOWN' || r.arguments_sha256 !== argumentsSha256 ||
      !op || typeof op !== 'object' || op.id !== operation.id || op.version !== operation.version) throw denied();
}

export interface OccurrenceFacts { scheduleId: string; generation: number; state: string; runBinding: unknown; createdAtMs: number }
export async function readOccurrence(tx: Tx, tenantId: string, occurrenceKey: string): Promise<OccurrenceFacts | null> {
  let rows: Record<string, unknown>[];
  try {
    rows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT schedule_id::text AS schedule_id, generation::text AS generation, state, run_binding,
             floor(extract(epoch FROM created_at) * 1000)::bigint::text AS created_at_ms
        FROM meri_read_delegation_facts.occurrences_v1 WHERE tenant_id = ${tenantId} AND occurrence_key = ${occurrenceKey} LIMIT 2`;
  } catch {
    throw unavailable();
  }
  if (rows.length !== 1) return null;
  const r = rows[0]!;
  if (!isUuid(r.schedule_id) || typeof r.state !== 'string') throw unavailable();
  return { scheduleId: r.schedule_id as string, generation: integer(r.generation), state: r.state, runBinding: r.run_binding, createdAtMs: integer(r.created_at_ms) };
}

/** `effect.binding` names this run: tenant, conversation and run equal, and any other binding field present equal too. */
export function occurrenceBindsRun(runBinding: unknown, d: Parameters<typeof runBindingOf>[0]): boolean {
  if (!runBinding || typeof runBinding !== 'object' || Array.isArray(runBinding)) return false;
  const b = runBinding as Record<string, unknown>, want = runBindingOf(d) as Record<string, unknown>;
  if (b.tenantId !== want.tenantId || b.conversationId !== want.conversationId || b.runId !== want.runId) return false;
  return Object.keys(b).every((k) => !Object.hasOwn(want, k) || b[k] === want[k]);
}

export interface ScheduleFacts { ownerActorId: string; generation: number; projectionSha256: string }
export async function readSchedule(tx: Tx, tenantId: string, scheduleId: string): Promise<ScheduleFacts | null> {
  let rows: Record<string, unknown>[];
  try {
    rows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT owner_actor_id::text AS owner_actor_id, generation::text AS generation, projection_sha256::text AS projection_sha256
        FROM meri_read_delegation_facts.schedules_v1 WHERE tenant_id = ${tenantId} AND schedule_id = ${scheduleId}::uuid LIMIT 2`;
  } catch {
    throw unavailable();
  }
  if (rows.length !== 1) return null;
  const r = rows[0]!;
  if (typeof r.owner_actor_id !== 'string' || !isSha(r.projection_sha256)) throw unavailable();
  return { ownerActorId: r.owner_actor_id, generation: integer(r.generation), projectionSha256: r.projection_sha256 as string };
}
