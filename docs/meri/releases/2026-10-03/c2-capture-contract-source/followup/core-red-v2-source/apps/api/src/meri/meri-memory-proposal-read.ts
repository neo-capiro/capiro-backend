import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { hasAtLeast, type TenantContext } from '@capiro/shared';
import type { MeriPendingMemoryProposalRead } from '@capiro/shared/meri-read-outcome';
import type { GovernedMemoryCandidateService } from '../memory/governed-memory-candidate.service.js';

/** Read the canonical proposer queue. No projection, provider, decision or approved recall. */
export async function readOwnPendingMemoryProposals(
  ctx: TenantContext,
  input: Record<string, unknown>,
  owner?: Pick<GovernedMemoryCandidateService, 'listOwnProposals'>,
): Promise<MeriPendingMemoryProposalRead> {
  if (!ctx.tenantId || !ctx.userId || !hasAtLeast(ctx.role, 'standard_user')) {
    throw new ForbiddenException('Memory proposals require an authenticated ordinary user.');
  }
  if (!owner) throw new ServiceUnavailableException('Memory proposal reads are unavailable.');
  const { clientId, cursor, limit } = input;
  if (clientId != null && (typeof clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId))) {
    throw new BadRequestException('clientId must be a client UUID.');
  }
  if (cursor != null && (typeof cursor !== 'string' || !cursor || cursor.length > 2048)) {
    throw new BadRequestException('cursor is invalid.');
  }
  if (limit != null && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10)) {
    throw new BadRequestException('limit must be an integer from 1 to 10.');
  }
  const page = await owner.listOwnProposals(ctx, {
    ...(clientId ? { clientId: clientId as string } : {}),
    ...(cursor ? { cursor: cursor as string } : {}),
    limit: (limit as number | undefined) ?? 5,
    status: 'pending',
  });
  const candidates: MeriPendingMemoryProposalRead['candidates'] = page.candidates.map((row) => {
    if (row.status !== 'pending') throw new Error('memory_proposal_owner_status_mismatch');
    if (clientId && row.clientId && row.clientId !== clientId) throw new Error('memory_proposal_owner_scope_mismatch');
    const proposal = row.restricted ? null : row.proposal;
    const title = proposal?.canonicalItem?.title ?? proposal?.key ?? null;
    const text = proposal?.canonicalItem
      ? proposal.canonicalItem.sections.map((section) => `${section.heading}\n${section.body}`).join('\n\n')
      : proposal?.value ?? null;
    return {
      id: row.id, status: 'pending', approvedFact: false, scope: row.scope,
      clientId: row.clientId, sourceKind: row.sourceKind, createdAt: row.createdAt,
      restricted: row.restricted, title: title?.slice(0, 200) ?? null,
      proposedText: text?.slice(0, 2000) ?? null,
      contentTruncated: (title?.length ?? 0) > 200 || (text?.length ?? 0) > 2000,
    };
  });
  const complete = page.enabled && !cursor && page.nextCursor === null &&
    candidates.every((row) => !row.restricted && !row.contentTruncated && row.proposedText !== null);
  return {
    tool: 'list_memory_proposals', enabled: page.enabled, authority: 'own_pending_proposals',
    claimsAreApprovedFacts: false,
    scope: { tenantId: ctx.tenantId, userId: ctx.userId, clientId: (clientId as string | null) ?? null },
    candidates, nextCursor: page.nextCursor,
    coverage: { firstPage: !cursor, complete, reason: !page.enabled ? 'review_disabled'
      : complete ? 'own_pending_proposals_complete' : 'unread_pages_restricted_or_truncated_content' },
  };
}
