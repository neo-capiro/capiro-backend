/**
 * MR-04 renewal (W5-02 MR-04): the owner's CURRENT unchanged approved routine
 * intent, re-approved by a NEW explicit attended decision, re-issues the saved
 * read consent as a new row through the SAME canonical writer.
 *
 * What this module is NOT. It is not a second consent writer, not a second
 * authority store, and not a policy owner: it writes nothing itself and it
 * re-implements none of `routineConsentEvent`'s semantics. `assertRoutineConsentRenewal`
 * only READS Core's own rows under the same schedule advisory lock and database
 * clock the writers use, and refuses unless the stored canonical consent still
 * pins exactly what the new approval would re-issue.
 *
 * Private protocol (trusted control service -> Core). The caller supplies the
 * IMMUTABLE INTENT BYTES it holds in custody plus a fresh attended approval; Core
 * never reconstructs an intent from digests. Body:
 *
 *   { schemaVersion: 1,
 *     selection: { phase: 'before_claim',
 *                  operation: 'schedule_task' | 'update_scheduled_task',   // a renewal never cancels
 *                  proposal: <prepared proposal, validated by routineConsentEvent>,
 *                  scheduleBinding: { intent, approval, callerIdentity, deadlineMs, bindingSha256 } } }
 *
 * `selection` is handed to `routineConsentEvent` VERBATIM, so the canonical owner
 * still decides the intent/approval identity, the projection digests, the scope
 * equality, the single policy revision, the limits ceiling and the approval's own
 * decision window. This module reads closed only the members the renewal fences
 * need (operation, generation, intent id, projection digests, projection scopes,
 * approval window end) so a malformed request fails at 400 before any database
 * access. Because the boundary is the tool-service identity plus the current
 * signed-in tenant context, no browser selects or forges that authority: the
 * caller identity and the approver must both be the current session principal.
 *
 * Fences that must hold before any mutation (assertRoutineConsentRenewal):
 *   * a stored consent exists — a renewal is never a first issuance;
 *   * the stored consent's intent id, generation, intent digest, projection digest
 *     and policy revision equal the ones the new approval re-issues (an unchanged
 *     pin set; a changed pin set is refused, never silently re-pinned);
 *   * the stored complete scope set and the stored limits are canonically equal
 *     (no scope or budget widening, no narrowing);
 *   * no revocation at or after the stored consent (paused/deleted is not resumed);
 *   * the owner is still an active member at or above `standard_user` of an active
 *     tenant and every ORIGINAL client scope is still on the owner's client wall.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { types as nodeTypes } from 'node:util';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { ROLE_RANK, type TenantRole } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { nativeCanonicalSha256, type NativeScope } from '../native-approvals/native-approval.contract.js';
import { meriExecutionClientsVisible, meriExecutionDbNow } from '../execution-capability/meri-execution-authority.js';
import type { RoutineLimits } from './meri-routine-policy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RENEWAL_OPERATIONS = ['schedule_task', 'update_scheduled_task'] as const;
const PROJECTION_KEYS = ['temporalScheduleId', 'timezone', 'maxCostMicrousd', 'maxRuntimeSeconds', 'retryLimit', 'destinationId', 'createdAt'];

const invalid = (field: string) => new BadRequestException(`Invalid routine consent renewal: ${field}`);
const forbidden = () => new ForbiddenException('Routine authority refused');

/** Same closed-record discipline as `meri-routines.contract.ts`: own string keys, no proxies. */
function record(value: unknown, required: readonly string[], optional: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) throw invalid(field);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw invalid(field);
  const keys = Reflect.ownKeys(value);
  if (keys.some((k) => typeof k !== 'string' || (!required.includes(k) && !optional.includes(k))) ||
      required.some((k) => !keys.includes(k))) throw invalid(field);
  return value as Record<string, unknown>;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(field);
  return value;
}

export interface RoutineConsentRenewalRequest {
  schemaVersion: 1;
  /** The wire-A `before_claim` envelope, passed to `routineConsentEvent` verbatim. */
  selection: unknown;
  operation: (typeof RENEWAL_OPERATIONS)[number];
  /** Digest of the exact immutable intent object the caller supplied (the same computation the owner makes). */
  intentSha256: string;
  projectionSha256: string;
  intentId: string;
  scheduleId: string;
  generation: number;
  /** The intent projection's own scope array, canonically compared by `routineConsentEvent`. */
  projectionScopes: unknown[];
  /** The fresh approval's decision window end: the attended receipt fence for the write. */
  approvalExpiresAtMs: number;
}

export function parseRoutineConsentRenewalRequest(value: unknown): RoutineConsentRenewalRequest {
  const v = record(value, ['schemaVersion', 'selection'], [], 'body');
  if (v.schemaVersion !== 1) throw invalid('schemaVersion');
  const selection = record(v.selection, ['phase', 'operation', 'proposal', 'scheduleBinding'], [], 'selection');
  if (selection.phase !== 'before_claim') throw invalid('selection.phase');
  if (!RENEWAL_OPERATIONS.includes(selection.operation as (typeof RENEWAL_OPERATIONS)[number])) throw invalid('selection.operation');
  if (!selection.proposal || typeof selection.proposal !== 'object' || Array.isArray(selection.proposal)) throw invalid('selection.proposal');
  const binding = record(selection.scheduleBinding, ['intent', 'approval', 'callerIdentity', 'deadlineMs', 'bindingSha256'], [], 'scheduleBinding');
  const intent = record(binding.intent, ['intentId', 'operation', 'projection'],
    ['expectedGeneration', 'generation', 'previousProjectionSha256', 'configuration', 'cancel', 'taskInstructionSha256'], 'intent');
  const operation = selection.operation as (typeof RENEWAL_OPERATIONS)[number];
  if (intent.operation !== operation) throw invalid('intent.operation');
  if (!Number.isSafeInteger(intent.generation) || (intent.generation as number) < 1) throw invalid('intent.generation');
  const projection = record(intent.projection, ['scheduleId', 'owner', 'scopes', 'state'], PROJECTION_KEYS, 'intent.projection');
  if (!Array.isArray(projection.scopes) || projection.scopes.length < 1 || projection.scopes.length > 100) throw invalid('intent.projection.scopes');
  const approval = record(binding.approval, ['proposalId', 'commandSha256', 'decision', 'decidedAt', 'expiresAt', 'approver', 'policyRevision'], [], 'approval');
  const approvalExpiresAtMs = typeof approval.expiresAt === 'string' ? Date.parse(approval.expiresAt) : NaN;
  if (!Number.isSafeInteger(approvalExpiresAtMs)) throw invalid('approval.expiresAt');
  return {
    schemaVersion: 1, selection: v.selection, operation,
    intentSha256: nativeCanonicalSha256(binding.intent), projectionSha256: nativeCanonicalSha256(intent.projection),
    intentId: uuid(intent.intentId, 'intent.intentId'), scheduleId: uuid(projection.scheduleId, 'intent.projection.scheduleId'),
    generation: intent.generation as number, projectionScopes: projection.scopes, approvalExpiresAtMs,
  };
}

/** The pinned pins the new approval would re-issue, taken from the canonically validated event. */
export interface RoutineConsentRenewalPins {
  tenantId: string;
  ownerActorId: string;
  scheduleId: string;
  intentId: string;
  generation: number;
  intentSha256: string;
  projectionSha256: string;
  policyRevision: string;
  scopes: readonly NativeScope[];
  limits: RoutineLimits;
}

export interface RoutineConsentRenewalFacts { consentId: string; issuedAtMs: number; expiresAtMs: number; observedAtMs: number }

/**
 * Serializes with every consent writer for this schedule (the same advisory key
 * `lockRoutineSchedule` takes), then verifies under the database clock that the
 * stored canonical consent still pins exactly these pins and that the owner's
 * current rights still cover the original scope set. Read-only: it writes nothing.
 */
export async function assertRoutineConsentRenewal(
  tx: Prisma.TransactionClient,
  pins: RoutineConsentRenewalPins,
): Promise<RoutineConsentRenewalFacts> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(
    hashtextextended('capiro-meri-routine:' || ${pins.tenantId}::text || ':' || ${pins.scheduleId}::text, 0::bigint))::text AS locked`;
  const nowMs = await meriExecutionDbNow(tx);
  const stored = await tx.clioMeriRoutineConsent.findFirst({
    where: { tenantId: pins.tenantId, ownerUserId: pins.ownerActorId, scheduleId: pins.scheduleId },
    orderBy: { issuedAt: 'desc' },
  });
  // A renewal is never a first issuance: the routine must already hold this owner's consent.
  if (!stored) throw forbidden();
  const scopes = stored.scopes as unknown as NativeScope[];
  const limits = stored.limits as unknown as RoutineLimits;
  if (stored.ownerUserId !== pins.ownerActorId || stored.intentId !== pins.intentId || stored.generation !== pins.generation ||
      stored.intentSha256 !== pins.intentSha256 || stored.projectionSha256 !== pins.projectionSha256 ||
      stored.policyRevision !== pins.policyRevision || stored.issuedAt.getTime() > nowMs ||
      canonicalizeCoreRetainedJson(scopes) !== canonicalizeCoreRetainedJson(pins.scopes) ||
      canonicalizeCoreRetainedJson(limits) !== canonicalizeCoreRetainedJson(pins.limits)) throw forbidden();
  const revoked = await tx.clioMeriRoutineConsentRevocation.findFirst({
    where: { tenantId: pins.tenantId, scheduleId: pins.scheduleId, revokedAt: { gte: stored.issuedAt } },
  });
  if (revoked) throw forbidden();
  const member = await tx.tenantMembership.findFirst({
    where: { tenantId: pins.tenantId, userId: pins.ownerActorId, status: 'active' },
    include: { tenant: true },
  });
  if (!member || member.tenant.status !== 'active' || !Object.hasOwn(ROLE_RANK, member.role) ||
      ROLE_RANK[member.role as TenantRole] < ROLE_RANK.standard_user) throw forbidden();
  const clients = [...new Set(scopes.filter((s) => s.kind === 'client').map((s) => s.resourceId.toLowerCase()))].sort();
  if (!(await meriExecutionClientsVisible(tx, pins.tenantId, pins.ownerActorId, clients))) throw forbidden();
  return { consentId: stored.consentId, issuedAtMs: stored.issuedAt.getTime(), expiresAtMs: stored.expiresAt.getTime(), observedAtMs: nowMs };
}

/**
 * The stored window that now applies to these pins, read back after the write.
 * On an exact replay the canonical writer's `skipDuplicates` keeps the FIRST row,
 * so this returns the original timestamps and the renewal extends nothing.
 */
export async function readRoutineConsentRenewalWindow(
  tx: Prisma.TransactionClient,
  pins: RoutineConsentRenewalPins,
  decisionSha256: string,
): Promise<{ issuedAtMs: number; expiresAtMs: number; decisionSha256: string }> {
  const stored = await tx.clioMeriRoutineConsent.findFirst({
    where: { tenantId: pins.tenantId, ownerUserId: pins.ownerActorId, scheduleId: pins.scheduleId, decisionSha256 },
  }) ?? await tx.clioMeriRoutineConsent.findFirst({
    where: { tenantId: pins.tenantId, ownerUserId: pins.ownerActorId, scheduleId: pins.scheduleId },
    orderBy: { issuedAt: 'desc' },
  });
  if (!stored) throw forbidden();
  return { issuedAtMs: stored.issuedAt.getTime(), expiresAtMs: stored.expiresAt.getTime(), decisionSha256: stored.decisionSha256 };
}

/** The recorded consent for one exact decision, used to report a replay honestly. */
export async function readRoutineConsentDecision(
  tx: Prisma.TransactionClient,
  tenantId: string,
  intentId: string,
  decisionSha256: string,
): Promise<boolean> {
  const recorded = await tx.clioMeriRoutineConsent.findFirst({ where: { tenantId, intentId, decisionSha256 } });
  return recorded !== null;
}
