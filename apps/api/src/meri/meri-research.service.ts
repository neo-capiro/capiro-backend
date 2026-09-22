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
import { MeriToolsService } from './meri-tools.service.js';
import { clientScopeRefusal, CLIENT_ID_UUID_RE, isMeriMailReadTool } from './meri-prompt.helpers.js';
import { AiCredentialResolverService } from '../engagement/ai-credential-resolver.service.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import { DELIVERABLE_RISK_TIERS } from '@capiro/shared';
import {
  assembleReportArtifact,
  buildPlanSystemPrompt,
  buildPlanUserPrompt,
  buildResearchSystemPrompt,
  buildResearchUserPrompt,
  clampTitle,
  humanToolLabel,
  parsePlanProposal,
  summarizeJsonForPrompt,
  summarizeToolResultForTrust,
  type PlanProposal,
} from './meri-research.helpers.js';
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
  readResearchRun,
  researchMetadata,
  terminalResearchRun,
  type ResearchRunState,
  type ResearchRunPhase,
} from './meri-research-run-state.js';

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

export interface SourceAttribution {
  tool: string;
  label: string;
  count?: number | null;
  summary: string;
  confidence: 'low' | 'high';
}

interface SseSink {
  write: (data: string) => void;
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

  async getSession(ctx: TenantContext, id: string) {
    const session = await this.ensureSession(ctx, id);

    // Attach the report artifact body when complete.
    let report: { id: string; title: string; bodyText: string | null; metadata?: unknown } | null =
      null;
    if (session.reportArtifactId) {
      report = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioArtifact.findFirst({
          where: { id: session.reportArtifactId ?? undefined, tenantId: ctx.tenantId },
          select: { id: true, title: true, bodyText: true, metadata: true },
        }),
      );
    }
    // A held artifact is never released by reconnection or export.
    if (report && researchMetadata(report.metadata).heldForReview === true)
      report = {
        ...report,
        bodyText: 'Report held for review. Open Reviews before using this deliverable.',
      };
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
    return { ...session, run: readResearchRun(session.metadata), report, reportMetadata };
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
        where: { id: session.reportArtifactId ?? undefined, tenantId: ctx.tenantId },
        select: { title: true, bodyText: true, metadata: true },
      }),
    );
    if (!artifact) throw new NotFoundException('Report artifact not found');
    if (researchMetadata(artifact.metadata).heldForReview === true)
      throw new BadRequestException('This research report is held for review');
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
            if (!current || stored?.id !== run.id || stored.status !== 'running') {
              controller.abort(researchLeaseError('Research lease is no longer active.'));
              return;
            }
            const updated = await this.prisma.withTenant(ctx.tenantId, (tx) =>
              tx.clioResearchSession.updateMany({
                where: {
                  id,
                  tenantId: ctx.tenantId,
                  userId: ctx.userId,
                  metadata: { equals: current.metadata ?? {} },
                },
                data: {
                  metadata: {
                    ...researchMetadata(current.metadata),
                    run: { ...run, heartbeatAt: new Date().toISOString() },
                  } as unknown as Prisma.InputJsonObject,
                  updatedAt: new Date(),
                },
              }),
            );
            if (!updated.count)
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
      const sink = {
        write: (data: string) => {
          try {
            const event = JSON.parse(data.replace(/^data: /, '').trim()) as Record<string, unknown>;
            if (event.type === 'progress' && typeof event.note === 'string') run.stage = event.note;
            if (event.type === 'step' && typeof event.label === 'string')
              run.stage = `Reading ${event.label}`;
            // Stage-only records: elapsed time is not a completion percentage.
          } catch {
            /* non-data heartbeat */
          }
          safeWrite(data);
        },
      };
      await execute(sink, { ...auth, run, signal: controller.signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Research failed';
      if (claimed)
        await this.markFailed(
          ctx,
          id,
          { ...auth, run: claimed, signal: controller.signal },
          message,
        );
      safeWrite(sseEvent({ type: 'error', message }));
      safeWrite(sseEvent({ type: 'done' }));
    } finally {
      stopping = true;
      if (timer) clearInterval(timer);
      await pending;
      auth.signal?.removeEventListener('abort', abort);
      if (this.activeRuns.get(key) === controller) this.activeRuns.delete(key);
    }
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
    const lock = await tx.clioResearchSession.updateMany({
      where: {
        id,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        metadata: { path: ['run', 'id'], equals: auth.run.id },
        status: auth.run.phase === 'plan' ? 'plan' : 'researching',
      },
      data: { updatedAt: new Date() },
    });
    if (!lock.count)
      throw new ConflictException(
        'This research attempt no longer owns the run. Refresh to recover its current status.',
      );
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
      if (readResearchRun(current.metadata)?.id !== auth.run.id || current.status === 'complete')
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
      await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioResearchSession.updateMany({
          where: {
            id,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            status: { in: ['plan', 'researching'] },
            metadata: { equals: current.metadata ?? {} },
          },
          data: {
            status: status === 'cancelled' ? 'cancelled' : 'failed',
            metadata: {
              ...researchMetadata(current.metadata),
              run,
            } as unknown as Prisma.InputJsonObject,
            updatedAt: new Date(),
          },
        }),
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
    const system = buildPlanSystemPrompt(PRODUCT_NAME);
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

    let proposal: PlanProposal;
    const useV3 = this.v3Research && (await this.v3Research.enabled(ctx));
    try {
      const raw = useV3
        ? await this.v3Research!.plan(
            ctx,
            {
              sessionId: session.id,
              topic: session.topic,
              clientId: session.clientId,
              system,
              user,
              handoff,
            },
            auth,
          )
        : await this.anthropicComplete(ctx.tenantId, system, user, auth.signal);
      proposal = parsePlanProposal(raw, session.topic);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Planning failed';
      this.logger.warn(`Research plan failed: ${msg}`);
      // A failed provider is a recoverable failed attempt, never a fabricated plan.
      await this.markFailed(ctx, session.id, auth, msg);
      sse.write(sseEvent({ type: 'error', message: msg }));
      sse.write(sseEvent({ type: 'done' }));
      return;
    } finally {
      progress.stop();
    }

    const planMessageId = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.fenceRun(tx, ctx, session.id, auth);
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
      await tx.clioResearchSession.update({
        where: { id: session.id },
        data: {
          title: clampTitle(proposal.title),
          plan: proposal.plan as Prisma.InputJsonValue,
          clarifyingQuestions: proposal.clarifyingQuestions as Prisma.InputJsonValue,
          status: 'awaiting_clarification',
          metadata: {
            ...researchMetadata(session.metadata),
            run: terminalResearchRun(
              auth.run!,
              'awaiting_clarification',
              proposal.clarifyingQuestions.length
                ? 'Waiting for your clarification answers'
                : 'Plan ready; research can begin',
            ),
          } as unknown as Prisma.InputJsonObject,
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
                `Research plan — ${proposal.title}\n\n${proposal.plan.map((step, index) => `${index + 1}. ${step}`).join('\n')}` +
                (proposal.clarifyingQuestions.length
                  ? `\n\nClarifying questions:\n${proposal.clarifyingQuestions.join('\n')}`
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
              ...researchMetadata(session.metadata),
              run: terminalResearchRun(auth.run!, 'awaiting_clarification', 'Plan ready'),
              planMessageId: planMessage.id,
            } as unknown as Prisma.InputJsonObject,
          },
        });
      return planMessage?.id ?? null;
    });

    sse.write(sseEvent({ type: 'title', title: proposal.title }));
    sse.write(sseEvent({ type: 'plan', plan: proposal.plan }));
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
    // A research run is minutes long and — under MERI_AUDITOR_MODE=enforce — emits
    // NO report text until the post-hoc audit clears it (see bufferReport below).
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
      const message = error instanceof Error ? error.message : 'Research failed';
      this.logger.warn(`Research run failed: ${message}`);
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

    const plan = asStringArray(session.plan);
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
      researchHandoffPrompt(handoff, session.id),
    ]
      .filter(Boolean)
      .join('\n\n');

    sse.write(sseEvent({ type: 'phase', phase: 'gather' }));
    if (this.v3Research && (await this.v3Research.enabled(ctx))) {
      progress.set('Researching with the conversation’s selected reasoning mode…');
      const result = await this.v3Research.run(
        ctx,
        {
          sessionId: session.id,
          conversationId: handoff?.conversationId ?? null,
          clientId: session.clientId,
          system: buildResearchSystemPrompt(PRODUCT_NAME, { inheritChatOutputContract: true }),
          user,
          handoff,
          clientContext,
        },
        auth,
        (event) => {
          // Progress follows observed provider/tool events, never an elapsed-time percentage.
          if (event.type === 'step' && typeof event.label === 'string')
            progress.set(`Reading ${event.label}…`);
          else if (event.type === 'source')
            progress.set('Reviewing the retrieved evidence for the report…');
          // The shared report/audit tail delivers text after evidence checks.
          if (event.type !== 'text' && event.type !== 'done') sse.write(sseEvent(event));
        },
      );
      await this.finishResearch(ctx, session, sse, progress, {
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
    progress.set('Reviewing the research plan…');
    // Deep Research is a read-only GATHER agent: it must NOT be able to call
    // side-effecting tools (send_email/reply_email/save_memory/create_task/
    // update_client_profile/docgen/...). A long-running agentic loop over the full
    // tool set could otherwise autonomously send mail or mutate data. Filter to
    // concurrency-safe (== read-only, i.e. not in SIDE_EFFECTING_TOOLS) tools;
    // the final report is persisted by this service, not via a write tool. This
    // mirrors the read-only hardening on the scheduled-tasks runner.
    const toolSchemas = this.tools
      .anthropicToolSchemas()
      .filter((s) => this.tools.isConcurrencySafe(s.name));
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
    // Resolved ONCE up front because ENFORCE changes the streaming shape below:
    // the post-hoc audit can only protect the READER if the report text hasn't
    // already been streamed to them token-by-token. Under enforce we buffer the
    // report deltas (thinking/steps/sources still stream live so the trust
    // timeline works), audit, then deliver — the full body when cleared, a hold
    // notice instead of the body when held. Shadow/annotate keep today's
    // stream-as-generated behavior (the audit there never withholds anything).
    const auditorMode = await resolveTenantAuditorMode(this.prisma, ctx.tenantId);
    const bufferReport = auditorMode === 'enforce';
    // Say so, once, instead of letting the reader interpret a silent empty bubble
    // as a broken run. Unknown event types are ignored by older clients.
    if (bufferReport) {
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
        progress.set(
          `Gathering evidence — round ${round + 1} of ${maxRounds}` +
            (sources.length > 0 ? ` · ${sources.length} source(s) so far` : ''),
        );
        const controller = new AbortController();
        // Clamp the per-call timeout to the budget that's actually left, so one
        // slow round can't consume time the report needs.
        const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, gatherRemainingMs));
        const toolUseById = new Map<number, { id: string; name: string; jsonParts: string[] }>();
        const thinkingState = createThinkingState();
        let stopReason: string | null = null;

        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(prepareAnthropicRequest({
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
            })),
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
                // Extended thinking (F3): relay reasoning to the research
                // timeline; blocks replay in the loop but never persist.
                const thinkingDelta = applyThinkingStreamEvent(thinkingState, evt);
                if (thinkingDelta.thinkingTextDelta) {
                  sse.write(sseEvent({ type: 'thinking', text: thinkingDelta.thinkingTextDelta }));
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
                    // Enforce buffers report text until the post-hoc audit
                    // clears it (see bufferReport above).
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
          toolsUsed.push(t.name);
          sse.write(sseEvent({ type: 'step', tool: t.name, label: humanToolLabel(t.name) }));
          progress.set(`Running ${humanToolLabel(t.name)}…`);

          let resultPayload: unknown;
          let isError = false;
          if (scopeViolation) {
            isError = true;
            resultPayload = { error: scopeViolation };
            this.logger.warn(
              `Deep Research blocked an out-of-scope client read: ${t.name} (session ${session.id})`,
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
              resultPayload = await withMeriToolExecutionControl(
                { signal: auth.signal, deadlineAt },
                () => this.tools.execute(ctx, t.name as never, parsedInput),
              );
            } catch (err) {
              isError = true;
              resultPayload = {
                error: err instanceof Error ? err.message : 'Tool execution failed',
              };
            }
          }

          const { count, detail } = summarizeToolResultForTrust(resultPayload);
          const source: SourceAttribution = {
            tool: t.name,
            label: humanToolLabel(t.name),
            count: count ?? undefined,
            summary: isError
              ? typeof (resultPayload as { error?: unknown })?.error === 'string'
                ? (resultPayload as { error: string }).error
                : 'Tool error'
              : detail || 'Completed',
            confidence: isError ? 'low' : 'high',
          };
          sources.push(source);
          sse.write(sseEvent({ type: 'source', source }));

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
        progress.set('Writing the report…');
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
        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(prepareAnthropicRequest({
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
            })),
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
                  // Thinking from the forced pass streams to the timeline only;
                  // it never enters reportBody (redaction guarantee, F3).
                  sse.write(sseEvent({ type: 'thinking', text: evt.delta.thinking }));
                } else if (
                  evt.type === 'content_block_delta' &&
                  evt.delta?.type === 'text_delta' &&
                  typeof evt.delta.text === 'string'
                ) {
                  reportBody += evt.delta.text;
                  // Enforce buffers report text until the post-hoc audit
                  // clears it (see bufferReport above).
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
      const msg = err instanceof Error ? err.message : 'Research failed';
      this.logger.warn(`Research run failed: ${msg}`);
      sse.write(sseEvent({ type: 'error', message: msg }));
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
    },
  ) {
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
        this.logger.warn(
          JSON.stringify({
            event: 'meri.citation_integrity',
            conversationId: readResearchHandoff(session.metadata)?.conversationId ?? null,
            turnId: session.id,
            surface: 'research_report',
            dropped: formA.dropped,
            registered: result.citations?.length ?? 0,
            mode: evidenceAccuracyMode,
          }),
        );
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
      progress.set('Checking the report against the gathered sources…');
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

    // Reader-protection flush (enforce only): report deltas were withheld above,
    // so deliver now — the full (banner-prefixed) body when the audit cleared
    // it, or a hold notice INSTEAD of the body when held. The persisted artifact
    // keeps the full text either way; approve in Reviews releases it.
    const heldNotice =
      `> ⏸️ **Report held for review.** The grounding auditor flagged this report under ` +
      `enforce mode and it was not delivered. A reviewer must approve it in Reviews before ` +
      `the content is released; the saved report is marked *held for review*.` +
      (heldReason ? `\n>\n> ${heldReason.slice(0, 500)}` : '');

    // Persist the report artifact + link it to the session.
    progress.set('Saving the report…');
    const artifactBody = assembleReportArtifact({
      title: session.title,
      topic: session.topic,
      plan,
      reportBody,
      sources,
      citations: result.citations,
      generatedAt: new Date(),
    });

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
        count: source.count,
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

    const persisted = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.fenceRun(tx, ctx, session.id, result.runAuth);
      if (
        session.clientId &&
        !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, session.clientId))
      ) {
        throw new NotFoundException('Research session not found');
      }
      // Research started in chat stays in that thread. Standalone/older sessions
      // retain their existing backing conversation behavior.
      const existing =
        session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
          ? (session.metadata as Record<string, unknown>).backingConversationId
          : undefined;
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

      const reportMessage = handoff?.conversationId
        ? await tx.clioMessage.create({
            data: {
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              clientId: session.clientId,
              conversationId,
              role: 'assistant',
              body: held ? heldNotice : artifactBody,
              metadata: reportMetadata as unknown as Prisma.InputJsonObject,
            },
            select: { id: true },
          })
        : null;
      const artifact = await tx.clioArtifact.create({
        data: {
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
            ...reportMetadata,
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
            ...(session.metadata &&
            typeof session.metadata === 'object' &&
            !Array.isArray(session.metadata)
              ? session.metadata
              : {}),
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
    const artifactId = persisted.artifactId;

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
        reportMetadata: publicResearchReportMetadata(reportMetadata),
      }),
    );
    sse.write(sseEvent({ type: 'done' }));
  }

  // ── internals ───────────────────────────────────────────────────────────

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
        body: JSON.stringify(prepareAnthropicRequest({
          model,
          max_tokens: 1500,
          system,
          messages: [{ role: 'user', content: user }],
        })),
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
  let note = 'Starting the research run…';
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
      note = next;
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

/** Only user-facing evidence crosses the report stream/recovery boundary. */
function publicResearchReportMetadata(value: unknown): Record<string, unknown> {
  const metadata = researchMetadata(value);
  return Object.fromEntries(
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
}
