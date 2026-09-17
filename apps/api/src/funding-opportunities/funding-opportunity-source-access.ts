import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  FUNDING_OPPORTUNITIES_FEATURE,
  FUNDING_OPPORTUNITIES_FORECASTS_FEATURE,
  isFundingOpportunitiesFeatureEnabled,
} from './funding-opportunities-flag.guard.js';
import type { StorableOpportunitySource } from './funding-opportunity-identity.js';

/** Shared by HTTP reads, counts and non-HTTP actions. DIBBS is master-only (D-80). */
export async function readEnabledFundingSources(
  prisma: PrismaService,
  tenantId: string,
): Promise<StorableOpportunitySource[]> {
  try {
    if (
      !(await isFundingOpportunitiesFeatureEnabled(prisma, tenantId, FUNDING_OPPORTUNITIES_FEATURE))
    ) {
      throw new NotFoundException('Funding opportunities is unavailable.');
    }
    const [forecasts, sbir] = await Promise.all([
      isFundingOpportunitiesFeatureEnabled(
        prisma,
        tenantId,
        FUNDING_OPPORTUNITIES_FORECASTS_FEATURE,
      ),
      isFundingOpportunitiesFeatureEnabled(prisma, tenantId, 'funding_opportunities_sbir'),
    ]);
    return [
      'grants_gov',
      'sam_gov',
      'dibbs',
      'ca_portal',
      ...(forecasts ? ['agency_forecast' as const] : []),
      ...(sbir ? ['sbir_sttr' as const] : []),
    ];
  } catch {
    throw new NotFoundException('Funding opportunities is unavailable.');
  }
}

export async function requireFundingSourceAccess(
  prisma: PrismaService,
  tenantId: string,
  source: StorableOpportunitySource,
): Promise<void> {
  const sources = await readEnabledFundingSources(prisma, tenantId);
  if (!sources.includes(source))
    throw new NotFoundException('This opportunity feed is unavailable.');
}
