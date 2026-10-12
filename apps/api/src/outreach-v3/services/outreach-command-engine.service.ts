import { z } from 'zod';
import { createHash } from 'node:crypto';
import { workspaceSavedOutreachRevisionWithinTx, WorkspaceRevisionUnavailable, canonicalWorkspaceSnapshot } from '@capiro/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CapabilityAuthorizationService } from '../../capabilities/capability-authorization.service.js';
import type { AuthorizedCapabilityContext } from '../../capabilities/capability-context.js';
import { CapabilityError } from '../../capabilities/capability-errors.js';
import {
  OutreachTargetReferenceService,
  OUTREACH_REFERENCE_TX_TIMEOUT_MS,
} from '../../capabilities/targets/outreach-target-reference.service.js';
import { OutreachContextReferenceService } from '../../capabilities/context/outreach-context-reference.service.js';
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
  allAcceptedContextRefs,
  hashCampaignSpecV1,
  parseCampaignSpecV1,
  type OutreachCampaignSpecV1,
} from '../state/outreach-campaign-spec.v1.js';
import { reduceOutreachCommand, type AuthorizedOutreachCommand } from '../state/outreach-command-reducer.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { assertOutreachContextSponsorIsolation } from '../context/outreach-context-sponsor-policy.js';

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
  /** Bound provenance attached only by the saved-revision staging entrypoint. */
  savedRevisionStaging?: Record<string, unknown>;
}

@Injectable()
export class OutreachCommandEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: OutreachStateRepository,
    private readonly authorization: CapabilityAuthorizationService,
    private readonly targetReferences: OutreachTargetReferenceService,
    private readonly contextReferences: OutreachContextReferenceService,
  ) {}

  /** User-selected saved revision -> existing literal skeleton command. No
   * session creation, artifact creation, model call, upload or send occurs. */
  async stageSavedNewsletter(ctx: TenantContext, sessionId: string, input: unknown) {
    const selected = z.object({
      requestId: z.string().uuid().transform((s) => s.toLowerCase()),
      draftId: z.string().uuid().transform((s) => s.toLowerCase()),
      versionId: z.string().uuid().transform((s) => s.toLowerCase()),
      snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
      expectedStateVersion: z.number().int().positive(),
    }).strict().parse(input);
    sessionId = z.string().uuid().parse(sessionId).toLowerCase();
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const session = await this.repository.lockOwnedSession(tx, ctx, sessionId);
      let revision;
      try {
        revision = await workspaceSavedOutreachRevisionWithinTx(tx, {
          tenantId: ctx.tenantId, clerkUserId: ctx.clerkUserId, userId: ctx.userId,
          draftId: selected.draftId, versionId: selected.versionId,
        });
      } catch (error) {
        if (error instanceof WorkspaceRevisionUnavailable) throw unauthorizedReference('saved Workspace');
        throw error;
      }
      const snapshotHash = createHash('sha256').update(revision.snapshotJson).digest('hex');
      if (snapshotHash !== selected.snapshotHash) {
        throw new OutreachCommandError('OUTREACH_STATE_CONFLICT', 'The selected saved revision hash does not match. Refresh the selection.', 409);
      }
      const current = await this.repository.loadStateVersion(tx, ctx, session.id, session.currentStateVersion);
      const spec = this.parseAndVerifyState(current.specJsonb, current.specHash);
      await this.authorizeSavedRevisionSponsor(tx, ctx, session.id, spec, revision.clientId);
      const batch = this.parseNormalizeAndValidateBatch({
        batchId: selected.requestId, expectedStateVersion: selected.expectedStateVersion,
        commands: [{ type: 'SET_CONTENT_SKELETON', schemaVersion: 1, payload: { value: revision.contentSkeleton } }],
      });
      const requestHash = createHash('sha256').update(canonicalWorkspaceSnapshot({
        tenantId: ctx.tenantId.toLowerCase(), actorUserId: ctx.userId.toLowerCase(),
        sessionId, ...selected,
      })).digest('hex');
      const provenance = {
        kind: 'workspace_saved_newsletter_v1', requestHash, requestId: selected.requestId,
        draftId: revision.draftId, versionId: revision.versionId, snapshotHash,
        hashFormat: 'workspace-snapshot-canonical-json-v1',
        clientId: revision.clientId, savedAt: revision.savedAt,
        authorId: revision.authorId, authorKind: revision.authorKind,
        expectedStateVersion: selected.expectedStateVersion,
        commandHash: hashNormalizedOutreachCommandBatch(batch),
      };
      const prior = await this.repository.findBatchResult(tx, ctx, session.id, batch.batchId);
      if (prior) {
        const staging = (prior.safeMetadataJsonb as { savedRevisionStaging?: unknown } | null)?.savedRevisionStaging;
        // Generic command IDs and staging IDs share the existing durable unique
        // namespace; an ordinary command can never be upgraded into a receipt.
        if (!staging || canonicalWorkspaceSnapshot(staging) !== canonicalWorkspaceSnapshot(provenance)) {
          throw new OutreachCommandError('OUTREACH_COMMAND_ID_REUSE', 'This request ID was already used for another command or saved revision.', 409);
        }
      }
      const result = await this.applyBatchWithinTx(tx, ctx, session.id, batch, {
        prelockedSession: session, savedRevisionStaging: provenance,
      });
      const receipt = prior ?? await this.repository.findBatchResult(tx, ctx, session.id, batch.batchId);
      if (!receipt) throw new OutreachCommandError('OUTREACH_STATE_CORRUPT', 'The staging receipt was not recorded.', 500);
      return { ...result, receiptId: receipt.id, staged: provenance };
    }, { timeoutMs: OUTREACH_REFERENCE_TX_TIMEOUT_MS });
  }

  private async authorizeSavedRevisionSponsor(
    tx: Prisma.TransactionClient, ctx: TenantContext, sessionId: string,
    spec: OutreachCampaignSpecV1, clientId: string | null,
  ) {
    if (!clientId) {
      if (spec.sponsor.kind !== 'firm' || spec.sponsor.clientRefs.length) {
        throw unauthorizedReference('newsletter sponsor');
      }
      return;
    }
    if (spec.sponsor.kind !== 'client' || spec.sponsor.clientRefs.length !== 1 ||
        spec.sponsor.clientRefs[0]!.clientId.toLowerCase() !== clientId) {
      throw unauthorizedReference('newsletter sponsor');
    }
    const clients = await tx.$queryRaw<Array<{ memoryWall: boolean }>>`
      SELECT memory_wall AS "memoryWall" FROM clients
      WHERE tenant_id=${ctx.tenantId}::uuid AND id=${clientId}::uuid AND status::text<>'archived' FOR SHARE`;
    if (!clients[0]) throw unauthorizedReference('newsletter client');
    if (clients[0].memoryWall) {
      const grants = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM client_memory_access WHERE tenant_id=${ctx.tenantId}::uuid
        AND client_id=${clientId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
      if (!grants.length) throw unauthorizedReference('newsletter client');
    }
    await this.authorizeClientRefs(tx, ctx, sessionId, [clientId]);
  }

  async applyBatch(ctx: TenantContext, sessionId: string, input: unknown) {
    const batch = this.parseNormalizeAndValidateBatch(input);
    // ADD_TARGET_REFS reauthorizes every locator inside this transaction, and a
    // directory locator means an HTTP call to DirectoryService — so Prisma's 5s
    // default killed legitimate multi-target batches with P2028 (surfaced as a
    // misleading 503 "database is temporarily busy"). See
    // OUTREACH_REFERENCE_TX_TIMEOUT_MS for why this is interim.
    return this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      (tx) => this.applyBatchWithinTx(tx, ctx, sessionId, batch),
      { timeoutMs: OUTREACH_REFERENCE_TX_TIMEOUT_MS },
    );
  }

  parseNormalizeAndValidateBatch(input: unknown): ApplyOutreachCommandBatchInput {
    const parsed = parseOutreachCommandBatch(input);
    const normalized = normalizeOutreachCommandBatch(parsed);
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

    if (options.prelockedSession) {
      const locked = options.prelockedSession;
      if (
        locked.id !== sessionId ||
        locked.tenantId !== ctx.tenantId ||
        locked.createdByUserId !== ctx.userId
      ) {
        throw new OutreachCommandError(
          'OUTREACH_STATE_CORRUPT',
          'The prelocked session does not match the requested scope.',
          500,
        );
      }
    }

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

    const authorizedCommands: AuthorizedOutreachCommand[] = [];
    for (const command of batch.commands) {
      authorizedCommands.push(await this.authorizeCommandWithinTx(tx, ctx, session, command));
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
    try {
      assertOutreachContextSponsorIsolation(finalSpec);
    } catch {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'Client-specific context is not compatible with the campaign sponsor scope.',
        422,
      );
    }
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

    await this.repository.appendEvent(tx, ctx, session, {
      eventType: 'command_batch_result',
      source,
      stateVersionBefore: session.currentStateVersion,
      stateVersionAfter: nextVersion,
      commandBatchId: batch.batchId,
      payloadHash: batchHash,
      safeMetadata: { ...result, ...(options.savedRevisionStaging ? { savedRevisionStaging: options.savedRevisionStaging } : {}) },
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

    if (command.type === 'ADD_TARGET_REFS') {
      try {
        const refs = (command.payload as { refs: unknown[] }).refs;
        const resolvedTargetRefs = await this.targetReferences.resolveManyWithinTx(tx, ctx, refs);
        return { ...command, resolvedTargetRefs };
      } catch (error) {
        if (error instanceof CapabilityError) throw unauthorizedReference('target');
        throw error;
      }
    }

    if (command.type === 'ACCEPT_CONTEXT_REFS') {
      try {
        const selections = (command.payload as { selections: unknown[] }).selections;
        const resolvedContextRefs = await this.contextReferences.resolveManyWithinTx(
          tx,
          ctx,
          selections,
        );
        return { ...command, resolvedContextRefs };
      } catch (error) {
        if (error instanceof CapabilityError) throw unauthorizedReference('context');
        throw error;
      }
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
      try {
        await this.targetReferences.reauthorizeSnapshotsWithinTx(
          tx,
          ctx,
          restoreSpec.targeting.selectedTargetRefs,
        );
        await this.contextReferences.reauthorizeSnapshotsWithinTx(
          tx,
          ctx,
          allAcceptedContextRefs(restoreSpec),
        );
      } catch (error) {
        if (error instanceof CapabilityError) throw unauthorizedReference('restored');
        throw error;
      }
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
      assertOutreachContextSponsorIsolation(spec);
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

function unauthorizedReference(kind: string): OutreachCommandError {
  return new OutreachCommandError(
    'OUTREACH_REFERENCE_UNAUTHORIZED',
    `One or more ${kind} references are not available in the authorized scope.`,
    403,
  );
}
