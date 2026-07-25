import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { verifyPlan, type VerifierNode, type Violation } from '@capiro/strategy-verifier';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { isoDate } from '../strategy/versioning.js';
import { LIVE_NODE_WHERE } from '../strategy/live-node.js';
import { MeriService, type Grounding } from '../meri/meri.service.js';
import type {
  DocumentDraftSection,
  NodeDocumentDraftResponse,
  StewardFactLine,
  StewardHealth,
} from '../meri/meri.types.js';
import { StewardService } from '../context/steward.service.js';
import { AGENTIC_FLAGS, StrategyFlagsService } from '../flags/strategy-flags.service.js';
import { RunsService } from './runs.service.js';
import { ExecutionArtifactClient } from './execution-artifact.client.js';
import { computeSendToken, sendEnabled, type SendTokenInput } from './send-approval.js';
import {
  computeApprovalHash,
  contextPackFingerprint,
  invalidateApproval,
  recordApproval,
  verifyApproval,
  type ApprovalAction,
  type ApprovalBinding,
  type ApprovalRecipient,
  type ApprovalRecord,
  type ApprovalVerification,
} from './approval-binding.js';
import { evaluateEligibility, type EligibilityResult } from './execution-eligibility.js';
import { stampRunMetrics, type RunMetricsInput } from './run-metrics.js';
import { PENDING_ARTIFACT_REF } from './artifact-ref.js';
import { isActionAllowed, reasonForState } from './run-state.js';
import type {
  CreateRunDto,
  ExecutionKindValue,
  ExecutionPlanDto,
  TransitionRunDto,
} from './dto/agents.dto.js';

type Tx = Prisma.TransactionClient;

/** kind -> the sp_node_artifact type it stages (1:1). */
const ARTIFACT_TYPE_BY_KIND: Record<ExecutionKindValue, 'workspace_draft' | 'outreach_record'> = {
  workspace: 'workspace_draft',
  outreach: 'outreach_record',
};

/** A do-not-contact facts must carry to be treated as a hard client constraint. */
const CONSTRAINT_AUTHORITY = 'client_approved';
/**
 * Do-not-contact phrases (conservative, documented heuristic). SINGLE SOURCE OF
 * TRUTH: both the DB predicate in checkClientConstraints (pushed INTO the query
 * so a standing instruction can never be hidden behind a row cap) and the
 * authoritative regex gate below are derived from this list. Phrases are plain
 * literals (no regex metacharacters), so `.join('|')` builds the regex safely.
 */
const DO_NOT_CONTACT_PHRASES = ['do not contact', 'no outreach'] as const;
/** Conservative do-not-contact heuristic (documented), derived from the phrases above. */
const DO_NOT_CONTACT_RE = new RegExp(DO_NOT_CONTACT_PHRASES.join('|'), 'i');

/**
 * The write-ahead staging sentinel now lives in the pure artifact-ref.ts module so
 * the P0-2 recovery rules can reason about reservations without importing this
 * Nest service. Re-exported here because existing importers (the safety and
 * execution specs) take it from this module.
 */
export { PENDING_ARTIFACT_REF };

/**
 * Internal control-flow signal ONLY — thrown inside reserveArtifact's own
 * transaction (never escapes the try/catch there) when a row for (nodeId,
 * artifactType) already exists — real ref or sentinel — by the time that
 * transaction runs, so the CREATE must not proceed. See reserveArtifact.
 */
const ARTIFACT_ALREADY_PRESENT = Symbol('artifact-already-present');

/**
 * Reason a run parks when a retry finds a surviving write-ahead reservation: the
 * external artifact may already exist upstream but was never linked, so it needs a
 * human/Stage-H reconciliation before any further attempt (never a duplicate hop).
 */
const STAGING_INCOMPLETE_REASON =
  'artifact staging incomplete — an external artifact may exist upstream but was not linked; reconcile before retrying';

/** Stage-G grounded generation prompt/tool-spec version, for metrics/audit provenance. */
const EXECUTION_DOC_PROMPT_SPEC = 'execution-document-draft@v1';

/** The Execution-Agent's persisted intent, stored on run.findings.execution. */
interface ExecutionMeta {
  kind: ExecutionKindValue;
  nodeId: string;
  strategyId: string;
  missionId: string;
  pinnedVersionId: string | null;
}

type ExecutionTaskType = 'workspace_draft' | 'outreach_record' | 'await_send_approval';
interface ExecutionTask {
  type: ExecutionTaskType;
  nodeId: string;
  detail: Record<string, unknown>;
}

/** Snapshot of an apps/api ClientTarget picked for a node (see node.dto.ts NodeTargetRefDto). */
interface NodeTargetRef {
  clientTargetId?: string;
  memberId: string;
  memberName?: string;
  party?: string;
  state?: string;
  chamber?: string;
  committee?: string;
  sourceDirectory?: string;
}

/** The node fields plan/execute reason over (Prisma row subset). */
interface NodeRow {
  id: string;
  kind: string;
  subject: string;
  title: string;
  note: string | null;
  ownerUserId: string | null;
  status: string;
  startsOn: Date | string | null;
  endsOn: Date | string | null;
  dependsOnIds: string[];
  targetRef: NodeTargetRef | null;
}
interface StrategyRow {
  id: string;
  clientId: string | null;
  type: string;
  goal: string | null;
  nodes: NodeRow[];
}

/**
 * Stage G Execution Agent (Do-mode) — the run lifecycle that STAGES artifacts
 * for an approved plan node. ZERO LLM: `plan` produces a deterministic task list
 * a human reviews; `execute` stages Workspace/outreach artifact SHELLS via the
 * ExecutionArtifactClient hop (cited-draft PROSE generation via Meri is a
 * documented deferred seam — G stages the shell + context, not LLM content).
 *
 * CRITICAL SAFETY BOUNDARY (plan §G, non-negotiable):
 *  - The actual EXTERNAL SEND stays HARD-DISABLED until Stage H. This service
 *    fully builds the await_send_approval token machinery (send-approval.ts) but
 *    NEVER calls a send path; the ExecutionArtifactClient has no send URL, and
 *    send-approval.sendEnabled reads STRATEGY_EXECUTION_SEND_ENABLED (an env that
 *    does NOT exist in Stage G). A send-pending run PARKS in waiting_for_input.
 *  - Artifact staging REQUIRES an interactive caller bearer. A bearerless
 *    invocation (pure scheduler/system) parks the run in waiting_for_input
 *    ('execution requires an interactive session') — never a bearerless hop.
 *  - The per-kind flag (executionAgentWorkspace / executionAgentOutreach) is
 *    re-checked fail-closed IN-SERVICE so the guard-less scheduler path is gated.
 */
@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly versioning: VersioningService,
    private readonly runs: RunsService,
    private readonly meri: MeriService,
    private readonly steward: StewardService,
    private readonly flags: StrategyFlagsService,
    private readonly artifacts: ExecutionArtifactClient,
  ) {}

  // ---- list ----------------------------------------------------------------

  /**
   * The Execution-review list (GET /agents/execution/runs). Execution runs are
   * the only runs whose idempotencyKey is `exec:<nodeId>:<kind>`, so filter on
   * that prefix to exclude watcher/scheduler runs. Optional strategyId scopes to
   * one strategy's runs. Tenant-scoped via withTenant; newest first, capped 100.
   */
  async listRuns(tenantId: string, opts: { strategyId?: string; take?: number } = {}) {
    const take = Math.min(Math.max(opts.take ?? 50, 1), 100);
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.spAgentRun.findMany({
        where: {
          idempotencyKey: { startsWith: 'exec:' },
          ...(opts.strategyId ? { strategyId: opts.strategyId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    );
  }

  // ---- plan ----------------------------------------------------------------

  /**
   * Create/claim the execution run (idempotencyKey `exec:<nodeId>:<kind>` — one
   * run per node+kind), drive queued->planning, run the G0 pre-execution
   * re-check, and either PARK (waiting_for_input, nothing staged) or produce the
   * reviewed task plan (ready_for_review). Bearer is unused here (plan stages
   * nothing) — carried only for signature parity with execute/resume.
   */
  async plan(
    tenantId: string,
    userId: string | null,
    _bearer: string | undefined,
    dto: ExecutionPlanDto,
  ) {
    await this.assertKindEnabled(tenantId, dto.kind);
    const strategyId = await this.resolveTarget(tenantId, dto);
    const idempotencyKey = `exec:${dto.nodeId}:${dto.kind}`;
    const run = await this.runs.createRun(tenantId, userId, dto.missionId, {
      trigger: 'manual',
      idempotencyKey,
      strategyId,
    } as CreateRunDto);
    const meta: ExecutionMeta = {
      kind: dto.kind,
      nodeId: dto.nodeId,
      strategyId,
      missionId: dto.missionId,
      pinnedVersionId: dto.pinnedVersionId ?? null,
    };

    // Re-entry routing. A fresh run is queued; a run already reviewed (planned)
    // is returned unchanged (idempotent); a G0-parked run (waiting_for_input with
    // NO reviewed plan yet) or a crash-stranded 'planning' run is re-checked.
    // Anything else is a conflict (a run mid/post execution cannot be re-planned
    // in place).
    if (run.state === 'ready_for_review') return run;
    // A waiting_for_input run that ALREADY carries a reviewed plan (readTasks() !=
    // null) is a MID-EXECUTION park (e.g. 'awaiting send approval' / 'outreach
    // blocked', an OutreachRecord may already be staged), NOT a G0 park. Rewinding
    // it queued->planning->ready_for_review would clobber findings.tasks/results/
    // sendApproval and re-open it for a fresh execute, bypassing resume() (the
    // intended continuation). It must be continued via resume(), so reject here.
    if (run.state === 'waiting_for_input' && this.readTasks(run) !== null) {
      throw new ConflictException(
        `run for '${idempotencyKey}' is mid-execution (parked with a reviewed plan) — resume it, do not re-plan`,
      );
    }
    if (run.state === 'queued' || run.state === 'waiting_for_input') {
      await this.runs.transition(tenantId, userId, run.id, {
        to: 'planning',
      } as TransitionRunDto);
    } else if (run.state !== 'planning') {
      throw new ConflictException(
        `run for '${idempotencyKey}' is already ${run.state} — cannot (re)plan`,
      );
    }
    return this.runPlanning(tenantId, userId, run.id, meta);
  }

  /** G0 + task-plan production, transitioning planning -> waiting_for_input | ready_for_review. */
  private async runPlanning(
    tenantId: string,
    userId: string | null,
    runId: string,
    meta: ExecutionMeta,
  ) {
    const phaseStart = Date.now();
    this.logger.log(`[run:${runId} mission:${meta.missionId}] execution plan start (${meta.kind})`);
    const { strategy, targetNode, headVersionId } = await this.loadPlanState(
      tenantId,
      meta.strategyId,
      meta.nodeId,
    );
    const { g0, blockReason } = await this.evaluateG0(
      tenantId,
      meta,
      strategy,
      targetNode,
      headVersionId,
    );

    if (blockReason) {
      await this.runs.transition(tenantId, userId, runId, {
        to: 'waiting_for_input',
        waitingReason: blockReason,
        findings: { execution: meta, g0 },
      } as TransitionRunDto);
      return this.settlePhase(tenantId, userId, runId, meta.missionId, 'plan', phaseStart);
    }

    const tasks = this.buildTasks(meta.kind, targetNode, strategy);
    await this.runs.transition(tenantId, userId, runId, {
      to: 'ready_for_review',
      findings: { execution: meta, g0, tasks },
    } as TransitionRunDto);
    return this.settlePhase(tenantId, userId, runId, meta.missionId, 'plan', phaseStart);
  }

  /**
   * The G0 pre-execution gate, run against freshly-loaded plan state. Returns the
   * full findings.g0 picture PLUS a single precise `blockReason` (null iff the
   * gate passes). Called at BOTH plan() and execute() time — a blocker is not an
   * exclusively plan-time fact: a material conflict the Steward opens, the plan
   * head advancing past the pinned version, or the node losing its owner/date can
   * all arise AFTER plan-review, so runExecuting() MUST re-run this immediately
   * before staging (the plan's 'open material conflict = Execution-eligibility
   * BLOCKER' invariant must hold at stage time, not just at review time).
   *
   * Grounding + health each open their OWN withTenant tx; both are awaited here
   * AFTER loadPlanState has resolved in the caller, so neither is nested inside
   * another tx (house rule: never nest a grounding read in a tx).
   */
  private async evaluateG0(
    tenantId: string,
    meta: ExecutionMeta,
    strategy: StrategyRow,
    targetNode: NodeRow,
    headVersionId: string | null,
  ): Promise<{
    g0: Record<string, unknown>;
    blockReason: string | null;
    grounding: Grounding;
    stewardHealth: StewardHealth;
  }> {
    const ground = await this.meri.grounding(tenantId);
    const health = await this.steward.health(tenantId, strategy.clientId);
    const openMaterialConflicts = health.openMaterialConflicts.length;
    // The wire-shape subset MeriService.stewardContext forwards to the
    // orchestrator (Stage-G document-draft reuses the SAME shape) — narrowed
    // from the richer StewardHealthReport (factCounts/staleDocs are internal).
    const stewardHealth: StewardHealth = {
      status: health.status,
      missingRequired: health.missingRequired,
      openMaterialConflicts: health.openMaterialConflicts,
    };

    const versionDrift =
      meta.pinnedVersionId != null && headVersionId !== meta.pinnedVersionId;
    const chain = this.chainOf(targetNode.id, strategy.nodes);
    const violations = this.verify(strategy.type, strategy.nodes, ground);
    const chainErrors = violations.filter(
      (v) => v.severity === 'error' && v.nodeIds.some((id) => chain.has(id)),
    );
    const eligibility = evaluateEligibility({
      node: {
        kind: targetNode.kind,
        subject: targetNode.subject,
        ownerUserId: targetNode.ownerUserId,
        startsOn: isoDate(targetNode.startsOn),
        endsOn: isoDate(targetNode.endsOn),
      },
      strategyHealth: { openMaterialConflicts },
      hasWorkspaceAccess: this.hasWorkspaceAccess(meta.kind),
      kind: meta.kind,
    });

    const g0 = {
      checkedAt: new Date().toISOString(),
      versionDrift,
      pinnedVersionId: meta.pinnedVersionId,
      headVersionId,
      verifierChainErrors: chainErrors.map((e) => ({
        code: e.code,
        message: e.message,
        nodeIds: e.nodeIds,
      })),
      eligibility,
      openMaterialConflicts,
    };

    // ANY blocking condition parks the run WITHOUT staging. Precedence gives the
    // most specific precise reason; findings.g0 carries the full picture.
    const blockReason = versionDrift
      ? 'plan changed since approval'
      : chainErrors.length
        ? `plan verification failed: ${chainErrors.map((e) => e.message).join('; ')}`
        : openMaterialConflicts > 0
          ? 'unresolved material conflict'
          : !eligibility.eligible
            ? `node no longer eligible: ${eligibility.reasons.join('; ')}`
            : null;

    return { g0, blockReason, grounding: ground, stewardHealth };
  }

  /** The deterministic task list a human reviews before execute() stages anything. */
  private buildTasks(
    kind: ExecutionKindValue,
    node: NodeRow,
    strategy: StrategyRow,
  ): ExecutionTask[] {
    if (kind === 'workspace') {
      return [
        {
          type: 'workspace_draft',
          nodeId: node.id,
          detail: { docTitle: node.title, product: strategy.type },
        },
      ];
    }
    // Outreach: stage the record, THEN an await_send_approval task (the send
    // itself stays hard-disabled — the run parks on this task).
    return [
      {
        type: 'outreach_record',
        nodeId: node.id,
        detail: { title: node.title, subject: node.subject },
      },
      { type: 'await_send_approval', nodeId: node.id, detail: { subject: node.subject } },
    ];
  }

  // ---- execute -------------------------------------------------------------

  /**
   * Execute a REVIEWED plan: require an interactive bearer (else park), drive
   * ready_for_review -> executing, stage each task idempotently, then settle:
   *  - all non-send tasks done + no send pending => executing -> ready_for_review
   *    -> completed (final validation);
   *  - a send task => park in waiting_for_input('awaiting send approval') — the
   *    send is NEVER performed (Stage-H hard boundary);
   *  - a do-not-contact-blocked outreach => park with the block finding.
   */
  async execute(tenantId: string, userId: string | null, bearer: string | undefined, runId: string) {
    const run = await this.runs.get(tenantId, runId);
    const meta = this.readExecutionMeta(run);
    await this.assertKindEnabled(tenantId, meta.kind);
    const tasks = this.readTasks(run);
    if (!tasks) {
      throw new BadRequestException('run has no reviewed plan to execute');
    }
    // P0-2/P0-3: `approved` is the approval-bound entry into staging. `executing`
    // stays accepted so a re-entered (crash-resumed) run can continue, which is
    // what the write-ahead reservation exists to make safe.
    if (
      run.state !== 'ready_for_review' &&
      run.state !== 'approved' &&
      run.state !== 'executing'
    ) {
      throw new ConflictException(
        `run is ${run.state} — only a reviewed or approved run can be executed`,
      );
    }

    // SAFETY: staging requires an interactive caller bearer. No bearer => park
    // (never a bearerless external hop). ready_for_review/executing -> waiting.
    if (!bearer) {
      await this.runs.transition(tenantId, userId, runId, {
        to: 'waiting_for_input',
        waitingReason: 'execution requires an interactive session',
      } as TransitionRunDto);
      return this.runs.get(tenantId, runId);
    }

    if (run.state === 'ready_for_review' || run.state === 'approved') {
      await this.runs.transition(tenantId, userId, runId, {
        to: 'executing',
      } as TransitionRunDto);
    }
    return this.runExecuting(
      tenantId,
      userId,
      bearer,
      runId,
      meta,
      tasks,
      this.readPriorSendApproval(run),
    );
  }

  private async runExecuting(
    tenantId: string,
    userId: string | null,
    bearer: string,
    runId: string,
    meta: ExecutionMeta,
    tasks: ExecutionTask[],
    /** The send-approval token this run was PARKED with before this call, if any
     *  (read off run.findings by the caller before re-entering) — see
     *  readPriorSendApproval / computeSendApproval. */
    priorSendApproval: Record<string, unknown> | null,
  ) {
    const phaseStart = Date.now();
    this.logger.log(
      `[run:${runId} mission:${meta.missionId}] execution execute start (${meta.kind})`,
    );
    const { strategy, targetNode, headVersionId } = await this.loadPlanState(
      tenantId,
      meta.strategyId,
      meta.nodeId,
    );

    // G0 RE-CHECK (Stage G invariant, plan §G0). Re-run the SAME pre-execution
    // gate here — immediately before staging — not just at plan() time. A
    // blocker can arise AFTER the plan was reviewed (the Steward opens a new
    // material conflict, the plan head advances past the pinned version, or the
    // node loses its owner/date). Re-gating parks the run WITHOUT staging rather
    // than acting on now-stale reviewed tasks. The reviewed task list is
    // preserved (transition shallow-merges findings), so a resume re-gates and
    // continues once the transient blocker clears. (The do-not-contact fact is
    // ALSO re-checked per-outreach below — this covers the general gate.)
    const { g0, blockReason, grounding, stewardHealth } = await this.evaluateG0(
      tenantId,
      meta,
      strategy,
      targetNode,
      headVersionId,
    );
    if (blockReason) {
      await this.runs.transition(tenantId, userId, runId, {
        to: 'waiting_for_input',
        waitingReason: blockReason,
        findings: { execution: meta, g0 },
      } as TransitionRunDto);
      return this.settlePhase(tenantId, userId, runId, meta.missionId, 'execute', phaseStart);
    }

    // P0-3 ENFORCEMENT: a run carrying a recorded approval must have that
    // approval re-verified against the CURRENT payload before we act on it. A
    // drifted approval is persisted as invalidated and the run PARKS — the audit's
    // "confirm execution is blocked until reapproval".
    const runRow = await this.runs.get(tenantId, runId);
    const approvalBlock = await this.verifyRunApproval(
      tenantId,
      userId,
      runId,
      runRow,
      this.buildBinding(runId, targetNode, strategy, this.readResults(runRow), {
        action: isSendPark(runRow) ? 'send' : 'stage',
        kind: meta.kind,
        headVersionId,
        stewardHealth,
      }),
    );
    if (approvalBlock) {
      await this.runs.transition(tenantId, userId, runId, {
        to: 'waiting_for_input',
        waitingReason: `approval no longer valid: ${approvalBlock}`,
        findings: { execution: meta, g0 },
      } as TransitionRunDto);
      return this.settlePhase(tenantId, userId, runId, meta.missionId, 'execute', phaseStart);
    }

    const clientName = await this.resolveClientName(tenantId, strategy.clientId);
    // Read-only prompt grounding for the (optional) generation call below — NOT
    // part of any gate; fails soft to [] (mirrors MeriService.stewardContext).
    const stewardFacts = await this.fetchStewardFactsSafely(tenantId, strategy.clientId);

    const results: Record<string, unknown> = {};
    let sendApproval: Record<string, unknown> | null = null;
    let sendPending = false;
    let blocked = false;
    let stagingIncomplete = false;
    // Stage-G grounded generation provenance for this phase's metrics stamp —
    // set only when a generation call actually ran and returned a model.
    let generationModel: string | undefined;

    for (const task of tasks) {
      const key = `${task.nodeId}:${task.type}`;
      if (task.type === 'workspace_draft') {
        const staged = await this.stageWorkspace(
          tenantId,
          userId,
          bearer,
          runId,
          targetNode,
          strategy,
          clientName,
          grounding,
          stewardFacts,
          stewardHealth,
        );
        results[key] = staged;
        if (isStagingIncomplete(staged)) stagingIncomplete = true;
        generationModel ??= readGeneratedModel(staged);
      } else if (task.type === 'outreach_record') {
        const constraint = await this.checkClientConstraints(
          tenantId,
          strategy.clientId,
          targetNode,
        );
        if (constraint.blocked) {
          results[key] = { status: 'blocked', reason: constraint.reason };
          blocked = true;
          continue; // skip staging AND the dependent await_send_approval task
        }
        const staged = await this.stageOutreach(
          tenantId,
          userId,
          bearer,
          runId,
          targetNode,
          strategy,
          grounding,
          stewardFacts,
          stewardHealth,
        );
        results[key] = staged;
        generationModel ??= readGeneratedModel(staged);
        if (isStagingIncomplete(staged)) {
          stagingIncomplete = true;
          continue; // skip the dependent await_send_approval task
        }
      } else {
        // await_send_approval: compute the send token, park — NEVER send.
        if (blocked || stagingIncomplete) {
          results[key] = {
            status: 'skipped',
            reason: blocked ? 'outreach blocked' : 'outreach staging incomplete',
          };
          continue;
        }
        sendApproval = this.computeSendApproval(
          runId,
          targetNode,
          strategy,
          results,
          priorSendApproval,
          { headVersionId, stewardHealth },
        );
        results[key] = { status: 'awaiting_send_approval' };
        sendPending = true;
      }
    }

    // A surviving write-ahead reservation (an external artifact may exist upstream
    // but was never linked) takes precedence — park for reconciliation rather than
    // completing or issuing a duplicate hop. NEVER re-create here.
    const generation = generationModel
      ? { model: generationModel, promptSpecVersion: EXECUTION_DOC_PROMPT_SPEC }
      : undefined;

    if (stagingIncomplete) {
      await this.runs.transition(tenantId, userId, runId, {
        to: 'waiting_for_input',
        waitingReason: STAGING_INCOMPLETE_REASON,
        findings: { results, ...(sendApproval ? { sendApproval } : {}) },
      } as TransitionRunDto);
      return this.settlePhase(tenantId, userId, runId, meta.missionId, 'execute', phaseStart, generation);
    }
    if (blocked) {
      await this.runs.transition(tenantId, userId, runId, {
        to: 'waiting_for_input',
        waitingReason: 'outreach blocked by a client do-not-contact constraint',
        findings: { results, ...(sendApproval ? { sendApproval } : {}) },
      } as TransitionRunDto);
      return this.settlePhase(tenantId, userId, runId, meta.missionId, 'execute', phaseStart, generation);
    }
    if (sendPending) {
      // The run does NOT auto-complete while a send is pending — it parks for a
      // human to approve (and, only in Stage H, to actually send).
      await this.runs.transition(tenantId, userId, runId, {
        to: 'waiting_for_input',
        waitingReason: 'awaiting send approval',
        findings: { results, sendApproval },
      } as TransitionRunDto);
      return this.settlePhase(tenantId, userId, runId, meta.missionId, 'execute', phaseStart, generation);
    }

    // All non-send tasks done, nothing pending => STAGED, then complete.
    //
    // P0-2 vocabulary (audit P1-13): `staged` is the state that says "the
    // Workspace draft / Outreach record EXISTS and is linked to the step" —
    // distinct from `completed`, which says the run's workflow is finished. The
    // pre-P0-2 path went executing -> ready_for_review -> completed, which
    // overloaded ready_for_review to mean two different things (a plan awaiting
    // approval, and a staged artifact awaiting acknowledgement) and gave the
    // reconciler nothing to distinguish "artifact created" from "nothing created".
    await this.runs.transition(tenantId, userId, runId, {
      to: 'staged',
      findings: { results },
    } as TransitionRunDto);
    await this.runs.transition(tenantId, userId, runId, {
      to: 'completed',
    } as TransitionRunDto);
    return this.settlePhase(tenantId, userId, runId, meta.missionId, 'execute', phaseStart, generation);
  }

  // ---- resume / cancel -----------------------------------------------------

  /**
   * Resume a parked (waiting_for_input) run. If it carries a reviewed plan
   * (findings.tasks), CONTINUE execution (requires the interactive bearer);
   * otherwise it was G0-parked before a plan existed, so RE-CHECK (re-plan).
   */
  async resume(tenantId: string, userId: string | null, bearer: string | undefined, runId: string) {
    const run = await this.runs.get(tenantId, runId);
    if (run.state !== 'waiting_for_input') {
      throw new ConflictException(
        `run is ${run.state} — only a waiting_for_input run can be resumed`,
      );
    }
    const meta = this.readExecutionMeta(run);
    await this.assertKindEnabled(tenantId, meta.kind);
    const tasks = this.readTasks(run);

    if (tasks) {
      if (!bearer) {
        // Stay parked — never a bearerless hop; surface why the resume can't run.
        throw new BadRequestException('execution requires an interactive session');
      }
      await this.runs.transition(tenantId, userId, runId, {
        to: 'executing',
      } as TransitionRunDto);
      return this.runExecuting(
        tenantId,
        userId,
        bearer,
        runId,
        meta,
        tasks,
        this.readPriorSendApproval(run),
      );
    }

    // G0 park (no plan yet) -> re-run the pre-execution re-check.
    await this.runs.transition(tenantId, userId, runId, { to: 'planning' } as TransitionRunDto);
    return this.runPlanning(tenantId, userId, runId, meta);
  }

  /**
   * Cancel a run (the audit's "Cancel run" control). canceled is reachable from
   * every non-terminal state; the policy check first turns "already finished" into
   * a precise 409 with the plain-words state reason instead of a raw transition
   * error. Wired to POST /agents/execution/runs/:id/cancel — before P0-2 this
   * method existed but had NO route and NO caller, so there was no cancel path at
   * all from the UI.
   */
  async cancel(tenantId: string, userId: string | null, runId: string) {
    const run = await this.runs.get(tenantId, runId);
    if (!isActionAllowed(run.state, 'cancel')) {
      throw new ConflictException(
        `run is ${run.state} — it cannot be canceled (${reasonForState(run.state)})`,
      );
    }
    return this.runs.transition(tenantId, userId, runId, { to: 'canceled' } as TransitionRunDto);
  }

  // ---- staging (external hop + back-link) ----------------------------------

  /**
   * Stage a Workspace draft for the node, idempotently and RETRY-SAFELY. The run
   * key is `exec:<nodeId>:workspace` and kind->artifactType is 1:1, so an existing
   * sp_node_artifact for (nodeId, 'workspace_draft') means this logical run already
   * staged it — skip the external create.
   *
   * The external create cannot share a transaction with the local back-link write,
   * so a bare "create then link" would duplicate on retry: if the back-link write
   * failed AFTER a successful create, a re-entered execute() (allowed from
   * 'executing') would find no link and create a SECOND draft. Guard with a
   * write-ahead reservation: commit the PENDING_ARTIFACT_REF sentinel BEFORE the
   * hop, create, then finalize the sentinel to the real ref. A surviving sentinel
   * on retry => a prior attempt may already have created the draft upstream, so we
   * do NOT create again; we surface 'staging_incomplete' and the run parks for
   * reconciliation.
   */
  private async stageWorkspace(
    tenantId: string,
    userId: string | null,
    bearer: string,
    runId: string,
    node: NodeRow,
    strategy: StrategyRow,
    clientName: string,
    grounding: Grounding,
    stewardFacts: StewardFactLine[],
    stewardHealth: StewardHealth,
  ) {
    const existing = await this.findArtifact(tenantId, node.id, 'workspace_draft');
    if (existing === PENDING_ARTIFACT_REF) return this.stagingIncompleteResult();
    if (existing) return { status: 'already_staged', artifactRef: existing };

    // Reserve the (node, type) slot BEFORE hopping (and before generating — only
    // the reservation winner spends LLM budget; a P2002 loser parks without
    // generating). A false return = a concurrent executor won the reservation in
    // the read-before-commit window (Window B), so park for reconciliation
    // rather than issue a duplicate external create.
    if (!(await this.reserveArtifact(tenantId, userId, strategy.id, node, 'workspace_draft'))) {
      return this.stagingIncompleteResult();
    }
    // Grounded generation, OUTSIDE any tx. Fails soft to null inside MeriService
    // — a Steward/orchestrator hiccup here must never fail the run. sanitizeDraftDoc
    // re-validates the shape (heading/html must be strings) so a contract drift in
    // the independently-deployed orchestrator can never throw mid-stage below.
    const doc = sanitizeDraftDoc(
      await this.meri.draftExecutionDocument(tenantId, bearer, {
        kind: 'workspace_draft',
        clientId: strategy.clientId,
        strategyType: strategy.type,
        goal: strategy.goal,
        node: nodeForDraft(node),
        grounding,
        stewardFacts,
        stewardHealth,
      }),
    );
    const sections = this.buildWorkspaceSections(doc, node, strategy);
    // Gate title selection on the same signal buildWorkspaceSections uses for the
    // body (doc.sections.length) — a degenerate generation (title present, sections
    // empty/sanitized-away) must fall back to node.title for BOTH, never pair an
    // AI-generated title with the deterministic placeholder body.
    const generated = !!doc?.sections?.length;
    const { ref } = await this.artifacts.createWorkspaceDraft(bearer, {
      docTitle: generated ? doc!.title?.trim() || node.title : node.title,
      clientName,
      product: strategy.type,
      sections,
    });
    await this.recordArtifact(tenantId, userId, runId, strategy.id, node, 'workspace_draft', ref, {
      doc,
      stewardFactCount: stewardFacts.length,
    });
    return {
      status: 'staged',
      artifactRef: ref,
      // Gate on usable content (sections.length), not doc truthiness — same
      // signal as recordArtifact's provenance, so a degenerate doc never
      // surfaces a real model id for what is actually the deterministic body.
      model: doc?.sections?.length ? (doc.model ?? undefined) : undefined,
      groundedFactCount: doc?.sections?.length ? citedFactRefs(doc.sections).length : undefined,
    };
  }

  private async stageOutreach(
    tenantId: string,
    userId: string | null,
    bearer: string,
    runId: string,
    node: NodeRow,
    strategy: StrategyRow,
    grounding: Grounding,
    stewardFacts: StewardFactLine[],
    stewardHealth: StewardHealth,
  ) {
    const existing = await this.findArtifact(tenantId, node.id, 'outreach_record');
    if (existing === PENDING_ARTIFACT_REF) return this.stagingIncompleteResult();
    // Idempotent replay: no body is regenerated/available here — computeSendApproval
    // falls back to the deterministic message for this run (documented Stage-G limit).
    if (existing) return { status: 'already_staged', artifactRef: existing };

    if (!strategy.clientId) {
      throw new BadRequestException('strategy has no client — cannot stage an outreach record');
    }
    // Write-ahead reservation BEFORE the external create (see stageWorkspace) — the
    // retry-safety + concurrency guard, checked AFTER the clientId precondition so a
    // client-less strategy never leaves a stray reservation. A false return = a
    // concurrent executor won the slot, so park for reconciliation (no duplicate hop).
    if (!(await this.reserveArtifact(tenantId, userId, strategy.id, node, 'outreach_record'))) {
      return this.stagingIncompleteResult();
    }
    // sanitizeDraftDoc re-validates the shape (heading/html must be strings) so a
    // contract drift in the independently-deployed orchestrator can never throw
    // mid-stage below (see stageWorkspace).
    const doc = sanitizeDraftDoc(
      await this.meri.draftExecutionDocument(tenantId, bearer, {
        kind: 'outreach_record',
        clientId: strategy.clientId,
        strategyType: strategy.type,
        goal: strategy.goal,
        node: nodeForDraft(node),
        grounding,
        stewardFacts,
        stewardHealth,
      }),
    );
    // Gate title selection on the same signal the body uses (doc.sections.length)
    // — mirrors stageWorkspace's docTitle gating: a degenerate generation (title
    // present, sections empty/sanitized-away) must fall back to node.title for
    // BOTH, never pair an AI-generated title with the deterministic placeholder
    // body. Otherwise a refined title/subject from propose_document_draft
    // (documented as applying generically to "the deliverable", not
    // workspace-only) actually reaches the staged OutreachRecord.
    const generated = !!doc?.sections?.length;
    const body = generated ? this.flattenSectionsToText(doc!.sections) : null;
    const recipient = node.targetRef ? this.buildTargetRecipient(node.targetRef) : null;
    const resume = this.buildOutreachResumeMetadata(
      recipient,
      generated,
      doc,
      generated ? this.flattenSectionsToHtml(doc!.sections) : null,
    );
    const { ref } = await this.artifacts.createOutreachRecord(bearer, {
      title: generated ? doc!.title?.trim() || node.title : node.title,
      subject: generated ? doc!.title?.trim() || node.title : node.title,
      clientId: strategy.clientId,
      body,
      recipients: recipient ? [recipient] : undefined,
      lastStep: resume.lastStep,
      metadata: {
        source: 'strategy-execution-agent',
        runId,
        nodeId: node.id,
        ...resume.metadata,
      },
    });
    await this.recordArtifact(tenantId, userId, runId, strategy.id, node, 'outreach_record', ref, {
      doc,
      stewardFactCount: stewardFacts.length,
    });
    return {
      status: 'staged',
      artifactRef: ref,
      body,
      // Gate on usable content (sections.length), not doc truthiness — same
      // signal as recordArtifact's provenance, so a degenerate doc never
      // surfaces a real model id for what is actually the deterministic body.
      model: doc?.sections?.length ? (doc.model ?? undefined) : undefined,
      groundedFactCount: doc?.sections?.length ? citedFactRefs(doc.sections).length : undefined,
    };
  }

  /** The staging result that tells runExecuting to park for reconciliation. */
  private stagingIncompleteResult(): { status: 'staging_incomplete'; reason: string } {
    return { status: 'staging_incomplete', reason: STAGING_INCOMPLETE_REASON };
  }

  /**
   * The artifactRef recorded for (node, type), or null. The value is EITHER a real
   * upstream ref (fully staged) OR PENDING_ARTIFACT_REF (a write-ahead reservation
   * whose finalize has not committed). At most one row exists per (node, type) at a
   * time — reserveArtifact writes the sentinel row, recordArtifact retires it in the
   * same tx that writes the real row — so the caller can trust a single value.
   */
  private async findArtifact(
    tenantId: string,
    nodeId: string,
    artifactType: 'workspace_draft' | 'outreach_record',
  ): Promise<string | null> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spNodeArtifact.findFirst({
        where: { nodeId, artifactType },
        select: { artifactRef: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return row?.artifactRef ?? null;
  }

  /**
   * Write-ahead intent AND the CAS guard on the re-entry/concurrency path: commit
   * a PENDING_ARTIFACT_REF back-link row for (node, type) BEFORE the external
   * create hop, via a plain CREATE on the unique triple. Two outcomes:
   *  - the row is created => we hold the reservation, return true and proceed to
   *    the hop (a create that succeeds upstream but whose finalize/recordArtifact
   *    fails leaves this durable marker a retry detects — see stageWorkspace); OR
   *  - the unique triple already carries the sentinel (P2002) => return false, the
   *    caller parks for reconciliation and MUST NOT hop. A CREATE (not an upsert)
   *    is what makes this SERIALIZE: when two executors both pass findArtifact()
   *    == null (Window B — a re-entered 'executing' run) and race here, exactly
   *    ONE wins the insert; the loser gets P2002. (An idempotent upsert would let
   *    BOTH proceed and duplicate the external artifact.) A crash-orphaned sentinel
   *    is normally caught earlier by findArtifact(); this closes the narrow
   *    read-before-commit window findArtifact() cannot see.
   * BUT the triple-scoped CREATE alone only collides with an existing PENDING
   * row — a caller that fully finished (generated, created upstream, and
   * committed the REAL ref via recordArtifact, which also retires its own
   * sentinel) leaves no row on the PENDING triple, so a staggered (not
   * simultaneous) concurrent caller's CREATE would succeed again and rerun the
   * whole generate+create cycle. Close that by re-checking for ANY row on
   * (nodeId, artifactType) — real ref or sentinel, not just this exact triple
   * — INSIDE this same transaction, immediately before the CREATE: Postgres
   * gives this findFirst a fresh read of what's committed as of this
   * transaction's start, so a prior caller's fully-committed real ref is
   * always visible here even though it wasn't visible to the caller's earlier
   * (pre-transaction) findArtifact() read.
   * Its OWN tx (must commit before the hop). It does NOT advance the node or log
   * activity (those belong to the real stage event); recordArtifact retires this
   * sentinel when it commits the real ref.
   */
  private async reserveArtifact(
    tenantId: string,
    userId: string | null,
    strategyId: string,
    node: NodeRow,
    artifactType: 'workspace_draft' | 'outreach_record',
  ): Promise<boolean> {
    try {
      await this.inTx(tenantId, userId, async (tx) => {
        // Re-check inside the transaction — see doc comment above.
        const existing = await tx.spNodeArtifact.findFirst({
          where: { nodeId: node.id, artifactType },
          select: { id: true },
        });
        if (existing) {
          throw ARTIFACT_ALREADY_PRESENT;
        }
        // Hook scopes reads but NOT create — set every scalar (prisma.service).
        await tx.spNodeArtifact.create({
          data: {
            tenantId,
            strategyId,
            nodeId: node.id,
            artifactType,
            artifactRef: PENDING_ARTIFACT_REF,
            createdByUserId: userId ?? 'system',
          },
        });
      });
      return true;
    } catch (err) {
      if (err === ARTIFACT_ALREADY_PRESENT) {
        return false;
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Finalize a staged artifact: retire the write-ahead reservation, record the node
   * -> artifact back-link with the REAL ref, AND advance the node's status
   * draft/suggested -> in_progress — but NEVER past it (DO NOT submit; stop before
   * internal_review per plan §G6). One withTenantUser tx, so the sentinel is dropped
   * and the real link appears together (a reader never sees both). The upsert on the
   * unique triple keeps a re-run from duplicating. Attributed authorKind 'meri'
   * (agent action) with the interactive actorUserId. Like artifact linking, this
   * does NOT cut a version — an execution side effect must not churn version history
   * (artifacts are dropped-on-restore, G6).
   */
  private async recordArtifact(
    tenantId: string,
    userId: string | null,
    runId: string,
    strategyId: string,
    node: NodeRow,
    artifactType: 'workspace_draft' | 'outreach_record',
    artifactRef: string,
    /** Stage-G grounded generation provenance (Task e2) — omitted on the
     *  deterministic fallback path (doc: null). */
    generation?: { doc: { model: string | null; sections: DocumentDraftSection[] } | null; stewardFactCount: number },
  ): Promise<void> {
    const advance = node.status === 'draft' || node.status === 'suggested';
    const refs = citedFactRefs(generation?.doc?.sections ?? []);
    // Gate on ACTUAL usable content, not doc truthiness — a degenerate/shape-
    // mismatched orchestrator response (e.g. {} or sections: []) must audit
    // identically to the null-doc fallback path, never claim generated:true
    // with a real model id over a persisted deterministic placeholder.
    const provenance = generation?.doc?.sections?.length
      ? {
          generated: true,
          model: generation.doc.model,
          promptSpecVersion: EXECUTION_DOC_PROMPT_SPEC,
          stewardFactsSent: generation.stewardFactCount,
          groundedFactCount: refs.length,
          citedFactRefs: refs,
        }
      : { generated: false };
    await this.inTx(tenantId, userId, async (tx) => {
      // Retire the write-ahead reservation so exactly one row remains for
      // (node, type) — the real ref below (idempotent: no-op if already retired).
      await tx.spNodeArtifact.deleteMany({
        where: { nodeId: node.id, artifactType, artifactRef: PENDING_ARTIFACT_REF },
      });
      await tx.spNodeArtifact.upsert({
        where: {
          nodeId_artifactType_artifactRef: { nodeId: node.id, artifactType, artifactRef },
        },
        // The query hook scopes upsert.where but NOT the create branch — set
        // every scalar (esp. tenantId) explicitly (prisma.service RLS note).
        create: {
          tenantId,
          strategyId,
          nodeId: node.id,
          artifactType,
          artifactRef,
          createdByUserId: userId ?? 'system',
        },
        update: {},
      });
      if (advance) {
        await tx.spNode.update({ where: { id: node.id }, data: { status: 'in_progress' } });
      }
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: 'meri',
        action: 'execution.artifact_staged',
        entityType: 'node',
        entityId: node.id,
        strategyId,
        after: { runId, artifactType, artifactRef, nodeStatusAdvanced: advance, ...provenance },
      });
    });
  }

  // ---- send-approval (token only — NEVER sends) ----------------------------

  /**
   * Compute the send-approval token over the EXACT (deterministic) message the
   * outreach WOULD send, bound to this run. Stored on findings.sendApproval; the
   * run parks awaiting approval. Nothing is sent — the send path stays
   * hard-disabled until Stage H (send-approval.ts / STRATEGY_EXECUTION_SEND_ENABLED).
   */
  private computeSendApproval(
    runId: string,
    node: NodeRow,
    strategy: StrategyRow,
    results: Record<string, unknown>,
    /** The token this SAME run last parked with (see readPriorSendApproval), if any. */
    priorSendApproval: Record<string, unknown> | null,
    /** P0-3: the live plan head + steward health the FULL binding hash covers.
     *  Passed in (not re-read) so the preview hash and the approve-time hash are
     *  computed from IDENTICAL inputs — otherwise "approve exact draft" could
     *  never match and every approval would 409. */
    bindingCtx: { headVersionId: string | null; stewardHealth: StewardHealth | null },
  ): Record<string, unknown> {
    const outreachResult = results[`${node.id}:outreach_record`] as
      | { artifactRef?: string; body?: string | null }
      | undefined;
    const outreachRef = outreachResult?.artifactRef ?? null;
    // Idempotent replay (stageOutreach's already_staged branch carries no body):
    // reuse the PRIOR token for this run+artifact VERBATIM instead of recomputing
    // one over the deterministic placeholder. Recomputing here would silently
    // overwrite a previously-correct, grounded-body-bound token — the one shown
    // in ExecutionReview's send-approval preview and wired to the approve action
    // — with one that no longer matches what is actually persisted upstream.
    if (
      !outreachResult?.body &&
      priorSendApproval &&
      priorSendApproval.tokenRunId === runId &&
      priorSendApproval.artifactRef === outreachRef
    ) {
      return priorSendApproval;
    }
    // The token hashes whatever is ACTUALLY staged: the grounded body when this
    // invocation just generated + staged one, else the same deterministic shell
    // as before this feature (a FIRST-time computation with no prior token to
    // reuse and no body — documented Stage-G limit, never a send regardless).
    const input: SendTokenInput = {
      message: outreachResult?.body?.trim() || `Outreach regarding: ${node.title}`,
      // A real target (see NOD targetRef picker) resolves to their name; an
      // untargeted node falls back to the bare subject category, unchanged
      // from before this feature.
      recipients: [node.targetRef ? targetDisplayName(node.targetRef) : node.subject],
      ask: strategy.goal?.trim() || node.title,
      windowStart: isoDate(node.startsOn),
      windowEnd: isoDate(node.endsOn),
    };
    return {
      token: computeSendToken(input),
      tokenRunId: runId,
      input,
      artifactRef: outreachRef,
      status: 'pending',
      // Explicit: the send stays disabled in Stage G regardless of the token.
      sendEnabled: false,
      // P0-3: the hash of the FULL binding for the payload as staged right now.
      // The web preview compares this against approvedContentHash to render the
      // changed-since-review badge; the server re-derives and re-verifies the
      // same binding at every gate (see verifyRunApproval).
      contentHash: computeApprovalHash(
        this.buildBinding(runId, node, strategy, results, {
          action: 'send',
          kind: 'outreach',
          headVersionId: bindingCtx.headVersionId,
          stewardHealth: bindingCtx.stewardHealth,
        }),
      ),
      ...(priorSendApproval?.approvedContentHash
        ? { approvedContentHash: priorSendApproval.approvedContentHash }
        : {}),
    };
  }

  // ---- P0-3 approval binding (records; authorises NO send) -------------------

  /**
   * The FULL approval binding for a run's current payload — the audit's required
   * field list, assembled from live state rather than from whatever the reviewer
   * happened to be looking at.
   *
   * `action` distinguishes approving the STAGING of an artifact from approving an
   * external SEND, and is itself bound, so a stage approval can never satisfy a
   * send (approval-binding.spec covers that explicitly).
   */
  private buildBinding(
    runId: string,
    node: NodeRow,
    strategy: StrategyRow,
    results: Record<string, unknown>,
    opts: {
      action: ApprovalAction;
      kind: ExecutionKindValue;
      headVersionId: string | null;
      stewardHealth?: StewardHealth | null;
    },
  ): ApprovalBinding {
    const artifactType = ARTIFACT_TYPE_BY_KIND[opts.kind];
    // A 'stage' approval is granted BEFORE anything is generated, so it binds the
    // PLAN (strategy+version, step, target, subject, template, grounding health)
    // and deliberately NOT the generated content — which does not exist yet.
    // Binding a body here would make every stage approval self-invalidate the
    // moment staging produced one, parking every resumed run. Content binding is
    // the 'send' approval's job, which is what P0-3 is actually about.
    const result = opts.action === 'send' ? asObject(results[`${node.id}:${artifactType}`]) : null;
    const body = typeof result?.body === 'string' ? result.body : '';
    const model = typeof result?.model === 'string' ? result.model : null;
    // `grounded` is the SAME signal recordArtifact audits: usable generated
    // sections, not mere doc truthiness. A deterministic fallback must never
    // present as grounded prose.
    const grounded = !!model;
    const citedFactRefs =
      typeof result?.groundedFactCount === 'number' && result.groundedFactCount > 0
        ? [`count:${result.groundedFactCount}`]
        : [];

    const recipients: ApprovalRecipient[] = node.targetRef
      ? [
          {
            id: node.targetRef.clientTargetId ?? node.targetRef.memberId ?? null,
            name: targetDisplayName(node.targetRef),
            address: null,
          },
        ]
      : [];

    return {
      strategyId: strategy.id,
      strategyVersionId: opts.headVersionId,
      nodeId: node.id,
      runId,
      action: opts.action,
      channel: artifactType,
      subject: node.title,
      body,
      recipients,
      // No attachment path exists on the execution payload yet; bound as an
      // empty set so adding one later is automatically invalidating.
      attachments: [],
      templateVersion: EXECUTION_DOC_PROMPT_SPEC,
      contextPackFingerprint: contextPackFingerprint({
        groundingStatus: opts.stewardHealth?.status ?? null,
        missingRequired: opts.stewardHealth?.missingRequired ?? [],
        openMaterialConflictIds: (opts.stewardHealth?.openMaterialConflicts ?? []).map((c) => c.id),
        citedFactRefs,
      }),
      groundingStatus: opts.stewardHealth?.status ?? null,
      grounded,
      model,
      provider: model ? 'anthropic' : null,
      // Bound so flipping the Stage-H switch cannot silently promote a historic
      // approval into a send authorisation.
      sendEnabled: sendEnabled(process.env),
    };
  }

  /**
   * The approval picture for a run: what is staged NOW, its content hash, any
   * recorded approval, and whether that approval still holds. This is what the
   * approval screen renders — so every disclosure the audit requires (exact
   * recipient, exact subject, full body, grounding warnings, fallback warning,
   * version drift, changed-since-review, stages-vs-sends) is a server-derived
   * fact rather than something the UI infers.
   */
  async approvalStatus(tenantId: string, runId: string) {
    const run = await this.runs.get(tenantId, runId);
    const meta = this.readExecutionMeta(run);
    const { strategy, targetNode, headVersionId } = await this.loadPlanState(
      tenantId,
      meta.strategyId,
      meta.nodeId,
    );
    const health = await this.steward.health(tenantId, strategy.clientId);
    const stewardHealth: StewardHealth = {
      status: health.status,
      missingRequired: health.missingRequired,
      openMaterialConflicts: health.openMaterialConflicts,
    };
    const results = this.readResults(run);
    // A run parked on the send gate is approving a SEND; anything earlier is
    // approving the STAGING of the artifact.
    const action: ApprovalAction = isSendPark(run) ? 'send' : 'stage';
    const binding = this.buildBinding(runId, targetNode, strategy, results, {
      action,
      kind: meta.kind,
      headVersionId,
      stewardHealth,
    });
    const approval = this.readApproval(run);
    const verification = approval ? verifyApproval(binding, approval) : null;

    return {
      runId,
      state: run.state as string,
      action,
      /** Does approving here stage an artifact, or transmit externally? */
      effect: action === 'send' ? 'sends externally' : 'stages internally',
      /** Always false in Stage G — the send path is hard-disabled. */
      sendEnabled: sendEnabled(process.env),
      contentHash: computeApprovalHash(binding),
      binding,
      approval,
      approvalValid: verification ? verification.valid : false,
      approvalInvalidReason: verification && !verification.valid ? verification.reason : null,
      changedFields: verification?.changedFields ?? [],
      // The audit's required disclosures, as explicit server-computed flags.
      warnings: {
        // Only meaningful for a send approval — a stage approval precedes
        // generation, so "not grounded" there is expected, not a warning.
        fallbackContent: action === 'send' && !binding.grounded,
        groundingStatus: stewardHealth.status,
        openMaterialConflicts: stewardHealth.openMaterialConflicts,
        missingRequiredContext: stewardHealth.missingRequired,
        versionDrift: meta.pinnedVersionId != null && meta.pinnedVersionId !== headVersionId,
        pinnedVersionId: meta.pinnedVersionId,
        headVersionId,
        changedSinceReview: !!approval && !!verification && !verification.valid,
      },
    };
  }

  /**
   * Approve the EXACT payload the reviewer is looking at.
   *
   * `contentHash` is mandatory and is the reviewer's assertion of WHAT they saw.
   * If the live payload no longer hashes to it, the draft moved between render
   * and click, so we 409 rather than approve something unseen. That check is the
   * whole point of P0-3 and is deliberately not softenable.
   *
   * Approving a plan (action 'stage') drives ready_for_review -> approved, the
   * state P0-2 made legal. Approving a send RECORDS the authorisation and leaves
   * the run parked: the external send stays hard-disabled and this method has no
   * send path of any kind.
   */
  async approve(tenantId: string, userId: string, runId: string, input: { contentHash: string }) {
    if (!input.contentHash) {
      throw new BadRequestException(
        'contentHash is required — approve the exact draft you reviewed',
      );
    }
    const status = await this.approvalStatus(tenantId, runId);
    if (input.contentHash !== status.contentHash) {
      throw new ConflictException(
        'this draft changed since you reviewed it — reload and approve the current content',
      );
    }
    if (status.action === 'stage' && !isActionAllowed(status.state, 'approve')) {
      throw new ConflictException(
        `run is ${status.state} — it cannot be approved (${reasonForState(status.state)})`,
      );
    }

    const now = new Date();
    const record = recordApproval(status.binding, userId, now);

    await this.inTx(tenantId, userId, async (tx) => {
      const run = await tx.spAgentRun.findFirst({ where: { id: runId } });
      if (!run) throw new NotFoundException('Run not found');
      const prevFindings = asObject(run.findings) ?? {};
      const prevSend = asObject(prevFindings.sendApproval);
      await tx.spAgentRun.updateMany({
        where: { id: runId },
        data: {
          findings: {
            ...prevFindings,
            approval: record as unknown as Prisma.JsonObject,
            // Mirror the approved hash onto the send preview so the web's
            // changed-since-review comparison (approvedContentHash vs
            // contentHash) works without a second fetch.
            ...(prevSend
              ? {
                  sendApproval: {
                    ...prevSend,
                    approvedContentHash: record.contentHash,
                    status: 'approved',
                  },
                }
              : {}),
          } as Prisma.InputJsonValue,
          heartbeatAt: now,
        },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: 'person',
        action: 'execution.approval_granted',
        entityType: 'run',
        entityId: runId,
        strategyId: status.binding.strategyId,
        // The FULL approved payload goes in the audit row, so the record can
        // reproduce exactly what was authorised — not merely that something was.
        after: {
          contentHash: record.contentHash,
          approvedAt: record.approvedAt,
          action: record.binding.action,
          sendEnabled: record.binding.sendEnabled,
          binding: record.binding as unknown as Prisma.JsonObject,
        },
      });
    });

    // A stage approval advances the lifecycle; a send approval leaves the run
    // parked (nothing may be transmitted in Stage G).
    if (status.action === 'stage' && status.state === 'ready_for_review') {
      await this.runs.transition(tenantId, userId, runId, { to: 'approved' } as TransitionRunDto);
    }
    return this.approvalStatus(tenantId, runId);
  }

  /** Withdraw/refuse an approval. Records who and why; never sends. */
  async rejectApproval(tenantId: string, userId: string, runId: string, reason?: string) {
    const run = await this.runs.get(tenantId, runId);
    const existing = this.readApproval(run);
    const now = new Date();
    const stated = reason?.trim() || 'rejected by a reviewer';

    await this.inTx(tenantId, userId, async (tx) => {
      const fresh = await tx.spAgentRun.findFirst({ where: { id: runId } });
      if (!fresh) throw new NotFoundException('Run not found');
      const prevFindings = asObject(fresh.findings) ?? {};
      const prevSend = asObject(prevFindings.sendApproval);
      const dead = existing
        ? invalidateApproval(existing, { valid: false, reason: stated, changedFields: [] }, now)
        : null;
      await tx.spAgentRun.updateMany({
        where: { id: runId },
        data: {
          findings: {
            ...prevFindings,
            ...(dead ? { approval: dead as unknown as Prisma.JsonObject } : {}),
            ...(prevSend
              ? { sendApproval: { ...prevSend, approvedContentHash: null, status: 'rejected' } }
              : {}),
            approvalRejection: { reason: stated, byUserId: userId, at: now.toISOString() },
          } as Prisma.InputJsonValue,
          heartbeatAt: now,
        },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: 'person',
        action: 'execution.approval_rejected',
        entityType: 'run',
        entityId: runId,
        after: { reason: stated, hadApproval: !!existing },
      });
    });
    return this.runs.get(tenantId, runId);
  }

  /**
   * P0-3 ENFORCEMENT. Re-derive the binding and re-verify a recorded approval
   * immediately before acting on it. A drifted approval is PERSISTED as
   * invalidated (with the fields that moved) and the run parks — never silently
   * ignored, and never silently honoured.
   *
   * Returns the invalidation reason when the approval no longer holds, else null.
   */
  private async verifyRunApproval(
    tenantId: string,
    userId: string | null,
    runId: string,
    run: { findings: unknown },
    binding: ApprovalBinding,
  ): Promise<string | null> {
    const approval = this.readApproval(run);
    if (!approval) return null; // nothing approved => nothing to invalidate
    const verification: ApprovalVerification = verifyApproval(binding, approval);
    if (verification.valid) return null;
    if (approval.status !== 'invalidated') {
      await this.persistInvalidation(tenantId, userId, runId, approval, verification);
    }
    return verification.reason ?? 'the approved payload changed';
  }

  private async persistInvalidation(
    tenantId: string,
    userId: string | null,
    runId: string,
    approval: ApprovalRecord,
    verification: ApprovalVerification,
  ): Promise<void> {
    const now = new Date();
    const dead = invalidateApproval(approval, verification, now);
    await this.inTx(tenantId, userId, async (tx) => {
      const fresh = await tx.spAgentRun.findFirst({ where: { id: runId } });
      if (!fresh) return;
      const prevFindings = asObject(fresh.findings) ?? {};
      const prevSend = asObject(prevFindings.sendApproval);
      await tx.spAgentRun.updateMany({
        where: { id: runId },
        data: {
          findings: {
            ...prevFindings,
            approval: dead as unknown as Prisma.JsonObject,
            ...(prevSend ? { sendApproval: { ...prevSend, status: 'invalidated' } } : {}),
          } as Prisma.InputJsonValue,
        },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: userId ? 'person' : 'meri',
        action: 'execution.approval_invalidated',
        entityType: 'run',
        entityId: runId,
        before: { contentHash: approval.contentHash, approvedAt: approval.approvedAt },
        after: { reason: dead.invalidatedReason, changedFields: dead.changedFields },
      });
    });
  }

  /** The recorded approval on a run, or null. */
  private readApproval(run: { findings: unknown }): ApprovalRecord | null {
    const raw = asObject(asObject(run.findings)?.approval);
    if (!raw || !asObject(raw.binding) || typeof raw.contentHash !== 'string') return null;
    return raw as unknown as ApprovalRecord;
  }

  /** The per-task staged results blob (findings.results), or {}. */
  private readResults(run: { findings: unknown }): Record<string, unknown> {
    return asObject(asObject(run.findings)?.results) ?? {};
  }

  // ---- client constraint (do-not-contact) ----------------------------------

  /**
   * Conservative do-not-contact gate: if any ACTIVE fact in the client's scope
   * carries authority 'client_approved' AND its text matches /do not contact|no
   * outreach/i, BLOCK the outreach task (documented heuristic — a client-approved
   * standing instruction outweighs a staged campaign). Tightening the match to
   * the node's SUBJECT proximity (only block when the instruction names this
   * counterparty) is a documented refinement; for now we over-block rather than
   * risk an unwanted contact.
   */
  private async checkClientConstraints(
    tenantId: string,
    clientId: string | null,
    _node: NodeRow,
  ): Promise<{ blocked: boolean; reason?: string }> {
    if (!clientId) return { blocked: false };
    // Push the do-not-contact predicate INTO the query. A prior version read an
    // UNORDERED take:200 page of every client_approved fact and regex-scanned it
    // in JS; with >200 active client_approved facts in scope (the OR aggregates
    // global clientId:null facts across the tenant) the matching instruction
    // could fall outside that arbitrary page and the gate would silently pass.
    // Filtering on the phrase list here means the DB returns ONLY candidate
    // matches (0 or a few), so no row cap can hide a standing client
    // instruction. DO_NOT_CONTACT_RE stays the authoritative gate on the rows.
    const facts = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spContextFact.findMany({
        where: {
          state: 'active',
          authority: CONSTRAINT_AUTHORITY,
          AND: [
            { OR: [{ clientId }, { clientId: null }] },
            {
              OR: DO_NOT_CONTACT_PHRASES.map((phrase) => ({
                fact: { contains: phrase, mode: 'insensitive' as const },
              })),
            },
          ],
        },
        select: { fact: true },
      }),
    );
    const hit = facts.find((f) => DO_NOT_CONTACT_RE.test(String(f.fact)));
    if (hit) {
      return { blocked: true, reason: `client constraint: "${String(hit.fact).slice(0, 200)}"` };
    }
    return { blocked: false };
  }

  // ---- loads / helpers -----------------------------------------------------

  private async resolveTarget(tenantId: string, dto: ExecutionPlanDto): Promise<string> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const mission = await tx.spAgentMission.findFirst({
        where: { id: dto.missionId },
        select: { id: true, strategyId: true },
      });
      if (!mission) throw new NotFoundException('Mission not found');
      const strategyId = dto.strategyId ?? mission.strategyId;
      if (!strategyId) {
        throw new BadRequestException(
          'mission has no strategy — pass strategyId for a firm-level mission',
        );
      }
      // P0-1: an archived node is not executable — it reads as not part of the
      // strategy, so no run can be planned against plan history.
      const node = await tx.spNode.findFirst({
        where: { id: dto.nodeId, strategyId, ...LIVE_NODE_WHERE },
        select: { id: true },
      });
      if (!node) throw new BadRequestException('node is not part of the target strategy');
      return strategyId;
    });
  }

  private async loadPlanState(
    tenantId: string,
    strategyId: string,
    nodeId: string,
  ): Promise<{ strategy: StrategyRow; targetNode: NodeRow; headVersionId: string | null }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const strategy = await tx.spStrategy.findFirst({
        where: { id: strategyId },
        // P0-1: LIVE plan only. Both the G0 re-check and the target-node lookup
        // read from this, so a node archived AFTER the plan was reviewed makes
        // execute() fail closed instead of staging against plan history.
        include: {
          nodes: { where: { ...LIVE_NODE_WHERE }, orderBy: [{ startsOn: 'asc' }, { createdAt: 'asc' }] },
        },
      });
      if (!strategy) throw new NotFoundException('Strategy not found');
      const s = strategy as unknown as StrategyRow;
      const targetNode = s.nodes.find((n) => n.id === nodeId);
      if (!targetNode) throw new BadRequestException('node is not part of the target strategy');
      const head = await tx.spVersion.findFirst({
        where: { strategyId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      return { strategy: s, targetNode, headVersionId: head?.id ?? null };
    });
  }

  /** Workspace expects the client NAME (unlike outreach's clientId). Tenant-scoped raw read. */
  private async resolveClientName(tenantId: string, clientId: string | null): Promise<string> {
    if (!clientId) return 'Client';
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM clients WHERE id = ${clientId}::uuid AND tenant_id = ${tenantId}::uuid LIMIT 1`,
    );
    return rows[0]?.name ?? 'Client';
  }

  /** The node + its transitive dependency ids ("this node's chain"). */
  private chainOf(targetId: string, nodes: NodeRow[]): Set<string> {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const chain = new Set<string>();
    const stack = [targetId];
    while (stack.length) {
      const id = stack.pop()!;
      if (chain.has(id)) continue;
      chain.add(id);
      const n = byId.get(id);
      for (const dep of n?.dependsOnIds ?? []) stack.push(dep);
    }
    return chain;
  }

  /** Same verifier input MeriService.verify / WatcherService.verify build. */
  private verify(strategyType: string, nodes: NodeRow[], ground: Grounding): Violation[] {
    const vnodes: VerifierNode[] = nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      subject: n.subject,
      title: n.title,
      startsOn: isoDate(n.startsOn) ?? '',
      endsOn: isoDate(n.endsOn),
      dependsOnIds: Array.isArray(n.dependsOnIds) ? n.dependsOnIds : [],
    }));
    return verifyPlan({
      strategyType,
      nodes: vnodes,
      fiscal: {
        today: ground.fiscal.today ?? null,
        fys: ground.fiscal.fys ?? [],
        fyLabels: ground.fiscal.fyLabels ?? [],
        focalFy: ground.fiscal.focalFy ?? '',
      },
      congress: ground.reference.congress,
      ppbeCurrentPhases: ground.reference.ppbeCurrentPhases,
    }).violations;
  }

  /** Deterministic HTML shell seeded into the staged draft when grounded
   *  generation is unavailable/failed (NO LLM prose) — the original Stage-G
   *  fallback, unchanged. */
  private deterministicWorkspaceHtml(node: NodeRow, strategy: StrategyRow): string {
    const title = escapeHtml(node.title);
    const goal = strategy.goal ? escapeHtml(strategy.goal) : '';
    return (
      `<p>Draft staged by the Strategy Execution Agent for step: <strong>${title}</strong> ` +
      `(${escapeHtml(node.subject)}).</p>` +
      (goal ? `<p>Strategy goal: ${goal}</p>` : '')
    );
  }

  /**
   * Workspace section map (Task c1/b4): a grounded multi-section draft maps
   * each `{heading, html}` onto one config.sectionContent entry (HTML
   * authoritatively sanitized here — sanitizeSectionHtml is the allowlist of
   * record, the orchestrator's own sanitizer is first-pass only). No sections
   * (generation failed/unavailable, or the model returned an empty array) ->
   * the single-entry deterministic fallback, unchanged from before this feature.
   */
  private buildWorkspaceSections(
    doc: { sections: DocumentDraftSection[] } | null,
    node: NodeRow,
    strategy: StrategyRow,
  ): Record<string, string> {
    if (doc?.sections?.length) {
      // Object.create(null), NOT {} — a model-authored heading that trims to the
      // literal string '__proto__' is a real (if adversarial) input, and on a
      // normal object literal `out['__proto__'] = html` hits Object.prototype's
      // __proto__ accessor: it silently no-ops for a non-object value instead of
      // creating an own property, so the section would vanish with no collision
      // and no trace. A null-prototype accumulator has no such accessor, so the
      // assignment (and the `in` collision check below) behave like a plain map.
      const out: Record<string, string> = Object.create(null);
      for (const s of doc.sections) {
        const heading = s.heading.trim() || 'Background';
        const html = sanitizeSectionHtml(s.html);
        // Two model-authored sections can share a heading (the tool schema puts
        // no uniqueness constraint on it) — merge onto the same slot instead of
        // last-write-wins, so a colliding section's HTML is appended rather than
        // silently dropped from the persisted workspace draft.
        out[heading] = heading in out ? `${out[heading]}\n${html}` : html;
      }
      return out;
    }
    return { Background: this.deterministicWorkspaceHtml(node, strategy) };
  }

  /**
   * Flatten a grounded draft's sections into one plain-text Outreach campaign
   * body (Task c2): heading + HTML-stripped-to-text per section, joined with
   * blank lines. Sanitized first (sanitizeSectionHtml), then tags stripped —
   * OutreachRecord.body is a plain-text column, not HTML.
   */
  private flattenSectionsToText(sections: DocumentDraftSection[]): string {
    return sections
      .map((s) => {
        const text = sanitizeSectionHtml(s.html)
          .replace(/<\/(p|li|h2|h3)>/gi, '\n')
          // Remaining tags (opening block tags + ANY inline tag: <a>, </a>,
          // <strong>, </strong>, <em>, </em>) are stripped to a SPACE, not
          // empty string — otherwise text immediately adjacent to an inline
          // tag with no surrounding whitespace in the source HTML (e.g.
          // `see<a href="...">this report</a>for details`) gets jammed
          // together with no separator once the tag itself disappears.
          .replace(/<[^>]+>/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/ *\n */g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        return s.heading.trim() ? `${s.heading.trim()}\n${text}` : text;
      })
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  /**
   * Flatten a grounded draft's sections into ONE html string for the outreach
   * wizard's per-recipient draft (metadata.generatedByKey) — the wizard renders
   * that field as HTML (sanitizeHtml(markdownishToHtml(...)) on ITS OWN
   * generations), unlike OutreachRecord.body which is plain text. Headings are
   * dropped (an email body isn't a multi-section document); each section's
   * already-sanitized HTML is just joined in order.
   */
  private flattenSectionsToHtml(sections: DocumentDraftSection[]): string {
    return sections
      .map((s) => sanitizeSectionHtml(s.html))
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Build the OutreachRecipientDto-shaped object for a node's targetRef (see
   * NodeTargetRef) — a real, named recipient instead of the bare subject
   * category. `id`/`directoryContactId` = memberId so the web wizard's
   * recipientKey() (id || directoryContactId || email || name) is stable and
   * DETERMINISTIC across this recipient object and its generatedByKey genKey
   * below (both must derive the identical key or the wizard treats the seeded
   * draft as belonging to a different, empty slot and silently regenerates it).
   */
  private buildTargetRecipient(target: NodeTargetRef): Record<string, unknown> {
    return {
      id: target.memberId,
      name: target.memberName?.trim() || target.memberId,
      directoryContactId: target.memberId,
      directoryContactName: target.memberName?.trim() || undefined,
      chamber: target.chamber || undefined,
      state: target.state || undefined,
      party: target.party || undefined,
      committee: target.committee || undefined,
      sourceLabel: 'Strategy target',
    };
  }

  /**
   * Everything the outreach wizard needs to resume USEFULLY on a staged
   * OutreachRecord, instead of the blank Direction-landing step every prior
   * staged outreach opened to (NewOutreachWizard's resume hydration needs
   * `record.recipients` non-empty AND a matching `individual:<key>`-prefixed
   * metadata.generatedByKey entry — the wizard's OWN legacy per-recipient
   * fallback seeds a BARE (unprefixed) key that never matches a v2 genKey, so
   * we write the v2 shape directly rather than relying on that fallback).
   * No recipient resolved -> land on 'recipients' (still strictly better than
   * 'direction'); recipient resolved but generation fell back to the
   * deterministic placeholder -> land on 'recipients' too (nothing worth
   * reviewing on 'generate' yet); recipient + real grounded content -> land on
   * 'generate' with the draft pre-seeded so Meri's grounded body is what the
   * user sees, not the wizard's own (ungrounded) auto-generation.
   */
  private buildOutreachResumeMetadata(
    recipient: Record<string, unknown> | null,
    generated: boolean,
    doc: NodeDocumentDraftResponse | null,
    htmlBody: string | null,
  ): { lastStep: number; metadata: Record<string, unknown> } {
    if (!recipient) {
      return { lastStep: 3, metadata: { lastStepId: 'recipients' } };
    }
    const target = { key: 'node-target', type: 'individual', recipients: [recipient], cc: [], bcc: [] };
    if (!generated || !htmlBody) {
      return { lastStep: 3, metadata: { lastStepId: 'recipients', targets: [target] } };
    }
    const genKey = `individual:${recipient.id as string}`;
    return {
      lastStep: 5,
      metadata: {
        lastStepId: 'generate',
        targets: [target],
        generatedByKey: {
          [genKey]: {
            subject: doc?.title?.trim() || '',
            body: htmlBody,
            status: 'ready',
          },
        },
      },
    };
  }

  /**
   * Read-only Steward facts for grounded generation — fails soft to [] on any
   * error (mirrors MeriService.stewardContext; this is prompt content, never a
   * gate). A SEPARATE fetch from evaluateG0's `this.steward.health()` call,
   * which is NOT wrapped (a health-read failure legitimately should surface,
   * since it feeds the G0 eligibility gate).
   */
  private async fetchStewardFactsSafely(
    tenantId: string,
    clientId: string | null,
  ): Promise<StewardFactLine[]> {
    try {
      return await this.steward.factsForOrchestrator(tenantId, clientId);
    } catch (err) {
      this.logger.warn(`steward facts unavailable for generation: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Workspace access. Today it is guaranteed by the executionAgentWorkspace flag
   * (re-checked fail-closed above), so a workspace-kind plan that reaches G0 is
   * entitled -> true. A finer-grained per-user workspace ACL check is a
   * documented Stage-H seam; the pure eligibility module already gates on the
   * `false` path, exercised exhaustively in the unit spec.
   */
  private hasWorkspaceAccess(_kind: ExecutionKindValue): boolean {
    return true;
  }

  private async assertKindEnabled(tenantId: string, kind: ExecutionKindValue): Promise<void> {
    const flag =
      kind === 'workspace'
        ? AGENTIC_FLAGS.executionAgentWorkspace
        : AGENTIC_FLAGS.executionAgentOutreach;
    const enabled = await this.flags.isAgenticFlagEnabled(tenantId, flag);
    if (!enabled) {
      throw new ForbiddenException(`The Execution Agent (${kind}) is not enabled for this tenant`);
    }
  }

  private readExecutionMeta(run: { findings: unknown }): ExecutionMeta {
    const f = asObject(run.findings);
    const meta = asObject(f?.execution);
    const kind = meta?.kind;
    if (kind !== 'workspace' && kind !== 'outreach') {
      throw new BadRequestException('run is not an execution run (missing execution metadata)');
    }
    return {
      kind,
      nodeId: String(meta!.nodeId),
      strategyId: String(meta!.strategyId),
      missionId: String(meta!.missionId),
      pinnedVersionId: typeof meta!.pinnedVersionId === 'string' ? meta!.pinnedVersionId : null,
    };
  }

  private readTasks(run: { findings: unknown }): ExecutionTask[] | null {
    const f = asObject(run.findings);
    const tasks = f?.tasks;
    return Array.isArray(tasks) && tasks.length > 0 ? (tasks as ExecutionTask[]) : null;
  }

  /**
   * The send-approval token this run last parked with, if any. Read BEFORE
   * re-entering runExecuting so an already-staged outreach replay (stageOutreach's
   * findArtifact() branch, which carries no body) can reuse the prior grounded
   * token instead of computeSendApproval falling back to the deterministic
   * placeholder and overwriting it — see computeSendApproval.
   */
  private readPriorSendApproval(run: { findings: unknown }): Record<string, unknown> | null {
    return asObject(asObject(run.findings)?.sendApproval);
  }

  private inTx<T>(tenantId: string, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return userId
      ? this.prisma.withTenantUser(tenantId, userId, fn)
      : this.prisma.withTenant(tenantId, fn);
  }

  // ---- metrics / structured logging (Stage H) ------------------------------

  /**
   * Phase-finish settle (Stage H): best-effort stamp the run's metrics, log the
   * outcome with run/mission context, and return the (freshly-read) run. Called
   * at every runPlanning / runExecuting exit — park OR complete — so run.findings
   * always carries the last phase + its latency.
   */
  private async settlePhase(
    tenantId: string,
    userId: string | null,
    runId: string,
    missionId: string,
    phase: 'plan' | 'execute',
    phaseStart: number,
    generation?: { model?: string; promptSpecVersion?: string },
  ) {
    await this.stampMetrics(tenantId, userId, runId, {
      phase,
      latencyMs: Date.now() - phaseStart,
      ...(generation?.model !== undefined ? { model: generation.model } : {}),
      ...(generation?.promptSpecVersion !== undefined
        ? { promptSpecVersion: generation.promptSpecVersion }
        : {}),
    });
    // P0-2 HEARTBEAT: refresh the liveness clock at every phase exit so a long
    // but healthy phase (grounded generation + two upstream hops) is never read as
    // a stranded run by the reconciler. Best-effort inside — never fails a phase.
    await this.runs.heartbeat(tenantId, runId);
    const run = await this.runs.get(tenantId, runId);
    this.logger.log(
      `[run:${runId} mission:${missionId}] execution ${phase} settled -> ${run.state}`,
    );
    return run;
  }

  /**
   * Merge run metrics (model / prompt-spec / latency / last-phase) onto
   * run.findings ADDITIVELY (stampRunMetrics preserves execution/tasks/g0/
   * results). BEST-EFFORT: an observability write must never fail a run, so a
   * throw is logged and swallowed. Deliberately NOT audited via
   * VersioningService.logActivity — it is a silent annotation (like the
   * write-ahead reservation), not a domain mutation. The read+merge+write share
   * one tx so a concurrent findings write is not blindly clobbered (soft: the
   * merge is onto the read-time snapshot). ai_usage agent_run_id linkage is a
   * documented cross-app seam (see run-metrics.ts).
   */
  private async stampMetrics(
    tenantId: string,
    userId: string | null,
    runId: string,
    input: RunMetricsInput,
  ): Promise<void> {
    try {
      await this.inTx(tenantId, userId, async (tx) => {
        const run = await tx.spAgentRun.findFirst({ where: { id: runId } });
        if (!run) return;
        await tx.spAgentRun.updateMany({
          where: { id: runId },
          data: { findings: stampRunMetrics(run.findings, input) as Prisma.InputJsonValue },
        });
      });
    } catch (err) {
      this.logger.warn(`[run:${runId}] run-metrics stamp skipped: ${(err as Error).message}`);
    }
  }
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * P0-3: is this run parked on the SEND gate? That is the point at which the
 * thing being approved is an external transmission rather than internal staging.
 * Keyed off the same waitingReason the send park writes.
 */
function isSendPark(run: { state?: unknown; waitingReason?: unknown; findings?: unknown }): boolean {
  if (run.state !== 'waiting_for_input') return false;
  if (typeof run.waitingReason === 'string' && /awaiting send approval/i.test(run.waitingReason)) {
    return true;
  }
  return false;
}

/** A stage result that signals a surviving write-ahead reservation (parks the run). */
function isStagingIncomplete(result: unknown): boolean {
  return asObject(result)?.status === 'staging_incomplete';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Runtime shape guard on the orchestrator's response, applied ONCE immediately
 * after draftExecutionDocument returns (both stageWorkspace and stageOutreach).
 * Unlike MeriService's draftNode/applyEdit — which explicitly re-validate other
 * semi-trusted LLM-sourced fields before use — nothing downstream of the fetch
 * (buildWorkspaceSections, flattenSectionsToText, citedFactRefs, the `generated`
 * gates, and the persisted provenance) re-checked that a `sections` entry's
 * `heading`/`html` were actually strings before calling .trim()/handing them to
 * sanitizeSectionHtml. draftExecutionDocument's try/catch only covers the HTTP
 * hop, not the *shape* of a 200 response, and the orchestrator
 * (apps/meriv2-orchestrator) is an independently-deployed service whose own
 * sanitizeDocumentSections is first-pass only (see sanitizeSectionHtml below) —
 * a contract drift there must not throw here. This must never throw mid-stage:
 * reserveArtifact has already committed the write-ahead sentinel by the time
 * doc is read, so an uncaught throw would park the run stuck rather than
 * cleanly recording the deterministic fallback. Malformed entries are dropped,
 * not thrown on — exactly the "no usable sections" path every downstream
 * consumer already falls back on.
 */
function sanitizeDraftDoc(doc: NodeDocumentDraftResponse | null): NodeDocumentDraftResponse | null {
  if (!doc) return doc;
  const sections = Array.isArray(doc.sections) ? doc.sections.filter(isWellFormedSection) : [];
  return sections.length === doc.sections?.length ? doc : { ...doc, sections };
}

function isWellFormedSection(s: unknown): s is DocumentDraftSection {
  return (
    !!s &&
    typeof s === 'object' &&
    typeof (s as DocumentDraftSection).heading === 'string' &&
    typeof (s as DocumentDraftSection).html === 'string'
  );
}

/**
 * Human-readable label for a node's target, e.g. "Rep. Jane Smith (D, CA,
 * House)". Falls back to the bare member id when no display name was
 * snapshotted (a picker edge case, not the normal path).
 */
function targetDisplayName(target: NodeTargetRef): string {
  const name = target.memberName?.trim() || target.memberId;
  const parts = [target.party, target.state, target.chamber].filter(
    (p): p is string => Boolean(p?.trim()),
  );
  return parts.length ? `${name} (${parts.join(', ')})` : name;
}

/**
 * NodeRow -> the orchestrator's DocumentDraftNode wire shape (ISO dates). The
 * node's targetRef (WHO this is for, not just its subject category) is folded
 * into `note` as a grounding line rather than widened as a new wire field —
 * avoids a cross-service DTO change in the independently-deployed orchestrator
 * for what is, from the prompt's perspective, just more node context.
 */
function nodeForDraft(node: NodeRow): {
  id: string;
  kind: string;
  subject: string;
  title: string;
  note: string | null;
  startsOn: string | null;
  endsOn: string | null;
} {
  const targetLine = node.targetRef
    ? `Target: ${targetDisplayName(node.targetRef)}${node.targetRef.committee ? ` — ${node.targetRef.committee}` : ''}`
    : null;
  return {
    id: node.id,
    kind: node.kind,
    subject: node.subject,
    title: node.title,
    note: targetLine ? [targetLine, node.note].filter(Boolean).join('\n') : node.note,
    startsOn: isoDate(node.startsOn),
    endsOn: isoDate(node.endsOn),
  };
}

/** A staged-task result's generation model, if grounded generation ran. */
function readGeneratedModel(result: unknown): string | undefined {
  const model = asObject(result)?.model;
  return typeof model === 'string' && model ? model : undefined;
}

/** 'fact:<id>' provenance refs a grounded draft's sections actually cited. */
function citedFactRefs(sections: DocumentDraftSection[]): string[] {
  return sections
    .flatMap((s) => s.sources ?? [])
    .map((s) => s.ref)
    .filter((ref): ref is string => typeof ref === 'string' && ref.startsWith('fact:'));
}

/**
 * Authoritative HTML allowlist (Task c3) — the orchestrator's
 * sanitizeDocumentSections is first-pass only; THIS is what actually reaches
 * config.sectionContent / the outreach body. Strips every tag except
 * h2/h3/p/ul/ol/li/strong/em/a, drops every attribute except a
 * scheme-restricted href on <a>, and removes script/style blocks + any
 * on*="" event-handler attribute outright.
 */
const ALLOWED_TAGS = new Set(['h2', 'h3', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'a']);
const HREF_SCHEME_RE = /^(https?:|mailto:)/i;

function sanitizeSectionHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, rawTag: string, attrs: string) => {
      const tag = rawTag.toLowerCase();
      const closing = match.startsWith('</');
      if (!ALLOWED_TAGS.has(tag)) return '';
      if (closing) return `</${tag}>`;
      if (tag !== 'a') return `<${tag}>`;
      const hrefMatch = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? '';
      return href && HREF_SCHEME_RE.test(href.trim())
        ? `<a href="${escapeHtml(href.trim())}">`
        : '<a>';
    });
}
