import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { LIVE_NODE_WHERE } from '../strategy/live-node.js';
import { isPendingRef, isRealRef, PENDING_ARTIFACT_REF } from './artifact-ref.js';
import { RunsService } from './runs.service.js';
import { RUN_STATE_POLICY, RUN_TERMINAL_STATES } from './run-state.js';
import {
  detectRecovery,
  needsHuman,
  repairFor,
  type RecoveryArtifactRow,
  type RecoveryFinding,
} from './run-recovery.js';
import type { TransitionRunDto } from './dto/agents.dto.js';

/*
 * P0-2 run reconciliation — the repair half of "Execution runs can become
 * permanently stranded".
 *
 * Two entry points, deliberately different in blast radius:
 *
 *  - reconcileRun(tenantId, userId, runId): ON-DEMAND, always available. This is
 *    what the "Reconcile" control in the review UI calls. One run, tenant-scoped,
 *    attributed to the user who asked.
 *
 *  - tickOnce(): the SWEEP. Cross-tenant, claims stale non-terminal runs and
 *    reconciles each. DARK BY DEFAULT — armed only when STRATEGY_AGENTS_ENABLED
 *    and STRATEGY_RUN_RECONCILER are both 'true' (the same dark-by-default shape
 *    as WatcherSchedulerService, deliberately: nothing new starts moving
 *    production run state on a deploy).
 *
 * Rules live in the pure run-recovery.ts. This service only does I/O: gather the
 * facts a rule needs, apply at most ONE transition per run per pass, and audit
 * everything. It NEVER creates or sends anything — reconciliation cannot stage an
 * artifact, and there is no send path here at all.
 */

const DEFAULT_POLL_MS = 300_000; // 5 min — recovery is not latency-sensitive
const MIN_POLL_MS = 60_000;
/** How many stale runs one sweep pass handles (the rest wait for the next tick). */
const SWEEP_BATCH = 50;

/** Non-terminal states the sweep considers (terminal runs need no recovery). */
const SWEEPABLE_STATES = Object.entries(RUN_STATE_POLICY)
  .filter(([, p]) => !p.terminal)
  .map(([state]) => state);

export interface ReconcileResult {
  runId: string;
  findings: RecoveryFinding[];
  /** The transition actually applied, if any. */
  applied: { to: string; reason: string } | null;
  /** True when findings exist but only a human can resolve them. */
  needsHuman: boolean;
}

export interface SweepResult {
  scanned: number;
  repaired: number;
  escalated: number;
  clean: number;
}

@Injectable()
export class RunReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunReconcilerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: RunsService,
    private readonly versioning: VersioningService,
  ) {}

  /**
   * DARK BY DEFAULT (mirrors WatcherSchedulerService). Both switches must be on:
   * STRATEGY_AGENTS_ENABLED (the agentic kill-switch) AND STRATEGY_RUN_RECONCILER
   * (this loop's own switch). On-demand reconcileRun() is unaffected by either —
   * a human asking to repair one run is always allowed.
   */
  onModuleInit(): void {
    if (
      process.env.STRATEGY_AGENTS_ENABLED !== 'true' ||
      process.env.STRATEGY_RUN_RECONCILER !== 'true'
    ) {
      return;
    }
    const raw = Number(process.env.STRATEGY_RUN_RECONCILER_POLL_MS);
    const intervalMs = Math.max(
      Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_MS,
      MIN_POLL_MS,
    );
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    this.logger.log(`run reconciler armed (sweep every ${intervalMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Interval callback: guarded so a slow sweep never overlaps the next fire. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tickOnce();
    } catch (err) {
      this.logger.error(`run reconciler sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One sweep pass (exposed for tests — no timer, no re-entrancy guard).
   * Cross-tenant read under withSystem, then per-run reconcile inside the run's
   * OWN tenant scope. A poisoned run is isolated by the per-run try/catch and can
   * never wedge the loop.
   */
  async tickOnce(): Promise<SweepResult> {
    const candidates = await this.prisma.withSystem((tx) =>
      tx.spAgentRun.findMany({
        where: {
          state: { in: SWEEPABLE_STATES as never },
          idempotencyKey: { startsWith: 'exec:' },
        },
        // Oldest heartbeat first: the longest-stuck runs get attention first.
        // Nulls sort last in Postgres ASC, so pre-P0-2 rows (heartbeatAt NULL)
        // are picked up after the dated ones — intentional, they are the least
        // urgent because they are already long dead.
        orderBy: [{ heartbeatAt: 'asc' }, { createdAt: 'asc' }],
        take: SWEEP_BATCH,
        select: { id: true, tenantId: true },
      }),
    );

    const result: SweepResult = { scanned: 0, repaired: 0, escalated: 0, clean: 0 };
    for (const row of candidates) {
      result.scanned += 1;
      try {
        // userId null => attributed to the system (authorKind 'meri').
        const out = await this.reconcileRun(row.tenantId, null, row.id);
        if (out.applied) result.repaired += 1;
        else if (out.needsHuman) result.escalated += 1;
        else result.clean += 1;
      } catch (err) {
        this.logger.error(`reconcile run ${row.id} failed: ${(err as Error).message}`);
      }
    }
    if (result.scanned) {
      this.logger.log(
        `run reconciler sweep: scanned=${result.scanned} repaired=${result.repaired} escalated=${result.escalated} clean=${result.clean}`,
      );
    }
    return result;
  }

  /**
   * Reconcile ONE run: gather facts, detect, apply at most one repair, audit.
   * Read-only when the run is healthy. Never creates or sends anything.
   */
  async reconcileRun(
    tenantId: string,
    userId: string | null,
    runId: string,
  ): Promise<ReconcileResult> {
    const facts = await this.gatherFacts(tenantId, runId);
    const findings = detectRecovery({ ...facts, nowMs: Date.now() });
    const repair = repairFor(findings, facts.run.reconcileAttempts);
    const escalate = needsHuman(findings, facts.run.reconcileAttempts);

    let applied: { to: string; reason: string } | null = null;
    if (repair?.transition) {
      const to = repair.transition.to;
      try {
        await this.runs.transition(tenantId, userId, runId, {
          to,
          // The reason rides on waitingReason for a park and on error for a
          // failure state, so the user always reads WHY, never a bare state.
          ...(to === 'waiting_for_input' ? { waitingReason: repair.transition.reason } : {}),
          ...(to === 'failed_recoverable' || to === 'failed_terminal'
            ? { error: repair.transition.reason }
            : {}),
          findings: {
            reconciliation: {
              at: new Date().toISOString(),
              code: repair.code,
              detail: repair.detail,
              appliedTransition: to,
            },
          },
        } as TransitionRunDto);
        applied = { to, reason: repair.transition.reason };
      } catch (err) {
        // A concurrent transition won (409 from the CAS) — that is a healthy
        // outcome, not a reconciler failure: the run moved on its own.
        this.logger.warn(
          `reconcile ${runId}: ${repair.code} -> ${to} lost the race (${(err as Error).message})`,
        );
      }
    }

    // Stamp the reconcile bookkeeping + audit, even on a clean pass (so "when did
    // we last check this?" is answerable).
    await this.stampReconciled(tenantId, userId, runId, findings, applied, escalate);

    return { runId, findings, applied, needsHuman: escalate };
  }

  /**
   * Operator resolution for the one case reconciliation cannot decide: a surviving
   * write-ahead reservation. The operator has checked Workspace/Outreach and tells
   * us which it is.
   *
   *  - adopt(ref): the artifact DOES exist upstream — retire the sentinel and
   *    commit the real back-link, then let the next reconcile advance the run.
   *  - release(): nothing was created — drop the sentinel so a retry can stage
   *    cleanly.
   *
   * This is deliberately a HUMAN-authorised endpoint: both branches are
   * unrecoverable-if-wrong (adopt links a wrong document; release permits a
   * duplicate), which is exactly why the reconciler will not guess.
   */
  async resolveReservation(
    tenantId: string,
    userId: string,
    runId: string,
    input: { action: 'adopt' | 'release'; artifactRef?: string },
  ) {
    if (input.action === 'adopt' && !isRealRef(input.artifactRef)) {
      throw new BadRequestException(
        'adopt requires the real upstream artifact id (and it may not be the staging sentinel)',
      );
    }
    const facts = await this.gatherFacts(tenantId, runId);
    if (!facts.execution) {
      throw new BadRequestException('run has no execution intent — nothing to reconcile');
    }
    const artifactType =
      facts.execution.kind === 'outreach' ? 'outreach_record' : 'workspace_draft';
    const reservation = facts.artifacts.find(
      (a) => a.artifactType === artifactType && isPendingRef(a.artifactRef),
    );
    if (!reservation) {
      throw new BadRequestException('this run has no outstanding staging reservation to resolve');
    }
    const nodeId = facts.execution.nodeId;

    return this.prisma.withTenantUser(tenantId, userId, async (tx) => {
      // Drop the sentinel either way (CAS on the sentinel ref so a concurrent
      // resolve/recordArtifact cannot be clobbered).
      const dropped = await tx.spNodeArtifact.deleteMany({
        where: { nodeId, artifactType, artifactRef: PENDING_ARTIFACT_REF },
      });
      if (dropped.count === 0) {
        throw new BadRequestException(
          'the staging reservation was already resolved — reload the run',
        );
      }
      if (input.action === 'adopt') {
        await tx.spNodeArtifact.upsert({
          where: {
            nodeId_artifactType_artifactRef: {
              nodeId,
              artifactType: artifactType as never,
              artifactRef: input.artifactRef!,
            },
          },
          // The query hook scopes upsert.where but NOT the create branch — set
          // every scalar explicitly (prisma.service RLS note).
          create: {
            tenantId,
            strategyId: facts.strategyId!,
            nodeId,
            artifactType: artifactType as never,
            artifactRef: input.artifactRef!,
            createdByUserId: userId,
          },
          update: {},
        });
      }
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: 'person',
        action: 'run.reservation_resolved',
        entityType: 'run',
        entityId: runId,
        strategyId: facts.strategyId ?? undefined,
        after: {
          action: input.action,
          nodeId,
          artifactType,
          ...(input.action === 'adopt' ? { artifactRef: input.artifactRef } : {}),
        },
      });
      return { runId, action: input.action, nodeId, artifactType };
    });
  }

  /**
   * Cross-run detection the per-run rules cannot see: the SAME upstream artifact
   * id linked from more than one node (the audit's "duplicate external
   * references"). Report-only — deciding which link is the real one needs a human.
   */
  async listDuplicateArtifactRefs(tenantId: string, strategyId?: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.spNodeArtifact.findMany({
        where: {
          ...(strategyId ? { strategyId } : {}),
          artifactRef: { not: PENDING_ARTIFACT_REF },
        },
        select: {
          artifactRef: true,
          artifactType: true,
          nodeId: true,
          strategyId: true,
          detachedAt: true,
        },
        take: 2000,
      });
      const byRef = new Map<string, typeof rows>();
      for (const r of rows) {
        const key = `${r.artifactType}:${r.artifactRef}`;
        const list = byRef.get(key) ?? [];
        list.push(r);
        byRef.set(key, list);
      }
      return [...byRef.entries()]
        .filter(([, list]) => new Set(list.map((r) => r.nodeId)).size > 1)
        .map(([key, list]) => ({
          key,
          artifactType: list[0]!.artifactType,
          artifactRef: list[0]!.artifactRef,
          nodeIds: [...new Set(list.map((r) => r.nodeId))],
          // A detached duplicate is expected after a P0-1 restore revived one of
          // two competing links; flag which side is historical.
          attachedCount: list.filter((r) => r.detachedAt == null).length,
        }));
    });
  }

  // ---- fact gathering --------------------------------------------------------

  private async gatherFacts(tenantId: string, runId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const run = await tx.spAgentRun.findFirst({ where: { id: runId } });
      if (!run) throw new NotFoundException('Run not found');

      const execution = readExecutionMeta(run.findings);
      const hasApproval = readHasApproval(run.findings);

      let artifacts: RecoveryArtifactRow[] = [];
      let nodeLive = true;
      let nodeHasTarget = true;
      let headVersionId: string | null = null;

      if (execution) {
        artifacts = await tx.spNodeArtifact.findMany({
          where: { nodeId: execution.nodeId },
          select: { artifactType: true, artifactRef: true, detachedAt: true },
        });
        // P0-1: LIVE_NODE_WHERE — a node archived by a restore is NOT live, which
        // is itself a recovery finding (NODE_NOT_LIVE).
        const node = await tx.spNode.findFirst({
          where: { id: execution.nodeId, ...LIVE_NODE_WHERE },
          select: { id: true, targetRef: true },
        });
        nodeLive = !!node;
        nodeHasTarget = !!node?.targetRef;
        if (run.strategyId) {
          const head = await tx.spVersion.findFirst({
            where: { strategyId: run.strategyId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { id: true },
          });
          headVersionId = head?.id ?? null;
        }
      }

      return {
        run: {
          id: run.id,
          state: run.state as string,
          heartbeatAt: run.heartbeatAt,
          startedAt: run.startedAt,
          createdAt: run.createdAt,
          reconcileAttempts: run.reconcileAttempts,
        },
        strategyId: run.strategyId,
        execution,
        hasApproval,
        artifacts,
        headVersionId,
        nodeLive,
        nodeHasTarget,
      };
    });
  }

  private async stampReconciled(
    tenantId: string,
    userId: string | null,
    runId: string,
    findings: RecoveryFinding[],
    applied: { to: string; reason: string } | null,
    escalate: boolean,
  ): Promise<void> {
    const run = (fn: (tx: Prisma.TransactionClient) => Promise<void>) =>
      userId
        ? this.prisma.withTenantUser(tenantId, userId, fn)
        : this.prisma.withTenant(tenantId, fn);
    await run(async (tx) => {
      await tx.spAgentRun.updateMany({
        where: { id: runId },
        data: {
          reconciledAt: new Date(),
          // Only count an attempt that actually DID something — a clean pass must
          // not burn the budget that protects a broken run from being swept
          // forever.
          ...(applied ? { reconcileAttempts: { increment: 1 } } : {}),
        },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: userId ? 'person' : 'meri',
        action: 'run.reconciled',
        entityType: 'run',
        entityId: runId,
        after: {
          codes: findings.map((f) => f.code),
          applied: applied?.to ?? null,
          needsHuman: escalate,
        },
      });
    });
  }
}

/** Parse findings.execution (the Execution-Agent intent) defensively. */
function readExecutionMeta(
  findings: unknown,
): { kind: string; nodeId: string; pinnedVersionId: string | null } | null {
  if (!findings || typeof findings !== 'object' || Array.isArray(findings)) return null;
  const exec = (findings as Record<string, unknown>).execution;
  if (!exec || typeof exec !== 'object' || Array.isArray(exec)) return null;
  const e = exec as Record<string, unknown>;
  if (typeof e.kind !== 'string' || typeof e.nodeId !== 'string') return null;
  return {
    kind: e.kind,
    nodeId: e.nodeId,
    pinnedVersionId: typeof e.pinnedVersionId === 'string' ? e.pinnedVersionId : null,
  };
}

/** True when the run carries a send-approval record on its findings. */
function readHasApproval(findings: unknown): boolean {
  if (!findings || typeof findings !== 'object' || Array.isArray(findings)) return false;
  const sa = (findings as Record<string, unknown>).sendApproval;
  return !!sa && typeof sa === 'object' && !Array.isArray(sa);
}

/** Exported for the spec: which states the sweep looks at. */
export const RECONCILER_SWEEPABLE_STATES: readonly string[] = SWEEPABLE_STATES.filter(
  (s) => !RUN_TERMINAL_STATES.has(s),
);
