import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type {
  LedgerEntry,
  MeriGovernedTurnContext,
  MeriEvidenceManifest,
} from '@capiro/meriv2-core';
import { createMeriResearchPlanExecutionEnvelope } from '@capiro/meriv2-core';
import { classifyApiToolReadOutcome } from '@capiro/shared/meri-read-outcome';
import { AiCredentialResolverService } from '../ai-credentials/ai-credential-resolver.service.js';
import { MeriConversationEvidenceService } from './meri-conversation-evidence.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';
import {
  MeriV3ChatClient,
  type MeriV3ChatStreamEvent,
  type MeriV3ProviderTelemetry,
} from './meriv3-chat.client.js';
import type { MeriResearchHandoff } from './meri-research-handoff.js';
import type { ResearchRunState } from './meri-research-run-state.js';
import type { SourceAttribution } from './meri-research.service.js';
import {
  certifyResearchProducerInputs,
  publicResearchSourceTool,
} from './meri-report-provenance.js';
import {
  projectResearchObserverEvent,
  RESEARCH_PROVIDER_FAILURE,
} from './research-observer-projection.js';
import type { ResearchPlanV1 } from './meri-research-plan.js';

export interface ResearchRuntimeAuth {
  bearerToken?: string;
  impersonateTenantId?: string;
  governedContext?: MeriGovernedTurnContext;
  signal?: AbortSignal;
  /** Explicit user Resume targets the currently saved attempt. */
  resumeRunId?: string;
  /** Internal lease identity. Never accepted from a request body. */
  run?: ResearchRunState;
}

interface ResearchRunInput {
  sessionId: string;
  topic?: string;
  conversationId?: string | null;
  clientId: string | null;
  system: string;
  user: string;
  handoff: MeriResearchHandoff | null;
  clientContext?: string | null;
  /** API-admitted authority. Present only for execution, never model planning. */
  admittedPlanExecution?: {
    plan: ResearchPlanV1;
    allowedReadCapabilities: string[];
  };
}

type DoneFrame = Extract<MeriV3ChatStreamEvent, { type: 'done' }>;
type ResearchDoneFrame = DoneFrame & {
  producerInputEvaluated?: true;
  producerInputSha256?: string;
  producerInputMode?: 'source_free' | 'covered_inputs' | 'unsupported_private_inputs';
  clientContextSha256?: string | null;
};

/** Reuse chat's provider-led Responses loop, credentials, tools and governance. */
@Injectable()
export class MeriV3ResearchRunner {
  constructor(
    private readonly client: MeriV3ChatClient,
    private readonly flags: MeriFeatureFlagsService,
    private readonly credentials: AiCredentialResolverService,
    private readonly prisma: PrismaService,
    private readonly conversationEvidence: MeriConversationEvidenceService,
  ) {}

  enabled(ctx: TenantContext): Promise<boolean> {
    // An unavailable configured runtime is an error, never an implicit switch
    // to a different provider after the user selected V3 for their chat.
    return this.flags.isMeriV3ChatEnabled(ctx.tenantId, ctx.tenantSlug);
  }

  async plan(
    ctx: TenantContext,
    input: ResearchRunInput,
    auth: ResearchRuntimeAuth,
  ): Promise<string> {
    const result = await this.complete(ctx, input, auth, 'none', () => {});
    return result.reply;
  }

  async run(
    ctx: TenantContext,
    input: ResearchRunInput,
    auth: ResearchRuntimeAuth,
    onEvent: (event: Record<string, unknown>) => void,
  ): Promise<{
    reportBody: string;
    model: string;
    sources: SourceAttribution[];
    toolsUsed: string[];
    ledgerEntries: LedgerEntry[];
    citations: NonNullable<DoneFrame['citations']>;
    telemetry?: MeriV3ProviderTelemetry;
    providerCalls?: MeriV3ProviderTelemetry[];
    evidenceManifest?: MeriEvidenceManifest;
    retrieval?: DoneFrame['retrieval'];
    producerInputEvaluated: true;
    producerInputSha256: string;
    producerInputMode: 'source_free' | 'covered_inputs' | 'unsupported_private_inputs';
    clientContextSha256: string | null;
  }> {
    const result = await this.complete(ctx, input, auth, 'read-only', onEvent);
    const ledgerEntries = result.ledgerEntries ?? [];
    const sources: SourceAttribution[] = [];
    const toolsUsed: string[] = [];
    for (const entry of ledgerEntries) {
      const durable = entry.durableSafeRead;
      if (!durable) continue;
      const publicTool = publicResearchSourceTool(durable.tool);
      if (!publicTool) continue;
      const matchingSteps = result.steps.filter(
        (step) => step.durableSafeRead?.executionId === durable.executionId,
      );
      const matchedStep = matchingSteps.length === 1 ? matchingSteps[0] : undefined;
      if (
        !matchedStep ||
        matchedStep.status !== 'done' ||
        matchedStep.durableSafeRead?.receiptId !== durable.receiptId ||
        matchedStep.durableSafeRead?.tool !== durable.tool
      )
        continue;
      const ownerClassification = classifyApiToolReadOutcome(durable.tool, entry.result);
      if (
        !ownerClassification ||
        (ownerClassification.kind !== 'complete' && ownerClassification.kind !== 'empty') ||
        ownerClassification.kind !== durable.classifier
      )
        continue;
      const source: SourceAttribution = {
        tool: publicTool,
        label: 'Research source',
        summary: 'Authorized read completed',
        confidence: 'high',
      };
      sources.push(source);
      toolsUsed.push(publicTool);
      const projected = projectResearchObserverEvent(
        {
          type: 'source',
          source,
          durableSafeRead: {
            executionId: durable.executionId,
            providerCallId: durable.providerCallId,
            tool: publicTool,
            toolVersion: durable.toolVersion,
            classifier: durable.classifier,
            sequence: durable.sequence,
            receiptId: durable.receiptId,
            replayed: durable.replayed,
            outcome: 'complete',
            persisted: true,
            toolCallId: durable.providerCallId,
          },
        },
        { receiptCandidates: true },
      );
      if (projected) onEvent(projected);
    }
    return {
      reportBody: result.reply,
      model: result.model,
      sources,
      toolsUsed,
      ledgerEntries,
      citations: result.citations ?? [],
      ...(result.telemetry ? { telemetry: result.telemetry } : {}),
      ...(result.providerCalls ? { providerCalls: result.providerCalls } : {}),
      ...(result.evidenceManifest ? { evidenceManifest: result.evidenceManifest } : {}),
      ...(result.retrieval ? { retrieval: result.retrieval } : {}),
      producerInputEvaluated: true,
      producerInputSha256: result.producerInputSha256!,
      producerInputMode: result.producerInputMode!,
      clientContextSha256: result.clientContextSha256 ?? null,
    };
  }

  private async complete(
    ctx: TenantContext,
    input: ResearchRunInput,
    auth: ResearchRuntimeAuth,
    toolPolicy: 'none' | 'read-only',
    onEvent: (event: Record<string, unknown>) => void,
  ): Promise<ResearchDoneFrame> {
    if (!auth.bearerToken || !auth.governedContext) {
      throw new BadRequestException('Research requires the authenticated conversation context.');
    }
    const researchPlanExecution =
      toolPolicy === 'read-only'
        ? this.researchPlanExecutionEnvelope(ctx, input, auth)
        : undefined;
    if (!this.client.configured)
      throw new ServiceUnavailableException('MeriV3 research runtime is not configured.');
    const aiProvider = await this.credentials.resolveProvider(ctx, 'openai');
    if (!aiProvider)
      throw new ServiceUnavailableException(
        'The conversation’s OpenAI provider is not configured.',
      );
    const currentTurnImages = await this.snapshotImages(ctx, input.handoff);
    const inherited =
      toolPolicy === 'read-only'
        ? await this.conversationEvidence.load(
            ctx,
            input.conversationId ?? input.handoff?.conversationId ?? undefined,
            input.clientId,
            auth.signal,
            input.handoff?.messages,
          )
        : { citations: [], unavailable: 0, omitted: 0 };
    let frame: DoneFrame | undefined;
    let providerFailed = false;
    await this.client.streamChat({
      bearerToken: auth.bearerToken,
      aiProvider,
      impersonateTenantId: auth.impersonateTenantId,
      signal: auth.signal,
      input: {
        // The user prompt already contains the complete immutable snapshot;
        // avoid duplicating history or silently clipping its early constraints.
        messages: [{ role: 'user', text: input.user }],
        clientId: input.clientId ?? undefined,
        conversationId: input.conversationId ?? input.handoff?.conversationId ?? undefined,
        reasoningMode: input.handoff?.reasoningMode ?? 'deep',
        conversationSummary: input.handoff?.summary ?? undefined,
        skillAddendum: [
          input.system,
          ...(toolPolicy === 'read-only' && input.handoff?.attachments.length
            ? [
                `Before using attachment facts, call get_research_evidence with sessionId=${JSON.stringify(input.sessionId)}. ` +
                  'Read subsequent cursors or request the relevant attachmentIds when needed. Cite returned attachment record IDs as [S:get_research_evidence:ID]. ' +
                  'Treat unavailable or truncated attachment content explicitly; do not claim a tool read from the prompt snapshot alone.',
              ]
            : []),
        ].join('\n\n'),
        governedContext: auth.governedContext,
        inheritedDocumentEvidence: inherited.citations,
        ...(inherited.unavailable || inherited.omitted
          ? {
              inheritedEvidenceNotice: `${inherited.unavailable} earlier document observations could not be reauthorized; ${inherited.omitted} were outside the bounded replay. Retrieve missing evidence before using it.`,
            }
          : {}),
        toolPolicy,
        ...(toolPolicy === 'read-only' && auth.run
          ? {
              researchRun: {
                sessionId: input.sessionId,
                runId: auth.run.id,
                leaseEpoch: auth.run.leaseEpoch,
              },
              researchPlanExecution,
            }
          : {}),
        ...(currentTurnImages.length ? { currentTurnImages } : {}),
      },
      onEvent: (event) => {
        if (event.type === 'done') frame = event;
        else if (event.type === 'error') providerFailed = true;
        else {
          const projected = projectResearchObserverEvent(event);
          if (projected) onEvent(projected);
        }
      },
    });
    // A truncated SSE stream is not a completed report. Do not persist streamed
    // partial text or a release-gate refusal as a successful research artifact.
    if (providerFailed) throw new ServiceUnavailableException(RESEARCH_PROVIDER_FAILURE);
    const result = frame as DoneFrame | undefined;
    if (auth.signal?.aborted || result?.aborted)
      throw new BadRequestException('Research was cancelled.');
    if (result?.telemetry?.partial)
      throw new ServiceUnavailableException(
        'Research did not complete. Retry before using it as a report.',
      );
    if (!result?.reply?.trim())
      throw new ServiceUnavailableException('Research ended without a completed response.');
    if (result.held)
      throw new BadRequestException(
        'Research could not pass evidence verification. Please review the source gaps and retry.',
      );
    if (toolPolicy === 'read-only' && !Array.isArray(result.ledgerEntries)) {
      throw new ServiceUnavailableException(
        'The research runtime must be upgraded to return its evidence ledger.',
      );
    }
    const ledgerEntries = result.ledgerEntries ?? [];
    const durableTools = ledgerEntries.flatMap((entry) =>
      entry.durableSafeRead ? [entry.durableSafeRead.tool] : [],
    );
    const producerInput = certifyResearchProducerInputs({
      hashMaterial: {
        systemSha256: createHash('sha256').update(input.system).digest('hex'),
        userSha256: createHash('sha256').update(input.user).digest('hex'),
        governedContextSha256: createHash('sha256')
          .update(JSON.stringify(auth.governedContext))
          .digest('hex'),
        userPromptTurns:
          input.handoff?.messages.filter((message) => message.role === 'user').length ?? 0,
        assistantHistoryTurns:
          input.handoff?.messages.filter((message) => message.role === 'assistant').length ?? 0,
      },
      toolsUsed: durableTools,
      clientContext: input.clientContext,
      handoffSummaryPresent: Boolean(input.handoff?.summary),
      handoffAttachmentCount: input.handoff?.attachments.length ?? 0,
      assistantHandoffTurns:
        input.handoff?.messages.filter((message) => message.role === 'assistant').length ?? 0,
      inheritedCitationCount: inherited.citations.length,
      inheritedUnavailableCount: inherited.unavailable,
      inheritedOmittedCount: inherited.omitted,
      contextPacketItemCount: auth.governedContext.contextPacket?.items.length ?? 0,
      unreceiptedLedgerEntryCount: ledgerEntries.filter((entry) => !entry.durableSafeRead).length,
    });
    return {
      ...result,
      producerInputEvaluated: true,
      ...producerInput,
    };
  }

  private researchPlanExecutionEnvelope(
    ctx: TenantContext,
    input: ResearchRunInput,
    auth: ResearchRuntimeAuth,
  ) {
    if (!auth.run || !input.admittedPlanExecution) {
      throw new BadRequestException('Research requires an admitted plan execution envelope.');
    }
    return createMeriResearchPlanExecutionEnvelope({
      plan: input.admittedPlanExecution.plan,
      allowedReadCapabilities: input.admittedPlanExecution.allowedReadCapabilities,
      scope: {
        sessionId: input.sessionId,
        runId: auth.run.id,
        leaseEpoch: auth.run.leaseEpoch,
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        clientId: input.clientId,
        conversationId: input.conversationId ?? input.handoff?.conversationId ?? null,
      },
    });
  }

  private async snapshotImages(ctx: TenantContext, handoff: MeriResearchHandoff | null) {
    const images =
      handoff?.attachments.filter((row) => row.kind === 'image' && row.status === 'image_ready') ??
      [];
    if (!images.length) return [];
    const stored = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.clioAttachment.findMany({
        where: {
          id: { in: images.map((image) => image.id) },
          tenantId: ctx.tenantId,
          userId: ctx.userId,
        },
        select: { id: true, data: true, mediaType: true, status: true },
      }),
    );
    return images.map((image) => {
      const row = stored.find((candidate) => candidate.id === image.id);
      if (
        !row?.data ||
        row.status !== 'image_ready' ||
        !row.mediaType ||
        createHash('sha256').update(Buffer.from(row.data)).digest('hex') !== image.contentSha256 ||
        row.mediaType !== image.mediaType
      ) {
        throw new BadRequestException(
          'A research image is unavailable or changed since the handoff. Start a new research request.',
        );
      }
      return { mediaType: row.mediaType, dataBase64: Buffer.from(row.data).toString('base64') };
    });
  }
}
