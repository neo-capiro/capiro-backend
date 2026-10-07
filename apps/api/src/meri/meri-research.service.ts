import { emitMeriApiTelemetry, withMeriApiTelemetrySpan } from './meri-telemetry.runtime.js';
import {
  admittedResearchTelemetry,
  admittedResearchReceiptTelemetry,
  remainingResearchTelemetryBudget,
} from './meri-research-telemetry.js';
import { prepareAnthropicRequest } from '@capiro/shared/ai-model-policy';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { MeriCitation, TenantContext } from '@capiro/shared';
import { AI_PRICING, validateCitationMarkers, validateFormBCitations } from '@capiro/shared';
import { classifyApiToolReadOutcome } from '@capiro/shared/meri-read-outcome';
import {
  BD_GATE_PRICE_INPUT_USD_PER_MILLION,
  BD_GATE_PRICE_OUTPUT_USD_PER_MILLION,
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
  describePlanReply,
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
import {
  MeriV3ResearchRunner,
  type ResearchChildRuntimeResult,
  type ResearchRuntimeAuth,
} from './meri-v3-research-runner.js';
import type {
  MeriV3ProviderTelemetry,
  MeriV3RetrievalStreamSummary,
} from './meriv3-chat.client.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { MERI_TURN_MAINTENANCE, type MeriTurnMaintenance } from './meri-turn-maintenance.js';

import { createHash, randomUUID } from 'node:crypto';
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
  currentMailSourceScopeAuthorization,
  currentMeetingSourceScopeAuthorization,
  currentNativeWorkSourceScopeAuthorization,
  currentOwnerReauthorizationInput,
  currentOwnerResultAuthorizesReplay,
  RESEARCH_REPORT_BODY_WITHHELD,
  researchProducerProofUnavailable,
  supportsDurableOwnerReauthorization,
} from './meri-research-replay-authorization.js';
import {
  buildResearchReportProvenance,
  certifyResearchProducerInputs,
  publicResearchSourceTool,
} from './meri-report-provenance.js';
import {
  describeResearchProducerInputCategories,
  joinResearchProducerInputs,
  pinResearchProducerInputs,
  researchProducerInputCoverableTool,
  ResearchProducerInputNotCurrent,
  type ResearchProducerInputCategories,
  type ResearchProducerInputDraftV1,
  type ResearchProducerInputManifestV1,
  type ResearchProducerInputMode,
} from './meri-research-producer-inputs.js';
import {
  isResearchObserverErrorMessage,
  projectResearchObserverError,
  projectResearchObserverEvent,
  projectResearchTerminalFailure,
  RESEARCH_OBSERVER_STATUS,
  ResearchTerminalError,
  type ResearchTerminalFailure,
} from './research-observer-projection.js';
import {
  admitResearchToolBudget,
  completeResearchToolAttempt,
  readResearchToolBudget,
  reserveResearchProviderAttempt,
  reserveResearchToolAttempt,
  settleResearchProviderAttempt,
  ResearchProviderBudgetError,
  ResearchToolBudgetError,
  type ResearchProviderAttemptKind,
  type ResearchProviderBudgetLimitsV1,
  type ResearchToolAttemptBinding,
  type ResearchToolAttemptOutcome,
} from './meri-research-tool-budget.js';
import {
  activateDurableResearchCoordinator,
  admitDurableResearchCoordinator,
  applyDurableResearchReplan,
  approvalStepProposalId,
  completeDurableResearchStep,
  failDurableResearchStep,
  finishDurableResearchReauthorization,
  observeDurableResearchCancellation,
  publicDurableResearchCoordinator,
  queueDurableResearchSteering,
  readDurableResearchCoordinator,
  recordDurableResearchApprovalProposal,
  requestDurableResearchCancellation,
  reserveDurableResearchStep,
  settleDurableResearchApprovalStep,
  DurableResearchCoordinatorError,
} from './meri-research-coordinator.js';
import type { MeriActionProposalService } from './meri-action-proposal.service.js';
import {
  buildJobApprovalDraftPrompt,
  jobApprovalTool,
  parseJobApprovalDraft,
  pendingJobApprovalSteps,
} from './meri-job-approvals.js';
import {
  ResearchChildTaskError,
  boundResearchChildGoal,
  completeResearchChildTask,
  createResearchChildTaskBatch,
  currentResearchGoalRevision,
  failResearchChildTask,
  persistResearchChildTaskBatch,
  readResearchChildTasks,
  researchChildEvidenceHandles,
  type ResearchChildFailureV1,
  type ResearchChildTaskV1,
} from './meri-research-child-task.js';

import {
  meriJobDeliverables,
  meriJobKind,
  meriJobView,
  type MeriJobDeliverable,
  type MeriJobKind,
} from './meri-job.js';
import {
  MeriJobDeliverableRequestError,
  requestedJobDeliverables,
} from './meri-job-deliverables.js';
import { meriJobsEnabled } from '../common/tenant-flags.js';

/** The file a deliverable job renders from its report, for the plan and research prompts. */
function promptDeliverable(session: {
  kind?: string | null;
  deliverables?: unknown;
}): { format: string; title: string } | null {
  if (session.kind !== 'deliverable') return null;
  const deliverable = meriJobDeliverables(session.deliverables)[0];
  return deliverable ? { format: deliverable.format, title: deliverable.title } : null;
}

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
/** Compare-and-swap attempts per heartbeat before it skips one beat. */
const HEARTBEAT_CAS_ATTEMPTS = 3;

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
  reservationId: string;
  executionId: string;
  leaseEpoch?: number;
  providerCallId: string;
  tool: string;
  toolVersion: string;
  input: Record<string, unknown>;
  result: unknown;
}

export interface ResearchToolReservationInput {
  leaseEpoch: number;
  providerCallId: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ResearchProviderReservationInput {
  leaseEpoch: number;
  logicalOperationId: string;
  attemptId: string;
  retryOfAttemptId: string | null;
  kind: ResearchProviderAttemptKind;
  phase: string;
  provider: string;
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number | null;
}

export interface ResearchProviderSettlementInput {
  leaseEpoch: number;
  reservationId: string;
  logicalOperationId: string;
  attemptId: string;
  retryOfAttemptId: string | null;
  kind: ResearchProviderAttemptKind;
  phase: string;
  provider: string;
  model: string;
  outcome: 'known' | 'rejected' | 'uncertain';
  inputTokens: number | null;
  outputTokens: number | null;
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

  /** Release D: posts a job's approval-step cards. Absent means no card is ever posted. */
  private jobApprovals?: MeriActionProposalService;

  attachJobApprovalProposals(proposals: MeriActionProposalService): void {
    this.jobApprovals = proposals;
  }

  /**
   * Release D: settle each posted approval step from its proposal's current
   * status (owner-scoped read) with a compare-and-swap. Execution stays with
   * the proposal authority; this only records the outcome on the job.
   */
  private async settleJobApprovals<T extends { id: string; metadata: Prisma.JsonValue | null }>(
    ctx: TenantContext,
    session: T,
  ): Promise<T> {
    let coordinator;
    try {
      coordinator = readDurableResearchCoordinator(session.metadata);
    } catch {
      return session;
    }
    const waiting = (coordinator?.steps ?? []).flatMap((step) => {
      const proposalId = approvalStepProposalId(step);
      return step.goalRevision === coordinator!.goalRevision &&
        step.outcome === 'waiting_for_approval' &&
        proposalId
        ? [{ stepId: step.id, proposalId }]
        : [];
    });
    if (!waiting.length) return session;
    let metadata: unknown = session.metadata;
    let changed = false;
    for (const { stepId, proposalId } of waiting) {
      const proposal = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.meriActionProposal.findFirst({
          where: { id: proposalId, tenantId: ctx.tenantId, userId: ctx.userId },
          select: { status: true },
        }),
      );
      if (!proposal) continue;
      try {
        const settled = settleDurableResearchApprovalStep({
          metadata,
          stepId,
          proposalId,
          proposalStatus: proposal.status,
        });
        if (settled.changed) {
          metadata = settled.metadata;
          changed = true;
        }
      } catch (error) {
        this.logger.warn(
          `meri.job.approval.settle_failed ${JSON.stringify({ sessionId: session.id, stepId, code: error instanceof DurableResearchCoordinatorError ? error.code : 'unknown' })}`,
        );
      }
    }
    if (!changed) return session;
    const updated = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioResearchSession.updateMany({
        where: {
          id: session.id,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          metadata: { equals: session.metadata ?? {} },
        },
        data: { metadata: metadata as Prisma.InputJsonObject, updatedAt: new Date() },
      }),
    );
    // A concurrent writer won; the next read settles from its state.
    return updated.count ? { ...session, metadata: metadata as Prisma.JsonValue } : session;
  }

  /**
   * Release D: before the report is saved, post the existing proposal card for
   * each final approval step whose reads completed. One bounded drafting call
   * per step (same provider path as planning), the input validated by the
   * proposal service, and a card only for an action that needs approval.
   * Jobs only; a plain research run never posts. Failures are logged and leave
   * the step unposted, which is not a wait.
   */
  private async postJobApprovalProposals(
    ctx: TenantContext,
    session: Awaited<ReturnType<MeriResearchService['ensureSession']>>,
    auth: ResearchRuntimeAuth,
    report: string,
  ): Promise<Array<{ stepId: string; proposalId: string }>> {
    if (!this.jobApprovals || meriJobKind(session.kind) === 'research') return [];
    const current = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioResearchSession.findFirst({
        where: { id: session.id, tenantId: ctx.tenantId, userId: ctx.userId },
        select: { metadata: true },
      }),
    );
    let steps;
    try {
      steps = pendingJobApprovalSteps(current?.metadata);
    } catch {
      return [];
    }
    if (!steps.length) return [];
    const handoff = readResearchHandoff(session.metadata);
    const schemas = new Map(
      this.tools.anthropicToolSchemas().map((schema) => [schema.name, schema.input_schema]),
    );
    const notPosted = (stepId: string, code: string) =>
      this.logger.warn(
        `meri.job.approval.not_posted ${JSON.stringify({ sessionId: session.id, stepId, code })}`,
      );
    const posted: Array<{ stepId: string; proposalId: string }> = [];
    for (const step of steps) {
      const tool = jobApprovalTool(step, (name) => this.tools.isSideEffecting(name));
      if (!tool) {
        notPosted(step.id, 'job_approval_tool_ambiguous');
        continue;
      }
      try {
        const prompt = buildJobApprovalDraftPrompt({
          objective: step.objective,
          tool,
          inputSchema: schemas.get(tool) ?? { type: 'object' },
          report,
        });
        const raw = await this.completeStructured(ctx, session, auth, prompt.system, prompt.user);
        const created = await this.jobApprovals.create(ctx, {
          tool,
          input: parseJobApprovalDraft(raw),
          ...(handoff?.conversationId ? { conversationId: handoff.conversationId } : {}),
          surface: 'job',
          requireApproval: true,
        });
        if (created.disposition === 'pending_approval' || created.disposition === 'blocked')
          posted.push({ stepId: step.id, proposalId: created.proposal.proposalId });
        else notPosted(step.id, `job_approval_disposition_${created.disposition}`);
      } catch (error) {
        notPosted(
          step.id,
          error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : error instanceof Error
              ? error.message.slice(0, 120)
              : 'unknown',
        );
      }
    }
    return posted;
  }

  /** One structured completion on the planning provider path (no tools). */
  private async completeStructured(
    ctx: TenantContext,
    session: { id: string; topic: string; clientId: string | null; metadata: Prisma.JsonValue | null },
    auth: ResearchRuntimeAuth,
    system: string,
    user: string,
  ): Promise<string> {
    const useV3 = Boolean(this.v3Research && (await this.v3Research.enabled(ctx)));
    return useV3
      ? this.v3Research!.plan(
          ctx,
          {
            sessionId: session.id,
            topic: session.topic,
            clientId: session.clientId,
            system,
            user,
            handoff: readResearchHandoff(session.metadata),
          },
          auth,
        )
      : this.anthropicComplete(ctx, session.id, auth, system, user);
  }

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
          kind: true,
          goalRevision: true,
          deliverables: true,
          clientId: true,
          reportArtifactId: true,
          metadata: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    const visible = await Promise.all(
      sessions.map(async (listed) => {
        try {
          await this.ensureSession(ctx, listed.id);
          const session = await this.settleJobApprovals(ctx, listed);
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
            job: meriJobView(session),
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
    const session = await this.settleJobApprovals(ctx, await this.ensureSession(ctx, id));

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
      job: meriJobView(session),
      report,
      reportMetadata,
    };
  }

  async createSession(
    ctx: TenantContext,
    request: ResearchHandoffInput & { kind?: MeriJobKind; deliverables?: unknown },
  ) {
    const { kind = 'research', deliverables: requestedDeliverables, ...input } = request;
    const topic = (input.topic ?? '').trim();
    if (!topic) throw new BadRequestException('A research topic is required');
    // Stage 2 jobs are dark until the tenant flag is on; research is unchanged.
    if (kind !== 'research' && !(await this.jobsEnabled(ctx.tenantId)))
      throw new ForbiddenException('meri_jobs_disabled');
    let deliverables: MeriJobDeliverable[];
    try {
      deliverables = requestedJobDeliverables(
        kind,
        requestedDeliverables,
        clampTitle(input.title?.trim() || topic),
      );
    } catch (error) {
      if (error instanceof MeriJobDeliverableRequestError)
        throw new BadRequestException(error.message);
      throw error;
    }
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
          kind,
          ...(deliverables.length
            ? { deliverables: deliverables as unknown as Prisma.InputJsonValue }
            : {}),
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
          kind: true,
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

  /** Fails closed: an unreadable tenant row means jobs stay off. */
  private async jobsEnabled(tenantId: string): Promise<boolean> {
    try {
      const tenant = (await this.prisma.withTenant(tenantId, (tx) =>
        tx.tenant.findFirst({ where: { id: tenantId }, select: { settings: true } }),
      )) as { settings: unknown } | null;
      return meriJobsEnabled(tenant?.settings);
    } catch {
      return false;
    }
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

  /** Persist one aggregate model/provider/JEV reservation before external dispatch. */
  async reserveProviderAttempt(
    ctx: TenantContext,
    id: string,
    runId: string,
    raw: ResearchProviderReservationInput,
  ) {
    const input = strictProviderReservationInput(raw);
    for (let retry = 0; retry < 4; retry += 1) {
      const result = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const current = await tx.clioResearchSession.findFirst({
          where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
        });
        const run = readResearchRun(current?.metadata);
        if (
          !current ||
          !run ||
          run.id !== runId ||
          run.leaseEpoch !== input.leaseEpoch ||
          run.status !== 'running'
        )
          throw new ConflictException('Research lease is no longer active.');
        await this.assertResearchPublicationAuthorized(tx, ctx, current);
        let reserved;
        try {
          reserved = reserveResearchProviderAttempt({
            metadata: current.metadata,
            run,
            limits: this.researchProviderBudgetLimits(run),
            binding: input,
            price: researchProviderPrice(input.kind, input.model),
          });
        } catch (error) {
          if (error instanceof ResearchProviderBudgetError) throw new ConflictException(error.code);
          throw error;
        }
        if (!reserved.dispatchAllowed) return { retry: false as const, reserved };
        const changed = await this.updateActiveResearchRun(
          tx,
          ctx,
          current.id,
          run,
          current.metadata,
          reserved.metadata,
          current.status,
          new Date(),
        );
        return changed ? { retry: false as const, reserved } : { retry: true as const };
      });
      if (result.retry) continue;
      const { reservation, budget, dispatchAllowed } = result.reserved;
      emitMeriApiTelemetry({
        name: 'meri.research.budget.reserved',
        boundary: 'research_budget',
        researchSessionId: id,
        durableRunId: runId,
        leaseEpoch: input.leaseEpoch,
        operationId: reservation.reservationId,
        outcome: dispatchAllowed ? 'dispatch_allowed' : 'dispatch_denied',
        remainingBudget: remainingResearchTelemetryBudget(budget),
      });
      return {
        version: 1 as const,
        reservationId: reservation.reservationId,
        dispatchAllowed,
        status: reservation.status,
        deadlineAt: budget.limits.deadlineAt,
        chargedAttempts: budget.chargedAttempts,
        chargedTokens: budget.chargedTokens,
        chargedCostMicros: budget.chargedCostMicros,
      };
    }
    throw new ConflictException(
      'Research provider budget changed concurrently; retry with the same attempt identity.',
    );
  }

  /** Idempotently settle known usage; uncertain responses retain their worst-case charge. */
  async settleProviderAttempt(
    ctx: TenantContext,
    id: string,
    runId: string,
    raw: ResearchProviderSettlementInput,
  ) {
    const input = strictProviderSettlementInput(raw);
    for (let retry = 0; retry < 4; retry += 1) {
      const result = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const current = await tx.clioResearchSession.findFirst({
          where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
        });
        const run = readResearchRun(current?.metadata);
        if (
          !current ||
          !run ||
          run.id !== runId ||
          run.leaseEpoch !== input.leaseEpoch ||
          run.status !== 'running'
        )
          throw new ConflictException('Research lease is no longer active.');
        let settled;
        try {
          settled = settleResearchProviderAttempt({
            metadata: current.metadata,
            run,
            reservationId: input.reservationId,
            binding: input,
            outcome:
              input.outcome === 'known'
                ? {
                    kind: 'known',
                    inputTokens: input.inputTokens!,
                    outputTokens: input.outputTokens!,
                    price: researchProviderPrice(input.kind, input.model),
                  }
                : { kind: input.outcome },
          });
        } catch (error) {
          if (error instanceof ResearchProviderBudgetError) throw new ConflictException(error.code);
          throw error;
        }
        if (settled.metadata === current.metadata) return { retry: false as const, settled };
        const changed = await this.updateActiveResearchRun(
          tx,
          ctx,
          current.id,
          run,
          current.metadata,
          settled.metadata,
          current.status,
          new Date(),
        );
        return changed ? { retry: false as const, settled } : { retry: true as const };
      });
      if (result.retry) continue;
      emitMeriApiTelemetry({
        name: 'meri.research.budget.settled',
        boundary: 'research_budget',
        researchSessionId: id,
        durableRunId: runId,
        leaseEpoch: input.leaseEpoch,
        operationId: result.settled.reservation.reservationId,
        outcome: result.settled.reservation.status,
        remainingBudget: remainingResearchTelemetryBudget(result.settled.budget),
      });
      return {
        version: 1 as const,
        status: result.settled.reservation.status,
        chargedAttempts: result.settled.budget.chargedAttempts,
        chargedTokens: result.settled.budget.chargedTokens,
        chargedCostMicros: result.settled.budget.chargedCostMicros,
      };
    }
    throw new ConflictException('Research provider usage changed concurrently; retry settlement.');
  }

  /** Persist the complete two-leaf batch under the current lease before dispatch. */
  async persistChildTaskBatch(
    ctx: TenantContext,
    id: string,
    runId: string,
    leaseEpoch: number,
    tasks: ResearchChildTaskV1[],
  ): Promise<ResearchChildTaskV1[]> {
    return this.updateResearchChildMetadata(ctx, id, runId, leaseEpoch, (metadata, run) =>
      persistResearchChildTaskBatch({ metadata, run, tasks }),
    );
  }

  /** Persist a validated structured result before parent synthesis can observe it. */
  async persistChildTaskResult(
    ctx: TenantContext,
    id: string,
    runId: string,
    leaseEpoch: number,
    taskId: string,
    result: ResearchChildRuntimeResult,
  ): Promise<ResearchChildTaskV1[]> {
    return this.updateResearchChildMetadata(ctx, id, runId, leaseEpoch, (metadata, run) => {
      const goalRevision = currentResearchGoalRevision(metadata);
      return completeResearchChildTask({
        metadata,
        run,
        goalRevision,
        taskId,
        output: result.output,
        model: result.model,
        provider: 'openai',
        allowedEvidenceHandles: researchChildEvidenceHandles(result.citations),
      });
    });
  }

  /** Persist a typed child failure; raw provider text never becomes a finding. */
  async persistChildTaskFailure(
    ctx: TenantContext,
    id: string,
    runId: string,
    leaseEpoch: number,
    taskId: string,
    failure: Omit<ResearchChildFailureV1, 'failedAt'>,
  ): Promise<ResearchChildTaskV1[]> {
    return this.updateResearchChildMetadata(ctx, id, runId, leaseEpoch, (metadata, run) => {
      const goalRevision = currentResearchGoalRevision(metadata);
      return failResearchChildTask({
        metadata,
        run,
        goalRevision,
        taskId,
        failure,
        status: failure.code === 'cancelled' ? 'cancelled' : 'failed',
      });
    });
  }

  /** Reserve one server-owned attempt before a research runtime may dispatch it. */
  async reserveSafeReadAttempt(
    ctx: TenantContext,
    id: string,
    runId: string,
    raw: ResearchToolReservationInput,
  ) {
    const input = strictReservationInput(raw);
    const toolVersion = this.currentSafeReadToolVersion(ctx, input.tool);
    return this.reserveBoundToolAttempt(ctx, id, runId, input.leaseEpoch, {
      providerCallId: input.providerCallId,
      kind: 'dispatch',
      tool: input.tool,
      toolVersion,
      input: input.input,
    });
  }

  /** Server-to-server V3 hook; commits private result bytes and the public receipt atomically. */
  async commitSafeReadOutcome(
    ctx: TenantContext,
    id: string,
    runId: string,
    input: ResearchSafeReadOutcomeInput,
  ) {
    if (input.executionId !== input.reservationId)
      throw new ConflictException('Research outcome identity does not match its reservation.');
    let committed: { receipt: DurableResearchStepReceipt; run: ResearchRunState } | null = null;
    for (let attempt = 0; attempt < 4 && !committed; attempt += 1) {
      try {
        committed = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
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
          const receipt = await this.commitSafeReadOutcomeInTransaction(
            tx,
            ctx,
            current,
            run,
            input,
          );
          return { receipt, run };
        });
      } catch (error) {
        if (error instanceof ResearchBudgetCasRetry) continue;
        throw error;
      }
    }
    if (!committed)
      throw new ConflictException('Research lease changed while saving the reserved outcome.');
    // Commit and publication are separate failure boundaries. A revocation here
    // leaves the private result durable but withholds it from the caller.
    await this.assertReceiptPublicationAuthorized(ctx, id, committed.run);
    emitMeriApiTelemetry({
      name: 'meri.research.source.committed',
      boundary: 'research_source',
      ...admittedResearchReceiptTelemetry(id, committed.receipt),
      outcome: 'committed',
    });
    return committed.receipt;
  }

  /** A logical/unavailable owner response is durable attempt evidence, never step completion. */
  async failSafeReadAttempt(
    ctx: TenantContext,
    id: string,
    runId: string,
    input: { leaseEpoch: number; reservationId: string; code?: string },
  ) {
    if (
      !Number.isSafeInteger(input.leaseEpoch) ||
      input.leaseEpoch < 0 ||
      typeof input.reservationId !== 'string' ||
      !input.reservationId.trim()
    )
      throw new BadRequestException('Invalid research step failure identity.');
    for (let retry = 0; retry < 4; retry += 1) {
      const outcome = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const current = await tx.clioResearchSession.findFirst({
          where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
        });
        const run = readResearchRun(current?.metadata);
        if (
          !current ||
          !run ||
          run.id !== runId ||
          run.leaseEpoch !== input.leaseEpoch ||
          run.status !== 'running'
        )
          throw new ConflictException('Research lease is no longer active.');
        await this.assertResearchPublicationAuthorized(tx, ctx, current);
        let failed;
        try {
          failed = failDurableResearchStep({
            metadata: current.metadata,
            run,
            reservationId: input.reservationId,
            code: typeof input.code === 'string' ? input.code : 'owner_result_not_complete',
          });
        } catch (error) {
          if (error instanceof DurableResearchCoordinatorError)
            throw new ConflictException(error.code);
          throw error;
        }
        const changed = await this.updateActiveResearchRun(
          tx,
          ctx,
          current.id,
          run,
          current.metadata,
          failed.metadata,
          current.status,
          new Date(),
        );
        return changed ? failed : null;
      });
      if (outcome)
        return {
          version: 1 as const,
          stepId: outcome.coordinator.events.at(-1)?.stepId ?? null,
          outcome:
            outcome.coordinator.steps.find(
              (step) => step.id === outcome.coordinator.events.at(-1)?.stepId,
            )?.outcome ?? 'retryable_failure',
        };
    }
    throw new ConflictException('Research lease changed while saving the failed attempt.');
  }

  /** Reuse is limited to a prior ownership epoch; its owner proof consumes one persisted attempt. */
  async replaySafeReadOutcome(
    ctx: TenantContext,
    id: string,
    runId: string,
    request: {
      leaseEpoch: number;
      providerCallId?: string;
      tool: string;
      toolVersion: string;
      input: Record<string, unknown>;
    },
  ) {
    const replayProviderCallId = boundedAttemptIdentity(request.providerCallId);
    const candidate = await this.loadReplayCandidate(ctx, id, runId, {
      ...request,
      providerCallId: replayProviderCallId,
    });
    if (!candidate) return { replayed: false as const, dispatchAllowed: true as const };

    const proofAttemptId = `reauthorize:${researchJsonSha256({
      providerCallId: replayProviderCallId,
      priorExecutionId: candidate.receipt.executionId,
    })}`;
    const binding: ResearchToolAttemptBinding = {
      providerCallId: proofAttemptId,
      kind: 'receipt_reauthorization',
      tool: candidate.envelope.tool,
      toolVersion: candidate.envelope.toolVersion,
      input: candidate.executeInput,
    };
    const reservation = await this.reserveBoundToolAttempt(
      ctx,
      id,
      runId,
      request.leaseEpoch,
      binding,
      candidate.envelope.input,
    );
    if (!reservation.dispatchAllowed) {
      // A completed proof only records what was authorized for its original
      // release. Reusing it would turn stale owner authority into permission.
      // Reserved attempts also remain uncertain and cannot be dispatched again.
      return {
        replayed: false as const,
        dispatchAllowed: false as const,
        replayMiss:
          reservation.status === 'completed'
            ? ('completed_reauthorization_identity' as const)
            : ('reauthorization_in_flight_or_uncertain' as const),
      };
    }

    let authorized = false;
    try {
      // This actual owner query runs only after its transaction committed. A
      // lost response remains spent and the same identity cannot run it twice.
      const currentOwnerResult = await this.tools.execute(
        ctx,
        candidate.envelope.tool as never,
        candidate.executeInput,
      );
      authorized = currentOwnerResultAuthorizesReplay(
        candidate.envelope.tool,
        candidate.envelope.result,
        currentOwnerResult,
      );
    } catch {
      authorized = false;
    }
    await this.completeReservedAttempt(
      ctx,
      id,
      runId,
      request.leaseEpoch,
      reservation.reservationId,
      binding,
      authorized ? 'replay_authorized' : 'replay_denied',
    );
    if (!authorized) return { replayed: false as const, dispatchAllowed: false as const };

    const isMailTool = ['list_emails', 'search_emails', 'get_email_thread'].includes(
      candidate.envelope.tool,
    );
    const isMeetingTool = candidate.envelope.tool === 'read_client_meetings';
    const isNativeWorkTool = ['query_tasks', 'query_action_items'].includes(
      candidate.envelope.tool,
    );
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const final = await tx.clioResearchSession.findFirst({
        where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
      });
      const finalRun = readResearchRun(final?.metadata);
      if (
        !final ||
        finalRun?.id !== runId ||
        finalRun.leaseEpoch !== request.leaseEpoch ||
        finalRun.status !== 'running'
      )
        throw new ConflictException('Research lease is no longer active.');
      if (
        isMailTool &&
        !(await currentMailSourceScopeAuthorization({
          tx,
          ctx,
          sessionClientId: final.clientId,
          tool: candidate.envelope.tool,
          originalInput: candidate.envelope.input,
          savedResult: candidate.envelope.result,
        }))
      )
        return { replayed: false as const, dispatchAllowed: false as const };
      if (
        isMeetingTool &&
        !(await currentMeetingSourceScopeAuthorization({
          tx,
          ctx,
          sessionClientId: final.clientId,
          originalInput: candidate.envelope.input,
          savedResult: candidate.envelope.result,
        }))
      )
        return { replayed: false as const, dispatchAllowed: false as const };
      if (
        isNativeWorkTool &&
        !(await currentNativeWorkSourceScopeAuthorization({
          tx,
          ctx,
          sessionClientId: final.clientId,
          tool: candidate.envelope.tool,
          originalInput: candidate.envelope.input,
          savedResult: candidate.envelope.result,
        }))
      )
        return { replayed: false as const, dispatchAllowed: false as const };
      await this.assertResearchPublicationAuthorized(tx, ctx, final);
      return {
        replayed: true as const,
        dispatchAllowed: false as const,
        result: candidate.envelope.result,
        durableSafeRead: publicDurableSafeRead(candidate.receipt, true),
      };
    });
  }

  async getCoordinatorSnapshot(ctx: TenantContext, id: string, rawAfterSequence?: string) {
    const afterSequence = rawAfterSequence === undefined ? 0 : Number(rawAfterSequence);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw new BadRequestException('afterSequence must be a non-negative integer.');
    const session = await this.ensureSession(ctx, id);
    const coordinator = readDurableResearchCoordinator(session.metadata);
    if (!coordinator)
      throw new ConflictException(
        'The durable research coordinator is not available for this session.',
      );
    const events = coordinator.events.filter((event) => event.sequence > afterSequence);
    const firstRetained = coordinator.events[0]?.sequence ?? 0;
    return {
      version: 1 as const,
      researchId: session.id,
      run: readResearchRun(session.metadata),
      coordinator: publicDurableResearchCoordinator(coordinator),
      events,
      nextSequence: Math.max(afterSequence, ...coordinator.events.map((event) => event.sequence)),
      ...(coordinator.events.length >= 200 && afterSequence > 0 && firstRetained > afterSequence
        ? { cursorResetRequired: true as const }
        : {}),
    };
  }

  async steerRun(
    ctx: TenantContext,
    id: string,
    input: { version: number; requestId: string; expectedGoalRevision: number; message: string },
  ) {
    if (input.version !== 1) throw new BadRequestException('Unsupported steering DTO version.');
    for (let retry = 0; retry < 4; retry += 1) {
      const session = await this.ensureSession(ctx, id);
      if (session.reportArtifactId)
        throw new ConflictException(
          'Completed research cannot be steered. Start a new research request.',
        );
      let queued;
      try {
        queued = queueDurableResearchSteering({
          metadata: session.metadata,
          expectedGoalRevision: input.expectedGoalRevision,
          requestId: input.requestId,
          message: input.message,
        });
      } catch (error) {
        if (error instanceof DurableResearchCoordinatorError)
          throw new ConflictException(error.code);
        throw error;
      }
      if (queued.idempotentReplay)
        return {
          version: 1 as const,
          accepted: true as const,
          idempotentReplay: true as const,
          receipt: queued.receipt,
        };
      const interrupted = {
        ...terminalResearchRun(
          queued.run,
          'interrupted',
          'Steering accepted; resume will validate the revised plan',
        ),
        readyToStart: true,
        failureReason: undefined,
      };
      const metadata = { ...queued.metadata, run: interrupted };
      const changed = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioResearchSession.updateMany({
          where: {
            id,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            reportArtifactId: null,
            metadata: { equals: session.metadata ?? {} },
          },
          data: {
            status: 'researching',
            goalRevision: currentResearchGoalRevision(metadata),
            metadata: metadata as unknown as Prisma.InputJsonObject,
            updatedAt: new Date(),
          },
        }),
      );
      if (!changed.count) continue;
      const controller = this.activeRuns.get(`${ctx.tenantId}:${ctx.userId}:${id}`);
      if (controller) {
        const reason = new Error('Research goal revision changed at an ordered safe boundary.');
        reason.name = 'ResearchGoalRevisionError';
        controller.abort(reason);
      }
      return {
        version: 1 as const,
        accepted: true as const,
        idempotentReplay: false as const,
        receipt: queued.receipt,
      };
    }
    throw new ConflictException('Research changed while accepting steering; refresh and retry.');
  }

  /** Cancelling is explicit; disconnect only detaches. Request and observation are separate commits. */
  async cancelRun(
    ctx: TenantContext,
    id: string,
    input?: { version?: number; requestId?: string; reason?: string },
  ) {
    if (input?.version !== undefined && input.version !== 1)
      throw new BadRequestException('Unsupported cancellation DTO version.');
    for (let retry = 0; retry < 4; retry += 1) {
      const session = await this.ensureSession(ctx, id);
      const run = readResearchRun(session.metadata);
      if (!run || ['complete', 'failed', 'partial', 'cancelled'].includes(run.status))
        return { version: 1 as const, ok: true as const, idempotentReplay: true as const, run };
      const coordinator = readDurableResearchCoordinator(session.metadata);
      if (!coordinator) {
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
        if (!changed.count) continue;
        this.activeRuns.get(`${ctx.tenantId}:${ctx.userId}:${id}`)?.abort();
        return {
          version: 1 as const,
          ok: true as const,
          idempotentReplay: false as const,
          run: cancelled,
        };
      }
      let requested;
      try {
        requested = requestDurableResearchCancellation({
          metadata: session.metadata,
          requestId: input?.requestId ?? `legacy:${randomUUID()}`,
          reason: input?.reason ?? 'User pressed Stop',
        });
      } catch (error) {
        if (error instanceof DurableResearchCoordinatorError)
          throw new ConflictException(error.code);
        throw error;
      }
      if (requested.idempotentReplay)
        return {
          version: 1 as const,
          ok: true as const,
          idempotentReplay: true as const,
          run: requested.run,
        };
      const changed = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioResearchSession.updateMany({
          where: {
            id,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            metadata: { equals: session.metadata ?? {} },
          },
          data: {
            metadata: requested.metadata as unknown as Prisma.InputJsonObject,
            updatedAt: new Date(),
          },
        }),
      );
      if (!changed.count) continue;
      const controller = this.activeRuns.get(`${ctx.tenantId}:${ctx.userId}:${id}`);
      if (controller) controller.abort();
      else await this.observeCancellation(ctx, id, requested.run.id, requested.run.leaseEpoch);
      return {
        version: 1 as const,
        ok: true as const,
        idempotentReplay: false as const,
        run: requested.run,
      };
    }
    throw new ConflictException('Research changed while cancelling; refresh its status and retry.');
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
      if (previous && ['running', 'cancel_requested'].includes(previous.status)) {
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
      let claimedMetadata: Record<string, unknown> = {
        ...researchMetadata(session.metadata),
        run: claimed,
      };
      if (phase === 'research' && readDurableResearchCoordinator(claimedMetadata)) {
        const deadlineAt = new Date(
          now.getTime() +
            positiveNumberOr(
              this.config.get('CLIO_RESEARCH_TOTAL_BUDGET_MS', { infer: true }),
              1_800_000,
            ),
        ).toISOString();
        const activated = activateDurableResearchCoordinator({
          metadata: claimedMetadata,
          run: claimed,
          deadlineAt,
          now,
        });
        claimedMetadata = activated.metadata;
      }
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
            metadata: claimedMetadata as unknown as Prisma.InputJsonObject,
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
            // Receipts, budget and coordinator writes change the session row
            // between this read and the compare-and-swap below. A lost race is
            // not a lost lease: re-read and retry, and abort only when the
            // stored run is no longer this owner's running lease. Skipping one
            // beat is harmless (10s beats, 120s lease).
            for (let attempt = 0; attempt < HEARTBEAT_CAS_ATTEMPTS; attempt += 1) {
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
                const raw = researchMetadata(researchMetadata(current?.metadata).run);
                this.logger.warn(
                  `Research heartbeat found the lease inactive: session=${id} run=${run.id} ` +
                    `epoch=${run.leaseEpoch} stored=${JSON.stringify({
                      present: Boolean(current),
                      sameRun: stored?.id === run.id,
                      epoch: stored?.leaseEpoch ?? null,
                      status: stored?.status ?? null,
                      rawStatus: typeof raw.status === 'string' ? raw.status : null,
                      heartbeatAgeMs:
                        typeof raw.heartbeatAt === 'string'
                          ? Date.now() - Date.parse(raw.heartbeatAt)
                          : null,
                    })}`,
                );
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
              if (updated) return;
            }
            this.logger.warn(
              `Research heartbeat skipped one beat after ${HEARTBEAT_CAS_ATTEMPTS} concurrent writes: session=${id} run=${run.id}`,
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
              emitMeriApiTelemetry({
                name: 'meri.research.source.published',
                boundary: 'research_source',
                ...admittedResearchReceiptTelemetry(id, persisted),
                outcome: 'published',
              });
              data = sseEvent({
                ...event,
                sequence: persisted.sequence,
                durableSafeRead: publicDurableSafeRead(persisted, qualification.replayed === true),
              });
            }
            safeWrite(data);
          })
          .catch((error) => {
            pendingError = error;
            controller.abort(researchLeaseError('Research progress could not be persisted.'));
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
              message: isResearchObserverErrorMessage(event.message)
                ? event.message
                : projectResearchObserverError(event.message, controller.signal),
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
      await withMeriApiTelemetrySpan(
        {
          name: 'meri.research.execute',
          boundary: 'research_run',
          ...admittedResearchTelemetry(
            id,
            run,
            readResearchHandoff(session.metadata)?.conversationId,
            currentResearchGoalRevision(claimedMetadata),
          ),
        },
        () => execute(sink, { ...auth, run, signal: controller.signal }),
      );
    } catch (error) {
      const privateMessage = error instanceof Error ? error.message : 'Research failed';
      const failure = projectResearchTerminalFailure(error, controller.signal);
      if (claimed)
        await this.markFailed(
          ctx,
          id,
          { ...auth, run: claimed, signal: controller.signal },
          failure,
        );
      const terminal = [
        sseEvent({ type: 'error', message: failure.message }),
        sseEvent({ type: 'done' }),
      ];
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
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.prisma.withTenant(ctx.tenantId, async (tx) => {
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
            throw new ConflictException(
              'Research source completion was not qualified for durability.',
            );
          return this.commitSafeReadOutcomeInTransaction(tx, ctx, current, run, {
            reservationId: qualification.executionId,
            executionId: qualification.executionId,
            providerCallId: toolCallId,
            tool,
            toolVersion: qualification.toolVersion,
            input: qualification.input as Record<string, unknown>,
            result: qualification.result,
          });
        });
      } catch (error) {
        if (error instanceof ResearchBudgetCasRetry) continue;
        throw error;
      }
    }
    throw new ConflictException('Research lease changed while saving progress.');
  }

  private async loadReplayCandidate(
    ctx: TenantContext,
    id: string,
    runId: string,
    request: {
      leaseEpoch: number;
      providerCallId: string;
      tool: string;
      toolVersion: string;
      input: Record<string, unknown>;
    },
  ) {
    boundedAttemptIdentity(request.providerCallId);
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
      if (!receipt?.resultRef || !receipt.resultBodySha256) return null;
      const metadata = researchMetadata(current.metadata);
      const handoff = readResearchHandoff(current.metadata);
      const conversationId =
        handoff?.conversationId ??
        (typeof metadata.backingConversationId === 'string'
          ? metadata.backingConversationId
          : null);
      if (!conversationId) return null;
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
        return null;
      }
      if (
        envelope.executionId !== receipt.executionId ||
        envelope.providerCallId !== receipt.providerCallId ||
        envelope.runId !== receipt.runId ||
        envelope.leaseEpoch !== receipt.leaseEpoch ||
        envelope.tool !== receipt.tool ||
        envelope.toolVersion !== receipt.toolVersion ||
        envelope.inputSha256 !== receipt.inputSha256 ||
        envelope.resultSha256 !== receipt.resultSha256 ||
        classifyApiToolReadOutcome(envelope.tool, envelope.result)?.kind !== envelope.classifier ||
        !supportsDurableOwnerReauthorization(envelope.tool)
      )
        return null;
      const isMailTool = ['list_emails', 'search_emails', 'get_email_thread'].includes(
        envelope.tool,
      );
      const mailAuthorization = isMailTool
        ? await currentMailSourceScopeAuthorization({
            tx,
            ctx,
            sessionClientId: current.clientId,
            tool: envelope.tool,
            originalInput: envelope.input,
            savedResult: envelope.result,
          })
        : null;
      if (isMailTool && !mailAuthorization) return null;
      const isMeetingTool = envelope.tool === 'read_client_meetings';
      const meetingAuthorization = isMeetingTool
        ? await currentMeetingSourceScopeAuthorization({
            tx,
            ctx,
            sessionClientId: current.clientId,
            originalInput: envelope.input,
            savedResult: envelope.result,
          })
        : null;
      const isNativeWorkTool = ['query_tasks', 'query_action_items'].includes(envelope.tool);
      const nativeWorkAuthorization = isNativeWorkTool
        ? await currentNativeWorkSourceScopeAuthorization({
            tx,
            ctx,
            sessionClientId: current.clientId,
            tool: envelope.tool,
            originalInput: envelope.input,
            savedResult: envelope.result,
          })
        : null;
      if (isMeetingTool && !meetingAuthorization) return null;
      if (isNativeWorkTool && !nativeWorkAuthorization) return null;
      const reauthorizationInput =
        mailAuthorization?.executeInput ??
        meetingAuthorization?.executeInput ??
        nativeWorkAuthorization?.executeInput ??
        currentOwnerReauthorizationInput(envelope.tool, envelope.input, envelope.result);
      if (!reauthorizationInput) return null;
      return { receipt, envelope, executeInput: reauthorizationInput };
    });
  }

  private async reserveBoundToolAttempt(
    ctx: TenantContext,
    id: string,
    runId: string,
    leaseEpoch: number,
    binding: ResearchToolAttemptBinding,
    coordinatorInput: ResearchToolAttemptBinding['input'] = binding.input,
  ) {
    for (let retry = 0; retry < 4; retry += 1) {
      const result = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const current = await tx.clioResearchSession.findFirst({
          where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
        });
        const run = readResearchRun(current?.metadata);
        if (
          !current ||
          !run ||
          run.id !== runId ||
          run.leaseEpoch !== leaseEpoch ||
          run.status !== 'running'
        )
          throw new ConflictException('Research lease is no longer active.');
        await this.assertResearchPublicationAuthorized(tx, ctx, current);
        this.assertCurrentSafeReadPolicy(ctx, binding.tool, binding.toolVersion);
        const rawPlan = researchMetadata(current.metadata).researchPlan;
        let plan: ResearchPlanV1;
        try {
          plan = validateResearchPlan(rawPlan, this.researchPlanAdmissionContext(ctx, current));
        } catch {
          throw new ConflictException('The current admitted research plan is unavailable.');
        }
        let reserved;
        try {
          reserved = reserveResearchToolAttempt({
            metadata: current.metadata,
            run,
            plan,
            binding,
          });
        } catch (error) {
          if (error instanceof ResearchToolBudgetError) throw new ConflictException(error.code);
          throw error;
        }
        if (!reserved.dispatchAllowed) return { retry: false as const, reserved };
        let coordinated;
        try {
          let coordinatorMetadata = reserved.metadata;
          const coordinator = readDurableResearchCoordinator(coordinatorMetadata);
          if (coordinator && coordinator.leaseEpoch !== run.leaseEpoch) {
            coordinatorMetadata = activateDurableResearchCoordinator({
              metadata: coordinatorMetadata,
              run,
              deadlineAt:
                coordinator.deadlineAt ??
                new Date(
                  Date.now() +
                    positiveNumberOr(
                      this.config.get('CLIO_RESEARCH_TOTAL_BUDGET_MS', { infer: true }),
                      1_800_000,
                    ),
                ).toISOString(),
            }).metadata;
          }
          coordinated = reserveDurableResearchStep({
            metadata: coordinatorMetadata,
            run,
            reservationId: reserved.reservation.reservationId,
            providerCallId: binding.providerCallId,
            kind: binding.kind,
            tool: binding.tool,
            toolVersion: binding.toolVersion,
            toolInput: coordinatorInput,
          });
        } catch (error) {
          if (error instanceof DurableResearchCoordinatorError)
            throw new ConflictException(error.code);
          throw error;
        }
        const changed = await this.updateActiveResearchRun(
          tx,
          ctx,
          current.id,
          run,
          current.metadata,
          coordinated.metadata,
          current.status,
          new Date(),
        );
        return changed
          ? { retry: false as const, reserved, step: coordinated.step }
          : { retry: true as const };
      });
      if (result.retry) continue;
      const { reservation, budget, dispatchAllowed } = result.reserved;
      return {
        version: 1 as const,
        reservationId: reservation.reservationId,
        tool: reservation.tool,
        toolVersion: reservation.toolVersion,
        kind: reservation.kind,
        status: reservation.status,
        outcome: reservation.outcome,
        dispatchAllowed,
        spent: budget.spent,
        limit: budget.limit,
        ...(result.step
          ? {
              step: {
                id: result.step.id,
                goalRevision: result.step.goalRevision,
                attempt: result.step.attempt,
                deadlineAt: result.step.deadlineAt,
              },
            }
          : {}),
      };
    }
    throw new ConflictException(
      'Research budget changed concurrently; retry with the same attempt identity.',
    );
  }

  private async completeReservedAttempt(
    ctx: TenantContext,
    id: string,
    runId: string,
    leaseEpoch: number,
    reservationId: string,
    binding: ResearchToolAttemptBinding,
    outcome: ResearchToolAttemptOutcome,
  ): Promise<void> {
    for (let retry = 0; retry < 4; retry += 1) {
      const done = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const current = await tx.clioResearchSession.findFirst({
          where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
        });
        const run = readResearchRun(current?.metadata);
        if (
          !current ||
          !run ||
          run.id !== runId ||
          run.leaseEpoch !== leaseEpoch ||
          run.status !== 'running'
        )
          throw new ConflictException('Research lease is no longer active.');
        await this.assertResearchPublicationAuthorized(tx, ctx, current);
        let completed;
        try {
          completed = completeResearchToolAttempt({
            metadata: current.metadata,
            run,
            reservationId,
            binding: {
              kind: binding.kind,
              tool: binding.tool,
              toolVersion: binding.toolVersion,
              input: binding.input,
            },
            outcome,
          });
        } catch (error) {
          if (error instanceof ResearchToolBudgetError) throw new ConflictException(error.code);
          throw error;
        }
        let nextMetadata = completed.metadata;
        if (binding.kind === 'receipt_reauthorization') {
          try {
            nextMetadata = finishDurableResearchReauthorization({
              metadata: nextMetadata,
              run,
              reservationId,
              authorized: outcome === 'replay_authorized',
              operationRef: `reauthorization:${binding.providerCallId}`,
            }).metadata;
          } catch (error) {
            if (error instanceof DurableResearchCoordinatorError)
              throw new ConflictException(error.code);
            throw error;
          }
        }
        if (nextMetadata === current.metadata) return true;
        return this.updateActiveResearchRun(
          tx,
          ctx,
          current.id,
          run,
          current.metadata,
          nextMetadata,
          current.status,
          new Date(),
        );
      });
      if (done) return;
    }
    throw new ConflictException('Research lease changed while completing a reserved attempt.');
  }

  private currentSafeReadToolVersion(ctx: TenantContext, tool: string): string {
    const schema = this.tools
      .anthropicToolSchemas({ tenantId: ctx.tenantId, surface: 'chat' })
      .find((candidate) => candidate.name === tool);
    if (!schema || !this.tools.isConcurrencySafe(tool))
      throw new ConflictException('The read tool is no longer authorized by the current policy.');
    return researchToolVersion(schema.input_schema);
  }

  private assertCurrentSafeReadPolicy(ctx: TenantContext, tool: string, toolVersion: string) {
    if (this.currentSafeReadToolVersion(ctx, tool) !== toolVersion)
      throw new ConflictException('The read tool is no longer authorized by the current policy.');
  }

  private async commitSafeReadOutcomeInTransaction(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    current: Awaited<ReturnType<MeriResearchService['ensureSession']>>,
    run: ResearchRunState,
    input: ResearchSafeReadOutcomeInput,
  ) {
    if (
      !input.reservationId?.trim() ||
      input.executionId !== input.reservationId ||
      !input.providerCallId?.trim()
    )
      throw new ConflictException(
        'A durable safe-read outcome requires exact invocation identity.',
      );
    this.assertCurrentSafeReadPolicy(ctx, input.tool, input.toolVersion);
    const readOutcome = classifyApiToolReadOutcome(input.tool, input.result);
    // A partial read is receipted too: the model saw it, so the read-time
    // re-check must cover it. It never becomes a qualified report source.
    if (
      readOutcome?.kind !== 'complete' &&
      readOutcome?.kind !== 'empty' &&
      readOutcome?.kind !== 'partial'
    )
      throw new ConflictException('The owner result is not a re-checkable safe read.');

    let outcomeMetadata: unknown = current.metadata;
    if (!readDurableResearchCoordinator(outcomeMetadata)) {
      let plan: ResearchPlanV1;
      try {
        plan = validateResearchPlan(
          researchMetadata(current.metadata).researchPlan,
          this.researchPlanAdmissionContext(ctx, current),
        );
        const admittedCoordinator = admitDurableResearchCoordinator({
          metadata: outcomeMetadata,
          plan,
          objective: current.topic,
          run,
        });
        const activated = activateDurableResearchCoordinator({
          metadata: admittedCoordinator.metadata,
          run: readResearchRun(admittedCoordinator.metadata) ?? run,
          deadlineAt: new Date(
            Date.now() +
              positiveNumberOr(
                this.config.get('CLIO_RESEARCH_TOTAL_BUDGET_MS', { infer: true }),
                1_800_000,
              ),
          ).toISOString(),
        });
        outcomeMetadata = reserveDurableResearchStep({
          metadata: activated.metadata,
          run: readResearchRun(activated.metadata) ?? run,
          reservationId: input.reservationId,
          providerCallId: input.providerCallId,
          kind: 'dispatch',
          tool: input.tool,
          toolVersion: input.toolVersion,
          toolInput: input.input,
        }).metadata;
      } catch (error) {
        if (
          error instanceof ResearchPlanValidationError ||
          error instanceof DurableResearchCoordinatorError
        )
          throw new ConflictException(
            error instanceof DurableResearchCoordinatorError
              ? error.code
              : 'The current admitted research plan is unavailable.',
          );
        throw error;
      }
    }

    const existing = readDurableResearchStepReceipts(outcomeMetadata).find(
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
      const budget = readResearchToolBudget(outcomeMetadata);
      const reservation = budget?.attempts.find(
        (attempt) => attempt.reservationId === input.reservationId,
      );
      if (reservation?.status !== 'completed' || reservation.outcome !== 'result_committed')
        throw new ConflictException('The durable result is not paired to a completed reservation.');
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
    const metadata = researchMetadata(outcomeMetadata);
    const handoff = readResearchHandoff(outcomeMetadata);
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
        ? outcomeMetadata
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
    let completed;
    try {
      completed = completeResearchToolAttempt({
        metadata: appended.metadata,
        run,
        reservationId: input.reservationId,
        binding: {
          kind: 'dispatch',
          tool: input.tool,
          toolVersion: input.toolVersion,
          input: input.input,
        },
        outcome: 'result_committed',
        now: new Date(completedAt),
      });
    } catch (error) {
      if (error instanceof ResearchToolBudgetError) throw new ConflictException(error.code);
      throw error;
    }
    let coordinatedMetadata: Record<string, unknown>;
    try {
      coordinatedMetadata = completeDurableResearchStep({
        metadata: completed.metadata,
        run,
        reservationId: input.reservationId,
        receiptId: appended.receipt.receiptId,
        resultRef: artifact.id,
        sourceRef: `safe-read:${appended.receipt.receiptId}`,
        now: new Date(completedAt),
      }).metadata;
    } catch (error) {
      if (error instanceof DurableResearchCoordinatorError) throw new ConflictException(error.code);
      throw error;
    }
    const changed = await this.updateActiveResearchRun(
      tx,
      ctx,
      current.id,
      run,
      current.metadata,
      coordinatedMetadata,
      current.status,
      new Date(),
    );
    if (!changed) throw new ResearchBudgetCasRetry();
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
    if (session.run)
      emitMeriApiTelemetry({
        name: 'meri.research.replay',
        boundary: 'research_checkpoint',
        ...admittedResearchTelemetry(
          id,
          session.run,
          readResearchHandoff(session.metadata)?.conversationId,
        ),
        artifactIds: session.report ? [session.report.id] : [],
        terminalReason: 'replayed',
      });
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
    failure: ResearchTerminalFailure = projectResearchTerminalFailure(undefined),
  ) {
    if (!auth.run) return;
    try {
      const current = await this.ensureSession(ctx, id);
      const currentRun = readResearchRun(current.metadata);
      if (
        currentRun?.id === auth.run.id &&
        currentRun.leaseEpoch === auth.run.leaseEpoch &&
        currentRun.status === 'cancel_requested'
      ) {
        await this.observeCancellation(ctx, id, currentRun.id, currentRun.leaseEpoch);
        return;
      }
      if (
        currentRun?.id !== auth.run.id ||
        currentRun.leaseEpoch !== auth.run.leaseEpoch ||
        currentRun.status !== 'running' ||
        current.status === 'complete'
      )
        return;
      const status =
        failure.cause === 'lease'
          ? 'interrupted'
          : failure.cause === 'cancelled'
            ? 'cancelled'
            : failure.cause === 'partial'
              ? 'partial'
              : 'failed';
      const run = {
        ...terminalResearchRun(auth.run, status, failure.message),
        failureReason: failure.message,
      };
      const now = new Date();
      const persisted = await this.prisma.withTenant(ctx.tenantId, (tx) =>
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
      if (persisted)
        emitMeriApiTelemetry({
          name: 'meri.research.terminal',
          boundary: 'research_checkpoint',
          ...admittedResearchTelemetry(
            id,
            run,
            readResearchHandoff(current.metadata)?.conversationId,
          ),
          terminalReason: status,
          ...(failure.cause === 'lease' ? { cancellationIssuer: 'lease_lost' as const } : {}),
        });
    } catch (error) {
      this.logger.warn(
        `Could not persist research failure: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private async observeCancellation(
    ctx: TenantContext,
    id: string,
    runId: string,
    leaseEpoch: number,
  ): Promise<ResearchRunState> {
    for (let retry = 0; retry < 4; retry += 1) {
      const session = await this.ensureSession(ctx, id);
      const run = readResearchRun(session.metadata);
      if (run?.status === 'cancelled') return run;
      if (run?.id !== runId || run.leaseEpoch !== leaseEpoch || run.status !== 'cancel_requested')
        throw new ConflictException('Cancellation observation no longer matches the active run.');
      let observed;
      try {
        observed = observeDurableResearchCancellation({ metadata: session.metadata });
      } catch (error) {
        if (error instanceof DurableResearchCoordinatorError)
          throw new ConflictException(error.code);
        throw error;
      }
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
            metadata: observed.metadata as unknown as Prisma.InputJsonObject,
            updatedAt: new Date(),
          },
        }),
      );
      if (changed.count) {
        emitMeriApiTelemetry({
          name: 'meri.research.cancelled',
          boundary: 'research_checkpoint',
          ...admittedResearchTelemetry(
            id,
            observed.run,
            readResearchHandoff(session.metadata)?.conversationId,
          ),
          terminalReason: 'cancelled',
          cancellationIssuer: 'user',
        });
        return observed.run;
      }
    }
    throw new ConflictException('Research changed while observing cancellation.');
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
      buildPlanUserPrompt(session.topic, clientContext, promptDeliverable(session)),
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
      const failure = projectResearchTerminalFailure(err, auth.signal);
      this.logger.warn(`Research plan failed: ${privateMessage}`);
      // A failed provider is a recoverable failed attempt, never a fabricated plan.
      await this.markFailed(ctx, session.id, auth, failure);
      sse.write(sseEvent({ type: 'error', message: failure.message }));
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
      let budgetedMetadata: Record<string, unknown>;
      try {
        budgetedMetadata = admitResearchToolBudget(
          currentMetadata,
          admitted.budget.toolCalls,
        ).metadata;
      } catch (error) {
        if (error instanceof ResearchToolBudgetError) throw new ConflictException(error.code);
        throw error;
      }
      const coordinated = admitDurableResearchCoordinator({
        metadata: budgetedMetadata,
        plan: admitted,
        objective: session.topic,
        run: auth.run!,
      });
      const coordinatedRun = readResearchRun(coordinated.metadata) ?? auth.run!;
      const persistedMetadata = {
        ...coordinated.metadata,
        researchPlan: admitted,
        run: terminalResearchRun(
          coordinatedRun,
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
              run: terminalResearchRun(coordinatedRun, 'awaiting_clarification', 'Plan ready'),
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
      const failure = projectResearchTerminalFailure(error, auth.signal);
      this.logger.warn(`Research run failed: ${privateMessage}`);
      await this.markFailed(ctx, id, auth, failure);
      sse.write(sseEvent({ type: 'error', message: failure.message }));
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
    const activeRunId = auth.run.id;
    await this.assertRunActive(ctx, id, activeRunId);

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
        deliverable: promptDeliverable(session),
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
      if (
        acceptedSession.clientId !== session.clientId ||
        (acceptedHandoff?.conversationId ?? null) !== (handoff?.conversationId ?? null)
      ) {
        throw new ConflictException('Research scope changed during dispatch preparation.');
      }
      const baseAcceptedUser = [
        buildResearchUserPrompt({
          topic: acceptedSession.topic,
          plan: researchPlanStringProjection(acceptedPlan),
          clarifyingQuestions: asStringArray(acceptedSession.clarifyingQuestions),
          clarifyingAnswers: asStringRecord(acceptedSession.clarifyingAnswers),
          clientContext,
          deliverable: promptDeliverable(acceptedSession),
        }),
        `ADMITTED RESEARCH PLAN CONTRACT v${acceptedPlan.version}:\n${JSON.stringify(acceptedPlan)}`,
        researchHandoffPrompt(acceptedHandoff, acceptedSession.id),
      ]
        .filter(Boolean)
        .join('\n\n');
      progress.set('Running two bounded read-only evidence reviews…');
      const childResults = await this.runBoundedResearchChildren(
        ctx,
        acceptedSession,
        acceptedPlan,
        clientContext,
        auth,
      );
      if (auth.signal?.aborted) throw new BadRequestException('Research was cancelled.');
      // Child execution and source reauthorization can span multiple awaits.
      // Rebind the parent dispatch after them, before admitting child prose.
      const currentDispatch = await this.admitFreshResearchPlanForDispatch(ctx, id, auth);
      if (
        currentResearchGoalRevision(currentDispatch.session.metadata) !==
          currentResearchGoalRevision(acceptedSession.metadata) ||
        researchJsonSha256(currentDispatch.plan) !== researchJsonSha256(acceptedPlan)
      ) {
        throw new ConflictException(
          'Research goal or scope changed while child findings were running.',
        );
      }
      const acceptedUser = [
        baseAcceptedUser,
        childResults.length
          ? [
              'PERSISTED CURRENTLY-AUTHORIZED BOUNDED CHILD FINDINGS:',
              JSON.stringify(
                childResults.map((child) => ({
                  taskId: child.taskId,
                  goalRevision: child.output.goalRevision,
                  findings: child.output.findings,
                  limitations: child.output.limitations,
                })),
              ),
              'Synthesize these findings as evidence summaries, not as a final answer. Preserve their exact source handles and report contradictions or limitations.',
            ].join('\n')
          : 'No bounded child finding passed the typed result and current-source gates. Research directly and report the gap truthfully.',
      ].join('\n\n');
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
            // A report publishes only when every producer input can be
            // re-checked at read, so the run reads only through such tools.
            allowedReadCapabilities: [
              ...new Set(
                acceptedPlan.steps
                  .flatMap((step) => step.allowedCapabilities)
                  .filter(
                    (name) =>
                      this.tools.isConcurrencySafe(name) && researchProducerInputCoverableTool(name),
                  ),
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
      const joinedResult = joinResearchChildEvidence(result, childResults);
      await this.finishResearch(ctx, acceptedSession, sse, progress, {
        ...joinedResult,
        // Admitted child findings enter the parent prompt with their inputs.
        ...joinResearchProducerInputs(result, childResults),
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
        if (!auth.run) throw new ConflictException('Legacy research requires an active run lease.');
        const requestBody = JSON.stringify(
          prepareAnthropicRequest({
            model,
            max_tokens: thinking.maxTokens,
            ...(thinking.thinking ? { thinking: thinking.thinking } : { temperature: 0.2 }),
            stream: true,
            system,
            tools: toolSchemas,
            messages,
          }),
        );
        const providerReservation = await this.reserveLegacyProviderAttempt(
          ctx,
          id,
          auth.run,
          'acquisition',
          model,
          requestBody,
          thinking.maxTokens,
        );
        let providerSettlementAttempted = false;
        let providerInputTokens: number | null = null;
        let providerOutputTokens: number | null = null;

        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
            body: requestBody,
            signal: auth.signal
              ? AbortSignal.any([controller.signal, auth.signal])
              : controller.signal,
          });

          if (!response.ok || !response.body) {
            const errText = await response.text().catch(() => '');
            throw new ResearchTerminalError(
              'provider',
              `Anthropic HTTP ${response.status}${errText ? `: ${errText.slice(0, 300)}` : ''}`,
            );
          }

          const responseBody = response.body as unknown as AsyncIterable<Uint8Array>;
          for await (const evt of anthropicStreamEvents(responseBody)) {
            if (
              evt.type === 'message_start' &&
              Number.isSafeInteger(evt.message?.usage?.input_tokens)
            )
              providerInputTokens = Number(evt.message.usage.input_tokens);
            if (evt.type === 'message_delta' && Number.isSafeInteger(evt.usage?.output_tokens))
              providerOutputTokens = Number(evt.usage.output_tokens);
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
          }
          providerSettlementAttempted = true;
          await this.settleLegacyProviderAttempt(
            ctx,
            id,
            auth.run,
            providerReservation,
            providerInputTokens !== null && providerOutputTokens !== null
              ? {
                  kind: 'known',
                  inputTokens: providerInputTokens,
                  outputTokens: providerOutputTokens,
                }
              : { kind: 'uncertain' },
          );
        } catch (roundErr) {
          if (!providerSettlementAttempted) {
            providerSettlementAttempted = true;
            await this.settleLegacyProviderAttempt(ctx, id, auth.run, providerReservation, {
              kind: 'uncertain',
            });
          }
          // A per-round abort means this model turn exceeded the (long) research
          // timeout. Don't let it kill the whole run — stop gathering and fall
          // through to the forced-synthesis pass so we still write a report
          // rather than persisting only the sources gathered so far.
          if (isControllerAbort(roundErr, controller.signal) && !auth.signal?.aborted) {
            this.logger.warn(`Research gather round ${round} timed out; forcing synthesis`);
            break;
          }
          if (roundErr instanceof ResearchTerminalError) throw roundErr;
          throw new ResearchTerminalError(
            'provider',
            roundErr instanceof Error ? roundErr.message : 'Anthropic gather request failed.',
          );
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
          let dispatchReservationId: string | undefined;
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
                      providerCallId: t.id,
                      tool: t.name,
                      toolVersion,
                      input: parsedInput,
                    })
                  : { replayed: false as const };
              if (replay.replayed) {
                resultPayload = replay.result;
                replayedReceipt = replay.durableSafeRead;
              } else {
                if ('dispatchAllowed' in replay && replay.dispatchAllowed === false)
                  throw new ConflictException(
                    'This research attempt was already spent or its replay proof failed; it was not dispatched again.',
                  );
                const reservation = await this.reserveBoundToolAttempt(
                  ctx,
                  id,
                  auth.run!.id,
                  auth.run!.leaseEpoch,
                  {
                    providerCallId: t.id,
                    kind: 'dispatch',
                    tool: t.name,
                    toolVersion,
                    input: parsedInput,
                  },
                );
                if (!reservation.dispatchAllowed)
                  throw new ConflictException(
                    'This research attempt was already reserved; it was not dispatched again.',
                  );
                dispatchReservationId = reservation.reservationId;
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
          if (!qualifiedSuccess && dispatchReservationId && auth.run) {
            await this.failSafeReadAttempt(ctx, id, auth.run.id, {
              leaseEpoch: auth.run.leaseEpoch,
              reservationId: dispatchReservationId,
              code: readOutcome?.kind ?? 'unknown_owner_result',
            });
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
                  executionId: dispatchReservationId,
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
        // The persisted absolute deadline is authoritative across resume and
        // forced synthesis; this pass may not create a post-deadline grace window.
        const synthesisTimeoutMs = Math.min(timeoutMs, deadlineAt - Date.now());
        if (synthesisTimeoutMs <= 0)
          throw new BadRequestException(
            'Research deadline reached before final synthesis; no complete report was fabricated.',
          );
        const timer = setTimeout(() => controller.abort(), synthesisTimeoutMs);
        let thinkingStatusSent = false;
        const synthesisRequestBody = JSON.stringify(
          prepareAnthropicRequest({
            model,
            max_tokens: thinking.maxTokens,
            ...(thinking.thinking ? { thinking: thinking.thinking } : { temperature: 0.2 }),
            stream: true,
            system,
            messages,
          }),
        );
        const synthesisReservation = await this.reserveLegacyProviderAttempt(
          ctx,
          id,
          auth.run,
          'synthesis',
          model,
          synthesisRequestBody,
          thinking.maxTokens,
        );
        let synthesisSettlementAttempted = false;
        let synthesisInputTokens: number | null = null;
        let synthesisOutputTokens: number | null = null;
        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
            body: synthesisRequestBody,
            signal: auth.signal
              ? AbortSignal.any([controller.signal, auth.signal])
              : controller.signal,
          });
          if (!response.ok || !response.body) {
            const errText = await response.text().catch(() => '');
            throw new ResearchTerminalError(
              'provider',
              `Anthropic HTTP ${response.status}${errText ? `: ${errText.slice(0, 300)}` : ''}`,
            );
          }
          if (!synthesizing) {
            synthesizing = true;
            sse.write(sseEvent({ type: 'phase', phase: 'synthesize' }));
          }
          const responseBody = response.body as unknown as AsyncIterable<Uint8Array>;
          for await (const evt of anthropicStreamEvents(responseBody)) {
            if (
              evt.type === 'message_start' &&
              Number.isSafeInteger(evt.message?.usage?.input_tokens)
            )
              synthesisInputTokens = Number(evt.message.usage.input_tokens);
            if (evt.type === 'message_delta' && Number.isSafeInteger(evt.usage?.output_tokens))
              synthesisOutputTokens = Number(evt.usage.output_tokens);
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
          }
          synthesisSettlementAttempted = true;
          await this.settleLegacyProviderAttempt(
            ctx,
            id,
            auth.run,
            synthesisReservation,
            synthesisInputTokens !== null && synthesisOutputTokens !== null
              ? {
                  kind: 'known',
                  inputTokens: synthesisInputTokens,
                  outputTokens: synthesisOutputTokens,
                }
              : { kind: 'uncertain' },
          );
        } catch (synthErr) {
          if (!synthesisSettlementAttempted) {
            synthesisSettlementAttempted = true;
            await this.settleLegacyProviderAttempt(ctx, id, auth.run, synthesisReservation, {
              kind: 'uncertain',
            });
          }
          // Keep whatever prose streamed before an abort rather than discarding
          // it — a partial report is still more useful than sources alone.
          if (isControllerAbort(synthErr, controller.signal) && !auth.signal?.aborted) {
            this.logger.warn('Forced research synthesis timed out; keeping partial report');
          } else {
            if (synthErr instanceof ResearchTerminalError) throw synthErr;
            throw new ResearchTerminalError(
              'provider',
              synthErr instanceof Error ? synthErr.message : 'Anthropic synthesis request failed.',
            );
          }
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (err) {
      const privateMessage = err instanceof Error ? err.message : 'Research failed';
      this.logger.warn(`Research run failed: ${privateMessage}`);
      throw err;
    }

    if (auth.signal?.aborted) throw new BadRequestException('Research was cancelled.');
    if (!endedCleanly) throw new ResearchTerminalError('partial');
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
      producerInputMode?: ResearchProducerInputMode;
      clientContextSha256?: string | null;
      producerInputDraft?: ResearchProducerInputDraftV1 | null;
      producerInputCategories?: ResearchProducerInputCategories;
      producerClientContext?: string | null;
    },
  ) {
    // Source completions are fenced and saved before report persistence or observer delivery.
    await sse.flush?.();
    let { reportBody } = result;
    const { sources, ledgerEntries, model, auditorMode, bufferReport } = result;
    // Producers list a tool once per read; the report declares each tool once,
    // as its publication and read-time proofs require (T5 cab91bd9: ten
    // read_client_documents reads refused the report).
    const toolsUsed = [...new Set(result.toolsUsed)];
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
    // What the reviewer must see to decide a hold: each finding with the exact
    // flagged sentence. Stored on the review request, never logged.
    let heldFindings: Array<{ check: string; severity: string; detail: string; span: string }> = [];
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
            heldFindings = verdict.findings.slice(0, 10).map((finding) => ({
              check: finding.check,
              severity: finding.severity,
              detail: finding.detail.slice(0, 500),
              span: finding.span.slice(0, 500),
            }));
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
    const producerInput: {
      producerInputSha256?: string;
      producerInputMode?: ResearchProducerInputMode;
      clientContextSha256: string | null;
      producerInputDraft?: ResearchProducerInputDraftV1 | null;
      producerInputCategories?: ResearchProducerInputCategories;
    } = result.producerInputEvaluated
      ? {
          producerInputSha256: result.producerInputSha256,
          producerInputMode: result.producerInputMode,
          clientContextSha256: result.clientContextSha256 ?? null,
          producerInputDraft: result.producerInputDraft ?? null,
          producerInputCategories: result.producerInputCategories,
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
      throw researchProducerProofUnavailable(
        session.id,
        'finish:producer_input_missing',
        toolsUsed,
      );
    if (producerInput.producerInputMode === 'unsupported_private_inputs') {
      this.logger.warn(
        `Research producer inputs refused: session=${session.id} ` +
          describeResearchProducerInputCategories(producerInput.producerInputCategories),
      );
      throw new ConflictException(
        'The research report includes private producer inputs without a current authorization adapter.',
      );
    }
    let producerInputManifest: ResearchProducerInputManifestV1 | undefined;
    if (producerInput.producerInputMode === 'governed_inputs') {
      const draft = producerInput.producerInputDraft;
      if (!draft)
        throw researchProducerProofUnavailable(
          session.id,
          'finish:governed_draft_missing',
          toolsUsed,
        );
      try {
        producerInputManifest = await this.prisma.withTenant(ctx.tenantId, (tx) =>
          pinResearchProducerInputs(
            tx,
            ctx,
            { sessionClientId: session.clientId, conversationId: handoff?.conversationId ?? null },
            draft,
          ),
        );
      } catch (error) {
        if (error instanceof ResearchProducerInputNotCurrent)
          this.logger.warn(
            `Research producer input not current at publication: session=${session.id} category=${error.category}`,
          );
        throw error;
      }
      this.logger.log(
        `Research producer inputs governed: session=${session.id} ` +
          describeResearchProducerInputCategories(producerInput.producerInputCategories),
      );
    }
    await this.assertReplayedReportSourcesAuthorized(
      ctx,
      session.id,
      result.runAuth.run!,
      toolsUsed,
      { ...producerInput, producerInputManifest },
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

    // Release D: a held report never posts a card; otherwise post each final
    // approval step's card while the run still holds its lease, and record it
    // on the step in the same write that saves the report.
    const postedApprovals = held
      ? []
      : await this.postJobApprovalProposals(ctx, session, result.runAuth, reportBody);
    const artifactId = randomUUID();
    const reportMessageId = handoff?.conversationId ? randomUUID() : null;
    const persisted = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const currentMetadata = await this.fenceRun(tx, ctx, session.id, result.runAuth);
      let approvalMetadata: unknown = withoutProducerInputManifest(
        researchMetadata(currentMetadata),
      );
      for (const posted of postedApprovals) {
        try {
          approvalMetadata = recordDurableResearchApprovalProposal({
            metadata: approvalMetadata,
            ...posted,
          }).metadata;
        } catch (error) {
          this.logger.warn(
            `meri.job.approval.record_failed ${JSON.stringify({ sessionId: session.id, ...posted, code: error instanceof DurableResearchCoordinatorError ? error.code : 'unknown' })}`,
          );
        }
      }
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
        producerInputMode: producerInput.producerInputMode as
          | 'source_free'
          | 'covered_inputs'
          | 'governed_inputs',
        clientContextSha256: producerInput.clientContextSha256,
        ...(producerInputManifest
          ? { producerInputManifestSha256: researchJsonSha256(producerInputManifest) }
          : {}),
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
            ...researchMetadata(approvalMetadata),
            backingConversationId: conversationId,
            ...(result.citations ? { citations: result.citations } : {}),
            run: terminalResearchRun(
              result.runAuth.run!,
              'complete',
              held ? 'Report held for review' : 'Report saved',
            ),
            heldForReview: held,
            // Private: ids and versions only, re-checked on every report read.
            ...(producerInputManifest ? { producerInputManifest } : {}),
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

    emitMeriApiTelemetry({
      name: 'meri.research.report.published',
      boundary: 'research_checkpoint',
      ...admittedResearchTelemetry(session.id, result.runAuth.run!, persisted.conversationId),
      artifactIds: [artifactId],
      terminalReason: 'completed',
      verificationVerdict: held ? 'fail' : 'unknown',
      outcome: 'saved_and_authorized',
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
        payload: { artifactId, findings: heldFindings },
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

  private async runBoundedResearchChildren(
    ctx: TenantContext,
    session: Awaited<ReturnType<MeriResearchService['ensureSession']>>,
    plan: ResearchPlanV1,
    clientContext: string | null,
    auth: ResearchRuntimeAuth,
  ): Promise<ResearchChildRuntimeResult[]> {
    if (!this.v3Research || !auth.run)
      throw new ConflictException('Bounded child research requires the active V3 run.');
    const run = auth.run;
    const handoff = readResearchHandoff(session.metadata);
    const allowed = [
      ...new Set(
        plan.steps
          .filter((step) => step.effect === 'read')
          .flatMap((step) => step.allowedCapabilities)
          .filter(
            (capability) =>
              this.tools.isConcurrencySafe(capability) &&
              !this.tools.isSideEffecting(capability) &&
              Boolean(publicResearchSourceTool(capability)),
          ),
      ),
    ].sort();
    // Child findings must remain compatible with the existing report provenance
    // owner. Plans without a currently reauthorizable source stay parent-only.
    if (!allowed.length) return [];
    const left = allowed.filter((_capability, index) => index % 2 === 0);
    const right = allowed.filter((_capability, index) => index % 2 === 1);
    if (!right.length) right.push(...left);
    const goalRevision = currentResearchGoalRevision(session.metadata);
    const providerDeadline = this.researchProviderBudgetLimits(run).deadlineAt;
    const coordinatorDeadline = researchMetadata(
      researchMetadata(session.metadata).durableCoordinator,
    ).deadlineAt;
    const deadlineAt =
      typeof coordinatorDeadline === 'string' &&
      Number.isFinite(Date.parse(coordinatorDeadline)) &&
      Date.parse(coordinatorDeadline) < Date.parse(providerDeadline)
        ? coordinatorDeadline
        : providerDeadline;
    const tasks = createResearchChildTaskBatch({
      specs: [
        {
          id: `${run.id}:child:${goalRevision}:1`,
          role: 'evidence_reviewer',
          goal: boundResearchChildGoal(
            `Review the admitted evidence for: ${plan.steps
              .filter((step) => step.effect === 'read')
              .map((step) => step.objective)
              .join('; ')}`,
          ),
          allowedCapabilities: left,
        },
        {
          id: `${run.id}:child:${goalRevision}:2`,
          role: 'scope_analyst',
          goal: boundResearchChildGoal(
            `Independently identify scope gaps and contradictions for: ${plan.steps
              .filter((step) => step.effect === 'read')
              .map((step) => step.objective)
              .join('; ')}`,
          ),
          allowedCapabilities: right,
        },
      ],
      run,
      scope: plan.scope,
      parentPlan: plan,
      parentAllowedReadCapabilities: allowed,
      evidenceHandles: [],
      goalRevision,
      modelConfig: {
        policy: 'current_approved_research_model',
        provider: 'openai',
        modelSelection: 'server_resolved',
        reasoningMode: handoff?.reasoningMode ?? 'deep',
        allowProviderFallback: false,
      },
      deadlineAt,
    });
    await this.persistChildTaskBatch(ctx, session.id, run.id, run.leaseEpoch, tasks);

    const outcomes = await Promise.all(
      tasks.map(async (task): Promise<ResearchChildRuntimeResult | null> =>
        withMeriApiTelemetrySpan(
          {
            name: 'meri.research.child',
            boundary: 'research_child',
            ...admittedResearchTelemetry(session.id, run, handoff?.conversationId, goalRevision),
            childRunId: task.id,
          },
          async () => {
            try {
              const result = await this.v3Research!.runChild(
                ctx,
                task,
                {
                  sessionId: session.id,
                  conversationId: handoff?.conversationId ?? null,
                  clientId: session.clientId,
                  system: '',
                  user: '',
                  handoff,
                  clientContext,
                  admittedPlanExecution: {
                    plan,
                    allowedReadCapabilities: task.allowedCapabilities,
                  },
                },
                auth,
              );
              await this.persistChildTaskResult(
                ctx,
                session.id,
                run.id,
                run.leaseEpoch,
                task.id,
                result,
              );
              emitMeriApiTelemetry({
                name: 'meri.research.child.persisted',
                boundary: 'research_child',
                childRunId: task.id,
                outcome: 'persisted',
                durableRunId: run.id,
                goalRevision,
                leaseEpoch: run.leaseEpoch,
              });
              return result;
            } catch (error) {
              const failure = researchChildFailure(error, auth.signal);
              this.logger.warn(
                `Research child failed: session=${session.id} child=${task.id} ${failure.code}: ${failure.message}`,
              );
              try {
                await this.persistChildTaskFailure(
                  ctx,
                  session.id,
                  run.id,
                  run.leaseEpoch,
                  task.id,
                  failure,
                );
                emitMeriApiTelemetry({
                  name: 'meri.research.child.failed',
                  boundary: 'research_child',
                  childRunId: task.id,
                  outcome: failure.code,
                  durableRunId: run.id,
                  goalRevision,
                  leaseEpoch: run.leaseEpoch,
                });
              } catch {
                // Stop, lease loss, or steering already owns the authoritative state.
              }
              return null;
            }
          },
        ),
      ),
    );
    if (auth.signal?.aborted) throw new BadRequestException('Research was cancelled.');
    const successful = outcomes.filter(
      (outcome): outcome is ResearchChildRuntimeResult => outcome !== null,
    );
    const current = await this.ensureSession(ctx, session.id);
    const currentRun = readResearchRun(current.metadata);
    if (
      currentRun?.id !== run.id ||
      currentRun.leaseEpoch !== run.leaseEpoch ||
      currentRun.status !== 'running'
    ) {
      throw new ConflictException('Research lease is no longer active.');
    }
    if (currentResearchGoalRevision(current.metadata) !== goalRevision)
      throw new ConflictException('Research goal changed while child findings were running.');
    const persisted = new Map(
      readResearchChildTasks(current.metadata).map((task) => [task.id, task]),
    );
    const completed = successful.filter(
      (child) => persisted.get(child.taskId)?.status === 'completed',
    );
    // A child's findings carry its producer inputs into the parent. A child
    // with an input class that has no current-authorization adapter is dropped.
    const ungoverned = completed.filter(
      (child) => child.producerInputMode === 'unsupported_private_inputs',
    );
    for (const child of ungoverned) {
      this.logger.warn(
        `Bounded child producer inputs refused: session=${session.id} task=${child.taskId} ` +
          describeResearchProducerInputCategories(child.producerInputCategories),
      );
      await this.persistChildTaskFailure(ctx, session.id, run.id, run.leaseEpoch, child.taskId, {
        code: 'source_not_current',
        message: 'A child input has no current-authorization adapter.',
      }).catch(() => undefined);
    }
    const eligible = completed.filter(
      (child) => child.producerInputMode !== 'unsupported_private_inputs',
    );
    if (!eligible.length) return [];

    const toolsUsed = [...new Set(eligible.flatMap((child) => child.toolsUsed))].sort();
    try {
      await assertCurrentResearchReportSourcesAuthorized({
        prisma: this.prisma,
        tools: this.tools,
        ctx,
        scope: {
          sessionId: session.id,
          clientId: session.clientId,
          conversationId: handoff?.conversationId ?? undefined,
          publication: {
            runId: run.id,
            leaseEpoch: run.leaseEpoch,
            toolsUsed,
            producerInputSha256: researchJsonSha256({
              version: 1,
              childTasks: eligible.map((child) => ({
                taskId: child.taskId,
                output: child.output,
              })),
            }),
            producerInputMode: 'covered_inputs',
            clientContextSha256: eligible[0]?.clientContextSha256 ?? null,
          },
        },
      });
    } catch (error) {
      await Promise.all(
        eligible.map((child) =>
          this.persistChildTaskFailure(ctx, session.id, run.id, run.leaseEpoch, child.taskId, {
            code: 'source_not_current',
            message: 'A child source could not be reauthorized by its current owner.',
          }).catch(() => undefined),
        ),
      );
      this.logger.warn(
        `Bounded child source proof failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return [];
    }
    return eligible;
  }

  private async updateResearchChildMetadata(
    ctx: TenantContext,
    id: string,
    runId: string,
    leaseEpoch: number,
    mutate: (metadata: unknown, run: ResearchRunState) => Record<string, unknown>,
  ): Promise<ResearchChildTaskV1[]> {
    for (let retry = 0; retry < 4; retry += 1) {
      const result = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const current = await tx.clioResearchSession.findFirst({
          where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
        });
        const run = readResearchRun(current?.metadata);
        if (
          !current ||
          !run ||
          run.id !== runId ||
          run.leaseEpoch !== leaseEpoch ||
          run.status !== 'running'
        ) {
          throw new ConflictException('Research lease is no longer active.');
        }
        const nextMetadata = mutate(current.metadata, run);
        if (nextMetadata === current.metadata) {
          return { retry: false as const, tasks: readResearchChildTasks(current.metadata) };
        }
        const changed = await this.updateActiveResearchRun(
          tx,
          ctx,
          current.id,
          run,
          current.metadata,
          nextMetadata,
          current.status,
          new Date(),
        );
        return changed
          ? { retry: false as const, tasks: readResearchChildTasks(nextMetadata) }
          : { retry: true as const };
      });
      if (!result.retry) return result.tasks;
    }
    throw new ConflictException(
      'Research child state changed concurrently; retry with the same child identity.',
    );
  }

  private researchProviderBudgetLimits(run: ResearchRunState): ResearchProviderBudgetLimitsV1 {
    if (this.config.get('CLIO_RESEARCH_PROVIDER_BUDGET_ENABLED', { infer: true }) === false)
      throw new ConflictException('research_provider_budget_disabled');
    const maxAttempts = positiveNumberOr(
      this.config.get('CLIO_RESEARCH_MAX_PROVIDER_ATTEMPTS', { infer: true }),
      23,
    );
    const maxTokens = positiveNumberOr(
      this.config.get('CLIO_RESEARCH_MAX_TOTAL_TOKENS', { infer: true }),
      120_000,
    );
    const maxCostUsd = positiveNumberOr(
      this.config.get('CLIO_RESEARCH_MAX_COST_USD', { infer: true }),
      (120_000 / 1_000_000) * Math.max(...Object.values(AI_PRICING).map((p) => p.outputPerM)),
    );
    const budgetMs = positiveNumberOr(
      this.config.get('CLIO_RESEARCH_TOTAL_BUDGET_MS', { infer: true }),
      1_800_000,
    );
    return {
      maxAttempts: Math.floor(maxAttempts),
      maxTokens: Math.floor(maxTokens),
      maxCostMicros: Math.max(1, Math.floor(maxCostUsd * 1_000_000)),
      deadlineAt: new Date(Date.parse(run.startedAt) + budgetMs).toISOString(),
    };
  }

  private async reserveLegacyProviderAttempt(
    ctx: TenantContext,
    sessionId: string,
    run: ResearchRunState,
    phase: string,
    model: string,
    requestBody: string,
    maxOutputTokens: number,
  ) {
    const logicalOperationId = `legacy:${createHash('sha256')
      .update(JSON.stringify({ phase, model, requestBody }))
      .digest('hex')}`;
    const attemptId = `${logicalOperationId}:0`;
    const reserved = await this.reserveProviderAttempt(ctx, sessionId, run.id, {
      leaseEpoch: run.leaseEpoch,
      logicalOperationId,
      attemptId,
      retryOfAttemptId: null,
      kind: 'anthropic_messages',
      phase,
      provider: 'anthropic',
      model,
      maxInputTokens: Buffer.byteLength(requestBody, 'utf8'),
      maxOutputTokens,
    });
    if (!reserved.dispatchAllowed)
      throw new ConflictException('Research provider attempt was not admitted for dispatch.');
    return {
      reservationId: reserved.reservationId,
      logicalOperationId,
      attemptId,
      retryOfAttemptId: null,
      kind: 'anthropic_messages' as const,
      phase,
      provider: 'anthropic',
      model,
    };
  }

  private async settleLegacyProviderAttempt(
    ctx: TenantContext,
    sessionId: string,
    run: ResearchRunState,
    reservation: {
      reservationId: string;
      logicalOperationId: string;
      attemptId: string;
      retryOfAttemptId: string | null;
      kind: 'anthropic_messages';
      phase: string;
      provider: string;
      model: string;
    },
    outcome:
      | { kind: 'known'; inputTokens: number; outputTokens: number }
      | { kind: 'rejected' }
      | { kind: 'uncertain' },
  ): Promise<void> {
    await this.settleProviderAttempt(ctx, sessionId, run.id, {
      leaseEpoch: run.leaseEpoch,
      ...reservation,
      outcome: outcome.kind,
      inputTokens: outcome.kind === 'known' ? outcome.inputTokens : null,
      outputTokens: outcome.kind === 'known' ? outcome.outputTokens : null,
    });
  }

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
        : this.anthropicComplete(ctx, session.id, auth, nextSystem, nextUser);

    const raw = await complete(system, user);
    // The reply's shape, never its text: tells a cut-off reply from prose or
    // fences around a valid plan (T7's steering re-plan failed both attempts
    // with plan_must_be_strict_json and nothing else to go on, 2026-10-07).
    const logInvalid = (attempt: 'first' | 'repair', reply: unknown, issues: string[]) =>
      this.logger.warn(
        `meri.research.plan_invalid ${JSON.stringify({
          sessionId: session.id,
          attempt,
          issues: issues.slice(0, 8),
          reply: describePlanReply(reply),
        })}`,
      );
    // A newly proposed plan may not hang work off an approval step (it never
    // runs); stored plans are re-checked at dispatch without this rule.
    const proposalContext = { ...admissionContext, approvalStepsMustBeFinal: true };
    try {
      return validateResearchPlan(raw, proposalContext);
    } catch (error) {
      if (!(error instanceof ResearchPlanValidationError)) throw error;
      logInvalid('first', raw, error.issues);
      if (auth.run) await this.assertRunActive(ctx, session.id, auth.run.id);
      const repair = buildResearchPlanRepairPrompt(system, raw, error);
      const repairedRaw = await complete(repair.system, `${user}\n\n${repair.user}`);
      try {
        return validateResearchPlan(repairedRaw, proposalContext);
      } catch (repairError) {
        if (!(repairError instanceof ResearchPlanValidationError)) throw repairError;
        logInvalid('repair', repairedRaw, repairError.issues);
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
    const coordinator = readDurableResearchCoordinator(session.metadata);
    const pendingSteering = coordinator?.inbox.filter(
      (message) => message.sequence > coordinator.appliedInboxSequence,
    );
    if (coordinator && pendingSteering?.length) {
      if (!auth.run)
        throw new ConflictException('Steering revalidation requires an active run lease.');
      const clientContext = await this.clientContext(ctx, session.clientId);
      const currentPlan = researchMetadata(session.metadata).researchPlan;
      const system = buildResearchPlanSystemPrompt(PRODUCT_NAME, context);
      const user = [
        buildPlanUserPrompt(session.topic, clientContext, promptDeliverable(session)),
        `CURRENT ADMITTED PLAN (replace it; do not expand its tool-call budget):\n${JSON.stringify(currentPlan)}`,
        `ORDERED STEERING INBOX THROUGH GOAL REVISION ${coordinator.goalRevision}:\n${pendingSteering
          .map((message) => `${message.sequence}. ${message.message}`)
          .join('\n')}`,
        'Return a complete replacement plan. Preserve truthful prior effects, but do not treat old-revision pending work or model claims as completed evidence.',
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
        const currentCoordinator = readDurableResearchCoordinator(current?.metadata);
        if (
          !current ||
          !currentRun ||
          currentRun.id !== auth.run!.id ||
          currentRun.leaseEpoch !== auth.run!.leaseEpoch ||
          currentRun.status !== 'running' ||
          !currentCoordinator ||
          currentCoordinator.goalRevision !== coordinator.goalRevision ||
          !currentCoordinator.inbox.some(
            (message) => message.sequence > currentCoordinator.appliedInboxSequence,
          )
        )
          throw new ConflictException(
            'Research goal revision changed while revalidating the plan.',
          );
        await this.assertResearchPublicationAuthorized(tx, ctx, current);
        const admitted = validateResearchPlan(
          proposed,
          this.researchPlanAdmissionContext(ctx, current),
        );
        let budgetedMetadata: Record<string, unknown>;
        try {
          budgetedMetadata = admitResearchToolBudget(
            current.metadata,
            admitted.budget.toolCalls,
          ).metadata;
        } catch (error) {
          if (error instanceof ResearchToolBudgetError) throw new ConflictException(error.code);
          throw error;
        }
        const replanned = applyDurableResearchReplan({
          metadata: budgetedMetadata,
          plan: admitted,
          run: currentRun,
        });
        const nextMetadata = { ...replanned.metadata, researchPlan: admitted };
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
          throw new ConflictException('Research lease changed while applying steering.');
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
    const stored = researchMetadata(session.metadata).researchPlan;
    if (stored !== undefined) {
      try {
        const admitted = validateResearchPlan(stored, context);
        if (coordinator) return admitted;
        if (!auth.run)
          throw new ConflictException(
            'Research coordinator admission requires an active run lease.',
          );
        return this.prisma.withTenant(ctx.tenantId, async (tx) => {
          const current = await tx.clioResearchSession.findFirst({
            where: { id: session.id, tenantId: ctx.tenantId, userId: ctx.userId },
          });
          const currentRun = readResearchRun(current?.metadata);
          if (
            !current ||
            !currentRun ||
            currentRun.id !== auth.run!.id ||
            currentRun.leaseEpoch !== auth.run!.leaseEpoch ||
            currentRun.status !== 'running'
          )
            throw new ConflictException('Research is no longer running.');
          await this.assertResearchPublicationAuthorized(tx, ctx, current);
          const currentPlan = validateResearchPlan(
            researchMetadata(current.metadata).researchPlan,
            this.researchPlanAdmissionContext(ctx, current),
          );
          const admittedCoordinator = admitDurableResearchCoordinator({
            metadata: current.metadata,
            plan: currentPlan,
            objective: current.topic,
            run: currentRun,
          });
          const activated = activateDurableResearchCoordinator({
            metadata: admittedCoordinator.metadata,
            run: readResearchRun(admittedCoordinator.metadata) ?? currentRun,
            deadlineAt: new Date(
              Date.now() +
                positiveNumberOr(
                  this.config.get('CLIO_RESEARCH_TOTAL_BUDGET_MS', { infer: true }),
                  1_800_000,
                ),
            ).toISOString(),
          });
          const updated = await this.updateActiveResearchRun(
            tx,
            ctx,
            current.id,
            currentRun,
            current.metadata,
            activated.metadata,
            current.status,
            new Date(),
          );
          if (!updated)
            throw new ConflictException('Research lease changed while admitting the coordinator.');
          await tx.clioResearchSession.update({
            where: { id: current.id },
            data: {
              title: clampTitle(currentPlan.title),
              plan: researchPlanStringProjection(currentPlan) as Prisma.InputJsonValue,
              updatedAt: new Date(),
            },
          });
          return currentPlan;
        });
      } catch (error) {
        if (!(error instanceof ResearchPlanValidationError)) throw error;
        throw new BadRequestException(
          `Saved research plan is not admitted for the current scope and capabilities: ${error.issues.join('; ')}`,
        );
      }
    }
    if (!auth.run)
      throw new ConflictException('Legacy plan migration requires an active run lease.');

    const clientContext = await this.clientContext(ctx, session.clientId);
    const legacyPlan = asStringArray(session.plan);
    const system = buildResearchPlanSystemPrompt(PRODUCT_NAME, context);
    const user = [
      buildPlanUserPrompt(session.topic, clientContext, promptDeliverable(session)),
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
      let budgetedMetadata: Record<string, unknown>;
      try {
        budgetedMetadata = admitResearchToolBudget(
          current.metadata,
          admitted.budget.toolCalls,
        ).metadata;
      } catch (error) {
        if (error instanceof ResearchToolBudgetError) throw new ConflictException(error.code);
        throw error;
      }
      const coordinated = admitDurableResearchCoordinator({
        metadata: budgetedMetadata,
        plan: admitted,
        objective: session.topic,
        run: currentRun,
      });
      const nextMetadata = {
        ...coordinated.metadata,
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
      producerInputMode?: ResearchProducerInputMode;
      clientContextSha256?: string | null;
      producerInputManifest?: ResearchProducerInputManifestV1;
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
      throw researchProducerProofUnavailable(
        id,
        !run
          ? 'replay:run_missing'
          : !options?.producerInputSha256
            ? 'replay:producer_input_sha256_missing'
            : `replay:producer_input_mode:${options.producerInputMode ?? 'missing'}`,
        toolsUsed,
      );
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
                ...(options.producerInputManifest
                  ? { producerInputManifest: options.producerInputManifest }
                  : {}),
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
    ctx: TenantContext,
    sessionId: string,
    auth: ResearchRuntimeAuth,
    system: string,
    user: string,
  ): Promise<string> {
    if (!auth.run) throw new ConflictException('Research planning requires an active run lease.');
    // BYOK: tenant key (or global fallback) via resolver; model unchanged.
    const resolved = await this.aiCredentials.resolveProviderByTenantId(ctx.tenantId, 'anthropic');
    if (!resolved) throw new Error('ANTHROPIC_API_KEY not configured');
    const anthropicKey = resolved.apiKey;
    const model = this.config.get('CLIO_RESEARCH_PLAN_MODEL', { infer: true });
    const timeoutMs = this.config.get('CLIO_REQUEST_TIMEOUT_MS', { infer: true });
    const requestBody = JSON.stringify(
      prepareAnthropicRequest({
        model,
        max_tokens: 1500,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    );
    const reservation = await this.reserveLegacyProviderAttempt(
      ctx,
      sessionId,
      auth.run,
      'repair',
      model,
      requestBody,
      1500,
    );
    let settlementAttempted = false;

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
        body: requestBody,
        signal: auth.signal ? AbortSignal.any([controller.signal, auth.signal]) : controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        settlementAttempted = true;
        await this.settleLegacyProviderAttempt(
          ctx,
          sessionId,
          auth.run,
          reservation,
          [401, 403, 408, 409, 422, 429].includes(response.status)
            ? { kind: 'rejected' }
            : { kind: 'uncertain' },
        );
        throw new Error(
          `Anthropic HTTP ${response.status}${errText ? `: ${errText.slice(0, 300)}` : ''}`,
        );
      }
      const json = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      settlementAttempted = true;
      await this.settleLegacyProviderAttempt(
        ctx,
        sessionId,
        auth.run,
        reservation,
        Number.isSafeInteger(json.usage?.input_tokens) &&
          Number.isSafeInteger(json.usage?.output_tokens)
          ? {
              kind: 'known',
              inputTokens: Number(json.usage!.input_tokens),
              outputTokens: Number(json.usage!.output_tokens),
            }
          : { kind: 'uncertain' },
      );
      return (json.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
    } catch (error) {
      if (!settlementAttempted) {
        settlementAttempted = true;
        await this.settleLegacyProviderAttempt(ctx, sessionId, auth.run, reservation, {
          kind: 'uncertain',
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ── module-private pure helpers ─────────────────────────────────────────── */

function researchChildFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): Omit<ResearchChildFailureV1, 'failedAt'> {
  if (signal?.aborted)
    return { code: 'cancelled', message: 'The parent research run was stopped.' };
  if (error instanceof ResearchChildTaskError) {
    if (error.code === 'research_child_deadline_exceeded')
      return { code: 'deadline_exceeded', message: 'The bounded child deadline elapsed.' };
    if (error.code === 'research_child_goal_revision_mismatch')
      return {
        code: 'superseded_goal_revision',
        message: 'A newer research goal revision superseded the child result.',
      };
    return {
      code: 'schema_invalid',
      message: `Strict bounded child validation rejected the result (${error.message}).`.slice(0, 600),
    };
  }
  return {
    code: 'provider_failed',
    message: 'The approved research provider runtime did not return a usable child result.',
  };
}

function joinResearchChildEvidence<
  T extends {
    sources: SourceAttribution[];
    toolsUsed: string[];
    ledgerEntries: LedgerEntry[];
    citations: MeriCitation[];
  },
>(parent: T, children: readonly ResearchChildRuntimeResult[]): T {
  if (!children.length) return parent;
  const sources = [...parent.sources];
  const sourceKeys = new Set(sources.map((source) => `${source.tool}\u0000${source.summary}`));
  for (const source of children.flatMap((child) => child.sources)) {
    const key = `${source.tool}\u0000${source.summary}`;
    if (!sourceKeys.has(key)) {
      sourceKeys.add(key);
      sources.push(source);
    }
  }
  const ledgerEntries = [...parent.ledgerEntries];
  const ledgerKeys = new Set(ledgerEntries.map(researchChildLedgerKey));
  for (const entry of children.flatMap((child) => child.ledgerEntries)) {
    const key = researchChildLedgerKey(entry);
    if (!ledgerKeys.has(key)) {
      ledgerKeys.add(key);
      ledgerEntries.push(entry);
    }
  }
  const citations = [...parent.citations];
  const citationKeys = new Set(
    citations.map((citation) => `${citation.tool}:${citation.id || citation.stableId || ''}`),
  );
  let citationNumber = citations.reduce((max, citation) => Math.max(max, citation.n), 0);
  for (const citation of children.flatMap((child) => child.citations)) {
    const key = `${citation.tool}:${citation.id || citation.stableId || ''}`;
    if (!citationKeys.has(key)) {
      citationKeys.add(key);
      citationNumber += 1;
      citations.push({ ...citation, n: citationNumber });
    }
  }
  return {
    ...parent,
    sources,
    toolsUsed: [...new Set([...parent.toolsUsed, ...children.flatMap((child) => child.toolsUsed)])],
    ledgerEntries,
    citations,
  };
}

function withoutProducerInputManifest(metadata: Record<string, unknown>): Record<string, unknown> {
  const { producerInputManifest: _previousRun, ...rest } = metadata;
  return rest;
}

function researchChildLedgerKey(entry: LedgerEntry): string {
  const durable = researchMetadata(researchMetadata(entry).durableSafeRead);
  return typeof durable.executionId === 'string' && typeof durable.receiptId === 'string'
    ? `${durable.executionId}:${durable.receiptId}`
    : JSON.stringify(entry);
}

function researchLeaseError(message: string): Error {
  const error = new Error(message);
  error.name = 'ResearchLeaseError';
  return error;
}

class ResearchBudgetCasRetry extends Error {
  constructor() {
    super('research_budget_cas_retry');
    this.name = 'ResearchBudgetCasRetry';
  }
}

function strictReservationInput(raw: unknown): ResearchToolReservationInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new BadRequestException('Research tool reservation is malformed.');
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  const expected = ['leaseEpoch', 'providerCallId', 'tool', 'input'];
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key)) ||
    !Number.isSafeInteger(value.leaseEpoch) ||
    Number(value.leaseEpoch) < 0 ||
    typeof value.tool !== 'string' ||
    !/^[a-z][a-z0-9_]{0,159}$/.test(value.tool) ||
    !value.input ||
    typeof value.input !== 'object' ||
    Array.isArray(value.input)
  )
    throw new BadRequestException('Research tool reservation is malformed.');
  return {
    leaseEpoch: value.leaseEpoch as number,
    providerCallId: boundedAttemptIdentity(value.providerCallId),
    tool: value.tool,
    input: value.input as Record<string, unknown>,
  };
}

function strictProviderReservationInput(raw: unknown): ResearchProviderReservationInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new BadRequestException('Research provider reservation is malformed.');
  const value = raw as Record<string, unknown>;
  const expected = [
    'leaseEpoch',
    'logicalOperationId',
    'attemptId',
    'retryOfAttemptId',
    'kind',
    'phase',
    'provider',
    'model',
    'maxInputTokens',
    'maxOutputTokens',
  ];
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key)) ||
    !Number.isSafeInteger(value.leaseEpoch) ||
    Number(value.leaseEpoch) < 0 ||
    !(value.retryOfAttemptId === null || boundedProviderString(value.retryOfAttemptId, 500)) ||
    !['openai_responses', 'anthropic_messages', 'jev'].includes(String(value.kind)) ||
    !boundedProviderString(value.phase, 64) ||
    !boundedProviderString(value.provider, 64) ||
    !boundedProviderString(value.model, 160) ||
    !Number.isSafeInteger(value.maxInputTokens) ||
    Number(value.maxInputTokens) < 0 ||
    !(
      value.maxOutputTokens === null ||
      (Number.isSafeInteger(value.maxOutputTokens) && Number(value.maxOutputTokens) >= 0)
    )
  )
    throw new BadRequestException('Research provider reservation is malformed.');
  return {
    leaseEpoch: value.leaseEpoch as number,
    logicalOperationId: boundedAttemptIdentity(value.logicalOperationId),
    attemptId: boundedAttemptIdentity(value.attemptId),
    retryOfAttemptId: value.retryOfAttemptId as string | null,
    kind: value.kind as ResearchProviderAttemptKind,
    phase: value.phase as string,
    provider: value.provider as string,
    model: value.model as string,
    maxInputTokens: value.maxInputTokens as number,
    maxOutputTokens: value.maxOutputTokens as number | null,
  };
}

function strictProviderSettlementInput(raw: unknown): ResearchProviderSettlementInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new BadRequestException('Research provider settlement is malformed.');
  const value = raw as Record<string, unknown>;
  const expected = [
    'leaseEpoch',
    'reservationId',
    'logicalOperationId',
    'attemptId',
    'retryOfAttemptId',
    'kind',
    'phase',
    'provider',
    'model',
    'outcome',
    'inputTokens',
    'outputTokens',
  ];
  const known = value.outcome === 'known';
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key)) ||
    !Number.isSafeInteger(value.leaseEpoch) ||
    Number(value.leaseEpoch) < 0 ||
    !(value.retryOfAttemptId === null || boundedProviderString(value.retryOfAttemptId, 500)) ||
    !['openai_responses', 'anthropic_messages', 'jev'].includes(String(value.kind)) ||
    !boundedProviderString(value.phase, 64) ||
    !boundedProviderString(value.provider, 64) ||
    !boundedProviderString(value.model, 160) ||
    !['known', 'rejected', 'uncertain'].includes(String(value.outcome)) ||
    (known &&
      (!Number.isSafeInteger(value.inputTokens) ||
        Number(value.inputTokens) < 0 ||
        !Number.isSafeInteger(value.outputTokens) ||
        Number(value.outputTokens) < 0)) ||
    (!known && (value.inputTokens !== null || value.outputTokens !== null))
  )
    throw new BadRequestException('Research provider settlement is malformed.');
  return {
    leaseEpoch: value.leaseEpoch as number,
    reservationId: boundedAttemptIdentity(value.reservationId),
    logicalOperationId: boundedAttemptIdentity(value.logicalOperationId),
    attemptId: boundedAttemptIdentity(value.attemptId),
    retryOfAttemptId: value.retryOfAttemptId as string | null,
    kind: value.kind as ResearchProviderAttemptKind,
    phase: value.phase as string,
    provider: value.provider as string,
    model: value.model as string,
    outcome: value.outcome as ResearchProviderSettlementInput['outcome'],
    inputTokens: value.inputTokens as number | null,
    outputTokens: value.outputTokens as number | null,
  };
}

function boundedProviderString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
  );
}

function researchProviderPrice(
  kind: ResearchProviderAttemptKind,
  model: string,
): { inputPerM: number; outputPerM: number } | null {
  if (kind === 'jev' && /^jev-\d+\.\d+\.\d+$/.test(model)) {
    return {
      inputPerM: BD_GATE_PRICE_INPUT_USD_PER_MILLION,
      outputPerM: BD_GATE_PRICE_OUTPUT_USD_PER_MILLION,
    };
  }
  const prices = AI_PRICING as Record<string, { inputPerM: number; outputPerM: number }>;
  return prices[model] ?? null;
}

function boundedAttemptIdentity(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 256 || value.trim() !== value)
    throw new BadRequestException('Research attempt identity is malformed.');
  return value;
}

function sseEvent(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Decode Anthropic SSE without allowing a logical/protocol failure to become a clean turn. */
const MAX_ANTHROPIC_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_ANTHROPIC_SSE_LINE_CHARS = 1024 * 1024;

async function* anthropicStreamEvents(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<Record<string, any>> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let sawEvent = false;
  let responseBytes = 0;

  const parseLine = (rawLine: string): Record<string, any> | null => {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith(':') || /^(event|id|retry):/.test(line)) return null;
    const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (!payload || payload === '[DONE]') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new ResearchTerminalError(
        'partial',
        `Malformed Anthropic stream event: ${error instanceof Error ? error.message : 'invalid JSON'}`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new ResearchTerminalError('partial', 'Malformed Anthropic stream event shape.');
    const event = parsed as Record<string, any>;
    if (event.type === 'error') {
      const detail =
        event.error && typeof event.error === 'object' && typeof event.error.message === 'string'
          ? event.error.message
          : typeof event.message === 'string'
            ? event.message
            : 'Anthropic returned a logical error event.';
      throw new ResearchTerminalError('provider', detail);
    }
    sawEvent = true;
    return event;
  };

  const decode = (chunk?: Uint8Array): string => {
    try {
      return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
    } catch {
      throw new ResearchTerminalError('partial', 'Malformed UTF-8 in Anthropic stream.');
    }
  };

  const parseText = function* (text: string): Generator<Record<string, any>> {
    let start = 0;
    for (;;) {
      const newline = text.indexOf('\n', start);
      if (newline < 0) break;
      const segment = text.slice(start, newline);
      if (buffer.length + segment.length > MAX_ANTHROPIC_SSE_LINE_CHARS)
        throw new ResearchTerminalError('partial', 'Anthropic stream line exceeded the limit.');
      const line = buffer + segment;
      buffer = '';
      const event = parseLine(line);
      if (event) yield event;
      start = newline + 1;
    }
    const remainder = text.slice(start);
    if (buffer.length + remainder.length > MAX_ANTHROPIC_SSE_LINE_CHARS)
      throw new ResearchTerminalError('partial', 'Anthropic stream line exceeded the limit.');
    buffer += remainder;
  };

  try {
    for await (const chunk of body) {
      responseBytes += chunk.byteLength;
      if (responseBytes > MAX_ANTHROPIC_STREAM_BYTES)
        throw new ResearchTerminalError('partial', 'Anthropic stream exceeded the response limit.');
      yield* parseText(decode(chunk));
    }
    yield* parseText(decode());
    if (buffer.trim()) {
      const event = parseLine(buffer);
      if (event) yield event;
    }
  } catch (error) {
    if (error instanceof ResearchTerminalError) throw error;
    throw new ResearchTerminalError(
      sawEvent ? 'partial' : 'provider',
      error instanceof Error ? error.message : 'Anthropic stream failed.',
    );
  }
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
 * True only for an abort surfaced after this specific controller fired.
 * fetch/undici use DOMException/Error named 'AbortError', but the name alone is
 * provider-controlled data and is not sufficient timeout authority.
 */
function isControllerAbort(err: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    err.name === 'AbortError'
  );
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
  const coordinator = readDurableResearchCoordinator(value);
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
    ...(coordinator ? { durableCoordinator: publicDurableResearchCoordinator(coordinator) } : {}),
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
