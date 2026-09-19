import { Injectable } from '@nestjs/common';
import {
  normalizeOpportunitySearchCriteria,
  type OpportunitySearchRecordV2,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  readSourceSql,
  type SqlRow,
} from './funding-opportunity-v2-search.sql.js';
import type { OpportunityClientProfile } from './funding-opportunity-v2-search.service.js';

/** Exact cached CA source read used by detail/workflow consumers. No live fetch. */
export type CaliforniaGrantSourceRecord = OpportunitySearchRecordV2;

@Injectable()
export class CaliforniaGrantSourceReader {
  constructor(private readonly prisma: PrismaService) {}

  async readOne(
    portalId: string,
    options: {
      mode?: 'all' | 'matched';
      clientId?: string | null;
      profile?: OpportunityClientProfile | null;
    } = {},
  ): Promise<CaliforniaGrantSourceRecord | null> {
    const id = portalId.trim();
    if (!id) return null;
    const { criteria } = normalizeOpportunitySearchCriteria({
      mode: options.mode ?? 'all',
      clientId: options.clientId ?? undefined,
      sources: ['ca_portal'],
      lifecycle: [],
      page: 1,
      pageSize: 1,
    });
    const result = await readSourceSql(
      this.prisma,
      'ca_portal',
      criteria,
      options.profile ?? null,
      id,
    );
    return result.records[0] ?? null;
  }
}

export type { SqlRow };
