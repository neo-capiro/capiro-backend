/**
 * MR-04 visibility half (W5-02 MR-04, docs/handover/20261027/W5-02-M7-ROUTINES-SKILLS.md:145–157):
 * "Expose 'routine active, read consent unresolved/expired' distinctly from
 * successful unattended reads."
 *
 * A read-only observation of the owner's saved routine read consent for the
 * CURRENT authorized generation. It is not an authority decision: it writes no
 * consent, revocation, approval, lease or grant, signs nothing, and never
 * replaces or relaxes the existing fail-closed refusals in `unattendedGrant`
 * (wire C) or `readRoutineSubject`/`read` (the retained read owner). Those
 * owners remain the only answer to "may this fire / may this read".
 *
 * Caller. The current-authorized routines list owner (Meri control) supplies the
 * exact persisted schedule identity plus the generation, intent and projection
 * digests it already holds. The request carries NO scope and NO client selector,
 * so a caller can never widen, narrow or substitute the approved scope set: the
 * observation reads the original approved scopes from the consent row itself and
 * re-checks every one of them against the owner's current client wall.
 *
 * Matching. Only a consent row for the requested generation AND intent digest AND
 * projection digest can be reported `active`; an older generation's consent is
 * reported `absent` for the requested pins (never `active`) with the nearest
 * row's generation and window for honest diagnosis.
 *
 * Clock and rights. The database clock on the caller's transaction is the
 * reference instant, and the owner's current membership (active member of an
 * active tenant, role at or above `standard_user`) and every contributing client
 * scope are re-checked before any `active` answer is returned.
 *
 * Unknown is not absence. A database/transport failure propagates to the caller;
 * this module never converts a failed read into a fabricated `absent`.
 *
 * Output. Closed, finite and free of consent payloads and private identity: no
 * scope array, no intent/decision digests, no consent or intent id, no user id.
 * Only state, the matched pins' generation and window, a scope COUNT and a
 * digest of the currently checked rights (`rightsSha256`).
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { types as nodeTypes } from 'node:util';
import type { Prisma } from '@prisma/client';
import { ROLE_RANK, type TenantRole } from '@capiro/shared';
import { nativeCanonicalSha256, type NativeScope } from '../native-approvals/native-approval.contract.js';
import { meriExecutionClientsVisible, meriExecutionDbNow } from '../execution-capability/meri-execution-authority.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;

const invalid = (field: string) => new BadRequestException(`Invalid routine consent observation: ${field}`);
const forbidden = () => new ForbiddenException('Routine authority refused');

/** The closed request. Same discipline as `meri-routines.contract.ts`'s record(): own string keys, no proxies. */
function record(value: unknown, required: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) throw invalid(field);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw invalid(field);
  const keys = Reflect.ownKeys(value);
  if (keys.some((k) => typeof k !== 'string' || !required.includes(k)) || required.some((k) => !keys.includes(k))) throw invalid(field);
  return value as Record<string, unknown>;
}

export interface RoutineConsentObservationRequest {
  schemaVersion: 1;
  tenantId: string;
  ownerActorId: string;
  scheduleId: string;
  /** The generation the caller currently persists for this schedule. */
  generation: number;
  intentSha256: string;
  projectionSha256: string;
}

export type RoutineConsentObservationState = 'active' | 'expired' | 'revoked' | 'absent';
/** Why a matched, unexpired consent is not currently usable. `revocation` is an attended pause/delete. */
export type RoutineConsentRevocationCause = 'revocation' | 'membership' | 'client-scope';

export interface RoutineConsentObservation {
  schemaVersion: 1;
  state: RoutineConsentObservationState;
  /** True only when the newest consent for this owner+schedule matched every requested pin. */
  pinsMatched: boolean;
  observedAtMs: number;
  /** Echo of the requested (current) generation. */
  generation: number;
  /** The newest consent row's generation, or null when this owner has no consent for this schedule. */
  consentGeneration: number | null;
  issuedAtMs: number | null;
  expiresAtMs: number | null;
  /** Count only — the approved scope payload is never returned. */
  scopeCount: number | null;
  cause: RoutineConsentRevocationCause | null;
  /** Digest of the currently checked rights; present only for `active`. */
  rightsSha256: string | null;
}

export function parseRoutineConsentObservationRequest(value: unknown): RoutineConsentObservationRequest {
  const v = record(value, ['schemaVersion', 'tenantId', 'ownerActorId', 'scheduleId', 'generation', 'intentSha256', 'projectionSha256'], 'body');
  if (v.schemaVersion !== 1) throw invalid('schemaVersion');
  for (const key of ['tenantId', 'ownerActorId', 'scheduleId']) {
    if (typeof v[key] !== 'string' || !UUID.test(v[key] as string)) throw invalid(key);
  }
  if (!Number.isSafeInteger(v.generation) || (v.generation as number) < 1) throw invalid('generation');
  for (const key of ['intentSha256', 'projectionSha256']) {
    if (typeof v[key] !== 'string' || !HEX64.test(v[key] as string)) throw invalid(key);
  }
  return { schemaVersion: 1, tenantId: v.tenantId as string, ownerActorId: v.ownerActorId as string, scheduleId: v.scheduleId as string,
    generation: v.generation as number, intentSha256: v.intentSha256 as string, projectionSha256: v.projectionSha256 as string };
}

/**
 * Serializes against the consent writers for one schedule (same advisory key as
 * `lockRoutineSchedule`), then answers from Core's own rows under the database
 * clock. Read-only: no row is created, changed or deleted on any path.
 */
export async function readRoutineConsentObservation(
  tx: Prisma.TransactionClient,
  q: RoutineConsentObservationRequest,
): Promise<RoutineConsentObservation> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(
    hashtextextended('capiro-meri-routine:' || ${q.tenantId}::text || ':' || ${q.scheduleId}::text, 0::bigint))::text AS locked`;
  const nowMs = await meriExecutionDbNow(tx);
  // Core's own attended approval is the only durable owner assertion it holds for a schedule.
  // A schedule recorded for another owner is a foreign request, never an absence.
  const attendance = await tx.clioMeriRoutineApproval.findFirst({
    where: { tenantId: q.tenantId, scheduleId: q.scheduleId },
    select: { ownerUserId: true },
  });
  if (attendance && attendance.ownerUserId !== q.ownerActorId) throw forbidden();
  const base = { schemaVersion: 1 as const, observedAtMs: nowMs, generation: q.generation };
  const consent = await tx.clioMeriRoutineConsent.findFirst({
    where: { tenantId: q.tenantId, ownerUserId: q.ownerActorId, scheduleId: q.scheduleId },
    orderBy: { issuedAt: 'desc' },
  });
  if (!consent) {
    return { ...base, state: 'absent', pinsMatched: false, consentGeneration: null, issuedAtMs: null, expiresAtMs: null,
      scopeCount: null, cause: null, rightsSha256: null };
  }
  const issuedAtMs = consent.issuedAt.getTime(), expiresAtMs = consent.expiresAt.getTime();
  const scopes = Array.isArray(consent.scopes) ? (consent.scopes as unknown as NativeScope[]) : null;
  const found = { ...base, consentGeneration: consent.generation, issuedAtMs, expiresAtMs, scopeCount: scopes === null ? null : scopes.length };
  const pinsMatched = consent.generation === q.generation && consent.intentSha256 === q.intentSha256 &&
    consent.projectionSha256 === q.projectionSha256;
  if (!pinsMatched) {
    // An older generation's consent can never look active for the current pins.
    return { ...found, state: 'absent', pinsMatched: false, cause: null, rightsSha256: null };
  }
  // Mirrors the canonical reader: a row issued in the future is not current authority.
  if (issuedAtMs > nowMs) throw forbidden();
  if (scopes === null || scopes.length < 1 || scopes.some((s) => !s || typeof s !== 'object' || s.tenantId !== q.tenantId)) throw forbidden();
  const revoked = await tx.clioMeriRoutineConsentRevocation.findFirst({
    where: { tenantId: q.tenantId, scheduleId: q.scheduleId, revokedAt: { gte: consent.issuedAt } },
  });
  if (revoked) return { ...found, state: 'revoked', pinsMatched: true, cause: 'revocation', rightsSha256: null };
  if (expiresAtMs <= nowMs) return { ...found, state: 'expired', pinsMatched: true, cause: null, rightsSha256: null };
  const member = await tx.tenantMembership.findFirst({
    where: { tenantId: q.tenantId, userId: q.ownerActorId, status: 'active' },
    include: { tenant: true },
  });
  if (!member || member.tenant.status !== 'active' || !Object.hasOwn(ROLE_RANK, member.role) ||
      ROLE_RANK[member.role as TenantRole] < ROLE_RANK.standard_user) {
    return { ...found, state: 'revoked', pinsMatched: true, cause: 'membership', rightsSha256: null };
  }
  const clients = [...new Set(scopes.filter((s) => s.kind === 'client').map((s) => s.resourceId.toLowerCase()))].sort();
  if (!(await meriExecutionClientsVisible(tx, q.tenantId, q.ownerActorId, clients))) {
    return { ...found, state: 'revoked', pinsMatched: true, cause: 'client-scope', rightsSha256: null };
  }
  return { ...found, state: 'active', pinsMatched: true, cause: null,
    rightsSha256: nativeCanonicalSha256({ role: member.role, status: member.status, tenantStatus: member.tenant.status, clients }) };
}
