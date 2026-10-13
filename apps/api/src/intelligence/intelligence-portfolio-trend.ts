import type { PrismaService } from '../prisma/prisma.service.js';
import type { PortfolioEngagementTrendResponse } from './intelligence.service.js';
import { buildQuarterWindows, foldEngagementTrend } from './intelligence-portfolio-quarters.js';

export class IntelligencePortfolioTrend {
  constructor(private readonly prisma: PrismaService) {}

  async getPortfolioEngagementTrend(tenantId: string): Promise<PortfolioEngagementTrendResponse> {
    const quarters = buildQuarterWindows(new Date(), 6); // oldest → newest
    const windowStart = quarters[0]!.start;

    const [outreach, mail] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.outreachRecord.findMany({
          where: {
            clientId: { not: null },
            deletedAt: null,
            sentAt: { gte: windowStart },
            client: { status: { not: 'archived' } },
          },
          select: { sentAt: true },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.mailThread.findMany({
          where: {
            clientId: { not: null },
            lastMessageAt: { gte: windowStart },
            client: { status: { not: 'archived' } },
          },
          select: { lastMessageAt: true },
        }),
      ),
    ]);

    return foldEngagementTrend(quarters, outreach, mail);
  }
}
