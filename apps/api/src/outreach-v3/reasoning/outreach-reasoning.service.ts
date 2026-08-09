import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { AiCredentialResolverService } from '../../ai-credentials/ai-credential-resolver.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  targetKeyForLocator,
  type OutreachTargetLocatorV1,
} from '../../capabilities/targets/outreach-target.contract.js';
import {
  contextKeyForSelection,
  normalizeContextSelectionV1,
  type OutreachContextSelectionV1,
} from '../../capabilities/context/outreach-context.contract.js';
import { OUTREACH_COMMAND_REGISTRY } from '../commands/outreach-command-registry.js';
import { OutreachCommandProposalService } from '../services/outreach-command-proposal.service.js';
import { OutreachStateVersionGuardService } from '../services/outreach-state-version-guard.service.js';
import {
  allAcceptedContextRefs,
  type OutreachCampaignSpecV1,
} from '../state/outreach-campaign-spec.v1.js';
import type { ParsedOutreachCommandEnvelope } from '../state/outreach-command.contract.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import {
  OUTREACH_REASONING_LIMITS,
  OutreachReasoningError,
  parseReasoningTurnInput,
  type OutreachReasoningEffort,
  type OutreachReasoningStateMode,
  type ReasoningTranscriptTurn,
} from './outreach-reasoning.contract.js';
import { OutreachReasoningContextService } from './outreach-reasoning-context.service.js';
import {
  OutreachReasoningRepository,
  type OutreachReasoningConversationRow,
} from './outreach-reasoning.repository.js';
import { OutreachReasoningTurnClaimService } from './outreach-reasoning-turn-claim.service.js';
import { OpenAiOutreachReasoningProvider } from './openai-outreach-reasoning.provider.js';

const implementedCommandTypes = new Set(
  OUTREACH_COMMAND_REGISTRY.filter((entry) => entry.status === 'implemented').map(
    (entry) => entry.type,
  ),
);

@Injectable()
export class OutreachReasoningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: AiCredentialResolverService,
    private readonly repository: OutreachReasoningRepository,
    private readonly claims: OutreachReasoningTurnClaimService,
    private readonly campaignContext: OutreachReasoningContextService,
    private readonly provider: OpenAiOutreachReasoningProvider,
    private readonly proposals: OutreachCommandProposalService,
    private readonly stateVersions: OutreachStateVersionGuardService,
  ) {}

  async createConversation(ctx: TenantContext, sessionId: string) {
    const campaign = await this.campaignContext.loadCampaignContext(ctx, sessionId);
    const stateMode = configuredStateMode();
    const reasoningEffort = configuredReasoningEffort();

    if (stateMode === 'provider_state' && !providerStateExplicitlyEnabled()) {
      throw new OutreachReasoningError(
        'OUTREACH_REASONING_PROVIDER_STATE_DISABLED',
        'Provider-managed Outreach conversation state is not enabled for this environment.',
        503,
      );
    }

    let credential;
    try {
      credential = await this.credentials.resolveProviderForOutreachReasoning(ctx, 'openai');
    } catch {
      throw providerUnavailable();
    }
    if (!credential) throw providerUnavailable();

    const model = process.env.OUTREACH_V3_REASONING_MODEL?.trim() || credential.model;
    if (!model || model.length > 160) {
      throw new OutreachReasoningError(
        'OUTREACH_REASONING_PROVIDER_UNAVAILABLE',
        'A valid OpenAI reasoning model is not configured.',
        503,
      );
    }

    const conversation = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.repository.createConversation(tx, ctx, {
        sessionId,
        stateMode,
        model,
        reasoningEffort,
      }),
    );

    return {
      id: conversation.id,
      sessionId: conversation.sessionId,
      provider: conversation.provider,
      stateMode: conversation.stateMode,
      model: conversation.model,
      reasoningEffort: conversation.reasoningEffort,
      status: conversation.status,
      currentStateVersion: campaign.currentStateVersion,
      createdAt: conversation.createdAt,
    };
  }

  async getConversation(ctx: TenantContext, conversationId: string) {
    const conversation = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.repository.getOwnedConversation(tx, ctx, conversationId),
    );
    return publicConversation(conversation);
  }

  async respond(ctx: TenantContext, conversationId: string, rawInput: unknown) {
    const input = parseReasoningTurnInput(rawInput);
    const turnId = randomUUID();
    const started = Date.now();
    const userMessageHash = hashVisibleText(input.message);
    let conversation: OutreachReasoningConversationRow | null = null;
    let inspectedStateVersion = 1;

    await this.claims.claim(ctx, conversationId, turnId);

    try {
      const loaded = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const currentConversation = await this.repository.getOwnedConversation(
          tx,
          ctx,
          conversationId,
        );
        if (currentConversation.status !== 'active') {
          throw new OutreachReasoningError(
            'OUTREACH_REASONING_NOT_FOUND',
            'The requested Outreach reasoning conversation is not active.',
            404,
          );
        }
        const transcript =
          currentConversation.stateMode === 'capiro_managed'
            ? await this.repository.recentTranscript(
                tx,
                ctx,
                conversationId,
                Math.ceil(OUTREACH_REASONING_LIMITS.recentTranscriptTurns / 2),
              )
            : [];
        return { currentConversation, transcript };
      });
      conversation = loaded.currentConversation;

      const campaign = await this.campaignContext.loadCampaignContext(
        ctx,
        conversation.sessionId,
      );
      inspectedStateVersion = campaign.currentStateVersion;
      const capabilityCtx = this.campaignContext.capabilityContext(
        ctx,
        conversation.sessionId,
        campaign,
      );
      const transcript = boundTranscript(loaded.transcript);
      const instructions = this.campaignContext.buildInstructions(ctx, campaign);
      const toolEvidence = new Map<string, unknown>();

      const providerResult = await this.provider.respond({
        ctx,
        provider: 'openai',
        stateMode: conversation.stateMode,
        model: conversation.model,
        reasoningEffort: conversation.reasoningEffort,
        store: conversation.stateMode === 'provider_state',
        previousResponseId:
          conversation.stateMode === 'provider_state' ? conversation.lastResponseId : null,
        instructions,
        userMessage: input.message,
        recentTranscript: transcript,
        tools: this.campaignContext.providerTools(campaign),
        executeTool: async (name, toolInput) => {
          const result = await this.campaignContext.executeReadTool(
            capabilityCtx,
            campaign,
            name,
            toolInput,
          );
          toolEvidence.set(result.resultId, result.output);
          return result;
        },
      });

      for (const command of providerResult.proposedCommands) {
        if (!implementedCommandTypes.has(command.type)) {
          throw new OutreachReasoningError(
            'OUTREACH_REASONING_OUTPUT_INVALID',
            'The reasoning provider proposed a command that is not implemented in this phase.',
            502,
          );
        }
      }
      assertCommandsGrounded(
        providerResult.proposedCommands,
        providerResult.referencedToolResults.map((entry) => entry.resultId),
        toolEvidence,
        campaign.spec as OutreachCampaignSpecV1,
      );

      const assistantMessageHash = hashVisibleText(providerResult.assistantMessage);
      const latencyMs = Date.now() - started;
      const proposalIds: string[] = [];

      await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        await this.stateVersions.assertCurrentWithinTx(
          tx,
          ctx,
          conversation!.sessionId,
          inspectedStateVersion,
        );

        if (providerResult.proposedCommands.length > 0) {
          const proposal = await this.proposals.createModelProposalWithinTx(
            tx,
            ctx,
            conversation!.sessionId,
            {
              expectedStateVersion: inspectedStateVersion,
              commands: providerResult.proposedCommands,
            },
          );
          proposalIds.push(proposal.id);
        }

        const currentConversation = await this.repository.getOwnedConversation(
          tx,
          ctx,
          conversationId,
        );
        await this.repository.appendSucceededTurn(tx, ctx, currentConversation, {
          stateVersion: inspectedStateVersion,
          userMessageText:
            conversation!.stateMode === 'capiro_managed' ? input.message : null,
          assistantMessageText:
            conversation!.stateMode === 'capiro_managed'
              ? providerResult.assistantMessage
              : null,
          userMessageHash,
          assistantMessageHash,
          providerResponseId: providerResult.providerResponseRef,
          toolResultRefs: providerResult.referencedToolResults,
          proposalIds,
          openQuestions: providerResult.openQuestions,
          usage: providerResult.usage,
          latencyMs,
        });
        await this.repository.updateAfterTurn(
          tx,
          ctx,
          conversationId,
          conversation!.stateMode === 'provider_state'
            ? providerResult.providerResponseRef
            : null,
        );
      });

      return {
        conversationId,
        sessionId: conversation.sessionId,
        stateVersion: inspectedStateVersion,
        assistantMessage: providerResult.assistantMessage,
        proposalIds,
        proposedCommands: providerResult.proposedCommands,
        openQuestions: providerResult.openQuestions,
        referencedToolResults: providerResult.referencedToolResults,
        usage: providerResult.usage,
        providerResponseRef:
          conversation.stateMode === 'provider_state'
            ? providerResult.providerResponseRef
            : null,
      };
    } catch (error) {
      const normalized = normalizeReasoningFailure(error);
      if (conversation) {
        try {
          await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
            const currentConversation = await this.repository.getOwnedConversation(
              tx,
              ctx,
              conversationId,
            );
            await this.repository.appendFailedTurn(tx, ctx, currentConversation, {
              stateVersion: inspectedStateVersion,
              userMessageText:
                conversation!.stateMode === 'capiro_managed' ? input.message : null,
              userMessageHash,
              failureCode: normalized.code,
              latencyMs: Date.now() - started,
            });
          });
        } catch {
          // Never mask the safe user-facing failure with secondary audit trouble.
        }
      }
      throw normalized;
    } finally {
      await this.claims.release(ctx, conversationId, turnId).catch(() => undefined);
    }
  }

  async archiveConversation(ctx: TenantContext, conversationId: string) {
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.repository.archiveConversation(tx, ctx, conversationId),
    );
    return { id: conversationId, status: 'archived' as const };
  }
}

function assertCommandsGrounded(
  commands: ParsedOutreachCommandEnvelope[],
  referencedResultIds: string[],
  allToolEvidence: Map<string, unknown>,
  spec: OutreachCampaignSpecV1,
): void {
  const referencedEvidence = referencedResultIds
    .map((id) => allToolEvidence.get(id))
    .filter((value): value is unknown => value !== undefined);
  const availableTargetKeys = new Set<string>();
  const availableRecommendations = new Map<string, string>();
  const availableContextKeys = new Set<string>();

  for (const output of referencedEvidence) {
    collectTargetEvidence(output, availableTargetKeys, availableRecommendations);
    collectContextEvidence(output, availableContextKeys);
  }
  const currentContextKeys = new Set([
    ...allAcceptedContextRefs(spec).map((entry) => entry.contextKey),
    ...spec.context.excludedRefs.map((entry) => entry.contextKey),
  ]);

  for (const command of commands) {
    if (command.type === 'ADD_TARGET_REFS') {
      const refs = (command.payload as { refs: OutreachTargetLocatorV1[] }).refs;
      for (const ref of refs) {
        if (!availableTargetKeys.has(targetKeyForLocator(ref))) throw invalidTargetProposal();
      }
    }
    if (command.type === 'REJECT_TARGET_RECOMMENDATION') {
      const payload = command.payload as { recommendationRef: string; targetKey: string };
      if (availableRecommendations.get(payload.recommendationRef) !== payload.targetKey) {
        throw invalidTargetProposal();
      }
    }
    if (command.type === 'ACCEPT_CONTEXT_REFS') {
      const selections = (command.payload as { selections: OutreachContextSelectionV1[] })
        .selections;
      for (const selection of selections) {
        const key = contextKeyForSelection(normalizeContextSelectionV1(selection));
        if (!availableContextKeys.has(key)) throw invalidContextProposal();
      }
    }
    if (command.type === 'EXCLUDE_CONTEXT_REFS') {
      const refs = (command.payload as { refs: Array<{ contextKey: string }> }).refs;
      for (const ref of refs) {
        if (!currentContextKeys.has(ref.contextKey) && !availableContextKeys.has(ref.contextKey)) {
          throw invalidContextProposal();
        }
      }
    }
  }
}

function collectTargetEvidence(
  output: unknown,
  targetKeys: Set<string>,
  recommendationRefs: Map<string, string>,
): void {
  if (!output || typeof output !== 'object') return;
  const data = (output as Record<string, unknown>).data;
  if (!data || typeof data !== 'object') return;
  const value = data as Record<string, unknown>;
  const candidates = Array.isArray(value.candidates) ? value.candidates : [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.targetKey === 'string') targetKeys.add(record.targetKey);
    if (
      typeof record.recommendationRef === 'string' &&
      typeof record.targetKey === 'string'
    ) {
      recommendationRefs.set(record.recommendationRef, record.targetKey);
    }
  }
  const target = value.target;
  if (target && typeof target === 'object') {
    const record = target as Record<string, unknown>;
    if (typeof record.targetKey === 'string') targetKeys.add(record.targetKey);
  }
}

function collectContextEvidence(output: unknown, contextKeys: Set<string>): void {
  if (!output || typeof output !== 'object') return;
  const data = (output as Record<string, unknown>).data;
  if (!data || typeof data !== 'object') return;
  const value = data as Record<string, unknown>;
  const selections: unknown[] = [];
  if (value.selection) selections.push(value.selection);
  for (const candidate of Array.isArray(value.candidates) ? value.candidates : []) {
    if (candidate && typeof candidate === 'object' && 'selection' in candidate) {
      selections.push((candidate as Record<string, unknown>).selection);
    }
  }
  for (const selection of selections) {
    try {
      contextKeys.add(contextKeyForSelection(normalizeContextSelectionV1(selection)));
    } catch {
      // Ignore malformed evidence; the proposal cannot be grounded by it.
    }
  }
}

function invalidTargetProposal(): OutreachReasoningError {
  return new OutreachReasoningError(
    'OUTREACH_REASONING_OUTPUT_INVALID',
    'The reasoning provider proposed a target change that was not grounded in its referenced Capiro results.',
    502,
  );
}

function invalidContextProposal(): OutreachReasoningError {
  return new OutreachReasoningError(
    'OUTREACH_REASONING_OUTPUT_INVALID',
    'The reasoning provider proposed a context change that was not grounded in its referenced Capiro results or current Campaign Spec.',
    502,
  );
}

function configuredStateMode(): OutreachReasoningStateMode {
  const raw = process.env.OUTREACH_V3_REASONING_STATE_MODE?.trim();
  if (!raw || raw === 'capiro_managed') return 'capiro_managed';
  if (raw === 'provider_state') return 'provider_state';
  throw new OutreachReasoningError(
    'OUTREACH_REASONING_PROVIDER_STATE_DISABLED',
    'OUTREACH_V3_REASONING_STATE_MODE must be capiro_managed or provider_state.',
    503,
  );
}

function configuredReasoningEffort(): OutreachReasoningEffort {
  const raw = process.env.OUTREACH_V3_REASONING_EFFORT?.trim() || 'medium';
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  throw new OutreachReasoningError(
    'OUTREACH_REASONING_PROVIDER_UNAVAILABLE',
    'OUTREACH_V3_REASONING_EFFORT must be low, medium, or high.',
    503,
  );
}

function providerStateExplicitlyEnabled(): boolean {
  return process.env.OUTREACH_V3_REASONING_PROVIDER_STATE_ENABLED === 'true';
}

function providerUnavailable() {
  return new OutreachReasoningError(
    'OUTREACH_REASONING_PROVIDER_UNAVAILABLE',
    'OpenAI reasoning is not available for this Capiro environment.',
    503,
    true,
  );
}

function hashVisibleText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function boundTranscript(turns: ReasoningTranscriptTurn[]): ReasoningTranscriptTurn[] {
  const selected: ReasoningTranscriptTurn[] = [];
  let chars = 0;
  for (const turn of [...turns].reverse()) {
    if (selected.length >= OUTREACH_REASONING_LIMITS.recentTranscriptTurns) break;
    if (chars + turn.text.length > OUTREACH_REASONING_LIMITS.recentTranscriptChars) break;
    selected.push(turn);
    chars += turn.text.length;
  }
  return selected.reverse();
}

function normalizeReasoningFailure(error: unknown): OutreachReasoningError {
  if (error instanceof OutreachReasoningError) return error;
  if (error instanceof OutreachCommandError) {
    const conflict = error.code === 'OUTREACH_STATE_CONFLICT';
    return new OutreachReasoningError(
      'OUTREACH_REASONING_OUTPUT_INVALID',
      conflict
        ? 'The campaign changed while the reasoning turn was running. Retry against the current state.'
        : 'The proposed campaign change could not be persisted safely.',
      conflict ? 409 : 502,
      conflict,
      error.safeMetadata,
    );
  }
  return new OutreachReasoningError(
    'OUTREACH_REASONING_PROVIDER_UNAVAILABLE',
    'Outreach reasoning was unavailable.',
    503,
    true,
  );
}

function publicConversation(conversation: OutreachReasoningConversationRow) {
  return {
    id: conversation.id,
    sessionId: conversation.sessionId,
    provider: conversation.provider,
    stateMode: conversation.stateMode,
    model: conversation.model,
    reasoningEffort: conversation.reasoningEffort,
    status: conversation.status,
    createdAt: conversation.createdAt,
    lastUsedAt: conversation.lastUsedAt,
  };
}
