import { prepareAnthropicRequest } from '@capiro/shared/ai-model-policy';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { MeriCitation, TenantContext } from '@capiro/shared';
import { validateCitationMarkers, validateFormBCitations } from '@capiro/shared';
import { classifyApiToolReadOutcome } from '@capiro/shared/meri-read-outcome';
import {
  runAuditor,
  ledgerToToolResultMap,
  type LedgerEntry,
  type MeriEvidenceManifest,
} from '@capiro/meriv2-core';
import { resolveTenantAuditorMode } from '../common/auditor-mode.js';
import { resolveEvidenceAccuracyModeForTenant } from '../common/meri-evidence-accuracy-flags.js';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isInternalClioArtifact } from '../common/internal-clio-artifact.js';
import { MeriToolsService } from './meri-tools.service.js';
import {
  clientScopeRefusal,
  CLIENT_ID_UUID_RE,
  isMeriMailReadTool,
} from './meri-prompt.helpers.js';
import { AiCredentialResolverService } from '../engagement/ai-credential-resolver.service.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import { DELIVERABLE_RISK_TIERS } from '@capiro/shared';
import {
  assembleReportArtifact,
  buildPlanUserPrompt,
  buildResearchSystemPrompt,
  buildResearchUserPrompt,
  clampTitle,
  humanToolLabel,
  summarizeJsonForPrompt,
  summarizeToolResultForTrust,
} from './meri-research.helpers.js';
import {
  ResearchPlanValidationError,
  buildResearchPlanRepairPrompt,
  buildResearchPlanSystemPrompt,
  researchPlanStringProjection,
  validateResearchPlan,
  type ResearchPlanAdmissionContext,
  type ResearchPlanV1,
} from './meri-research-plan.js';
import {
  applyThinkingStreamEvent,
  createThinkingState,
  thinkingReplayBlocks,
  thinkingRequestParams,
  type ThinkingSettings,
} from './meri-thinking.helpers.js';

import {
  captureResearchHandoff,
  readResearchHandoff,
  researchHandoffPrompt,
  type ResearchHandoffInput,
} from './meri-research-handoff.js';
import { attachmentMetaRef } from './meri-attachment.helpers.js';
import { MeriV3ResearchRunner, type ResearchRuntimeAuth } from './meri-v3-research-runner.js';
import type {
  MeriV3ProviderTelemetry,
  MeriV3RetrievalStreamSummary,
} from './meriv3-chat.client.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { MERI_TURN_MAINTENANCE, type MeriTurnMaintenance } from './meri-turn-maintenance.js';

import { randomUUID } from 'node:crypto';
import { withMeriToolExecutionControl } from './meri-tool-request-control.js';
import {
  ACTIVE_RESEARCH_RUN_FENCE_SQL,
  ACTIVE_RESEARCH_RUN_UPDATE_SQL,
  readResearchRun,
  researchLeaseCutoff,
  researchMetadata,
  terminalResearchRun,
  type ResearchRunState,
  type ResearchRunPhase,
} from './meri-research-run-state.js';
import {
  appendDurableResearchResultReceipt,
  readDurableResearchStepReceipts,
  type DurableResearchStepReceipt,
} from './meri-research-durable-step.js';
import {
  RESEARCH_SAFE_READ_ARTIFACT_KIND,
  openDurableResearchResult,
  researchJsonSha256,
  researchToolVersion,
  sealDurableResearchResult,
} from './meri-research-durable-result.js';
import {
  assertCurrentResearchReportSourcesAuthorized,
  currentOwnerResultAuthorizesReplay,
  RESEARCH_REPORT_BODY_WITHHELD,
  supportsDurableOwnerReauthorization,
} from './meri-research-replay-authorization.js';
import {
  buildResearchReportProvenance,
  certifyResearchProducerInputs,
  publicResearchSourceTool,
} from './meri-report-provenance.js';
import {
  projectResearchObserverError,
  projectResearchObserverEvent,
  RESEARCH_OBSERVER_STATUS,
  RESEARCH_PROVIDER_FAILURE,
} from './research-observer-projection.js';

const PRODUCT_NAME = 'Meri';

/**
 * Absolute floor for the forced-synthesis window, independent of how little of
 * the total budget is left. Guards the degenerate case where gathering consumed
 * everything: a 0ms window aborts the writer instantly and ships sources with no
 * report. Clamped down to the per-call timeout at the use site. 30s produced
 * thin partial artifacts under live load (2026-08-18 funding reports); 3 minutes
 * is enough for a multi-section cited body.
 */
const SYNTHESIS_FLOOR_MS = 180_000;

const RESEARCH_GATHER_THINKING_STATUS = RESEARCH_OBSERVER_STATUS.gatheringThinking;
const RESEARCH_SYNTHESIS_THINKING_STATUS = RESEARCH_OBSERVER_STATUS.writingReport;

export interface SourceAttribution {
  tool: string;
  label: string;
  count?: number | null;
  summary: string;
  confidence: 'low' | 'high';
}

interface SseSink {
  write: (data: string) => void;
  /** Internal-only receipt candidate channel; never an observer transport. */
  writeReceiptCandidate?: (event: Record<string, unknown>) => void;
  flush?: () => Promise<void>;
}

export interface ResearchSafeReadOutcomeInput {
  executionId: string;
  leaseEpoch?: number;
  providerCallId: string;
  tool: string;
  toolVersion: string;
  input: Record<string, unknown>;
  result: unknown;
}

export interface MeriReportModelContextMessage {
  id: string;
  role: string;
  body: string;
  metadata?: Prisma.JsonValue | null;
}

export interface MeriReportModelContextAuthorization<T extends MeriReportModelContextMessage> {
  messages: T[];
  summary: string | null;
  withheldReports: Array<{
    messageId: string | null;
    metadata: Record<string, unknown>;
  }>;
}

/**
 * Deep Research workflow and persistence. The provider plans, chooses reads,
 * and synthesizes; this service preserves scope, evidence, progress and reports.
 * V3 tenants use chat's existing Responses runtime for planning and research.
 * Existing non-V3 sessions retain their legacy provider path during rollout.
 * Chat-originated sessions snapshot server-owned history and attachments, then
 * persist their plan, clarifications and final report back into that thread.
 */
@Injectable()
export class MeriResearchService {
  private readonly logger = new Logger(MeriResearchService.name);
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly tools: MeriToolsService,
    private readonly aiCredentials: AiCredentialResolverService,
    private readonly reviews: ReviewsService,
    @Optional() private readonly v3Research?: MeriV3ResearchRunner,
    @Optional()
    @Inject(MERI_TURN_MAINTENANCE)
    private readonly turnMaintenance?: MeriTurnMaintenance,
  ) {}

  // ── Session CRUD ─────────────────────────────────────────────────────────

  async listSessions(ctx: TenantContext, conversationId?: string) {
    const sessions = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioResearchSession.findMany({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          ...(conversationId
            ? { metadata: { path: ['handoff', 'conversationId'], equals: conversationId } }
            : {}),
        },
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: {
          id: true,
          title: true,
          topic: true,
          status: true,
          clientId: true,
          reportArtifactId: true,
          metadata: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    const visible = await Promise.all(
      sessions.map(async (session) => {
        try {
          await this.ensureSession(ctx, session.id);
          const metadata = researchMetadata(session.metadata);
          return {
            ...session,
            metadata: {
              handoff: {
                conversationId: readResearchHandoff(session.metadata)?.conversationId ?? null,
              },
              planMessageId: metadata.planMessageId,
              reportMessageId: metadata.reportMessageId,
            },
            run: readResearchRun(session.metadata),
          };
        } catch {
          return null;
        }
      }),
    );
    return visible.filter((session) => session !== null);
  }

  /**
   * Reauthorize report-derived chat context immediately before it crosses a
   * model boundary. Ordinary messages and user-authored research handoffs are
   * unchanged; assistant report references fail closed through the same
   * current-owner seam used by report recovery and export.
   */
  async authorizeModelContext<T extends MeriReportModelContextMessage>(
    ctx: TenantContext,
    scope: { conversationId: string; clientId: string | null },
    messages: T[],
    summary: string | null,
  ): Promise<MeriReportModelContextAuthorization<T>> {
    const reports = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.findMany({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          conversationId: scope.conversationId,
          kind: 'research_report',
        },
        select: { id: true, messageId: true, metadata: true },
      }),
    );
    const reportByMessageId = new Map(
      reports.flatMap((report) => (report.messageId ? [[report.messageId, report] as const] : [])),
    );
    const authorization = new Map<string, Promise<boolean>>();
    const authorize = (sessionId: string | null, reportArtifactId?: string): Promise<boolean> => {
      if (!sessionId) return Promise.resolve(false);
      const key = `${sessionId}:${reportArtifactId ?? ''}`;
      const existing = authorization.get(key);
      if (existing) return existing;
      const checked = assertCurrentResearchReportSourcesAuthorized({
        prisma: this.prisma,
        tools: this.tools,
        ctx,
        scope: { sessionId, reportArtifactId, ...scope },
      }).then(
        () => true,
        () => false,
      );
      authorization.set(key, checked);
      return checked;
    };
    const withheldReports: MeriReportModelContextAuthorization<T>['withheldReports'] = [];
    let messageContextWithheld = false;
    const authorizedMessages = await Promise.all(
      messages.map(async (message) => {
        const metadata = researchMetadata(message.metadata);
        const linkedReport = reportByMessageId.get(message.id);
        const linkedMetadata = researchMetadata(linkedReport?.metadata);
        const sessionId =
          typeof metadata.researchSessionId === 'string' && metadata.researchSessionId
            ? metadata.researchSessionId
            : typeof linkedMetadata.researchSessionId === 'string' &&
                linkedMetadata.researchSessionId
              ? linkedMetadata.researchSessionId
              : null;
        const reportDerived =
          message.role === 'assistant' &&
          (metadata.researchReport === true || Boolean(sessionId) || Boolean(linkedReport));
        if (!reportDerived || (await authorize(sessionId, linkedReport?.id))) return message;
        messageContextWithheld = true;
        const withheld = withheldPublicResearchReportMetadata(message.metadata, sessionId);
        withheldReports.push({ messageId: message.id, metadata: withheld });
        return {
          ...message,
          body: RESEARCH_REPORT_BODY_WITHHELD,
          metadata: withheld as Prisma.InputJsonValue,
        };
      }),
    );
    let authorizedSummary = messageContextWithheld ? null : summary;
    if (summary) {
      for (const report of reports) {
        const metadata = researchMetadata(report.metadata);
        const sessionId =
          typeof metadata.researchSessionId === 'string' && metadata.researchSessionId
            ? metadata.researchSessionId
            : null;
        if (!(await authorize(sessionId, report.id))) {
          authorizedSummary = null;
          if (!withheldReports.some((entry) => entry.messageId === report.messageId)) {
            withheldReports.push({
              messageId: report.messageId,
              metadata: withheldPublicResearchReportMetadata(report.metadata, sessionId),
            });
          }
          break;
        }
      }
    }
    return { messages: authorizedMessages, summary: authorizedSummary, withheldReports };
  }

  async getSession(ctx: TenantContext, id: string) {
    const session = await this.ensureSession(ctx, id);

    // Attach the report artifact body when complete.
    let report: { id: string; title: string; bodyText: string | null; metadata?: unknown } | null =
      null;
    let reportBodyWithheld = false;
    if (session.reportArtifactId) {
      report = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioArtifact.findFirst({
          where: {
            id: session.reportArtifactId ?? undefined,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
          },
          select: { id: true, title: true, bodyText: true, metadata: true, kind: true },
        }),
      );
      if (isInternalClioArtifact(report)) report = null;
    }
    // A held artifact is never released by reconnection or export.
    if (report && researchMetadata(report.metadata).heldForReview === true)
      report = {
        ...report,
        bodyText: 'Report held for review. Open Reviews before using this deliverable.',
      };
    const storedRun = readResearchRun(session.metadata);
    if (report) {
      try {
        await this.assertReplayedReportSourcesAuthorized(ctx, session.id, storedRun, null, {
          reportArtifactId: report.id,
        });
      } catch {
        reportBodyWithheld = true;
        report = {
          ...report,
          bodyText: RESEARCH_REPORT_BODY_WITHHELD,
          metadata: withheldPublicResearchReportMetadata(report.metadata, session.id),
        };
      }
    }
    let reportMetadata = publicResearchReportMetadata(report?.metadata);
    const reportMessageId = researchMetadata(session.metadata).reportMessageId;
    if (report && typeof reportMessageId === 'string') {
      const message = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioMessage.findFirst({
          where: {
            id: reportMessageId,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            clientId: session.clientId,
            role: 'assistant',
          },
          select: { metadata: true },
        }),
      );
      const metadata = researchMetadata(message?.metadata);
      reportMetadata = publicResearchReportMetadata(metadata);
    }
    if (reportBodyWithheld)
      reportMetadata = withheldPublicResearchReportMetadata(reportMetadata, session.id);
    if (report && !reportBodyWithheld)
      report = { ...report, metadata: publicResearchReportMetadata(report.metadata) };
    return {
      ...session,
      sources: publicResearchSources(session.sources),
      metadata: publicResearchSessionMetadata(session.metadata),
      run: readResearchRun(session.metadata),
      report,
      reportMetadata,
    };
  }

  async createSession(ctx: TenantContext, input: ResearchHandoffInput) {
    const topic = (input.topic ?? '').trim();
    if (!topic) throw new BadRequestException('A research topic is required');
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const handoff = await captureResearchHandoff(tx, ctx, { ...input, topic });
      const session = await tx.clioResearchSession.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: handoff.clientId,
          title: clampTitle(input.title?.trim() || topic),
          topic,
          status: 'plan',
          metadata: {
            handoff,
            run: {
              id: randomUUID(),
              leaseEpoch: 0,
              eventSequence: 0,
              phase: 'plan',
              status: 'interrupted',
              readyToStart: true,
              stage: 'Research request saved; planning has not started',
              startedAt: new Date().toISOString(),
              heartbeatAt: new Date().toISOString(),
            },
          } as unknown as Prisma.InputJsonObject,
        },
        select: {
          id: true,
          title: true,
          topic: true,
          status: true,
          clientId: true,
          createdAt: true,
        },
      });
      if (handoff.conversationId) {
        const staged = new Set(input.attachmentIds ?? []);
        const message = await tx.clioMessage.create({
          data: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            clientId: handoff.clientId,
            conversationId: handoff.conversationId,
            role: 'user',
            body: topic,
            metadata: {
              researchSessionId: session.id,
              attachments: handoff.attachments
                .filter((row) => staged.has(row.id))
                .map(attachmentMetaRef),
            } as unknown as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        // Only claim unconsumed uploads. Existing evidence stays linked to its original turn.
        if (staged.size) {
          const unconsumed = handoff.attachments.filter(
            (row) => staged.has(row.id) && !row.sourceMessageId,
          );
          const claimed = await tx.clioAttachment.updateMany({
            where: {
              id: { in: unconsumed.map((row) => row.id) },
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              messageId: null,
            },
            data: { messageId: message.id },
          });
          if (claimed.count !== unconsumed.length)
            throw new BadRequestException(
              'A staged attachment was consumed by another conversation; retry research',
            );
        }
        await tx.clioConversation.update({
          where: { id: handoff.conversationId },
          data: { updatedAt: new Date() },
        });
      }
      return {
        ...session,
        conversationId: handoff.conversationId,
        reasoningMode: handoff.reasoningMode,
      };
    });
  }

  async deleteSession(ctx: TenantContext, id: string) {
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioResearchSession.deleteMany({
        where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
      }),
    );
    return { ok: true };
  }

  /**
   * Fetch the completed report's markdown for a session (for export). Throws if
   * the session has no report yet.
   */
  async getReportMarkdown(
    ctx: TenantContext,
    id: string,
  ): Promise<{ title: string; markdown: string }> {
    const session = await this.ensureSession(ctx, id);
    if (!session.reportArtifactId) {
      throw new BadRequestException('This research session has no report yet');
    }
    const artifact = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.findFirst({
        where: {
          id: session.reportArtifactId ?? undefined,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
        },
        select: { title: true, bodyText: true, metadata: true, kind: true },
      }),
    );
    if (!artifact || isInternalClioArtifact(artifact))
      throw new NotFoundException('Report artifact not found');
    if (researchMetadata(artifact.metadata).heldForReview === true)
      throw new BadRequestException('This research report is held for review');
    const storedRun = readResearchRun(session.metadata);
    await this.assertReplayedReportSourcesAuthorized(ctx, session.id, storedRun, null, {
      reportArtifactId: session.reportArtifactId,
    });
    return { title: artifact.title, markdown: artifact.bodyText ?? '' };
  }

  /** Persist the lobbyist's answers to the clarifying questions. */
  async answerClarifications(ctx: TenantContext, id: string, answers: Record<string, string>) {
    const session = await this.ensureSession(ctx, id);
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(answers ?? {})) {
      if (typeof v === 'string' && v.trim()) clean[String(k)] = v.trim();
    }
    if (
      JSON.stringify(asStringRecord(session.clarifyingAnswers)) === JSON.stringify(clean) &&
      session.status === 'researching'
    )
      return { ok: true };
    if (session.reportArtifactId || readResearchRun(session.metadata)?.status === 'running')
      throw new ConflictException(
        'Research has already started; its clarification answers cannot change.',
      );
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const changed = await tx.clioResearchSession.updateMany({
        where: {
          id: session.id,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          metadata: { equals: session.metadata ?? {} },
          reportArtifactId: null,
        },
        data: {
          clarifyingAnswers: clean as Prisma.InputJsonValue,
          metadata: {
            ...researchMetadata(session.metadata),
            answersRevision: randomUUID(),
            run: {
              id: randomUUID(),
              leaseEpoch: readResearchRun(session.metadata)?.leaseEpoch ?? 0,
              eventSequence: readResearchRun(session.metadata)?.eventSequence ?? 0,
              phase: 'research',
              status: 'interrupted',
              readyToStart: true,
              stage: 'Clarifications saved; research has not started',
              startedAt: new Date().toISOString(),
              heartbeatAt: new Date().toISOString(),
            },
          } as unknown as Prisma.InputJsonObject,
          status: 'researching',
          updatedAt: new Date(),
        },
      });
      if (!changed.count)
        throw new ConflictException('Research changed while saving answers; refresh its status.');
      const handoff = readResearchHandoff(session.metadata);
      if (handoff?.conversationId)
        await tx.clioMessage.create({
          data: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            clientId: session.clientId,
            conversationId: handoff.conversationId,
            role: 'user',
            body: `Research clarification answers:\n${JSON.stringify(clean)}`,
            metadata: { researchSessionId: session.id },
          },
        });
    });
    return { ok: true };
  }

  async streamPlan(ctx: TenantContext, id: string, sse: SseSink, auth: ResearchRuntimeAuth = {}) {
    return this.withResearchRun(ctx, id, 'plan', sse, auth, (sink, runAuth) =>
      this.runPlanStream(ctx, id, sink, runAuth),
    );
  }

  async streamResearch(
    ctx: TenantContext,
    id: string,
    sse: SseSink,
    auth: ResearchRuntimeAuth = {},
  ) {
    return this.withResearchRun(ctx, id, 'research', sse, auth, (sink, runAuth) =>
      this.runClaimedResearch(ctx, id, sink, runAuth),
    );
  }

  async assertRunActive(ctx: TenantContext, id: string, runId: string) {
    const session = await this.ensureSession(ctx, id);
    const run = readResearchRun(session.metadata);
    if (run?.id !== runId || run.status !== 'running')
      throw new ConflictException('Research is no longer running.');
    return { active: true };
  }

  /** Server-to-server V3 hook; commits private result bytes and the public receipt atomically. */
  async commitSafeReadOutcome(
    ctx: TenantContext,
    id: string,
    runId: string,
    input: ResearchSafeReadOutcomeInput,
  ) {
    const committed = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const current = await tx.clioResearchSession.findFirst({
        where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
      });
      const run = readResearchRun(current?.metadata);
      if (
        !current ||
        !run ||
        run.id !== runId ||
        run.status !== 'running' ||
        input.leaseEpoch !== run.leaseEpoch
      )
        throw new ConflictException('Research lease is no longer active.');
      await this.assertResearchPublicationAuthorized(tx, ctx, current);
      const receipt = await this.commitSafeReadOutcomeInTransaction(tx, ctx, current, run, input);
      return { receipt, run };
    });
    // Commit and publication are separate failure boundaries. A revocation here
    // leaves the private result durable but withholds it from the caller.
    await this.assertReceiptPublicationAuthorized(ctx, id, committed.run);
    return committed.receipt;
  }

  /** Reuse is limited to a prior ownership epoch and reauthorized on every request. */
  async replaySafeReadOutcome(
    ctx: TenantContext,
    id: string,
    runId: string,
    request: {
      leaseEpoch: number;
      tool: string;
      toolVersion: string;
      input: Record<string, unknown>;
    },
  ) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const current = await tx.clioResearchSession.findFirst({
        where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
      });
      const run = readResearchRun(current?.metadata);
      if (
        !current ||
        !run ||
        run.id !== runId ||
        run.status !== 'running' ||
        request.leaseEpoch !== run.leaseEpoch
      )
        throw new ConflictException('Research lease is no longer active.');
      await this.assertResearchPublicationAuthorized(tx, ctx, current);
      this.assertCurrentSafeReadPolicy(ctx, request.tool, request.toolVersion);
      const inputSha256 = researchJsonSha256(request.input);
      const receipt = readDurableResearchStepReceipts(current.metadata)
        .filter(
          (candidate) =>
            candidate.version === 2 &&
            candidate.status === 'complete' &&
            candidate.leaseEpoch < run.leaseEpoch &&
            candidate.runId !== run.id &&
            candidate.tool === request.tool &&
            candidate.toolVersion === request.toolVersion &&
            candidate.inputSha256 === inputSha256,
        )
        .sort((a, b) => b.sequence - a.sequence)[0];
      if (!receipt?.resultRef || !receipt.resultBodySha256) return { replayed: false as const };
      const handoff = readResearchHandoff(current.metadata);
      const backing = researchMetadata(current.metadata).backingConversationId;
      const conversationId =
        handoff?.conversationId ?? (typeof backing === 'string' ? backing : null);
      if (!conversationId) return { replayed: false as const };
      const artifact = await tx.clioArtifact.findFirst({
        where: {
          id: receipt.resultRef,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: current.clientId,
          conversationId,
          kind: RESEARCH_SAFE_READ_ARTIFACT_KIND,
        },
        select: { bodyText: true },
      });
      let envelope;
      try {
        envelope = openDurableResearchResult(artifact?.bodyText, receipt.resultBodySha256);
      } catch {
        // A missing/corrupt private cache is a replay miss. The caller may perform
        // a fresh owner read; cache damage must not turn the tool into an error.
        return { replayed: false as const };
      }
      if (
        envelope.executionId !== receipt.executionId ||
        envelope.providerCallId !== receipt.providerCallId ||
        envelope.runId !== receipt.runId ||
        envelope.leaseEpoch !== receipt.leaseEpoch ||
        envelope.tool !== receipt.tool ||
        envelope.toolVersion !== receipt.toolVersion ||
        envelope.inputSha256 !== receipt.inputSha256 ||
        envelope.resultSha256 !== receipt.resultSha256
      )
        return { replayed: false as const };
      const classified = classifyApiToolReadOutcome(envelope.tool, envelope.result);
      if (classified?.kind !== envelope.classifier) return { replayed: false as const };
      if (!supportsDurableOwnerReauthorization(envelope.tool)) return { replayed: false as const };
      let currentOwnerResult: unknown;
      try {
        // The canonical owner path re-evaluates RLS/ACL, lifecycle and source
        // version now. This is an authorization proof read, not old coverage.
        currentOwnerResult = await this.tools.execute(ctx, envelope.tool as never, envelope.input);
      } catch {
        return { replayed: false as const };
      }
      if (!currentOwnerResultAuthorizesReplay(envelope.tool, envelope.result, currentOwnerResult))
        return { replayed: false as const };
      const final = await tx.clioResearchSession.findFirst({
        where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
      });
      const finalRun = readResearchRun(final?.metadata);
      if (
        !final ||
        finalRun?.id !== run.id ||
        finalRun.leaseEpoch !== run.leaseEpoch ||
        finalRun.status !== 'running'
      )
        throw new ConflictException('Research lease is no longer active.');
      await this.assertResearchPublicationAuthorized(tx, ctx, final);
      return {
        replayed: true as const,
        result: envelope.result,
        durableSafeRead: publicDurableSafeRead(receipt, true),
      };
    });
  }

  /** Cancelling is an explicit action; a disconnected browser only detaches. */
  async cancelRun(ctx: TenantContext, id: string) {
    const session = await this.ensureSession(ctx, id);
    const run = readResearchRun(session.metadata);
    if (!run || !['running', 'interrupted'].includes(run.status)) return { ok: true, run };
    const cancelled = terminalResearchRun(run, 'cancelled', 'Research stopped at your request');
    const changed = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioResearchSession.updateMany({
        where: {
          id,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          metadata: { equals: session.metadata ?? {} },
        },
        data: {
          status: 'cancelled',
          metadata: {
            ...researchMetadata(session.metadata),
            run: cancelled,
          } as unknown as Prisma.InputJsonObject,
          updatedAt: new Date(),
        },
      }),
    );
    if (!changed.count)
      throw new ConflictException(
        'Research changed while cancelling; refresh its status and retry.',
      );
    this.activeRuns.get(`${ctx.tenantId}:${ctx.userId}:${id}`)?.abort();
    return { ok: true, run: cancelled };
  }

  private async withResearchRun(
    ctx: TenantContext,
    id: string,
    phase: ResearchRunPhase,
    output: SseSink,
    auth: ResearchRuntimeAuth,
    execute: (sink: SseSink, auth: ResearchRuntimeAuth) => Promise<void>,
  ) {
    // Suppress writes to a detached response; the run still persists its result.
    const safeWrite = (data: string) => {
      try {
        output.write(data);
      } catch {
        /* detached */
      }
    };
    let claimed: ResearchRunState | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let pending = Promise.resolve();
    let stopping = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    auth.signal?.addEventListener('abort', abort, { once: true });
    if (auth.signal?.aborted) controller.abort();
    const key = `${ctx.tenantId}:${ctx.userId}:${id}`;
    try {
      const session = await this.ensureSession(ctx, id);
      const previous = readResearchRun(session.metadata);
      if (
        session.reportArtifactId ||
        (phase === 'plan' && asStringArray(session.plan).length > 0)
      ) {
        await this.replaySession(ctx, id, { write: safeWrite }, phase);
        return;
      }
      if (previous?.status === 'running') {
        safeWrite(sseEvent({ type: 'run', run: previous }));
        safeWrite(sseEvent({ type: 'done' }));
        return;
      }
      // A delayed pre-Stop POST cannot restart a cancelled or abandoned attempt.
      // Only the explicit Resume control targets an existing attempt ID.
      if (
        previous &&
        ['cancelled', 'failed', 'partial', 'interrupted'].includes(previous.status) &&
        !(previous.status === 'interrupted' && previous.readyToStart === true) &&
        auth.resumeRunId !== previous.id
      ) {
        safeWrite(sseEvent({ type: 'run', run: previous }));
        safeWrite(sseEvent({ type: 'done' }));
        return;
      }
      if (controller.signal.aborted) throw new BadRequestException('Research was cancelled.');
      const now = new Date();
      claimed = {
        id: randomUUID(),
        leaseEpoch: (previous?.leaseEpoch ?? 0) + 1,
        eventSequence: previous?.eventSequence ?? 0,
        phase,
        status: 'running',
        stage: phase === 'plan' ? 'Planning the research' : 'Gathering evidence',
        startedAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
      };
      const result = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioResearchSession.updateMany({
          // Optimistic compare-and-swap: two API replicas cannot both own a run.
          where: {
            id,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            metadata: { equals: session.metadata ?? {} },
            reportArtifactId: null,
          },
          data: {
            status: phase === 'plan' ? 'plan' : 'researching',
            metadata: {
              ...researchMetadata(session.metadata),
              run: claimed,
            } as unknown as Prisma.InputJsonObject,
            updatedAt: now,
          },
        }),
      );
      if (!result.count) {
        const current = await this.ensureSession(ctx, id);
        safeWrite(sseEvent({ type: 'run', run: readResearchRun(current.metadata) }));
        safeWrite(sseEvent({ type: 'done' }));
        return;
      }
      const run = claimed;
      this.activeRuns.set(key, controller);
      safeWrite(sseEvent({ type: 'run', run }));
      const heartbeat = () => {
        if (stopping) return;
        pending = pending
          .then(async () => {
            if (stopping) return;
            const current = await this.prisma.withTenant(ctx.tenantId, (tx) =>
              tx.clioResearchSession.findFirst({
                where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
              }),
            );
            const stored = readResearchRun(current?.metadata);
            if (
              !current ||
              stored?.id !== run.id ||
              stored.leaseEpoch !== run.leaseEpoch ||
              stored.status !== 'running'
            ) {
              controller.abort(researchLeaseError('Research lease is no longer active.'));
              return;
            }
            const heartbeatAt = new Date();
            const nextMetadata = {
              ...researchMetadata(current.metadata),
              run: { ...run, heartbeatAt: heartbeatAt.toISOString() },
            };
            const updated = await this.prisma.withTenant(ctx.tenantId, (tx) =>
              this.updateActiveResearchRun(
                tx,
                ctx,
                id,
                run,
                current.metadata,
                nextMetadata,
                current.status,
                heartbeatAt,
              ),
            );
            if (!updated)
              controller.abort(
                researchLeaseError('Research lease changed while reporting progress.'),
              );
          })
          .catch((error) => {
            this.logger.warn(
              `Research heartbeat failed: ${error instanceof Error ? error.message : 'unknown error'}`,
            );
            controller.abort(
              researchLeaseError('The worker could not confirm its research lease.'),
            );
          });
      };
      timer = setInterval(heartbeat, 10_000);
      timer.unref?.();
      let pendingError: unknown;
      const queueEvent = (event: Record<string, unknown>, data = sseEvent(event)) => {
        if (event.type === 'progress' && typeof event.note === 'string') run.stage = event.note;
        if (event.type === 'step') run.stage = RESEARCH_OBSERVER_STATUS.readingSource;
        if (event.type === 'error' || event.type === 'done') {
          // Durable progress can fail independently of the terminal control
          // channel. Preserve event ordering, but never hide the honest
          // terminal outcome from observers after a queued receipt failure.
          pending = pending.then(
            () => safeWrite(data),
            () => safeWrite(data),
          );
          return;
        }
        pending = pending
          .then(async () => {
            if (pendingError) throw pendingError;
            const qualification = researchMetadata(event.durableSafeRead);
            if (
              event.type === 'source' &&
              qualification.outcome === 'complete' &&
              typeof qualification.toolCallId === 'string' &&
              typeof qualification.tool === 'string'
            ) {
              const persisted =
                qualification.persisted === true
                  ? (qualification as unknown as DurableResearchStepReceipt)
                  : await this.persistDurableSourceReceipt(
                      ctx,
                      id,
                      run,
                      researchMetadata(event.source),
                      qualification,
                    );
              run.eventSequence = persisted.sequence;
              await this.assertReceiptPublicationAuthorized(ctx, id, run);
              data = sseEvent({
                ...event,
                sequence: persisted.sequence,
                durableSafeRead: publicDurableSafeRead(
                  persisted,
                  qualification.replayed === true,
                ),
              });
            }
            safeWrite(data);
          })
          .catch((error) => {
            pendingError = error;
            controller.abort(
              researchLeaseError('Research progress could not be persisted.'),
            );
          });
      };
      const sink: SseSink = {
        write: (data: string) => {
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data.replace(/^data: /, '').trim()) as Record<string, unknown>;
          } catch {
            return;
          }
          if (event.type === 'error') {
            event = {
              type: 'error',
              message: projectResearchObserverError(event.message, controller.signal),
            };
          } else if (
            [
              'thinking',
              'reasoning',
              'reasoning_delta',
              'reasoning_summary',
              'start',
              'runtime',
              'progress',
              'tool_call',
              'tool_done',
              'pending_approval',
              'source',
            ].includes(String(event.type))
          ) {
            const original = event;
            const projected = projectResearchObserverEvent(event);
            if (!projected) return;
            event = projected;
            if (event.type === 'progress') {
              if (
                typeof original.elapsedMs === 'number' &&
                Number.isSafeInteger(original.elapsedMs) &&
                original.elapsedMs >= 0
              )
                event.elapsedMs = original.elapsedMs;
              if (
                typeof original.budgetMs === 'number' &&
                Number.isSafeInteger(original.budgetMs) &&
                original.budgetMs >= 0
              )
                event.budgetMs = original.budgetMs;
            }
          } else if (
            ![
              'run',
              'phase',
              'title',
              'plan',
              'clarify',
              'notice',
              'text',
              'report',
              'done',
            ].includes(String(event.type))
          ) {
            return;
          }
          queueEvent(event);
        },
        writeReceiptCandidate: (candidate) => {
          const projected = projectResearchObserverEvent(candidate, { receiptCandidates: true });
          if (projected) queueEvent(projected);
        },
        flush: async () => {
          await pending;
          if (pendingError) throw pendingError;
        },
      };
      await execute(sink, { ...auth, run, signal: controller.signal });
    } catch (error) {
      const privateMessage = error instanceof Error ? error.message : 'Research failed';
      const message = projectResearchObserverError(error, controller.signal);
      if (claimed)
        await this.markFailed(
          ctx,
          id,
          { ...auth, run: claimed, signal: controller.signal },
          message,
        );
      const terminal = [sseEvent({ type: 'error', message }), sseEvent({ type: 'done' })];
      // A direct execute/setup failure can race a receipt already queued by the
      // sink. Publish terminal control only after that receipt settles, using
      // the rejection path too so a failed receipt cannot poison error/done.
      pending = pending.then(
        () => terminal.forEach(safeWrite),
        () => terminal.forEach(safeWrite),
      );
      this.logger.warn(`Research run failed: ${privateMessage}`);
    } finally {
      stopping = true;
      if (timer) clearInterval(timer);
      await pending;
      auth.signal?.removeEventListener('abort', abort);
      if (this.activeRuns.get(key) === controller) this.activeRuns.delete(key);
    }
  }

  /** Commit a safe-read completion before its observer event is released. */
  private async persistDurableSourceReceipt(
    ctx: TenantContext,
    id: string,
    run: ResearchRunState,
    source: Record<string, unknown>,
    qualification: Record<string, unknown>,
  ) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const current = await tx.clioResearchSession.findFirst({
        where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
      });
      const currentRun = readResearchRun(current?.metadata);
      if (
        !current ||
        currentRun?.id !== run.id ||
        currentRun.leaseEpoch !== run.leaseEpoch ||
        currentRun.status !== 'running'
      )
        throw new ConflictException('Research lease is no longer active.');
      await this.assertResearchPublicationAuthorized(tx, ctx, current);

      const toolCallId = qualification.toolCallId as string;
      const tool = qualification.tool as string;
      if (
        !toolCallId.trim() ||
        source.tool !== tool ||
        source.confidence !== 'high' ||
        !this.tools.isConcurrencySafe(tool) ||
        typeof qualification.executionId !== 'string' ||
        typeof qualification.toolVersion !== 'string' ||
        !qualification.input ||
        typeof qualification.input !== 'object' ||
        Array.isArray(qualification.input) ||
        !('result' in qualification)
      )
        throw new ConflictException('Research source completion was not qualified for durability.');
      return this.commitSafeReadOutcomeInTransaction(tx, ctx, current, run, {
        executionId: qualification.executionId,
        providerCallId: toolCallId,
        tool,
        toolVersion: qualification.toolVersion,
        input: qualification.input as Record<string, unknown>,
        result: qualification.result,
      });
    });
  }

  private assertCurrentSafeReadPolicy(ctx: TenantContext, tool: string, toolVersion: string) {
    const schema = this.tools
      .anthropicToolSchemas({ tenantId: ctx.tenantId, surface: 'chat' })
      .find((candidate) => candidate.name === tool);
    if (
      !schema ||
      !this.tools.isConcurrencySafe(tool) ||
      researchToolVersion(schema.input_schema) !== toolVersion
    )
      throw new ConflictException('The read tool is no longer authorized by the current policy.');
  }

  private async commitSafeReadOutcomeInTransaction(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    current: Awaited<ReturnType<MeriResearchService['ensureSession']>>,
    run: ResearchRunState,
    input: ResearchSafeReadOutcomeInput,
  ) {
    if (!input.executionId?.trim() || !input.providerCallId?.trim())
      throw new ConflictException(
        'A durable safe-read outcome requires exact invocation identity.',
      );
    this.assertCurrentSafeReadPolicy(ctx, input.tool, input.toolVersion);
    const readOutcome = classifyApiToolReadOutcome(input.tool, input.result);
    if (readOutcome?.kind !== 'complete' && readOutcome?.kind !== 'empty')
      throw new ConflictException('The owner result is not a qualified complete safe read.');

    const existing = readDurableResearchStepReceipts(current.metadata).find(
      (receipt) => receipt.version === 2 && receipt.executionId === input.executionId,
    );
    if (existing) {
      if (
        existing.runId !== run.id ||
        existing.leaseEpoch !== run.leaseEpoch ||
        existing.providerCallId !== input.providerCallId ||
        existing.tool !== input.tool ||
        existing.toolVersion !== input.toolVersion ||
        existing.inputSha256 !== researchJsonSha256(input.input) ||
        existing.resultSha256 !== researchJsonSha256(input.result)
      )
        throw new ConflictException(
          'Durable safe-read execution identity was reused inconsistently.',
        );
      return existing;
    }

    const completedAt = new Date().toISOString();
    const sealed = sealDurableResearchResult({
      executionId: input.executionId,
      providerCallId: input.providerCallId,
      runId: run.id,
      leaseEpoch: run.leaseEpoch,
      tool: input.tool,
      toolVersion: input.toolVersion,
      classifier: readOutcome.kind,
      input: input.input,
      result: input.result,
      completedAt,
    });
    const metadata = researchMetadata(current.metadata);
    const handoff = readResearchHandoff(current.metadata);
    let conversationId =
      handoff?.conversationId ??
      (typeof metadata.backingConversationId === 'string' ? metadata.backingConversationId : null);
    if (!conversationId) {
      const conversation = await tx.clioConversation.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: current.clientId,
          title: `Research: ${current.title}`,
          status: 'active',
          metadata: { researchSessionId: current.id } as Prisma.InputJsonObject,
        },
        select: { id: true },
      });
      conversationId = conversation.id;
    }
    const artifact = await tx.clioArtifact.create({
      data: {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        clientId: current.clientId,
        conversationId,
        title: 'Internal research safe-read result',
        kind: RESEARCH_SAFE_READ_ARTIFACT_KIND,
        contentType: 'application/json',
        bodyText: sealed.body,
        metadata: {
          serverOnly: true,
          researchSessionId: current.id,
          executionId: input.executionId,
          bodySha256: sealed.bodySha256,
          byteSize: sealed.byteSize,
        } as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    const receiptBase =
      conversationId === metadata.backingConversationId
        ? current.metadata
        : { ...metadata, backingConversationId: conversationId };
    const appended = appendDurableResearchResultReceipt(receiptBase, run, {
      receiptId: `${run.id}:${run.leaseEpoch}:${input.executionId}`,
      toolCallId: input.providerCallId,
      tool: input.tool,
      label: humanToolLabel(input.tool),
      status: 'complete',
      summary: 'Authorized read completed',
      completedAt,
      executionId: input.executionId,
      providerCallId: input.providerCallId,
      toolVersion: input.toolVersion,
      inputSha256: sealed.envelope.inputSha256,
      resultSha256: sealed.envelope.resultSha256,
      resultBodySha256: sealed.bodySha256,
      resultRef: artifact.id,
      resultByteSize: sealed.byteSize,
      classifier: sealed.envelope.classifier,
    });
    const changed = await this.updateActiveResearchRun(
      tx,
      ctx,
      current.id,
      run,
      current.metadata,
      appended.metadata,
      current.status,
      new Date(),
    );
    if (!changed) throw new ConflictException('Research lease changed while saving progress.');
    return appended.receipt;
  }

  private async replaySession(
    ctx: TenantContext,
    id: string,
    sse: SseSink,
    phase: ResearchRunPhase,
  ) {
    const session = await this.getSession(ctx, id);
    const metadata = researchMetadata(session.metadata);
    sse.write(sseEvent({ type: 'run', run: session.run }));
    if (session.report) {
      sse.write(
        sseEvent({
          type: 'report',
          artifactId: session.report.id,
          body: session.report.bodyText ?? '',
          reportMetadata: session.reportMetadata,
          messageId: metadata.reportMessageId,
          conversationId:
            readResearchHandoff(session.metadata)?.conversationId ?? metadata.backingConversationId,
        }),
      );
    } else if (phase === 'plan') {
      sse.write(sseEvent({ type: 'title', title: session.title }));
      sse.write(sseEvent({ type: 'plan', plan: asStringArray(session.plan) }));
      sse.write(
        sseEvent({ type: 'clarify', questions: asStringArray(session.clarifyingQuestions) }),
      );
    }
    sse.write(
      sseEvent({
        type: 'done',
        ...(phase === 'plan' && typeof metadata.planMessageId === 'string'
          ? { messageId: metadata.planMessageId }
          : {}),
      }),
    );
  }

  /** Row update locks the lease inside the same transaction as the artifact write. */
  private async fenceRun(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    id: string,
    auth: ResearchRuntimeAuth,
  ) {
    if (!auth.run || auth.signal?.aborted)
      throw new ConflictException('Research stopped before its result could be saved.');
    const now = new Date();
    const rows = await tx.$queryRawUnsafe<Array<{ metadata_jsonb: Prisma.JsonValue }>>(
      ACTIVE_RESEARCH_RUN_FENCE_SQL,
      id,
      ctx.tenantId,
      ctx.userId,
      auth.run.phase === 'plan' ? 'plan' : 'researching',
      auth.run.id,
      auth.run.leaseEpoch,
      auth.run.phase,
      researchLeaseCutoff(now),
      now,
    );
    if (!rows.length)
      throw new ConflictException(
        'This research attempt no longer owns the run. Refresh to recover its current status.',
      );
    return rows[0]!.metadata_jsonb;
  }

  private async markFailed(
    ctx: TenantContext,
    id: string,
    auth: ResearchRuntimeAuth,
    failureReason = 'Research did not complete',
  ) {
    if (!auth.run) return;
    try {
      const current = await this.ensureSession(ctx, id);
      const currentRun = readResearchRun(current.metadata);
      if (
        currentRun?.id !== auth.run.id ||
        currentRun.leaseEpoch !== auth.run.leaseEpoch ||
        currentRun.status !== 'running' ||
        current.status === 'complete'
      )
        return;
      const leaseLost =
        auth.signal?.reason instanceof Error && auth.signal.reason.name === 'ResearchLeaseError';
      if (leaseLost) failureReason = auth.signal!.reason.message;
      const status = leaseLost
        ? 'interrupted'
        : auth.signal?.aborted
          ? 'cancelled'
          : /partial|did not complete|without a completed/i.test(failureReason)
            ? 'partial'
            : 'failed';
      const run = {
        ...terminalResearchRun(auth.run, status, failureReason),
        failureReason: failureReason.slice(0, 500),
      };
      const now = new Date();
      await this.prisma.withTenant(ctx.tenantId, (tx) =>
        this.updateActiveResearchRun(
          tx,
          ctx,
          id,
          auth.run!,
          current.metadata,
          { ...researchMetadata(current.metadata), run },
          status === 'cancelled' ? 'cancelled' : 'failed',
          now,
        ),
      );
    } catch (error) {
      this.logger.warn(
        `Could not persist research failure: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  // ── Phase 1: PLAN (streamed) ───────────────────────────────────────────────

  /**
   * Stream the PLAN phase: one model call that returns a plan + clarifying
   * questions. Persists them on the session and emits a `clarify` SSE event the
   * UI renders as an answer form.
   */
  private async runPlanStream(
    ctx: TenantContext,
    id: string,
    sse: SseSink,
    auth: ResearchRuntimeAuth = {},
  ) {
    const session = await this.ensureSession(ctx, id);
    sse.write(sseEvent({ type: 'phase', phase: 'plan' }));

    const clientContext = await this.clientContext(ctx, session.clientId);
    const admissionContext = this.researchPlanAdmissionContext(ctx, session);
    const system = buildResearchPlanSystemPrompt(PRODUCT_NAME, admissionContext);
    const handoff = readResearchHandoff(session.metadata);
    const user = [
      buildPlanUserPrompt(session.topic, clientContext),
      researchHandoffPrompt(handoff, session.id),
    ]
      .filter(Boolean)
      .join('\n\n');

    // The planning call emits nothing until it returns, and it may take as long
    // as CLIO_REQUEST_TIMEOUT_MS — which would otherwise be silence long enough
    // to trip the client's stall watchdog on a legitimately slow plan.
    const progress = createProgressReporter(sse, {
      intervalMs: positiveNumberOr(
        this.config.get('CLIO_RESEARCH_PROGRESS_INTERVAL_MS', { infer: true }),
        5_000,
      ),
      budgetMs: positiveNumberOr(
        this.config.get('CLIO_REQUEST_TIMEOUT_MS', { infer: true }),
        120_000,
      ),
    });
    progress.set('Planning the research…');

    let proposal: ResearchPlanV1;
    try {
      proposal = await this.requestAdmittedResearchPlan(
        ctx,
        session,
        admissionContext,
        system,
        user,
        auth,
      );
    } catch (err) {
      const privateMessage = err instanceof Error ? err.message : 'Planning failed';
      const message = projectResearchObserverError(err, auth.signal);
      this.logger.warn(`Research plan failed: ${privateMessage}`);
      // A failed provider is a recoverable failed attempt, never a fabricated plan.
      await this.markFailed(ctx, session.id, auth, message);
      sse.write(sseEvent({ type: 'error', message }));
      sse.write(sseEvent({ type: 'done' }));
      return;
    } finally {
      progress.stop();
    }

    const planMessageId = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const currentMetadata = await this.fenceRun(tx, ctx, session.id, auth);
      if (
        session.clientId &&
        !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, session.clientId))
      )
        throw new NotFoundException('Research session not found');
      if (
        handoff?.conversationId &&
        !(await tx.clioConversation.findFirst({
          where: {
            id: handoff.conversationId,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            clientId: session.clientId,
            archivedAt: null,
          },
          select: { id: true },
        }))
      )
        throw new BadRequestException(
          'The originating conversation is no longer available in this client scope',
        );
      const currentAdmissionContext = this.researchPlanAdmissionContext(ctx, {
        ...session,
        metadata: currentMetadata,
      });
      const admitted = validateResearchPlan(proposal, currentAdmissionContext);
      const stringPlan = researchPlanStringProjection(admitted);
      const persistedMetadata = {
        ...researchMetadata(currentMetadata),
        researchPlan: admitted,
        run: terminalResearchRun(
          auth.run!,
          'awaiting_clarification',
          admitted.clarifyingQuestions.length
            ? 'Waiting for your clarification answers'
            : 'Plan ready; research can begin',
        ),
      };
      await tx.clioResearchSession.update({
        where: { id: session.id },
        data: {
          title: clampTitle(admitted.title),
          plan: stringPlan as Prisma.InputJsonValue,
          clarifyingQuestions: admitted.clarifyingQuestions as Prisma.InputJsonValue,
          status: 'awaiting_clarification',
          metadata: persistedMetadata as unknown as Prisma.InputJsonObject,
          updatedAt: new Date(),
        },
      });
      const planMessage = handoff?.conversationId
        ? await tx.clioMessage.create({
            data: {
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              clientId: session.clientId,
              conversationId: handoff.conversationId,
              role: 'assistant',
              body:
                `Research plan — ${admitted.title}\n\n${stringPlan.map((step, index) => `${index + 1}. ${step}`).join('\n')}` +
                (admitted.clarifyingQuestions.length
                  ? `\n\nClarifying questions:\n${admitted.clarifyingQuestions.join('\n')}`
                  : ''),
              metadata: { researchSessionId: session.id },
            },
            select: { id: true },
          })
        : null;
      if (planMessage)
        await tx.clioResearchSession.update({
          where: { id: session.id },
          data: {
            metadata: {
              ...persistedMetadata,
              run: terminalResearchRun(auth.run!, 'awaiting_clarification', 'Plan ready'),
              planMessageId: planMessage.id,
            } as unknown as Prisma.InputJsonObject,
          },
        });
      return planMessage?.id ?? null;
    });

    sse.write(sseEvent({ type: 'title', title: proposal.title }));
    sse.write(sseEvent({ type: 'plan', plan: researchPlanStringProjection(proposal) }));
    sse.write(sseEvent({ type: 'clarify', questions: proposal.clarifyingQuestions }));
    sse.write(sseEvent({ type: 'done', ...(planMessageId ? { messageId: planMessageId } : {}) }));
  }

  // ── Phases 3+4: GATHER + SYNTHESIZE (streamed) ──────────────────────────────

  /**
   * Run the selected provider with read-only research tools. Both runtimes share
   * evidence checks and report persistence in the originating conversation.
   */
  private async runClaimedResearch(
    ctx: TenantContext,
    id: string,
    sse: SseSink,
    auth: ResearchRuntimeAuth = {},
  ) {
    // A research run can take minutes and emits no report text until current
    // publication authority is checked and the report is durably saved.
    // Without a heartbeat the reader stares at an empty assistant bubble for the
    // whole run with no way to tell "still gathering" from "dead stream". The
    // heartbeat lives out here so its interval is cleared on EVERY exit path,
    // including a throw out of the persist tail.
    const progress = createProgressReporter(sse, {
      intervalMs: positiveNumberOr(
        this.config.get('CLIO_RESEARCH_PROGRESS_INTERVAL_MS', { infer: true }),
        5_000,
      ),
      budgetMs: positiveNumberOr(
        this.config.get('CLIO_RESEARCH_TOTAL_BUDGET_MS', { infer: true }),
        1_800_000,
      ),
    });
    try {
      await this.runResearchStream(ctx, id, sse, progress, auth);
    } catch (error) {
      const privateMessage = error instanceof Error ? error.message : 'Research failed';
      const message = projectResearchObserverError(error, auth.signal);
      this.logger.warn(`Research run failed: ${privateMessage}`);
      await this.markFailed(ctx, id, auth, message);
      sse.write(sseEvent({ type: 'error', message }));
      sse.write(sseEvent({ type: 'done' }));
    } finally {
      progress.stop();
    }
  }

  private async runResearchStream(
    ctx: TenantContext,
    id: string,
    sse: SseSink,
    progress: ProgressReporter,
    auth: ResearchRuntimeAuth,
  ) {
    const session = await this.ensureSession(ctx, id);
    const admittedPlan = await this.admitResearchPlanForDispatch(ctx, session, auth);
    if (!auth.run) throw new ConflictException('Research dispatch requires an active run lease.');
    await this.assertRunActive(ctx, id, auth.run.id);

    const plan = researchPlanStringProjection(admittedPlan);
    const clarifyingQuestions = asStringArray(session.clarifyingQuestions);
    const clarifyingAnswers = asStringRecord(session.clarifyingAnswers);
    const clientContext = await this.clientContext(ctx, session.clientId);

    const handoff = readResearchHandoff(session.metadata);
    const user = [
      buildResearchUserPrompt({
        topic: session.topic,
        plan,
        clarifyingQuestions,
        clarifyingAnswers,
        clientContext,
      }),
      `ADMITTED RESEARCH PLAN CONTRACT v${admittedPlan.version}:\n${JSON.stringify(admittedPlan)}`,
      researchHandoffPrompt(handoff, session.id),
    ]
      .filter(Boolean)
      .join('\n\n');

    sse.write(sseEvent({ type: 'phase', phase: 'gather' }));
    if (this.v3Research && (await this.v3Research.enabled(ctx))) {
      // enabled() and the preparation above are asynchronous. Bind dispatch to
      // one fresh authorized row and the catalog observed after those awaits,
      // then carry only that accepted snapshot into the runner.
      const accepted = await this.admitFreshResearchPlanForDispatch(ctx, id, auth);
      const acceptedSession = accepted.session;
      const acceptedPlan = accepted.plan;
      const acceptedHandoff = readResearchHandoff(acceptedSession.metadata);
      const acceptedUser = [
        buildResearchUserPrompt({
          topic: acceptedSession.topic,
          plan: researchPlanStringProjection(acceptedPlan),
          clarifyingQuestions: asStringArray(acceptedSession.clarifyingQuestions),
          clarifyingAnswers: asStringRecord(acceptedSession.clarifyingAnswers),
          clientContext,
        }),
        `ADMITTED RESEARCH PLAN CONTRACT v${acceptedPlan.version}:\n${JSON.stringify(acceptedPlan)}`,
        researchHandoffPrompt(acceptedHandoff, acceptedSession.id),
      ]
        .filter(Boolean)
        .join('\n\n');
      progress.set(RESEARCH_OBSERVER_STATUS.startingRuntime);
      const result = await this.v3Research.run(
        ctx,
        {
          sessionId: acceptedSession.id,
          conversationId: acceptedHandoff?.conversationId ?? null,
          clientId: acceptedSession.clientId,
          system: buildResearchSystemPrompt(PRODUCT_NAME, { inheritChatOutputContract: true }),
          user: acceptedUser,
          handoff: acceptedHandoff,
          clientContext,
          admittedPlanExecution: {
            plan: acceptedPlan,
            allowedReadCapabilities: [
              ...new Set(
                acceptedPlan.steps
                  .flatMap((step) => step.allowedCapabilities)
                  .filter((name) => this.tools.isConcurrencySafe(name)),
              ),
            ].sort(),
          },
        },
        auth,
        (event) => {
          const projected = projectResearchObserverEvent(event, { receiptCandidates: true });
          if (!projected) return;
          // Progress follows observed provider/tool events, never an elapsed-time percentage.
          if (projected.type === 'step') progress.set(RESEARCH_OBSERVER_STATUS.readingSource);
          else if (projected.type === 'source')
            progress.set(RESEARCH_OBSERVER_STATUS.reviewingEvidence);
          if (projected.type === 'source') sse.writeReceiptCandidate?.(projected);
          else sse.write(sseEvent(projected));
        },
      );
      await this.finishResearch(ctx, acceptedSession, sse, progress, {
        ...result,
        runAuth: auth,
        auditorMode: await resolveTenantAuditorMode(this.prisma, ctx.tenantId),
        bufferReport: true,
      });
      return;
    }

    // BYOK: run Deep Research gather on the tenant's own key when set, else the
    // global fallback (resolver). Model stays CLIO_RESEARCH_MODEL.
    const resolved = await this.aiCredentials.resolveProvider(ctx, 'anthropic');
    if (!resolved) {
      throw new BadRequestException('ANTHROPIC_API_KEY not configured');
    }
    const anthropicKey = resolved.apiKey;

    const model = this.config.get('CLIO_RESEARCH_MODEL', { infer: true });
    const maxTokens = this.config.get('CLIO_RESEARCH_MAX_TOKENS', { infer: true });
    // Extended thinking (F3): research gather/synthesize is deep work by
    // definition, so it always qualifies when the feature is enabled.
    const thinkingSettings: ThinkingSettings = {
      enabled: this.config.get('CLIO_EXTENDED_THINKING', { infer: true }),
      mode: this.config.get('CLIO_THINKING_MODE', { infer: true }),
      budgetTokens: this.config.get('CLIO_RESEARCH_THINKING_BUDGET_TOKENS', { infer: true }),
    };
    const thinking = thinkingRequestParams(thinkingSettings, 'deep', maxTokens);
    // Deep research uses its OWN (much longer) per-request timeout, not the
    // short interactive-chat one — a single gather/synthesis turn runs minutes.
    const timeoutMs = this.config.get('CLIO_RESEARCH_TIMEOUT_MS', { infer: true });
    const maxRounds = this.config.get('CLIO_RESEARCH_MAX_TOOL_ROUNDS', { infer: true });
    // HARD wall-clock ceiling for the whole run. The per-round timeout above only
    // bounds ONE model call, so the previous effective bound was maxRounds ×
    // timeoutMs (10 × 600s ≈ 100 minutes) — long enough that a live run and a
    // hung one look identical in the drawer. Gathering stops taking new rounds
    // once the budget minus the synthesis reserve is spent, and each round's
    // timeout is clamped to the budget that remains.
    const totalBudgetMs = positiveNumberOr(
      this.config.get('CLIO_RESEARCH_TOTAL_BUDGET_MS', { infer: true }),
      1_800_000,
    );
    const synthesisReserveMs = Math.min(
      positiveNumberOr(
        this.config.get('CLIO_RESEARCH_SYNTHESIS_RESERVE_MS', { infer: true }),
        480_000,
      ),
      // Never reserve so much that gathering gets no time at all.
      Math.floor(totalBudgetMs / 2),
    );
    const deadlineAt = Date.now() + totalBudgetMs;
    progress.set(RESEARCH_OBSERVER_STATUS.reviewingPlan);
    // Deep Research is a read-only GATHER agent: it must NOT be able to call
    // side-effecting tools (send_email/reply_email/save_memory/create_task/
    // update_client_profile/docgen/...). A long-running agentic loop over the full
    // tool set could otherwise autonomously send mail or mutate data. Filter to
    // concurrency-safe (== read-only, i.e. not in SIDE_EFFECTING_TOOLS) tools;
    // the final report is persisted by this service, not via a write tool. This
    // mirrors the read-only hardening on the scheduled-tasks runner.
    const admittedCapabilities = new Set(
      admittedPlan.steps.flatMap((step) => step.allowedCapabilities),
    );
    const toolSchemas = this.tools
      .anthropicToolSchemas({ tenantId: ctx.tenantId, surface: 'chat' })
      .filter((s) => admittedCapabilities.has(s.name) && this.tools.isConcurrencySafe(s.name));
    const system = buildResearchSystemPrompt(PRODUCT_NAME);

    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      {
        role: 'user',
        content: user,
      },
    ];

    let reportBody = '';
    const sources: SourceAttribution[] = [];
    const toolsUsed: string[] = [];
    // Session client name for the client-scope refusal below — resolved at most
    // once per run, and only if the model actually asks for another client.
    let sessionClientName: string | null | undefined;
    const resolveSessionClientName = async (): Promise<string | null> => {
      if (sessionClientName === undefined) {
        sessionClientName = session.clientId
          ? await this.prisma
              .withTenant(ctx.tenantId, (tx) =>
                tx.client.findFirst({
                  where: { id: session.clientId as string },
                  select: { name: true },
                }),
              )
              .then((c) => c?.name ?? null)
              .catch(() => null)
          : null;
      }
      return sessionClientName;
    };
    // Wave-2 post-hoc auditor ledger for the research surface (the most dangerous
    // one — the S3 fabrication cluster). Accumulates successful tool results
    // across gather rounds; audited after synthesis.
    const ledgerEntries: LedgerEntry[] = [];
    // Report prose is a publication surface, unlike progress/thinking/source
    // events. Buffer it for every auditor mode until current authorization and
    // durable persistence both succeed. Enforce mode additionally explains the
    // delayed delivery because its grounding audit may replace prose with a hold
    // notice.
    const auditorMode = await resolveTenantAuditorMode(this.prisma, ctx.tenantId);
    const bufferReport = true;
    // Say so, once, instead of letting the reader interpret a silent empty bubble
    // as a broken run. Unknown event types are ignored by older clients.
    if (auditorMode === 'enforce') {
      sse.write(
        sseEvent({
          type: 'notice',
          message:
            'Grounding checks run before delivery on this workspace, so the report arrives ' +
            'in one piece when it passes rather than streaming as it is written.',
        }),
      );
    }
    let synthesizing = false;
    // True only when the agentic loop ended because the model stopped calling
    // tools and wrote its report. If it ends any other way (tool-round budget
    // exhausted, or a round aborted on timeout) the report was never written, so
    // the forced-synthesis pass below MUST run.
    let endedCleanly = false;

    try {
      for (let round = 0; round < maxRounds; round += 1) {
        if (auth.run) await this.assertRunActive(ctx, id, auth.run.id);
        if (auth.signal?.aborted) throw new BadRequestException('Research was cancelled.');
        // Budget gate: stop opening new gather rounds once the reserve is all
        // that's left. Falling out here leaves endedCleanly === false, so the
        // forced-synthesis pass below still writes a report from the evidence
        // gathered so far — the run ends early, never empty.
        const gatherRemainingMs = deadlineAt - synthesisReserveMs - Date.now();
        if (gatherRemainingMs <= 0) {
          this.logger.warn(
            `Research gather budget spent after ${round} round(s) ` +
              `(budget ${totalBudgetMs}ms, reserve ${synthesisReserveMs}ms); forcing synthesis`,
          );
          break;
        }
        progress.set(RESEARCH_OBSERVER_STATUS.gatheringEvidence);
        const controller = new AbortController();
        // Clamp the per-call timeout to the budget that's actually left, so one
        // slow round can't consume time the report needs.
        const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, gatherRemainingMs));
        const toolUseById = new Map<number, { id: string; name: string; jsonParts: string[] }>();
        const thinkingState = createThinkingState();
        let thinkingStatusSent = false;
        let stopReason: string | null = null;

        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(
              prepareAnthropicRequest({
                model,
                max_tokens: thinking.maxTokens,
                // Zero-trust Wave 1 (RC8): temperature 0.2 on the figure-heavy
                // research rounds — but ONLY when extended thinking is off
                // (Anthropic rejects temperature != 1 alongside a thinking block).
                ...(thinking.thinking ? { thinking: thinking.thinking } : { temperature: 0.2 }),
                stream: true,
                system,
                tools: toolSchemas,
                messages,
              }),
            ),
            signal: auth.signal
              ? AbortSignal.any([controller.signal, auth.signal])
              : controller.signal,
          });

          if (!response.ok || !response.body) {
            const errText = await response.text().catch(() => '');
            throw new Error(
              `Anthropic HTTP ${response.status}${errText ? `: ${errText.slice(0, 300)}` : ''}`,
            );
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
                // Provider thinking is retained only for the signed replay block
                // required by the next provider round. Observer frames receive a
                // fixed source-independent status, never provider reasoning text.
                const thinkingDelta = applyThinkingStreamEvent(thinkingState, evt);
                if (thinkingDelta.thinkingTextDelta && !thinkingStatusSent) {
                  thinkingStatusSent = true;
                  progress.set(RESEARCH_GATHER_THINKING_STATUS);
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
                    // The first streamed prose marks the transition into synthesis.
                    if (!synthesizing) {
                      synthesizing = true;
                      sse.write(sseEvent({ type: 'phase', phase: 'synthesize' }));
                    }
                    reportBody += delta.text;
                    // The publication tail releases report text after authorization
                    // and durable persistence (see bufferReport above).
                    if (!bufferReport) sse.write(sseEvent({ type: 'text', text: delta.text }));
                  } else if (
                    delta.type === 'input_json_delta' &&
                    typeof delta.partial_json === 'string'
                  ) {
                    toolUseById.get(evt.index)?.jsonParts.push(delta.partial_json);
                  }
                } else if (evt.type === 'message_delta') {
                  stopReason = evt.delta?.stop_reason ?? stopReason;
                }
              } catch {
                /* incomplete chunk */
              }
            }
          }
        } catch (roundErr) {
          // A per-round abort means this model turn exceeded the (long) research
          // timeout. Don't let it kill the whole run — stop gathering and fall
          // through to the forced-synthesis pass so we still write a report
          // rather than persisting only the sources gathered so far.
          if (isAbortError(roundErr)) {
            this.logger.warn(`Research gather round ${round} timed out; forcing synthesis`);
            break;
          }
          throw roundErr;
        } finally {
          clearTimeout(timer);
        }

        // If the model did not request tools, it wrote its final report.
        if (stopReason !== 'tool_use' || toolUseById.size === 0) {
          endedCleanly = stopReason === 'end_turn';
          break;
        }

        const orderedTools = [...toolUseById.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => v);

        // Thinking blocks first (the API requires them replayed with
        // signatures when tools are used — F3), then tool_use blocks.
        const assistantTurn: Array<Record<string, unknown>> = [
          ...thinkingReplayBlocks(thinkingState),
        ];
        for (const t of orderedTools) {
          if (auth.signal?.aborted) throw new BadRequestException('Research was cancelled.');
          if (auth.run) await this.assertRunActive(ctx, id, auth.run.id);
          let parsedInput: Record<string, unknown> = {};
          const raw = t.jsonParts.join('');
          if (raw.trim()) {
            try {
              parsedInput = JSON.parse(raw);
            } catch {
              parsedInput = {};
            }
          }
          assistantTurn.push({ type: 'tool_use', id: t.id, name: t.name, input: parsedInput });
        }
        messages.push({ role: 'assistant', content: assistantTurn });

        const toolResultBlocks: Array<Record<string, unknown>> = [];
        for (const t of orderedTools) {
          if (auth.signal?.aborted) throw new BadRequestException('Research was cancelled.');
          if (auth.run) await this.assertRunActive(ctx, id, auth.run.id);
          let parsedInput: Record<string, unknown> = {};
          const raw = t.jsonParts.join('');
          if (raw.trim()) {
            try {
              parsedInput = JSON.parse(raw);
            } catch {
              parsedInput = {};
            }
          }
          // Client scope is ENFORCED, not merely defaulted (2026-07-29) — the
          // same rule as the chat loop in meri.service.ts. An omitted clientId
          // is filled from the session; a DIFFERENT one is refused rather than
          // rewritten, so a client-scoped research report can never be built
          // from another client's rows.
          let scopeViolation: string | undefined;
          if (session.clientId) {
            const supplied =
              typeof parsedInput.clientId === 'string' ? parsedInput.clientId.trim() : '';
            if (!supplied) {
              if (!isMeriMailReadTool(t.name)) parsedInput.clientId = session.clientId;
            } else if (supplied !== session.clientId) {
              const name = CLIENT_ID_UUID_RE.test(supplied)
                ? null
                : await resolveSessionClientName();
              if (name && supplied.toLowerCase() === name.toLowerCase()) {
                parsedInput.clientId = session.clientId;
              } else {
                scopeViolation = clientScopeRefusal(await resolveSessionClientName());
              }
            }
          }
          let resultPayload: unknown;
          let isError = false;
          const toolSchema = toolSchemas.find((schema) => schema.name === t.name);
          const toolVersion = toolSchema ? researchToolVersion(toolSchema.input_schema) : '';
          const publicTool = publicResearchSourceTool(t.name);
          const observerToolQualified = Boolean(
            !scopeViolation &&
              publicTool &&
              toolSchema &&
              toolVersion &&
              this.tools.isConcurrencySafe(t.name),
          );
          const step = projectResearchObserverEvent({
            type: 'tool_call',
            tool: observerToolQualified ? publicTool : null,
          });
          if (step?.type === 'step') sse.write(sseEvent(step));
          progress.set(RESEARCH_OBSERVER_STATUS.readingSource);
          let replayedReceipt: Record<string, unknown> | undefined;
          if (scopeViolation) {
            isError = true;
            resultPayload = { error: scopeViolation };
            this.logger.warn(
              `Deep Research blocked an out-of-scope client read: ${t.name} (session ${session.id})`,
            );
          } else if (!admittedCapabilities.has(t.name)) {
            isError = true;
            resultPayload = { error: `Tool "${t.name}" is outside the admitted research plan` };
            this.logger.warn(
              `Deep Research blocked an out-of-plan tool call: ${t.name} (session ${session.id})`,
            );
          } else if (!this.tools.isConcurrencySafe(t.name)) {
            // Defense-in-depth: never execute a side-effecting tool in the
            // read-only research loop, even if one somehow reaches this point
            // (schema-filter regression, model hallucinating a tool name).
            isError = true;
            resultPayload = { error: `Tool "${t.name}" is not permitted in read-only research` };
            this.logger.warn(
              `Deep Research blocked a side-effecting tool call: ${t.name} (session ${session.id})`,
            );
          } else {
            try {
              const replay =
                auth.run && toolVersion
                  ? await this.replaySafeReadOutcome(ctx, id, auth.run.id, {
                      leaseEpoch: auth.run.leaseEpoch,
                      tool: t.name,
                      toolVersion,
                      input: parsedInput,
                    })
                  : { replayed: false as const };
              if (replay.replayed) {
                resultPayload = replay.result;
                replayedReceipt = replay.durableSafeRead;
              } else {
                resultPayload = await withMeriToolExecutionControl(
                  { signal: auth.signal, deadlineAt },
                  () => this.tools.execute(ctx, t.name as never, parsedInput),
                );
              }
            } catch (err) {
              isError = true;
              resultPayload = {
                error: err instanceof Error ? err.message : 'Tool execution failed',
              };
            }
          }

          const readOutcome = isError ? null : classifyApiToolReadOutcome(t.name, resultPayload);
          const qualifiedSuccess =
            readOutcome?.kind === 'complete' || readOutcome?.kind === 'empty';
          if (readOutcome?.kind === 'failed' || readOutcome?.kind === 'unavailable') {
            isError = true;
          }
          const { count } = summarizeToolResultForTrust(resultPayload);
          const observerQualifiedSuccess = Boolean(
            qualifiedSuccess && observerToolQualified && t.id && publicTool,
          );
          const source: SourceAttribution = {
            tool: publicTool ?? 'research_source',
            label: 'Research source',
            count: count ?? undefined,
            summary: 'Authorized read completed',
            confidence: 'high',
          };
          if (observerQualifiedSuccess) {
            sources.push(source);
            toolsUsed.push(publicTool!);
          }
          progress.set(
            observerQualifiedSuccess
              ? RESEARCH_OBSERVER_STATUS.sourceFinished
              : RESEARCH_OBSERVER_STATUS.sourceNeedsAttention,
          );
          if (observerQualifiedSuccess) {
            const candidate = projectResearchObserverEvent(
              {
                type: 'source',
                source,
                  durableSafeRead: replayedReceipt ?? {
                    outcome: 'complete',
                    executionId: randomUUID(),
                    toolCallId: t.id,
                    tool: publicTool,
                    toolVersion,
                    input: parsedInput,
                    result: resultPayload,
                    ...(typeof count === 'number' ? { recordsReturned: count } : {}),
                  },
              },
              { receiptCandidates: true },
            );
            if (candidate) sse.writeReceiptCandidate?.(candidate);
          }
          // The result receipt and private payload must commit before this
          // owner result is returned to the provider for the next model turn.
          if (observerQualifiedSuccess) await sse.flush?.();

          const serialized = summarizeJsonForPrompt(resultPayload, 12_000);
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: t.id,
            is_error: isError,
            content: serialized,
          });
          if (!isError) {
            ledgerEntries.push({
              tool: t.name,
              serialized,
              result: resultPayload,
              rowCount: count ?? undefined,
            });
          }
        }
        messages.push({ role: 'user', content: toolResultBlocks });
      }

      // FORCED SYNTHESIS. The agentic loop can end WITHOUT the model ever
      // writing its report — it exhausted the tool-round budget while still
      // gathering, or a round hit the research timeout (endedCleanly === false).
      // In those cases any text streamed so far is gather-phase narration ("I'll
      // search X, then Y…"), NOT the report — exactly the "it only tells me what
      // it searched / only sources" symptom. Also force a pass if the loop ended
      // cleanly but produced no prose. Make one final NO-TOOLS call so the model
      // must produce the report from the evidence it already gathered.
      if (!endedCleanly || !reportBody.trim()) {
        if (auth.run) await this.assertRunActive(ctx, id, auth.run.id);
        if (auth.signal?.aborted) throw new BadRequestException('Research was cancelled.');
        endedCleanly = false;
        // Discard gather-phase narration so the forced pass writes a clean
        // report instead of appending it to the narration.
        if (!endedCleanly) reportBody = '';
        messages.push({
          role: 'user',
          content:
            'The research budget is ending. Do NOT call any more tools. Clearly identify missing evidence and material uncertainty. Write the decision-grade ' +
            'research report NOW, in markdown, following the report requirements: Executive Summary, ' +
            'plan-driven sections with inline source citations, Recommended Actions, and Open Questions.',
        });
        progress.set(RESEARCH_OBSERVER_STATUS.writingReport);
        const controller = new AbortController();
        // Synthesis gets whatever budget remains, but never less than a floor: if
        // gathering already blew through the budget, handing the writer a 0ms
        // window would abort instantly and deliver sources with no report — the
        // exact failure this forced pass exists to prevent. So the worst-case
        // ceiling is budget + floor, not budget exactly. The floor itself never
        // exceeds the configured per-call timeout.
        const synthesisFloorMs = Math.min(
          timeoutMs,
          Math.max(synthesisReserveMs, SYNTHESIS_FLOOR_MS),
        );
        const synthesisTimeoutMs = Math.max(
          synthesisFloorMs,
          Math.min(timeoutMs, deadlineAt - Date.now()),
        );
        const timer = setTimeout(() => controller.abort(), synthesisTimeoutMs);
        let thinkingStatusSent = false;
        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(
              prepareAnthropicRequest({
                model,
                max_tokens: thinking.maxTokens,
                // Zero-trust Wave 1 (RC8): temperature 0.2 on the figure-heavy
                // research rounds — but ONLY when extended thinking is off
                // (Anthropic rejects temperature != 1 alongside a thinking block).
                ...(thinking.thinking ? { thinking: thinking.thinking } : { temperature: 0.2 }),
                stream: true,
                system,
                // No `tools` key → the model cannot call tools and must answer.
                messages,
              }),
            ),
            signal: auth.signal
              ? AbortSignal.any([controller.signal, auth.signal])
              : controller.signal,
          });
          if (!response.ok || !response.body) {
            const errText = await response.text().catch(() => '');
            throw new Error(
              `Anthropic HTTP ${response.status}${errText ? `: ${errText.slice(0, 300)}` : ''}`,
            );
          }
          if (!synthesizing) {
            synthesizing = true;
            sse.write(sseEvent({ type: 'phase', phase: 'synthesize' }));
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
                if (evt.type === 'message_delta' && evt.delta?.stop_reason === 'end_turn')
                  endedCleanly = true;
                if (
                  evt.type === 'content_block_delta' &&
                  evt.delta?.type === 'thinking_delta' &&
                  typeof evt.delta.thinking === 'string'
                ) {
                  // Do not put provider reasoning on the observer stream. A fixed
                  // status preserves liveness without revealing source content.
                  if (!thinkingStatusSent) {
                    thinkingStatusSent = true;
                    progress.set(RESEARCH_SYNTHESIS_THINKING_STATUS);
                  }
                } else if (
                  evt.type === 'content_block_delta' &&
                  evt.delta?.type === 'text_delta' &&
                  typeof evt.delta.text === 'string'
                ) {
                  reportBody += evt.delta.text;
                  // The publication tail releases report text after authorization
                  // and durable persistence (see bufferReport above).
                  if (!bufferReport) sse.write(sseEvent({ type: 'text', text: evt.delta.text }));
                }
              } catch {
                /* incomplete chunk */
              }
            }
          }
        } catch (synthErr) {
          // Keep whatever prose streamed before an abort rather than discarding
          // it — a partial report is still more useful than sources alone.
          if (isAbortError(synthErr)) {
            this.logger.warn('Forced research synthesis timed out; keeping partial report');
          } else {
            throw synthErr;
          }
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (err) {
      const privateMessage = err instanceof Error ? err.message : 'Research failed';
      this.logger.warn(`Research run failed: ${privateMessage}`);
      sse.write(sseEvent({ type: 'error', message: RESEARCH_PROVIDER_FAILURE }));
    }

    if (auth.signal?.aborted) throw new BadRequestException('Research was cancelled.');
    if (!endedCleanly)
      throw new BadRequestException(
        'Research did not complete; partial provider output has not been released as a report.',
      );
    await this.finishResearch(ctx, session, sse, progress, {
      reportBody,
      sources,
      toolsUsed,
      ledgerEntries,
      model,
      auditorMode,
      bufferReport,
      runAuth: auth,
      producerClientContext: clientContext,
    });
  }

  private async finishResearch(
    ctx: TenantContext,
    session: Awaited<ReturnType<MeriResearchService['ensureSession']>>,
    sse: SseSink,
    progress: ProgressReporter,
    result: {
      runAuth: ResearchRuntimeAuth;
      reportBody: string;
      sources: SourceAttribution[];
      toolsUsed: string[];
      ledgerEntries: LedgerEntry[];
      model: string;
      auditorMode: Awaited<ReturnType<typeof resolveTenantAuditorMode>>;
      bufferReport: boolean;
      citations?: MeriCitation[];
      retrieval?: MeriV3RetrievalStreamSummary;
      telemetry?: MeriV3ProviderTelemetry;
      providerCalls?: MeriV3ProviderTelemetry[];
      evidenceManifest?: MeriEvidenceManifest;
      producerInputEvaluated?: true;
      producerInputSha256?: string;
      producerInputMode?: 'source_free' | 'covered_inputs' | 'unsupported_private_inputs';
      clientContextSha256?: string | null;
      producerClientContext?: string | null;
    },
  ) {
    // Source completions are fenced and saved before report persistence or observer delivery.
    await sse.flush?.();
    let { reportBody } = result;
    const { sources, toolsUsed, ledgerEntries, model, auditorMode, bufferReport } = result;
    const plan = asStringArray(session.plan);
    const handoff = readResearchHandoff(session.metadata);
    if (!reportBody.trim())
      throw new BadRequestException('Research did not produce a report. Please retry.');
    // Strip unresolved FORM B [S:tool:record_id] tokens from the report BEFORE
    // the auditor + persist. The research prompt instructs a FORM-B token on
    // every material claim, so a token whose tool wasn't called this turn (or
    // whose record_id isn't verbatim in that tool's result) lends false
    // authority to a likely-fabricated sentence. Mirrors the chat loops (which
    // strip persisted history) and workspace doc-gen (which strips delivered
    // HTML) — research was the one delivered surface still carrying them. Runs
    // before runAuditor below so a stray unresolved token no longer counts
    // toward a D1 hold; the underlying claim, if fabricated, is still caught by
    // the content checks (D2/D4/D7/D11).
    if (reportBody.trim().length > 0) {
      const formB = validateFormBCitations(reportBody, ledgerToToolResultMap(ledgerEntries));
      if (formB.invalid.length) {
        this.logger.warn(
          `[meri-research] stripped ${formB.invalid.length} unresolved FORM B citation(s) ` +
            `from the report: ${formB.invalid.join(', ')}`,
        );
        reportBody = formB.sanitizedText;
      }
    }

    const evidenceAccuracyMode = resolveEvidenceAccuracyModeForTenant(ctx.tenantId, 'research');
    if (evidenceAccuracyMode === 'enforce' && reportBody.trim().length > 0) {
      const formA = validateCitationMarkers(reportBody, result.citations ?? []);
      if (formA.dropped.length) {
        this.logger.warn('meri.citation_integrity', {
          conversationId: readResearchHandoff(session.metadata)?.conversationId ?? null,
          turnId: session.id,
          surface: 'research_report',
          dropped: formA.dropped,
          registered: result.citations?.length ?? 0,
          mode: evidenceAccuracyMode,
        });
      }
      reportBody = formA.cleanedText;
    }

    // Wave-2 post-hoc auditor on the RESEARCH surface — SHADOW by default
    // (MERI_AUDITOR_MODE off = no-op). Research is the most dangerous surface, so
    // extending shadow coverage here is high-value: it re-derives ground truth
    // from the gather-loop ledger and logs/persists any contradiction in the
    // synthesized report WITHOUT altering it. Fully guarded; never breaks a run.
    // held: true only when the auditor returns decision==='hold' (enforce mode +
    // a finding on this blocking surface). Research has no external send/file to
    // block, so "hold" = the persisted report artifact is marked heldForReview
    // (and its body already carries the Unverified banner below), so a flagged
    // report is never presented as a cleared deliverable. Inert under shadow/
    // annotate (decision is never 'hold' there), so the default flow is unchanged.
    let held = false;
    let heldReason = '';
    if (auditorMode !== 'off' && reportBody.trim().length > 0) {
      progress.set(RESEARCH_OBSERVER_STATUS.checkingReport);
      try {
        const verdict = runAuditor({
          output: reportBody,
          ledger: { entries: ledgerEntries },
          surface: 'research',
          mode: auditorMode,
        });
        if (verdict.findings.length > 0) {
          this.logger.warn(
            `[meri-auditor:${auditorMode}] research session ${session.id} — ${verdict.findings.length} finding(s), ` +
              `top=${verdict.topSeverity}, decision=${verdict.decision}: ` +
              verdict.findings.map((f) => `${f.check}/${f.severity}`).join(', '),
          );
          await this.prisma.withTenant(ctx.tenantId, (tx) =>
            tx.meriAuditLedger.create({
              data: {
                tenantId: ctx.tenantId,
                surface: 'research',
                mode: auditorMode,
                decision: verdict.decision,
                topSeverity: verdict.topSeverity ?? null,
                findingCount: verdict.findings.length,
                findings: verdict.findings as unknown as Prisma.InputJsonValue,
                outputChars: reportBody.length,
              },
            }),
          );
          // Degraded mode (v3 plan §3.6): research is fully-blocking. SHADOW only
          // logs+persists (above); ANNOTATE/ENFORCE additionally prepend an
          // Unverified banner naming the held findings to the PERSISTED report,
          // so a flagged report can never present its findings as confirmed.
          // Inert while mode is shadow (the default) — this branch is skipped.
          if (auditorMode === 'annotate' || auditorMode === 'enforce') {
            const checks = [...new Set(verdict.findings.map((f) => f.check))].join(', ');
            reportBody =
              `> ⚠️ **Unverified — ${verdict.findings.length} grounding finding(s) held for review ` +
              `(${checks}).** Treat flagged claims as unconfirmed until a reviewer clears them.\n\n` +
              reportBody;
          }
          // Enforce = hold: mark the persisted artifact/session heldForReview
          // below. decisionFor() returns 'hold' only in enforce mode, so this is
          // inert under shadow/annotate.
          held = verdict.decision === 'hold';
          if (held) {
            heldReason = `Grounding auditor: ${verdict.findings
              .map((f) => `${f.check} (${f.severity}): ${f.detail}`)
              .join('; ')}`.slice(0, 2000);
          }
        }
      } catch (err) {
        this.logger.warn(
          `[meri-auditor] research audit failed (run unaffected): ${(err as Error).message}`,
        );
      }
    }

    // Report deltas were withheld above. Deliver only after publication checks
    // and persistence below — the full body when cleared, or a hold notice
    // instead when grounding enforcement held it.
    const heldNotice =
      `> ⏸️ **Report held for review.** The grounding auditor flagged this report under ` +
      `enforce mode and it was not delivered. A reviewer must approve it in Reviews before ` +
      `the content is released; the saved report is marked *held for review*.` +
      (heldReason ? `\n>\n> ${heldReason.slice(0, 500)}` : '');

    // Persist the report artifact + link it to the session.
    progress.set(RESEARCH_OBSERVER_STATUS.savingReport);
    const artifactBody = assembleReportArtifact({
      title: session.title,
      topic: session.topic,
      plan,
      reportBody,
      sources,
      citations: result.citations,
      generatedAt: new Date(),
    });
    const inheritedCitationCount =
      handoff?.messages.reduce((count, message) => {
        const citations = researchMetadata(message.metadata).citations;
        return count + (Array.isArray(citations) ? citations.length : 0);
      }, 0) ?? 0;
    const producerInput = result.producerInputEvaluated
      ? {
          producerInputSha256: result.producerInputSha256,
          producerInputMode: result.producerInputMode,
          clientContextSha256: result.clientContextSha256 ?? null,
        }
      : certifyResearchProducerInputs({
          hashMaterial: {
            sessionId: session.id,
            runId: result.runAuth.run!.id,
            leaseEpoch: result.runAuth.run!.leaseEpoch,
            topicSha256: researchJsonSha256(session.topic),
            planSha256: researchJsonSha256(plan),
            handoffSha256: researchJsonSha256(handoff),
          },
          toolsUsed,
          clientContext: result.producerClientContext,
          handoffSummaryPresent: Boolean(handoff?.summary),
          handoffAttachmentCount: handoff?.attachments.length ?? 0,
          assistantHandoffTurns:
            handoff?.messages.filter((message) => message.role === 'assistant').length ?? 0,
          inheritedCitationCount,
          inheritedUnavailableCount: 0,
          inheritedOmittedCount: 0,
          contextPacketItemCount: result.runAuth.governedContext?.contextPacket.items.length ?? 0,
          unreceiptedLedgerEntryCount: ledgerEntries.filter(
            (entry) => !toolsUsed.includes(entry.tool),
          ).length,
        });
    if (!producerInput.producerInputSha256 || !producerInput.producerInputMode)
      throw new ConflictException('The research report producer proof is unavailable.');
    if (producerInput.producerInputMode === 'unsupported_private_inputs')
      throw new ConflictException(
        'The research report includes private producer inputs without a current authorization adapter.',
      );
    await this.assertReplayedReportSourcesAuthorized(
      ctx,
      session.id,
      result.runAuth.run!,
      toolsUsed,
      producerInput,
    );

    const retrieval = result.retrieval ?? result.runAuth.governedContext?.retrieval;
    const reportMetadata = {
      researchSessionId: session.id,
      researchReport: true,
      model,
      intent: 'deep_research',
      tier: handoff?.reasoningMode === 'fast' ? 'fast' : 'deep',
      plan,
      trustSteps: sources.map((source) => ({
        tool: source.tool,
        label: source.label,
        detail: source.summary,
        ...(source.count !== undefined ? { count: source.count } : {}),
        confidence: source.confidence,
        status: source.confidence === 'low' ? 'error' : 'done',
      })),
      ...(result.runAuth.governedContext
        ? {
            contextPacketId: result.runAuth.governedContext.contextPacket.packetId,
          }
        : {}),
      ...(retrieval ? { retrieval } : {}),
      ...(handoff ? { reasoningMode: handoff.reasoningMode } : {}),
      ...(result.telemetry
        ? {
            telemetry: result.telemetry,
            reasoningEffort: result.telemetry.effectiveReasoningEffort,
            finishReason: result.telemetry.finishReason,
            partial: result.telemetry.partial,
          }
        : {}),
      ...(result.providerCalls ? { providerCalls: result.providerCalls } : {}),
      ...(result.evidenceManifest ? { evidenceManifest: result.evidenceManifest } : {}),
      ...(result.citations ? { citations: result.citations } : {}),
      ...(held ? { heldForReview: true } : {}),
    };

    const artifactId = randomUUID();
    const reportMessageId = handoff?.conversationId ? randomUUID() : null;
    const persisted = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const currentMetadata = await this.fenceRun(tx, ctx, session.id, result.runAuth);
      if (
        session.clientId &&
        !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, session.clientId))
      ) {
        throw new NotFoundException('Research session not found');
      }
      // Research started in chat stays in that thread. Standalone/older sessions
      // retain their existing backing conversation behavior.
      const existing = researchMetadata(currentMetadata).backingConversationId;
      let conversationId =
        handoff?.conversationId ?? (typeof existing === 'string' ? existing : null);
      if (handoff?.conversationId) {
        const origin = await tx.clioConversation.findFirst({
          where: {
            id: handoff.conversationId,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            clientId: session.clientId,
            archivedAt: null,
          },
          select: { id: true },
        });
        if (!origin)
          throw new BadRequestException(
            'The originating conversation is no longer available in this client scope',
          );
      }
      if (!conversationId) {
        const conversation = await tx.clioConversation.create({
          data: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            clientId: session.clientId ?? null,
            title: `Research: ${session.title}`,
            status: 'active',
            metadata: { researchSessionId: session.id } as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        conversationId = conversation.id;
      }

      const reportProvenance = buildResearchReportProvenance({
        artifactId,
        messageId: reportMessageId,
        sessionId: session.id,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        clientId: session.clientId,
        conversationId,
        runId: result.runAuth.run!.id,
        leaseEpoch: result.runAuth.run!.leaseEpoch,
        body: artifactBody,
        receipts: readDurableResearchStepReceipts(currentMetadata),
        toolsUsed,
        producerInputSha256: producerInput.producerInputSha256!,
        producerInputMode: producerInput.producerInputMode as 'source_free' | 'covered_inputs',
        clientContextSha256: producerInput.clientContextSha256,
      });
      const persistedReportMetadata = {
        ...reportMetadata,
        researchSessionId: session.id,
        reportArtifactId: artifactId,
        reportProvenance,
      };
      const reportMessage = reportMessageId
        ? await tx.clioMessage.create({
            data: {
              id: reportMessageId,
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              clientId: session.clientId,
              conversationId,
              role: 'assistant',
              body: held ? heldNotice : artifactBody,
              metadata: persistedReportMetadata as unknown as Prisma.InputJsonObject,
            },
            select: { id: true },
          })
        : null;
      const artifact = await tx.clioArtifact.create({
        data: {
          id: artifactId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: session.clientId ?? null,
          conversationId,
          ...(reportMessage ? { messageId: reportMessage.id } : {}),
          title: session.title,
          kind: 'research_report',
          contentType: 'text/markdown',
          bodyText: artifactBody,
          metadata: {
            ...persistedReportMetadata,
            researchSessionId: session.id,
            topic: session.topic,
            plan,
            toolsUsed,
            sourceCount: sources.length,
            model,
            ...(result.telemetry ? { telemetry: result.telemetry } : {}),
            ...(result.providerCalls ? { providerCalls: result.providerCalls } : {}),
            ...(result.evidenceManifest ? { evidenceManifest: result.evidenceManifest } : {}),
            ...(handoff
              ? {
                  reasoningMode: handoff.reasoningMode,
                  originatingConversationId: handoff.conversationId,
                }
              : {}),
            // Phase 2.5-1: set only under enforce+finding; consumers/UI treat a
            // held report as not-yet-cleared (its body carries the banner too).
            ...(held ? { heldForReview: true } : {}),
          } as unknown as Prisma.InputJsonObject,
        },
        select: { id: true },
      });
      await tx.clioResearchSession.update({
        where: { id: session.id },
        data: {
          status: 'complete',
          reportArtifactId: artifact.id,
          sources: sources as unknown as Prisma.InputJsonValue,
          metadata: {
            ...researchMetadata(currentMetadata),
            backingConversationId: conversationId,
            ...(result.citations ? { citations: result.citations } : {}),
            run: terminalResearchRun(
              result.runAuth.run!,
              'complete',
              held ? 'Report held for review' : 'Report saved',
            ),
            heldForReview: held,
            ...(result.telemetry ? { telemetry: result.telemetry } : {}),
            ...(result.providerCalls ? { providerCalls: result.providerCalls } : {}),
            ...(result.evidenceManifest ? { evidenceManifest: result.evidenceManifest } : {}),
            ...(reportMessage ? { reportMessageId: reportMessage.id } : {}),
            reportProvenance,
          } as unknown as Prisma.InputJsonObject,
          updatedAt: new Date(),
        },
      });
      if (handoff?.conversationId)
        await tx.clioConversation.update({
          where: { id: conversationId },
          data: { updatedAt: new Date() },
        });
      return { artifactId: artifact.id, messageId: reportMessage?.id ?? null, conversationId };
    });
    // Persistence and network publication are separate revocation boundaries.
    await this.assertReplayedReportSourcesAuthorized(ctx, session.id, result.runAuth.run!, null, {
      reportArtifactId: artifactId,
      conversationId: persisted.conversationId,
    });

    if (handoff?.conversationId) {
      try {
        this.turnMaintenance?.scheduleAfterTurnMaintenance(ctx, handoff.conversationId);
      } catch (error) {
        this.logger.warn(
          `Research conversation maintenance could not be scheduled: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }

    // G4: a held report becomes a pending review_request so a reviewer can
    // clear heldForReview through the Reviews queue (fail-open by contract).
    if (held) {
      await this.reviews.createSystem(ctx.tenantId, {
        riskTier: DELIVERABLE_RISK_TIERS.research_report ?? 'moderate',
        surface: 'research',
        subjectType: 'research_artifact',
        subjectId: artifactId,
        clientId: session.clientId ?? null,
        title: session.title,
        reason: heldReason || 'Grounding auditor held this research report for review.',
        payload: { artifactId },
        requestedBy: ctx.userId,
      });
    }

    if (bufferReport) {
      const deliverable = held ? heldNotice : reportBody;
      if (deliverable.trim().length > 0) sse.write(sseEvent({ type: 'text', text: deliverable }));
    }

    sse.write(sseEvent({ type: 'phase', phase: 'done' }));
    // The report event REPLACES the whole chat message client-side — when held
    // (enforce only) it must carry the hold notice, never the report body, or
    // the buffering above would be undone at the finish line.
    sse.write(
      sseEvent({
        type: 'report',
        artifactId,
        messageId: persisted.messageId,
        conversationId: persisted.conversationId,
        body: held ? heldNotice : artifactBody,
        reportMetadata: publicResearchReportMetadata({
          ...reportMetadata,
          researchSessionId: session.id,
          reportArtifactId: artifactId,
        }),
      }),
    );
    sse.write(sseEvent({ type: 'done' }));
  }

  // ── internals ───────────────────────────────────────────────────────────

  private researchPlanAdmissionContext(
    ctx: TenantContext,
    session: {
      id: string;
      clientId: string | null;
      metadata: Prisma.JsonValue | null;
    },
  ): ResearchPlanAdmissionContext {
    const handoff = readResearchHandoff(session.metadata);
    return {
      scope: {
        sessionId: session.id,
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        clientId: session.clientId,
        conversationId: handoff?.conversationId ?? null,
      },
      capabilities: this.tools
        .anthropicToolSchemas({ tenantId: ctx.tenantId, surface: 'chat' })
        .map((schema) => ({
          name: schema.name,
          sideEffecting: this.tools.isSideEffecting(schema.name),
        })),
    };
  }

  /** Final V3 gate: no asynchronous preparation may follow this accepted observation. */
  private async admitFreshResearchPlanForDispatch(
    ctx: TenantContext,
    id: string,
    auth: ResearchRuntimeAuth,
  ): Promise<{
    session: Awaited<ReturnType<MeriResearchService['ensureSession']>>;
    plan: ResearchPlanV1;
  }> {
    if (!auth.run) throw new ConflictException('Research dispatch requires an active run lease.');
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const current = await tx.clioResearchSession.findFirst({
        where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
      });
      const currentRun = readResearchRun(current?.metadata);
      if (
        !current ||
        current.status !== 'researching' ||
        currentRun?.id !== auth.run!.id ||
        currentRun.leaseEpoch !== auth.run!.leaseEpoch ||
        currentRun.phase !== auth.run!.phase ||
        currentRun.status !== 'running'
      )
        throw new ConflictException('Research is no longer running.');

      await this.assertResearchPublicationAuthorized(tx, ctx, current);
      const stored = researchMetadata(current.metadata).researchPlan;
      try {
        const plan = validateResearchPlan(stored, this.researchPlanAdmissionContext(ctx, current));
        return { session: current, plan };
      } catch (error) {
        if (!(error instanceof ResearchPlanValidationError)) throw error;
        throw new BadRequestException(
          `Saved research plan is not admitted for the current scope and capabilities: ${error.issues.join('; ')}`,
        );
      }
    });
  }

  /** Strict provider boundary with one validation-triggered repair and no fallback plan. */
  private async requestAdmittedResearchPlan(
    ctx: TenantContext,
    session: {
      id: string;
      topic: string;
      clientId: string | null;
      metadata: Prisma.JsonValue | null;
    },
    admissionContext: ResearchPlanAdmissionContext,
    system: string,
    user: string,
    auth: ResearchRuntimeAuth,
  ): Promise<ResearchPlanV1> {
    const handoff = readResearchHandoff(session.metadata);
    const useV3 = Boolean(this.v3Research && (await this.v3Research.enabled(ctx)));
    const complete = (nextSystem: string, nextUser: string) =>
      useV3
        ? this.v3Research!.plan(
            ctx,
            {
              sessionId: session.id,
              topic: session.topic,
              clientId: session.clientId,
              system: nextSystem,
              user: nextUser,
              handoff,
            },
            auth,
          )
        : this.anthropicComplete(ctx.tenantId, nextSystem, nextUser, auth.signal);

    const raw = await complete(system, user);
    try {
      return validateResearchPlan(raw, admissionContext);
    } catch (error) {
      if (!(error instanceof ResearchPlanValidationError)) throw error;
      if (auth.run) await this.assertRunActive(ctx, session.id, auth.run.id);
      const repair = buildResearchPlanRepairPrompt(system, raw, error);
      const repairedRaw = await complete(repair.system, `${user}\n\n${repair.user}`);
      try {
        return validateResearchPlan(repairedRaw, admissionContext);
      } catch (repairError) {
        if (!(repairError instanceof ResearchPlanValidationError)) throw repairError;
        throw new BadRequestException(
          `Research plan remained invalid after one repair attempt: ${repairError.issues.join('; ')}`,
        );
      }
    }
  }

  /**
   * Revalidates current catalog/scope immediately before dispatch. Old sessions
   * receive one bounded planning migration; a stored typed plan is never silently
   * repaired because scope or catalog drift is an authorization failure.
   */
  private async admitResearchPlanForDispatch(
    ctx: TenantContext,
    session: Awaited<ReturnType<MeriResearchService['ensureSession']>>,
    auth: ResearchRuntimeAuth,
  ): Promise<ResearchPlanV1> {
    const context = this.researchPlanAdmissionContext(ctx, session);
    const stored = researchMetadata(session.metadata).researchPlan;
    if (stored !== undefined) {
      try {
        return validateResearchPlan(stored, context);
      } catch (error) {
        if (!(error instanceof ResearchPlanValidationError)) throw error;
        throw new BadRequestException(
          `Saved research plan is not admitted for the current scope and capabilities: ${error.issues.join('; ')}`,
        );
      }
    }
    if (!auth.run) throw new ConflictException('Legacy plan migration requires an active run lease.');

    const clientContext = await this.clientContext(ctx, session.clientId);
    const legacyPlan = asStringArray(session.plan);
    const system = buildResearchPlanSystemPrompt(PRODUCT_NAME, context);
    const user = [
      buildPlanUserPrompt(session.topic, clientContext),
      legacyPlan.length
        ? `Legacy UI plan (uncertified; migrate it rather than trusting it):\n${legacyPlan
            .map((step, index) => `${index + 1}. ${step}`)
            .join('\n')}`
        : 'No legacy plan is available. Create the bounded typed plan from the saved request.',
      researchHandoffPrompt(readResearchHandoff(session.metadata), session.id),
    ]
      .filter(Boolean)
      .join('\n\n');
    const proposed = await this.requestAdmittedResearchPlan(
      ctx,
      session,
      context,
      system,
      user,
      auth,
    );

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const current = await tx.clioResearchSession.findFirst({
        where: { id: session.id, tenantId: ctx.tenantId, userId: ctx.userId },
      });
      const currentRun = readResearchRun(current?.metadata);
      if (
        !current ||
        currentRun?.id !== auth.run!.id ||
        currentRun.leaseEpoch !== auth.run!.leaseEpoch ||
        currentRun.status !== 'running'
      )
        throw new ConflictException('Research lease is no longer active.');
      await this.assertResearchPublicationAuthorized(tx, ctx, current);
      const admitted = validateResearchPlan(
        proposed,
        this.researchPlanAdmissionContext(ctx, current),
      );
      const nextMetadata = {
        ...researchMetadata(current.metadata),
        researchPlan: admitted,
      };
      const updated = await this.updateActiveResearchRun(
        tx,
        ctx,
        current.id,
        currentRun,
        current.metadata,
        nextMetadata,
        current.status,
        new Date(),
      );
      if (!updated)
        throw new ConflictException('Research lease changed while admitting the migrated plan.');
      await tx.clioResearchSession.update({
        where: { id: current.id },
        data: {
          title: clampTitle(admitted.title),
          plan: researchPlanStringProjection(admitted) as Prisma.InputJsonValue,
          clarifyingQuestions: admitted.clarifyingQuestions as Prisma.InputJsonValue,
          updatedAt: new Date(),
        },
      });
      return admitted;
    });
  }

  private async updateActiveResearchRun(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    id: string,
    run: ResearchRunState,
    expectedMetadata: unknown,
    nextMetadata: unknown,
    nextSessionStatus: string,
    now: Date,
  ): Promise<boolean> {
    const rows = await tx.$queryRawUnsafe<Array<{ metadata_jsonb: Prisma.JsonValue }>>(
      ACTIVE_RESEARCH_RUN_UPDATE_SQL,
      id,
      ctx.tenantId,
      ctx.userId,
      run.phase === 'plan' ? 'plan' : 'researching',
      run.id,
      run.leaseEpoch,
      run.phase,
      researchLeaseCutoff(now),
      JSON.stringify(expectedMetadata ?? {}),
      JSON.stringify(nextMetadata ?? {}),
      nextSessionStatus,
      now,
    );
    return rows.length === 1;
  }

  private async assertResearchPublicationAuthorized(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    session: { clientId: string | null; metadata: Prisma.JsonValue | null },
  ): Promise<void> {
    if (
      session.clientId &&
      !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, session.clientId))
    )
      throw new NotFoundException('Research session not found');
    const handoff = readResearchHandoff(session.metadata);
    const backingConversationId = researchMetadata(session.metadata).backingConversationId;
    if (handoff && handoff.clientId !== session.clientId)
      throw new BadRequestException(
        'The originating conversation is no longer available in this client scope',
      );
    const authorizedConversationId =
      handoff?.conversationId ??
      (typeof backingConversationId === 'string' ? backingConversationId : null);
    if (
      authorizedConversationId &&
      !(await tx.clioConversation.findFirst({
        where: {
          id: authorizedConversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: session.clientId,
          archivedAt: null,
        },
        select: { id: true },
      }))
    )
      throw new BadRequestException(
        'The originating conversation is no longer available in this client scope',
      );
  }

  /** Recheck current scope after commit and immediately before public release. */
  private async assertReceiptPublicationAuthorized(
    ctx: TenantContext,
    id: string,
    run: ResearchRunState,
  ): Promise<void> {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const current = await tx.clioResearchSession.findFirst({
        where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
      });
      const currentRun = readResearchRun(current?.metadata);
      if (
        !current ||
        currentRun?.id !== run.id ||
        currentRun.leaseEpoch !== run.leaseEpoch ||
        currentRun.status !== 'running'
      )
        throw new ConflictException('Research lease is no longer active.');
      await this.assertResearchPublicationAuthorized(tx, ctx, current);
    });
  }

  /** Reauthorize prior-run owner bodies before saving and before releasing a report. */
  private async assertReplayedReportSourcesAuthorized(
    ctx: TenantContext,
    id: string,
    run: ResearchRunState | null,
    toolsUsed: string[] | null,
    options?: {
      producerInputSha256?: string;
      producerInputMode?: 'source_free' | 'covered_inputs' | 'unsupported_private_inputs';
      clientContextSha256?: string | null;
      reportArtifactId?: string;
      conversationId?: string;
    },
  ): Promise<void> {
    if (
      toolsUsed &&
      (!run ||
        !options?.producerInputSha256 ||
        !options.producerInputMode ||
        options.producerInputMode === 'unsupported_private_inputs')
    )
      throw new ConflictException('The research report producer proof is unavailable.');
    await assertCurrentResearchReportSourcesAuthorized({
      prisma: this.prisma,
      tools: this.tools,
      ctx,
      scope: {
        sessionId: id,
        ...(options?.reportArtifactId ? { reportArtifactId: options.reportArtifactId } : {}),
        ...(options?.conversationId ? { conversationId: options.conversationId } : {}),
        ...(toolsUsed && run && options?.producerInputSha256
          ? {
              publication: {
                runId: run.id,
                leaseEpoch: run.leaseEpoch,
                toolsUsed,
                producerInputSha256: options.producerInputSha256,
                producerInputMode: options.producerInputMode!,
                clientContextSha256: options.clientContextSha256 ?? null,
              },
            }
          : {}),
      },
    });
  }

  private async ensureSession(ctx: TenantContext, id: string) {
    const session = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioResearchSession.findFirst({
        where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
      }),
    );
    if (!session) throw new NotFoundException('Research session not found');
    if (
      session.clientId &&
      !(await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, session.clientId as string),
      ))
    )
      throw new NotFoundException('Research session not found');
    const handoff = readResearchHandoff(session.metadata);
    if (handoff?.conversationId) {
      const originatingConversationId = handoff.conversationId;
      const origin = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioConversation.findFirst({
          where: {
            id: originatingConversationId,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            clientId: session.clientId,
            archivedAt: null,
          },
          select: { id: true },
        }),
      );
      if (!origin || handoff.clientId !== session.clientId)
        throw new BadRequestException(
          'The originating conversation is no longer available in this client scope',
        );
    }
    return session;
  }

  private async clientContext(ctx: TenantContext, clientId: string | null): Promise<string | null> {
    if (!clientId) return null;
    try {
      const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.client.findFirst({
          where: { id: clientId },
          select: { name: true, description: true, productDescription: true },
        }),
      );
      if (!client) return null;
      const parts = [`Client: ${client.name}`];
      if (client.description) parts.push(`Description: ${client.description}`);
      if (client.productDescription) parts.push(`Product/service: ${client.productDescription}`);
      return parts.join('\n');
    } catch {
      return null;
    }
  }

  /** Single non-streaming Anthropic completion (used for the PLAN phase). */
  private async anthropicComplete(
    tenantId: string,
    system: string,
    user: string,
    signal?: AbortSignal,
  ): Promise<string> {
    // BYOK: tenant key (or global fallback) via resolver; model unchanged.
    const resolved = await this.aiCredentials.resolveProviderByTenantId(tenantId, 'anthropic');
    if (!resolved) throw new Error('ANTHROPIC_API_KEY not configured');
    const anthropicKey = resolved.apiKey;
    const model = this.config.get('CLIO_RESEARCH_PLAN_MODEL', { infer: true });
    const timeoutMs = this.config.get('CLIO_REQUEST_TIMEOUT_MS', { infer: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          prepareAnthropicRequest({
            model,
            max_tokens: 1500,
            system,
            messages: [{ role: 'user', content: user }],
          }),
        ),
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(
          `Anthropic HTTP ${response.status}${errText ? `: ${errText.slice(0, 300)}` : ''}`,
        );
      }
      const json = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
      return (json.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ── module-private pure helpers ─────────────────────────────────────────── */

function researchLeaseError(message: string): Error {
  const error = new Error(message);
  error.name = 'ResearchLeaseError';
  return error;
}

function sseEvent(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Config guard for the wall-clock budgets. A stubbed/partial ConfigService (unit
 * tests, an older env) can hand back undefined, and feeding NaN to setTimeout
 * fires it immediately — which would abort every model call instead of bounding
 * it. Anything that isn't a finite positive number falls back to the default.
 */
function positiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

interface ProgressReporter {
  /** Update the current stage. Emits immediately, then on each heartbeat tick. */
  set: (note: string) => void;
  stop: () => void;
}

/**
 * Liveness heartbeat for a research run.
 *
 * Deep Research runs for minutes, and under MERI_AUDITOR_MODE=enforce it streams
 * NO report text at all until the post-hoc grounding audit clears it — the trust
 * timeline moves but the message body stays empty. That made a healthy run look
 * identical to a hung one. This emits a `progress` event on every stage change
 * AND on a fixed interval, so the client can render what's happening and can
 * treat prolonged silence as a genuine stall rather than waiting forever.
 */
function createProgressReporter(
  sse: SseSink,
  opts: { intervalMs: number; budgetMs: number },
): ProgressReporter {
  const startedAt = Date.now();
  let note: string = RESEARCH_OBSERVER_STATUS.startingRun;
  let stopped = false;

  const emit = () => {
    if (stopped) return;
    // A closed/destroyed response must never take the run down with it.
    try {
      sse.write(
        sseEvent({
          type: 'progress',
          note,
          elapsedMs: Date.now() - startedAt,
          budgetMs: opts.budgetMs,
        }),
      );
    } catch {
      /* client gone; the run's own completion path still persists the report */
    }
  };

  const timer = setInterval(emit, Math.max(1_000, opts.intervalMs));
  // Never keep the process (or a jest worker) alive on the heartbeat alone.
  timer.unref?.();

  return {
    set: (next: string) => {
      const projected = projectResearchObserverEvent({ type: 'progress', note: next });
      note =
        projected?.type === 'progress' && typeof projected.note === 'string'
          ? projected.note
          : RESEARCH_OBSERVER_STATUS.preparingReport;
      emit();
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * True for an AbortController-driven timeout. fetch/undici surface these as a
 * DOMException/Error named 'AbortError' (and sometimes the message "This
 * operation was aborted"), so match on either.
 */
function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || /abort/i.test(err.message);
}

function asStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function asStringRecord(value: Prisma.JsonValue | null | undefined): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function publicDurableSafeRead(receipt: DurableResearchStepReceipt, replayed: boolean) {
  const tool = publicResearchSourceTool(receipt.tool) ?? 'research_source';
  return {
    version: receipt.version,
    receiptId: receipt.receiptId,
    runId: receipt.runId,
    leaseEpoch: receipt.leaseEpoch,
    sequence: receipt.sequence,
    effectClass: receipt.effectClass,
    toolCallId: receipt.toolCallId,
    tool,
    label: 'Research source',
    status: receipt.status,
    summary: receipt.status === 'complete' ? 'Authorized read completed' : 'Authorized read failed',
    completedAt: receipt.completedAt,
    outcome: 'complete',
    persisted: true,
    replayed,
    ...(receipt.executionId ? { executionId: receipt.executionId } : {}),
    ...(receipt.providerCallId ? { providerCallId: receipt.providerCallId } : {}),
    ...(receipt.toolVersion ? { toolVersion: receipt.toolVersion } : {}),
    ...(receipt.classifier ? { classifier: receipt.classifier } : {}),
  };
}

/** Public source rows contain fixed owner vocabulary and status only, never owner prose. */
function publicResearchSources(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const source = researchMetadata(candidate);
    const tool = publicResearchSourceTool(source.tool);
    if (!tool) return [];
    return [
      {
        tool,
        label: 'Research source',
        summary: 'Authorized read completed',
        ...(typeof source.count === 'number' &&
        Number.isSafeInteger(source.count) &&
        source.count >= 0
          ? { count: source.count }
          : {}),
        ...(['low', 'high'].includes(String(source.confidence))
          ? { confidence: source.confidence }
          : {}),
      },
    ];
  });
}

/** Public recovery metadata deliberately excludes result refs, hashes, inputs, and result bytes. */
function publicResearchSessionMetadata(value: unknown): Record<string, unknown> {
  const metadata = researchMetadata(value);
  return {
    handoff: {
      conversationId: readResearchHandoff(value)?.conversationId ?? null,
    },
    ...(typeof metadata.planMessageId === 'string'
      ? { planMessageId: metadata.planMessageId }
      : {}),
    ...(typeof metadata.reportMessageId === 'string'
      ? { reportMessageId: metadata.reportMessageId }
      : {}),
    ...(Array.isArray(metadata.durableStepReceipts)
      ? {
          durableStepReceipts: readDurableResearchStepReceipts(metadata).map((receipt) =>
            publicDurableSafeRead(receipt, false),
          ),
        }
      : {}),
  };
}

/** Only user-facing evidence crosses the report stream/recovery boundary. */
function publicResearchReportMetadata(value: unknown): Record<string, unknown> {
  const metadata = researchMetadata(value);
  const projected = Object.fromEntries(
    [
      'citations',
      'trustSteps',
      'trace',
      'intent',
      'tier',
      'plan',
      'contextPacketId',
      'retrieval',
      'verification',
      'groundingCaveat',
      'groundingStatement',
      'telemetry',
      'reasoningMode',
      'finishReason',
      'partial',
      'evidenceManifest',
    ]
      .filter((key) => key in metadata)
      .map((key) => [key, metadata[key]]),
  );
  const toolsUsed = Array.isArray(metadata.toolsUsed)
    ? metadata.toolsUsed.flatMap((tool) => {
        const safe = publicResearchSourceTool(tool);
        return safe ? [safe] : [];
      })
    : undefined;
  return {
    ...(typeof metadata.researchSessionId === 'string'
      ? { researchSessionId: metadata.researchSessionId }
      : {}),
    ...(typeof metadata.reportArtifactId === 'string'
      ? { reportArtifactId: metadata.reportArtifactId }
      : {}),
    ...(toolsUsed && toolsUsed.length === (metadata.toolsUsed as unknown[]).length
      ? { toolsUsed }
      : {}),
    ...projected,
  };
}

/** Withheld reads retain only structural recovery/status data, never source-derived prose. */
function withheldPublicResearchReportMetadata(
  value: unknown,
  sessionId: string | null,
): Record<string, unknown> {
  const metadata = researchMetadata(value);
  const trustSteps = Array.isArray(metadata.trustSteps)
    ? metadata.trustSteps.flatMap((value) => {
        const step = researchMetadata(value);
        const tool = publicResearchSourceTool(step.tool);
        const safe = {
          ...(tool ? { tool } : {}),
          ...(typeof step.count === 'number' && Number.isSafeInteger(step.count) && step.count >= 0
            ? { count: step.count }
            : {}),
          ...(['low', 'high'].includes(String(step.confidence))
            ? { confidence: step.confidence }
            : {}),
          ...(['done', 'error'].includes(String(step.status)) ? { status: step.status } : {}),
        };
        return Object.keys(safe).length ? [safe] : [];
      })
    : undefined;
  return {
    ...(trustSteps ? { trustSteps } : {}),
    ...(metadata.intent === 'deep_research' ? { intent: metadata.intent } : {}),
    ...(['fast', 'deep'].includes(String(metadata.tier)) ? { tier: metadata.tier } : {}),
    ...(['fast', 'standard', 'deep', 'max'].includes(String(metadata.reasoningMode))
      ? { reasoningMode: metadata.reasoningMode }
      : {}),
    ...(typeof metadata.partial === 'boolean' ? { partial: metadata.partial } : {}),
    reportBodyAccess: {
      status: 'withheld',
      reason: 'current_source_authorization_unavailable',
      recovery: sessionId ? 'research_session' : 'conversation_research_history',
      ...(sessionId ? { researchSessionId: sessionId } : {}),
    },
  };
}
