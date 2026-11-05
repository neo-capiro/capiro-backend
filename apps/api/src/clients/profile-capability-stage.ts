import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { FillEvidence } from './client-profile-fill.helpers.js';
import type { PortfolioCapabilitiesReviewService } from './portfolio/portfolio-capabilities-review.service.js';
import { parsePortfolio, proposalSchema } from './portfolio/portfolio.contracts.js';

/** Bridge for the existing research task transaction after its cancellation/attempt fence. */
export async function stageProfileCapabilityFinding(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  subject: { kind: 'client' | 'prospect'; id: string },
  input: { kind: string; source: string; proposedValue: unknown; evidence: FillEvidence[] },
  review: Pick<PortfolioCapabilitiesReviewService, 'stageExtractedCapabilitiesInTransaction'>,
) {
  // Prospects deliberately keep the lighter section set; never create a hidden client/capability.
  if (subject.kind !== 'client' || input.kind !== 'capability') return null;
  const value = input.proposedValue;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Invalid extracted capability');
  const p = value as Record<string, unknown>;
  const evidence = input.evidence.map((source) => {
    const attachmentId =
      typeof source.metadata?.attachmentId === 'string' ? source.metadata.attachmentId : undefined;
    const url = source.url || undefined;
    if (!source.excerpt?.trim() || !source.observedAt || (!url && !attachmentId))
      throw new BadRequestException(
        'Capability evidence requires an observed date and a supporting source excerpt',
      );
    return {
      title: source.label.slice(0, 180),
      excerpt: source.excerpt.slice(0, 4000),
      observedAt: source.observedAt,
      ...(url ? { url } : {}),
      ...(attachmentId ? { attachmentId } : {}),
      sourceType: attachmentId
        ? 'document'
        : url && /(^|\.)gov$/i.test(new URL(url).hostname)
          ? 'official'
          : 'company',
    };
  });
  const proposal = parsePortfolio(proposalSchema, {
    kind: 'capability',
    ...(typeof p.capabilityId === 'string' ? {capabilityId:p.capabilityId} : {}),
    payload: {
      name: p.name,
      type: p.type,
      lifecycle: p.lifecycle ?? 'unspecified',
      description: p.description ?? '',
      tags: Array.isArray(p.tags) ? p.tags : [],
      classification: p.classification ?? 'capability',
      ...(typeof p.expectedCapabilityVersion === 'number' ? {expectedCapabilityVersion:p.expectedCapabilityVersion} : {}),
      ...(typeof p.businessUnitId === 'string' ? { businessUnitId: p.businessUnitId } : {}),
    },
    evidence,
  });
  const [staged] = await review.stageExtractedCapabilitiesInTransaction(tx, ctx, subject.id, [
    proposal,
  ]);
  return staged ?? null;
}
