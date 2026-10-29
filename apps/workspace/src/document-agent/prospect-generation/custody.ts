import { NotFoundException } from '@nestjs/common';
import {
  workspaceProspectGenerationSourceWithinTx,
  workspaceGenerationConversationId,
} from '@capiro/shared/workspace-prospect-generation-source';
import type { Prisma, WsAgentProposal } from '../../../generated/prisma-client/index.js';
import { readDraftSnapshotInTx } from '../../drafts/atomic-draft-save.js';
import {
  generationPayload,
  PROSPECT_GENERATION,
  type ProspectGenerationPayload,
} from './contract.js';

export async function loadProspectProposal(
  tx: Prisma.TransactionClient,
  tenantId: string,
  draftId: string,
  prospectId: string,
  actorId: string,
  proposalId: string,
) {
  const row = await tx.wsAgentProposal.findFirst({
    where: { id: proposalId, tenantId, draftId, type: PROSPECT_GENERATION },
  });
  if (!row) throw new NotFoundException('Generation proposal not found');
  const payload = generationPayload(row.payload);
  if (payload.source.prospectId !== prospectId || payload.source.draftId !== draftId)
    throw new NotFoundException('Generation proposal not found');
  const source = await workspaceProspectGenerationSourceWithinTx(
    tx,
    tenantId,
    { clerkUserId: actorId },
    payload.source,
    { edit: true },
  );
  const current = await readDraftSnapshotInTx(tx, tenantId, draftId, prospectId);
  return { row, payload, source, current };
}

export function prospectProposalReply(
  row: WsAgentProposal,
  payload: ProspectGenerationPayload,
  stateHash: string,
  full = true,
) {
  return {
    schemaVersion: 1 as const,
    tenantId: row.tenantId,
    draftId: row.draftId,
    prospectId: payload.source.prospectId,
    proposalId: row.id,
    conversationId: workspaceGenerationConversationId(payload.turn.requestId),
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    status: row.status,
    phase: payload.phase,
    stale: row.status === 'pending' && row.baseHash !== stateHash,
    baseStateHash: row.baseHash,
    source: payload.source,
    selectedSections: payload.input.selectedSections,
    writingBrief: payload.input.writingBrief,
    outputHash: payload.outputHash ?? null,
    output: full ? (payload.output ?? null) : null,
    failureReason: payload.failureReason ?? null,
    decision: payload.decision ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}
