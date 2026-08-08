import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CapabilityAuthorizationService } from '../../capabilities/capability-authorization.service.js';
import type { AuthorizedCapabilityContext } from '../../capabilities/capability-context.js';
import { CapabilityError } from '../../capabilities/capability-errors.js';
import {
  OutreachStateRepository,
  type OutreachEventSource,
  type OutreachSessionRow,
} from '../persistence/outreach-state.repository.js';
import {
  parseOutreachCommandBatch,
  type ApplyOutreachCommandBatchInput,
  type ParsedOutreachCommandEnvelope,
} from '../state/outreach-command.contract.js';
import {
  hashNormalizedOutreachCommandBatch,
  normalizeOutreachCommandBatch,
} from '../state/outreach-command-normalization.js';
import {
  hashCampaignSpecV1,
  parseCampaignSpecV1,
  type OutreachCampaignSpecV1,
} from '../state/outreach-campaign-spec.v1.js';
import { reduceOutreachCommand, type AuthorizedOutreachCommand } from '../state/outreach-command-reducer.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';

export interface OutreachCommandBatchResult {
  status: 'applied' | 'no_change';
  batchId: string;
  stateVersion: number;
  specHash: string;
  changed: boolean;
  commandCount: number;
  replayed: boolean;
}

export interface ApplyWithinTxOptions {
  source?: OutreachEventSource;
  prelockedSession?: OutreachSessionRow;
  excludeProposalId?: string | null;
}

@Injectable()
export class OutreachCommandEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: OutreachStateRepository,
    private readonly authorization: CapabilityAuthorizationService,
  ) {}

  async applyBatch(ctx: TenantContext, sessionId: string, input: unknown) {
    const batch = this.parseNormalizeAndValidateBatch(input);
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.applyBatchWithinTx(tx, ctx, sessionId, batch),
    );
  }

  parseNormalizeAndValidateBatch(input: unknown): ApplyOutreachCommandBatchInput {
    const parsed = parseOutreachCommandBatch(input);
    const normalized = normalizeOutreachCommandBatch(parsed);
    // Re-parse normalized output so transformations cannot create a state that
    // violates the strict command schema (e.g. explicit ask -> empty text).
    return parseOutreachCommandBatch(normalized);
  }

  async applyBatchWithinTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
    batch: ApplyOutreachCommandBatchInput,
    options: ApplyWithinTxOptions = {},
  ): Promise<OutreachCommandBatchResult> {
    const source = options.source ?? 'user_control';
    const batchHash = hashNormalizedOutreachCommandBatch(batch);
    const session =
      options.prelockedSession ?? (await this.repository.lockOwnedSession(tx, ctx, sessionId));

    // The session lock serializes both idempotency lookup and expected-version
    // comparison. A concurrent retry waits, then sees the committed result.
    const prior = await this.repository.findBatchResult(tx, ctx, sessionId, batch.batchId);
    if (prior) {
      if (prior.payloadHash !== batchHash) {
        throw new OutreachCommandError(
          'OUTREACH_COMMAND_ID_REUSE',
          'This command batch ID was already used for a different payload.',
          409,
        );
      }
      return this.replayResult(prior.safeMetadataJsonb, batch.batchId);
    }

    if (session.status === 'archived') {
      throw new OutreachCommandError(
        'OUTREACH_SESSION_ARCHIVED',
        'Archived outreach sessions cannot be mutated.',
        409,
      );
    }
    if (session.status !== 'active') {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'This outreach session is not active.',
        409,
      );
    }
    if (session.currentStateVersion !== batch.expectedStateVersion) {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CONFLICT',
        'The outreach session changed. Refresh before applying this command.',
        409,
        { currentStateVersion: session.currentStateVersion },
      );
    }

    const currentRow = await this.repository.loadStateVersion(
      tx,
      ctx,
      session.id,
      session.currentStateVersion,
    );
    const currentSpec = this.parseAndVerifyState(currentRow.specJsonb, currentRow.specHash);

    // Parse + authorize the entire batch before the first persistent mutation.
    const authorizedCommands: AuthorizedOutreachCommand[] = [];
    for (const command of batch.commands) {
      authorizedCommands.push(
        await this.authorizeCommandWithinTx(tx, ctx, session, command),
      );
    }

    let workingSpec = currentSpec;
    const commandAudit: Array<{ type: string; changed: boolean; restoreFromVersion?: number }> = [];
    for (const command of authorizedCommands) {
      const reduced = reduceOutreachCommand(workingSpec, command);
      workingSpec = reduced.nextSpec;
      commandAudit.push({
        type: command.type,
        changed: command.type === 'RESTORE_STATE_VERSION' ? true : reduced.changed,
        restoreFromVersion:
          command.type === 'RESTORE_STATE_VERSION'
            ? (command.payload as { version: number }).version
            : undefined,
      });
    }

    const finalSpec = parseCampaignSpecV1(workingSpec);
    const finalHash = hashCampaignSpecV1(finalSpec);
    const restoreRequested = authorizedCommands.some(
      (command) => command.type === 'RESTORE_STATE_VERSION',
    );
    const changed = restoreRequested || finalHash !== currentRow.specHash;
    const nextVersion = changed ? session.currentStateVersion + 1 : session.currentStateVersion;

    if (changed) {
      await this.repository.insertStateVersion(tx, ctx, {
        sessionId: session.id,
        version: nextVersion,
        schemaVersion: finalSpec.schemaVersion,
        specJsonb: finalSpec,
        specHash: finalHash,
        mutationBatchId: batch.batchId,
      });
      await this.repository.updateCurrentVersion(
        tx,
        ctx,
        session.id,
        session.currentStateVersion,
        nextVersion,
      );

      for (const audit of commandAudit) {
        await this.repository.appendEvent(tx, ctx, session, {
          eventType: 'command_applied',
          source,
          stateVersionBefore: session.currentStateVersion,
          stateVersionAfter: nextVersion,
          commandType: audit.type,
          safeMetadata: {
            changed: audit.changed,
            ...(audit.restoreFromVersion
              ? { restoredFromVersion: audit.restoreFromVersion }
              : {}),
          },
        });
      }

      await this.repository.supersedeStaleProposals(
        tx,
        ctx,
        session.id,
        nextVersion,
        options.excludeProposalId ?? null,
      );
    }

    const result: OutreachCommandBatchResult = {
      status: changed ? 'applied' : 'no_change',
      batchId: batch.batchId,
      stateVersion: nextVersion,
      specHash: changed ? finalHash : currentRow.specHash,
      changed,
      commandCount: batch.commands.length,
      replayed: false,
    };

    // Exactly one event per command batch carries command_batch_id. The partial
    // unique index turns this event into the durable idempotency result row.
    await this.repository.appendEvent(tx, ctx, session, {
      eventType: 'command_batch_result',
      source,
      stateVersionBefore: session.currentStateVersion,
      stateVersionAfter: nextVersion,
      commandBatchId: batch.batchId,
      payloadHash: batchHash,
      safeMetadata: result,
    });

    return result;
  }

  private async authorizeCommandWithinTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    session: OutreachSessionRow,
    command: ParsedOutreachCommandEnvelope,
  ): Promise<AuthorizedOutreachCommand> {
    if (command.type === 'SET_SPONSOR_SCOPE') {
      const refs = (command.payload as { clientRefs: Array<{ clientId: string }> }).clientRefs;
      await this.authorizeClientRefs(tx, ctx, session.id, refs.map((ref) => ref.clientId));
      return command;
    }

    if (command.type === 'RESTORE_STATE_VERSION') {
      const version = (command.payload as { version: number }).version;
      const row = await this.repository.loadStateVersion(tx, ctx, session.id, version);
      const restoreSpec = this.parseAndVerifyState(row.specJsonb, row.specHash);
      await this.authorizeClientRefs(
        tx,
        ctx,
        session.id,
        restoreSpec.sponsor.clientRefs.map((ref) => ref.clientId),
      );
      return { ...command, restoreSpec };
    }

    return command;
  }

  private async authorizeClientRefs(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
    clientIds: string[],
  ): Promise<void> {
    const capabilityContext: AuthorizedCapabilityContext = {
      actorUserId: ctx.userId,
      clerkUserId: ctx.clerkUserId,
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      role: ctx.role,
      clientScope: null,
      impersonation: null,
      requestId: `outreach-v3:${sessionId}`,
      surface: 'outreach',
    };

    for (const clientId of [...new Set(clientIds)]) {
      try {
        await this.authorization.authorizeClientWithinTx(tx, capabilityContext, clientId);
      } catch (error) {
        if (error instanceof CapabilityError) {
          throw new OutreachCommandError(
            'OUTREACH_REFERENCE_UNAUTHORIZED',
            'One or more campaign references are not authorized.',
            403,
          );
        }
        throw error;
      }
    }
  }

  private parseAndVerifyState(specJsonb: unknown, storedHash: string): OutreachCampaignSpecV1 {
    let spec: OutreachCampaignSpecV1;
    try {
      spec = parseCampaignSpecV1(specJsonb);
    } catch {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CORRUPT',
        'The current outreach state could not be validated.',
        500,
      );
    }
    if (hashCampaignSpecV1(spec) !== storedHash) {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CORRUPT',
        'The current outreach state hash does not match its canonical content.',
        500,
      );
    }
    return spec;
  }

  private replayResult(metadata: unknown, batchId: string): OutreachCommandBatchResult {
    if (!metadata || typeof metadata !== 'object') {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CORRUPT',
        'The durable command result is malformed.',
        500,
      );
    }
    const value = metadata as Partial<OutreachCommandBatchResult>;
    if (
      (value.status !== 'applied' && value.status !== 'no_change') ||
      typeof value.stateVersion !== 'number' ||
      typeof value.specHash !== 'string' ||
      typeof value.changed !== 'boolean' ||
      typeof value.commandCount !== 'number'
    ) {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CORRUPT',
        'The durable command result is malformed.',
        500,
      );
    }
    return {
      status: value.status,
      batchId,
      stateVersion: value.stateVersion,
      specHash: value.specHash,
      changed: value.changed,
      commandCount: value.commandCount,
      replayed: true,
    };
  }
}
