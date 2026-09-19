import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { Prisma, TenantRole } from '@prisma/client';
import {
  normalizeOpportunitySearchCriteria,
  type OpportunityCriteriaWarning,
  type OpportunitySearchCriteriaV2,
  type SavedSearchSummaryV2,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { readVisibleClientIds } from './funding-opportunity-access.js';

export const SAVED_SEARCH_APPLY_EXECUTOR = Symbol('SAVED_SEARCH_APPLY_EXECUTOR');

export type SavedSearchContext = { tenantId: string; userId: string; role?: TenantRole | string };
export type SavedSearchApplyResult = { total?: number | null; opportunities?: unknown[]; [key: string]: unknown };
export type SavedSearchApplyExecutor = (ctx: SavedSearchContext, criteria: OpportunitySearchCriteriaV2) => Promise<SavedSearchApplyResult>;

type SavedSearchRow = {
  id: string; tenantId: string; clientId: string | null; isTenantWide: boolean; name: string;
  description: string | null; opportunityTypes: string[]; query: string; criteriaJson: unknown;
  sort: string; pageSize: number; matchMode: string; ownerId: string; visibility: string;
  alertsEnabled: boolean; alertCadence: string | null; alertChannels: string[]; alertDeadlineThreshold: number | null;
  alertNewVsChanged: boolean; lastEvaluatedAt: Date | null; lastNotifiedAt: Date | null;
  lastAppliedAt: Date | null; lastRunResultCount: number | null; createdAt: Date; updatedAt: Date;
  schemaVersion: number; archivedAt: Date | null; originalCriteriaJson: unknown; migrationWarnings: unknown;
};
type SearchCreate = { name: string; description?: string | null; visibility: 'private' | 'tenant'; clientId?: string | null; criteria: unknown };
type SearchPatch = { name?: string; description?: string | null; visibility?: 'private' | 'tenant'; clientId?: string | null; criteria?: unknown; archived?: boolean };

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const dateString = (value: Date | null): string | null => value?.toISOString() ?? null;
const isAdmin = (ctx: SavedSearchContext): boolean => ctx.role === 'user_admin' || ctx.role === 'capiro_admin';

@Injectable()
export class FundingOpportunitySavedSearchService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(SAVED_SEARCH_APPLY_EXECUTOR) private readonly applyExecutor?: SavedSearchApplyExecutor,
  ) {}

  async list(ctx: SavedSearchContext, clientId?: string | null) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      if (clientId !== undefined && clientId !== null) await this.assertClientReadable(tx, ctx, clientId);
      const rows = await tx.savedOpportunitySearch.findMany({
        // A selected client sees its own scope plus tenant-wide searches. Discovery
        // mode is tenant-wide only; never load another client's private rows.
        where: clientId === undefined || clientId === null
          ? { tenantId: ctx.tenantId, clientId: null }
          : { tenantId: ctx.tenantId, OR: [{ clientId }, { clientId: null }] },
        orderBy: { updatedAt: 'desc' },
      });
      const visible: SavedSearchRow[] = [];
      for (const row of rows as unknown as SavedSearchRow[]) {
        await this.markArchivedClientSearch(tx, row);
        if (await this.canRead(tx, ctx, row)) visible.push(row);
      }
      return { searches: visible.map((row) => this.toSummary(row, this.normalizePersisted(row))) };
    });
  }

  async create(ctx: SavedSearchContext, input: SearchCreate) {
    if (!input || typeof input !== 'object' || !input.criteria || typeof input.criteria !== 'object' || Array.isArray(input.criteria)) {
      throw new BadRequestException('Saved search criteria must be an object.');
    }
    if (!input?.name?.trim()) throw new BadRequestException('Saved search name is required.');
    const normalized = this.normalizeForWrite(input.criteria, input.clientId);
    await this.assertClientWritable(ctx, normalized.clientId);
    const row = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => tx.savedOpportunitySearch.create({
      data: {
        tenantId: ctx.tenantId, clientId: normalized.clientId, isTenantWide: normalized.clientId === null,
        name: input.name.trim(), description: input.description ?? null, opportunityTypes: normalized.criteria.types,
        query: normalized.criteria.query, criteriaJson: json(normalized.criteria), sort: normalized.criteria.sort,
        pageSize: normalized.criteria.pageSize, matchMode: normalized.criteria.mode, ownerId: ctx.userId,
        visibility: input.visibility, alertsEnabled: false, alertCadence: null, alertChannels: [],
        alertDeadlineThreshold: null, alertNewVsChanged: false, schemaVersion: normalized.criteria.schemaVersion,
        originalCriteriaJson: normalized.warnings.length ? json(input.criteria) : undefined,
        migrationWarnings: json(normalized.warnings),
      },
    }));
    return this.toSummary(row as unknown as SavedSearchRow);
  }

  async get(ctx: SavedSearchContext, id: string) {
    const row = await this.readAuthorized(ctx, id, 'read');
    return this.toSummary(row, this.normalizePersisted(row));
  }

  async update(ctx: SavedSearchContext, id: string, patch: SearchPatch) {
    const existing = await this.readAuthorized(ctx, id, 'write');
    const nextClientId = patch.clientId === undefined ? existing.clientId : patch.clientId;
    await this.assertClientWritable(ctx, nextClientId);
    if (patch.name !== undefined && !patch.name.trim()) throw new BadRequestException('Saved search name is required.');
    if (patch.criteria !== undefined && (patch.criteria === null || typeof patch.criteria !== 'object' || Array.isArray(patch.criteria))) {
      throw new BadRequestException('Saved search criteria must be an object.');
    }
    const criteriaWasReplaced = patch.criteria !== undefined;
    const rawCriteria = criteriaWasReplaced
      ? patch.criteria
      : patch.clientId === undefined
        ? existing.criteriaJson
        : { ...(existing.criteriaJson as Record<string, unknown>), clientId: nextClientId };
    const normalized = criteriaWasReplaced ? this.normalizeForWrite(rawCriteria, nextClientId) : null;
    const updateData = {
        ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
        ...(patch.clientId === undefined ? {} : {
          clientId: nextClientId,
          isTenantWide: nextClientId === null,
          criteriaJson: json(rawCriteria),
        }),
        ...(normalized ? {
          opportunityTypes: normalized.criteria.types, query: normalized.criteria.query,
          criteriaJson: json(normalized.criteria), sort: normalized.criteria.sort, pageSize: normalized.criteria.pageSize,
          matchMode: normalized.criteria.mode, schemaVersion: normalized.criteria.schemaVersion,
          originalCriteriaJson: normalized.warnings.length ? json(rawCriteria) : null,
          migrationWarnings: json(normalized.warnings),
        } : {}),
        ...(patch.archived === undefined ? {} : { archivedAt: patch.archived ? new Date() : null }),
      } as Prisma.SavedOpportunitySearchUpdateInput;
    const row = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => tx.savedOpportunitySearch.update({
      where: { id },
      data: updateData,
    }));
    return this.toSummary(row as unknown as SavedSearchRow);
  }

  async remove(ctx: SavedSearchContext, id: string) {
    await this.readAuthorized(ctx, id, 'write');
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => tx.savedOpportunitySearch.delete({ where: { id } }));
    return { deleted: true, id };
  }

  async duplicate(ctx: SavedSearchContext, id: string, name?: string) {
    const source = await this.readAuthorized(ctx, id, 'write');
    const sourceCriteria = this.normalizePersisted(source);
    const duplicate = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => tx.savedOpportunitySearch.create({
      data: {
        tenantId: ctx.tenantId, clientId: source.clientId, isTenantWide: source.isTenantWide,
        name: name?.trim() || `${source.name} copy`, description: source.description, opportunityTypes: sourceCriteria.criteria.types,
        query: sourceCriteria.criteria.query, criteriaJson: json(source.criteriaJson), sort: sourceCriteria.criteria.sort, pageSize: sourceCriteria.criteria.pageSize,
        matchMode: sourceCriteria.criteria.mode, ownerId: ctx.userId, visibility: source.visibility, alertsEnabled: false,
        alertCadence: null, alertChannels: [], alertDeadlineThreshold: null, alertNewVsChanged: false,
        schemaVersion: source.schemaVersion, originalCriteriaJson: source.originalCriteriaJson == null
          ? (sourceCriteria.warnings.length ? json(source.criteriaJson) : undefined)
          : json(source.originalCriteriaJson),
        migrationWarnings: json(sourceCriteria.warnings),
      },
    }));
    return this.toSummary(duplicate as unknown as SavedSearchRow);
  }

  async apply(ctx: SavedSearchContext, id: string, executor: SavedSearchApplyExecutor = this.applyExecutor ?? this.unwiredApplyExecutor) {
    const row = await this.readAuthorized(ctx, id, 'read');
    if (row.archivedAt !== null) throw new BadRequestException('Archived saved searches cannot be applied.');
    const normalized = this.normalizePersisted(row);
    if (row.schemaVersion > 2) throw new BadRequestException('Saved search needs migration before it can be applied.');
    if (normalized.unsafe) throw new BadRequestException('Saved search needs migration before it can be applied.');
    const criteria = normalized.criteria;
    const result = await executor(ctx, criteria);
    const resultCount = typeof result.total === 'number' ? result.total : null;
    const applied = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => tx.savedOpportunitySearch.update({
      where: { id }, data: { lastAppliedAt: new Date(), lastRunResultCount: resultCount },
    }));
    return { ...result, search: this.toSummary({ ...(applied as unknown as SavedSearchRow), criteriaJson: json(criteria) }) };
  }

  private readonly unwiredApplyExecutor: SavedSearchApplyExecutor = async () => {
    throw new BadRequestException('Saved-search apply is not wired to the unified opportunity search service.');
  };

  private normalizePersisted(row: SavedSearchRow): {
    criteria: OpportunitySearchCriteriaV2;
    warnings: OpportunityCriteriaWarning[];
    unsupported: Record<string, unknown>;
    unsafe: boolean;
  } {
    const normalized = normalizeOpportunitySearchCriteria(row.criteriaJson);
    const historical = Array.isArray(row.migrationWarnings) ? row.migrationWarnings : [];
    const warnings = [...historical, ...normalized.warnings].filter((value): value is OpportunityCriteriaWarning =>
      Boolean(value) && typeof value === 'object' && typeof (value as any).key === 'string' &&
      ['unsupported', 'retired', 'invalid'].includes((value as any).reason),
    );
    const unique = [...new Map(warnings.map((warning) => [warning.key + String.fromCharCode(0) + warning.reason, warning])).values()];
    const hasUnsupported = Object.keys(normalized.unsupported).length > 0;
    const hasFutureCriteriaSchema = typeof (row.criteriaJson as any)?.schemaVersion === 'number' && (row.criteriaJson as any).schemaVersion > 2;
    const hasFutureRowSchema = typeof row.schemaVersion === 'number' && row.schemaVersion > 2;
    if (hasFutureRowSchema && !unique.some((warning) => warning.key === 'schemaVersion' && warning.reason === 'unsupported')) {
      unique.push({ key: 'schemaVersion', reason: 'unsupported' });
    }
    return {
      criteria: normalized.criteria,
      warnings: unique,
      unsupported: normalized.unsupported,
      unsafe: hasUnsupported || hasFutureCriteriaSchema || hasFutureRowSchema || unique.some((warning) => warning.reason !== 'retired'),
    };
  }

  private normalizeForWrite(input: unknown, bodyClientId?: string | null) {
    const normalized = normalizeOpportunitySearchCriteria(input);
    const clientId = bodyClientId === undefined ? normalized.criteria.clientId : bodyClientId;
    if ((clientId ?? null) !== normalized.criteria.clientId) throw new BadRequestException('Saved-search client scope does not match its criteria.');
    return { ...normalized, clientId, criteria: { ...normalized.criteria, clientId } };
  }

  private async readAuthorized(ctx: SavedSearchContext, id: string, operation: 'read' | 'write') {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const found = await tx.savedOpportunitySearch.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!found) throw new NotFoundException('Saved search not found.');
      const row = found as unknown as SavedSearchRow;
      await this.markArchivedClientSearch(tx, row);
      const readable = await this.canRead(tx, ctx, row);
      const writableClient = operation !== 'write' || row.clientId === null || isAdmin(ctx)
        ? true
        : await this.clientIsReadable(tx, ctx, row.clientId);
      if (!readable || !writableClient || (operation === 'write' && !this.canWrite(row, ctx))) {
        throw new NotFoundException('Saved search not found.');
      }
      return row;
    });
  }

  private async assertClientWritable(ctx: SavedSearchContext, clientId: string | null) {
    if (clientId === null) return;
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await this.assertClientReadable(tx, ctx, clientId);
      const client = await tx.client.findFirst({ where: { id: clientId, tenantId: ctx.tenantId }, select: { status: true } });
      if (client?.status === 'archived') throw new NotFoundException('Client not found.');
    });
  }

  private async assertClientReadable(tx: any, ctx: SavedSearchContext, clientId: string) {
    const client = await tx.client.findFirst({ where: { id: clientId, tenantId: ctx.tenantId }, select: { id: true, status: true } });
    if (!client) throw new NotFoundException('Client not found.');
    if (client.status === 'archived') throw new NotFoundException('Client not found.');
    if (!isAdmin(ctx) && !(await this.clientIsReadable(tx, ctx, clientId))) throw new NotFoundException('Client not found.');
  }

  private async clientIsReadable(tx: any, ctx: SavedSearchContext, clientId: string): Promise<boolean> {
    const client = await tx.client.findFirst({ where: { id: clientId, tenantId: ctx.tenantId }, select: { status: true } });
    if (!client || client.status === 'archived') return false;
    return (await readVisibleClientIds(tx, ctx.tenantId, ctx.userId)).includes(clientId);
  }

  private async canRead(tx: any, ctx: SavedSearchContext, row: SavedSearchRow): Promise<boolean> {
    if (row.tenantId !== ctx.tenantId) return false;
    if (row.visibility === 'private' && row.ownerId !== ctx.userId && !isAdmin(ctx)) return false;
    if (row.clientId === null) return row.visibility === 'tenant' || row.ownerId === ctx.userId || isAdmin(ctx);
    const client = await tx.client.findFirst({ where: { id: row.clientId, tenantId: ctx.tenantId }, select: { status: true } });
    if (!client) return false;
    if (client.status === 'archived') return row.ownerId === ctx.userId || isAdmin(ctx);
    return isAdmin(ctx) || (await readVisibleClientIds(tx, ctx.tenantId, ctx.userId)).includes(row.clientId);
  }

  private canWrite(row: SavedSearchRow, ctx: SavedSearchContext): boolean {
    return row.tenantId === ctx.tenantId && (row.ownerId === ctx.userId || isAdmin(ctx));
  }

  private async markArchivedClientSearch(tx: any, row: SavedSearchRow): Promise<void> {
    if (!row.clientId || row.archivedAt) return;
    const client = await tx.client.findFirst({ where: { id: row.clientId, tenantId: row.tenantId }, select: { status: true } });
    if (client?.status === 'archived') {
      row.archivedAt = new Date();
      await tx.savedOpportunitySearch.update({ where: { id: row.id }, data: { archivedAt: row.archivedAt } });
    }
  }

  private toSummary(row: SavedSearchRow, normalized = this.normalizePersisted(row)): SavedSearchSummaryV2 & Record<string, unknown> {
    return {
      id: row.id, name: row.name, description: row.description, visibility: row.visibility as 'private' | 'tenant', clientId: row.clientId,
      criteria: normalized.criteria,
      warnings: normalized.warnings, archivedAt: dateString(row.archivedAt),
      createdByUserId: row.ownerId, updatedAt: row.updatedAt.toISOString(), isTenantWide: row.isTenantWide,
      opportunityTypes: row.opportunityTypes, query: row.query, sort: row.sort, pageSize: row.pageSize, matchMode: row.matchMode,
      ownerId: row.ownerId, schemaVersion: normalized.criteria.schemaVersion,
      originalCriteriaJson: row.originalCriteriaJson ?? (normalized.unsafe ? row.criteriaJson : null),
      alerts: { enabled: row.alertsEnabled, cadence: row.alertCadence, channels: row.alertChannels, deadlineThreshold: row.alertDeadlineThreshold,
        newVsChanged: row.alertNewVsChanged, lastEvaluatedAt: dateString(row.lastEvaluatedAt), lastNotifiedAt: dateString(row.lastNotifiedAt) },
      lastAppliedAt: dateString(row.lastAppliedAt), lastRunResultCount: row.lastRunResultCount, createdAt: row.createdAt.toISOString(),
    };
  }
}
