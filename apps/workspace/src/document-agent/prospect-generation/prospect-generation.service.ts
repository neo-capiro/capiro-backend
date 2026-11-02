import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { WorkspaceRevisionUnavailable } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CollaboratorsService } from '../../collaborators/collaborators.service.js';
import { canEdit } from '../../collaborators/role-policy.js';
import {
  withProspectDraft,
  assertNoBoundBriefCopy,
} from '../../prospect-resources/prospect-draft-access.js';
import { readDraftSnapshotInTx } from '../../drafts/atomic-draft-save.js';
import {
  NATIVE_GENERATION_TURN,
  type NativeGenerationTurnPort,
} from '../native-generation.bridge.js';
import { DocumentAgentRevisionService } from '../document-agent-revision.service.js';
import { ProspectGenerationBootstrapClient } from './bootstrap.client.js';
import { prepareProspectGeneration } from './prepare.js';
import {
  admitProspectOutcome,
  generationConflict,
  generationHash,
  generationInput,
  generationPayload,
  PROSPECT_GENERATION,
} from './contract.js';
import { loadProspectProposal, prospectProposalReply } from './custody.js';
import { decideProspectGeneration } from './decision.js';
import { NativeGenerationOwnerError } from '../native-generation-conversation.client.js';

@Injectable()
export class ProspectGenerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
    private readonly revisions: DocumentAgentRevisionService,
    private readonly bootstrap: ProspectGenerationBootstrapClient,
    @Inject(NATIVE_GENERATION_TURN) private readonly native: NativeGenerationTurnPort | null,
  ) {}

  private within<T>(
    tenantId: string,
    draftId: string,
    prospectId: string,
    actorId: string,
    callback: Parameters<typeof withProspectDraft<T>>[5],
  ) {
    return withProspectDraft(
      this.prisma,
      { tenantId, id: draftId, prospectId },
      actorId,
      canEdit,
      'write',
      callback,
    ).catch((error) => {
      if (error instanceof WorkspaceRevisionUnavailable)
        throw new NotFoundException('Generation source not found');
      throw error;
    });
  }

  async list(tenantId: string, draftId: string, prospectId: string, actorId: string) {
    return this.within(tenantId, draftId, prospectId, actorId, async (tx) => {
      const current = await readDraftSnapshotInTx(tx, tenantId, draftId, prospectId);
      const rows = await tx.wsAgentProposal.findMany({
        where: { tenantId, draftId, type: PROSPECT_GENERATION },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
      });
      return {
        schemaVersion: 1 as const,
        tenantId,
        draftId,
        prospectId,
        stateHash: current.stateHash,
        available: Boolean(this.native && this.bootstrap.configured()),
        proposals: rows.map((row) =>
          prospectProposalReply(row, generationPayload(row.payload), current.stateHash, false),
        ),
      };
    });
  }

  read(tenantId: string, draftId: string, prospectId: string, actorId: string, proposalId: string) {
    return this.within(tenantId, draftId, prospectId, actorId, async (tx) => {
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
  }

  async generate(
    tenantId: string,
    draftId: string,
    actorId: string,
    raw: unknown,
    credential?: string,
  ) {
    if (!credential) throw new UnauthorizedException('A current session is required');
    if (!this.native || !this.bootstrap.configured())
      throw new ServiceUnavailableException('Prospect generation is not configured');
    const input = generationInput(raw),
      prospectId = input.expectedProspectId;
    const created = await this.within(tenantId, draftId, prospectId, actorId, async (tx) => {
      await assertNoBoundBriefCopy(tx, tenantId, draftId);
      const current = await readDraftSnapshotInTx(tx, tenantId, draftId, prospectId);
      const previous = await tx.wsAgentProposal.findFirst({
        where: { id: input.requestId, tenantId, draftId, type: PROSPECT_GENERATION },
      });
      if (previous) {
        if (
          previous.createdById !== actorId ||
          generationPayload(previous.payload).requestHash !==
            generationHash({ tenantId, draftId, actorId, input })
        )
          return generationConflict('REQUEST_CONFLICT');
        return false;
      }
      if (current.stateHash !== input.expectedStateHash)
        return generationConflict('STATE_CONFLICT');
      const payload = await prepareProspectGeneration(tx, tenantId, draftId, actorId, input);
      await this.revisions.createProspectGeneration(tx, tenantId, draftId, actorId, payload);
      return true;
    });
    return created
      ? this.advance(tenantId, draftId, prospectId, actorId, input.requestId, credential, 'retry')
      : this.read(tenantId, draftId, prospectId, actorId, input.requestId);
  }

  /** Exact retries use the native owner's existing request identity. Readback
   * never starts a model; no local queue or replacement run is introduced. */
  async advance(
    tenantId: string,
    draftId: string,
    prospectId: string,
    actorId: string,
    proposalId: string,
    credential: string | undefined,
    operation: 'retry' | 'reconcile',
  ) {
    if (!credential) throw new UnauthorizedException('A current session is required');
    if (!this.native || !this.bootstrap.configured())
      throw new ServiceUnavailableException('Prospect generation is not configured');
    const selected = await this.within(tenantId, draftId, prospectId, actorId, async (tx) => {
      const current = await loadProspectProposal(
        tx,
        tenantId,
        draftId,
        prospectId,
        actorId,
        proposalId,
      );
      if (current.row.createdById !== actorId) return generationConflict('ACTOR_CONFLICT');
      if (
        current.row.status !== 'pending' ||
        ['ready', 'failed'].includes(current.payload.phase) ||
        (operation === 'retry' && current.payload.phase === 'approval-required')
      )
        return null;
      await tx.wsAgentProposal.update({
        where: { id: proposalId },
        data: { payload: { ...current.payload, phase: 'unknown' } as never },
      });
      return current.payload;
    });
    if (!selected) return this.read(tenantId, draftId, prospectId, actorId, proposalId);
    let outcome;
    try {
      await this.bootstrap.register(tenantId, selected.turn.actorId, selected.source, credential);
      outcome =
        operation === 'retry'
          ? await this.native.turn(selected.turn, { credential })
          : await this.native.readTurn(selected.turn, credential);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500) throw error;
      if (error instanceof NativeGenerationOwnerError) {
        if (error.code === 'authority')
          throw new ForbiddenException('Current generation access was not confirmed');
        if (error.code === 'conflict') return generationConflict('REQUEST_CONFLICT');
        if (error.code === 'refused')
          throw new ServiceUnavailableException('Generation was refused by the configured owner');
        if (error.code === 'output')
          return this.within(tenantId, draftId, prospectId, actorId, async (tx) => {
            const current = await loadProspectProposal(
              tx,
              tenantId,
              draftId,
              prospectId,
              actorId,
              proposalId,
            );
            if (
              current.row.status !== 'pending' ||
              ['ready', 'failed'].includes(current.payload.phase)
            )
              return prospectProposalReply(current.row, current.payload, current.current.stateHash);
            const payload = {
              ...current.payload,
              phase: 'failed' as const,
              failureReason: 'output-invalid' as const,
            };
            const row = await tx.wsAgentProposal.update({
              where: { id: proposalId },
              data: { payload: payload as never },
            });
            return prospectProposalReply(row, payload, current.current.stateHash);
          });
      }
      // The retained unknown is intentional. Lost acknowledgements never turn
      // into failure, fresh paid attempts, accepted content or invented success.
      return this.read(tenantId, draftId, prospectId, actorId, proposalId);
    }
    return this.within(tenantId, draftId, prospectId, actorId, async (tx) => {
      const current = await loadProspectProposal(
        tx,
        tenantId,
        draftId,
        prospectId,
        actorId,
        proposalId,
      );
      if (current.row.status !== 'pending' || ['ready', 'failed'].includes(current.payload.phase))
        return prospectProposalReply(current.row, current.payload, current.current.stateHash);
      const admitted = admitProspectOutcome(current.payload, outcome);
      if (current.payload.runId && admitted.runId && current.payload.runId !== admitted.runId)
        return generationConflict('OUTPUT_CONFLICT');
      const row = await tx.wsAgentProposal.update({
        where: { id: proposalId },
        data: { payload: admitted as never },
      });
      return prospectProposalReply(row, admitted, current.current.stateHash);
    });
  }

  decide(
    tenantId: string,
    draftId: string,
    prospectId: string,
    actorId: string,
    proposalId: string,
    raw: unknown,
  ) {
    return decideProspectGeneration(
      this.prisma,
      this.collaborators,
      tenantId,
      draftId,
      prospectId,
      actorId,
      proposalId,
      raw,
    ).catch((error) => {
      if (error instanceof WorkspaceRevisionUnavailable)
        throw new NotFoundException('Generation source not found');
      throw error;
    });
  }
}
