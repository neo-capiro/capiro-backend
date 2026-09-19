import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { writeMembershipDecision } from './folder-decisions.js';
import type { Prisma, LegiWatchFolder } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SourceDataRepository } from '../../sourcedata/source-data.repository.js';
import {
  FolderSourceDataRepository,
  FOLDER_SOURCE_SQL,
  FOLDER_NUMBER_SQL,
  normalizeBillNumber,
  type FolderSourceBill,
} from '../../sourcedata/folder-source-data.repository.js';
import {
  type BillCorpusQueryDto,
  type BulkFolderBillsDto,
  type FolderActivityQueryDto,
  type FolderBoardQueryDto,
  type FolderContextDto,
  type FolderExportDto,
  type FolderFieldsDto,
  type ResolveBillsDto,
  type UpdateFolderDto,
} from './folder-tracker.dto.js';

export const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const isFolderAdmin = (ctx: WorkspaceTenantContext) =>
  [
    'org:admin',
    'admin',
    'owner',
    'org:owner',
    'capiro_admin',
    'user_admin',
    'client_admin',
  ].includes(ctx.role ?? '');
export const canEditFolder = (
  f: Pick<LegiWatchFolder, 'ownerClerkId' | 'otherUserAccess'>,
  actor: string,
) => Boolean(f.ownerClerkId && (f.ownerClerkId === actor || f.otherUserAccess === 'read_change'));
export { normalizeBillNumber } from '../../sourcedata/folder-source-data.repository.js';
export function csvCell(value: unknown): string {
  const raw = String(value ?? '');
  // Formula safety includes leading whitespace/control characters and tabs/newlines.
  const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(raw) || /^[\t\r\n]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}
export type FolderBillRow = FolderSourceBill & {
  assignmentId: string | null;
  folderId: string | null;
  topPriority: boolean | null;
  importance: string | null;
  position: string | null;
  internalComments: string | null;
  externalComments: string | null;
  version: number | null;
  addedAt: Date | null;
  addedDateRaw: string | null;
  addedDatePrecision: string | null;
  summary?: string | null;
  classifications?: string[] | null;
  subjects?: string[] | null;
  currentCommittee?: string | null;
};

@Injectable()
export class FolderTrackerService {
  constructor(
    readonly prisma: PrismaService,
    readonly source: FolderSourceDataRepository,
    private readonly legacySource: SourceDataRepository,
  ) {}

  withActor<T>(
    ctx: WorkspaceTenantContext,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts?: { timeoutMs?: number },
  ) {
    return this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.folder_actor', ${ctx.clerkUserId}, true), set_config('app.folder_admin', ${isFolderAdmin(ctx) ? 'on' : 'off'}, true)`;
        return fn(tx);
      },
      opts,
    );
  }
  async folder(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    id: string,
    write = false,
    allowArchived = false,
  ) {
    // Serialize membership/context edits with archive/access changes.
    if (write)
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_folder WHERE tenant_id = ${ctx.tenantId} AND id = ${id} FOR UPDATE`;
    const f = await tx.legiWatchFolder.findFirst({ where: { tenantId: ctx.tenantId, id } });
    if (!f) throw new NotFoundException('FOLDER_NOT_FOUND');
    if (write && (!canEditFolder(f, ctx.clerkUserId) || (f.archived && !allowArchived)))
      throw new ForbiddenException(
        f.archived ? 'FOLDER_ARCHIVED' : 'FOLDER_READ_ONLY_OR_OWNER_UNRESOLVED',
      );
    return f;
  }
  async validateReferences(ctx: WorkspaceTenantContext, input: FolderFieldsDto) {
    if (input.clientId && !(await this.legacySource.getClientProfile(ctx.tenantId, input.clientId)))
      throw new NotFoundException('CLIENT_NOT_FOUND');
    if (input.ownerClerkId && !(await this.source.activeMember(ctx.tenantId, input.ownerClerkId)))
      throw new BadRequestException('OWNER_NOT_ACTIVE_IN_TENANT');
  }
  async list(ctx: WorkspaceTenantContext) {
    return this.withActor(ctx, async (tx) =>
      (
        await tx.legiWatchFolder.findMany({
          where: { tenantId: ctx.tenantId },
          orderBy: [{ archived: 'asc' }, { name: 'asc' }, { id: 'asc' }],
          include: { _count: { select: { assignments: true } } },
        })
      ).map((f) => ({
        ...f,
        canEdit: !f.archived && canEditFolder(f, ctx.clerkUserId),
        canManage: f.ownerClerkId === ctx.clerkUserId,
        count: f._count.assignments,
      })),
    );
  }
  async create(ctx: WorkspaceTenantContext, input: FolderFieldsDto) {
    if (!input.name.trim()) throw new BadRequestException('NAME_REQUIRED');
    await this.validateReferences(ctx, input);
    if (input.ownerClerkId && input.ownerClerkId !== ctx.clerkUserId && !isFolderAdmin(ctx))
      throw new ForbiddenException('OWNER_ASSIGNMENT_REQUIRES_ADMIN');
    return this.withActor(ctx, (tx) =>
      tx.legiWatchFolder.create({
        data: {
          ...input,
          name: input.name.trim(),
          tenantId: ctx.tenantId,
          ownerClerkId: input.ownerClerkId ?? ctx.clerkUserId,
          createdBy: ctx.clerkUserId,
        },
      }),
    );
  }
  async update(ctx: WorkspaceTenantContext, id: string, input: UpdateFolderDto) {
    if (!input.name.trim()) throw new BadRequestException('NAME_REQUIRED');
    await this.validateReferences(ctx, input);
    return this.withActor(ctx, async (tx) => {
      const f = await this.folder(tx, ctx, id, true, true);
      if (
        f.ownerClerkId !== ctx.clerkUserId &&
        ((input.ownerClerkId !== undefined && input.ownerClerkId !== f.ownerClerkId) ||
          (input.otherUserAccess !== undefined && input.otherUserAccess !== f.otherUserAccess) ||
          (input.clientId !== undefined && input.clientId !== f.clientId))
      )
        throw new ForbiddenException('ONLY_OWNER_CAN_CHANGE_ACCESS');
      const { expectedVersion, ...data } = input;
      const result = await tx.legiWatchFolder.updateMany({
        where: { tenantId: ctx.tenantId, id, version: expectedVersion },
        data: { ...data, name: data.name.trim(), version: { increment: 1 } },
      });
      if (!result.count) throw new ConflictException('FOLDER_CHANGED_RELOAD');
      return tx.legiWatchFolder.findFirstOrThrow({ where: { tenantId: ctx.tenantId, id } });
    });
  }
  async context(ctx: WorkspaceTenantContext, folderId: string, billId: string) {
    return this.withActor(ctx, async (tx) => {
      const f = await this.folder(tx, ctx, folderId);
      const assignment = await tx.legiWatchFolderBill.findFirst({
        where: { tenantId: ctx.tenantId, folderId, billId },
      });
      return {
        folder: { id: f.id, name: f.name, clientId: f.clientId },
        assignment,
        canEdit: !f.archived && canEditFolder(f, ctx.clerkUserId),
      };
    });
  }
  async updateContext(
    ctx: WorkspaceTenantContext,
    folderId: string,
    billId: string,
    input: FolderContextDto,
  ) {
    return this.withActor(ctx, async (tx) => {
      await this.folder(tx, ctx, folderId, true);
      const a = await tx.legiWatchFolderBill.findFirst({
        where: { tenantId: ctx.tenantId, folderId, billId },
      });
      if (!a) throw new NotFoundException('ASSIGNMENT_NOT_FOUND');
      const { expectedVersion, ...data } = input;
      const result = await tx.legiWatchFolderBill.updateMany({
        where: { tenantId: ctx.tenantId, id: a.id, version: expectedVersion },
        data: { ...data, version: { increment: 1 }, updatedBy: ctx.clerkUserId },
      });
      if (!result.count) throw new ConflictException('CONTEXT_CHANGED_RELOAD');
      await tx.legiWatchFolderRevision.create({
        data: {
          tenantId: ctx.tenantId,
          assignmentId: a.id,
          version: expectedVersion + 1,
          changedBy: ctx.clerkUserId,
          context: data,
        },
      });
      return tx.legiWatchFolderBill.findFirstOrThrow({
        where: { tenantId: ctx.tenantId, id: a.id },
      });
    });
  }
  async resolve(input: ResolveBillsDto) {
    const tokens = input.billNumbers.match(/[a-zA-Z.]+\s*\d+|[^\s,;]+/g) ?? [];
    if (tokens.length > 200) throw new BadRequestException('MAX_200_BILLS');
    const normalized = tokens.map((token) => normalizeBillNumber(token, input.jurisdiction));
    const rows = await this.source.resolve(
      input.jurisdiction,
      input.sessionKey,
      normalized.filter((n): n is string => !!n),
    );
    const seen = new Set<string>();
    return tokens.map((token, index) => {
      const number = normalized[index];
      const matches = rows.filter((b) => normalizeBillNumber(b.number, b.jurisdiction) === number);
      const duplicate = !!number && seen.has(number);
      if (number) seen.add(number);
      return {
        token,
        status: duplicate
          ? 'duplicate'
          : matches.length === 1
            ? 'resolved'
            : matches.length > 1
              ? 'ambiguous'
              : 'unresolved',
        bill: !duplicate && matches.length === 1 ? matches[0] : null,
        reason: !number
          ? 'Use a bill type and number'
          : matches.length === 0
            ? 'No canonical bill in the selected jurisdiction and session'
            : null,
      };
    });
  }
  async resolveSelection(ctx: WorkspaceTenantContext, input: ResolveBillsDto) {
    const results = await this.resolve(input);
    if (!input.folderIds?.length) return results;
    return this.withActor(ctx, async (tx) => {
      for (const id of input.folderIds!) await this.folder(tx, ctx, id);
      const assignments = await tx.legiWatchFolderBill.findMany({
        where: {
          tenantId: ctx.tenantId,
          folderId: { in: input.folderIds },
          billId: { in: results.flatMap((r) => (r.bill ? [r.bill.id] : [])) },
        },
        select: { billId: true, folderId: true },
      });
      return results.map((r) => ({
        ...r,
        alreadyIn: r.bill
          ? assignments.filter((a) => a.billId === r.bill!.id).map((a) => a.folderId)
          : [],
      }));
    });
  }
  async bulk(ctx: WorkspaceTenantContext, folderId: string, input: BulkFolderBillsDto) {
    const sources = await this.source.bills([...new Set(input.billIds)]);
    const results: Array<{ billId: string; status: string }> = [];
    // One bounded transaction per item; replay is safe after interruption.
    for (const billId of [...new Set(input.billIds)]) {
      const b = sources.find((x) => x.id === billId);
      if (!b && input.action === 'add') {
        results.push({ billId, status: 'unresolved' });
        continue;
      }
      try {
        const status = await this.withActor(ctx, async (tx) => {
          await this.folder(tx, ctx, folderId, true);
          const receipt = await writeMembershipDecision(tx, ctx, {
            folderId,
            billId,
            action: input.action,
            origin: 'manual',
            requestKey: randomUUID(),
            bill: b,
          });
          return receipt.outcome;
        });
        results.push({ billId, status });
      } catch (e) {
        if (e instanceof ForbiddenException || e instanceof NotFoundException)
          results.push({ billId, status: 'not_permitted' });
        else throw e;
      }
    }
    return { results, alertsActivated: false };
  }
  async board(
    ctx: WorkspaceTenantContext,
    input: FolderBoardQueryDto,
    search = false,
    selectedIds?: string[],
  ) {
    // jurisdiction/sessionKey are DTO-optional only so the global search path
    // can omit them; a folder board (or any folderId-scoped read) still
    // requires both. Enforced here because one DTO serves both routes.
    if (!search || input.folderId) {
      if (!input.jurisdiction || !input.sessionKey)
        throw new BadRequestException('JURISDICTION_AND_SESSION_REQUIRED');
    }
    const { cursor, limit = 50, ...filters } = input;
    const scope = hash({ tenantId: ctx.tenantId, filters, search, selectedIds });
    let offset = 0;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (decoded.scope !== scope || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0)
          throw new Error();
        offset = decoded.offset;
      } catch {
        throw new BadRequestException('CURSOR_SCOPE_CHANGED');
      }
    }
    if (input.clientId) {
      // Read-only client validation BEFORE opening the interactive transaction:
      // getClientProfile opens its own withSystem read and nesting it inside
      // withActor starves the pool (P5015 under normal pooling).
      if (!(await this.legacySource.getClientProfile(ctx.tenantId, input.clientId)))
        throw new NotFoundException('CLIENT_NOT_FOUND');
      if (input.folderId) {
        const folder = await this.prisma.legiWatchFolder.findFirst({
          where: { tenantId: ctx.tenantId, id: input.folderId },
          select: { clientId: true },
        });
        if (folder && folder.clientId !== input.clientId)
          throw new NotFoundException('FOLDER_CLIENT_MISMATCH');
      }
    }
    return this.withActor(ctx, async (tx) => {
      if (input.folderId) await this.folder(tx, ctx, input.folderId);
      const values: unknown[] = [ctx.tenantId];
      const bind = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };
      // An omitted jurisdiction or sessionKey searches the entire ingested
      // corpus (all states, all Congresses, special sessions). Explicit values
      // keep exact predicates.
      const where: string[] = [];
      if (input.jurisdiction) where.push(`b.jurisdiction = ${bind(input.jurisdiction)}`);
      if (input.sessionKey) where.push(`b."sessionKey" = ${bind(input.sessionKey)}`);
      // Search can show unassigned canonical bills. A board always shows assignments.
      const join = search ? 'LEFT JOIN' : 'JOIN';
      let assignmentScope = 'a.tenant_id = $1 AND a.bill_id = b.id';
      if (input.folderId) assignmentScope += ` AND a.folder_id = ${bind(input.folderId)}`;
      else if (search) assignmentScope += ' AND false';
      if (input.clientId) where.push(`f.client_id = ${bind(input.clientId)}`);
      if (input.q) {
        const escaped = '%' + input.q.replace(/[\\%_]/g, '\\$&') + '%';
        const billNumber = normalizeBillNumber(input.q, input.jurisdiction);
        // FL H/S aliases are row-local: only FL rows read H as HB. When no
        // jurisdiction is selected, also match the un-aliased token so a
        // Florida H0027 and a Massachusetts H 27 both answer "H 27".
        const flAlias = !input.jurisdiction ? normalizeBillNumber(input.q, 'FL') : null;
        const numberMatch = [
          billNumber ? `${FOLDER_NUMBER_SQL} = ${bind(billNumber)}` : null,
          flAlias && flAlias !== billNumber
            ? `(b.jurisdiction = 'FL' AND ${FOLDER_NUMBER_SQL} = ${bind(flAlias)})`
            : null,
        ]
          .filter(Boolean)
          .join(' OR ');
        where.push(
          `(b.title ILIKE ${bind(escaped)} OR b.number ILIKE ${bind(escaped)}${numberMatch ? ` OR ${numberMatch}` : ''})`,
        );
      }
      if (input.sponsor) {
        const pattern = bind('%' + input.sponsor.replace(/[\\%_]/g, '\\$&') + '%');
        where.push(
          `(b.sponsor ILIKE ${pattern} OR EXISTS (SELECT 1 FROM state_bill_sponsor s WHERE s.bill_key = b.id AND s.name ILIKE ${pattern}) OR EXISTS (SELECT 1 FROM congress_bill_cosponsor cs WHERE cs.bill_id = b.id AND cs.withdrawn_date IS NULL AND cs.full_name ILIKE ${pattern}))`,
        );
      }
      if (input.status) where.push(`b.status = ${bind(input.status)}`);
      if (input.chamber) where.push(`b.chamber = ${bind(input.chamber)}`);
      if (input.comments === 'internal') where.push(`a.internal_comments <> ''`);
      if (input.comments === 'external') where.push(`a.external_comments <> ''`);
      if (input.comments === 'any')
        where.push(`(a.internal_comments <> '' OR a.external_comments <> '')`);
      if (input.comments === 'none')
        where.push(`a.internal_comments = '' AND a.external_comments = ''`);
      if (input.topPriority) where.push(`a.top_priority = ${bind(input.topPriority === 'true')}`);
      if (input.importance) where.push(`a.importance = ${bind(input.importance)}`);
      if (input.position) where.push(`a.position = ${bind(input.position)}`);
      if (selectedIds) where.push(`a.id = ANY(${bind(selectedIds)}::text[])`);
      if (input.classification)
        where.push(
          `EXISTS (SELECT 1 FROM unnest(coalesce(b.classifications, ARRAY[]::text[])) c WHERE c = ${bind(input.classification)})`,
        );
      if (input.subject)
        where.push(
          `EXISTS (SELECT 1 FROM unnest(b.subjects) s WHERE s ILIKE ${bind('%' + input.subject.replace(/[\\%_]/g, '\\$&') + '%')})`,
        );
      if (input.committee) where.push(`b."currentCommittee" = ${bind(input.committee)}`);
      if (input.summary)
        where.push(`b.summary ILIKE ${bind('%' + input.summary.replace(/[\\%_]/g, '\\$&') + '%')}`);
      if (input.actionText)
        where.push(
          `b."latestAction" ILIKE ${bind('%' + input.actionText.replace(/[\\%_]/g, '\\$&') + '%')}`,
        );
      const predicates = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const from = `FROM (${FOLDER_SOURCE_SQL}) b ${join} intel_legiwatch_folder_bill a ON ${assignmentScope}
        LEFT JOIN intel_legiwatch_folder f ON f.tenant_id = $1 AND f.id = a.folder_id ${predicates}`;
      const direction = input.direction === 'desc' ? 'DESC' : 'ASC';
      const sortSql: Record<string, string> = {
        bill: `regexp_replace(b.number, '[^A-Za-z]', '', 'g') ${direction}, coalesce(nullif(regexp_replace(b.number, '[^0-9]', '', 'g'), ''), '0')::numeric ${direction}`,
        title: `b.title ${direction}`,
        sponsor: `b.sponsor ${direction} NULLS LAST`,
        lastAction: `b."latestActionAt" ${direction} NULLS LAST`,
        added: `a.added_at ${direction} NULLS LAST`,
      };
      const count = await tx.$queryRawUnsafe<Array<{ total: number }>>(
        `SELECT count(*)::int AS total ${from}`,
        ...values,
      );
      const rows = await tx.$queryRawUnsafe<FolderBillRow[]>(
        `SELECT b.*, a.id AS "assignmentId", a.folder_id AS "folderId",
        a.top_priority AS "topPriority", a.importance, a.position, a.internal_comments AS "internalComments",
        a.external_comments AS "externalComments", a.version, a.added_at AS "addedAt",
        a.added_date_raw AS "addedDateRaw", a.added_date_precision AS "addedDatePrecision",
        ${input.summaryIncluded === 'true' ? `b.summary, b.classifications, b.subjects, b."currentCommittee"` : `NULL AS summary, NULL AS classifications, NULL AS subjects, NULL AS "currentCommittee"`}
        ${from} ORDER BY ${sortSql[input.sort ?? 'bill'] ?? sortSql.bill}, b.id, a.id
        LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
        ...values,
      );
      const total = count[0]?.total ?? 0;
      return {
        rows,
        total,
        nextCursor:
          offset + rows.length < total
            ? Buffer.from(JSON.stringify({ scope, offset: offset + rows.length })).toString(
                'base64url',
              )
            : null,
      };
    });
  }
  /**
   * Global corpus search for the public route. BillCorpusQueryDto carries no
   * folder/client/private fields by construction; this wrapper additionally
   * strips any stray value so the search can never join tenant-private tables.
   */
  async searchCorpus(ctx: WorkspaceTenantContext, input: BillCorpusQueryDto) {
    const { jurisdiction, sessionKey, q, sponsor, status, chamber, sort, direction, cursor, limit, classification, subject, committee, summary, actionText, summaryIncluded } = input;
    return this.board(
      ctx,
      {
        jurisdiction,
        sessionKey,
        q,
        sponsor,
        status,
        chamber,
        sort,
        direction,
        cursor,
        limit,
        classification,
        subject,
        committee,
        summary,
        actionText,
        summaryIncluded,
      },
      true,
    );
  }
  async export(ctx: WorkspaceTenantContext, input: FolderExportDto) {
    if (input.scope === 'selected' && !input.selectedIds?.length)
      throw new BadRequestException('SELECT_ROWS_FOR_EXPORT');
    const { scope, selectedIds, includeInternalComments, includeExternalComments, ...query } =
      input;
    // One bounded SELECT gives the export a single PostgreSQL statement snapshot.
    // Paging separate reads could skip or duplicate assignments during edits.
    const page = await this.board(
      ctx,
      { ...query, cursor: undefined, limit: 10001 },
      false,
      scope === 'selected' ? selectedIds : undefined,
    );
    if (page.rows.length > 10000) throw new BadRequestException('NARROW_EXPORT_TO_10000_ROWS');
    const rows = page.rows;
    const columns: Array<[string, keyof FolderBillRow]> = [
      ['Bill', 'number'],
      ['Title', 'title'],
      ['Jurisdiction', 'jurisdiction'],
      ['Session', 'sessionKey'],
      ['Sponsor', 'sponsor'],
      ['Public status', 'status'],
      ['Last action', 'latestAction'],
      ['Top priority', 'topPriority'],
      ['Importance', 'importance'],
      ['Position', 'position'],
      ['Date foldered (source)', 'addedDateRaw'],
      ['Date precision', 'addedDatePrecision'],
    ];
    if (input.summaryIncluded === 'true') {
      columns.push(['Summary', 'summary']);
      columns.push(['Current committee', 'currentCommittee']);
      columns.push(['Classification', 'classifications']);
    }
    if (includeInternalComments) columns.push(['Folder internal comments', 'internalComments']);
    if (includeExternalComments) columns.push(['Folder external comments', 'externalComments']);
    return {
      count: rows.length,
      csv: [
        columns.map(([name]) => csvCell(name)).join(','),
        ...rows.map((row) => columns.map(([, key]) => csvCell(row[key])).join(',')),
      ].join('\r\n'),
    };
  }

  /** Daily original-record activity (session/folder/client-scoped). */
  async activities(ctx: WorkspaceTenantContext, input: FolderActivityQueryDto) {
    if (input.clientId && !(await this.legacySource.getClientProfile(ctx.tenantId, input.clientId)))
      throw new NotFoundException('CLIENT_NOT_FOUND');
    const { cursor, limit = 25, ...filters } = input;
    const scope = hash({ tenantId: ctx.tenantId, filters });
    let offset = 0;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (decoded.scope !== scope || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0)
          throw new Error();
        offset = decoded.offset;
      } catch {
        throw new BadRequestException('INVALID_ACTIVITY_CURSOR');
      }
    }
    if (input.from && input.to && input.from > input.to)
      throw new BadRequestException('INVALID_DATE_RANGE');
    for (const d of [input.from, input.to]) {
      if (!d) continue;
      const t = Date.parse(d);
      if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== d)
        throw new BadRequestException('INVALID_DATE_RANGE');
    }
    return this.withActor(ctx, async (tx) => {
      if (input.folderId) await this.folder(tx, ctx, input.folderId);
      const scopeMeta = {
        jurisdiction: input.jurisdiction,
        sessionKey: input.sessionKey,
        folderId: input.folderId ?? null,
        clientId: input.clientId ?? null,
        onlyTracked: input.onlyTracked === 'true',
        chamber: input.chamber ?? null,
      };
      // Federal text/amendment activity has no retained daily source: the text
      // join is state-only (state_bill_version) and the amendment join is
      // state-only (state_bill_published_record), so US rows are necessarily
      // empty regardless of real federal publications. Report the source as
      // unavailable instead of implying zero events occurred. This short
      // circuit runs only after all tenant/client/folder ownership and
      // input/cursor validation above — unsupported kinds never bypass it.
      if (input.jurisdiction === 'US' && input.kind !== 'action') {
        return {
          rows: [],
          total: 0,
          nextCursor: null,
          availability: 'unavailable',
          reason:
            input.kind === 'text'
              ? 'Federal text filing activity is not available from the retained activity sources.'
              : 'Federal amendment activity is not available from the retained activity sources.',
          kind: input.kind,
          from: input.from ?? null,
          to: input.to ?? null,
          scope: scopeMeta,
        };
      }
      const values: unknown[] = [ctx.tenantId, input.jurisdiction, input.sessionKey];
      const bind = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };
      const scopeSql: string[] = [];
      if (input.folderId || input.clientId || input.onlyTracked === 'true') {
        const parts: string[] = ['ta.tenant_id = $1', 'ta.bill_id = b.id'];
        if (input.folderId) parts.push(`ta.folder_id = ${bind(input.folderId)}`);
        if (input.clientId)
          parts.push(
            `EXISTS (SELECT 1 FROM intel_legiwatch_folder tf WHERE tf.tenant_id = $1 AND tf.id = ta.folder_id AND tf.client_id = ${bind(input.clientId)})`,
          );
        if (input.onlyTracked === 'true')
          parts.push(
            `EXISTS (SELECT 1 FROM intel_legiwatch_folder tf WHERE tf.tenant_id = $1 AND tf.id = ta.folder_id AND NOT tf.archived)`,
          );
        scopeSql.push(
          `EXISTS (SELECT 1 FROM intel_legiwatch_folder_bill ta WHERE ${parts.join(' AND ')})`,
        );
      }
      if (input.chamber) scopeSql.push(`b.chamber = ${bind(input.chamber)}`);
      const whereSql = scopeSql.length ? ' AND ' + scopeSql.join(' AND ') : '';
      const dateSql =
        input.kind === 'amendment'
          ? (input.from ? ` AND NULLIF(r.event_date, '')::date >= ${bind(input.from)}::date` : '') +
            (input.to ? ` AND NULLIF(r.event_date, '')::date <= ${bind(input.to)}::date` : '')
          : (input.from ? ` AND x.date::date >= ${bind(input.from)}::date` : '') +
            (input.to ? ` AND x.date::date <= ${bind(input.to)}::date` : '');
      let fromSql: string, selectSql: string, orderSql: string;
      if (input.kind === 'action') {
        if (input.jurisdiction === 'US') {
          fromSql = `FROM (${FOLDER_SOURCE_SQL}) b JOIN congress_bill_action x ON x.bill_id = b.id WHERE b.jurisdiction = $2 AND b."sessionKey" = $3`;
          selectSql = `x.id::text AS id, b.id AS "billId", b.number, b.title, b.jurisdiction, b."sessionKey", x.date::text AS date, 'action' AS kind, x.text, b."sourceUrl" AS url, NULL::int AS "providerDocumentId", b.chamber, 'congress_action' AS provenance`;
          orderSql = `x.date DESC NULLS LAST, x.id`;
        } else {
          fromSql = `FROM (${FOLDER_SOURCE_SQL}) b JOIN (
            SELECT id::text, bill_key, date, text, order_key::int, NULL::text AS url, 'legacy_action' AS provenance FROM state_bill_action la
            WHERE NOT EXISTS (SELECT 1 FROM state_bill_published_record r WHERE r.bill_key = la.bill_key AND r.kind = 'action')
              AND NOT EXISTS (SELECT 1 FROM state_bill sb2 WHERE sb2.id = la.bill_key AND coalesce(sb2.report_source_facts->'coverage'->>'actions','false') = 'true')
            UNION ALL
            SELECT id::text, bill_key, NULLIF(event_date, '')::date, evidence->>'text' AS text, source_order::int, evidence->>'url' AS url, 'published_record' AS provenance FROM state_bill_published_record r
            WHERE kind = 'action'
              AND coalesce(
                (SELECT o.state_record_id = r.id FROM published_record_source_current o WHERE o.source_key = 'state:' || r.bill_key || ':' || r.kind || ':' || r.source_identity),
                NOT EXISTS(SELECT 1 FROM state_bill_published_record later WHERE later.bill_key = r.bill_key AND later.kind = r.kind AND later.source_identity = r.source_identity AND (later.first_observed_at, later.id) > (r.first_observed_at, r.id))
              )
          ) x ON x.bill_key = b.id WHERE b.jurisdiction = $2 AND b."sessionKey" = $3`;
          selectSql = `x.id::text AS id, b.id AS "billId", b.number, b.title, b.jurisdiction, b."sessionKey", x.date::text AS date, 'action' AS kind, x.text, coalesce(x.url, b."sourceUrl") AS url, NULL::int AS "providerDocumentId", b.chamber, x.provenance`;
          orderSql = `x.date DESC NULLS LAST, x.order_key DESC, x.id`;
        }
      } else if (input.kind === 'text') {
        fromSql = `FROM (${FOLDER_SOURCE_SQL}) b JOIN state_bill_version x ON x.bill_key = b.id WHERE b.jurisdiction = $2 AND b."sessionKey" = $3 AND x.date <> '1970-01-01'::date`;
        selectSql = `x.id::text AS id, b.id AS "billId", b.number, b.title, b.jurisdiction, b."sessionKey", x.date::text AS date, 'text' AS kind, x.version_type AS text, x.state_url AS url, x.legiscan_doc_id AS "providerDocumentId", b.chamber, 'bill_version' AS provenance`;
        orderSql = `x.date DESC NULLS LAST, x.id`;
      } else {
        fromSql = `FROM (${FOLDER_SOURCE_SQL}) b JOIN state_bill_published_record r ON r.bill_key = b.id AND r.kind = 'amendment' WHERE b.jurisdiction = $2 AND b."sessionKey" = $3
          AND coalesce(
            (SELECT o.state_record_id = r.id FROM published_record_source_current o WHERE o.source_key = 'state:' || r.bill_key || ':' || r.kind || ':' || r.source_identity),
            NOT EXISTS(SELECT 1 FROM state_bill_published_record later WHERE later.bill_key = r.bill_key AND later.kind = r.kind AND later.source_identity = r.source_identity AND (later.first_observed_at, later.id) > (r.first_observed_at, r.id))
          )`;
        selectSql = `r.id::text AS id, b.id AS "billId", b.number, b.title, b.jurisdiction, b."sessionKey", r.event_date AS date, 'amendment' AS kind, r.evidence->>'text' AS text, r.evidence->>'url' AS url, NULL::int AS "providerDocumentId", b.chamber, 'published_record' AS provenance`;
        orderSql = `r.event_date DESC NULLS LAST, r.source_order DESC, r.id`;
      }
      const count = await tx.$queryRawUnsafe<Array<{ total: number }>>(
        `SELECT count(*)::int AS total ${fromSql}${whereSql}${dateSql}`,
        ...values,
      );
      const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT ${selectSql} ${fromSql}${whereSql}${dateSql} ORDER BY ${orderSql} LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
        ...values,
      );
      const total = count[0]?.total ?? 0;
      return {
        rows,
        total,
        nextCursor:
          offset + rows.length < total
            ? Buffer.from(JSON.stringify({ scope, offset: offset + rows.length })).toString(
                'base64url',
              )
            : null,
        availability: 'available',
        reason: null,
        kind: input.kind,
        from: input.from ?? null,
        to: input.to ?? null,
        scope: scopeMeta,
      };
    });
  }
}
