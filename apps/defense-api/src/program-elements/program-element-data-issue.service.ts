import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ALLOWED_DATA_ISSUE_FIELD_NAMES,
  PE_DATA_ISSUE_MAX_DESCRIPTION,
  PE_DATA_ISSUE_MAX_RESOLUTION_NOTES,
  PE_DATA_ISSUE_MAX_URL,
  PE_DATA_ISSUE_STATUSES,
  PE_DATA_ISSUE_TYPES,
  type PeDataIssueType,
} from '@capiro/defense-domain/pe-read';
import {
  DefenseTenantContext,
  normalizeLimit,
  normalizePage,
  requirePeCode,
} from './program-elements.shared.js';

export { PE_DATA_ISSUE_TYPES, PE_DATA_ISSUE_STATUSES };

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
 * Tenant-scoped PE data-issue feedback service.
 *
 * Two invariants carried from apps/api:
 *
 *  1. A resolution NEVER mutates canonical Program Element values. Proven in-band
 *     with a before/after marker comparison inside the same transaction rather than
 *     merely asserted in a comment.
 *  2. Every caller-supplied field is validated AT THE SERVICE LAYER, not only in the
 *     HTTP DTO. DTO validation covers the HTTP route; it does nothing for a direct
 *     service call (an internal port, a job, a test), so the rules live here.
 *
 * `suggestedSourceUrl` is persisted. It is the single most useful field on the
 * whole report — the citation the reporter believes contradicts the stored value —
 * and the previous implementation accepted it over HTTP and then silently dropped
 * it on the floor, so the column was never populated by this path.
 */
@Injectable()
export class ProgramElementDataIssueService {
  constructor(private readonly prisma: PrismaService) {}

  async create(peCodeRaw: string, input: CreatePeDataIssueInput, ctx: DefenseTenantContext) {
    const peCode = requirePeCode(peCodeRaw);
    const issueType = this.requireIssueType(input.issueType);
    const description = this.requireDescription(input.description);
    const fy = this.normalizeFy(input.fy);
    const fieldName = this.normalizeFieldName(input.fieldName);
    const suggestedSourceUrl = this.normalizeSourceUrl(input.suggestedSourceUrl);

    const pe = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!pe) throw new NotFoundException(`Program Element ${peCode} not found`);

    return this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      const created = await tx.programElementDataIssue.create({
        data: {
          tenantId: ctx.tenantId,
          reportedByUserId: ctx.userId,
          peCode,
          fy,
          fieldName,
          issueType,
          description,
          suggestedSourceUrl,
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
          after: {
            peCode,
            fy,
            fieldName,
            issueType,
            descriptionLength: description.length,
            hasSuggestedSourceUrl: suggestedSourceUrl != null,
          },
        },
      });
      return created;
    });
  }

  async listForPe(
    peCodeRaw: string,
    ctx: DefenseTenantContext,
    opts: { status?: string; page?: number; limit?: number } = {},
  ) {
    const peCode = requirePeCode(peCodeRaw);
    const page = normalizePage(opts.page);
    const limit = normalizeLimit(opts.limit);
    const status = this.normalizeStatusFilter(opts.status);
    const where = { peCode, ...(status ? { status } : {}) };
    const { total, rows } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [count, items] = await Promise.all([
        tx.programElementDataIssue.count({ where }),
        tx.programElementDataIssue.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);
      return { total: count, rows: items };
    });
    return { data: rows, total, page, limit };
  }

  async listAdmin(
    ctx: DefenseTenantContext,
    opts: { status?: string; peCode?: string; page?: number; limit?: number } = {},
  ) {
    const page = normalizePage(opts.page);
    const limit = normalizeLimit(opts.limit);
    const status = this.normalizeStatusFilter(opts.status);
    const peCode = opts.peCode ? requirePeCode(opts.peCode) : undefined;
    const where = { ...(status ? { status } : {}), ...(peCode ? { peCode } : {}) };
    const { total, rows } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [count, items] = await Promise.all([
        tx.programElementDataIssue.count({ where }),
        tx.programElementDataIssue.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);
      return { total: count, rows: items };
    });
    return { data: rows, total, page, limit };
  }

  async resolve(issueId: string, input: ResolvePeDataIssueInput, ctx: DefenseTenantContext) {
    if (input.status !== 'resolved' && input.status !== 'dismissed') {
      throw new BadRequestException('status must be resolved or dismissed');
    }
    const notes = this.normalizeResolutionNotes(input.resolutionNotes);

    return this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      const existing = await tx.programElementDataIssue.findFirst({ where: { id: issueId } });
      if (!existing) throw new NotFoundException(`Data issue ${issueId} not found`);
      if (existing.status !== 'open') {
        throw new BadRequestException(
          `Data issue ${issueId} is already ${existing.status} and cannot be re-resolved`,
        );
      }

      // Snapshot a canonical PE year marker BEFORE resolve so the non-mutation
      // invariant is provable in-band, not merely asserted.
      const markerSelect = {
        fy: true,
        request: true,
        enacted: true,
        conference: true,
        hascMark: true,
        sascMark: true,
        hacDMark: true,
        sacDMark: true,
        ndaaConference: true,
      } as const;
      const marker = await tx.programElementYear.findFirst({
        where: { peCode: existing.peCode },
        orderBy: { fy: 'desc' },
        select: markerSelect,
      });

      const updated = await tx.programElementDataIssue.update({
        where: { id: existing.id },
        data: {
          status: input.status,
          resolutionNotes: notes,
          resolvedByUserId: ctx.userId,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      const markerAfter = await tx.programElementYear.findFirst({
        where: { peCode: existing.peCode },
        orderBy: { fy: 'desc' },
        select: markerSelect,
      });

      if (JSON.stringify(marker) !== JSON.stringify(markerAfter)) {
        throw new BadRequestException(
          'Data-issue resolution must not mutate canonical Program Element values',
        );
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
          after: {
            status: updated.status,
            peCode: existing.peCode,
            fieldName: existing.fieldName,
            canonicalRowUnchanged: true,
          },
        },
      });

      return updated;
    });
  }

  // -- validators (service-layer, so a non-HTTP caller cannot bypass them) ----

  private requireIssueType(raw: string): PeDataIssueType {
    const value = (raw ?? '').trim();
    if (!(PE_DATA_ISSUE_TYPES as readonly string[]).includes(value)) {
      throw new BadRequestException(`issueType must be one of: ${PE_DATA_ISSUE_TYPES.join(', ')}`);
    }
    return value as PeDataIssueType;
  }

  private requireDescription(raw: string): string {
    const description = (raw ?? '').trim();
    if (!description) throw new BadRequestException('description is required');
    if (description.length > PE_DATA_ISSUE_MAX_DESCRIPTION) {
      throw new BadRequestException(
        `description must be <= ${PE_DATA_ISSUE_MAX_DESCRIPTION} characters`,
      );
    }
    return description;
  }

  private normalizeFy(raw: number | null | undefined): number | null {
    if (raw == null || (typeof raw === 'number' && Number.isNaN(raw))) return null;
    const fy = Number(raw);
    if (!Number.isInteger(fy) || fy < 1900 || fy > 2200) {
      throw new BadRequestException('fy must be an integer between 1900 and 2200');
    }
    return fy;
  }

  private normalizeFieldName(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    const value = raw.trim();
    if (!value) return null;
    if (!ALLOWED_DATA_ISSUE_FIELD_NAMES.has(value)) {
      throw new BadRequestException(
        `fieldName must be an allowed PE/year/source field (got "${value}")`,
      );
    }
    return value;
  }

  private normalizeSourceUrl(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    const value = raw.trim();
    if (!value) return null;
    if (value.length > PE_DATA_ISSUE_MAX_URL) {
      throw new BadRequestException(
        `suggestedSourceUrl must be <= ${PE_DATA_ISSUE_MAX_URL} characters`,
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new BadRequestException('suggestedSourceUrl must be a valid http(s) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('suggestedSourceUrl must use http or https');
    }
    return value;
  }

  private normalizeResolutionNotes(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    const value = raw.trim();
    if (!value) return null;
    if (value.length > PE_DATA_ISSUE_MAX_RESOLUTION_NOTES) {
      throw new BadRequestException(
        `resolutionNotes must be <= ${PE_DATA_ISSUE_MAX_RESOLUTION_NOTES} characters`,
      );
    }
    return value;
  }

  private normalizeStatusFilter(raw: string | null | undefined): string | undefined {
    const status = raw?.trim();
    if (!status) return undefined;
    if (!(PE_DATA_ISSUE_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(`status must be one of: ${PE_DATA_ISSUE_STATUSES.join(', ')}`);
    }
    return status;
  }
}
