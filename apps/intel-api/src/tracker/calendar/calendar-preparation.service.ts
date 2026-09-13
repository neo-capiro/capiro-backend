import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import {
  FeatureFlagService,
  STATE_CALENDAR_FEATURE,
} from '../../feature-flags/feature-flag.service.js';
import { FolderTrackerService } from '../folders/folder-tracker.service.js';
import { digest, ids, json, object } from '../reports/report-domain.js';

export type CalendarScope = {
  folderIds?: string[];
  clientId?: string;
  jurisdiction?: string;
  session?: string;
};
type PublicEvent = {
  id: string;
  title: string;
  jurisdiction: string | null;
  session: string | null;
  revision: number;
  status: string;
  checkedAt: Date | null;
  checkState: string;
  snapshot: unknown;
  date: string;
  time: string | null;
  timezone: string;
  startsAt: Date | null;
  location: string | null;
  sourceUrl: string | null;
  committeeName: string;
};

@Injectable()
export class CalendarPreparationService {
  constructor(
    readonly folders: FolderTrackerService,
    readonly flags: FeatureFlagService,
  ) {}
  async authorize(ctx: WorkspaceTenantContext) {
    if (!(await this.flags.isEnabled(STATE_CALENDAR_FEATURE, ctx.tenantId)))
      throw new NotFoundException();
    if (!(await this.folders.source.activeMember(ctx.tenantId, ctx.clerkUserId)))
      throw new ForbiddenException('ACTIVE_MEMBERSHIP_REQUIRED');
  }
  async scope(ctx: WorkspaceTenantContext, input: CalendarScope) {
    await this.authorize(ctx);
    if (input.folderIds && (!Array.isArray(input.folderIds) || input.folderIds.length > 200))
      throw new BadRequestException('SELECT_AT_MOST_200_FOLDERS');
    return this.folders.withActor(ctx, async (tx) => {
      const selected = input.folderIds ? ids(input.folderIds) : null;
      if (selected)
        for (const id of selected) {
          const folder = await this.folders.folder(tx, ctx, id);
          if (folder.archived) throw new BadRequestException('ARCHIVED_FOLDER_REQUIRES_REVIEW');
        }
      const folders = await tx.legiWatchFolder.findMany({
        where: {
          tenantId: ctx.tenantId,
          archived: false,
          ...(selected ? { id: { in: selected } } : {}),
          ...(input.clientId ? { clientId: input.clientId } : {}),
          ...(input.jurisdiction && input.jurisdiction !== 'ALL'
            ? { jurisdiction: input.jurisdiction }
            : {}),
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, clientId: true, version: true },
      });
      const assignments = await tx.legiWatchFolderBill.findMany({
        where: {
          tenantId: ctx.tenantId,
          folderId: { in: folders.map((f) => f.id) },
          ...(input.session ? { sessionKey: input.session } : {}),
        },
        take: 10001,
        orderBy: [{ folderId: 'asc' }, { billId: 'asc' }],
      });
      if (assignments.length > 10000)
        throw new BadRequestException('NARROW_CALENDAR_FOLDER_SELECTION');
      return { folders, billIds: [...new Set(assignments.map((a) => a.billId))], assignments };
    });
  }
  async publicEvent(id: string): Promise<PublicEvent> {
    const rows = await this.folders.prisma.$queryRawUnsafe<PublicEvent[]>(
      `SELECT id,title,
      geographic_jurisdiction AS jurisdiction,legislative_session AS session,calendar_revision AS revision,
      event_status AS status,calendar_checked_at AS "checkedAt",calendar_check_state AS "checkState",calendar_snapshot AS snapshot,
      to_char(date,'YYYY-MM-DD') AS date,time,timezone,starts_at AS "startsAt",location,url AS "sourceUrl",committee_name AS "committeeName"
      FROM committee_hearing WHERE id=$1 AND visibility='public'`,
      id,
    );
    if (!rows[0]) throw new NotFoundException('CALENDAR_EVENT_NOT_FOUND');
    return rows[0];
  }
  async prepare(
    ctx: WorkspaceTenantContext,
    hearingId: string,
    input: CalendarScope,
    requestKey?: string,
  ) {
    const scope = await this.scope(ctx, input),
      event = await this.publicEvent(hearingId);
    const snapshot = object(event.snapshot),
      agenda = Array.isArray(snapshot.agenda) ? snapshot.agenda.map(object) : [];
    const legacy =
      event.jurisdiction === 'US'
        ? await this.folders.prisma.$queryRawUnsafe<Array<{ billId: string }>>(
            'SELECT bill_id AS "billId" FROM committee_hearing_bill WHERE hearing_id=$1',
            hearingId,
          )
        : [];
    const agendaBillIds = [
      ...new Set([
        ...agenda
          .map((a) => object(a.bill).id)
          .filter((id): id is string => typeof id === 'string'),
        ...legacy.map((a) => a.billId),
      ]),
    ];
    const bills = [];
    for (let i = 0; i < agendaBillIds.length; i += 250)
      bills.push(...(await this.folders.source.reportBills(agendaBillIds.slice(i, i + 250))));
    const assignments = scope.assignments.filter((a) => agendaBillIds.includes(a.billId));
    const folderIds = [...new Set(assignments.map((a) => a.folderId))];
    const generatedAt = new Date().toISOString();
    const payload = {
      source: 'legiwatch-preparation',
      mode: 'preparation',
      generatedAt,
      event,
      agenda,
      documents: Array.isArray(snapshot.documents) ? snapshot.documents : [],
      bills,
      folders: scope.folders.filter((f) => folderIds.includes(f.id)),
      folderContext: assignments.map((a) => ({
        assignmentId: a.id,
        folderId: a.folderId,
        billId: a.billId,
        version: a.version,
        topPriority: a.topPriority,
        importance: a.importance,
        position: a.position,
        internalComments: a.internalComments,
        externalComments: a.externalComments,
      })),
      scope: { ...input, folderIds: scope.folders.map((f) => f.id) },
      limitations: [
        event.checkState !== 'complete' ? 'Calendar source check is incomplete or unknown.' : null,
        agenda.some((a) => a.kind === 'unresolved_bill')
          ? 'Some published bill references are unresolved.'
          : null,
        'Preparation uses published schedules and bill facts. It does not imply that testimony occurred.',
      ].filter(Boolean),
    };
    const frozen = await this.folders.withActor(ctx, async (tx) => {
      if (requestKey) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + ctx.clerkUserId + ':' + requestKey},0))`;
        const [prior] = await tx.$queryRaw<
          Array<{ snapshot_id: string; input_hash: string }>
        >`SELECT snapshot_id,input_hash FROM intel_legiwatch_preparation_request
          WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND request_key=${requestKey}`;
        if (prior) {
          if (prior.input_hash !== digest({ hearingId, input }))
            throw new ConflictException('PREPARATION_REQUEST_KEY_REUSED');
          return tx.legiWatchPreparationSnapshot.findFirstOrThrow({
            where: { tenantId: ctx.tenantId, ownerClerkId: ctx.clerkUserId, id: prior.snapshot_id },
          });
        }
      }
      const result = await tx.legiWatchPreparationSnapshot.create({
        data: {
          tenantId: ctx.tenantId,
          ownerClerkId: ctx.clerkUserId,
          hearingId,
          calendarRevision: event.revision,
          folderIds,
          payload: json(payload),
          contentHash: digest(payload),
        },
      });
      if (requestKey)
        await tx.$executeRaw`INSERT INTO intel_legiwatch_preparation_request(tenant_id,owner_clerk_id,request_key,input_hash,snapshot_id)
        VALUES(${ctx.tenantId},${ctx.clerkUserId},${requestKey},${digest({ hearingId, input })},${result.id})`;
      return result;
    });
    const saved = object(frozen.payload),
      savedEvent = object(saved.event);
    const savedBills = Array.isArray(saved.bills) ? saved.bills.map(object) : [];
    return {
      draft: { docTitle: `Hearing preparation — ${String(savedEvent.title ?? '')}` },
      context: { ...saved, snapshotId: frozen.id, contentHash: frozen.contentHash },
      sources: [
        {
          kind: 'hearing',
          id: hearingId,
          path: `/legiwatch/hearings/${encodeURIComponent(hearingId)}`,
          revision: frozen.calendarRevision,
        },
        ...(savedEvent.sourceUrl ? [{ kind: 'official_page', url: savedEvent.sourceUrl }] : []),
        ...savedBills.map((b) => ({ kind: 'bill', id: b.id, url: b.sourceUrl })),
      ],
    };
  }
  async snapshotStatus(ctx: WorkspaceTenantContext, id: string) {
    await this.authorize(ctx);
    const frozen = await this.folders.withActor(ctx, async (tx) => {
      const row = await tx.legiWatchPreparationSnapshot.findFirst({
        where: { tenantId: ctx.tenantId, ownerClerkId: ctx.clerkUserId, id },
      });
      if (!row) throw new NotFoundException('PREPARATION_NOT_FOUND');
      for (const folderId of row.folderIds) await this.folders.folder(tx, ctx, folderId);
      return row;
    });
    const event = await this.publicEvent(frozen.hearingId);
    const saved = object(frozen.payload),
      current = await this.scope(ctx, object(saved.scope) as CalendarScope);
    const oldFolders = Array.isArray(saved.folders) ? saved.folders.map(object) : [];
    const oldAssignments = Array.isArray(saved.folderContext)
      ? saved.folderContext.map(object)
      : [];
    const savedBills = Array.isArray(saved.bills) ? saved.bills.map((b) => object(b).id) : [];
    const savedAgenda = Array.isArray(saved.agenda)
      ? saved.agenda.map((a) => object(object(a).bill).id)
      : [];
    const relevant = current.assignments.filter(
      (a) => savedBills.includes(a.billId) || savedAgenda.includes(a.billId),
    );
    const contextChanged =
      oldFolders.some(
        (f) => !current.folders.some((c) => c.id === f.id && c.version === f.version),
      ) ||
      relevant.length !== oldAssignments.length ||
      oldAssignments.some(
        (a) => !relevant.some((c) => c.id === a.assignmentId && c.version === a.version),
      );
    return {
      id,
      hearingId: frozen.hearingId,
      preparedRevision: frozen.calendarRevision,
      currentRevision: event.revision,
      stale: event.revision !== frozen.calendarRevision || contextChanged,
      contextChanged,
      createdAt: frozen.createdAt,
      contentHash: frozen.contentHash,
    };
  }
}
