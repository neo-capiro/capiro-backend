import { captureMeriTurnScope } from './meri-turn-scope.js';
import {
  authorizeMeriProspectScope,
  prospectScopeDirective,
  prospectTurnScopeReceipt,
} from './meri-prospect-scope.helpers.js';
import {
  BizDevMeriScopeService,
  type MeriProspectScope,
} from '../business-development/bizdev-meri-scope.service.js';
import {
  authorizeMeriResearchPortfolioScope,
  ResearchPortfolioMeriScopeService,
  researchPortfolioScopeDirective,
  researchPortfolioTurnScopeReceipt,
} from '../research-portfolios/research-portfolio-meri-scope.service.js';
import {
  assertAttachmentConversation,
  authorizedAttachmentSources,
  compactedAttachmentContext,
} from './meri-attachment-continuity.js';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { MeriConversationEvidenceService } from './meri-conversation-evidence.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ordinaryClioArtifactWhere } from '../common/internal-clio-artifact.js';
import { AiCredentialResolverService } from '../engagement/ai-credential-resolver.service.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { CLIO_SKILLS } from './skills/skill-registry.js';
import { matchFirmSkillForTurn } from './meri-firm-skills.helpers.js';
import { resolveServedProcedure, type ServedProcedureReceipt } from './meri-procedure-runtime.js';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentMetaRef,
  attachmentRefsFromMetadata,
  formatAttachmentContext,
  formatAttachmentFilingReference,
  validateVisionSet,
  type AttachmentMetaRef,
} from './meri-attachment.helpers.js';
import {
  complianceRefusalBody,
  screenComplianceBlock,
  screenComplianceRisk,
} from './meri-compliance.helpers.js';
import { detectDeliverableReportRequest } from './meri-research-promote.helpers.js';
import { planTurnRerun } from './meri-turn.helpers.js';
import { meriProviderConfigurationError } from './meri-stream-preflight.helpers.js';
import { classifyToolAction, isSideEffectingTool } from './meri-actions.helpers.js';
import {
  MeriV3ChatClient,
  type MeriV3ChatStreamEvent,
  type MeriV3ProviderTelemetry,
} from './meriv3-chat.client.js';
import { reasoningModeFromConversationMetadata } from './meriv3-conversation.helpers.js';
import { buildMeriGroundingStatement } from './meri-grounding-statement.js';
import { MERI_TURN_MAINTENANCE, type MeriTurnMaintenance } from './meri-turn-maintenance.js';
import {
  describeAttachmentContentState,
  retryAttachmentExtraction,
} from './meri-attachment-content-state.js';
import { resolveEvidenceAccuracyModeForTenant } from '../common/meri-evidence-accuracy-flags.js';
import { MeriResearchService } from './meri-research.service.js';

interface SseWriter {
  write(data: string): void;
}

type RerunMode = 'new' | 'regenerate' | 'resend';

interface StreamControl {
  cleanContent: string;
  traceEnabled: boolean;
  pageWriteEnabled: boolean;
}

@Injectable()
export class MeriV3ProxyService {
  private readonly logger = new Logger(MeriV3ProxyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: MeriFeatureFlagsService,
    private readonly client: MeriV3ChatClient,
    private readonly aiCredentials: AiCredentialResolverService,
    private readonly clientKb: ClientKbService,
    private readonly firmSkills: MeriFirmSkillsService,
    @Inject(MERI_TURN_MAINTENANCE) private readonly maintenance: MeriTurnMaintenance,
    private readonly conversationEvidence: MeriConversationEvidenceService,
    private readonly research: MeriResearchService,
    // Phase 4 prospect dispatch: optional so existing direct-construction
    // specs keep compiling; Nest wiring provides it via BusinessDevelopmentModule.
    // A prospect-scoped conversation with it unavailable fails closed below.
    @Optional()
    @Inject(BizDevMeriScopeService)
    private readonly bizdevScope?: BizDevMeriScopeService,
    @Optional()
    @Inject(ResearchPortfolioMeriScopeService)
    private readonly researchPortfolioScope?: ResearchPortfolioMeriScopeService,
  ) {}

  async shouldHandle(ctx: TenantContext): Promise<boolean> {
    return this.flags.isMeriV3ChatEnabled(ctx.tenantId, ctx.tenantSlug);
  }

  async streamMessage(
    ctx: TenantContext,
    conversationId: string,
    body: string,
    sse: SseWriter,
    clientSignal?: AbortSignal,
    mode: RerunMode = 'new',
    attachmentIds: string[] = [],
    bearerToken?: string,
    impersonateTenantId?: string,
  ): Promise<void> {
    const emit = (event: Record<string, unknown>) =>
      sse.write(`data: ${JSON.stringify(event)}\n\n`);
    if (!this.client.configured) {
      emit({
        type: 'error',
        accepted: false,
        message: 'MeriV3 is enabled but its isolated runtime URL is missing.',
      });
      emit({ type: 'done' });
      return;
    }
    if (!bearerToken) {
      emit({
        type: 'error',
        accepted: false,
        message: 'MeriV3 could not authenticate this turn. No model or tool call was made.',
      });
      emit({ type: 'done' });
      return;
    }

    const conversation = await this.ensureConversation(ctx, conversationId);
    // Phase 4 prospect-scope authorization re-check: BEFORE any user-message
    // write or runtime dispatch for a prospect-scoped conversation, parse the
    // server-persisted scope and re-assert it is current. Missing/malformed/
    // stale scope, or an unavailable scope service, fails closed with the typed
    // conflict / safe 404 — the same shape conversation-creation uses.
    // Ordinary unscoped conversations return null here and proceed unchanged.
    const prospectScope = await authorizeMeriProspectScope(
      this.bizdevScope,
      ctx,
      conversation.metadata,
    );
    const researchScope = await authorizeMeriResearchPortfolioScope(
      this.researchPortfolioScope,
      ctx,
      conversation.metadata,
    );
    const control = extractStreamControl(body);
    const complianceScreen = screenComplianceRisk(control.cleanContent);
    let content: string;
    let sourceMessageId: string | null = null;

    if (mode === 'new') {
      content = control.cleanContent.trim();
      if (!content && !attachmentIds.length) throw new BadRequestException('Message body is empty');
      if (!content) content = '(See the attached file(s).)';
      if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new BadRequestException(
          `At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`,
        );
      }
      sourceMessageId = await this.persistUserMessage(ctx, conversation, content, attachmentIds);
    } else {
      const prior = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioMessage.findMany({
          where: { conversationId, role: { in: ['user', 'assistant'] } },
          orderBy: { createdAt: 'asc' },
          select: { id: true, role: true, body: true },
        }),
      );
      const plan = planTurnRerun(
        prior,
        mode,
        mode === 'resend' ? control.cleanContent.trim() : undefined,
      );
      if (!plan || !plan.contentToUse.trim()) {
        throw new BadRequestException('No previous user message to re-run');
      }
      content = plan.contentToUse;
      sourceMessageId =
        plan.updateUserMessageId ??
        [...prior].reverse().find((message) => message.role === 'user')?.id ??
        null;
      await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        if (plan.updateUserMessageId) {
          await tx.clioMessage.update({
            where: { id: plan.updateUserMessageId },
            data: { body: content },
          });
        }
        if (plan.deleteMessageIds.length) {
          await tx.clioMessage.deleteMany({
            where: { id: { in: plan.deleteMessageIds }, conversationId },
          });
        }
      });
    }

    // Acceptance describes durable user-message persistence, not provider readiness.
    // A stopped preparation must not restore this already-saved prompt as a draft.
    emit({ type: 'turn_accepted', ...(sourceMessageId ? { messageId: sourceMessageId } : {}) });

    if (
      process.env.MERI_COMPLIANCE_BLOCK !== 'false' &&
      (await this.flags.isEnabled(ctx.tenantId, 'complianceBlock', true))
    ) {
      const block = screenComplianceBlock(content);
      if (block.flagged) {
        const refusal = complianceRefusalBody(block.category);
        emit({ type: 'start', intent: 'compliance_refusal', tier: 'fast', runtime: 'meriv3' });
        emit({ type: 'text', text: refusal });
        const refusalMessage = await this.persistAssistantMessage(
          ctx,
          conversation,
          conversationId,
          refusal,
          {
            servedBy: 'compliance-block',
            runtime: 'meriv3',
            finishReason: 'stop',
            compliance: { flagged: true, category: block.category, blocked: true },
          },
        );
        emit({ type: 'done', messageId: refusalMessage.id });
        return;
      }
    }

    const reasoningMode = reasoningModeFromConversationMetadata(conversation.metadata);
    const reportRequest =
      mode === 'new' &&
      reasoningMode !== 'deep' &&
      reasoningMode !== 'max' &&
      process.env.MERI_RESEARCH_PROMOTE !== 'false'
        ? detectDeliverableReportRequest(content)
        : null;
    if (reportRequest && (await this.flags.isEnabled(ctx.tenantId, 'deepResearchPromote', true))) {
      const offer =
        'This looks like a request for a full sourced deliverable. Run it through **Deep Research** so every figure, bill number, Program Element, and name is retrieved and verified before release. Use **Run as Deep Research** below, or rephrase for a quick chat answer.';
      emit({ type: 'start', intent: 'deep_research_offer', tier: 'deep', runtime: 'meriv3' });
      emit({ type: 'text', text: offer });
      emit({ type: 'research_offer', topic: reportRequest.topic, reason: reportRequest.reason });
      const offerMessage = await this.persistAssistantMessage(
        ctx,
        conversation,
        conversationId,
        offer,
        {
          servedBy: 'research-promote',
          runtime: 'meriv3',
          finishReason: 'stop',
          researchOffer: { topic: reportRequest.topic },
        },
      );
      emit({ type: 'done', messageId: offerMessage.id });
      return;
    }

    const replay = await this.buildReplay(
      ctx,
      conversationId,
      conversation.summaryUpToMessageId ?? null,
      conversation.clientId,
      conversation.summary ?? null,
    );
    const inherited = await this.conversationEvidence.load(
      ctx,
      conversationId,
      conversation.clientId,
      clientSignal,
    );
    let aiProvider: Awaited<ReturnType<AiCredentialResolverService['resolveProvider']>>;
    try {
      aiProvider = await this.aiCredentials.resolveProvider(ctx, 'openai');
    } catch (err) {
      throw meriProviderConfigurationError(err);
    }
    let clientKbSnapshot: string | undefined;
    if (conversation.clientId) {
      clientKbSnapshot =
        (await this.clientKb
          .buildSnapshot(ctx.tenantId, conversation.clientId, ctx.userId)
          .catch(() => null)) ?? undefined;
    }
    let skillAddendum: string | undefined;
    const tenantSkills = await this.firmSkills.skillsForTenant(ctx.tenantId).catch(() => []);
    const matched = matchFirmSkillForTurn('', content, tenantSkills, CLIO_SKILLS);
    // A selected procedure is authority, not optional steering. Exact
    // resolution errors propagate; they never become unrestricted chat.
    const procedure = await resolveServedProcedure({
      tenantId: ctx.tenantId,
      clientId: conversation.clientId,
      selected: matched,
      firmSkills: this.firmSkills,
    });
    // Procedure instructions travel only in the signed governed context.
    if (!procedure && matched?.systemAddendum) skillAddendum = matched.systemAddendum;

    emit({
      type: 'start',
      intent: 'general',
      tier: reasoningMode === 'fast' ? 'fast' : 'deep',
      runtime: 'meriv3',
      reasoningMode,
      ...(procedure ? { procedure: procedure.receipt } : {}),
    });
    if (control.pageWriteEnabled) {
      emit({
        type: 'page_write',
        target: 'outreach_draft',
        note: 'Write mode enabled: verified output will be applied to this page when supported.',
      });
    }

    let accumulated = '';
    let errorMessage: string | null = null;
    let runtimeModel = 'meriv3';
    // Effort is only known once the runtime/done frame reports it. Seeding this
    // with the reasoning *mode* recorded a mode label ('deep') in the
    // reasoningEffort metadata whenever a turn failed before the first frame.
    let runtimeEffort: string | null = null;
    let runtimeTelemetry: MeriV3ProviderTelemetry | null = null;
    let providerCalls: MeriV3ProviderTelemetry[] = [];
    let doneFrame: Extract<MeriV3ChatStreamEvent, { type: 'done' }> | null = null;
    let groundingCaveat: {
      topSeverity: string | null;
      findings: Array<{ check: string; severity: string; detail: string }>;
    } | null = null;
    const steps: Array<{
      tool: string;
      label: string;
      detail?: string;
      status: 'done' | 'error' | 'pending_approval' | 'blocked';
    }> = [];
    const pendingApprovals: Array<Record<string, unknown>> = [];
    const artifactIds: string[] = [];

    const translate = (event: MeriV3ChatStreamEvent): void => {
      switch (event.type) {
        case 'start':
          return;
        case 'runtime':
          runtimeModel = event.model;
          runtimeEffort = event.reasoningEffort;
          runtimeTelemetry = event.telemetry ?? runtimeTelemetry;
          providerCalls = event.providerCalls ?? providerCalls;
          emit(event as unknown as Record<string, unknown>);
          return;
        case 'tool_call':
          emit({ type: 'tool_call', tool: event.tool, label: event.label });
          return;
        case 'tool_done': {
          steps.push(event);
          const summary =
            event.status === 'done'
              ? (event.detail ?? 'Completed')
              : event.status === 'pending_approval'
                ? 'Held for your approval'
                : (event.detail ?? (event.status === 'blocked' ? 'Blocked' : 'Errored'));
          emit({
            type: 'sources',
            sources: [
              {
                tool: event.tool,
                label: event.label,
                count: null,
                summary,
                confidence: event.status === 'done' ? 'high' : 'low',
              },
            ],
          });
          return;
        }
        case 'pending_approval':
          pendingApprovals.push(event as unknown as Record<string, unknown>);
          emit(event as unknown as Record<string, unknown>);
          return;
        case 'artifact':
          artifactIds.push(event.artifact.id);
          emit(event as unknown as Record<string, unknown>);
          return;
        case 'text':
          accumulated += event.text;
          emit({ type: 'text', text: event.text });
          return;
        case 'page_write':
          emit(event as unknown as Record<string, unknown>);
          return;
        case 'grounding_caveat':
          groundingCaveat = {
            topSeverity: event.topSeverity,
            findings: event.findings,
          };
          emit(event as unknown as Record<string, unknown>);
          return;
        case 'done':
          doneFrame = event;
          runtimeModel = event.model;
          runtimeEffort = event.reasoningEffort;
          runtimeTelemetry = event.telemetry ?? runtimeTelemetry;
          providerCalls = event.providerCalls ?? providerCalls;
          return;
        case 'error':
          errorMessage = event.message;
          return;
      }
    };

    // SSE keep-alive toward the BROWSER: while the orchestrator runs a long
    // no-tools synthesis it can emit no frames for many minutes. The browser
    // and every proxy hop between it and apps/api then see an idle connection
    // and may time it out (2026-09-01: turn errored "terminated" at 600s while
    // the orchestrator completed the synthesis 5 minutes later and the output
    // was discarded). A comment frame every 20s — alongside the orchestrator's
    // own keep-alive on the API↔orchestrator hop shipped in the same change —
    // keeps every hop's idle timer fed for the full max-mode turn budget.
    // SSE comments are ignored by standard parsers; the browser reader treats
    // only "data: " lines as frames, so this is invisible to it by construction.
    const keepAlive = setInterval(() => {
      try {
        sse.write(': ping\n\n');
      } catch {
        /* client already gone; the abort signal handles teardown */
      }
    }, 20_000);
    const stopKeepAlive = () => clearInterval(keepAlive);
    const inheritedEvidenceNotices = [
      inherited.unavailable || inherited.omitted
        ? `${inherited.unavailable} earlier document observations could not be reauthorized; ${inherited.omitted} were outside the bounded replay. Retrieve missing evidence through current tools before using it.`
        : null,
      replay.withheldReports.length
        ? 'Earlier research report context was withheld because current source authorization could not be confirmed. Reopen the research session to refresh or rerun it; do not infer the withheld contents.'
        : null,
    ].filter((notice): notice is string => Boolean(notice));
    try {
      await this.client.streamChat({
        bearerToken,
        input: {
          messages: replay.history,
          inheritedDocumentEvidence: inherited.citations,
          ...(inheritedEvidenceNotices.length
            ? { inheritedEvidenceNotice: inheritedEvidenceNotices.join(' ') }
            : {}),
          ...(conversation.clientId ? { clientId: conversation.clientId } : {}),
          conversationId,
          // Phase 4: the server-authored prospect directive rides the request
          // (bounded fields only — never provider payloads/notes/dossiers).
          ...(prospectScope ? { prospectDirective: prospectScopeDirective(prospectScope) } : {}),
          ...(researchScope
            ? { researchDirective: researchPortfolioScopeDirective(researchScope) }
            : {}),
          ...(replay.conversationSummary && replay.hasSummaryBoundary
            ? { conversationSummary: replay.conversationSummary }
            : {}),
          ...(clientKbSnapshot ? { clientKbSnapshot } : {}),
          ...(skillAddendum ? { skillAddendum } : {}),
          ...(procedure ? { procedure: procedure.binding } : {}),
          ...(control.pageWriteEnabled ? { pageWrite: true } : {}),
          ...(replay.currentTurnImages.length
            ? { currentTurnImages: replay.currentTurnImages }
            : {}),
          reasoningMode,
        },
        ...(aiProvider ? { aiProvider } : {}),
        ...(impersonateTenantId ? { impersonateTenantId } : {}),
        ...(clientSignal ? { signal: clientSignal } : {}),
        onEvent: translate,
      });
    } catch (error) {
      if (!clientSignal?.aborted) {
        errorMessage =
          errorMessage ??
          (error instanceof Error
            ? error.message
            : 'The MeriV3 runtime could not complete this turn.');
        this.logger.error(`MeriV3 proxy failed: ${errorMessage}`);
      }
    } finally {
      stopKeepAlive();
    }

    const aborted = Boolean(clientSignal?.aborted);
    const frame = doneFrame as Extract<MeriV3ChatStreamEvent, { type: 'done' }> | null;
    // A disconnected/truncated stream is not a successful stop, even if it
    // supplied text or completed a provider round before disconnecting.
    const finishReason = aborted
      ? clientSignal?.reason?.name === 'TimeoutError'
        ? 'deadline_exceeded'
        : 'aborted'
      : errorMessage
        ? 'error'
        : (frame?.telemetry?.finishReason ??
          (frame?.aborted ? 'aborted' : frame ? 'stop' : 'stream_interrupted'));
    const partial =
      aborted ||
      Boolean(frame?.aborted) ||
      Boolean(errorMessage) ||
      !frame ||
      Boolean(frame.telemetry?.partial);
    const reportedTelemetry = runtimeTelemetry as MeriV3ProviderTelemetry | null;
    const telemetry = reportedTelemetry ? { ...reportedTelemetry, finishReason, partial } : null;
    const assistantContent = (accumulated.trim() || frame?.reply || '').trim();
    if (!accumulated.trim() && assistantContent && !aborted && !errorMessage) {
      emit({ type: 'text', text: assistantContent });
    }
    if (frame?.usage && !aborted) emit({ type: 'usage', usage: frame.usage });
    if ((frame?.citations?.length || frame?.evidenceAccuracy === 'enforce') && !aborted) {
      emit({
        type: 'citations',
        citations: frame?.citations ?? [],
        ...(frame?.evidenceAccuracy === 'enforce' ? { evidenceAccuracy: 'enforce' } : {}),
      });
    }
    const groundingStatement = buildMeriGroundingStatement({
      citations: frame?.citations ?? [],
      verification: null,
      groundingCaveat,
    });
    if (!aborted) emit({ type: 'grounding_statement', statement: groundingStatement });
    if (control.traceEnabled && steps.length && !aborted) {
      emit({ type: 'exec_trace', trace: steps });
    }

    // Persist the same public tool receipt shown live. No provider reasoning
    // content is copied into this user-visible contract.
    const trustSteps = steps.map((step) => ({
      tool: step.tool,
      label: step.label,
      status: step.status === 'done' ? 'done' : 'error',
      detail:
        step.status === 'pending_approval'
          ? 'Held for your approval'
          : (step.detail ??
            (step.status === 'done'
              ? 'Completed'
              : step.status === 'blocked'
                ? 'Blocked'
                : 'Errored')),
      confidence: step.status === 'done' ? 'high' : 'low',
    }));

    // A turn stopped before its first text token still needs a durable receipt.
    // Otherwise reload either loses the partial turn or substitutes a provider
    // failure for an intentional Stop. Keep actual provider failures distinct.
    const stoppedWithoutText =
      !assistantContent && (finishReason === 'aborted' || finishReason === 'deadline_exceeded');
    const emptyAnswerBody =
      finishReason === 'aborted'
        ? 'Stopped before an answer was generated.'
        : finishReason === 'deadline_exceeded'
          ? 'The turn reached its time limit before an answer was generated.'
          : 'MeriV3 could not complete this turn. Please try again.';
    // Phase 4: a prospect-scoped turn's receipt comes ONLY from the server
    // conversation snapshot re-asserted before dispatch — never from the
    // retrieval plan or model output.
    const turnScope = prospectScope
      ? prospectTurnScopeReceipt(prospectScope)
      : researchScope
        ? researchPortfolioTurnScopeReceipt(researchScope)
        : captureMeriTurnScope(conversation, frame?.retrieval, frame?.contextPacket);
    let assistantMessageId: string | null = null;
    if (assistantContent || steps.length || errorMessage || stoppedWithoutText) {
      const message = await this.persistAssistantMessage(
        ctx,
        conversation,
        conversationId,
        assistantContent || emptyAnswerBody,
        {
          intent: frame?.intent ?? 'general',
          tier: reasoningMode === 'fast' ? 'fast' : 'deep',
          trustSteps,
          model: runtimeModel,
          runtime: 'meriv3',
          servedBy: 'meriv3',
          reasoningMode,
          reasoningEffort: runtimeEffort,
          ...(telemetry ? { telemetry } : {}),
          ...(providerCalls.length ? { providerCalls } : {}),
          ...(frame?.evidenceManifest ? { evidenceManifest: frame.evidenceManifest } : {}),
          toolsUsed: steps.map((step) => step.tool),
          usage: frame?.usage ?? {},
          citations: (frame?.citations ?? []) as unknown as Prisma.InputJsonValue,
          ...(frame?.evidenceAccuracy === 'enforce' ? { evidenceAccuracy: 'enforce' } : {}),
          groundingStatement,
          turnScope: turnScope as unknown as Prisma.InputJsonValue,
          ...(groundingCaveat
            ? { groundingCaveat: groundingCaveat as unknown as Prisma.InputJsonValue }
            : {}),
          ...(frame?.contextPacket
            ? {
                contextPacket: frame.contextPacket as unknown as Prisma.InputJsonValue,
                ...(frame.contextPacket.packetId
                  ? { contextPacketId: frame.contextPacket.packetId }
                  : {}),
              }
            : {}),
          ...(frame?.retrieval
            ? { retrieval: frame.retrieval as unknown as Prisma.InputJsonValue }
            : {}),
          ...(procedure ? { procedure: procedure.receipt as unknown as Prisma.InputJsonValue } : {}),
          finishReason,
          partial,
          trace: steps as unknown as Prisma.InputJsonValue,
          actions: steps
            .filter((step) => step.status === 'done' && isSideEffectingTool(step.tool))
            .map((step) => ({ tool: step.tool, kind: classifyToolAction(step.tool), ok: true })),
          ...(pendingApprovals.length
            ? { pendingApprovals: pendingApprovals as unknown as Prisma.InputJsonValue }
            : {}),
          ...(complianceScreen.flagged
            ? { compliance: { flagged: true, category: complianceScreen.category } }
            : {}),
        },
      );
      assistantMessageId = message.id;
      if (artifactIds.length) {
        await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.clioArtifact.updateMany({
            where: {
              id: { in: artifactIds },
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              conversationId,
              messageId: null,
              ...ordinaryClioArtifactWhere(),
            },
            data: { messageId: message.id },
          }),
        );
      }
    }

    if (errorMessage && !aborted) {
      emit({ type: 'error', message: errorMessage });
    }
    emit({
      type: 'done',
      model: runtimeModel,
      reasoningMode,
      reasoningEffort: runtimeEffort,
      finishReason,
      partial,
      ...(telemetry ? { telemetry } : {}),
      ...(frame?.evidenceManifest ? { evidenceManifest: frame.evidenceManifest } : {}),
      ...(assistantMessageId ? { messageId: assistantMessageId } : {}),
      ...(frame?.contextPacket?.packetId ? { contextPacketId: frame.contextPacket.packetId } : {}),
      ...(frame?.retrieval ? { retrieval: frame.retrieval } : {}),
      ...(procedure ? { procedure: procedure.receipt } : {}),
      turnScope,
    });
    this.logger.log(
      `MeriV3 proxy turn tenant=${ctx.tenantId} conversation=${conversationId} mode=${reasoningMode} ` +
        `model=${runtimeModel} tools=${steps.length} coverage=${frame?.retrieval?.coverage.complete ?? 'n/a'} ` +
        `aborted=${aborted} sourceMessage=${sourceMessageId} procedure=${procedureLogIdentity(
          procedure?.receipt,
        )}`,
    );
  }

  private async ensureConversation(ctx: TenantContext, conversationId: string) {
    const conversation = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.findFirst({
        where: {
          id: conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          archivedAt: null,
        },
        include: { client: { select: { id: true, name: true } } },
      }),
    );
    if (!conversation) throw new NotFoundException('Meri conversation not found');
    return conversation;
  }

  private async persistUserMessage(
    ctx: TenantContext,
    conversation: { id: string; clientId: string | null },
    content: string,
    attachmentIds: string[],
  ): Promise<string> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      let rows: Array<{
        id: string;
        filename: string;
        kind: string;
        status: string;
        byteSize: number;
        messageId?: string | null;
      }> = [];
      if (attachmentIds.length) {
        rows = await tx.clioAttachment.findMany({
          where: { id: { in: attachmentIds }, tenantId: ctx.tenantId, userId: ctx.userId },
          select: {
            id: true,
            filename: true,
            kind: true,
            status: true,
            byteSize: true,
            messageId: true,
          },
        });
        if (rows.length !== new Set(attachmentIds).size) {
          throw new BadRequestException('One or more attachments were not found');
        }
        await assertAttachmentConversation(tx, ctx, conversation.id, rows);
        const vision = validateVisionSet(
          rows
            .filter((row) => row.kind === 'image')
            .map((row) => ({ byteSize: row.byteSize, filename: row.filename })),
        );
        if (!vision.ok) throw new BadRequestException(vision.reason ?? 'Invalid image set');
      }
      const message = await tx.clioMessage.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: conversation.clientId,
          conversationId: conversation.id,
          role: 'user',
          body: content,
          metadata: rows.length
            ? ({ attachments: rows.map(attachmentMetaRef) } as unknown as Prisma.InputJsonValue)
            : {},
        },
        select: { id: true },
      });
      if (rows.length) {
        const claimed = await tx.clioAttachment.updateMany({
          where: {
            id: { in: attachmentIds },
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            messageId: null,
          },
          data: { messageId: message.id },
        });
        if (claimed.count !== rows.filter((row) => row.messageId == null).length) {
          throw new BadRequestException(
            'An attachment was used in another chat. Upload the file again.',
          );
        }
      }
      return message.id;
    });
  }

  private async buildReplay(
    ctx: TenantContext,
    conversationId: string,
    summaryUpToMessageId: string | null,
    clientId: string | null = null,
    conversationSummary: string | null = null,
  ) {
    const boundary = summaryUpToMessageId
      ? await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.clioMessage.findFirst({
            where: { id: summaryUpToMessageId, conversationId },
            select: { createdAt: true },
          }),
        )
      : null;
    const messages = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMessage.findMany({
        where: {
          conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          role: { in: ['user', 'assistant'] },
          ...(boundary
            ? {
                OR: [
                  { createdAt: { gt: boundary.createdAt } },
                  { createdAt: boundary.createdAt, id: { gt: summaryUpToMessageId! } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        // Maintenance starts before 40 messages; leave headroom while its
        // provider call is in flight. The boundary remains the only compaction.
        take: 80,
        select: { id: true, role: true, body: true, metadata: true },
      }),
    );
    messages.reverse();
    const reportContext = await this.research.authorizeModelContext(
      ctx,
      { conversationId, clientId },
      messages,
      conversationSummary,
    );
    const authorizedMessages = reportContext.messages;
    const refsByMessage = new Map<string, AttachmentMetaRef[]>();
    for (const message of authorizedMessages) {
      if (message.role !== 'user') continue;
      const refs = attachmentRefsFromMetadata(message.metadata);
      if (refs.length) refsByMessage.set(message.id, refs);
    }
    const lastUser = [...authorizedMessages].reverse().find((message) => message.role === 'user') ?? null;
    const allIds = [...refsByMessage.values()].flat().map((ref) => ref.id);
    const documentText = new Map<
      string,
      { id: string; filename: string; text: string; status: string; reason: string | null }
    >();
    const filingSources = new Map<
      string,
      { id: string; filename: string; kind: string; status: string; reason: string | null }
    >();
    const visibleImageIds = new Set<string>();
    const sourceMessageIds = authorizedMessages
      .filter((message) => message.role === 'user')
      .map((message) => message.id);
    const currentTurnImages: Array<{ mediaType: string; dataBase64: string }> = [];
    if (allIds.length) {
      const enforceContentState =
        resolveEvidenceAccuracyModeForTenant(ctx.tenantId, 'chat') === 'enforce';
      const documents = await authorizedAttachmentSources(
        this.prisma,
        ctx,
        conversationId,
        allIds,
        sourceMessageIds,
        enforceContentState,
      );
      for (const document of documents) {
        const initial = describeAttachmentContentState(document);
        if (enforceContentState && !initial.readable && document.data) {
          await retryAttachmentExtraction(this.prisma, document.id, ctx.tenantId, ctx.userId, () =>
            this.aiCredentials.resolveProvider(ctx, 'openai'),
          );
          const refreshed = await this.prisma.withTenant(ctx.tenantId, (tx) =>
            tx.clioAttachment.findFirst({
              where: { id: document.id, tenantId: ctx.tenantId, userId: ctx.userId },
              select: {
                id: true,
                filename: true,
                kind: true,
                textContent: true,
                status: true,
                reason: true,
                messageId: true,
                pages: true,
                data: true,
                createdAt: true,
              },
            }),
          );
          if (refreshed) Object.assign(document, refreshed);
        }
        filingSources.set(document.id, document);
        if (document.kind === 'image' || document.textContent == null) continue;
        documentText.set(document.id, {
          id: document.id,
          status: document.status,
          reason: document.reason,
          filename: document.filename,
          text: document.textContent ?? '',
        });
      }
      const imageIds = (lastUser ? (refsByMessage.get(lastUser.id) ?? []) : [])
        .filter((ref) => ref.kind === 'image' && filingSources.has(ref.id))
        .map((ref) => ref.id);
      if (imageIds.length) {
        const images = await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.clioAttachment.findMany({
            where: {
              id: { in: imageIds },
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              kind: 'image',
              messageId: {
                in: documents.flatMap((source) => (source.messageId ? [source.messageId] : [])),
              },
            },
            select: { id: true, mediaType: true, data: true },
          }),
        );
        for (const image of images) {
          if (image.mediaType && image.data) {
            visibleImageIds.add(image.id);
            currentTurnImages.push({
              mediaType: image.mediaType,
              dataBase64: Buffer.from(image.data).toString('base64'),
            });
          }
        }
      }
    }
    const history = authorizedMessages.map((message) => {
      const parts = [message.body];
      for (const ref of refsByMessage.get(message.id) ?? []) {
        const document = documentText.get(ref.id);
        const contentState =
          resolveEvidenceAccuracyModeForTenant(ctx.tenantId, 'chat') === 'enforce' &&
          filingSources.has(ref.id)
            ? describeAttachmentContentState(filingSources.get(ref.id)!).state
            : undefined;
        if (document)
          parts.push(
            formatAttachmentContext(
              document.filename,
              document.text,
              undefined,
              document,
              contentState,
            ),
          );
        else if (filingSources.has(ref.id)) {
          const imageVisible = message.id === lastUser?.id && visibleImageIds.has(ref.id);
          parts.push(
            formatAttachmentFilingReference(filingSources.get(ref.id)!, imageVisible, contentState),
          );
        } else {
          parts.push(
            `Attachment ${JSON.stringify(ref.filename)} (ID ${ref.id}) is unavailable for this turn. Ask for that file again; do not claim to have read it.`,
          );
        }
      }
      return {
        role: message.role as 'user' | 'assistant',
        text: parts.join('\n\n'),
      };
    });
    if (boundary || authorizedMessages.length >= 80) {
      const carried = await compactedAttachmentContext(
        this.prisma,
        ctx,
        conversationId,
        authorizedMessages.map((message) => message.id),
      );
      const latest = [...history].reverse().find((message) => message.role === 'user');
      if (carried && latest) latest.text += `\n\n${carried}`;
    }
    return {
      history,
      currentTurnImages,
      hasSummaryBoundary: Boolean(boundary),
      conversationSummary: reportContext.summary,
      withheldReports: reportContext.withheldReports,
    };
  }

  private async persistAssistantMessage(
    ctx: TenantContext,
    conversation: { clientId: string | null },
    conversationId: string,
    body: string,
    metadata: Record<string, unknown>,
  ): Promise<{ id: string }> {
    const message = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMessage.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: conversation.clientId,
          conversationId,
          role: 'assistant',
          body,
          metadata: metadata as Prisma.InputJsonValue,
        },
        select: { id: true },
      }),
    );
    this.maintenance.scheduleAfterTurnMaintenance(ctx, conversationId);
    return message;
  }
}

function extractStreamControl(body: string): StreamControl {
  let cleanContent = String(body ?? '');
  const traceEnabled = /(^|\s)#trace\b/i.test(cleanContent);
  cleanContent = cleanContent.replace(/(^|\s)#trace\b/gi, ' ').trim();
  const prefix = /^write on this page:\s*/i;
  const pageWriteEnabled = prefix.test(cleanContent);
  if (pageWriteEnabled) cleanContent = cleanContent.replace(prefix, '').trim();
  return { cleanContent, traceEnabled, pageWriteEnabled };
}

function procedureLogIdentity(receipt: ServedProcedureReceipt | undefined): string {
  if (!receipt) return 'none';
  return `${receipt.id}@${receipt.version}:${receipt.scope}:${receipt.effectMode}`;
}
