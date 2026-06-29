import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { AiCredentialResolverService } from '../engagement/ai-credential-resolver.service.js';
import { recordAiUsageEvent } from '../engagement/ai-usage-record.js';
import {
  addUsage,
  applyRoundUsageEvent,
  applyToolCacheControl,
  buildMeriSystemBlocks,
  meriCapabilityBlock,
  emptyUsage,
  type SystemTextBlock,
} from './meri-prompt.helpers.js';
import { rankMemoriesByKeyword } from './meri-memory.helpers.js';
import { runToolsConcurrently } from './meri-tool-exec.helpers.js';
import {
  extractCitationsFromToolResult,
  formatCitationsForPrompt,
  validateCitationMarkers,
  type MeriCitation,
} from './meri-citations.helpers.js';
import {
  buildVerifierSources,
  extractGroundingFromToolResult,
} from './meri-verifier-sources.helpers.js';
import {
  DOMAIN_PRIMER,
  extractCitedPeCodes,
  planFanOutQueries,
} from './meri-domain-fanout.helpers.js';
import { collectPeStructuralWarnings } from './meri-pe-structural.helpers.js';
import { CLIO_SKILLS, matchSkill } from './skills/skill-registry.js';
import type { MeriSkill } from './skills/skill.types.js';
import { matchFirmSkillForTurn } from './meri-firm-skills.helpers.js';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { MeriMcpService } from './meri-mcp.service.js';
import { parseBridgedToolName } from './meri-mcp.helpers.js';
import { summarizeTurnTrace, traceLogLine, type MeriRoundTrace } from './meri-trace.helpers.js';
import { buildPlanSteps } from './meri-plan.helpers.js';
import { ToolCircuitBreaker, CircuitOpenError } from './meri-circuit-breaker.js';
import { loopBudgetExceeded, type LoopStopReason } from './meri-budget.helpers.js';
import { parseSuggestions } from './meri-suggestions.helpers.js';
import { normalizeFeedback, type NormalizedFeedback } from './meri-feedback.helpers.js';
import { COMPLIANCE_GUARDRAILS, screenComplianceRisk } from './meri-compliance.helpers.js';
import { confidenceLevel } from './meri-confidence.helpers.js';
import { classifyToolAction, isSideEffectingTool } from './meri-actions.helpers.js';
import mammoth from 'mammoth';
import { extractPdfText } from './meri-attachment-extract.js';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  attachmentMetaRef,
  attachmentRefsFromMetadata,
  formatAttachmentContext,
  imageHistoryPlaceholder,
  imageMediaTypeFromSniff,
  resolveDocumentStatus,
  validateAttachment,
  validateVisionSet,
  verifyMagicBytes,
  type AttachmentMetaRef,
  type AttachmentStatus,
} from './meri-attachment.helpers.js';
import {
  applyThinkingStreamEvent,
  createThinkingState,
  thinkingReplayBlocks,
  thinkingRequestParams,
  type ThinkingSettings,
} from './meri-thinking.helpers.js';
import {
  buildCompactionPrompt,
  estimateTokens,
  formatSummaryBlockForPrompt,
  planCompaction,
  sanitizeSummaryOutput,
} from './meri-compaction.helpers.js';
import {
  buildMessageEmbeddingText,
  groupHitsByConversation,
  type HistorySearchHit,
} from './meri-history-search.helpers.js';
import {
  EMBEDDING_MODEL,
  embedText,
  normalize as normalizeForEmbedding,
  sha256 as embeddingHash,
  vectorLiteral,
} from '../embeddings/embedder.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import {
  parseVerifierClaims,
  summarizeVerification,
  type VerificationResult,
} from './meri-verifier.helpers.js';
import { planTurnRerun } from './meri-turn.helpers.js';

interface CreateConversationInput {
  clientId?: string;
  title?: string;
}

interface UpdateConversationInput {
  title?: string;
  clientId?: string | null;
}

type ConfidenceLevel = 'high' | 'medium' | 'low';

type RetrievalTier = 'fast' | 'deep';

interface OrchestratorPolicy {
  tier: RetrievalTier;
  contextCharBudget: number;
  researchLimit: number;
  researchChars: number;
  intelChars: number;
  clientContextChars: number;
}

interface OrchestratorTraceStep {
  tool: string;
  action: 'selected' | 'skipped';
  reason: string;
}

interface MeriSourceAttribution {
  tool: string;
  count?: number;
  summary: string;
  confidence: ConfidenceLevel;
}

interface OrchestratorConflict {
  title: string;
  detail: string;
}

interface OrchestratorResult {
  context: string;
  sources: MeriSourceAttribution[];
  policy: OrchestratorPolicy;
  trace: OrchestratorTraceStep[];
  conflict: OrchestratorConflict | null;
  template: {
    heading: string;
    sections: string[];
  } | null;
}

interface StreamControl {
  traceEnabled: boolean;
  cleanContent: string;
  pageWriteEnabled: boolean;
}

const RUNTIME_NAME = 'Hermes';
const PRODUCT_NAME = 'Meri';

@Injectable()
export class MeriService {
  private readonly logger = new Logger(MeriService.name);

  // P2-2: per-(tenant, tool) circuit breaker — pauses a tool after repeated
  // failures so the turn proceeds without it instead of retrying a dead dep.
  private readonly toolBreaker = new ToolCircuitBreaker({ threshold: 3, cooldownMs: 30_000 });

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly tools: MeriToolsService,
    private readonly clientKb: ClientKbService,
    private readonly mcp: MeriMcpService,
    private readonly firmSkills: MeriFirmSkillsService,
    private readonly aiCredentials: AiCredentialResolverService,
  ) {}

  async status(ctx: TenantContext) {
    const profile = await this.currentProfile(ctx);
    const configured = Boolean(this.config.get('ANTHROPIC_API_KEY', { infer: true }));
    return {
      brand: PRODUCT_NAME,
      runtime: RUNTIME_NAME,
      configured,
      healthy: configured,
      user: profile,
      tools: this.tools.manifest(),
      detail: configured
        ? 'Meri is online.'
        : 'Meri is not configured: ANTHROPIC_API_KEY is missing.',
    };
  }

  async listConversations(ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const conversations = await tx.clioConversation.findMany({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, archivedAt: null },
        orderBy: { updatedAt: 'desc' },
        include: {
          client: { select: { id: true, name: true, logoS3Key: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          artifacts: { orderBy: { createdAt: 'desc' }, take: 4 },
        },
      });
      return conversations.map((conversation) => ({
        ...conversation,
        latestMessage: conversation.messages[0] ?? null,
        messages: undefined,
      }));
    });
  }

  async createConversation(ctx: TenantContext, input: CreateConversationInput) {
    const title = input.title?.trim() || 'New Meri session';
    if (input.clientId) {
      await this.ensureClientVisible(ctx, input.clientId);
    }
    const profile = await this.currentProfile(ctx);

    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: input.clientId ?? null,
          title,
          workspaceKey: 'workspace',
          metadata: {
            brand: PRODUCT_NAME,
            runtime: RUNTIME_NAME,
            userEmail: profile.email,
          },
        },
      }),
    );
  }

  async getConversation(ctx: TenantContext, conversationId: string) {
    return this.ensureConversation(ctx, conversationId);
  }

  async updateConversation(ctx: TenantContext, conversationId: string, input: UpdateConversationInput) {
    const conversation = await this.ensureConversation(ctx, conversationId);
    const data: Prisma.ClioConversationUpdateInput = {};

    if (typeof input.title === 'string') {
      const title = input.title.trim();
      if (!title) throw new BadRequestException('Conversation title cannot be empty');
      data.title = title;
    }

    if (input.clientId !== undefined) {
      if (input.clientId) await this.ensureClientVisible(ctx, input.clientId);
      data.client = input.clientId
        ? { connect: { id: input.clientId } }
        : { disconnect: true };
    }

    if (!Object.keys(data).length) {
      return conversation;
    }

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const updated = await tx.clioConversation.update({
        where: { id: conversationId },
        data: { ...data, updatedAt: new Date() },
        include: { client: { select: { id: true, name: true } } },
      });

      if (input.clientId !== undefined) {
        await Promise.all([
          tx.clioMessage.updateMany({
            where: {
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              conversationId,
            },
            data: { clientId: input.clientId ?? null },
          }),
          tx.clioArtifact.updateMany({
            where: {
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              conversationId,
            },
            data: { clientId: input.clientId ?? null },
          }),
        ]);
      }

      return updated;
    });
  }

  async archiveConversation(ctx: TenantContext, conversationId: string) {
    await this.ensureConversation(ctx, conversationId);
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.update({
        where: { id: conversationId },
        data: { archivedAt: new Date(), status: 'archived' },
      }),
    );
    return { ok: true, id: conversationId };
  }

  async restoreConversation(ctx: TenantContext, conversationId: string) {
    const conversation = await this.ensureConversationAnyStatus(ctx, conversationId);
    if (!conversation.archivedAt) return conversation;
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.update({
        where: { id: conversationId },
        data: { archivedAt: null, status: 'active', updatedAt: new Date() },
        include: { client: { select: { id: true, name: true } } },
      }),
    );
  }

  async listMessages(ctx: TenantContext, conversationId: string) {
    await this.ensureConversation(ctx, conversationId);
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMessage.findMany({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, conversationId },
        orderBy: { createdAt: 'asc' },
        include: { artifacts: { orderBy: { createdAt: 'asc' } } },
      }),
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

  private async ensureConversationAnyStatus(ctx: TenantContext, conversationId: string) {
    const conversation = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.findFirst({
        where: {
          id: conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
        },
        include: { client: { select: { id: true, name: true } } },
      }),
    );
    if (!conversation) throw new NotFoundException('Meri conversation not found');
    return conversation;
  }

  private async ensureClientVisible(ctx: TenantContext, clientId: string) {
    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
        select: { id: true },
      }),
    );
    if (!client) throw new NotFoundException('Client not found');
  }

  private async currentProfile(ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: ctx.userId },
        select: { email: true, firstName: true, lastName: true },
      });
      const displayName =
        [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'Capiro user';
      return {
        id: ctx.userId,
        clerkUserId: ctx.clerkUserId,
        email: user?.email ?? null,
        displayName,
      };
    });
  }

  // ── SSE Streaming (Phase 1: Unified brain) ──

  async streamMessage(
    ctx: TenantContext,
    conversationId: string,
    body: string,
    sse: { write: (data: string) => void },
    clientSignal?: AbortSignal,
    mode: 'new' | 'regenerate' | 'resend' = 'new',
    attachmentIds: string[] = [],
  ) {
    const conversation = await this.ensureConversation(ctx, conversationId);
    const streamControl = this.extractStreamControl(body);

    // Compliance pre-screen (P1-7): audit-log clearly high-risk asks. Does not
    // block — the guardrails baked into the system prompt drive the refusal.
    const complianceScreen = screenComplianceRisk(streamControl.cleanContent);
    if (complianceScreen.flagged) {
      this.logger.warn(
        `Meri compliance flag [${complianceScreen.category}] tenant=${ctx.tenantId} user=${ctx.userId} conversation=${conversationId}`,
      );
    }

    let content: string;
    if (mode === 'new') {
      content = streamControl.cleanContent.trim();
      if (!content && !attachmentIds.length) throw new BadRequestException('Message body is empty');
      if (!content) content = '(See the attached file(s).)';
      if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new BadRequestException(
          `At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`,
        );
      }
      // Persist the new user message; claim referenced attachments (F1) in the
      // same transaction so a validation failure never leaves a dangling turn.
      await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        let attachmentRows: Array<{
          id: string;
          filename: string;
          kind: string;
          status: string;
          byteSize: number;
        }> = [];
        if (attachmentIds.length) {
          attachmentRows = await tx.clioAttachment.findMany({
            where: { id: { in: attachmentIds }, tenantId: ctx.tenantId, userId: ctx.userId },
            select: { id: true, filename: true, kind: true, status: true, byteSize: true },
          });
          if (attachmentRows.length !== new Set(attachmentIds).size) {
            throw new BadRequestException(
              'One or more attachments were not found (they may have expired) — re-upload and try again',
            );
          }
          const vision = validateVisionSet(
            attachmentRows
              .filter((r) => r.kind === 'image')
              .map((r) => ({ byteSize: r.byteSize, filename: r.filename })),
          );
          if (!vision.ok) throw new BadRequestException(vision.reason ?? 'Invalid image set');
        }
        const userMessage = await tx.clioMessage.create({
          data: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            clientId: conversation.clientId ?? null,
            conversationId,
            role: 'user',
            body: content,
            metadata: attachmentRows.length
              ? ({
                  attachments: attachmentRows.map(attachmentMetaRef),
                } as unknown as Prisma.InputJsonValue)
              : {},
          },
        });
        if (attachmentRows.length) {
          await tx.clioAttachment.updateMany({
            where: { id: { in: attachmentIds }, tenantId: ctx.tenantId, userId: ctx.userId },
            data: { messageId: userMessage.id },
          });
        }
      });
    } else {
      // Regenerate / edit-and-resend (P0-4): re-run the last user turn, discarding
      // the assistant turn(s) after it. No new user message is persisted; for
      // 'resend' the last user message body is replaced with the edited text.
      const prior = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioMessage.findMany({
          where: { conversationId, role: { in: ['user', 'assistant'] } },
          orderBy: { createdAt: 'asc' },
          select: { id: true, role: true, body: true },
        }),
      );
      const editedBody = mode === 'resend' ? streamControl.cleanContent.trim() : undefined;
      const plan = planTurnRerun(prior, mode, editedBody);
      if (!plan || !plan.contentToUse.trim()) {
        throw new BadRequestException('No previous user message to re-run');
      }
      content = plan.contentToUse;
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

    // Load recent history (F2): with a compaction summary, replay only the
    // messages newer than the summary boundary and inject the summary block;
    // otherwise fall back to the most recent turns.
    const summaryBoundary = conversation.summaryUpToMessageId
      ? await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.clioMessage.findFirst({
            where: { id: conversation.summaryUpToMessageId ?? undefined, conversationId },
            select: { createdAt: true },
          }),
        )
      : null;
    const conversationSummary = summaryBoundary ? (conversation.summary ?? null) : null;
    const historyDesc = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMessage.findMany({
        where: {
          conversationId,
          role: { in: ['user', 'assistant'] },
          ...(summaryBoundary ? { createdAt: { gt: summaryBoundary.createdAt } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        // Last-N turns kept verbatim. The char-budget trim (CLIO_HISTORY_CHAR_BUDGET)
        // is the real cap; this just bounds the DB read. Raised from 20→40 (and
        // 60→80 post-summary) so short turns aren't evicted before the char budget
        // even applies — fixes "Meri loses context" in longer threads.
        take: summaryBoundary ? 80 : 40,
        select: { id: true, role: true, body: true, metadata: true },
      }),
    );
    const history = historyDesc.reverse();

    // Resolve attachment context for replay (F1): documents re-inject their
    // extracted text on every turn; images attach as native vision blocks on
    // the current turn only (older turns get a placeholder line so the model
    // knows they existed).
    const attachmentRefsByMessage = new Map<string, AttachmentMetaRef[]>();
    for (const m of history) {
      const refs = attachmentRefsFromMetadata(m.metadata);
      if (refs.length) attachmentRefsByMessage.set(m.id, refs);
    }
    const lastUserMessage = [...history].reverse().find((m) => m.role === 'user') ?? null;
    const docTextById = new Map<string, { filename: string; text: string }>();
    const currentTurnImages: Array<{ filename: string; mediaType: string; dataBase64: string }> =
      [];
    if (attachmentRefsByMessage.size) {
      const allRefIds = [...attachmentRefsByMessage.values()].flat().map((r) => r.id);
      const docRows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioAttachment.findMany({
          where: { id: { in: allRefIds }, kind: { not: 'image' }, textContent: { not: null } },
          select: { id: true, filename: true, textContent: true },
        }),
      );
      for (const row of docRows) {
        docTextById.set(row.id, { filename: row.filename, text: row.textContent ?? '' });
      }
      const lastUserImageIds = (
        (lastUserMessage && attachmentRefsByMessage.get(lastUserMessage.id)) ??
        []
      )
        .filter((r) => r.kind === 'image')
        .map((r) => r.id);
      if (lastUserImageIds.length) {
        const imageRows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.clioAttachment.findMany({
            where: { id: { in: lastUserImageIds }, kind: 'image' },
            select: { id: true, filename: true, mediaType: true, data: true },
          }),
        );
        for (const row of imageRows) {
          if (row.data && row.mediaType) {
            currentTurnImages.push({
              filename: row.filename,
              mediaType: row.mediaType,
              dataBase64: Buffer.from(row.data).toString('base64'),
            });
          }
        }
      }
    }
    const replayHistory = history.map((m) => {
      const refs = attachmentRefsByMessage.get(m.id) ?? [];
      if (!refs.length) return { role: m.role as 'user' | 'assistant', body: m.body };
      const parts = [m.body];
      for (const ref of refs) {
        const doc = docTextById.get(ref.id);
        if (doc) parts.push(formatAttachmentContext(doc.filename, doc.text));
        else if (ref.kind === 'image' && m.id !== lastUserMessage?.id) {
          parts.push(imageHistoryPlaceholder(ref.filename));
        }
      }
      return { role: m.role as 'user' | 'assistant', body: parts.join('\n\n') };
    });

    // Classify intent
    const intent = await this.classifyIntent(content);
    this.logger.debug(`Stream intent: ${intent}`);

    // Firm-authored skills (F6b): tenant skills fire by intent or literal
    // trigger phrase; built-ins always win on conflict (registry safe-merge).
    let firmSkill: MeriSkill | null = null;
    if (this.skillsEnabled()) {
      const tenantSkills = await this.firmSkills.skillsForTenant(ctx.tenantId).catch(() => []);
      firmSkill = matchFirmSkillForTurn(intent, content, tenantSkills, CLIO_SKILLS);
      if (firmSkill) this.logger.debug(`Firm skill matched: ${firmSkill.id}`);
    }

    const orchestration = await this.orchestrateContext(ctx, conversation.clientId, intent, content);
    const effectiveTemplate = firmSkill?.template ?? orchestration.template;
    const promptCacheEnabled = this.config.get('CLIO_PROMPT_CACHE_ENABLED', { infer: true });
    const citationsEnabled = this.config.get('CLIO_CITATIONS_ENABLED', { infer: true });
    const systemBlocks = this.buildSystemBlocks(
      intent,
      orchestration.context,
      effectiveTemplate,
      promptCacheEnabled,
      conversationSummary,
      firmSkill,
    );

    sse.write(`data: ${JSON.stringify({ type: 'start', intent, tier: orchestration.policy.tier })}\n\n`);
    // Stream the plan up front (P2-1): a short "here's what I'll do" derived from
    // the orchestration's selected context sources, shown before tokens stream.
    sse.write(
      `data: ${JSON.stringify({ type: 'plan', steps: buildPlanSteps(orchestration.trace, intent) })}\n\n`,
    );
    if (streamControl.pageWriteEnabled) {
      sse.write(
        `data: ${JSON.stringify({
          type: 'page_write',
          target: 'outreach_draft',
          note: 'Write mode enabled: updates will be applied to this page when supported.',
        })}\n\n`,
      );
    }
    if (streamControl.traceEnabled) {
      sse.write(`data: ${JSON.stringify({ type: 'trace', trace: orchestration.trace, policy: orchestration.policy })}\n\n`);
    }
    if (orchestration.sources.length) {
      sse.write(`data: ${JSON.stringify({ type: 'sources', sources: orchestration.sources })}\n\n`);
    }
    if (orchestration.conflict) {
      sse.write(`data: ${JSON.stringify({ type: 'conflict', conflict: orchestration.conflict })}\n\n`);
    }
    if (effectiveTemplate) {
      sse.write(`data: ${JSON.stringify({ type: 'template', template: effectiveTemplate })}\n\n`);
    }

    // Trim history to a char budget (oldest-first) so long sessions don't
    // silently exceed the model context window and 400.
    const historyBudget = this.config.get('CLIO_HISTORY_CHAR_BUDGET', { infer: true });
    const trimmedHistory = trimHistoryToBudget(replayHistory, historyBudget);

    let assistantContent = '';
    const producedArtifacts: Array<{
      title: string;
      kind: string;
      contentType: string | null;
      bodyText: string | null;
      s3Key: string | null;
      metadata: Prisma.InputJsonValue;
    }> = [];
    const toolsUsed: string[] = [];
    const actionsTaken: Array<{ tool: string; kind: string; ok: boolean }> = [];
    const usageTotals = emptyUsage();
    const citations: MeriCitation[] = [];
    // Rich verifier grounding keyed by the SAME [N] marker as `citations`, so the
    // grounding gate sees the full records (budget figures, appropriation type,
    // markup status) the model saw — not the thin title+snippet stub that caused
    // the "18 of 18 claims unbacked" false-negative.
    const groundingByN = new Map<number, string>();
    let finalCitations: MeriCitation[] = [];
    let pageWritePayload: { subject?: string; body?: string } | null = null;
    let aborted = false;
    // Hoisted for post-turn usage metering (assigned inside the try below);
    // default to Meri's quality model + global key so a pre-call throw still
    // meters sensibly.
    let model = this.config.get('CLIO_MODEL', { infer: true });
    let usedTenantKey = false;
    const turnStartMs = Date.now();
    const traceRounds: MeriRoundTrace[] = [];
    let loopStopReason: LoopStopReason | null = null;

    try {
      // Per-tenant AI credentials: run Meri's Anthropic brain on the tenant's
      // own key + model override when they've set one, else the global key.
      // NOTE: the resolver's global model default is ANTHROPIC_MODEL (the cheap
      // Haiku used for engagement), which is NOT Meri's model. Meri's quality
      // default is CLIO_MODEL (Sonnet); only a tenant's explicit modelOverride
      // should change it. So: use the resolved key always, but keep CLIO_MODEL
      // as the model unless the call ran on a tenant key that carried an override.
      const meriModel = this.config.get('CLIO_MODEL', { infer: true });
      const resolved = await this.aiCredentials.resolveProvider(ctx, 'anthropic');
      if (!resolved) throw new Error('ANTHROPIC_API_KEY not configured');
      const anthropicKey = resolved.apiKey;
      usedTenantKey = resolved.usedTenantKey;
      // A tenant key with its own modelOverride drives the model; otherwise
      // Meri stays on its quality default. (resolved.model === MERI default
      // means no override was set, since the resolver fills ANTHROPIC_MODEL.)
      model =
        usedTenantKey && resolved.model !== this.aiCredentials.defaultModelFor('anthropic')
          ? resolved.model
          : meriModel;
      const maxTokens = this.config.get('CLIO_MAX_TOKENS', { infer: true });
      // Extended thinking on the deep tier (F3): fast-tier turns are untouched;
      // the kill-switch (CLIO_EXTENDED_THINKING=off) restores baseline behavior.
      const thinkingSettings: ThinkingSettings = {
        enabled: this.config.get('CLIO_EXTENDED_THINKING', { infer: true }),
        mode: this.config.get('CLIO_THINKING_MODE', { infer: true }),
        budgetTokens: this.config.get('CLIO_THINKING_BUDGET_TOKENS', { infer: true }),
      };
      const thinking = thinkingRequestParams(
        thinkingSettings,
        orchestration.policy.tier,
        maxTokens,
      );
      const timeoutMs = this.config.get('CLIO_REQUEST_TIMEOUT_MS', { infer: true });
      const maxRounds = this.config.get('CLIO_MAX_TOOL_ROUNDS', { infer: true });
      const turnBudgetMs = this.config.get('CLIO_TURN_BUDGET_MS', { infer: true });
      const toolTimeoutMs = this.config.get('CLIO_TOOL_TIMEOUT_MS', { infer: true });
      const toolRetries = this.config.get('CLIO_TOOL_RETRIES', { infer: true });
      // Bridged MCP tools (F6a) merge into the tool surface per tenant at
      // request time. Tenants with no MCP servers keep the exact baseline
      // tool list (and its shared prompt-cache prefix). run_analysis (F4) is
      // GA: it registers for every tenant by default (opt-OUT via
      // clioFeatureFlags.runAnalysis=false) and disappears instantly under the
      // env kill-switch CLIO_ANALYSIS_SANDBOX_ENABLED.
      const analysisEnabled = await this.tools.analysisSandboxEnabled(ctx.tenantId);
      const nativeSchemas = this.tools
        .anthropicToolSchemas()
        .filter((schema) => analysisEnabled || schema.name !== 'run_analysis');
      const mcpSchemas = await this.mcp.bridgedSchemasForTenant(ctx.tenantId);
      const toolSchemas = applyToolCacheControl(
        [...nativeSchemas, ...mcpSchemas],
        promptCacheEnabled,
      );

      // Anthropic message turns. content can be a string (history) or an array
      // of blocks (assistant tool_use / user tool_result) during the agentic loop.
      const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = trimmedHistory.map((m) => ({
        role: m.role,
        content: m.body,
      }));

      // Attach current-turn images as native Anthropic vision blocks (F1): the
      // Messages API reads them directly, no extraction step.
      if (currentTurnImages.length && messages.length) {
        const last = messages[messages.length - 1];
        if (last && last.role === 'user' && typeof last.content === 'string') {
          last.content = [
            ...currentTurnImages.map((img) => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 },
            })),
            { type: 'text', text: last.content },
          ];
        }
      }

      for (let round = 0; ; round += 1) {
        // Raised round cap + wall-clock turn budget (P2-3): stop and wrap up
        // gracefully rather than letting a single turn run away.
        const budgetStop = loopBudgetExceeded({
          round,
          maxRounds,
          elapsedMs: Date.now() - turnStartMs,
          budgetMs: turnBudgetMs,
        });
        if (budgetStop) {
          loopStopReason = budgetStop;
          if (!assistantContent.trim()) {
            const note =
              'I gathered information but reached this turn’s limit before composing a full answer — ask again and I’ll continue.';
            assistantContent = note;
            sse.write(`data: ${JSON.stringify({ type: 'text', text: note })}\n\n`);
          } else if (budgetStop === 'time_budget') {
            const note = '\n\n_(Reached this turn’s time budget — wrapping up.)_';
            assistantContent += note;
            sse.write(`data: ${JSON.stringify({ type: 'text', text: note })}\n\n`);
          }
          break;
        }
        if (clientSignal?.aborted) {
          aborted = true;
          break;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        // Cancel the in-flight model stream if the client disconnects / hits Stop.
        const onClientAbort = () => controller.abort();
        if (clientSignal) {
          if (clientSignal.aborted) controller.abort();
          else clientSignal.addEventListener('abort', onClientAbort);
        }

        // Accumulators for this round's assistant turn.
        const toolUseById = new Map<number, { id: string; name: string; jsonParts: string[] }>();
        const thinkingState = createThinkingState();
        const roundUsage = emptyUsage();
        let stopReason: string | null = null;
        const roundStartMs = Date.now();

        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              max_tokens: thinking.maxTokens,
              ...(thinking.thinking ? { thinking: thinking.thinking } : {}),
              stream: true,
              system: systemBlocks,
              tools: toolSchemas,
              messages,
            }),
            signal: controller.signal,
          });

          if (!response.ok || !response.body) {
            const errText = await response.text().catch(() => '');
            throw new Error(`Anthropic HTTP ${response.status}${errText ? `: ${errText.slice(0, 300)}` : ''}`);
          }

          const decoder = new TextDecoder();
          const responseBody = response.body as unknown as AsyncIterable<Uint8Array>;
          let buffer = '';

          for await (const chunk of responseBody) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const evt = JSON.parse(payload);
                applyRoundUsageEvent(roundUsage, evt);
                // Extended thinking (F3): relay reasoning deltas to the UI
                // timeline; the accumulated blocks replay in the agentic loop
                // but never persist (redaction guarantee, spec-covered).
                const thinkingDelta = applyThinkingStreamEvent(thinkingState, evt);
                if (thinkingDelta.thinkingTextDelta) {
                  sse.write(
                    `data: ${JSON.stringify({ type: 'thinking', text: thinkingDelta.thinkingTextDelta })}\n\n`,
                  );
                }
                if (evt.type === 'content_block_start') {
                  const block = evt.content_block ?? {};
                  if (block.type === 'tool_use') {
                    toolUseById.set(evt.index, {
                      id: String(block.id ?? ''),
                      name: String(block.name ?? ''),
                      jsonParts: [],
                    });
                  }
                } else if (evt.type === 'content_block_delta') {
                  const delta = evt.delta ?? {};
                  if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                    assistantContent += delta.text;
                    sse.write(`data: ${JSON.stringify({ type: 'text', text: delta.text })}\n\n`);
                  } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                    toolUseById.get(evt.index)?.jsonParts.push(delta.partial_json);
                  }
                } else if (evt.type === 'message_delta') {
                  stopReason = evt.delta?.stop_reason ?? stopReason;
                }
              } catch { /* incomplete chunk */ }
            }
          }
        } finally {
          clearTimeout(timer);
          clientSignal?.removeEventListener('abort', onClientAbort);
        }

        addUsage(usageTotals, roundUsage);
        this.logger.debug(
          `Meri usage [round ${round}] in=${roundUsage.inputTokens} out=${roundUsage.outputTokens} ` +
            `cacheRead=${roundUsage.cacheReadInputTokens} cacheCreate=${roundUsage.cacheCreationInputTokens}`,
        );

        // If the model did not request tools, the turn is complete.
        if (stopReason !== 'tool_use' || toolUseById.size === 0) {
          traceRounds.push({
            round,
            durationMs: Date.now() - roundStartMs,
            usage: roundUsage,
            stopReason,
            tools: [],
          });
          break;
        }

        // Reconstruct the assistant turn (text + tool_use blocks) and append it,
        // then execute each tool in-process and feed results back as a user turn.
        const orderedTools = [...toolUseById.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
        // Assistant content blocks: thinking blocks first (the API requires
        // them replayed with signatures when tools are used — F3), then
        // tool_use blocks.
        const assistantTurn: Array<Record<string, unknown>> = [
          ...thinkingReplayBlocks(thinkingState),
        ];
        // Note: we cannot perfectly reconstruct interleaved text positions from
        // the stream, so we emit accumulated text (if any new this round) as one
        // block followed by the tool_use blocks. Anthropic accepts this ordering.
        for (const t of orderedTools) {
          let parsedInput: Record<string, unknown> = {};
          const raw = t.jsonParts.join('');
          if (raw.trim()) {
            try { parsedInput = JSON.parse(raw); } catch { parsedInput = {}; }
          }
          assistantTurn.push({ type: 'tool_use', id: t.id, name: t.name, input: parsedInput });
        }
        messages.push({ role: 'assistant', content: assistantTurn });

        // Phase 1: parse each tool's input and emit its tool_call event up front,
        // in deterministic order, so the trust timeline shows the full plan before
        // results stream back. (Not gated on #trace — the user always sees calls.)
        const preparedTools = orderedTools.map((t, index) => {
          let parsedInput: Record<string, unknown> = {};
          const raw = t.jsonParts.join('');
          if (raw.trim()) {
            try { parsedInput = JSON.parse(raw); } catch { parsedInput = {}; }
          }
          // Default clientId from the conversation if the model omitted it.
          if (conversation.clientId && parsedInput.clientId === undefined) {
            parsedInput.clientId = conversation.clientId;
          }
          // Always thread the active conversationId into the tool input. The
          // model never supplies it (it isn't in any tool schema), and the
          // artifact-producing tools (create_word/create_excel/create_powerpoint,
          // create_meeting_brief, draft_policy_memo) require it to persist their
          // ClioArtifact row — without it persistArtifact returns
          // { persisted: false } and the generated Office document is silently
          // dropped (no artifact row, no download URL, canvas never opens).
          if (parsedInput.conversationId === undefined) {
            parsedInput.conversationId = conversationId;
          }
          toolsUsed.push(t.name);
          sse.write(`data: ${JSON.stringify({ type: 'tool_call', tool: t.name, label: humanToolLabel(t.name), input: redactToolInput(parsedInput) })}\n\n`);
          // Bridged MCP tools (F6a) are side-effecting (serialized) unless the
          // admin explicitly allowlisted them read-only.
          const concurrencySafe = parseBridgedToolName(t.name)
            ? this.mcp.isBridgedToolReadOnly(ctx.tenantId, t.name)
            : this.tools.isConcurrencySafe(t.name);
          return { index, tool: t, parsedInput, concurrencySafe };
        });

        // Phase 2: execute concurrently — read-only tools in parallel, side-effecting
        // tools serialized — with a per-tool timeout, preserving result order (P0-2).
        // P2-2: skip tools whose circuit is open (recent repeated failures) — the
        // closure throws CircuitOpenError (surfaced honestly, never retried);
        // idempotent tools get retried with backoff; results record breaker state.
        const breakerOpenAtStart = new Set(
          preparedTools
            .filter((item) => this.toolBreaker.isOpen(`${ctx.tenantId}:${item.tool.name}`))
            .map((item) => item.tool.name),
        );
        const outcomes = await runToolsConcurrently(
          preparedTools,
          (item): Promise<unknown> => {
            if (this.toolBreaker.isOpen(`${ctx.tenantId}:${item.tool.name}`)) {
              throw new CircuitOpenError(item.tool.name);
            }
            // Route bridged MCP tools to their server (F6a); the MCP service
            // wraps results as untrusted data and audits write calls.
            if (parseBridgedToolName(item.tool.name)) {
              return this.mcp.executeBridged(ctx, item.tool.name, item.parsedInput);
            }
            return this.tools.execute(ctx, item.tool.name as never, item.parsedInput);
          },
          {
            timeoutMs: toolTimeoutMs,
            retries: toolRetries,
            retryBackoffMs: 250,
            isRetryable: (err) => !(err instanceof CircuitOpenError),
          },
        );
        // Record breaker state only for tools we actually attempted (don't
        // penalize a tool we skipped because its breaker was already open).
        for (const item of preparedTools) {
          if (breakerOpenAtStart.has(item.tool.name)) continue;
          const key = `${ctx.tenantId}:${item.tool.name}`;
          if (outcomes[item.index]?.ok) this.toolBreaker.recordSuccess(key);
          else this.toolBreaker.recordFailure(key);
        }
        // P2-5: audit every side-effecting action Meri takes this round.
        for (const item of preparedTools) {
          if (!isSideEffectingTool(item.tool.name)) continue;
          const ok = outcomes[item.index]?.ok ?? false;
          const kind = classifyToolAction(item.tool.name);
          actionsTaken.push({ tool: item.tool.name, kind, ok });
          this.logger.log(
            `Meri action [${kind}] tool=${item.tool.name} ok=${ok} tenant=${ctx.tenantId} user=${ctx.userId} conversation=${conversationId}`,
          );
        }

        // Phase 3: surface each source + assemble tool_result blocks in tool_use order.
        const toolResultBlocks: Array<Record<string, unknown>> = [];
        for (const item of preparedTools) {
          const t = item.tool;
          const outcome = outcomes[item.index];
          let resultPayload: unknown;
          let isError = false;
          if (outcome && outcome.ok) {
            resultPayload = outcome.result;
            // Capture any artifacts the tool persisted so the artifact panel sees them.
            for (const art of extractToolArtifacts(resultPayload)) producedArtifacts.push(art);
            // If a draft/email tool ran in page-write mode, capture body for the page-write event.
            if (streamControl.pageWriteEnabled && (t.name === 'draft_policy_memo' || t.name === 'create_meeting_brief')) {
              const art = producedArtifacts[producedArtifacts.length - 1];
              if (art?.bodyText) pageWritePayload = { subject: art.title, body: art.bodyText };
            }
          } else {
            isError = true;
            resultPayload = { error: outcome?.error ?? 'Tool execution failed' };
          }
          // Extract numbered citation candidates from successful results so the
          // model can cite them as [N]; prepend the numbered list to the
          // tool_result content fed back to the model (P0-3).
          let toolContent = summarizeJsonForPrompt(resultPayload, 12_000);
          if (citationsEnabled && !isError) {
            const cites = extractCitationsFromToolResult(t.name, resultPayload, citations.length + 1);
            if (cites.length) {
              // Capture rich grounding for the SAME marker numbers before we push
              // the citations (startN must match the citation extractor's startN).
              const grounding = extractGroundingFromToolResult(resultPayload, citations.length + 1);
              for (const [n, body] of grounding) groundingByN.set(n, body);
              citations.push(...cites);
              toolContent = `${formatCitationsForPrompt(cites)}\n\n${toolContent}`;
            }
          }
          // Emit a real source with a human detail (counts / sample titles) so
          // the trust panel can show actual citations, not just a tool name.
          const { count, detail } = summarizeToolResultForTrust(resultPayload);
          sse.write(`data: ${JSON.stringify({
            type: 'sources',
            sources: [{
              tool: t.name,
              label: humanToolLabel(t.name),
              count: count ?? undefined,
              summary: isError
                ? (typeof (resultPayload as { error?: unknown })?.error === 'string' ? (resultPayload as { error: string }).error : 'Tool error')
                : (detail || 'Completed'),
              confidence: isError ? 'low' : 'high',
            }],
          })}\n\n`);
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: t.id,
            is_error: isError,
            content: toolContent,
          });
        }
        messages.push({ role: 'user', content: toolResultBlocks });
        traceRounds.push({
          round,
          durationMs: Date.now() - roundStartMs,
          usage: roundUsage,
          stopReason,
          tools: preparedTools.map((item) => ({
            name: item.tool.name,
            ok: outcomes[item.index]?.ok ?? false,
          })),
        });
        // Loop again so the model can read tool results and answer (or call more tools).
      }
    } catch (err) {
      if (clientSignal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        // Client disconnected / hit Stop: keep the partial answer, surface no error.
        aborted = true;
        this.logger.log(`Meri turn aborted by client [conv ${conversationId}]`);
      } else {
        const msg = err instanceof Error ? err.message : 'AI generation failed';
        sse.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`);
        if (!assistantContent) assistantContent = `Error: ${msg}`;
      }
    }

    this.logger.log(
      `Meri total usage [conv ${conversationId}] in=${usageTotals.inputTokens} out=${usageTotals.outputTokens} ` +
        `cacheRead=${usageTotals.cacheReadInputTokens} cacheCreate=${usageTotals.cacheCreationInputTokens}`,
    );
    sse.write(`data: ${JSON.stringify({ type: 'usage', usage: usageTotals })}\n\n`);

    // Per-tenant AI usage metering: persist one AiUsageEvent for this Meri turn
    // so Meri spend shows up in the tenant usage dashboards + admin console
    // alongside outreach. Best-effort — recordAiUsageEvent swallows + logs any
    // failure so metering can never break a turn. cache tokens are billed at
    // the input rate by the pricing model, so fold them into inputTokens.
    await recordAiUsageEvent(
      { prisma: this.prisma, logger: this.logger },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      'clio_chat',
      {
        provider: 'anthropic',
        model,
        usage: {
          inputTokens:
            usageTotals.inputTokens +
            usageTotals.cacheReadInputTokens +
            usageTotals.cacheCreationInputTokens,
          outputTokens: usageTotals.outputTokens,
        },
        usedTenantKey,
      },
    );

    // Validate citation markers against the numbered sources collected this turn:
    // keep real [N], strip hallucinated ones, surface the used citations (P0-3).
    if (citationsEnabled) {
      const { used, dropped, cleanedText } = validateCitationMarkers(assistantContent, citations);
      finalCitations = used;
      assistantContent = cleanedText;
      if (dropped.length) {
        this.logger.warn(`Meri dropped ${dropped.length} unmatched citation marker(s): [${dropped.join('], [')}]`);
      }
      if (used.length) {
        sse.write(`data: ${JSON.stringify({ type: 'citations', citations: used })}\n\n`);
      }
    }

    // Grounding/verifier gate (P0-6): for deliverables (briefings/memos) only —
    // never raw chat — run a cheap second pass that flags claims unsupported by
    // the retrieved sources. Fail-open (null on disable/error); >20% unsupported
    // marks the deliverable low-confidence for the UI banner.
    let verification: VerificationResult | null = null;
    const deliverable = producedArtifacts.find((a) => a.bodyText && a.bodyText.trim().length > 0);
    if (deliverable?.bodyText) {
      verification = await this.verifyDeliverable(
        deliverable.bodyText,
        buildVerifierSources(finalCitations, groundingByN),
      );
      // Structural + fan-out enrichment (P0-7..P0-10): deterministic PE category
      // checks (RDT&E vs procurement, capability/mission mismatch, primary-vehicle
      // overclaim) + adjacent freshness/better-fit findings. Fail-open: any error
      // leaves `structural` empty and never blocks the deliverable.
      const structural = await this.enrichDeliverableStructural(ctx, deliverable.bodyText);
      if (verification || structural.warnings.length || structural.fanOut.length) {
        sse.write(
          `data: ${JSON.stringify({
            type: 'verification',
            title: deliverable.title,
            verification,
            confidence: verification ? confidenceLevel(verification.unsupportedRatio) : undefined,
            structuralWarnings: structural.warnings,
            fanOut: structural.fanOut,
          })}\n\n`,
        );
      }
    }

    // If page-write mode produced concrete content, emit the real event the
    // frontend listens for (previously only a static "enabled" note was sent).
    if (streamControl.pageWriteEnabled && pageWritePayload) {
      sse.write(`data: ${JSON.stringify({ type: 'page_write', target: 'outreach_draft', subject: pageWritePayload.subject, body: pageWritePayload.body })}\n\n`);
    }

    // Execution trace (P1-3): aggregate per-round timings/usage + tool outcomes
    // for observability; persisted to metadata.trace and logged. Streamed to the
    // client only when the user opted into the trace view (#trace).
    const turnTrace = summarizeTurnTrace({
      intent,
      skill: firmSkill?.id ?? (this.skillsEnabled() ? (matchSkill(intent)?.id ?? null) : null),
      rounds: traceRounds,
      totalUsage: usageTotals,
      totalDurationMs: Date.now() - turnStartMs,
      lowConfidence: verification ? verification.lowConfidence : null,
    });
    this.logger.log(traceLogLine(turnTrace));
    if (streamControl.traceEnabled) {
      sse.write(`data: ${JSON.stringify({ type: 'exec_trace', trace: turnTrace })}\n\n`);
    }

    // Suggested next actions (P2-4): a cheap pass proposes 2-3 follow-up prompts,
    // streamed as chips. Skipped on abort / trivial answers; fail-open.
    let suggestions: string[] = [];
    if (this.suggestionsEnabled() && !aborted && assistantContent.trim().length > 40) {
      suggestions = await this.generateSuggestions(streamControl.cleanContent, assistantContent);
      if (suggestions.length) {
        sse.write(`data: ${JSON.stringify({ type: 'suggestions', suggestions })}\n\n`);
      }
    }

    // Persist assistant response (+ any artifacts produced by tools).
    const createdDeliverables: Array<{ id: string; title: string; kind: string; bodyText: string }> =
      [];
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const message = await tx.clioMessage.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: conversation.clientId ?? null,
          conversationId,
          role: 'assistant',
          body: assistantContent,
          metadata: {
            intent,
            model,
            tier: orchestration.policy.tier,
            preWarmSources: orchestration.sources.map((source) => source.tool),
            toolsUsed,
            usage: { ...usageTotals },
            citations: finalCitations as unknown as Prisma.InputJsonValue,
            finishReason: aborted ? 'aborted' : (loopStopReason ?? 'stop'),
            verification: verification as unknown as Prisma.InputJsonValue,
            trace: turnTrace as unknown as Prisma.InputJsonValue,
            suggestions,
            actions: actionsTaken,
            ...(complianceScreen.flagged
              ? { compliance: { flagged: true, category: complianceScreen.category } }
              : {}),
          },
        },
      });
      for (const art of producedArtifacts) {
        const createdArtifact = await tx.clioArtifact.create({
          data: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            clientId: conversation.clientId ?? null,
            conversationId,
            messageId: message.id,
            ...art,
          },
        });
        const artMeta = art.metadata as Record<string, unknown> | null;
        const isImageArtifact = typeof artMeta?.imageBase64 === 'string';
        if ((art.bodyText && art.bodyText.trim()) || isImageArtifact) {
          // Image artifacts (F4 charts) stream with an empty body; the UI
          // fetches the PNG from GET /clio/artifacts/:id/image by kind.
          createdDeliverables.push({
            id: createdArtifact.id,
            title: art.title,
            kind: art.kind,
            bodyText: art.bodyText ?? '',
          });
        }
      }
    });

    // Artifacts / Canvas (P1-4): stream produced deliverables so the client can
    // open them in the side canvas (copy / download / version).
    for (const deliverable of createdDeliverables) {
      sse.write(`data: ${JSON.stringify({ type: 'artifact', artifact: deliverable })}\n\n`);
    }

    // Auto-summarize for memory (if substantial)
    if (assistantContent.length > 200) {
      void this.maybeLearnFromConversation(ctx.tenantId, ctx.userId, conversationId, content, assistantContent).catch(() => {});
    }

    // After-turn maintenance (F2): index this turn's messages for history
    // search and run compaction when the conversation outgrows its budget.
    // Scheduled off the response cycle and fail-open — it never blocks or
    // breaks the streaming reply.
    setImmediate(() => {
      this.afterTurnMaintenance(ctx, conversationId).catch((err) => {
        this.logger.warn(
          `Meri after-turn maintenance failed [conv ${conversationId}]: ${err instanceof Error ? err.message : err}`,
        );
      });
    });

    sse.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  }

  /** PNG bytes for an analysis-chart artifact (F4 chat/docgen rendering). */
  async getArtifactImage(
    ctx: TenantContext,
    id: string,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    const artifact = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.findFirst({
        where: { id, tenantId: ctx.tenantId },
        select: { contentType: true, metadata: true },
      }),
    );
    const meta = artifact?.metadata as Record<string, unknown> | null;
    const b64 = typeof meta?.imageBase64 === 'string' ? (meta.imageBase64 as string) : null;
    if (!b64) return null;
    return {
      buffer: Buffer.from(b64, 'base64'),
      contentType: artifact?.contentType ?? 'image/png',
    };
  }

  // ── Long-conversation compaction + history search (F2) ───────────────────

  private async afterTurnMaintenance(ctx: TenantContext, conversationId: string): Promise<void> {
    await this.indexRecentMessagesForSearch(ctx, conversationId).catch((err) => {
      // Embeddings degrade silently to the ILIKE fallback at query time.
      this.logger.debug(
        `Meri message indexing skipped: ${err instanceof Error ? err.message : err}`,
      );
    });
    await this.maybeCompactConversation(ctx, conversationId);
  }

  /**
   * Embed the newest turns into context_embeddings (sourceType
   * 'clio_message') for history search. Hash-skip makes re-runs free; the
   * Bedrock call runs outside any transaction. Encrypted meeting notes never
   * enter this index — only clio_messages bodies are read.
   */
  private async indexRecentMessagesForSearch(
    ctx: TenantContext,
    conversationId: string,
  ): Promise<void> {
    if (!this.config.get('CLIO_MESSAGE_INDEX_ENABLED', { infer: true })) return;
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMessage.findMany({
        where: { conversationId, role: { in: ['user', 'assistant'] } },
        orderBy: { createdAt: 'desc' },
        take: 4,
        select: {
          id: true,
          role: true,
          body: true,
          clientId: true,
          conversation: { select: { title: true } },
        },
      }),
    );
    for (const row of rows) {
      if (!row.body || row.body.length < 10) continue;
      const text = normalizeForEmbedding(
        buildMessageEmbeddingText({
          conversationTitle: row.conversation?.title ?? null,
          role: row.role,
          body: row.body,
        }),
      );
      const hash = embeddingHash(text);
      const existing = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.$queryRawUnsafe<Array<{ content_hash: string }>>(
          `SELECT content_hash FROM context_embeddings
             WHERE tenant_id = $1::uuid AND source_type = 'clio_message'
               AND source_id = $2 AND model = $3
             LIMIT 1`,
          ctx.tenantId,
          row.id,
          EMBEDDING_MODEL,
        ),
      );
      if (existing[0]?.content_hash === hash) continue;
      // Bedrock call outside the transaction (it can take seconds).
      const vector = await embedText(text);
      const literal = vectorLiteral(vector);
      await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO context_embeddings
             (tenant_id, client_id, source_type, source_id, model, content_text, content_hash, embedding)
           VALUES ($1::uuid, $2::uuid, 'clio_message', $3, $4, $5, $6, '${literal}'::vector)
           ON CONFLICT (tenant_id, source_type, source_id, model)
             DO UPDATE SET content_text = EXCLUDED.content_text,
                           content_hash = EXCLUDED.content_hash,
                           embedding    = EXCLUDED.embedding,
                           updated_at   = NOW()`,
          ctx.tenantId,
          row.clientId ?? null,
          row.id,
          EMBEDDING_MODEL,
          text,
          hash,
        ),
      );
    }
  }

  /**
   * Rolling-summary compaction (F2). When the un-summarized text beyond the
   * verbatim tail reaches the trigger budget, fold it into the conversation's
   * running summary with the small intent-tier model and advance the
   * boundary. Incremental: old summary + turns since → new summary.
   */
  private async maybeCompactConversation(
    ctx: TenantContext,
    conversationId: string,
  ): Promise<void> {
    if (!this.config.get('CLIO_COMPACTION_ENABLED', { infer: true })) return;
    const conversation = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.findFirst({
        where: { id: conversationId, tenantId: ctx.tenantId },
        select: { summary: true, summaryUpToMessageId: true },
      }),
    );
    if (!conversation) return;
    const boundary = conversation.summaryUpToMessageId
      ? await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.clioMessage.findFirst({
            where: { id: conversation.summaryUpToMessageId ?? undefined, conversationId },
            select: { createdAt: true },
          }),
        )
      : null;
    const since = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMessage.findMany({
        where: {
          conversationId,
          role: { in: ['user', 'assistant'] },
          ...(boundary ? { createdAt: { gt: boundary.createdAt } } : {}),
        },
        orderBy: { createdAt: 'asc' },
        take: 200,
        select: { id: true, role: true, body: true },
      }),
    );
    const existingSummary = boundary ? conversation.summary : null;
    const plan = planCompaction({
      messages: since,
      existingSummary,
      triggerTokens: this.config.get('CLIO_COMPACTION_TRIGGER_TOKENS', { infer: true }),
      tailMessages: this.config.get('CLIO_COMPACTION_TAIL_MESSAGES', { infer: true }),
    });
    if (!plan.compact || !plan.upToMessageId) return;
    const prompt = buildCompactionPrompt({
      existingSummary,
      turns: plan.toSummarize.map((m) => ({ role: m.role, body: m.body })),
    });
    const raw = await this.completeWithIntentModel(prompt.system, prompt.user, 1200);
    const summary = raw ? sanitizeSummaryOutput(raw) : null;
    if (!summary) return;
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.update({
        where: { id: conversationId },
        data: {
          summary,
          summaryUpToMessageId: plan.upToMessageId,
          summaryTokens: estimateTokens(summary),
        },
      }),
    );
    this.logger.log(
      `Meri compaction [conv ${conversationId}]: folded ${plan.toSummarize.length} messages into the running summary (~${estimateTokens(summary)} tokens)`,
    );
  }

  /** One cheap, non-streaming intent-model completion. Fail-open (null). */
  private async completeWithIntentModel(
    system: string,
    user: string,
    maxTokens = 800,
  ): Promise<string | null> {
    try {
      const anthropicKey = this.config.get('ANTHROPIC_API_KEY', { infer: true });
      if (!anthropicKey) return null;
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.get('CLIO_INTENT_MODEL', { infer: true }),
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
      const text = (json.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      return text || null;
    } catch {
      return null;
    }
  }

  /**
   * History search (F2): pgvector cosine over indexed messages, keyword ILIKE
   * fallback (same degrade pattern as memory recall). Tenant + user scoped;
   * archived conversations excluded.
   */
  async searchConversations(ctx: TenantContext, query: string, limit = 10) {
    const q = (query ?? '').trim();
    if (q.length < 2) return [];
    try {
      const vector = await embedText(normalizeForEmbedding(q));
      const literal = vectorLiteral(vector);
      const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            conversation_id: string;
            message_id: string;
            title: string;
            client_id: string | null;
            body: string;
            created_at: Date;
            score: number;
          }>
        >(
          `SELECT m.conversation_id, m.id AS message_id, c.title, c.client_id, m.body, m.created_at,
                  1 - (ce.embedding <=> '${literal}'::vector) AS score
             FROM context_embeddings ce
             JOIN clio_messages m ON m.id::text = ce.source_id
             JOIN clio_conversations c ON c.id = m.conversation_id
            WHERE ce.source_type = 'clio_message'
              AND ce.tenant_id = $1::uuid
              AND m.tenant_id = $1::uuid
              AND m.user_id = $2::uuid
              AND c.archived_at IS NULL
            ORDER BY ce.embedding <=> '${literal}'::vector
            LIMIT 30`,
          ctx.tenantId,
          ctx.userId,
        ),
      );
      const hits: HistorySearchHit[] = rows
        .filter((r) => Number(r.score) > 0.25)
        .map((r) => ({
          conversationId: r.conversation_id,
          messageId: r.message_id,
          title: r.title,
          clientId: r.client_id,
          body: r.body,
          createdAt: new Date(r.created_at),
          score: Number(r.score),
        }));
      if (hits.length) return groupHitsByConversation(hits, q, limit);
    } catch (err) {
      this.logger.debug(
        `Semantic history search unavailable, falling back to keywords: ${err instanceof Error ? err.message : err}`,
      );
    }
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMessage.findMany({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          role: { in: ['user', 'assistant'] },
          body: { contains: q, mode: 'insensitive' },
          conversation: { archivedAt: null },
        },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: {
          conversationId: true,
          id: true,
          body: true,
          createdAt: true,
          conversation: { select: { title: true, clientId: true } },
        },
      }),
    );
    const hits: HistorySearchHit[] = rows.map((r) => ({
      conversationId: r.conversationId,
      messageId: r.id,
      title: r.conversation.title,
      clientId: r.conversation.clientId,
      body: r.body,
      createdAt: r.createdAt,
      score: null,
    }));
    return groupHitsByConversation(hits, q, limit);
  }

  private async orchestrateContext(
    ctx: TenantContext,
    clientId: string | null,
    intent: string,
    query: string,
  ): Promise<OrchestratorResult> {
    const policy = this.policyForIntent(intent, query);
    const contextParts: string[] = [];
    const sources: MeriSourceAttribution[] = [];
    const trace: OrchestratorTraceStep[] = [];

    // User voice/profile (memory files): standing context so Meri always writes
    // in the caller's voice and knows their role — not just when it calls a tool.
    try {
      const voice = await this.loadUserVoiceContext(ctx, clientId);
      if (voice) {
        contextParts.push(voice);
        trace.push({ tool: 'memory_files', action: 'selected', reason: 'Loaded user voice/profile (and client soul when client-linked).' });
      }
    } catch {
      // best-effort; never block a turn on memory-file context
    }

    if (clientId) {
      trace.push({ tool: 'client_profile', action: 'selected', reason: 'Client-linked conversation has priority context.' });
      // Always-on KB snapshot (F5): profile digest, top people, facility
      // footprint by district, recent documents — built fresh each turn, with
      // a plain profile fallback when the KB is disabled or unavailable.
      let snapshotLoaded = false;
      try {
        const snapshot = await this.clientKb.buildSnapshot(ctx.tenantId, clientId);
        if (snapshot) {
          contextParts.push(snapshot);
          sources.push({
            tool: 'client_kb',
            count: 1,
            summary: 'Client knowledge-base snapshot loaded',
            confidence: 'high',
          });
          trace.push({
            tool: 'client_kb',
            action: 'selected',
            reason: 'Injected KB snapshot (profile, people, facilities, recent docs).',
          });
          snapshotLoaded = true;
        }
      } catch {
        trace.push({
          tool: 'client_kb',
          action: 'skipped',
          reason: 'KB snapshot build failed; falling back to plain profile.',
        });
      }
      if (!snapshotLoaded) {
        try {
          const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
            tx.client.findFirst({
              where: { id: clientId },
              select: { name: true, description: true, productDescription: true },
            }),
          );
          if (client) {
            contextParts.push(`Client: ${client.name}`);
            if (client.description) contextParts.push(`Description: ${client.description}`);
            if (client.productDescription) contextParts.push(`Product/service: ${client.productDescription}`);
            sources.push({
              tool: 'client_profile',
              count: 1,
              summary: `Client profile loaded for ${client.name}`,
              confidence: 'high',
            });
          }
        } catch {
          trace.push({ tool: 'client_profile', action: 'skipped', reason: 'Client profile fetch failed.' });
        }
      }
    } else {
      trace.push({ tool: 'client_profile', action: 'skipped', reason: 'Conversation is not attached to a client.' });
    }

    try {
      const memories = await this.loadRelevantMemories(ctx.tenantId, ctx.userId, query);
      if (memories.length) {
        contextParts.push('\nRelevant firm knowledge (from Meri memory):');
        for (const mem of memories) contextParts.push(`- ${mem.value}`);
        sources.push({
          tool: 'clio_memory',
          count: memories.length,
          summary: `Loaded ${memories.length} memory items`,
          confidence: memories.length >= 3 ? 'high' : 'medium',
        });
        trace.push({ tool: 'clio_memory', action: 'selected', reason: `Loaded ${memories.length} relevant memories.` });
      } else {
        trace.push({ tool: 'clio_memory', action: 'skipped', reason: 'No high-signal memories matched query.' });
      }
    } catch {
      trace.push({ tool: 'clio_memory', action: 'skipped', reason: 'Memory retrieval failed.' });
    }

    const shouldLoadResearch = ['query_clients', 'query_engagement', 'query_workflow', 'generate_draft', 'general_question', 'generate_briefing'].includes(intent);
    if (shouldLoadResearch) {
      trace.push({ tool: 'search_research_sources', action: 'selected', reason: `Intent ${intent} benefits from workspace research context.` });
      try {
        const research = await this.tools.execute(ctx, 'search_research_sources' as never, {
          query,
          clientId: clientId ?? undefined,
          limit: policy.researchLimit,
        });
        const results = Array.isArray((research as { results?: unknown[] }).results)
          ? ((research as { results?: unknown[] }).results ?? [])
          : [];
        if (results.length) {
          contextParts.push('\nCapiro research context:');
          contextParts.push(summarizeJsonForPrompt(results, policy.researchChars));
          sources.push({
            tool: 'search_research_sources',
            count: results.length,
            summary: `Loaded ${results.length} research records`,
            confidence: results.length >= 5 ? 'high' : 'medium',
          });
        } else {
          trace.push({ tool: 'search_research_sources', action: 'skipped', reason: 'No research results returned.' });
        }
      } catch {
        trace.push({ tool: 'search_research_sources', action: 'skipped', reason: 'Research tool request failed.' });
      }
    } else {
      trace.push({ tool: 'search_research_sources', action: 'skipped', reason: `Intent ${intent} does not require research scan.` });
    }

    const shouldLoadIntel = ['query_intelligence', 'generate_briefing', 'general_question'].includes(intent);
    if (shouldLoadIntel) {
      trace.push({ tool: 'query_intelligence', action: 'selected', reason: `Intent ${intent} requests intelligence context.` });
      try {
        const clientName = clientId
          ? await this.prisma.withTenant(ctx.tenantId, (tx) =>
              tx.client.findFirst({ where: { id: clientId }, select: { name: true } }),
            ).then((c) => c?.name ?? undefined)
          : undefined;
        const intelResult = await this.tools.execute(ctx, 'query_intelligence' as never, {
          clientName: clientName ?? undefined,
        });
        const intelData = (intelResult as Record<string, unknown>)?.data;
        if (typeof intelData === 'string' && intelData.length > 10) {
          contextParts.push('\nFederal lobbying intelligence (from Capiro database):');
          contextParts.push(truncateText(intelData, policy.intelChars));
          sources.push({
            tool: 'query_intelligence',
            summary: 'Federal intelligence snapshot loaded',
            confidence: 'high',
          });
        } else {
          trace.push({ tool: 'query_intelligence', action: 'skipped', reason: 'No intelligence text payload returned.' });
        }
      } catch {
        trace.push({ tool: 'query_intelligence', action: 'skipped', reason: 'Intelligence tool request failed.' });
      }
    } else {
      trace.push({ tool: 'query_intelligence', action: 'skipped', reason: `Intent ${intent} does not need intelligence query.` });
    }

    const shouldLoadPublicWeb = ['query_intelligence', 'generate_briefing', 'general_question'].includes(intent);
    if (shouldLoadPublicWeb) {
      trace.push({ tool: 'search_public_web', action: 'selected', reason: `Intent ${intent} may need current public-web corroboration.` });
      try {
        const webResult = await this.tools.execute(ctx, 'search_public_web' as never, {
          query,
          limit: policy.tier === 'deep' ? 6 : 3,
        });
        const webRows = Array.isArray((webResult as { results?: unknown[] }).results)
          ? ((webResult as { results?: unknown[] }).results ?? [])
          : [];
        if (webRows.length) {
          contextParts.push('\nPublic web signals (supplemental to Capiro data):');
          contextParts.push(summarizeJsonForPrompt(webRows, policy.tier === 'deep' ? 2800 : 1400));
          sources.push({
            tool: 'search_public_web',
            count: webRows.length,
            summary: `Loaded ${webRows.length} public web results`,
            confidence: 'low',
          });
        } else {
          trace.push({ tool: 'search_public_web', action: 'skipped', reason: 'No public web results returned.' });
        }
      } catch {
        trace.push({ tool: 'search_public_web', action: 'skipped', reason: 'Public web search failed.' });
      }
    } else {
      trace.push({ tool: 'search_public_web', action: 'skipped', reason: `Intent ${intent} does not require web supplementation.` });
    }

    if (clientId && ['query_clients', 'query_engagement', 'generate_briefing', 'generate_draft'].includes(intent)) {
      trace.push({ tool: 'get_client_context', action: 'selected', reason: `Intent ${intent} needs detailed client context.` });
      try {
        const clientCtx = await this.tools.execute(ctx, 'get_client_context' as never, { clientId });
        const rawCtx = (clientCtx as Record<string, unknown>)?.context;
        if (rawCtx) {
          contextParts.push('\nDetailed client context:');
          contextParts.push(summarizeJsonForPrompt(rawCtx, policy.clientContextChars));
          sources.push({
            tool: 'get_client_context',
            summary: 'Loaded structured client context',
            confidence: 'high',
          });
        } else {
          trace.push({ tool: 'get_client_context', action: 'skipped', reason: 'Client context returned empty payload.' });
        }
      } catch {
        trace.push({ tool: 'get_client_context', action: 'skipped', reason: 'Detailed client context fetch failed.' });
      }
    } else {
      trace.push({ tool: 'get_client_context', action: 'skipped', reason: 'No client-linked deep context required.' });
    }

    const template = this.templateForIntent(intent);
    // Conflict surfacing is the model's job (the system prompt instructs it to
    // state discrepancies between public-web and Capiro data). The old
    // keyword-overlap heuristic produced false positives and caught no real
    // conflicts, so it was removed. Field kept null for forward compatibility.
    const conflict = null;

    return {
      context: truncateText(contextParts.join('\n'), policy.contextCharBudget),
      sources,
      policy,
      trace,
      conflict,
      template,
    };
  }

  private async classifyIntent(message: string): Promise<string> {
    const anthropicKey = this.config.get('ANTHROPIC_API_KEY', { infer: true });
    if (!anthropicKey) return 'general_question';
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.get('CLIO_INTENT_MODEL', { infer: true }),
          max_tokens: 50,
          system:
            'You classify user intent for a lobbying AI. Return only JSON: {"intent":"<intent>"}. ' +
            'Valid: query_intelligence, query_clients, query_engagement, query_workflow, edit_draft, edit_workflow_field, generate_draft, generate_briefing, analyze_bill, prep_hearing, draft_coalition_letter, track_amendment, navigate, general_question. ' +
            'Use analyze_bill for section-by-section bill analysis, prep_hearing for hearing preparation, draft_coalition_letter for sign-on/coalition letters, track_amendment for amendment status/whip questions.',
          messages: [{ role: 'user', content: message }],
        }),
      });
      if (res.ok) {
        const json = await res.json() as Record<string, unknown>;
        const text = Array.isArray(json.content) ? (json.content[0] as Record<string, unknown>)?.text : '';
        if (typeof text === 'string') {
          const match = text.match(/"intent"\s*:\s*"([^"]+)"/);
          if (match?.[1]) return match[1];
        }
      }
    } catch { /* fallback */ }
    return 'general_question';
  }

  /**
   * Grounding/verifier gate (P0-6). A cheap second pass extracts the
   * deliverable's factual claims and marks each supported/unsupported against
   * the retrieved sources. Fail-open: returns null when disabled, unkeyed, or on
   * any error, so verification never blocks the deliverable itself.
   */
  private async verifyDeliverable(
    output: string,
    sources: Array<{ n: number; title: string; snippet: string | null }>,
  ): Promise<VerificationResult | null> {
    if (!this.config.get('CLIO_VERIFIER_ENABLED', { infer: true })) return null;
    const anthropicKey = this.config.get('ANTHROPIC_API_KEY', { infer: true });
    if (!anthropicKey || !output.trim()) return null;
    try {
      const sourceList = sources.length
        ? sources.map((s) => `[${s.n}] ${s.title}${s.snippet ? ` — ${s.snippet}` : ''}`).join('\n')
        : '(no sources were retrieved)';
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.get('CLIO_INTENT_MODEL', { infer: true }),
          max_tokens: 1500,
          system:
            'You are a strict grounding verifier for a government-affairs assistant. Given SOURCES and a DOCUMENT, extract the document\'s distinct factual claims (skip headings, opinions, and generic advice). For each claim decide whether the SOURCES substantiate it. Return ONLY JSON: {"claims":[{"claim":"<short paraphrase>","supported":true|false,"sourceIds":[<source numbers>]}]}. Mark supported=true only when a listed source backs the claim, and list those source numbers. Be conservative: if unsure, use supported=false with sourceIds [].',
          messages: [
            {
              role: 'user',
              content: `SOURCES:\n${sourceList}\n\nDOCUMENT:\n${output.slice(0, 12_000)}`,
            },
          ],
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as Record<string, unknown>;
      const text = Array.isArray(json.content)
        ? (json.content[0] as Record<string, unknown>)?.text
        : '';
      if (typeof text !== 'string') return null;
      const claims = parseVerifierClaims(text);
      if (!claims.length) return null;
      return summarizeVerification(claims);
    } catch {
      return null;
    }
  }

  /**
   * Structural + fan-out enrichment for a deliverable (P0-7..P0-10). Extracts
   * cited PE codes from the deliverable, fetches each PE read-only, and runs the
   * deterministic category validators (RDT&E-vs-procurement, capability/mission
   * mismatch, primary-vehicle overclaim) plus the verify-time fan-out planner.
   * Fail-open: any error yields empty arrays so this never blocks the deliverable.
   * Gated by CLIO_VERIFIER_ENABLED (same flag as the grounding gate).
   */
  private async enrichDeliverableStructural(
    ctx: TenantContext,
    deliverableText: string,
  ): Promise<{
    warnings: ReturnType<typeof collectPeStructuralWarnings>;
    fanOut: ReturnType<typeof planFanOutQueries>;
  }> {
    const empty = { warnings: [], fanOut: [] };
    try {
      if (!this.config.get('CLIO_VERIFIER_ENABLED', { infer: true })) return empty;
      const codes = extractCitedPeCodes(deliverableText).slice(0, 6);
      if (!codes.length) return empty;

      const pes = await Promise.all(
        codes.map(async (peCode) => {
          try {
            const res = (await this.tools.execute(ctx, 'get_program_element' as never, {
              peCode,
            })) as { programElement?: Record<string, unknown> } | null;
            const pe = res?.programElement;
            if (!pe || typeof pe !== 'object') return null;
            return {
              peCode: String((pe as { peCode?: unknown }).peCode ?? peCode),
              title: (pe as { title?: string | null }).title ?? null,
              service: (pe as { service?: string | null }).service ?? null,
              appropriationType:
                (pe as { appropriationType?: string | null }).appropriationType ?? null,
              budgetActivity: (pe as { budgetActivity?: string | null }).budgetActivity ?? null,
              budgetActivityName:
                (pe as { budgetActivityName?: string | null }).budgetActivityName ?? null,
            };
          } catch {
            return null;
          }
        }),
      );
      const resolved = pes.filter((p): p is NonNullable<typeof p> => p != null);

      const warnings = collectPeStructuralWarnings(resolved, deliverableText);
      const fanOut = planFanOutQueries(
        resolved.map((p) => ({ peCode: p.peCode, title: p.title })),
        deliverableText,
      );
      return { warnings, fanOut };
    } catch (e) {
      this.logger.warn(`enrichDeliverableStructural failed: ${(e as Error).message}`);
      return empty;
    }
  }

  /**
   * Split the Meri system prompt into a static `base` (identical on every turn,
   * so it can be cached) and a per-turn `dynamic` tail (intent guidance + output
   * template + pre-loaded context snapshot, which varies and must NOT be cached).
   * The base text is unchanged from the previous single-string prompt so model
   * behavior is unaffected; only the delivery is split for prompt caching (P0-1).
   */
  private composeSystemParts(
    intent: string,
    context: string,
    template: { heading: string; sections: string[] } | null,
    conversationSummary: string | null = null,
    firmSkill: MeriSkill | null = null,
  ): { base: string; dynamic: string } {
    const base = [
      'You are Meri, an elite AI chief of staff designed exclusively for government affairs professionals.',
      'Your purpose is to maximize a lobbyist\'s efficiency, preparation, and strategic leverage.',
      '',
      meriCapabilityBlock(),
      '',
      'Tone and style requirements:',
      '- Ultra-concise, analytical, objective, authoritative.',
      '- You may be witty only in direct user chat responses.',
      '- Never use witty language in formal drafted content (briefings, memos, emails, reports).',
      '- Never use emoji or emoticons in any response.',
      '- Never use fluff, filler, or moral judgment.',
      '- Strip away idealism and focus on political reality and execution risk.',
      '',
      'Reasoning/output requirements:',
      '- Structure outputs for rapid scanning before high-stakes meetings.',
      '- When analyzing legislation, immediately include:',
      '  1) direct impact,',
      '  2) key stakeholders,',
      '  3) likely opposition,',
      '  4) leverage points / recommended moves.',
      '',
      'Data-source hierarchy (critical):',
      '- Treat Capiro internal sources as primary truth for client/engagement/intelligence questions.',
      '- Public-web results are supplemental only and may be incomplete or noisy.',
      '- If public web conflicts with Capiro internal data, state the discrepancy and prioritize Capiro data unless user asks otherwise.',
      '',
      'You have a set of tools to retrieve authoritative Capiro and federal data on demand: client context, workspace research, federal lobbying intelligence, congressional bills, LDA filings, SEC/FARA filings, federal grants, federal contract awards (USAspending, including Program Element/PE codes), DoD Program Elements (RDT&E/procurement budget lines with fiscal-year request/markup/enacted amounts, milestones, linked contractors, and bills), GAO/CRS reports, state bills, committee hearings, policy news, economic data, public-web search/scrape, and actions (create_meeting_brief, draft_policy_memo, save_note, send_email, list_emails, reply_email).',
      'USE THESE TOOLS rather than guessing. When a question concerns specific bills, filings, spending, contract awards, defense budget/Program Elements, clients, meetings, or emails, call the relevant tool and ground your answer in the result. Prefer Capiro internal tools first; use public-web tools only to corroborate.',
      'Any context pre-loaded below is a convenience snapshot, not a substitute for calling a tool when you need current or specific data.',
      'Do not fabricate facts. If uncertain, state uncertainty and propose the fastest verification path.',
      'Citations: when you state a fact drawn from a retrieved source, cite it inline with the bracketed number shown for that source in the tool results (e.g. [1], [2]). Only cite numbers that appear in the provided sources; never invent citation numbers.',
      '',
      'Defense budget structure (apply rigorously when drafting or fact-checking PE/budget/legislative claims):',
      DOMAIN_PRIMER,
      'Memory: you have persistent, cross-conversation memory for this firm and user. Relevant remembered facts are injected into the context below when available. When the user shares a durable preference, name, or ongoing priority — or explicitly asks you to remember something — call the save_memory tool to persist it, then briefly confirm. Never claim you lack memory or cannot retain information across sessions.',
      'Conversation continuity (critical): the full prior turns of THIS conversation are provided to you as message history. Treat the conversation as one continuous thread — read the earlier turns and carry their context forward. When the user says "it", "that", "those", "the firm", "add them", "the same client", or otherwise refers back, resolve the reference from earlier in this conversation; do NOT re-ask for something already established or act as if the thread just started. If you genuinely cannot find the referent in the history, say so and ask — but check the prior turns first. The per-turn context snapshot below supplements the conversation; it never replaces what the user already told you.',
      COMPLIANCE_GUARDRAILS,
    ].join('\n');

    const intentGuidance: Record<string, string> = {
      query_intelligence: 'The user is asking about federal lobbying intelligence. You have real data from the Capiro database, bills, LDA filings, spending, and trends. Synthesize this data with clear takeaways. List specific bill numbers, sponsors, and policy areas.',
      query_clients: 'The user is asking about their clients. Use available client data.',
      query_engagement: 'The user is asking about meetings or outreach. Reference engagement records.',
      query_workflow: 'The user is asking about workflows or submissions. Check workflow data.',
      generate_draft: 'Generate a professional government affairs email with proper tone and structure.',
      generate_briefing: 'Create an actionable briefing with key points, risks, and recommendations. Use intelligence data when relevant.',
      general_question: 'Answer helpfully about lobbying, government affairs, or the Capiro platform.',
    };

    // Skill registry (P0-5) is the source of truth for migrated intents; fall
    // back to the legacy inline guidance for the rest. The migrated skills are
    // byte-identical to these entries (skill-registry.spec.ts), so this never
    // changes output regardless of the CLIO_SKILLS_ENABLED toggle. A matched
    // firm skill (F6b) takes precedence — built-ins already won any trigger
    // conflict in the safe merge upstream.
    const skill = firmSkill ?? (this.skillsEnabled() ? matchSkill(intent) : null);
    const guidance = skill?.systemAddendum ?? intentGuidance[intent];

    const tail: string[] = [];
    if (guidance) tail.push(guidance);
    if (template) {
      tail.push(`Output template: ${template.heading}`);
      tail.push(`Required sections: ${template.sections.join(' | ')}`);
    }
    // Compaction summary (F2) sits in the dynamic tail — never the cached
    // base — so the prompt-cache split (P0-1) is preserved.
    if (conversationSummary) tail.push(formatSummaryBlockForPrompt(conversationSummary));
    if (context) tail.push(`Context:\n${context}`);
    return { base, dynamic: tail.join('\n\n') };
  }

  /**
   * Assemble the Anthropic `system` field as content blocks, placing the prompt
   * cache breakpoint on the static base (see meri-prompt.helpers).
   */
  private buildSystemBlocks(
    intent: string,
    context: string,
    template: { heading: string; sections: string[] } | null,
    cacheEnabled: boolean,
    conversationSummary: string | null = null,
    firmSkill: MeriSkill | null = null,
  ): SystemTextBlock[] {
    const { base, dynamic } = this.composeSystemParts(
      intent,
      context,
      template,
      conversationSummary,
      firmSkill,
    );
    return buildMeriSystemBlocks({ base, dynamic, cacheEnabled });
  }

  private extractStreamControl(rawBody: string): StreamControl {
    let cleanContent = rawBody;

    const tracePattern = /\s*#trace\s*$/i;
    const traceEnabled = tracePattern.test(cleanContent);
    if (traceEnabled) cleanContent = cleanContent.replace(tracePattern, '').trimEnd();

    const pageWritePattern = /^\s*write on this page:\s*/i;
    const pageWriteEnabled = pageWritePattern.test(cleanContent);
    if (pageWriteEnabled) cleanContent = cleanContent.replace(pageWritePattern, '').trimStart();

    return { traceEnabled, cleanContent, pageWriteEnabled };
  }

  private policyForIntent(intent: string, query: string): OrchestratorPolicy {
    const deepIntent = ['generate_briefing', 'query_intelligence', 'generate_draft'].includes(intent);
    const longQuery = query.length > 220;
    const tier: RetrievalTier = deepIntent || longQuery ? 'deep' : 'fast';
    if (tier === 'deep') {
      return {
        tier,
        contextCharBudget: 19_000,
        researchLimit: 18,
        researchChars: 8_500,
        intelChars: 8_500,
        clientContextChars: 7_500,
      };
    }
    return {
      tier,
      contextCharBudget: 9_500,
      researchLimit: 8,
      researchChars: 3_800,
      intelChars: 3_800,
      clientContextChars: 3_500,
    };
  }

  /** Whether the filesystem-driven skill registry (P0-5) is active. */
  private skillsEnabled(): boolean {
    return this.config.get('CLIO_SKILLS_ENABLED', { infer: true });
  }

  private suggestionsEnabled(): boolean {
    return this.config.get('CLIO_SUGGESTIONS_ENABLED', { infer: true });
  }

  /**
   * Cheap follow-up suggestion pass (P2-4): asks the intent model for 2-3 likely
   * next prompts. Fail-open — returns [] on any error so it never blocks a turn.
   */
  private async generateSuggestions(userMessage: string, answer: string): Promise<string[]> {
    try {
      const anthropicKey = this.config.get('ANTHROPIC_API_KEY', { infer: true });
      if (!anthropicKey) return [];
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.get('CLIO_INTENT_MODEL', { infer: true }),
          max_tokens: 200,
          system:
            "You propose the user's likely next prompts for a U.S. federal government-affairs assistant. " +
            'Output ONLY a JSON array of 2-3 short, specific follow-ups (max ~10 words each), phrased as the user would type them. No prose.',
          messages: [
            {
              role: 'user',
              content: `User asked:\n${userMessage}\n\nAssistant answered:\n${answer.slice(0, 4000)}\n\nReturn a JSON array of 2-3 next prompts.`,
            },
          ],
        }),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      const text = (data.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n');
      return parseSuggestions(text);
    } catch (err) {
      this.logger.warn(`Meri suggestion generation failed: ${(err as Error).message}`);
      return [];
    }
  }

  private templateForIntent(intent: string): { heading: string; sections: string[] } | null {
    // Prefer the skill registry's template for migrated intents (P0-5).
    if (this.skillsEnabled()) {
      const skill = matchSkill(intent);
      if (skill) return skill.template;
    }
    if (intent === 'generate_briefing') {
      return {
        heading: 'Government Affairs Briefing',
        sections: ['Executive Summary', 'Signal Scan', 'Opportunities', 'Risks', 'Recommended Actions'],
      };
    }
    if (intent === 'generate_draft') {
      return {
        heading: 'Outreach Draft',
        sections: ['Subject Line', 'Opening', 'Core Message', 'Ask / CTA', 'Close'],
      };
    }
    return null;
  }

  private shouldAttemptMemoryLearning(userMessage: string, assistantResponse: string): boolean {
    if (assistantResponse.length < 220) return false;
    const combined = `${userMessage}\n${assistantResponse}`.toLowerCase();
    const noiseMarkers = [
      'error',
      'traceback',
      'http',
      'status code',
      'build failed',
      'typecheck',
      'temporary',
      'for now',
      'todo',
      'next step',
    ];
    if (noiseMarkers.some((marker) => combined.includes(marker))) return false;
    return true;
  }

  private normalizeMemoryCandidate(key: string, value: string): { key: string; value: string } | null {
    const normalizedKey = key.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 200);
    const normalizedValue = value.trim().replace(/\s+/g, ' ').slice(0, 4000);
    if (!normalizedKey || !normalizedValue) return null;

    const volatilePatterns = [
      /\b(today|tomorrow|yesterday|next week|this week)\b/i,
      /\b\d{1,2}:\d{2}\b/,
      /\b(issue|ticket|task)\s*#?\d+/i,
      /\b(temp|temporary|draft only)\b/i,
    ];
    if (volatilePatterns.some((pattern) => pattern.test(normalizedValue))) return null;

    return { key: normalizedKey, value: normalizedValue };
  }

  private classifyMemoryType(key: string, value: string): 'firm' | 'user_private' {
    const combined = `${key} ${value}`.toLowerCase();
    const styleSignals = [
      'writing style',
      'tone',
      'voice',
      'format preference',
      'verbosity',
      'concise',
      'detailed',
      'prefers',
      'communication style',
      'how they write',
    ];
    return styleSignals.some((signal) => combined.includes(signal)) ? 'user_private' : 'firm';
  }

  private userScopedMemoryKey(userId: string, key: string): string {
    return `user:${userId}:${key}`;
  }

  // ── Memory: learn from conversations ──

  /**
   * Load the caller's voice/profile memory files (and the client's soul when the
   * conversation is client-linked) as a compact standing-context block. This is
   * what makes Meri write in the user's voice and respect the client's strategic
   * read on every turn — not only when it opts to call search_memory.
   * RLS-scoped to the caller (own user files + tenant-visible client files).
   */
  private async loadUserVoiceContext(
    ctx: TenantContext,
    clientId: string | null,
  ): Promise<string | null> {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRaw<Array<{ type: string; title: string; sections: unknown }>>`
        SELECT type, title, sections_jsonb AS sections
        FROM memory_items
        WHERE type IN ('user-voice', 'user-profile')
          AND owner_user_id = ${ctx.userId}::uuid
      `,
    );
    // Client soul/compass (tenant-visible) when this is a client conversation.
    const clientRows = clientId
      ? await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.$queryRaw<Array<{ type: string; title: string; sections: unknown }>>`
            SELECT type, title, sections_jsonb AS sections
            FROM memory_items
            WHERE type IN ('client-soul', 'client-compass')
              AND client_id = ${clientId}::uuid
          `,
        )
      : [];

    const blocks: string[] = [];
    const render = (title: string, sections: unknown): string | null => {
      if (!Array.isArray(sections)) return null;
      const body = sections
        .filter((s) => s && typeof s === 'object' && (s as { owner?: string }).owner === 'human')
        .map((s) => {
          const sec = s as { heading?: string; body?: string };
          return sec.body?.trim() ? `${sec.heading}: ${sec.body.trim()}` : '';
        })
        .filter(Boolean)
        .join('\n');
      return body ? `${title}\n${body}` : null;
    };

    for (const r of rows) {
      const label = r.type === 'user-voice'
        ? "The user's writing style — draft in THIS voice; mirror the sample writings closely without inventing content"
        : "About the user (their role and focus)";
      const block = render(label, r.sections);
      if (block) blocks.push(block);
    }
    for (const r of clientRows) {
      const block = render(`Client memory (${r.title})`, r.sections);
      if (block) blocks.push(block);
    }
    if (!blocks.length) return null;
    return `User & client memory files (authoritative for voice and strategy):\n\n${blocks.join('\n\n')}`;
  }

  private async loadRelevantMemories(
    tenantId: string,
    userId: string,
    query: string,
  ): Promise<Array<{ key: string; value: string }>> {
    try {
      const semantic = await this.semanticMemorySearch(tenantId, userId, query, 8);
      if (semantic.length > 0) {
        return semantic.map(({ key, value }) => ({ key, value }));
      }
    } catch {
      // fall through to keyword strategy
    }

    try {
      const memories = await this.prisma.withTenant(tenantId, (tx) =>
        tx.clioMemory.findMany({
          where: {
            tenantId,
            OR: [
              { scope: 'firm' },
              { scope: 'user_private', ownerUserId: userId },
            ],
          },
          orderBy: { updatedAt: 'desc' },
          take: 20,
          select: { key: true, value: true },
        }),
      );
      // Keyword-rank with a recency fallback so a stored memory is never
      // silently invisible when embeddings are unavailable (W2 M1).
      return rankMemoriesByKeyword(memories, query, 8).map(({ key, value }) => ({ key, value }));
    } catch {
      return [];
    }
  }

  private async maybeLearnFromConversation(
    tenantId: string,
    userId: string,
    conversationId: string,
    userMessage: string,
    assistantResponse: string,
  ): Promise<void> {
    if (!this.shouldAttemptMemoryLearning(userMessage, assistantResponse)) return;

    const anthropicKey = this.config.get('ANTHROPIC_API_KEY', { infer: true });
    if (!anthropicKey) return;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.get('CLIO_INTENT_MODEL', { infer: true }),
          max_tokens: 600,
          system:
            'Extract 0-3 durable facts from this conversation exchange. For each, return a confidence in [0,1] (how certain this is a stable, reusable fact and not a one-off), and a scope: "firm" only for institutional facts that are TRUE FOR THE WHOLE FIRM and clearly stated by the user (clients, processes, standing relationships); "user" for the speaker\'s personal writing/tone/format preferences or anything client-specific or uncertain. When in doubt use "user". Ignore temporary statuses, one-off tasks, runtime errors, specific timestamps, speculation, and operational chatter. Return JSON: {"memories":[{"key":"short_label","value":"fact","confidence":0.0,"scope":"user|firm"}]}. Return {"memories":[]} if nothing is durable.',
          messages: [{ role: 'user', content: `User: ${userMessage}\n\nAssistant: ${assistantResponse}` }],
        }),
      });

      if (!res.ok) return;
      const json = (await res.json()) as Record<string, unknown>;
      const text = Array.isArray(json.content) ? (json.content[0] as Record<string, unknown>)?.text : '';
      if (typeof text !== 'string') return;

      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return;
      const parsed = JSON.parse(match[0]) as { memories?: Array<{ key?: unknown; value?: unknown; confidence?: unknown; scope?: unknown }> };
      if (!Array.isArray(parsed.memories)) return;

      // Confidence threshold below which we never persist a learned fact.
      const MIN_CONFIDENCE = 0.7;
      // Cosine similarity above which a candidate is treated as a duplicate of
      // an existing memory (update in place instead of inserting a near-clone).
      const DEDUPE_SIMILARITY = 0.92;

      for (const mem of parsed.memories) {
        if (typeof mem.key !== 'string' || typeof mem.value !== 'string') continue;
        const normalized = this.normalizeMemoryCandidate(mem.key, mem.value);
        if (!normalized) continue;

        // (1) Confidence gate — drop low-confidence extractions entirely.
        const confidence = typeof mem.confidence === 'number' ? mem.confidence : 0;
        if (confidence < MIN_CONFIDENCE) continue;

        // (2) Default to user-private. Promote to firm scope ONLY when the
        // extractor explicitly says "firm", confidence is high, and the heuristic
        // classifier does not flag it as a personal style preference. This stops
        // a single chat's guess from silently becoming firm-wide truth.
        const extractorScope = mem.scope === 'firm' ? 'firm' : 'user';
        const styleType = this.classifyMemoryType(normalized.key, normalized.value); // 'firm' | 'user_private'
        const promoteToFirm = extractorScope === 'firm' && confidence >= 0.85 && styleType === 'firm';
        const scope: 'firm' | 'user_private' = promoteToFirm ? 'firm' : 'user_private';
        const ownerUserId = scope === 'user_private' ? userId : null;
        const storedKey = scope === 'user_private' ? this.userScopedMemoryKey(userId, normalized.key) : normalized.key;
        const source = scope === 'user_private' ? 'user_style' : 'firm';
        const memoryMetadata = {
          conversationId,
          updatedBy: 'auto',
          userId,
          visibility: scope,
          confidence,
        };

        // (3) Semantic dedupe — if a near-identical memory already exists in the
        // same scope, update it rather than inserting a near-clone.
        let dedupeTargetKey: string | null = null;
        try {
          const similar = await this.semanticMemorySearch(tenantId, userId, normalized.value, 3);
          const hit = similar.find((s) => s.score >= DEDUPE_SIMILARITY);
          if (hit) dedupeTargetKey = hit.key;
        } catch { /* dedupe is best-effort */ }

        const existing = await this.prisma.withTenant(tenantId, (tx) =>
          tx.clioMemory.findFirst({
            where: {
              tenantId,
              scope,
              ownerUserId,
              key: dedupeTargetKey ?? storedKey,
            },
          }),
        );

        if (existing) {
          await this.prisma.withTenant(tenantId, (tx) =>
            tx.clioMemory.update({
              where: { id: existing.id },
              data: {
                value: normalized.value,
                source,
                metadata: memoryMetadata,
              },
            }),
          );
        } else {
          await this.prisma.withTenant(tenantId, (tx) =>
            tx.clioMemory.create({
              data: {
                tenantId,
                scope,
                ownerUserId,
                key: storedKey,
                value: normalized.value,
                source,
                metadata: { ...memoryMetadata, createdBy: 'auto' },
              },
            }),
          );
        }

        void this.embedAndStoreMemory(tenantId, storedKey, normalized.value).catch(() => {});
      }
    } catch (err) {
      this.logger.debug(`Memory extraction failed: ${(err as Error).message}`);
    }
  }

  // ── Proactive Alerts ──────────────────────────────────────────────────

  async listAlerts(ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioProactiveAlert.findMany({
        where: { tenantId: ctx.tenantId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          alertType: true,
          title: true,
          body: true,
          priority: true,
          status: true,
          clientId: true,
          createdAt: true,
        },
      }),
    );
  }

  async dismissAlert(ctx: TenantContext, alertId: string) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioProactiveAlert.updateMany({
        where: { id: alertId, tenantId: ctx.tenantId },
        data: { status: 'read', readAt: new Date() },
      }),
    );
  }

  // ── Artifact Versioning ───────────────────────────────────────────────

  async createArtifactVersion(ctx: TenantContext, parentId: string, bodyText: string) {
    const parent = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.findFirst({
        where: { id: parentId, tenantId: ctx.tenantId },
      }),
    );
    if (!parent) throw new NotFoundException('Artifact not found');

    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: parent.clientId,
          conversationId: parent.conversationId,
          parentArtifactId: parent.id,
          title: parent.title,
          kind: parent.kind,
          contentType: parent.contentType,
          bodyText,
          metadata: { versionOf: parent.id, editedBy: ctx.userId },
        },
      }),
    );
  }

  // ── Message feedback (P1-2) ───────────────────────────────────────────

  /**
   * Record thumbs up/down (+ optional note) on an assistant message, stored in
   * clio_message.metadata.feedback. Tenant-scoped; passing a non-up/down rating
   * clears the feedback.
   */
  async recordMessageFeedback(
    ctx: TenantContext,
    messageId: string,
    input: { rating?: unknown; note?: unknown },
  ): Promise<NormalizedFeedback> {
    const feedback = normalizeFeedback(input);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const msg = await tx.clioMessage.findFirst({
        where: { id: messageId, tenantId: ctx.tenantId },
      });
      if (!msg) throw new NotFoundException('Message not found');
      const metadata =
        msg.metadata && typeof msg.metadata === 'object' && !Array.isArray(msg.metadata)
          ? (msg.metadata as Record<string, unknown>)
          : {};
      await tx.clioMessage.update({
        where: { id: messageId },
        data: {
          metadata: {
            ...metadata,
            feedback: { ...feedback, userId: ctx.userId, at: new Date().toISOString() },
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return feedback;
    });
  }

  /**
   * Ingest an uploaded attachment for chat use (P2-7 + assistant-parity F1).
   *
   * Validates (size cap, type allowlist, magic-byte sniff — a `.pdf` that is
   * actually HTML is rejected), extracts text for documents (pdf via unpdf,
   * docx via mammoth, plain text verbatim) with page/char caps and an explicit
   * truncation marker, detects scanned PDFs, and stores the result as a
   * tenant-scoped ClioAttachment row the stream request references by id.
   * Image bytes are stored raw so vision blocks can be rebuilt on regenerate.
   *
   * Extraction happens here — on the upload request, off the chat streaming
   * path — and the pdf page loop awaits between pages so the event loop is
   * never blocked for the whole document.
   *
   * Unusable files (unsupported / scanned / spoofed) return an explicit
   * user-visible status + reason instead of an opaque 4xx, and are not stored.
   */
  async uploadAttachment(
    ctx: TenantContext,
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  ): Promise<{
    id: string | null;
    filename: string;
    kind: string;
    status: AttachmentStatus;
    pages: number | null;
    truncated: boolean;
    reason: string | null;
    chars: number;
  }> {
    const filename = file.originalname || 'untitled';
    const reject = (kind: string, reason: string) => ({
      id: null,
      filename,
      kind,
      status: 'unsupported' as AttachmentStatus,
      pages: null,
      truncated: false,
      reason,
      chars: 0,
    });

    const validation = validateAttachment({
      contentType: file.mimetype,
      byteSize: file.buffer.length,
      filename,
    });
    if (!validation.ok) {
      return reject(validation.kind, validation.reason ?? 'Invalid attachment');
    }
    const magic = verifyMagicBytes(validation.kind, new Uint8Array(file.buffer.subarray(0, 256)));
    if (!magic.ok) {
      return reject(validation.kind, magic.reason ?? 'File contents do not match its type');
    }

    // Opportunistic sweep: unconsumed uploads older than 24h are dead weight.
    await this.prisma
      .withTenant(ctx.tenantId, (tx) =>
        tx.clioAttachment.deleteMany({
          where: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            messageId: null,
            createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        }),
      )
      .catch(() => {});

    if (validation.kind === 'image') {
      if (file.buffer.length > MAX_IMAGE_BYTES) {
        return reject(
          'image',
          `Images must be at most ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB for vision input`,
        );
      }
      const mediaType = imageMediaTypeFromSniff(magic.sniffed);
      const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioAttachment.create({
          data: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            filename,
            kind: 'image',
            status: 'image_ready',
            mediaType,
            byteSize: file.buffer.length,
            data: file.buffer,
          },
          select: { id: true },
        }),
      );
      return {
        id: row.id,
        filename,
        kind: 'image',
        status: 'image_ready',
        pages: null,
        truncated: false,
        reason: null,
        chars: 0,
      };
    }

    let raw = '';
    let pages: number | null = null;
    try {
      if (validation.kind === 'text') {
        raw = file.buffer.toString('utf8');
      } else if (validation.kind === 'docx') {
        raw = (await mammoth.extractRawText({ buffer: file.buffer })).value;
      } else if (validation.kind === 'pdf') {
        const extracted = await extractPdfText(file.buffer);
        raw = extracted.text;
        pages = extracted.pages;
      }
    } catch (err) {
      this.logger.warn(
        `Attachment extraction failed [${validation.kind}] ${filename}: ${err instanceof Error ? err.message : err}`,
      );
      return reject(
        validation.kind,
        `Could not read this ${validation.kind === 'pdf' ? 'PDF' : 'document'} — it may be corrupted, encrypted, or password-protected.`,
      );
    }

    const resolved = resolveDocumentStatus(validation.kind, raw);
    if (resolved.status === 'scanned' || resolved.status === 'unsupported') {
      return {
        id: null,
        filename,
        kind: validation.kind,
        status: resolved.status,
        pages,
        truncated: false,
        reason: resolved.reason,
        chars: 0,
      };
    }
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioAttachment.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          filename,
          kind: validation.kind,
          status: resolved.status,
          mediaType: file.mimetype || null,
          byteSize: file.buffer.length,
          pages,
          textContent: resolved.text,
          reason: resolved.reason,
        },
        select: { id: true },
      }),
    );
    return {
      id: row.id,
      filename,
      kind: validation.kind,
      status: resolved.status,
      pages,
      truncated: resolved.truncated,
      reason: resolved.reason,
      chars: resolved.text?.length ?? 0,
    };
  }


  // ── Proactive Alert Generation ────────────────────────────────────────
  // INTENTIONALLY NOT called on the chat hot path (it previously ran a full
  // tenant-wide scan after every message). The scheduled job
  // scripts/emit-clio-alerts.ts runs this same logic across all active tenants
  // every 30-60 min. This method is retained for in-process/single-tenant use
  // (e.g. an admin "refresh alerts now" action). The dashboard intel inbox is
  // the alert surface; GET /clio/alerts reads the rows produced here.

  async generateProactiveAlerts(tenantId: string): Promise<number> {
    let created = 0;
    try {
      // 1. Upcoming meetings without prep (next 48 hours)
      const tomorrow = new Date(Date.now() + 48 * 60 * 60 * 1000);
      const upcomingMeetings = await this.prisma.withSystem((tx) =>
        tx.meeting.findMany({
          where: {
            tenantId,
            startsAt: { gte: new Date(), lte: tomorrow },
            preps: { none: {} },
          },
          select: { id: true, subject: true, startsAt: true, clientId: true, client: { select: { name: true } } },
          take: 5,
        }),
      );

      for (const meeting of upcomingMeetings) {
        const exists = await this.prisma.withSystem((tx) =>
          tx.clioProactiveAlert.findFirst({
            where: { tenantId, sourceType: 'meeting_prep', sourceId: meeting.id, status: 'pending' },
          }),
        );
        if (!exists) {
          await this.prisma.withSystem((tx) =>
            tx.clioProactiveAlert.create({
              data: {
                tenantId,
                clientId: meeting.clientId,
                alertType: 'meeting_prep_needed',
                title: `Meeting prep needed: ${meeting.subject}`,
                body: `Your meeting "${meeting.subject}"${meeting.client?.name ? ` with ${meeting.client.name}` : ''} is in less than 48 hours and has no prep notes. Ask Meri to create a meeting brief.`,
                priority: 'high',
                sourceType: 'meeting_prep',
                sourceId: meeting.id,
                metadata: { meetingId: meeting.id, startsAt: meeting.startsAt.toISOString() },
              },
            }),
          );
          created++;
        }
      }

      // 2. Clients with no recent engagement (30+ days)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const staleClients = await this.prisma.withSystem((tx) =>
        tx.client.findMany({
          where: {
            tenantId,
            status: 'active',
            meetings: { none: { startsAt: { gte: thirtyDaysAgo } } },
          },
          select: { id: true, name: true },
          take: 5,
        }),
      );

      for (const client of staleClients) {
        const exists = await this.prisma.withSystem((tx) =>
          tx.clioProactiveAlert.findFirst({
            where: { tenantId, sourceType: 'stale_client', sourceId: client.id, status: 'pending' },
          }),
        );
        if (!exists) {
          await this.prisma.withSystem((tx) =>
            tx.clioProactiveAlert.create({
              data: {
                tenantId,
                clientId: client.id,
                alertType: 'client_activity',
                title: `No recent activity: ${client.name}`,
                body: `${client.name} hasn't had a meeting or engagement in over 30 days. Consider scheduling a check-in.`,
                priority: 'normal',
                sourceType: 'stale_client',
                sourceId: client.id,
                metadata: {},
              },
            }),
          );
          created++;
        }
      }
    } catch (err) {
      this.logger.warn(`Alert generation failed: ${(err as Error).message}`);
    }
    return created;
  }

  // ── Embedding-based memory search (Phase 4 semantic) ──────────────────

  async embedAndStoreMemory(tenantId: string, key: string, value: string): Promise<void> {
    const anthropicKey = this.config.get('ANTHROPIC_API_KEY', { infer: true });
    // Use OpenAI for embeddings (1536-dim text-embedding-3-small)
    const openaiKey = this.config.get('OPENAI_API_KEY', { infer: true });
    if (!openaiKey) return;

    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: `${key}: ${value}` }),
      });
      if (!res.ok) return;
      const json = await res.json() as { data?: Array<{ embedding?: number[] }> };
      const embedding = json.data?.[0]?.embedding;
      if (!embedding || embedding.length !== 1536) return;

      const vecStr = `[${embedding.join(',')}]`;
      await this.prisma.$executeRawUnsafe(
        `UPDATE clio_memory SET embedding = $1::vector WHERE tenant_id = $2::uuid AND key = $3`,
        vecStr, tenantId, key,
      );
    } catch (err) {
      this.logger.debug(`Embedding failed for memory ${key}: ${(err as Error).message}`);
    }
  }

  async semanticMemorySearch(
    tenantId: string,
    userId: string,
    query: string,
    limit = 5,
  ): Promise<Array<{ key: string; value: string; score: number }>> {
    const openaiKey = this.config.get('OPENAI_API_KEY', { infer: true });
    if (!openaiKey) return [];

    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: query }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const embedding = json.data?.[0]?.embedding;
      if (!embedding || embedding.length !== 1536) return [];

      const vecStr = `[${embedding.join(',')}]`;
      const results = await this.prisma.$queryRawUnsafe<Array<{ key: string; value: string; score: number }>>(
        `SELECT key, value, 1 - (embedding <=> $1::vector) as score
         FROM clio_memory
         WHERE tenant_id = $2::uuid
           AND embedding IS NOT NULL
           AND (
             scope = 'firm'
             OR (scope = 'user_private' AND owner_user_id = $3::uuid)
           )
         ORDER BY embedding <=> $1::vector
         LIMIT $4`,
        vecStr,
        tenantId,
        userId,
        limit,
      );
      return results.filter((r) => r.score > 0.3);
    } catch (err) {
      this.logger.debug(`Semantic search failed: ${(err as Error).message}`);
      return [];
    }
  }

  // ── Learned-memory surface (item 5/E: "Meri learned X" + one-click undo) ──

  /**
   * Recently auto-learned memories visible to this user (firm-scope + this
   * user's private). Used by the drawer to show "Meri learned: …" chips with an
   * undo affordance. Only auto-created entries are surfaced (createdBy === 'auto').
   */
  async listRecentLearnedMemories(ctx: TenantContext, limit = 5) {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMemory.findMany({
        where: {
          tenantId: ctx.tenantId,
          OR: [
            { scope: 'firm' },
            { scope: 'user_private', ownerUserId: ctx.userId },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: Math.min(Math.max(limit, 1), 20),
        select: { id: true, key: true, value: true, scope: true, metadata: true, updatedAt: true },
      }),
    );
    return rows
      .filter((row) => {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        return meta.createdBy === 'auto' || meta.updatedBy === 'auto';
      })
      .map((row) => {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        return {
          id: row.id,
          key: row.key,
          value: row.value,
          scope: row.scope,
          confidence: typeof meta.confidence === 'number' ? meta.confidence : null,
          learnedAt: row.updatedAt,
        };
      });
  }

  /**
   * Undo a learned memory. Deletes the row in a scope the user is allowed to
   * touch (own private memory, or firm memory within the tenant). Idempotent.
   */
  async forgetMemory(ctx: TenantContext, memoryId: string) {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMemory.findFirst({
        where: { id: memoryId, tenantId: ctx.tenantId },
        select: { id: true, scope: true, ownerUserId: true },
      }),
    );
    if (!row) throw new NotFoundException('Memory not found');
    if (row.scope === 'user_private' && row.ownerUserId !== ctx.userId) {
      throw new NotFoundException('Memory not found');
    }
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMemory.deleteMany({ where: { id: memoryId, tenantId: ctx.tenantId } }),
    );
    return { ok: true, id: memoryId };
  }

  /**
   * All memories visible to this user (firm-scope + this user's private), for the
   * inspect/edit panel (P2-6). Not limited to auto-created entries.
   */
  async listMemories(ctx: TenantContext, limit = 100) {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMemory.findMany({
        where: {
          tenantId: ctx.tenantId,
          OR: [{ scope: 'firm' }, { scope: 'user_private', ownerUserId: ctx.userId }],
        },
        orderBy: { updatedAt: 'desc' },
        take: Math.min(Math.max(limit, 1), 200),
        select: { id: true, key: true, value: true, scope: true, metadata: true, updatedAt: true },
      }),
    );
    return rows.map((row) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        key: row.key,
        value: row.value,
        scope: row.scope,
        confidence: typeof meta.confidence === 'number' ? meta.confidence : null,
        learnedAt: row.updatedAt,
      };
    });
  }

  /**
   * Edit a memory's value (P2-6). Same scope access control as forgetMemory: a
   * user_private memory is only editable by its owner. Marks it user-edited.
   */
  async updateMemory(ctx: TenantContext, memoryId: string, value: unknown) {
    const next = (typeof value === 'string' ? value.trim() : '').slice(0, 4000);
    if (!next) throw new BadRequestException('Memory value must be a non-empty string');
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMemory.findFirst({
        where: { id: memoryId, tenantId: ctx.tenantId },
        select: { id: true, scope: true, ownerUserId: true, metadata: true },
      }),
    );
    if (!row) throw new NotFoundException('Memory not found');
    if (row.scope === 'user_private' && row.ownerUserId !== ctx.userId) {
      throw new NotFoundException('Memory not found');
    }
    const meta =
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMemory.updateMany({
        where: { id: memoryId, tenantId: ctx.tenantId },
        data: {
          value: next,
          metadata: {
            ...meta,
            updatedBy: 'user',
            editedByUserId: ctx.userId,
          } as unknown as Prisma.InputJsonValue,
        },
      }),
    );
    return { ok: true, id: memoryId, value: next };
  }
}

function summarizeJsonForPrompt(value: unknown, maxChars = 5000): string {
  try {
    // Record-boundary-safe: if the value is an array, drop whole elements from
    // the end until the serialized form fits. This guarantees we never emit a
    // half-serialized record (which would split a bill number / CIK / dollar
    // figure mid-token and make the model "read" a corrupted value).
    if (Array.isArray(value)) {
      const records = [...value];
      let dropped = 0;
      while (records.length > 0) {
        const text = JSON.stringify(records, null, 2);
        if (text && text.length <= maxChars) {
          return dropped > 0
            ? `${text}\n... [${dropped} more record(s) omitted to fit context budget]`
            : text;
        }
        records.pop();
        dropped += 1;
      }
      // Even a single record exceeds the budget — fall through to line-safe trim.
      return truncateText(JSON.stringify(value, null, 2), maxChars);
    }

    const text = JSON.stringify(value, null, 2);
    if (!text) return '';
    return truncateText(text, maxChars);
  } catch {
    return '';
  }
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Cut on the last newline before the budget so we never slice a line (and
  // therefore never split a number/ID/URL) in half. Fall back to the last
  // whitespace, then to a hard cut only if there is no safe boundary at all.
  const window = text.slice(0, maxChars);
  let cut = window.lastIndexOf('\n');
  if (cut < maxChars * 0.5) {
    const space = window.lastIndexOf(' ');
    if (space > cut) cut = space;
  }
  if (cut <= 0) cut = maxChars;
  const omitted = text.length - cut;
  return `${text.slice(0, cut)}\n... [truncated ${omitted} chars at a safe boundary]`;
}

/**
 * Trim conversation history to a character budget, keeping the most recent
 * turns (oldest dropped first). Prevents silent context-limit 400s.
 */
function trimHistoryToBudget(
  history: Array<{ role: 'user' | 'assistant'; body: string }>,
  budgetChars: number,
): Array<{ role: 'user' | 'assistant'; body: string }> {
  let total = 0;
  const kept: Array<{ role: 'user' | 'assistant'; body: string }> = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (!turn) continue;
    const len = turn.body.length;
    if (total + len > budgetChars && kept.length > 0) break;
    total += len;
    kept.unshift(turn);
  }
  return kept;
}

/** Redact obviously sensitive fields before echoing tool input to the trace UI. */
function redactToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (/body|password|token|secret/i.test(k) && typeof v === 'string' && v.length > 80) {
      redacted[k] = `${v.slice(0, 60)}… [${v.length} chars]`;
    } else {
      redacted[k] = v;
    }
  }
  return redacted;
}

/** Human-friendly action label for a tool name, shown in the trust timeline. */
function humanToolLabel(tool: string): string {
  const labels: Record<string, string> = {
    get_client_context: 'Loaded client context',
    search_research_sources: 'Searched workspace records',
    query_intelligence: 'Pulled federal lobbying intelligence',
    search_congress_bills: 'Searched congressional bills',
    search_lda_filings: 'Searched LDA lobbying filings',
    search_sec_filings: 'Searched SEC filings',
    search_fara_registrations: 'Searched FARA registrations',
    search_federal_grants: 'Searched federal grants',
    search_gao_reports: 'Searched GAO reports',
    search_state_bills: 'Searched state bills',
    search_intel_articles: 'Searched policy news',
    search_committee_hearings: 'Searched committee hearings',
    search_crs_reports: 'Searched CRS reports',
    query_economic_data: 'Queried economic data',
    search_public_web: 'Searched the public web',
    scrape_web_page: 'Read a web page',
    create_meeting_brief: 'Created a meeting brief',
    draft_policy_memo: 'Drafted a policy memo',
    save_note: 'Saved a note',
    send_email: 'Sent an email',
    list_emails: 'Listed email threads',
    reply_email: 'Replied to an email thread',
  };
  return labels[tool] ?? tool.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Derive a count + human detail string from a tool result so the trust panel
 * can show what was actually found (citations), not just that a tool ran.
 * Handles the common Meri tool result shapes: { total, data: [...] },
 * { results: [...] }, { data: "<text>" }, { artifact }.
 */
function summarizeToolResultForTrust(payload: unknown): { count: number | null; detail: string } {
  if (!payload || typeof payload !== 'object') return { count: null, detail: '' };
  const rec = payload as Record<string, unknown>;
  if (typeof rec.error === 'string') return { count: null, detail: rec.error };

  const rows = Array.isArray(rec.data) ? (rec.data as unknown[])
    : Array.isArray(rec.results) ? (rec.results as unknown[])
    : null;
  const total = typeof rec.total === 'number' ? rec.total : (rows ? rows.length : null);

  if (rows && rows.length) {
    const sample = rows
      .slice(0, 3)
      .map((r) => {
        if (r && typeof r === 'object') {
          const o = r as Record<string, unknown>;
          const label = o.title ?? o.name ?? o.subject ?? o.companyName ?? o.registrantName ?? o.identifier ?? o.billNumber;
          if (typeof label === 'string') return label.length > 60 ? `${label.slice(0, 57)}…` : label;
        }
        return null;
      })
      .filter((x): x is string => Boolean(x));
    const head = total != null ? `${total} result${total === 1 ? '' : 's'}` : `${rows.length} result(s)`;
    return { count: total, detail: sample.length ? `${head}: ${sample.join('; ')}` : head };
  }

  if (typeof rec.data === 'string' && rec.data.trim()) {
    const text = rec.data.trim();
    return { count: null, detail: text.length > 100 ? `${text.slice(0, 97)}…` : text };
  }
  if (rec.artifact && typeof rec.artifact === 'object') {
    const a = rec.artifact as Record<string, unknown>;
    return { count: null, detail: typeof a.title === 'string' ? `Created: ${a.title}` : 'Created artifact' };
  }
  return { count: total, detail: total != null ? `${total} result(s)` : 'Completed' };
}

/**
 * Extract persisted artifacts from a Meri tool result so the streaming brain
 * can save them as clioArtifact rows (the artifact panel reads these).
 * Tools return { artifact: {...} } or { artifacts: [...] } with persisted!==false.
 */
function extractToolArtifacts(value: unknown): Array<{
  title: string;
  kind: string;
  contentType: string | null;
  bodyText: string | null;
  s3Key: string | null;
  metadata: Prisma.InputJsonValue;
}> {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (record.artifact) candidates.push(record.artifact);
  if (Array.isArray(record.artifacts)) candidates.push(...record.artifacts);
  const out: ReturnType<typeof extractToolArtifacts> = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const a = candidate as Record<string, unknown>;
    if (a.persisted === false) continue;
    const bodyText =
      typeof a.bodyText === 'string' ? a.bodyText :
      typeof a.body === 'string' ? a.body :
      typeof a.content === 'string' ? a.content : null;
    const s3Key = typeof a.s3Key === 'string' ? a.s3Key : null;
    const metadata = a.metadata && typeof a.metadata === 'object' && !Array.isArray(a.metadata)
      ? (a.metadata as Prisma.InputJsonObject)
      : {};
    // Image artifacts (F4 analysis charts) carry their PNG in metadata
    // instead of bodyText/s3Key.
    const hasImage = typeof (metadata as Record<string, unknown>).imageBase64 === 'string';
    if (!bodyText && !s3Key && !hasImage) continue;
    out.push({
      title: typeof a.title === 'string' && a.title.trim() ? a.title.trim() : 'Meri artifact',
      kind: typeof a.kind === 'string' && a.kind.trim() ? a.kind.trim() : 'document',
      contentType: typeof a.contentType === 'string' ? a.contentType : 'text/markdown',
      bodyText,
      s3Key,
      metadata,
    });
  }
  return out;
}
