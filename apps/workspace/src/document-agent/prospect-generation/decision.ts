import { withProspectDraft } from '../../prospect-resources/prospect-draft-access.js';
import { canEdit } from '../../collaborators/role-policy.js';
import type { CollaboratorsService } from '../../collaborators/collaborators.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { saveAtomicDraft } from '../../drafts/atomic-draft-save.js';
import { generationDecision, generationConflict, generationHash, record } from './contract.js';
import { loadProspectProposal, prospectProposalReply } from './custody.js';

/** The canonical atomic save commits acceptance, provenance and document bytes
 * together. Its immutable version is the acceptance receipt and replay owner. */
export async function decideProspectGeneration(
  prisma: PrismaService,
  collaborators: CollaboratorsService,
  tenantId: string,
  draftId: string,
  prospectId: string,
  actorId: string,
  proposalId: string,
  raw: unknown,
) {
  const input = generationDecision(raw);
  const requestHash = generationHash({ tenantId, draftId, prospectId, actorId, proposalId, input });
  const decide = { requestId: input.requestId, actorId, decision: input.decision, requestHash };
  const origin = { tenantId, id: draftId, prospectId };
  const selected = await withProspectDraft(
    prisma,
    origin,
    actorId,
    canEdit,
    'write',
    async (tx) => {
      const result = await loadProspectProposal(
        tx,
        tenantId,
        draftId,
        prospectId,
        actorId,
        proposalId,
      );
      const { row, payload } = result;
      if (payload.decision && payload.decision.requestHash !== requestHash)
        return generationConflict('DECISION_CONFLICT');
      if (!payload.decision && row.status !== 'pending')
        return generationConflict('DECISION_CONFLICT');
      if (
        payload.phase !== 'ready' ||
        !payload.output ||
        payload.outputHash !== input.outputHash ||
        generationHash(payload.output) !== input.outputHash ||
        input.expectedStateHash !== row.baseHash
      )
        return generationConflict('OUTPUT_CONFLICT');
      if (input.decision === 'reject') {
        const updated = payload.decision
          ? row
          : await tx.wsAgentProposal.update({
              where: { id: row.id },
              data: {
                status: 'rejected',
                decidedById: actorId,
                decidedAt: new Date(),
                payload: { ...payload, decision: decide } as never,
              },
            });
        return { ...result, row: updated, payload: { ...payload, decision: decide } };
      }
      return result;
    },
  );
  if (input.decision === 'reject')
    return {
      schemaVersion: 1 as const,
      proposal: prospectProposalReply(selected.row, selected.payload, selected.current.stateHash),
      save: null,
    };
  const { payload } = selected,
    output = payload.output!;
  const config = {
    ...record(selected.source.content.config),
    sections: output.names,
    sectionContent: output.sections,
    prospectGeneration: {
      proposalId,
      nativeRequestId: payload.turn.requestId,
      sourceVersionId: payload.source.sourceVersionId,
      sourceSnapshotHash: payload.source.sourceSnapshotHash,
      outputHash: payload.outputHash,
      acceptedById: actorId,
      decisionRequestId: input.requestId,
    },
  };
  const saveInput = {
    requestId: input.requestId,
    expectedStateHash: input.expectedStateHash,
    expectedClientId: null,
    label: 'Accepted generated proposal',
    draft: { docTitle: output.title, config },
  };
  const saved = await saveAtomicDraft(
    prisma,
    collaborators,
    tenantId,
    draftId,
    actorId,
    saveInput,
    async (tx) => {
      const current = await loadProspectProposal(
        tx,
        tenantId,
        draftId,
        prospectId,
        actorId,
        proposalId,
      );
      if (current.row.status !== 'pending' || current.payload.outputHash !== input.outputHash)
        return generationConflict('DECISION_CONFLICT');
      await tx.wsDraft.update({
        where: { id: draftId, tenantId },
        data: { docTitle: output.title, config: config as never, lastEditedById: actorId },
      });
      await tx.wsAgentProposal.update({
        where: { id: proposalId },
        data: {
          status: 'accepted',
          decidedById: actorId,
          decidedAt: new Date(),
          payload: { ...current.payload, decision: decide } as never,
        },
      });
    },
    prospectId,
  );
  const proposal = await withProspectDraft(prisma, origin, actorId, canEdit, 'read', async (tx) => {
    const current = await loadProspectProposal(
      tx,
      tenantId,
      draftId,
      prospectId,
      actorId,
      proposalId,
    );
    return prospectProposalReply(current.row, current.payload, current.current.stateHash);
  });
  return { schemaVersion: 1 as const, proposal, save: saved };
}
