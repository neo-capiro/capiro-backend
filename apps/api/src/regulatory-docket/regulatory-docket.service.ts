import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface RegulatoryDocketFilters {
  query?: string;
  agencyId?: string;
  documentType?: string;
  page?: number;
  limit?: number;
}

/** One bounded, literal title selector shared by the tool and docket reader. */
export function regulatoryDocketTitleQuery(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 200)
    throw new BadRequestException('Docket title query must be a string at most 200 characters');
  return value.trim() || undefined;
}

function titleFilter(query: string) {
  // Prisma contains uses PostgreSQL ILIKE. Preserve literal %, _ and backslash
  // using the same escaping convention as the existing source search owners.
  return { contains: query.replace(/[\\%_]/g, (character) => `\\${character}`), mode: 'insensitive' as const };
}

export interface PagedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Service exposing Regulations.gov docket data.
 *
 * GLOBAL table, no tenant_id, no RLS.
 * Populated by `pnpm sync:regulatory-dockets`.
 */
@Injectable()
export class RegulatoryDocketService {
  constructor(private readonly prisma: PrismaService) {}

  async listDockets(filters: RegulatoryDocketFilters): Promise<PagedResult<object>> {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 25));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    const query = regulatoryDocketTitleQuery(filters.query);
    if (query) where.title = titleFilter(query);
    if (filters.agencyId) where.agencyId = filters.agencyId;
    if (filters.documentType) where.documentType = filters.documentType;

    const [data, total] = await Promise.all([
      this.prisma.regulatoryDocket.findMany({
        where,
        orderBy: { postedDate: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.regulatoryDocket.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async getDocket(documentId: string): Promise<object> {
    const doc = await this.prisma.regulatoryDocket.findUnique({
      where: { documentId },
    });
    if (!doc) throw new NotFoundException(`Regulatory docket ${documentId} not found`);
    return doc;
  }

  async getUpcomingDeadlines(days = 30, query?: string): Promise<object[]> {
    const titleQuery = regulatoryDocketTitleQuery(query);
    const now = new Date();
    const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return this.prisma.regulatoryDocket.findMany({
      where: {
        ...(titleQuery ? { title: titleFilter(titleQuery) } : {}),
        commentEndDate: { gte: now, lte: cutoff },
        withdrawn: false,
      },
      orderBy: { commentEndDate: 'asc' },
      take: 50,
    });
  }
}
