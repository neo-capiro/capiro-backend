import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  dateOnly,
  EVIDENCE_MAX_AGE_MS,
  readEffectiveDateEvidence,
} from './effective-date-evidence.js';

export interface FederalRegisterFilters {
  type?: string;
  agency?: string;
  topic?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
}

export interface PagedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Service exposing Federal Register document data.
 *
 * GLOBAL table, no tenant_id, no RLS.
 * Populated by `pnpm sync:federal-register`.
 */
@Injectable()
export class FederalRegisterService {
  constructor(private readonly prisma: PrismaService) {}

  async getEffectiveDateCalendar(input: {
    dateFrom: string;
    dateTo: string;
    page?: number;
    limit?: number;
  }) {
    const from = dateOnly(input.dateFrom);
    const to = dateOnly(input.dateTo);
    const page = input.page ?? 1;
    const limit = input.limit ?? 50;
    if (
      !from ||
      !to ||
      from > to ||
      Date.parse(to) - Date.parse(from) > 366 * 86400000 ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 10000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new BadRequestException(
        'Effective-date range must be valid YYYY-MM-DD, at most 366 days; page 1–10000, limit 1–100',
      );
    }
    const now = new Date();
    const offset = (page - 1) * limit;
    return this.prisma.$transaction(
      async (tx) => {
        const [count] = await tx.$queryRaw<Array<{ total: bigint }>>`
        SELECT count(*) AS total FROM federal_register_document
        WHERE type = 'RULE' AND effective_date >= ${new Date(from)} AND effective_date <= ${new Date(to)}
          AND effective_date_evidence->>'status' = 'supported'`;
        const rows = await tx.$queryRaw<
          Array<{
            documentNumber: string;
            title: string;
            agencyNames: string[];
            effectiveDate: Date;
            evidence: unknown;
            observedAt: Date | null;
          }>
        >`SELECT document_number AS "documentNumber", title, agency_names AS "agencyNames",
          effective_date AS "effectiveDate", effective_date_evidence AS evidence,
          effective_date_observed_at AS "observedAt"
        FROM federal_register_document
        WHERE type = 'RULE' AND effective_date >= ${new Date(from)} AND effective_date <= ${new Date(to)}
          AND effective_date_evidence->>'status' = 'supported'
        ORDER BY effective_date, document_number LIMIT ${limit} OFFSET ${offset}`;
        const [catalog] = await tx.$queryRaw<
          Array<{ rules: bigint; withoutEvidence: bigint; notSupported: bigint }>
        >`
        SELECT count(*) AS rules,
          count(*) FILTER (WHERE effective_date_evidence IS NULL) AS "withoutEvidence",
          count(*) FILTER (WHERE effective_date_evidence IS NOT NULL
            AND effective_date_evidence->>'status' IS DISTINCT FROM 'supported') AS "notSupported"
        FROM federal_register_document WHERE type = 'RULE'`;
        const runSelect = {
          source: true,
          startedAt: true,
          finishedAt: true,
          status: true,
          rowsUpdated: true,
          errorCount: true,
          stats: true,
        } as const;
        const latestIngestion = await tx.syncRun.findFirst({
          where: { source: 'sync-federal-register' },
          orderBy: { startedAt: 'desc' },
          select: runSelect,
        });
        const latestRefresh = await tx.syncRun.findFirst({
          where: { source: 'sync-federal-register-effective-dates' },
          orderBy: { startedAt: 'desc' },
          select: runSelect,
        });
        const data = rows.flatMap((row) => {
          const evidence = readEffectiveDateEvidence(row.evidence, row.documentNumber);
          if (
            !evidence ||
            evidence.status !== 'supported' ||
            !row.observedAt ||
            row.observedAt.toISOString() !== evidence.observedAt ||
            row.effectiveDate.toISOString() !== `${evidence.date}T00:00:00.000Z` ||
            row.observedAt.getTime() > now.getTime() ||
            now.getTime() - row.observedAt.getTime() > EVIDENCE_MAX_AGE_MS
          )
            return [];
          return [
            {
              documentNumber: row.documentNumber,
              title: row.title,
              agencyNames: row.agencyNames,
              date: evidence.date,
              dateKind: 'effective' as const,
              provenance: evidence,
            },
          ];
        });
        return {
          data,
          range: { dateFrom: from, dateTo: to },
          page,
          limit,
          pagination: {
            totalCandidates: Number(count.total),
            returned: data.length,
            excludedOnPage: rows.length - data.length,
            hasMoreCandidates: offset + rows.length < Number(count.total),
          },
          coverage: {
            scope: 'locally_ingested_rule_publisher_metadata',
            complete: false,
            allFederalRules: false,
            parsedFullDatesSection: false,
            separatelyIssuedCorrectionsResolved: false,
            asOf: now.toISOString(),
            maximumObservationAgeHours: EVIDENCE_MAX_AGE_MS / 3600000,
            catalogRules: Number(catalog.rules),
            withoutEvidence: Number(catalog.withoutEvidence),
            unsupportedEvidence: Number(catalog.notSupported),
            latestIngestion,
            latestRefresh,
            refreshRequired: true,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async listDocuments(filters: FederalRegisterFilters): Promise<PagedResult<object>> {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 25));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (filters.type) where.type = filters.type.toUpperCase();
    if (filters.agency) where.agencyNames = { has: filters.agency };
    if (filters.topic) where.topics = { has: filters.topic };
    if (filters.dateFrom || filters.dateTo) {
      const dateFilter: Record<string, unknown> = {};
      if (filters.dateFrom) dateFilter.gte = new Date(filters.dateFrom);
      if (filters.dateTo) dateFilter.lte = new Date(filters.dateTo);
      where.publicationDate = dateFilter;
    }

    const [data, total] = await Promise.all([
      this.prisma.federalRegisterDocument.findMany({
        where,
        orderBy: { publicationDate: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.federalRegisterDocument.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async getDocument(documentNumber: string): Promise<object> {
    const doc = await this.prisma.federalRegisterDocument.findUnique({
      where: { documentNumber },
    });
    if (!doc) throw new NotFoundException(`Federal Register document ${documentNumber} not found`);
    return doc;
  }

  async getUpcomingDeadlines(days = 30): Promise<object[]> {
    const now = new Date();
    const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return this.prisma.federalRegisterDocument.findMany({
      where: {
        commentEndDate: { gte: now, lte: cutoff },
      },
      orderBy: { commentEndDate: 'asc' },
      take: 50,
    });
  }

  async getByAgency(agencyName: string, page = 1, limit = 25): Promise<PagedResult<object>> {
    const pg = Math.max(1, page);
    const lim = Math.min(100, Math.max(1, limit));
    const skip = (pg - 1) * lim;

    const where: Record<string, unknown> = {
      agencyNames: { has: agencyName },
    };

    const [data, total] = await Promise.all([
      this.prisma.federalRegisterDocument.findMany({
        where,
        orderBy: { publicationDate: 'desc' },
        skip,
        take: lim,
      }),
      this.prisma.federalRegisterDocument.count({ where }),
    ]);

    return { data, total, page: pg, limit: lim };
  }
}
