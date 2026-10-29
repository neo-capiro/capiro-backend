/**
 * MB-05 routine source-event custody read (finite slice, Core side).
 *
 * The one service-identity route the source-event receiver may call:
 * `POST /api/internal/routines/source-events/current` on the EXISTING `internal/routines`
 * controller (`InternalServiceGuard`, already registered in meri.module.ts and already admitted
 * by tenant-context by the `/api/internal` prefix — no auth, middleware or registry change).
 *
 * It answers with the canonical immutable alert, its current watch/owner/membership/client wall
 * and the EXACT saved routine consent, re-read in one tenant transaction. Nothing here is
 * authority and nothing is created: a caller-supplied owner, scope, client or producer claim is
 * never echoed, and the event hash it returns is derived from Core's OWN rows, so a producer
 * that sent different bytes is refused by the receiver's hash agreement rather than trusted.
 *
 * Only states Core custody can actually establish are reported. `sourceState` is derived from
 * the watch's own source-state row and the prospect's dismissal — never invented — and Meri
 * skips (dispatches nothing) for anything that is not `current`.
 */
import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ROLE_RANK, type TenantRole } from '@capiro/shared';
import { isUuid } from '../../auth/read-delegation/read-delegation.contract.js';
import { fetchAccessibleClientRevisionsForClerkActor } from '../../memory/memory-wall.helpers.js';
import { meriExecutionDbNow } from '../execution-capability/meri-execution-authority.js';
import {
  SOURCE_EVENT_FAMILIES, SOURCE_EVENT_PRODUCER, SOURCE_EVENT_PROTOCOL,
  sourceEventFactHash, sourceEventFacts, type SourceEventAlertFacts, type SourceEventSourceFacts,
} from '../../business-development/bizdev-watch-source-event.js';

/** The receipt is a short-lived read of custody; every fact it carries is re-checked by Meri. */
export const SOURCE_EVENT_RECEIPT_WINDOW_MS = 30_000;
export const SOURCE_EVENT_WATCH_STATES = Object.freeze(['active', 'paused', 'ended']);
export const SOURCE_EVENT_SOURCE_STATES = Object.freeze(['current', 'revoked', 'deleted', 'superseded']);
export const SOURCE_EVENT_CONSENT_STATES = Object.freeze(['active', 'revoked', 'expired']);

const HEX64 = /^[a-f0-9]{64}$/;
const refused = (field: string) => new ConflictException(`Routine source event refused: ${field}`);

export interface RoutineSourceEventRequest {
  schemaVersion: 1; producer: string; tenantId: string; eventId: string; eventHash: string;
  scheduleId: string; generation: number;
}

/** The closed service-identity request body. Any unexpected key is a refusal. */
export function parseRoutineSourceEventRequest(raw: unknown): RoutineSourceEventRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)) throw refused('body');
  const value = raw as Record<string, unknown>;
  const keys = ['schemaVersion', 'producer', 'tenantId', 'eventId', 'eventHash', 'scheduleId', 'generation'];
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) throw refused('body');
  if (value.schemaVersion !== 1) throw refused('schemaVersion');
  if (value.producer !== SOURCE_EVENT_PRODUCER) throw refused('producer');
  for (const key of ['tenantId', 'eventId', 'scheduleId'] as const) {
    const candidate = value[key];
    if (typeof candidate !== 'string' || !isUuid(candidate)) throw refused(key);
  }
  if (typeof value.eventHash !== 'string' || !HEX64.test(value.eventHash)) throw refused('eventHash');
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1) throw refused('generation');
  return {
    schemaVersion: 1, producer: SOURCE_EVENT_PRODUCER, tenantId: value.tenantId as string, eventId: (value.eventId as string).toLowerCase(),
    eventHash: value.eventHash, scheduleId: (value.scheduleId as string).toLowerCase(), generation: value.generation as number,
  };
}

export interface RoutineSourceEventReceipt {
  schemaVersion: 1; producer: string; tenantId: string; eventId: string; eventHash: string;
  alert: SourceEventAlertFacts & SourceEventSourceFacts;
  watch: { ownerActorId: string; status: string; membership: string; clientId: string | null; sourceState: string };
  consent: { consentId: string | null; state: string; expiresAtMs: number };
  checkedAtMs: number; expiresAtMs: number;
}

/** The exact saved consent for one routine generation, revoked and expired states included. */
async function readSavedConsent(
  tx: Prisma.TransactionClient, tenantId: string, scheduleId: string, generation: number, nowMs: number,
): Promise<RoutineSourceEventReceipt['consent']> {
  const consent = await tx.clioMeriRoutineConsent.findFirst({
    where: { tenantId, scheduleId, generation },
    orderBy: { issuedAt: 'desc' },
  });
  if (!consent) return { consentId: null, state: 'expired', expiresAtMs: 0 };
  const expiresAtMs = consent.expiresAt.getTime();
  const revoked = await tx.clioMeriRoutineConsentRevocation.findFirst({
    where: { tenantId, scheduleId, revokedAt: { gte: consent.issuedAt } },
  });
  if (revoked) return { consentId: consent.consentId, state: 'revoked', expiresAtMs };
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) return { consentId: consent.consentId, state: 'expired', expiresAtMs };
  return { consentId: consent.consentId, state: 'active', expiresAtMs };
}

/** The owner's CURRENT membership and client wall, read in the same tenant transaction. */
async function readOwnerAuthority(
  tx: Prisma.TransactionClient, tenantId: string, ownerActorId: string, clientId: string | null,
): Promise<'active' | 'inactive'> {
  const member = await tx.tenantMembership.findFirst({
    where: { tenantId, userId: ownerActorId, status: 'active' }, include: { tenant: true },
  });
  if (!member || member.tenant.status !== 'active' || !Object.hasOwn(ROLE_RANK, member.role) ||
      ROLE_RANK[member.role as TenantRole] < ROLE_RANK.standard_user) return 'inactive';
  if (clientId === null) return 'active';
  const user = await tx.user.findUnique({ where: { id: ownerActorId }, select: { clerkUserId: true } });
  if (!user?.clerkUserId) return 'inactive';
  const wall = await fetchAccessibleClientRevisionsForClerkActor(tx, tenantId, user.clerkUserId, 4097);
  if (wall.length > 4096) return 'inactive';
  return wall.some((client) => client.id === clientId) ? 'active' : 'inactive';
}

/**
 * Re-read canonical custody for exactly one claimed producer event. The receipt always carries
 * Core's own facts; a claim that disagrees with them is refused by the receiver, not here.
 */
export async function readRoutineSourceEvent(
  tx: Prisma.TransactionClient, request: RoutineSourceEventRequest,
): Promise<RoutineSourceEventReceipt> {
  const alert = await tx.businessDevelopmentAlert.findFirst({
    where: { tenantId: request.tenantId, id: request.eventId },
    select: { id: true, watchId: true, prospectId: true, dedupeKey: true, fingerprint: true,
      sourceFamily: true, recordId: true, sourceRevision: true },
  });
  if (!alert) throw refused('alert');
  const watch = await tx.businessDevelopmentWatch.findFirst({
    where: { tenantId: request.tenantId, id: alert.watchId },
    select: { id: true, status: true, ownerUserId: true, prospect: { select: { id: true, linkedClientId: true, dismissedAt: true } } },
  });
  if (!watch) throw refused('watch');
  if (!SOURCE_EVENT_WATCH_STATES.includes(watch.status)) throw refused('watch.status');
  // The watch owner is the routine owner anchor; an ownerless watch has no owner authority to
  // read and therefore no receipt.
  const ownerActorId = watch.ownerUserId;
  if (typeof ownerActorId !== 'string' || !isUuid(ownerActorId)) throw refused('watch.owner');
  const sourceState = await readSourceState(tx, request.tenantId, watch.id, alert.sourceFamily, watch.prospect);
  const clientId = watch.prospect.linkedClientId === null || watch.prospect.dismissedAt !== null ? null : watch.prospect.linkedClientId;
  const membership = await readOwnerAuthority(tx, request.tenantId, ownerActorId, clientId);
  const nowMs = await meriExecutionDbNow(tx);
  const consent = await readSavedConsent(tx, request.tenantId, request.scheduleId, request.generation, nowMs);
  const facts = sourceEventFacts({
    tenantId: request.tenantId,
    alert: { alertId: alert.id, watchId: alert.watchId, prospectId: alert.prospectId, dedupeKey: alert.dedupeKey, fingerprint: alert.fingerprint },
    source: { sourceFamily: alert.sourceFamily, recordId: alert.recordId, sourceRevision: alert.sourceRevision },
  });
  const end = consent.state === 'active' ? Math.min(nowMs + SOURCE_EVENT_RECEIPT_WINDOW_MS, consent.expiresAtMs) : nowMs + SOURCE_EVENT_RECEIPT_WINDOW_MS;
  return {
    schemaVersion: 1, producer: request.producer, tenantId: facts.tenantId, eventId: alert.id,
    // Core's OWN fact digest, never the caller's claim.
    eventHash: sourceEventFactHash(facts),
    alert: { ...facts.alert, ...facts.source },
    watch: { ownerActorId, status: watch.status, membership, clientId, sourceState },
    consent,
    checkedAtMs: nowMs,
    expiresAtMs: Number.isSafeInteger(end) && end > nowMs ? end : nowMs + SOURCE_EVENT_RECEIPT_WINDOW_MS,
  };
}

/**
 * The source state of the ALERT's source family for this watch, from actual custody only:
 * a dismissed prospect revoked tracking, a missing source-state row means this watch no longer
 * tracks that family, and anything Core cannot establish is not reported as current.
 */
async function readSourceState(
  tx: Prisma.TransactionClient, tenantId: string, watchId: string, sourceFamily: string,
  prospect: { dismissedAt: Date | null },
): Promise<string> {
  if (!SOURCE_EVENT_FAMILIES.includes(sourceFamily)) throw refused('sourceFamily');
  if (prospect.dismissedAt !== null) return 'revoked';
  const state = await tx.businessDevelopmentWatchSourceState.findFirst({
    where: { tenantId, watchId, sourceFamily }, select: { id: true },
  });
  return state ? 'current' : 'superseded';
}

export { SOURCE_EVENT_PROTOCOL };
