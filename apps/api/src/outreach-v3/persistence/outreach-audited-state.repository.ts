import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { supersedeStaleOutreachProposals } from './outreach-proposal-supersession.js';
import { OutreachStateRepository } from './outreach-state.repository.js';

/**
 * Phase 2 audit-hardening wrapper around the state repository.
 *
 * Every caller of supersedeStaleProposals already owns the outreach_sessions
 * row lock. UPDATE ... RETURNING gives this layer the exact proposal rows whose
 * status changed, so one durable ledger event is appended for every eager
 * supersession in the same transaction with no pre-read race or pagination cap.
 */
@Injectable()
export class OutreachAuditedStateRepository extends OutreachStateRepository {
  override async supersedeStaleProposals(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
    currentStateVersion: number,
    excludeProposalId: string | null = null,
  ): Promise<number> {
    const superseded = await supersedeStaleOutreachProposals(
      tx,
      ctx,
      sessionId,
      currentStateVersion,
      excludeProposalId,
    );

    for (const proposal of superseded) {
      await this.appendEvent(tx, ctx, { id: sessionId }, {
        eventType: 'proposal_superseded',
        source: 'system',
        stateVersionBefore: proposal.expectedStateVersion,
        stateVersionAfter: currentStateVersion,
        safeMetadata: {
          proposalId: proposal.id,
          expectedStateVersion: proposal.expectedStateVersion,
          currentStateVersion,
          reason: 'state_advanced',
        },
      });
    }

    return superseded.length;
  }
}
