import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type {
  LedgerEntry,
  MeriGovernedTurnContext,
  MeriEvidenceManifest,
} from '@capiro/meriv2-core';
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
}

type DoneFrame = Extract<MeriV3ChatStreamEvent, { type: 'done' }>;

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
  }> {
    const result = await this.complete(ctx, input, auth, 'read-only', onEvent);
    const ledgerEntries = result.ledgerEntries ?? [];
    const sources: SourceAttribution[] = result.steps.map((step) => ({
      tool: step.tool,
      label: step.label,
      summary:
        step.detail ??
        (step.status === 'done'
          ? 'Source retrieved; see cited evidence.'
          : `Source status: ${step.status}`),
      confidence: step.status === 'done' ? 'high' : 'low',
    }));
    return {
      reportBody: result.reply,
      model: result.model,
      sources,
      toolsUsed: [...new Set(result.steps.map((step) => step.tool))],
      ledgerEntries,
      citations: result.citations ?? [],
      ...(result.telemetry ? { telemetry: result.telemetry } : {}),
      ...(result.providerCalls ? { providerCalls: result.providerCalls } : {}),
      ...(result.evidenceManifest ? { evidenceManifest: result.evidenceManifest } : {}),
      ...(result.retrieval ? { retrieval: result.retrieval } : {}),
    };
  }

  private async complete(
    ctx: TenantContext,
    input: ResearchRunInput,
    auth: ResearchRuntimeAuth,
    toolPolicy: 'none' | 'read-only',
    onEvent: (event: Record<string, unknown>) => void,
  ): Promise<DoneFrame> {
    if (!auth.bearerToken || !auth.governedContext) {
      throw new BadRequestException('Research requires the authenticated conversation context.');
    }
    if (!this.client.configured)
      throw new ServiceUnavailableException('MeriV3 research runtime is not configured.');
    const aiProvider = await this.credentials.resolveProvider(ctx, 'openai');
    if (!aiProvider)
      throw new ServiceUnavailableException(
        'The conversation’s OpenAI provider is not configured.',
      );
    const currentTurnImages = await this.snapshotImages(ctx, input.handoff);
    const inherited = toolPolicy === 'read-only'
      ? await this.conversationEvidence.load(ctx, input.conversationId ?? input.handoff?.conversationId ?? undefined,
          input.clientId, auth.signal, input.handoff?.messages)
      : { citations: [], unavailable: 0, omitted: 0 };
    let frame: DoneFrame | undefined;
    let errorMessage: string | undefined;
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
          ? { inheritedEvidenceNotice: `${inherited.unavailable} earlier document observations could not be reauthorized; ${inherited.omitted} were outside the bounded replay. Retrieve missing evidence before using it.` }
          : {}),
        toolPolicy,
        ...(auth.run ? { researchRun: { sessionId: input.sessionId, runId: auth.run.id } } : {}),
        ...(currentTurnImages.length ? { currentTurnImages } : {}),
      },
      onEvent: (event) => {
        if (event.type === 'done') frame = event;
        else if (event.type === 'error') errorMessage = event.message;
        else if (event.type === 'tool_call')
          onEvent({ type: 'step', tool: event.tool, label: event.label });
        else if (event.type === 'tool_done')
          onEvent({
            type: 'source',
            source: {
              tool: event.tool,
              label: event.label,
              summary: event.detail ?? event.status,
              confidence: event.status === 'done' ? 'high' : 'low',
            },
          });
        else onEvent(event as unknown as Record<string, unknown>);
      },
    });
    // A truncated SSE stream is not a completed report. Do not persist streamed
    // partial text or a release-gate refusal as a successful research artifact.
    if (errorMessage) throw new ServiceUnavailableException(errorMessage);
    const result = frame as DoneFrame | undefined;
    if (auth.signal?.aborted || result?.aborted)
      throw new BadRequestException('Research was cancelled.');
    if (result?.telemetry?.partial)
      throw new ServiceUnavailableException(
        `Research did not complete (${result.telemetry.finishReason}). Retry before using it as a report.`,
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
    return result;
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
