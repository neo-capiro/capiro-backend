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
  type BulkFolderBillsDto,
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
  ['org:admin', 'admin', 'owner', 'org:owner', 'capiro_admin', 'client_admin'].includes(
    ctx.role ?? '',
  );
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
    return this.withActor(ctx, async (tx) => {
      if (input.folderId) await this.folder(tx, ctx, input.folderId);
      if (
        input.clientId &&
        !(await this.legacySource.getClientProfile(ctx.tenantId, input.clientId))
      )
        throw new NotFoundException('CLIENT_NOT_FOUND');
      const values: unknown[] = [ctx.tenantId, input.jurisdiction, input.sessionKey];
      const bind = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };
      const where = ['b.jurisdiction = $2', 'b."sessionKey" = $3'];
      // Search can show unassigned canonical bills. A board always shows assignments.
      const join = search ? 'LEFT JOIN' : 'JOIN';
      let assignmentScope = 'a.tenant_id = $1 AND a.bill_id = b.id';
      if (input.folderId) assignmentScope += ` AND a.folder_id = ${bind(input.folderId)}`;
      else if (search) assignmentScope += ' AND false';
      if (input.clientId) where.push(`f.client_id = ${bind(input.clientId)}`);
      if (input.q) {
        const billNumber = normalizeBillNumber(input.q, input.jurisdiction);
        where.push(
          `(b.title ILIKE ${bind('%' + input.q.replace(/[\\%_]/g, '\\$&') + '%')} OR b.number ILIKE ${bind('%' + input.q.replace(/[\\%_]/g, '\\$&') + '%')}${billNumber ? ` OR ${FOLDER_NUMBER_SQL} = ${bind(billNumber)}` : ''})`,
        );
      }
      if (input.sponsor)
        where.push(`b.sponsor ILIKE ${bind('%' + input.sponsor.replace(/[\\%_]/g, '\\$&') + '%')}`);
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
      const from = `FROM (${FOLDER_SOURCE_SQL}) b ${join} intel_legiwatch_folder_bill a ON ${assignmentScope}
        LEFT JOIN intel_legiwatch_folder f ON f.tenant_id = $1 AND f.id = a.folder_id WHERE ${where.join(' AND ')}`;
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
        a.added_date_raw AS "addedDateRaw", a.added_date_precision AS "addedDatePrecision"
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
}
