import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { DefenseTenantContext, normalizeLimit, normalizePage, requirePeCode } from './program-elements.shared.js';

export const PE_DATA_ISSUE_TYPES = [
  'value_incorrect',
  'missing_value',
  'wrong_source',
  'wrong_stage_or_vehicle',
  'wrong_pe_attribution',
  'other',
] as const;

export const PE_DATA_ISSUE_STATUSES = ['open', 'resolved', 'dismissed'] as const;

export interface CreatePeDataIssueInput {
  issueType: string;
  description: string;
  fy?: number | null;
  fieldName?: string | null;
  suggestedSourceUrl?: string | null;
}

export interface ResolvePeDataIssueInput {
  status: 'resolved' | 'dismissed';
  resolutionNotes?: string | null;
}

/**
 * Tenant-scoped PE data-issue feedback service. Preserves the invariant that
 * a data-issue resolution NEVER mutates canonical Program Element values —
 * enforced here with a before/after marker comparison inside the same
 * transaction, mirroring apps/api's non-mutation proof.
 */
@Injectable()
export class ProgramElementDataIssueService {
  constructor(private readonly prisma: PrismaService) {}

  async create(peCodeRaw: string, input: CreatePeDataIssueInput, ctx: DefenseTenantContext) {
    const peCode = requirePeCode(peCodeRaw);
    const issueType = this.requireIssueType(input.issueType);
    const description = this.requireDescription(input.description);

    const pe = await this.prisma.programElement.findUnique({ where: { peCode }, select: { peCode: true } });
    if (!pe) throw new NotFoundException(`Program Element ${peCode} not found`);

    const row = await this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      const created = await tx.programElementDataIssue.create({
        data: {
          tenantId: ctx.tenantId,
          reportedByUserId: ctx.userId,
          peCode,
          fy: input.fy ?? null,
          fieldName: input.fieldName ?? null,
          issueType,
          description,
          status: 'open',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'program_element.data_issue.create',
          entityType: 'program_element_data_issue',
          entityId: created.id,
          after: { peCode, issueType, descriptionLength: description.length },
        },
      });
      return created;
    });
    return row;
  }

  async listForPe(peCodeRaw: string, ctx: DefenseTenantContext, opts: { status?: string; page?: number; limit?: number } = {}) {
    const peCode = requirePeCode(peCodeRaw);
    const page = normalizePage(opts.page);
    const limit = normalizeLimit(opts.limit);
    const status = opts.status?.trim() || undefined;
    const where = { peCode, ...(status ? { status } : {}) };
    const { total, rows } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [count, items] = await Promise.all([
        tx.programElementDataIssue.count({ where }),
        tx.programElementDataIssue.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
      ]);
      return { total: count, rows: items };
    });
    return { data: rows, total, page, limit };
  }

  async listAdmin(ctx: DefenseTenantContext, opts: { status?: string; peCode?: string; page?: number; limit?: number } = {}) {
    const page = normalizePage(opts.page);
    const limit = normalizeLimit(opts.limit);
    const status = opts.status?.trim() || undefined;
    const peCode = opts.peCode ? requirePeCode(opts.peCode) : undefined;
    const where = { ...(status ? { status } : {}), ...(peCode ? { peCode } : {}) };
    const { total, rows } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [count, items] = await Promise.all([
        tx.programElementDataIssue.count({ where }),
        tx.programElementDataIssue.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
      ]);
      return { total: count, rows: items };
    });
    return { data: rows, total, page, limit };
  }

  async resolve(issueId: string, input: ResolvePeDataIssueInput, ctx: DefenseTenantContext) {
    if (input.status !== 'resolved' && input.status !== 'dismissed') {
      throw new BadRequestException('status must be resolved or dismissed');
    }

    const row = await this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      const existing = await tx.programElementDataIssue.findFirst({ where: { id: issueId } });
      if (!existing) throw new NotFoundException(`Data issue ${issueId} not found`);
      if (existing.status !== 'open') {
        throw new BadRequestException(`Data issue ${issueId} is already ${existing.status} and cannot be re-resolved`);
      }

      // Snapshot a canonical PE year marker BEFORE resolve so the non-mutation
      // invariant is provable in-band, not merely asserted.
      const marker = await tx.programElementYear.findFirst({
        where: { peCode: existing.peCode },
        orderBy: { fy: 'desc' },
        select: { fy: true, request: true, enacted: true, conference: true, hascMark: true, sascMark: true, hacDMark: true, sacDMark: true, ndaaConference: true },
      });

      const updated = await tx.programElementDataIssue.update({
        where: { id: existing.id },
        data: { status: input.status, resolutionNotes: input.resolutionNotes ?? null, resolvedByUserId: ctx.userId, resolvedAt: new Date() },
      });

      const markerAfter = await tx.programElementYear.findFirst({
        where: { peCode: existing.peCode },
        orderBy: { fy: 'desc' },
        select: { fy: true, request: true, enacted: true, conference: true, hascMark: true, sascMark: true, hacDMark: true, sacDMark: true, ndaaConference: true },
      });

      if (JSON.stringify(marker) !== JSON.stringify(markerAfter)) {
        throw new BadRequestException('Data-issue resolution must not mutate canonical Program Element values');
      }

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'program_element.data_issue.resolve',
          entityType: 'program_element_data_issue',
          entityId: updated.id,
          before: { status: existing.status },
          after: { status: updated.status, canonicalRowUnchanged: true },
        },
      });

      return updated;
    });

    return row;
  }

  private requireIssueType(raw: string): string {
    const value = (raw ?? '').trim();
    if (!(PE_DATA_ISSUE_TYPES as readonly string[]).includes(value)) {
      throw new BadRequestException(`issueType must be one of: ${PE_DATA_ISSUE_TYPES.join(', ')}`);
    }
    return value;
  }

  private requireDescription(raw: string): string {
    const description = (raw ?? '').trim();
    if (!description) throw new BadRequestException('description is required');
    if (description.length > 4000) throw new BadRequestException('description must be <= 4000 characters');
    return description;
  }
}
