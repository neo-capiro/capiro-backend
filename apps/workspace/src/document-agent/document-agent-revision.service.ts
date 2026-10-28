import { denyProspectTransfer } from '../prospect-resources/prospect-draft-access.js';
// Document Agent Revision Service — creates and manages revision proposals.
// A proposal must be accepted or rejected; it never silently edits the document.

import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { computeContentHash, computeOutlineHash } from './document-agent-state.js';

/** Error code for stale proposals. */
export const PROPOSAL_STALE_CODE = 'PROPOSAL_STALE';

/** The two delegates an insertion needs: this owner's client or a caller's transaction. */
type ProposalClient = Pick<PrismaService, 'wsDraft' | 'wsAgentProposal'>;

@Injectable()
export class DocumentAgentRevisionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a revision proposal. Stores baseRevision + baseHash for staleness
   * detection.
   */
  async createProposal(
    params: {
      tenantId: string;
      draftId: string;
      createdById: string;
      type: string;
      baseRevision: number;
      baseHash: string;
      payload: Record<string, unknown>;
    },
    /**
     * The client the row is inserted through. A caller that must establish the row
     * together with another durable effect (the workspace document agent's retained-run
     * admission) passes its own transaction client, so the insert commits or rolls back
     * with that effect instead of leaving an actionable row behind. Defaults to this
     * owner's client, so every existing caller is unchanged.
     */
    client: ProposalClient = this.prisma,
  ): Promise<{ proposalId: string }> {
    denyProspectTransfer(
      await client.wsDraft.findFirst({
        where: { tenantId: params.tenantId, id: params.draftId },
        select: { prospectId: true },
      }),
    );
    const proposal = await client.wsAgentProposal.create({
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
