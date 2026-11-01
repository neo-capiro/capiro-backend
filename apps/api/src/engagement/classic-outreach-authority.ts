import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { ownOutreachRecordWhere } from './engagement-access.helpers.js';
import { currentMeetingActor } from './meeting-resource-authority.js';
import { assertSavedMeetingPrepAccess } from './meeting-prep-source-access.js';

type Child = { id: string; tenantId?: string; clientId: string | null; createdAt?: Date; generatedFrom?: unknown };
export type OutreachAssociation = {
  id?: string;
  updatedAt?: Date;
  clientId: string | null;
  meetingId: string | null;
  meeting?: { id: string; tenantId?: string; clientId: string | null; preps: Child[]; debriefs: Child[] } | null;
};

export async function outreachClientReadable(tx: Prisma.TransactionClient, ctx: TenantContext, clientId: string | null) {
  if (clientId === null) return true;
  const client = await tx.client.findFirst({
    where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } }, select: { id: true },
  });
  return Boolean(client) && clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId);
}

export async function assertOutreachClientsReadable(
  tx: Prisma.TransactionClient, ctx: TenantContext, clientIds: readonly string[], message = 'Client not found',
) {
  for (const id of clientIds) if (!await outreachClientReadable(tx, ctx, id)) throw new NotFoundException(message);
}

export async function assertOutreachPrepSourcesReadable(
  tx: Prisma.TransactionClient, ctx: TenantContext, association: OutreachAssociation, message = 'Outreach record not found',
) {
  for (const prep of association.meeting?.preps ?? []) {
    try { await assertSavedMeetingPrepAccess(tx, ctx, prep.generatedFrom); }
    catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) throw new NotFoundException(message);
      throw error;
    }
  }
}

/** Two rows suffice to detect an ambiguous latest child, without reading history. */
function associationSelect() {
  return {
    id: true, updatedAt: true, clientId: true, meetingId: true,
    meeting: { select: {
      id: true, tenantId: true, clientId: true,
      preps: { select: { id: true, tenantId: true, clientId: true, createdAt: true, generatedFrom: true },
        orderBy: { createdAt: 'desc' as const }, take: 2 },
      debriefs: { select: { id: true, tenantId: true, clientId: true, createdAt: true },
        orderBy: { createdAt: 'desc' as const }, take: 2 },
    } },
  } as const;
}

function latest(children: Child[]): Child[] {
  if (children.length > 1) {
    const first = children[0]?.createdAt?.getTime();
    const second = children[1]?.createdAt?.getTime();
    // PostgreSQL timestamps can have finer precision than Date. When the two
    // leaders cannot be distinguished here, deny rather than choose by id.
    if (first === undefined || second === undefined || first <= second) throw new NotFoundException('Outreach record not found');
  }
  return children.slice(0, 1);
}

function canonicalAssociation(row: OutreachAssociation): OutreachAssociation {
  if (row.meetingId !== null && (!row.meeting || row.meeting.id !== row.meetingId))
    throw new NotFoundException('Outreach record not found');
  return { ...row, meeting: row.meeting ? { ...row.meeting,
    preps: latest(row.meeting.preps), debriefs: latest(row.meeting.debriefs) } : null };
}

function associationKey(row: OutreachAssociation) {
  return JSON.stringify([row.id, row.updatedAt, row.clientId, row.meetingId,
    row.meeting?.id ?? null, row.meeting?.clientId ?? null,
    row.meeting?.preps.map(p => [p.id, p.clientId, p.createdAt, p.generatedFrom]) ?? [],
    row.meeting?.debriefs.map(d => [d.id, d.clientId, d.createdAt]) ?? []]);
}

async function assertAssociation(tx: Prisma.TransactionClient, ctx: TenantContext, row: OutreachAssociation) {
  if (row.meeting && (row.meeting.tenantId !== ctx.tenantId ||
      [...row.meeting.preps, ...row.meeting.debriefs].some(child => child.tenantId !== ctx.tenantId)))
    throw new NotFoundException('Outreach record not found');
  const ids = [...new Set([row.clientId, row.meeting?.clientId,
    ...(row.meeting?.preps.map(p => p.clientId) ?? []), ...(row.meeting?.debriefs.map(d => d.clientId) ?? [])]
    .filter((id): id is string => typeof id === 'string'))];
  await assertOutreachClientsReadable(tx, ctx, ids, 'Outreach record not found');
  await assertOutreachPrepSourcesReadable(tx, ctx, row);
}

function recordWhere(ctx: TenantContext) {
  return { tenantId: ctx.tenantId, ...ownOutreachRecordWhere(ctx.userId), deletedAt: null };
}

async function currentActor(tx: Prisma.TransactionClient, ctx: TenantContext) {
  try { return await currentMeetingActor(tx, ctx); }
  catch (error) {
    if (error instanceof NotFoundException) throw new NotFoundException('Outreach record not found');
    throw error;
  }
}

/** Canonical detail/list guard. The loader is the existing ordinary projection. */
export async function readClassicOutreachRecord<T extends OutreachAssociation>(
  tx: Prisma.TransactionClient, ctx: TenantContext, id: string, load: () => Promise<T | null>,
  deleted = false,
): Promise<T> {
  const actor = await currentActor(tx, ctx);
  const where = { ...recordWhere(actor), id, deletedAt: deleted ? { not: null } : null };
  const peek = await tx.outreachRecord.findFirst({ where, select: associationSelect() });
  if (!peek) throw new NotFoundException('Outreach record not found');
  const before = canonicalAssociation(peek);
  await assertAssociation(tx, actor, before);
  const value = await load();
  if (!value || associationKey(canonicalAssociation(value)) !== associationKey(before))
    throw new NotFoundException('Outreach record not found');
  const afterActor = await currentActor(tx, ctx);
  const current = await tx.outreachRecord.findFirst({ where, select: associationSelect() });
  if (!current) throw new NotFoundException('Outreach record not found');
  const after = canonicalAssociation(current);
  if (afterActor.role !== actor.role || associationKey(after) !== associationKey(before))
    throw new NotFoundException('Outreach record not found');
  await assertAssociation(tx, afterActor, after);
  return value;
}

/** Server-selected scope; personal Classic is NOT an alias for client_records. */
export type ClassicOutreachScope =
  | { kind: 'client'; clientId: string }
  | { kind: 'client_associated' }
  | { kind: 'personal_classic' };

export class ClassicOutreachObservationIncompleteError extends ServiceUnavailableException {
  readonly code = 'CLASSIC_OUTREACH_OBSERVATION_INCOMPLETE';
  constructor() { super('Narrow the Classic Outreach scope before querying.'); }
}
export class ClassicOutreachObservationChangedError extends ServiceUnavailableException {
  readonly code = 'CLASSIC_OUTREACH_OBSERVATION_CHANGED';
  constructor() { super('Classic Outreach access or records changed. Please retry.'); }
}

export type ClassicOutreachObservationControl = {
  /** Caller-owned bound, at most the existing ordinary page maximum. */
  maxCandidates: number;
  /** Canonical request cancellation/deadline check; never supplied by the model. */
  assertActive: () => void;
};

async function observe(
  tx: Prisma.TransactionClient, ctx: TenantContext, scope: ClassicOutreachScope, control: ClassicOutreachObservationControl,
) {
  control.assertActive();
  const actor = await currentActor(tx, ctx);
  if (scope.kind === 'client') await assertOutreachClientsReadable(tx, actor, [scope.clientId]);
  const where = { ...recordWhere(actor), ...(scope.kind === 'client' ? { clientId: scope.clientId }
    : scope.kind === 'client_associated' ? { clientId: { not: null } } : {}) };
  const read = () => tx.outreachRecord.findMany({ where, select: associationSelect(), orderBy: { id: 'asc' }, take: control.maxCandidates + 1 });
  const rows = await read();
  if (rows.length > control.maxCandidates) throw new ClassicOutreachObservationIncompleteError();
  const ids: string[] = [];
  for (const row of rows) {
    control.assertActive();
    try { await assertAssociation(tx, actor, canonicalAssociation(row)); ids.push(row.id); }
    catch (error) {
      if (!(error instanceof NotFoundException || error instanceof ForbiddenException)) throw error;
    }
  }
  control.assertActive();
  const current = await read();
  if (JSON.stringify(current) !== JSON.stringify(rows)) throw new ClassicOutreachObservationChangedError();
  const afterActor = await currentActor(tx, ctx);
  if (afterActor.role !== actor.role) throw new ClassicOutreachObservationChangedError();
  control.assertActive();
  return { ids: Object.freeze(ids), key: JSON.stringify([actor.role, rows, ids]) };
}

/**
 * Authorize a COMPLETE bounded universe before aggregation; withhold the whole
 * result if currentness changes. The common SQL owner must bind exactly these
 * IDs to its fixed view before WHERE/GROUP/COUNT, not postfilter an aggregate.
 * Normal domain transactions are required: saved RP prep guards can take locks.
 * No body copies, persisted grant, SQL engine, or source admission is created.
 */
export async function withClassicOutreachEligibleIds<T>(
  prisma: Pick<PrismaService, 'withTenant'>, ctx: TenantContext, scope: ClassicOutreachScope,
  control: ClassicOutreachObservationControl, query: (ids: readonly string[]) => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(control.maxCandidates) || control.maxCandidates < 1 || control.maxCandidates > 100)
    throw new ClassicOutreachObservationIncompleteError();
  // Capture trusted inputs now; an async caller cannot switch the bound scope.
  const boundScope = { ...scope };
  if (!['client', 'client_associated', 'personal_classic'].includes(boundScope.kind) ||
      boundScope.kind === 'client' && !boundScope.clientId) throw new NotFoundException('Outreach scope not found');
  const boundCtx = { ...ctx };
  const boundControl = { ...control };
  const before = await prisma.withTenant(ctx.tenantId, tx => observe(tx, boundCtx, boundScope, boundControl));
  boundControl.assertActive();
  const result = await query(before.ids);
  boundControl.assertActive();
  const after = await prisma.withTenant(boundCtx.tenantId, tx => observe(tx, boundCtx, boundScope, boundControl));
  if (after.key !== before.key) throw new ClassicOutreachObservationChangedError();
  boundControl.assertActive();
  return result;
}
