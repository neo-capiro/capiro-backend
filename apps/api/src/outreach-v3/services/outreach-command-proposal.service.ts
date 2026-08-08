import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OutreachStateRepository } from '../persistence/outreach-state.repository.js';
import {
  parseOutreachCommandEnvelope,
  type ParsedOutreachCommandEnvelope,
} from '../state/outreach-command.contract.js';
import {
  hashNormalizedOutreachCommands,
  normalizeOutreachCommandEnvelope,
} from '../state/outreach-command-normalization.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { OutreachCommandEngineService } from './outreach-command-engine.service.js';

@Injectable()
export class OutreachCommandProposalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: OutreachStateRepository,
    private readonly commandEngine: OutreachCommandEngineService,
  ) {}

  async createProposal(
    ctx: TenantContext,
    sessionId: string,
    input: { expectedStateVersion: number; commands: unknown[] },
  ) {
    const commands = this.parseNormalizeCommands(input.commands);
    const commandsHash = hashNormalizedOutreachCommands(commands);

    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const session = await this.repository.lockOwnedSession(tx, ctx, sessionId);
      if (session.status === 'archived') {
        throw new OutreachCommandError(
          'OUTREACH_SESSION_ARCHIVED',
          'Archived outreach sessions cannot accept new proposals.',
          409,
        );
      }
      if (session.currentStateVersion !== input.expectedStateVersion) {
        throw new OutreachCommandError(
          'OUTREACH_STATE_CONFLICT',
          'The outreach session changed before the proposal was created.',
          409,
          { currentStateVersion: session.currentStateVersion },
        );
      }

      const proposal = await this.repository.createProposal(tx, ctx, session, {
        expectedStateVersion: input.expectedStateVersion,
        commands,
        commandsHash,
      });
      await this.repository.appendEvent(tx, ctx, session, {
        eventType: 'proposal_created',
        source: 'user_proposal',
        stateVersionBefore: session.currentStateVersion,
        stateVersionAfter: session.currentStateVersion,
        safeMetadata: {
          proposalId: proposal.id,
          expectedStateVersion: proposal.expectedStateVersion,
          commandCount: commands.length,
          commandsHash,
        },
      });
      return proposal;
    });
  }

  async listProposals(ctx: TenantContext, sessionId: string, limit = 100) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.repository.listOwnedProposals(tx, ctx, sessionId, Math.min(Math.max(limit, 1), 200)),
    );
  }

  async rejectProposal(
    ctx: TenantContext,
    sessionId: string,
    proposalId: string,
    rejectionCode?: string | null,
  ) {
    const boundedCode = rejectionCode?.trim().slice(0, 64) || null;
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const session = await this.repository.lockOwnedSession(tx, ctx, sessionId);
      const proposal = await this.repository.lockOwnedProposal(tx, ctx, sessionId, proposalId);
      if (proposal.status !== 'pending') {
        throw new OutreachCommandError(
          'OUTREACH_PROPOSAL_ALREADY_DECIDED',
          'The outreach proposal is no longer pending.',
          409,
        );
      }
      await this.repository.rejectProposal(tx, ctx, proposal.id, boundedCode);
      await this.repository.appendEvent(tx, ctx, session, {
        eventType: 'proposal_rejected',
        source: 'user_proposal',
        stateVersionBefore: session.currentStateVersion,
        stateVersionAfter: session.currentStateVersion,
        safeMetadata: { proposalId: proposal.id, rejectionCode: boundedCode },
      });
      return { id: proposal.id, status: 'rejected' as const };
    });
  }

  async applyProposal(ctx: TenantContext, sessionId: string, proposalId: string) {
    const outcome = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const session = await this.repository.lockOwnedSession(tx, ctx, sessionId);
      const proposal = await this.repository.lockOwnedProposal(tx, ctx, sessionId, proposalId);

      // State-changing command batches proactively terminalize proposals that
      // target the old version. Keep that eager supersession, but surface the
      // contract-specific stale error when a user later presses Apply instead of
      // collapsing it into a generic already-decided response.
      if (proposal.status === 'superseded') {
        throw new OutreachCommandError(
          'OUTREACH_PROPOSAL_STALE',
          'The outreach proposal targets an older campaign state and cannot be rebased automatically.',
          409,
          { currentStateVersion: session.currentStateVersion },
        );
      }
      if (proposal.status !== 'pending') {
        throw new OutreachCommandError(
          'OUTREACH_PROPOSAL_ALREADY_DECIDED',
          'The outreach proposal is no longer pending.',
          409,
        );
      }
      if (session.status === 'archived') {
        throw new OutreachCommandError(
          'OUTREACH_SESSION_ARCHIVED',
          'Archived outreach sessions cannot apply proposals.',
          409,
        );
      }

      if (proposal.expectedStateVersion !== session.currentStateVersion) {
        // Persist the terminal stale decision before surfacing the 409. Throwing
        // inside the transaction would roll this audit transition back.
        await tx.$executeRaw`
          UPDATE outreach_command_proposals
          SET status = 'superseded', decided_at = NOW(), rejection_code = 'state_advanced'
          WHERE id = CAST(${proposal.id} AS uuid)
            AND tenant_id = CAST(${ctx.tenantId} AS uuid)
            AND status = 'pending'
        `;
        await this.repository.appendEvent(tx, ctx, session, {
          eventType: 'proposal_superseded',
          source: 'user_proposal',
          stateVersionBefore: session.currentStateVersion,
          stateVersionAfter: session.currentStateVersion,
          safeMetadata: {
            proposalId: proposal.id,
            expectedStateVersion: proposal.expectedStateVersion,
            currentStateVersion: session.currentStateVersion,
          },
        });
        return {
          stale: true as const,
          currentStateVersion: session.currentStateVersion,
        };
      }

      const commands = this.parseNormalizeStoredCommands(proposal.commandsJsonb);
      if (hashNormalizedOutreachCommands(commands) !== proposal.commandsHash) {
        throw new OutreachCommandError(
          'OUTREACH_STATE_CORRUPT',
          'The stored outreach proposal hash does not match its commands.',
          500,
        );
      }

      // Proposal Apply owns its mutation identity. Do not reuse proposal.id as a
      // public command-batch UUID: direct controls accept caller-chosen batch IDs,
      // so a caller who knows the proposal UUID could otherwise pre-consume that
      // idempotency key before pressing Apply. This UUID is generated server-side
      // inside the same transaction; proposal terminal state prevents a second
      // committed Apply, while a rollback discards both the state and proposal stamp.
      const commandBatchId = randomUUID();
      const batch = this.commandEngine.parseNormalizeAndValidateBatch({
        batchId: commandBatchId,
        expectedStateVersion: proposal.expectedStateVersion,
        commands,
      });
      const result = await this.commandEngine.applyBatchWithinTx(
        tx,
        ctx,
        session.id,
        batch,
        {
          source: 'user_proposal',
          prelockedSession: session,
          excludeProposalId: proposal.id,
        },
      );

      await this.repository.markProposalApplied(tx, ctx, proposal.id, result.stateVersion);
      await this.repository.appendEvent(tx, ctx, session, {
        eventType: 'proposal_applied',
        source: 'user_proposal',
        stateVersionBefore: proposal.expectedStateVersion,
        stateVersionAfter: result.stateVersion,
        safeMetadata: {
          proposalId: proposal.id,
          commandBatchId,
          result: result.status,
        },
      });
      return { stale: false as const, proposalId: proposal.id, result };
    });

    if (outcome.stale) {
      throw new OutreachCommandError(
        'OUTREACH_PROPOSAL_STALE',
        'The outreach proposal targets an older campaign state and cannot be rebased automatically.',
        409,
        { currentStateVersion: outcome.currentStateVersion },
      );
    }
    return outcome;
  }

  private parseNormalizeCommands(input: unknown[]): ParsedOutreachCommandEnvelope[] {
    if (!Array.isArray(input) || input.length === 0 || input.length > 20) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_INVALID',
        'A proposal must contain between 1 and 20 commands.',
        400,
      );
    }
    return input.map((entry) =>
      parseOutreachCommandEnvelope(normalizeOutreachCommandEnvelope(parseOutreachCommandEnvelope(entry))),
    );
  }

  private parseNormalizeStoredCommands(input: unknown): ParsedOutreachCommandEnvelope[] {
    if (!Array.isArray(input)) {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CORRUPT',
        'The stored outreach proposal command list is malformed.',
        500,
      );
    }
    try {
      return this.parseNormalizeCommands(input);
    } catch (error) {
      if (error instanceof OutreachCommandError && error.code === 'OUTREACH_STATE_CORRUPT') {
        throw error;
      }
      throw new OutreachCommandError(
        'OUTREACH_STATE_CORRUPT',
        'The stored outreach proposal command list is malformed.',
        500,
      );
    }
  }
}
