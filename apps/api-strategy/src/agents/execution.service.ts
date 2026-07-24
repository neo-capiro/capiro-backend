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
import { MeriService, type Grounding } from '../meri/meri.service.js';
import { StewardService } from '../context/steward.service.js';
import { AGENTIC_FLAGS, StrategyFlagsService } from '../flags/strategy-flags.service.js';
import { RunsService } from './runs.service.js';
import { ExecutionArtifactClient } from './execution-artifact.client.js';
import { computeSendToken, type SendTokenInput } from './send-approval.js';
import { evaluateEligibility, type EligibilityResult } from './execution-eligibility.js';
import { stampRunMetrics, type RunMetricsInput } from './run-metrics.js';
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
 * Write-ahead intent sentinel for sp_node_artifact.artifactRef. A staging attempt
 * commits a row carrying THIS ref BEFORE the external create hop (reserveArtifact);
 * recordArtifact then retires it and commits the REAL ref atomically with the
 * node-status advance. Staging's external create and its local back-link cannot be
 * one transaction, so this sentinel is what makes a retry safe: if a prior attempt
 * created the upstream artifact but its back-link write failed, the sentinel
 * survives, so the retry FINDS it and parks for reconciliation instead of issuing a
 * second external create (a duplicate staged artifact). Real WsDraft/OutreachRecord
 * ids are uuids and never collide with it.
 */
export const PENDING_ARTIFACT_REF = '__staging_pending__';

/**
 * Reason a run parks when a retry finds a surviving write-ahead reservation: the
 * external artifact may already exist upstream but was never linked, so it needs a
 * human/Stage-H reconciliation before any further attempt (never a duplicate hop).
 */
const STAGING_INCOMPLETE_REASON =
  'artifact staging incomplete — an external artifact may exist upstream but was not linked; reconcile before retrying';

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

/** The node fields plan/execute reason over (Prisma row subset). */
interface NodeRow {
  id: string;
  kind: string;
  subject: string;
  title: string;
  ownerUserId: string | null;
  status: string;
  startsOn: Date | string | null;
  endsOn: Date | string | null;
  dependsOnIds: string[];
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
  ): Promise<{ g0: Record<string, unknown>; blockReason: string | null }> {
    const ground = await this.meri.grounding(tenantId);
    const health = await this.steward.health(tenantId, strategy.clientId);
    const openMaterialConflicts = health.openMaterialConflicts.length;

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

    return { g0, blockReason };
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
    if (run.state !== 'ready_for_review' && run.state !== 'executing') {
      throw new ConflictException(
        `run is ${run.state} — only a ready_for_review run can be executed`,
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

    if (run.state === 'ready_for_review') {
      await this.runs.transition(tenantId, userId, runId, {
        to: 'executing',
      } as TransitionRunDto);
    }
    return this.runExecuting(tenantId, userId, bearer, runId, meta, tasks);
  }

  private async runExecuting(
    tenantId: string,
    userId: string | null,
    bearer: string,
    runId: string,
    meta: ExecutionMeta,
    tasks: ExecutionTask[],
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
      return this.settlePhase(tenantId, userId, runId, meta.missionId, 'execute', phaseStart);
    }

    const clientName = await this.resolveClientName(tenantId, strategy.clientId);

    const results: Record<string, unknown> = {};
    let sendApproval: Record<string, unknown> | null = null;
    let sendPending = false;
    let blocked = false;
    let stagingIncomplete = false;

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
        );
        results[key] = staged;
        if (isStagingIncomplete(staged)) stagingIncomplete = true;
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
        );
        results[key] = staged;
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
        sendApproval = this.computeSendApproval(runId, targetNode, strategy, results);
        results[key] = { status: 'awaiting_send_approval' };
        sendPending = true;
      }
    }

    // A surviving write-ahead reservation (an external artifact may exist upstream
    // but was never linked) takes precedence — park for reconciliation rather than
    // completing or issuing a duplicate hop. NEVER re-create here.
    if (stagingIncomplete) {
      await this.runs.transition(tenantId, userId, runId, {
        to: 'waiting_for_input',
        waitingReason: STAGING_INCOMPLETE_REASON,
        findings: { results, ...(sendApproval ? { sendApproval } : {}) },
      } as TransitionRunDto);
      return this.settlePhase(tenantId, userId, runId, meta.missionId, 'execute', phaseStart);
    }
    if (blocked) {
      await this.runs.transition(tenantId, userId, runId, {
        to: 'waiting_for_input',
        waitingReason: 'outreach blocked by a client do-not-contact constraint',
        findings: { results, ...(sendApproval ? { sendApproval } : {}) },
      } as TransitionRunDto);
      return this.settlePhase(tenantId, userId, runId, meta.missionId, 'execute', phaseStart);
    }
    if (sendPending) {
      // The run does NOT auto-complete while a send is pending — it parks for a
      // human to approve (and, only in Stage H, to actually send).
      await this.runs.transition(tenantId, userId, runId, {
        to: 'waiting_for_input',
        waitingReason: 'awaiting send approval',
        findings: { results, sendApproval },
      } as TransitionRunDto);
      return this.settlePhase(tenantId, userId, runId, meta.missionId, 'execute', phaseStart);
    }

    // All non-send tasks done, nothing pending => final validation + complete.
    await this.runs.transition(tenantId, userId, runId, {
      to: 'ready_for_review',
      findings: { results },
    } as TransitionRunDto);
    await this.runs.transition(tenantId, userId, runId, {
      to: 'completed',
    } as TransitionRunDto);
    return this.settlePhase(tenantId, userId, runId, meta.missionId, 'execute', phaseStart);
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
      return this.runExecuting(tenantId, userId, bearer, runId, meta, tasks);
    }

    // G0 park (no plan yet) -> re-run the pre-execution re-check.
    await this.runs.transition(tenantId, userId, runId, { to: 'planning' } as TransitionRunDto);
    return this.runPlanning(tenantId, userId, runId, meta);
  }

  /** Cancel a run per the lifecycle (canceled is reachable from every non-terminal state). */
  async cancel(tenantId: string, userId: string | null, runId: string) {
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
  ) {
    const existing = await this.findArtifact(tenantId, node.id, 'workspace_draft');
    if (existing === PENDING_ARTIFACT_REF) return this.stagingIncompleteResult();
    if (existing) return { status: 'already_staged', artifactRef: existing };

    // Reserve the (node, type) slot BEFORE hopping. A false return = a concurrent
    // executor won the reservation in the read-before-commit window (Window B), so
    // park for reconciliation rather than issue a duplicate external create.
    if (!(await this.reserveArtifact(tenantId, userId, strategy.id, node, 'workspace_draft'))) {
      return this.stagingIncompleteResult();
    }
    const { ref } = await this.artifacts.createWorkspaceDraft(bearer, {
      docTitle: node.title,
      clientName,
      product: strategy.type,
      sectionHtml: this.deterministicWorkspaceHtml(node, strategy),
    });
    await this.recordArtifact(tenantId, userId, runId, strategy.id, node, 'workspace_draft', ref);
    return { status: 'staged', artifactRef: ref };
  }

  private async stageOutreach(
    tenantId: string,
    userId: string | null,
    bearer: string,
    runId: string,
    node: NodeRow,
    strategy: StrategyRow,
  ) {
    const existing = await this.findArtifact(tenantId, node.id, 'outreach_record');
    if (existing === PENDING_ARTIFACT_REF) return this.stagingIncompleteResult();
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
    const { ref } = await this.artifacts.createOutreachRecord(bearer, {
      title: node.title,
      subject: node.subject,
      clientId: strategy.clientId,
      metadata: { source: 'strategy-execution-agent', runId, nodeId: node.id },
    });
    await this.recordArtifact(tenantId, userId, runId, strategy.id, node, 'outreach_record', ref);
    return { status: 'staged', artifactRef: ref };
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
      await this.inTx(tenantId, userId, (tx) =>
        // Hook scopes reads but NOT create — set every scalar (prisma.service).
        tx.spNodeArtifact.create({
          data: {
            tenantId,
            strategyId,
            nodeId: node.id,
            artifactType,
            artifactRef: PENDING_ARTIFACT_REF,
            createdByUserId: userId ?? 'system',
          },
        }),
      );
      return true;
    } catch (err) {
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
  ): Promise<void> {
    const advance = node.status === 'draft' || node.status === 'suggested';
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
        after: { runId, artifactType, artifactRef, nodeStatusAdvanced: advance },
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
  ): Record<string, unknown> {
    const outreachRef =
      (results[`${node.id}:outreach_record`] as { artifactRef?: string } | undefined)?.artifactRef ??
      null;
    // Deterministic shell — NO LLM prose (that is the deferred Meri seam).
    const input: SendTokenInput = {
      message: `Outreach regarding: ${node.title}`,
      recipients: [node.subject],
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
    };
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
      const node = await tx.spNode.findFirst({
        where: { id: dto.nodeId, strategyId },
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
        include: { nodes: { orderBy: [{ startsOn: 'asc' }, { createdAt: 'asc' }] } },
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

  /** Deterministic HTML shell seeded into the staged draft (NO LLM prose). */
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
  ) {
    await this.stampMetrics(tenantId, userId, runId, { phase, latencyMs: Date.now() - phaseStart });
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
