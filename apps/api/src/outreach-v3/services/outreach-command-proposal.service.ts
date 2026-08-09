import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  OutreachStateRepository,
  type OutreachProposalRow,
} from '../persistence/outreach-state.repository.js';
import {
  canonicalJsonStringify,
  OUTREACH_V3_LIMITS,
} from '../state/outreach-campaign-spec.v1.js';
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

  /** Server-only Phase 3 seam. Browser DTOs never expose `source`. */
  async createModelProposal(
    ctx: TenantContext,
    sessionId: string,
    input: { expectedStateVersion: number; commands: unknown[] },
  ): Promise<OutreachProposalRow> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.createModelProposalWithinTx(tx, ctx, sessionId, input),
    );
  }

  /**
   * Transaction-composable variant used by the reasoning gateway so model
   * proposal creation, proposal audit, visible turn audit, and provider-ref
   * update commit or roll back together. This still creates a pending proposal
   * only; it never invokes the command engine.
   */
  async createModelProposalWithinTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
    input: { expectedStateVersion: number; commands: unknown[] },
  ): Promise<OutreachProposalRow> {
    const commands = this.parseNormalizeCommands(input.commands);
    const commandsHash = hashNormalizedOutreachCommands(commands);
    const commandsJson = JSON.stringify(commands);
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
        'The outreach session changed before the model proposal was created.',
        409,
        { currentStateVersion: session.currentStateVersion },
      );
    }

    const rows = await tx.$queryRaw<OutreachProposalRow[]>`
      INSERT INTO outreach_command_proposals (
        tenant_id, session_id, created_by_user_id, source, expected_state_version,
        commands_jsonb, commands_hash, status
      ) VALUES (
        CAST(${ctx.tenantId} AS uuid), CAST(${session.id} AS uuid),
        CAST(${ctx.userId} AS uuid), 'future_model', ${input.expectedStateVersion},
        CAST(${commandsJson} AS jsonb), ${commandsHash}, 'pending'
      )
      RETURNING
        id,
        tenant_id AS "tenantId",
        session_id AS "sessionId",
        created_by_user_id AS "createdByUserId",
        source,
        expected_state_version AS "expectedStateVersion",
        commands_jsonb AS "commandsJsonb",
        commands_hash AS "commandsHash",
        status,
        created_at AS "createdAt",
        decided_at AS "decidedAt",
        decided_by_user_id AS "decidedByUserId",
        applied_state_version AS "appliedStateVersion",
        rejection_code AS "rejectionCode"
    `;
    const proposal = rows[0];
    if (!proposal) throw new Error('OUTREACH_MODEL_PROPOSAL_CREATE_FAILED');

    await this.repository.appendEvent(tx, ctx, session, {
      eventType: 'proposal_created',
      source: 'future_model',
      stateVersionBefore: session.currentStateVersion,
      stateVersionAfter: session.currentStateVersion,
      safeMetadata: {
        proposalId: proposal.id,
        expectedStateVersion: proposal.expectedStateVersion,
        commandCount: commands.length,
        commandsHash,
        source: 'future_model',
      },
    });
    return proposal;
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
    if (!Array.isArray(input) || input.length === 0 || input.length > OUTREACH_V3_LIMITS.commandsPerBatch) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_INVALID',
        `A proposal must contain between 1 and ${OUTREACH_V3_LIMITS.commandsPerBatch} commands.`,
        400,
      );
    }
    const normalized = input.map((entry) =>
      parseOutreachCommandEnvelope(
        normalizeOutreachCommandEnvelope(parseOutreachCommandEnvelope(entry)),
      ),
    );
    const bytes = Buffer.byteLength(canonicalJsonStringify(normalized), 'utf8');
    if (bytes > OUTREACH_V3_LIMITS.commandBatchBytes) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BATCH_TOO_LARGE',
        'The proposal command payload exceeds the allowed size.',
        413,
        { bytes, maxBytes: OUTREACH_V3_LIMITS.commandBatchBytes },
      );
    }
    return normalized;
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
