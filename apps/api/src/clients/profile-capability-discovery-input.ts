import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { portfolioEvidenceVisible } from './portfolio/portfolio-source-access.js';
import { parsePortfolio, proposalSchema } from './portfolio/portfolio.contracts.js';

export interface ResearchBusinessUnit {
  id: string;
  name: string;
  annualReportYear: number;
  sourceUrls: string[];
}

export async function readApprovedResearchBusinessUnit(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  id: string,
): Promise<ResearchBusinessUnit> {
  if (!isUUID(id)) throw new BadRequestException('Invalid business unit');
  const row = await tx.clientPortfolioProposal.findFirst({
    where: { id, tenantId: ctx.tenantId, clientId, kind: 'business_unit', status: 'approved' },
  });
  if (!row || !(await portfolioEvidenceVisible(tx, ctx, clientId, row.evidence)))
    throw new NotFoundException('Approved business unit not found');
  const proposal = parsePortfolio(proposalSchema, {
    kind: row.kind,
    payload: row.payload,
    evidence: row.evidence,
  });
  if (proposal.kind !== 'business_unit') throw new BadRequestException('Invalid business unit');
  return {
    id: row.id,
    name: proposal.payload.name,
    annualReportYear: proposal.payload.annualReportYear,
    sourceUrls: proposal.evidence.flatMap((source) => (source.url ? [source.url] : [])),
  };
}

export function readResearchBusinessUnit(value: unknown): ResearchBusinessUnit {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Invalid saved business unit');
  const unit = value as Partial<ResearchBusinessUnit>;
  if (
    !unit.id ||
    !isUUID(unit.id) ||
    typeof unit.name !== 'string' ||
    !unit.name.trim() ||
    unit.name.length > 180 ||
    !Number.isSafeInteger(unit.annualReportYear) ||
    !Array.isArray(unit.sourceUrls) ||
    unit.sourceUrls.length > 24 ||
    unit.sourceUrls.some((url) => typeof url !== 'string' || !/^https?:\/\//.test(url))
  )
    throw new BadRequestException('Invalid saved business unit');
  return {
    id: unit.id,
    name: unit.name,
    annualReportYear: unit.annualReportYear!,
    sourceUrls: unit.sourceUrls,
  };
}
