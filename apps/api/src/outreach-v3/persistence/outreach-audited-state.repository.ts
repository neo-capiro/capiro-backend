import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { OutreachStateRepository } from './outreach-state.repository.js';

interface SupersededProposalAuditRow {
  id: string;
  expectedStateVersion: number;
}

/**
 * Phase 2 audit-hardening wrapper around the state repository.
 *
 * Every caller of supersedeStaleProposals already owns the outreach_sessions
 * row lock. Under that lock we can capture the exact pending proposal set,
 * terminalize it through the canonical repository operation, and append one
 * durable event per transition in the same transaction. Any count drift fails
 * the transaction closed instead of leaving proposal state ahead of its ledger.
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
    const stale = await tx.$queryRaw<SupersededProposalAuditRow[]>`
      SELECT
        id,
        expected_state_version AS "expectedStateVersion"
      FROM outreach_command_proposals
      WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND session_id = CAST(${sessionId} AS uuid)
        AND status = 'pending'
        AND expected_state_version < ${currentStateVersion}
        AND (${excludeProposalId}::text IS NULL OR id <> CAST(${excludeProposalId} AS uuid))
      ORDER BY id
    `;

    const changed = await super.supersedeStaleProposals(
      tx,
      ctx,
      sessionId,
      currentStateVersion,
      excludeProposalId,
    );

    if (changed !== stale.length) {
      throw new Error(
        `OUTREACH_PROPOSAL_SUPERSESSION_AUDIT_MISMATCH:${changed}:${stale.length}`,
      );
    }

    for (const proposal of stale) {
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

    return changed;
  }
}
