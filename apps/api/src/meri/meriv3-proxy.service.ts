import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiCredentialResolverService } from '../engagement/ai-credential-resolver.service.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { CLIO_SKILLS } from './skills/skill-registry.js';
import { matchFirmSkillForTurn } from './meri-firm-skills.helpers.js';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentMetaRef,
  attachmentRefsFromMetadata,
  formatAttachmentContext,
  imageHistoryPlaceholder,
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
import { classifyToolAction, isSideEffectingTool } from './meri-actions.helpers.js';
import { MeriV3ChatClient, type MeriV3ChatStreamEvent } from './meriv3-chat.client.js';
import { reasoningModeFromConversationMetadata } from './meriv3-conversation.helpers.js';

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
      emit({ type: 'error', message: 'MeriV3 is enabled but its isolated runtime URL is missing.' });
      emit({ type: 'done' });
      return;
    }
    if (!bearerToken) {
      emit({
        type: 'error',
        message: 'MeriV3 could not authenticate this turn. No model or tool call was made.',
      });
      emit({ type: 'done' });
      return;
    }

    const conversation = await this.ensureConversation(ctx, conversationId);
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

    if (
      process.env.MERI_COMPLIANCE_BLOCK !== 'false' &&
      (await this.flags.isEnabled(ctx.tenantId, 'complianceBlock', true))
    ) {
      const block = screenComplianceBlock(content);
      if (block.flagged) {
        const refusal = complianceRefusalBody(block.category);
        emit({ type: 'start', intent: 'compliance_refusal', tier: 'fast', runtime: 'meriv3' });
        emit({ type: 'text', text: refusal });
        await this.persistAssistantMessage(ctx, conversation, conversationId, refusal, {
          servedBy: 'compliance-block',
          runtime: 'meriv3',
          finishReason: 'stop',
          compliance: { flagged: true, category: block.category, blocked: true },
        });
        emit({ type: 'done' });
        return;
      }
    }

    const reportRequest =
      mode === 'new' && process.env.MERI_RESEARCH_PROMOTE !== 'false'
        ? detectDeliverableReportRequest(content)
        : null;
    if (
      reportRequest &&
      (await this.flags.isEnabled(ctx.tenantId, 'deepResearchPromote', true))
    ) {
      const offer =
        'This looks like a request for a full sourced deliverable. Run it through **Deep Research** so every figure, bill number, Program Element, and name is retrieved and verified before release. Use **Run as Deep Research** below, or rephrase for a quick chat answer.';
      emit({ type: 'start', intent: 'deep_research_offer', tier: 'deep', runtime: 'meriv3' });
      emit({ type: 'text', text: offer });
      emit({ type: 'research_offer', topic: reportRequest.topic, reason: reportRequest.reason });
      await this.persistAssistantMessage(ctx, conversation, conversationId, offer, {
        servedBy: 'research-promote',
        runtime: 'meriv3',
        finishReason: 'stop',
        researchOffer: { topic: reportRequest.topic },
      });
      emit({ type: 'done' });
      return;
    }

    const replay = await this.buildReplay(ctx, conversationId);
    const reasoningMode = reasoningModeFromConversationMetadata(conversation.metadata);
    const aiProvider = await this.aiCredentials.resolveProvider(ctx, 'openai');
    let clientKbSnapshot: string | undefined;
    if (conversation.clientId) {
      clientKbSnapshot =
        (await this.clientKb
          .buildSnapshot(ctx.tenantId, conversation.clientId)
          .catch(() => null)) ?? undefined;
    }
    let skillAddendum: string | undefined;
    try {
      const tenantSkills = await this.firmSkills.skillsForTenant(ctx.tenantId).catch(() => []);
      const matched = matchFirmSkillForTurn('', content, tenantSkills, CLIO_SKILLS);
      if (matched?.systemAddendum) skillAddendum = matched.systemAddendum;
    } catch {
      // Firm-authored steering is best effort; the governed runtime still works.
    }

    emit({
      type: 'start',
      intent: 'general',
      tier: reasoningMode === 'fast' ? 'fast' : 'deep',
      runtime: 'meriv3',
      reasoningMode,
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
    let runtimeEffort = reasoningMode;
    let doneFrame: Extract<MeriV3ChatStreamEvent, { type: 'done' }> | null = null;
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
          emit(event as unknown as Record<string, unknown>);
          return;
        case 'tool_call':
          emit({ type: 'tool_call', tool: event.tool, label: event.label });
          return;
        case 'tool_done': {
          steps.push(event);
          const summary =
            event.status === 'done'
              ? 'Completed'
              : event.status === 'pending_approval'
                ? 'Held for your approval'
                : event.detail ?? (event.status === 'blocked' ? 'Blocked' : 'Errored');
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
        case 'grounding_caveat':
          emit(event as unknown as Record<string, unknown>);
          return;
        case 'done':
          doneFrame = event;
          runtimeModel = event.model;
          runtimeEffort = event.reasoningEffort;
          return;
        case 'error':
          errorMessage = event.message;
          return;
      }
    };

    try {
      await this.client.streamChat({
        bearerToken,
        input: {
          messages: replay.history,
          ...(conversation.clientId ? { clientId: conversation.clientId } : {}),
          conversationId,
          ...(conversation.summary ? { conversationSummary: conversation.summary } : {}),
          ...(clientKbSnapshot ? { clientKbSnapshot } : {}),
          ...(skillAddendum ? { skillAddendum } : {}),
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
    }

    const aborted = Boolean(clientSignal?.aborted);
    const frame = doneFrame as Extract<MeriV3ChatStreamEvent, { type: 'done' }> | null;
    const assistantContent = (accumulated.trim() || frame?.reply || '').trim();
    if (!accumulated.trim() && assistantContent && !aborted && !errorMessage) {
      emit({ type: 'text', text: assistantContent });
    }
    if (frame?.usage && !aborted) emit({ type: 'usage', usage: frame.usage });
    if (frame?.citations?.length && !aborted) {
      emit({ type: 'citations', citations: frame.citations });
    }
    if (control.traceEnabled && steps.length && !aborted) {
      emit({ type: 'exec_trace', trace: steps });
    }

    if (assistantContent || steps.length || errorMessage) {
      const message = await this.persistAssistantMessage(
        ctx,
        conversation,
        conversationId,
        assistantContent || 'MeriV3 could not complete this turn. Please try again.',
        {
          intent: frame?.intent ?? 'general',
          model: runtimeModel,
          runtime: 'meriv3',
          servedBy: 'meriv3',
          reasoningMode,
          reasoningEffort: runtimeEffort,
          toolsUsed: steps.map((step) => step.tool),
          usage: frame?.usage ?? {},
          citations: (frame?.citations ?? []) as unknown as Prisma.InputJsonValue,
          ...(frame?.contextPacket
            ? { contextPacket: frame.contextPacket as unknown as Prisma.InputJsonValue }
            : {}),
          finishReason: aborted ? 'aborted' : errorMessage ? 'error' : 'stop',
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
      if (artifactIds.length) {
        await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.clioArtifact.updateMany({
            where: {
              id: { in: artifactIds },
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              conversationId,
              messageId: null,
            },
            data: { messageId: message.id },
          }),
        );
      }
    }

    if (errorMessage && !aborted) {
      emit({ type: 'error', message: errorMessage });
    }
    emit({ type: 'done' });
    this.logger.log(
      `MeriV3 proxy turn tenant=${ctx.tenantId} conversation=${conversationId} mode=${reasoningMode} ` +
        `model=${runtimeModel} tools=${steps.length} aborted=${aborted} sourceMessage=${sourceMessageId}`,
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
      }> = [];
      if (attachmentIds.length) {
        rows = await tx.clioAttachment.findMany({
          where: { id: { in: attachmentIds }, tenantId: ctx.tenantId, userId: ctx.userId },
          select: { id: true, filename: true, kind: true, status: true, byteSize: true },
        });
        if (rows.length !== new Set(attachmentIds).size) {
          throw new BadRequestException('One or more attachments were not found');
        }
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
        await tx.clioAttachment.updateMany({
          where: { id: { in: attachmentIds }, tenantId: ctx.tenantId, userId: ctx.userId },
          data: { messageId: message.id },
        });
      }
      return message.id;
    });
  }

  private async buildReplay(ctx: TenantContext, conversationId: string) {
    const messages = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMessage.findMany({
        where: { conversationId, role: { in: ['user', 'assistant'] } },
        orderBy: { createdAt: 'desc' },
        take: 40,
        select: { id: true, role: true, body: true, metadata: true },
      }),
    );
    messages.reverse();
    const refsByMessage = new Map<string, AttachmentMetaRef[]>();
    for (const message of messages) {
      const refs = attachmentRefsFromMetadata(message.metadata);
      if (refs.length) refsByMessage.set(message.id, refs);
    }
    const lastUser = [...messages].reverse().find((message) => message.role === 'user') ?? null;
    const allIds = [...refsByMessage.values()].flat().map((ref) => ref.id);
    const documentText = new Map<string, { filename: string; text: string }>();
    const currentTurnImages: Array<{ mediaType: string; dataBase64: string }> = [];
    if (allIds.length) {
      const documents = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioAttachment.findMany({
          where: { id: { in: allIds }, kind: { not: 'image' }, textContent: { not: null } },
          select: { id: true, filename: true, textContent: true },
        }),
      );
      for (const document of documents) {
        documentText.set(document.id, {
          filename: document.filename,
          text: document.textContent ?? '',
        });
      }
      const imageIds = (lastUser ? refsByMessage.get(lastUser.id) ?? [] : [])
        .filter((ref) => ref.kind === 'image')
        .map((ref) => ref.id);
      if (imageIds.length) {
        const images = await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.clioAttachment.findMany({
            where: { id: { in: imageIds }, kind: 'image' },
            select: { mediaType: true, data: true },
          }),
        );
        for (const image of images) {
          if (image.mediaType && image.data) {
            currentTurnImages.push({
              mediaType: image.mediaType,
              dataBase64: Buffer.from(image.data).toString('base64'),
            });
          }
        }
      }
    }
    const history = messages.map((message) => {
      const parts = [message.body];
      for (const ref of refsByMessage.get(message.id) ?? []) {
        const document = documentText.get(ref.id);
        if (document) parts.push(formatAttachmentContext(document.filename, document.text));
        else if (ref.kind === 'image' && message.id !== lastUser?.id) {
          parts.push(imageHistoryPlaceholder(ref.filename));
        }
      }
      return {
        role: message.role as 'user' | 'assistant',
        text: parts.join('\n\n'),
      };
    });
    return { history, currentTurnImages };
  }

  private async persistAssistantMessage(
    ctx: TenantContext,
    conversation: { clientId: string | null },
    conversationId: string,
    body: string,
    metadata: Record<string, unknown>,
  ): Promise<{ id: string }> {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
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
