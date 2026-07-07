import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Minimal read-only view over apps/api's ai_usage_events for the overage
 * cron: total real LLM cost per tenant for a window. Deliberately NOT a port
 * of apps/api's AiUsageService — the cron needs one aggregate, so a single
 * raw SUM (withSystem — the table is RLS'd and the cron has no tenant
 * context) is the whole dependency.
 */
@Injectable()
export class AiUsageReaderService {
  constructor(private readonly prisma: PrismaService) {}

  /** Total real LLM cost (USD) for a tenant since `from` (inclusive). */
  async tenantCostUsdSince(tenantId: string, from: Date): Promise<number> {
    const rows = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<Array<{ total: number | null }>>`
          SELECT SUM(cost_usd)::float8 AS total
          FROM ai_usage_events
          WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${from}
        `,
    );
    return rows[0]?.total ?? 0;
  }
}
