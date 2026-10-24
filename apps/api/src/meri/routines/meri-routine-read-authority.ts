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
export async function readRoutineSubject(tx: Prisma.TransactionClient, q: RoutineReadSelection) {
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
  const run = object(r.run_projection), execution = object(r.execution_record), generation = Number(r.generation);
  const binding = parseRunBinding(effect.binding, 'effect.binding');
  if (r.tenant_id !== q.tenantId || r.schedule_id !== q.scheduleId || r.occurrence_key !== q.occurrenceKey ||
      r.owner_actor_id !== binding.actorId || !Number.isSafeInteger(generation) || generation < 1 ||
      r.active_intent !== null || r.occurrence_state !== 'OPEN' || r.current_writer !== true || r.no_successor !== true ||
      hash(p) !== r.projection_sha256 || hash(effect) !== r.effect_sha256 || hash(run) !== r.run_projection_sha256 ||
      hash(execution) !== r.execution_record_sha256 || !isDeepStrictEqual(binding, q.binding) ||
      !isDeepStrictEqual(run.binding, binding) || !isDeepStrictEqual(execution.binding, binding) ||
      p.scheduleId !== q.scheduleId || p.state !== 'active' || p.owner?.tenantId !== q.tenantId || p.owner?.actorId !== binding.actorId ||
      o.generation !== generation || !isDeepStrictEqual(o.projection, p) || o.temporalScheduleId !== p.temporalScheduleId ||
      !['queued', 'starting', 'running'].includes(run.state) || !['launching', 'started', 'unknown'].includes(execution.phase) ||
      execution.native !== null || !isSha(execution.planSha256) || !Number.isSafeInteger(execution.expiresAtMs) ||
      execution.executionKey !== hash(binding) || execution.executionId !== execution.executionKey ||
      r.execution_key !== execution.executionKey || r.execution_id !== execution.executionId) throw refused();
  const identity = { tenantId: q.tenantId, actorId: binding.actorId, scheduleId: q.scheduleId,
    temporalScheduleId: o.temporalScheduleId, generation, workflowId: o.workflowId, scheduledAt: o.scheduledAt };
  if (hash(identity) !== q.occurrenceKey || binding.writerFence !== 1 ||
      !['conversation', 'run', 'attempt', 'worker'].every(k => binding[`${k}Id` as keyof NativeRunBinding] === originalUuid(q.occurrenceKey, k)) ||
      !isDeepStrictEqual(effect, { binding, requestId: originalUuid(q.occurrenceKey, 'request'),
        eventId: originalUuid(q.occurrenceKey, 'event'),
        workflowId: `meri:${binding.tenantId}:${binding.conversationId}:${binding.runId}` })) throw refused();
  if (!Array.isArray(run.scopes) || !run.scopes.length || run.scopes.length > 100) throw refused();
  const scopes = run.scopes.map((s: unknown) => parseScope(s, 'scope'));
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
  const createdAt = typeof run.createdAt === 'string' ? Date.parse(run.createdAt) : NaN;
  const effectExpiresAtMs = Math.min(execution.expiresAtMs, consent.expiresAt.getTime(), createdAt + limits.maxRuntimeSeconds * 1000);
  if (!Number.isSafeInteger(createdAt) || createdAt > nowMs || !Number.isSafeInteger(effectExpiresAtMs) || effectExpiresAtMs <= nowMs) throw refused();
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
    generation, consentId: consent.consentId, binding, scopes, clientIds, policyRevision: String(run.policyRevision),
    limits, checkedAtMs: nowMs, effectExpiresAtMs };
}
