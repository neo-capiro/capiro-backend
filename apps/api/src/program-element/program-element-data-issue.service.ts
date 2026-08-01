import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { CANONICAL_PE_YEAR_FIELDS } from './program-element-field-ownership.js';

export const PE_DATA_ISSUE_TYPES = [
  'value_incorrect',
  'missing_value',
  'wrong_source',
  'wrong_stage_or_vehicle',
  'wrong_pe_attribution',
  'other',
] as const;

export type PeDataIssueType = (typeof PE_DATA_ISSUE_TYPES)[number];

export const PE_DATA_ISSUE_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type PeDataIssueStatus = (typeof PE_DATA_ISSUE_STATUSES)[number];

/** Allowed field names for issue reports (canonical PE/year + a few UI claim labels). */
const ALLOWED_FIELD_NAMES = new Set<string>([
  ...CANONICAL_PE_YEAR_FIELDS,
  'title',
  'description',
  'service',
  'budgetActivity',
  'appropriationType',
  'fundingSummary',
  'timeline',
  'personnel',
  'contractors',
  'other',
]);

const MAX_DESCRIPTION = 4000;
const MAX_RESOLUTION_NOTES = 4000;
const MAX_URL = 2000;

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

export interface PeDataIssueDto {
  id: string;
  tenantId: string;
  peCode: string;
  fy: number | null;
  fieldName: string | null;
  issueType: string;
  description: string;
  suggestedSourceUrl: string | null;
  status: string;
  resolutionNotes: string | null;
  reportedByUserId: string;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ProgramElementDataIssueService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    peCodeRaw: string,
    input: CreatePeDataIssueInput,
    ctx: TenantContext,
  ): Promise<PeDataIssueDto> {
    const peCode = this.normalizePeCode(peCodeRaw);
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

    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
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
            // Intentionally no free-text description / URL / names (PII hygiene).
            hasSuggestedSourceUrl: suggestedSourceUrl != null,
            descriptionLength: description.length,
          },
        },
      });

      return created;
    });

    return this.toDto(row);
  }

  async listForPe(
    peCodeRaw: string,
    ctx: TenantContext,
    opts: { status?: string; page?: number; limit?: number } = {},
  ): Promise<{ data: PeDataIssueDto[]; total: number; page: number; limit: number }> {
    const peCode = this.normalizePeCode(peCodeRaw);
    const page = this.normalizePage(opts.page);
    const limit = this.normalizeLimit(opts.limit);
    const status = opts.status?.trim() || undefined;
    if (status && !(PE_DATA_ISSUE_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(
        `status must be one of: ${PE_DATA_ISSUE_STATUSES.join(', ')}`,
      );
    }

    const where = {
      peCode,
      ...(status ? { status } : {}),
    };

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

    return { data: rows.map((r) => this.toDto(r)), total, page, limit };
  }

  async listAdmin(
    ctx: TenantContext,
    opts: { status?: string; peCode?: string; page?: number; limit?: number } = {},
  ): Promise<{ data: PeDataIssueDto[]; total: number; page: number; limit: number }> {
    // Capario admin still runs inside tenant RLS (no global scan of other tenants
    // via this tenant-scoped list). Cross-tenant admin tooling is out of scope.
    const page = this.normalizePage(opts.page);
    const limit = this.normalizeLimit(opts.limit);
    const status = opts.status?.trim() || undefined;
    if (status && !(PE_DATA_ISSUE_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(
        `status must be one of: ${PE_DATA_ISSUE_STATUSES.join(', ')}`,
      );
    }
    const peCode = opts.peCode ? this.normalizePeCode(opts.peCode) : undefined;

    const where = {
      ...(status ? { status } : {}),
      ...(peCode ? { peCode } : {}),
    };

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

    return { data: rows.map((r) => this.toDto(r)), total, page, limit };
  }

  /**
   * Resolve or dismiss an issue. Never mutates ProgramElement / ProgramElementYear.
   * Canonical corrections remain on the reconciliation / manual_override path.
   */
  async resolve(
    issueId: string,
    input: ResolvePeDataIssueInput,
    ctx: TenantContext,
  ): Promise<PeDataIssueDto> {
    if (input.status !== 'resolved' && input.status !== 'dismissed') {
      throw new BadRequestException('status must be resolved or dismissed');
    }
    const notes = this.normalizeResolutionNotes(input.resolutionNotes);

    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.programElementDataIssue.findFirst({
        where: { id: issueId },
      });
      if (!existing) {
        throw new NotFoundException(`Data issue ${issueId} not found`);
      }
      if (existing.status !== 'open') {
        throw new BadRequestException(
          `Data issue ${issueId} is already ${existing.status} and cannot be re-resolved`,
        );
      }

      // Snapshot a canonical PE year marker BEFORE resolve so tests can prove
      // residual non-mutation (read-only; no PE writer call here).
      const marker = await tx.programElementYear.findFirst({
        where: { peCode: existing.peCode },
        orderBy: { fy: 'desc' },
        select: {
          fy: true,
          request: true,
          enacted: true,
          conference: true,
          hascMark: true,
          sascMark: true,
          hacDMark: true,
          sacDMark: true,
          ndaaConference: true,
        },
      });

      const updated = await tx.programElementDataIssue.update({
        where: { id: existing.id },
        data: {
          status: input.status,
          resolutionNotes: notes,
          resolvedByUserId: ctx.userId,
          resolvedAt: new Date(),
        },
      });

      const markerAfter = await tx.programElementYear.findFirst({
        where: { peCode: existing.peCode },
        orderBy: { fy: 'desc' },
        select: {
          fy: true,
          request: true,
          enacted: true,
          conference: true,
          hascMark: true,
          sascMark: true,
          hacDMark: true,
          sacDMark: true,
          ndaaConference: true,
        },
      });

      if (JSON.stringify(marker) !== JSON.stringify(markerAfter)) {
        // Fail closed: resolution path must never write canonical PE dollars.
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
            fy: existing.fy,
            fieldName: existing.fieldName,
            issueType: existing.issueType,
            hasResolutionNotes: notes != null,
            // Confirm non-mutation was checked in-band.
            canonicalRowUnchanged: true,
          },
        },
      });

      return updated;
    });

    return this.toDto(row);
  }

  private toDto(row: {
    id: string;
    tenantId: string;
    peCode: string;
    fy: number | null;
    fieldName: string | null;
    issueType: string;
    description: string;
    suggestedSourceUrl: string | null;
    status: string;
    resolutionNotes: string | null;
    reportedByUserId: string;
    resolvedByUserId: string | null;
    resolvedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): PeDataIssueDto {
    return {
      id: row.id,
      tenantId: row.tenantId,
      peCode: row.peCode,
      fy: row.fy,
      fieldName: row.fieldName,
      issueType: row.issueType,
      description: row.description,
      suggestedSourceUrl: row.suggestedSourceUrl,
      status: row.status,
      resolutionNotes: row.resolutionNotes,
      reportedByUserId: row.reportedByUserId,
      resolvedByUserId: row.resolvedByUserId,
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private normalizePeCode(raw: string): string {
    const peCode = (raw ?? '').trim().toUpperCase();
    if (!peCode) throw new BadRequestException('peCode is required');
    if (peCode.length > 16) throw new BadRequestException('peCode is too long');
    return peCode;
  }

  private requireIssueType(raw: string): PeDataIssueType {
    const value = (raw ?? '').trim();
    if (!(PE_DATA_ISSUE_TYPES as readonly string[]).includes(value)) {
      throw new BadRequestException(
        `issueType must be one of: ${PE_DATA_ISSUE_TYPES.join(', ')}`,
      );
    }
    return value as PeDataIssueType;
  }

  private requireDescription(raw: string): string {
    const description = (raw ?? '').trim();
    if (!description) throw new BadRequestException('description is required');
    if (description.length > MAX_DESCRIPTION) {
      throw new BadRequestException(`description must be <= ${MAX_DESCRIPTION} characters`);
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
    if (!ALLOWED_FIELD_NAMES.has(value)) {
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
    if (value.length > MAX_URL) {
      throw new BadRequestException(`suggestedSourceUrl must be <= ${MAX_URL} characters`);
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
    if (value.length > MAX_RESOLUTION_NOTES) {
      throw new BadRequestException(
        `resolutionNotes must be <= ${MAX_RESOLUTION_NOTES} characters`,
      );
    }
    return value;
  }

  private normalizePage(raw?: number): number {
    const n = Number(raw ?? 1);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.floor(n);
  }

  private normalizeLimit(raw?: number): number {
    const n = Number(raw ?? 25);
    if (!Number.isFinite(n) || n < 1) return 25;
    return Math.min(Math.floor(n), 100);
  }
}
