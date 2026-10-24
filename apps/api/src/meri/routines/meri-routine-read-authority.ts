import { ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@prisma/client';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import { isSha, isUuid } from '../../auth/read-delegation/read-delegation.contract.js';
import { meriExecutionDbNow } from '../execution-capability/meri-execution-authority.js';
import { fetchAccessibleClientRevisionsForClerkActor } from '../../memory/memory-wall.helpers.js';
import { nativeCanonicalSha256 as hash, parseRunBinding, parseScope, type NativeRunBinding } from '../native-approvals/native-approval.contract.js';
import { retainedReadObject, retainedReadSnapshot } from '../retained-read-context.js';
import type { RoutineLimits } from './meri-routine-policy.js';

const refused = () => new ForbiddenException('Routine read authority refused');
const object = (v: unknown): Record<string, any> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw refused();
  return v;
};
const same = isDeepStrictEqual;
const held = (state: unknown) => state === 'paused' || state === 'waiting-for-approval';
const active = (state: unknown) => ['queued', 'starting', 'running'].includes(String(state));
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
type ReadPurpose = 'current' | 'read';

function executionOf(row: Record<string, any>, binding: NativeRunBinding) {
  if (row.execution_record === null) {
    if ([row.execution_record_sha256, row.execution_key, row.execution_id].some(v => v !== null)) throw refused();
    return null;
  }
  const e = object(row.execution_record);
  if (hash(e) !== row.execution_record_sha256 || !same(e.binding, binding) || e.executionKey !== hash(binding) ||
      e.executionId !== e.executionKey || row.execution_key !== e.executionKey || row.execution_id !== e.executionId ||
      !isSha(e.planSha256) || !positive(e.expiresAtMs) || typeof e.runtimeSessionId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{32,255}$/.test(e.runtimeSessionId) ||
      !['launching', 'started', 'unknown', 'stopping', 'settled'].includes(e.phase)) throw refused();
  if (e.phase === 'settled') {
    const native = object(e.native);
    if (!['completed', 'failed', 'cancelled', 'paused', 'waiting-for-approval'].includes(native.state) ||
        Object.hasOwn(native, 'stopped') && native.stopped !== true) throw refused();
  } else if (e.native !== null) throw refused();
  return e;
}

/** Full run enumeration prevents a hidden fork, new prompt or incomplete edge
 * from nominating a current reader. Private request/file equality stays in SQL. */
async function readLineage(tx: Prisma.TransactionClient, q: RoutineReadSelection, origin: Record<string, any>, purpose: ReadPurpose, nowMs: number) {
  const rows = await tx.$queryRaw<Array<Record<string, any>>>`
    SELECT tenant_id, schedule_id, occurrence_key, conversation_id, run_id,
      run_projection, run_projection_sha256, request_sha256, execution_record, execution_record_sha256, execution_key, execution_id,
      initial_input, initial_input_sha256, initial_input_state, accepted_request_sha256, continuation, control,
      source_request_matches, target_request_matches, proof_matches, sequence_contiguous,
      outgoing_controls, next_run_reservation, next_run_reservation_sha256, next_run_state
    FROM meri_read_delegation_facts.routine_resume_steps_v1
    WHERE tenant_id = ${q.tenantId}::text AND schedule_id = ${q.scheduleId}::uuid AND occurrence_key = ${q.occurrenceKey}::text
    ORDER BY (run_projection#>>'{binding,writerFence}')::numeric LIMIT 101`;
  if (!rows.length || rows.length > 100) throw refused();
  const root = object(origin.run_projection), initial = object(rows[0]!.initial_input), rootBinding = parseRunBinding(root.binding, 'origin.binding');
  if (!same(rows[0]!.run_projection, root) || !same(rows[0]!.execution_record, origin.execution_record) ||
      rows[0]!.initial_input_state !== 'ACCEPTED' || hash(initial) !== rows[0]!.initial_input_sha256 ||
      !same(initial.binding, rootBinding) || !same(initial.scopes, root.scopes) || !same(initial.versions, root.versions) ||
      initial.requestId !== origin.effect.requestId || !isSha(initial.inputSha256) ||
      initial.requestSha256 !== rows[0]!.request_sha256 || initial.requestSha256 !== rows[0]!.accepted_request_sha256 ||
      !Number.isSafeInteger(initial.allocatedAtMs) || initial.allocatedAtMs < 0 || initial.allocatedAtMs > nowMs ||
      !positive(initial.expiresAtMs) || initial.expiresAtMs <= initial.allocatedAtMs ||
      root.createdAt !== new Date(initial.allocatedAtMs).toISOString() ||
      origin.current_writer !== (rows.length === 1) || origin.no_successor !== (rows.length === 1)) throw refused();
  const selectedClientId = initial.selectedClientId;
  if (selectedClientId === null ? root.scopes.length !== 1 || root.scopes[0].kind !== 'private-user' || root.scopes[0].resourceId !== rootBinding.actorId
    : !isUuid(selectedClientId) || !root.scopes.some((s: any) => s.kind === 'client' && s.resourceId === selectedClientId)) throw refused();
  const steps = rows.map((row, index) => {
    const run = object(row.run_projection), binding = parseRunBinding(run.binding, 'run.binding');
    if (row.tenant_id !== q.tenantId || row.schedule_id !== q.scheduleId || row.occurrence_key !== q.occurrenceKey ||
        row.conversation_id !== rootBinding.conversationId || row.run_id !== binding.runId || hash(run) !== row.run_projection_sha256 ||
        !isSha(row.request_sha256) || binding.tenantId !== rootBinding.tenantId || binding.actorId !== rootBinding.actorId ||
        binding.conversationId !== rootBinding.conversationId || binding.writerFence !== index + 1 ||
        !same(run.scopes, root.scopes) || !same(run.versions, root.versions) || run.policyRevision !== root.policyRevision ||
        !Array.isArray(row.outgoing_controls) || row.outgoing_controls.length > 1) throw refused();
    if (index === 0 ? !same(binding, rootBinding) || row.continuation !== null || row.control !== null
      : [row.initial_input, row.initial_input_sha256, row.initial_input_state, row.accepted_request_sha256].some(v => v !== null)) throw refused();
    return { row, run, binding, execution: executionOf(row, binding) };
  });
  let dispatching = false;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!, next = steps[index + 1];
    if (!next) {
      if ([step.row.next_run_reservation, step.row.next_run_reservation_sha256, step.row.next_run_state].some(v => v !== null)) throw refused();
      if (step.row.outgoing_controls.length) {
        const outgoing = object(step.row.outgoing_controls[0]);
        // Lifecycle refreshes source authority after begin and before committing
        // its target. This metadata-only lookup cannot authorize a tool read.
        if (purpose !== 'current' || !held(step.run.state) || !isUuid(outgoing.controlId) ||
            !['PENDING', 'DISPATCHING'].includes(outgoing.state) || !same(outgoing, {
              controlId: outgoing.controlId, intent: 'resume', state: outgoing.state, targetBinding: null, retirementBinding: null,
            })) throw refused();
      }
      continue;
    }
    const c = object(next.row.control), e = object(next.row.continuation), target = object(c.target), retirement = object(c.retirement);
    const input = object(c.input), session = object(e.sdkSession), key = object(session.key), outgoing = step.row.outgoing_controls[0];
    const reservation = object(step.row.next_run_reservation);
    dispatching = c.state === 'DISPATCHING';
    if (c.state !== 'APPLIED' && !(purpose === 'current' && dispatching && index === steps.length - 2) ||
        !held(step.run.state) || step.execution?.phase !== 'settled' || step.execution.native.state !== step.run.state ||
        ['runId', 'attemptId', 'workerId'].some(k => next.binding[k as keyof NativeRunBinding] === step.binding[k as keyof NativeRunBinding]) ||
        !same(c.sourceBinding, step.binding) || !same(target.binding, next.binding) || !same(retirement.binding, step.binding) ||
        !same(c.scopes, root.scopes) || !same(target.scopes, root.scopes) || c.sourceSelectedClientId !== selectedClientId || target.selectedClientId !== selectedClientId ||
        !same(c.versions, root.versions) || !same(target.versions, root.versions) || !positive(c.captureSequence) ||
        !isUuid(target.admissionReceiptId) || !isUuid(retirement.retirementReceiptId) || !positive(target.expiresAtMs) || !positive(retirement.expiresAtMs) ||
        input.intent !== 'resume' || !isUuid(input.controlId) || hash(input) !== c.inputSha256 ||
        input.checkpointId !== step.binding.runId || c.checkpointId !== input.checkpointId || !isSha(input.checkpointSha256) ||
        e.kind !== 'native-session' || e.mode !== 'resume' || e.controlId !== input.controlId || e.targetSessionId !== null || target.targetSessionId !== null ||
        !same(session.binding, step.binding) || !isSha(session.ownerSha256) || !positive(session.entriesCount) || session.entriesCount > 100000 ||
        typeof key.projectKey !== 'string' || !key.projectKey || key.projectKey.length > 256 || !isUuid(key.sessionId) || Object.hasOwn(key, 'subpath') ||
        !same(e.scopes, root.scopes) || !same(e.versions, root.versions) || !isSha(e.contextSha256) || e.contextSha256 !== c.contextSha256 ||
        e.sourceRequestSha256 !== step.row.request_sha256 || c.sourceRequestSha256 !== step.row.request_sha256 ||
        ['source_request_matches', 'target_request_matches', 'proof_matches', 'sequence_contiguous'].some(k => next.row[k] !== true) ||
        !same(outgoing, { controlId: input.controlId, intent: 'resume', state: c.state, targetBinding: next.binding, retirementBinding: step.binding }) ||
        step.row.next_run_state !== 'ACCEPTED' || hash(reservation) !== step.row.next_run_reservation_sha256 ||
        !same(reservation.source, step.binding) || !same(reservation.target, next.binding) || !same(reservation.scopes, root.scopes) ||
        !same(reservation.versions, root.versions) || reservation.policyRevision !== root.policyRevision || reservation.reservedAt !== next.run.createdAt ||
        !same(reservation.facts, { checkpoint: null, execution: { recordSha256: step.row.execution_record_sha256 } })) throw refused();
    if (dispatching && (target.expiresAtMs <= nowMs || retirement.expiresAtMs <= nowMs)) throw refused();
  }
  const head = steps.at(-1)!, source = dispatching ? steps.at(-2)! : null;
  const selected = same(q.binding, head.binding) ? head : purpose === 'current' && source && same(q.binding, source.binding) ? source : null;
  if (!selected) throw refused();
  const completedResume = steps.length > 1 && ['completed', 'failed'].includes(selected.run.state);
  if (purpose === 'current' && selected === head && (dispatching || completedResume)) {
    // A fast invocation can settle before commit acknowledgement or its APPLIED
    // receipt readback. These lifecycle lookups still confer no read authority.
    if (!active(selected.run.state) && !held(selected.run.state) && !completedResume) throw refused();
  } else if (purpose === 'read' || !held(selected.run.state)) {
    if (!active(selected.run.state) || !selected.execution || !['launching', 'started', 'unknown'].includes(selected.execution.phase) || selected.execution.expiresAtMs <= nowMs) throw refused();
  }
  const lineageSha256 = hash(steps.map(s => [s.binding, s.row.request_sha256, s.row.initial_input_sha256, s.row.continuation, s.row.control, s.row.next_run_reservation_sha256]));
  return { ...selected, initial, lineageSha256 };
}

export interface RoutineReadSelection {
  schemaVersion: 1; tenantId: string; scheduleId: string; occurrenceKey: string; binding: NativeRunBinding;
}

export function routineReadRequest(raw: unknown, read: boolean): RoutineReadSelection & Record<string, unknown> {
  const v = retainedReadSnapshot(retainedReadObject(raw, ['schemaVersion', 'tenantId', 'scheduleId', 'occurrenceKey', 'binding',
    ...(read ? ['operation', 'input', 'context'] : [])]), 65_536);
  if (v.schemaVersion !== 1 || !isUuid(v.tenantId) || !isUuid(v.scheduleId) || !isSha(v.occurrenceKey)) throw refused();
  const binding = parseRunBinding(v.binding, 'binding');
  if (binding.tenantId !== v.tenantId) throw refused();
  if (read && (typeof v.operation !== 'string' || !/^[a-z][A-Za-z0-9_.]{1,95}$/.test(v.operation))) throw refused();
  return { ...v, schemaVersion: 1 as const, tenantId: v.tenantId, scheduleId: v.scheduleId, occurrenceKey: v.occurrenceKey, binding };
}

function originalUuid(key: string, label: string): string {
  const h = createHash('sha256').update(`meri.schedule.occurrence.v1\0${key}\0${label}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Read-only projection of the existing schedule and AgentCore journals. The
 * runtime owns signed firing admission; this owner never creates a run/grant. */
export async function readRoutineSubject(tx: Prisma.TransactionClient, q: RoutineReadSelection, purpose: ReadPurpose = 'read') {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(
    hashtextextended('capiro-meri-routine:' || ${q.tenantId}::text || ':' || ${q.scheduleId}::text, 0::bigint))::text AS locked`;
  const nowMs = await meriExecutionDbNow(tx);
  const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
    SELECT tenant_id, schedule_id, occurrence_key, owner_actor_id, generation, projection, projection_sha256,
      active_intent, occurrence, effect, effect_sha256, occurrence_state, run_projection, run_projection_sha256,
      execution_record, execution_record_sha256, execution_key, execution_id, current_writer, no_successor
    FROM meri_read_delegation_facts.routine_runs_v1
    WHERE tenant_id = ${q.tenantId}::text AND schedule_id = ${q.scheduleId}::uuid AND occurrence_key = ${q.occurrenceKey}::text`;
  if (rows.length !== 1) throw refused();
  const r = rows[0]!, p = object(r.projection), o = object(r.occurrence), effect = object(r.effect);
  const originalRun = object(r.run_projection), execution = object(r.execution_record), generation = Number(r.generation);
  const originalBinding = parseRunBinding(effect.binding, 'effect.binding');
  const binding = originalBinding;
  if (r.tenant_id !== q.tenantId || r.schedule_id !== q.scheduleId || r.occurrence_key !== q.occurrenceKey ||
      r.owner_actor_id !== binding.actorId || !Number.isSafeInteger(generation) || generation < 1 ||
      r.active_intent !== null || r.occurrence_state !== 'OPEN' ||
      hash(p) !== r.projection_sha256 || hash(effect) !== r.effect_sha256 || hash(originalRun) !== r.run_projection_sha256 ||
      hash(execution) !== r.execution_record_sha256 ||
      !isDeepStrictEqual(originalRun.binding, binding) || !isDeepStrictEqual(execution.binding, binding) ||
      p.scheduleId !== q.scheduleId || p.state !== 'active' || p.owner?.tenantId !== q.tenantId || p.owner?.actorId !== binding.actorId ||
      o.generation !== generation || !isDeepStrictEqual(o.projection, p) || o.temporalScheduleId !== p.temporalScheduleId ||
      !isSha(execution.planSha256) || !Number.isSafeInteger(execution.expiresAtMs) ||
      execution.executionKey !== hash(binding) || execution.executionId !== execution.executionKey ||
      r.execution_key !== execution.executionKey || r.execution_id !== execution.executionId) throw refused();
  const identity = { tenantId: q.tenantId, actorId: binding.actorId, scheduleId: q.scheduleId,
    temporalScheduleId: o.temporalScheduleId, generation, workflowId: o.workflowId, scheduledAt: o.scheduledAt };
  if (hash(identity) !== q.occurrenceKey || binding.writerFence !== 1 ||
      !['conversation', 'run', 'attempt', 'worker'].every(k => binding[`${k}Id` as keyof NativeRunBinding] === originalUuid(q.occurrenceKey, k)) ||
      !isDeepStrictEqual(effect, { binding, requestId: originalUuid(q.occurrenceKey, 'request'),
        eventId: originalUuid(q.occurrenceKey, 'event'),
        workflowId: `meri:${binding.tenantId}:${binding.conversationId}:${binding.runId}` })) throw refused();
  if (!Array.isArray(originalRun.scopes) || !originalRun.scopes.length || originalRun.scopes.length > 100) throw refused();
  const lineage = await readLineage(tx, q, r, purpose, nowMs), run = lineage.run;
  const scopes: ReturnType<typeof parseScope>[] = run.scopes.map((s: unknown) => parseScope(s, 'scope'));
  if (!isDeepStrictEqual(scopes, p.scopes) || scopes.some(s => s.tenantId !== q.tenantId || s.policyRevision !== run.policyRevision ||
      s.kind === 'private-user' && s.resourceId !== binding.actorId)) throw refused();
  const consent = await tx.clioMeriRoutineConsent.findFirst({ where: { tenantId: q.tenantId, ownerUserId: binding.actorId,
    scheduleId: q.scheduleId, generation, projectionSha256: String(r.projection_sha256), expiresAt: { gt: new Date(nowMs) } },
    orderBy: { issuedAt: 'desc' } });
  if (!consent || consent.policyRevision !== run.policyRevision || !isDeepStrictEqual(consent.scopes, scopes) ||
      consent.issuedAt.getTime() > nowMs || await tx.clioMeriRoutineConsentRevocation.findFirst({
        where: { tenantId: q.tenantId, scheduleId: q.scheduleId, revokedAt: { gte: consent.issuedAt } } })) throw refused();
  const limits = object(consent.limits) as unknown as RoutineLimits;
  if (![limits.maxCostMicrousd, limits.maxRuntimeSeconds].every(n => Number.isSafeInteger(n) && n > 0) ||
      !Number.isSafeInteger(limits.retryLimit) || limits.retryLimit < 0 ||
      limits.maxRuntimeSeconds !== p.maxRuntimeSeconds || limits.maxCostMicrousd !== p.maxCostMicrousd || limits.retryLimit !== p.retryLimit) throw refused();
  const effectExpiresAtMs = Math.min(lineage.initial.expiresAtMs, consent.expiresAt.getTime(),
    lineage.initial.allocatedAtMs + limits.maxRuntimeSeconds * 1000,
    (purpose === 'read' || active(lineage.run.state)) && lineage.execution ? lineage.execution.expiresAtMs : Infinity);
  if (!Number.isSafeInteger(effectExpiresAtMs) || effectExpiresAtMs <= nowMs) throw refused();
  const member = await tx.tenantMembership.findFirst({ where: { tenantId: q.tenantId, userId: binding.actorId, status: 'active' }, include: { tenant: true } });
  const user = await tx.user.findUnique({ where: { id: binding.actorId }, select: { id: true, clerkUserId: true } });
  if (!member || !user?.clerkUserId || member.tenant.status !== 'active' || !Object.hasOwn(ROLE_RANK, member.role) ||
      ROLE_RANK[member.role as TenantRole] < ROLE_RANK.standard_user) throw refused();
  const clients = await fetchAccessibleClientRevisionsForClerkActor(tx, q.tenantId, user.clerkUserId, 4097);
  if (clients.length > 4096 || clients.some(c => !isUuid(c.id))) throw refused();
  const clientIds = clients.map(c => c.id).sort();
  if (scopes.some(s => s.kind === 'client' && !clientIds.includes(s.resourceId))) throw refused();
  const ctx: TenantContext = { tenantId: q.tenantId, tenantSlug: member.tenant.slug, userId: binding.actorId,
    clerkUserId: user.clerkUserId, role: member.role as TenantRole };
  return { schemaVersion: 1 as const, tenantId: q.tenantId, actorId: binding.actorId, clerkUserId: ctx.clerkUserId,
    tenantSlug: ctx.tenantSlug, role: ctx.role, scheduleId: q.scheduleId, occurrenceKey: q.occurrenceKey,
    generation, consentId: consent.consentId, binding: lineage.binding, scopes, clientIds, policyRevision: String(run.policyRevision),
    limits, checkedAtMs: nowMs, effectExpiresAtMs, lineageSha256: lineage.lineageSha256 };
}
