// Document Agent Revision Service — creates and manages revision proposals.
// A proposal must be accepted or rejected; it never silently edits the document.

import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { computeContentHash, computeOutlineHash } from './document-agent-state.js';

/** Error code for stale proposals. */
export const PROPOSAL_STALE_CODE = 'PROPOSAL_STALE';

@Injectable()
export class DocumentAgentRevisionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a revision proposal. Stores baseRevision + baseHash for staleness
   * detection.
   */
  async createProposal(params: {
    tenantId: string;
    draftId: string;
    createdById: string;
    type: string;
    baseRevision: number;
    baseHash: string;
    payload: Record<string, unknown>;
  }): Promise<{ proposalId: string }> {
    const proposal = await this.prisma.wsAgentProposal.create({
      data: {
        tenantId: params.tenantId,
        draftId: params.draftId,
        createdById: params.createdById,
        type: params.type,
        status: 'pending',
        baseRevision: params.baseRevision,
        baseHash: params.baseHash,
        payload: params.payload as never,
      },
    });
    return { proposalId: proposal.id };
  }

  /**
   * Verify that a proposal is not stale: recompute the affected-content hash
   * and compare with baseHash. Returns true if still valid, false if stale.
   */
  verifyNotStale(
    baseHash: string,
    currentHash: string,
  ): boolean {
    return baseHash === currentHash;
  }

  /**
   * Compute the base hash for an outline-based proposal.
   */
  computeOutlineBaseHash(sections: Array<{ id: string; title: string; required: boolean; locked: boolean }>): string {
    return computeOutlineHash(
      sections as unknown as Parameters<typeof computeOutlineHash>[0],
    );
  }

  /**
   * Compute the base hash for a content-based proposal.
   */
  computeContentBaseHash(content: Record<string, string>): string {
    return computeContentHash(content);
  }
}
