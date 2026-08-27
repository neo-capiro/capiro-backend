import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { sha256CanonicalJson } from '../../defense-budget/contracts/canonical-json.js';
import { communityFundingIdentity } from './community-funding.identity.js';
import { normalizeIdentityText } from './community-funding.parser.js';
import type { FundingCandidate } from './community-funding.types.js';

@Injectable()
export class CommunityFundingUpsertService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertMany(candidates: FundingCandidate[], sourceDocumentId: string, retrievedAt = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      let upserted = 0, changed = 0;
      for (const candidate of candidates) {
        const identityHash = communityFundingIdentity(candidate, sourceDocumentId);
        const sourceHash = sha256CanonicalJson(candidate as unknown as Parameters<typeof sha256CanonicalJson>[0]);
        const existing = await tx.communityFundingRequest.findUnique({ where: { identityHash }, select: { sourceHash: true } });
        // Collision policy: identity fields changing creates a new identity. Non-identity
        // corrections under the same identity update the canonical row and provenance.
        await tx.communityFundingRequest.upsert({ where: { identityHash }, create: this.data(candidate, sourceDocumentId, retrievedAt, identityHash, sourceHash),
          update: this.data(candidate, sourceDocumentId, retrievedAt, identityHash, sourceHash) });
        if (!existing) upserted++; else if (existing.sourceHash !== sourceHash) changed++;
      }
      return { upserted, changed, unchanged: candidates.length - upserted - changed };
    });
  }

  private data(c: FundingCandidate, sourceDocumentId: string, retrievedAt: Date, identityHash: string, sourceHash: string) {
    return { identityHash, chamber: c.chamber, requestType: c.requestType, fiscalYear: c.fiscalYear,
      requesterName: c.requesterName, requesterState: c.requesterState, requesterDistrict: c.requesterDistrict,
      recipientName: c.recipientName, recipientNormalized: normalizeIdentityText(c.recipientName), recipientAddress: c.recipientAddress,
      city: c.city, state: c.state, zip: c.zip, projectTitle: c.projectTitle, projectDescription: c.projectDescription,
      requestedAmountUsd: c.requestedAmountUsd, finalAmountUsd: c.finalAmountUsd, amountStageRaw: c.amountStageRaw,
      appropriationsAccountRaw: c.appropriationsAccountRaw,
      appropriationsAccountNormalized: c.appropriationsAccountRaw ? normalizeIdentityText(c.appropriationsAccountRaw) : null,
      subcommittee: c.subcommittee, sourceDocumentId, sourcePage: c.sourcePage, sourceRow: c.sourceRow, retrievedAt, sourceHash };
  }
}
