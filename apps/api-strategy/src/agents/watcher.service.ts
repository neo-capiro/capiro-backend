import { createHash } from 'node:crypto';
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
import { StewardService } from '../context/steward.service.js';
import { AGENTIC_FLAGS, StrategyFlagsService } from '../flags/strategy-flags.service.js';
import { RunsService } from './runs.service.js';
import { ChangeSetsService } from './change-sets.service.js';
import { classifyRisk } from './risk-router.js';
import { stampRunMetrics, type RunMetricsInput } from './run-metrics.js';
import {
  findingKey,
  runWatcherChecks,
  type Finding,
  type WatcherNode,
} from './watcher-checks.js';
import type {
  CreateChangeSetDto,
  CreateRunDto,
  RunTriggerValue,
  TransitionRunDto,
} from './dto/agents.dto.js';

/**
 * Stage F1: the Strategy Watcher's manual, SUGGEST-ONLY check core. ZERO LLM:
 * the whole run is deterministic — load state, run the shared verifier
 * (consumer 4) + the pure watcher-checks, persist findings, propose (never
 * apply) change-sets. The plan's bounded LLM interpretation pass for
 * context-comparison findings is a DEFERRED SEAM: when it lands it slots in
 * between runWatcherChecks and proposeChangeSets as an annotate-only step —
 * nothing here may start depending on it.
 *
 * A check run has NO external execution phase, so it goes
 * queued -> planning -> ready_for_review directly (run-state.ts documents the
 * planning->ready_for_review edge as the Stage F check-run shape).
 *
 * MEETING-COMPLETION SEAM (deferred with the meetings association): a
 * completed-meeting trigger would arrive via the F2 outbox consumer
 * (WATCH_TRIGGERING_TYPES) and land here as a normal scheduled check — no
 * watcher code change is expected beyond the outbox type allowlist.
 */
@Injectable()
export class WatcherService {
  private readonly logger = new Logger(WatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly versioning: VersioningService,
    private readonly flags: StrategyFlagsService,
    private readonly runs: RunsService,
    private readonly changeSets: ChangeSetsService,
    private readonly meri: MeriService,
    private readonly steward: StewardService,
  ) {}

  /**
   * Run one watcher check for a mission, now. `userId` null = scheduler/system
   * (F2) — writes run under withTenant and activity is attributed meri.
   *
   * The run-ledger trigger label: an explicit `opts.trigger` wins (the F2
   * scheduler passes 'scheduled'); the fallback follows the caller shape —
   * userId set => 'manual' (the controller path), userId null => 'scheduled'
   * — so automated runs never read as human-initiated.
   *
   * Idempotency: `watch:<missionId>:<today>` by default, so a same-day
   * re-trigger REFRESHES the existing run's findings instead of minting a new
   * run — and (the acceptance criterion) NEVER duplicates an open change-set:
   * proposals are deduped against open (proposed/approved) change-sets STILL
   * PINNED TO THE CURRENT HEAD by the `[watch:<code>:<sortedNodeIds>]` marker
   * each proposal summary carries (see proposeChangeSets for the zombie rule).
   */
  async runCheckNow(
    tenantId: string,
    userId: string | null,
    missionId: string,
    opts: { idempotencyKey?: string; trigger?: RunTriggerValue } = {},
  ): Promise<{ runId: string; findings: Finding[]; changeSetsProposed: string[] }> {
    // Per-tenant gate, re-checked HERE (not only in the controller guard):
    // the F2 scheduler calls this directly with no HTTP guard in the path.
    // Fail-closed, before any run row is minted.
    const enabled = await this.flags.isAgenticFlagEnabled(tenantId, AGENTIC_FLAGS.strategyWatcher);
    if (!enabled) {
      throw new ForbiddenException('The Strategy Watcher is not enabled for this tenant');
    }

    const mission = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spAgentMission.findFirst({ where: { id: missionId } }),
    );
    if (!mission) throw new NotFoundException('Mission not found');
    // Firm-level missions (strategyId null) are the F2 calendar path — a
    // documented SEAM, not a watcher check: they compare reference calendars
    // across strategies and propose firm-scoped change-sets (RiskRouter
    // firmLevel=true). runCheckNow is strategy-scoped by contract.
    if (!mission.strategyId) {
      throw new BadRequestException(
        'mission has no strategyId — firm-level calendar missions are handled by the F2 scheduler path, not run-check',
      );
    }
    const strategyId = mission.strategyId;
    // (mission.state is enforced by RunsService.createRun under FOR UPDATE —
    // rechecking here would just be a racy pre-read.)

    const today = isoDate(new Date())!;
    const idempotencyKey = opts.idempotencyKey ?? `watch:${missionId}:${today}`;
    // createRun enforces mission-active + (tenantId, idempotencyKey) dedup: a
    // replayed key returns the EXISTING run unchanged. Trigger: an explicit
    // opts.trigger wins; the fallback follows the caller shape (userId null =
    // F2 scheduler/system => 'scheduled').
    const trigger: RunTriggerValue = opts.trigger ?? (userId ? 'manual' : 'scheduled');
    const run = await this.runs.createRun(tenantId, userId, missionId, {
      trigger,
      idempotencyKey,
    } as CreateRunDto);

    // Replay routing: a fresh run is 'queued'; a same-key run that already
    // finished review-ready gets its findings REFRESHED in place; a run a
    // crashed invocation stranded in 'planning' is resumed. Anything else
    // (terminal / waiting / executing) cannot be re-driven — demand a new key.
    const refresh = run.state === 'ready_for_review';
    if (!refresh && run.state !== 'queued' && run.state !== 'planning') {
      throw new ConflictException(
        `run for '${idempotencyKey}' is already ${run.state} — pass a fresh idempotencyKey to re-check`,
      );
    }
    if (run.state === 'queued') {
      await this.runs.transition(tenantId, userId, run.id, { to: 'planning' } as TransitionRunDto);
    }

    const phaseStart = Date.now();
    this.logger.log(
      `[run:${run.id} mission:${missionId}] watcher check start (strategy:${strategyId})`,
    );
    try {
      const { findings, changeSetsProposed } = await this.executeCheck(
        tenantId,
        userId,
        run.id,
        strategyId,
        today,
      );

      // Persist findings on the run. Fresh path: planning -> ready_for_review
      // (a check run has no executing phase — nothing external ran). Replay
      // path: no legal self-transition, so merge findings in place (guarded on
      // the state we validated) and audit the recheck.
      const payload: Record<string, unknown> = { checkedOn: today, findings };
      if (refresh) {
        await this.refreshFindings(tenantId, userId, run.id, payload);
      } else {
        await this.runs.transition(tenantId, userId, run.id, {
          to: 'ready_for_review',
          findings: payload,
        } as TransitionRunDto);
      }

      // 'A no-change run creates no noise': zero findings still lands
      // ready_for_review with findings:[] (the run row IS the record), plus one
      // quiet watch.noop audit row — no change-set, no notification of any kind.
      if (findings.length === 0) {
        await this.logWatch(tenantId, userId, 'watch.noop', run.id, {
          strategyId,
          checkedOn: today,
        });
      }
      await this.stampMetrics(tenantId, userId, run.id, {
        phase: 'check',
        latencyMs: Date.now() - phaseStart,
      });
      this.logger.log(
        `[run:${run.id} mission:${missionId}] watcher check done` +
          ` (${findings.length} finding(s), ${changeSetsProposed.length} proposed)`,
      );
      return { runId: run.id, findings, changeSetsProposed };
    } catch (err) {
      // Best-effort: never leave a run we were driving stranded in planning.
      // (A refresh error leaves the already-reviewable run untouched.)
      if (!refresh) await this.failRun(tenantId, userId, run.id, err);
      throw err;
    }
  }

  // ---- the deterministic check pass ----------------------------------------

  private async executeCheck(
    tenantId: string,
    userId: string | null,
    runId: string,
    strategyId: string,
    today: string,
  ): Promise<{ findings: Finding[]; changeSetsProposed: string[] }> {
    // Grounding BEFORE anything else (house rule from ChangeSetsService.apply:
    // grounding reads open their own withTenant txs — never nest them).
    const ground = await this.meri.grounding(tenantId);
    const strategy = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spStrategy.findFirst({
        where: { id: strategyId },
        include: {
          // P0-1: LIVE plan only — a node archived by a restore must never
          // produce watcher findings or verifier violations.
          nodes: { where: { ...LIVE_NODE_WHERE }, orderBy: [{ startsOn: 'asc' }, { createdAt: 'asc' }] },
          artifacts: true,
        },
      }),
    );
    if (!strategy) {
      throw new NotFoundException('Mission strategy not found for this tenant');
    }
    const stewardHealth = await this.steward.health(tenantId, strategy.clientId);

    const nodes: WatcherNode[] = strategy.nodes.map((n) => ({
      id: n.id,
      kind: String(n.kind),
      subject: String(n.subject),
      title: n.title,
      startsOn: isoDate(n.startsOn) ?? '',
      endsOn: isoDate(n.endsOn),
      status: String(n.status),
      ownerUserId: n.ownerUserId,
      dependsOnIds: n.dependsOnIds,
      provenance: n.provenance,
    }));

    // Consumer 4 of the SHARED @capiro/strategy-verifier (same package the
    // orchestrator repair loop, the write gate and change-set apply run) —
    // advisory here: violations FOLD into findings, they never block or 422.
    const verifierViolations = this.verify(String(strategy.type), nodes, ground);

    const findings = runWatcherChecks({
      strategy: { id: strategy.id, type: String(strategy.type), title: strategy.title },
      nodes,
      today,
      congress: ground.reference.congress,
      stewardHealth,
      verifierViolations,
      artifactMismatches: computeArtifactMismatches(nodes, strategy.artifacts),
    });

    const changeSetsProposed = await this.proposeChangeSets(
      tenantId,
      userId,
      runId,
      strategyId,
      findings,
    );
    return { findings, changeSetsProposed };
  }

  /** Same node mapping + verifyPlan input MeriService.verify builds. */
  private verify(strategyType: string, nodes: WatcherNode[], ground: Grounding): Violation[] {
    const vnodes: VerifierNode[] = nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      subject: n.subject,
      title: n.title,
      startsOn: n.startsOn,
      endsOn: n.endsOn,
      dependsOnIds: n.dependsOnIds,
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

  /**
   * One sp_change_set per actionable finding (a finding's proposedOps are one
   * logical proposal group), created via the SAME ChangeSetsService.create the
   * controller uses (head pin + seal + audit). Risk comes from the F2
   * RiskRouter (`opts.risk` overrides the DTO — the symbolic classification,
   * never self-assessed).
   *
   * DEDUP (the acceptance criterion): before creating, list this strategy's
   * OPEN (proposed/approved) change-sets and SKIP any proposal whose
   * (code + sorted nodeIds) marker — `[watch:<code>:<ids>]`, embedded at the
   * head of every watcher proposal summary — is already open. Re-running a
   * check refreshes the run's findings but never duplicates a change-set;
   * once a proposal is applied/rejected/stale it leaves the open set and the
   * finding (if still true) may legitimately be re-proposed.
   *
   * ZOMBIE EXCLUSION: an open proposal whose pinned strategyVersionId is no
   * longer the strategy's CURRENT head can never apply — ChangeSetsService
   * .apply's head guard 409-stales it — but its row only flips to 'stale'
   * when someone actually ATTEMPTS the apply. If such a zombie kept its
   * marker in the dedup set, a still-true finding would sit for weeks with no
   * applicable proposal. So only open proposals still pinned to the current
   * head block re-proposal; a superseded one stops counting (it is left for
   * the existing human reject / apply-409-stale paths to clean up).
   *
   * DATE-STALENESS REFRESH: dedup alone would FREEZE a marker-matched open
   * proposal's ops at their proposal-day values. checkOverdue anchors its
   * retime to the RUN-day clock ("restart tomorrow"), so a proposal that sits
   * open for days drifts into the past — and with the head unmoved the stale
   * guard would happily apply that already-past window, which the next run
   * re-flags overdue: an approve/apply/re-propose loop that never converges.
   * So a marker hit on a still-'proposed' row whose freshly recomputed ops
   * differ REWRITES that row's ops/summary in place
   * (ChangeSetsService.refreshProposedOps — status-CAS'd and head-guarded).
   * 'approved' rows are IMMUTABLE — the human approved those exact ops; worst
   * case a late apply lands past dates once and the next run re-proposes fresh
   * ones (the applied row left the open set).
   *
   * CONCURRENCY: the dedup read and the creates share ONE transaction opened
   * under SELECT ... FOR UPDATE on the strategy row. A manual run-check
   * (watch:<missionId>:<date>) and a scheduler occurrence
   * (sched:<missionId>:<bucket>) hold DISTINCT idempotency keys — they are
   * different runs, so the run-level dedup never coalesces them and both can
   * reach this method at once. See the body comment for the race and the lock
   * discipline.
   */
  private async proposeChangeSets(
    tenantId: string,
    userId: string | null,
    runId: string,
    strategyId: string,
    findings: Finding[],
  ): Promise<string[]> {
    const actionable = findings.filter(
      (f) => Array.isArray(f.proposedOps) && f.proposedOps.length > 0,
    );
    if (actionable.length === 0) return [];

    // ONE tx for the dedup read AND the creates, serialized per strategy by
    // SELECT ... FOR UPDATE on the strategy row (the same lock + raw-SQL shape
    // as ChangeSetsService.apply — raw SQL bypasses both the tenant-scope
    // injection and RLS (capiro_app), hence the explicit tenant_id predicate).
    // Without it the dedup is read-then-create: two concurrent runs' findMany
    // reads (READ COMMITTED) each miss the other's uncommitted row and BOTH
    // create — duplicating the change-set the F1 acceptance says must never
    // duplicate. The loser blocks on the row lock until the winner commits;
    // its findMany (fresh statement snapshot) then sees the winner's proposals
    // and skips. Lock ORDER stays change-set -> strategy everywhere: we take
    // ONLY the strategy lock and never touch an existing change-set row after
    // it (inserts only), so propose cannot deadlock with apply. Deliberate
    // side effect: a mid-batch create failure rolls the WHOLE batch back —
    // a run's proposals land atomically instead of leaving a partial set.
    const { ids, refreshes } = await this.inTx(tenantId, userId, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM sp_strategy
        WHERE id = ${strategyId}::uuid AND tenant_id = ${tenantId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) {
        throw new NotFoundException('Mission strategy not found for this tenant');
      }

      // Same head total order ChangeSetsService.headOf pins (and apply's stale
      // guard checks) against: createdAt desc, id desc.
      const head = await tx.spVersion.findFirst({
        where: { strategyId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      const headId = head?.id ?? null;
      const open = await tx.spChangeSet.findMany({
        where: { strategyId, status: { in: ['proposed', 'approved'] } },
        select: { id: true, status: true, summary: true, ops: true, strategyVersionId: true },
      });
      // Zombie exclusion (see doc comment): only proposals still pinned to
      // the current head can apply, so only those block re-proposal. The row
      // is kept (not just its marker) so a marker hit can compare ops for the
      // date-staleness refresh.
      const openByMarker = new Map<string, { id: string; status: string; ops: unknown }>();
      for (const r of open) {
        if (r.strategyVersionId !== headId) continue;
        const m = parseWatchMarker(r.summary);
        if (m) openByMarker.set(m, { id: r.id, status: String(r.status), ops: r.ops });
      }

      const ids: string[] = [];
      // Date-staleness refreshes (see doc comment) are COLLECTED here but
      // EXECUTED AFTER this tx commits: refreshProposedOps rewrites an
      // EXISTING sp_change_set row, and doing that while holding the strategy
      // lock would invert apply's change-set -> strategy lock order
      // (deadlock). Post-commit is safe — refreshProposedOps re-verifies
      // status ('proposed', CAS) and the pinned head in its own tx.
      const refreshes: Array<{ id: string; summary: string; ops: unknown[] }> = [];
      for (const f of actionable) {
        const marker = watchMarker(f);
        const ops = f.proposedOps!;
        const existing = openByMarker.get(marker);
        if (existing) {
          // Still open for the same (code + nodes) — never a duplicate. But if
          // this run recomputed DIFFERENT ops (checkOverdue's retime drifts one
          // day per day the proposal sits open), rewrite the still-'proposed'
          // row in place so a late apply never retimes into the past.
          // stableJson: jsonb does not preserve key order, so compare
          // key-order-independently or every same-day re-run would "differ".
          if (existing.status === 'proposed' && stableJson(existing.ops) !== stableJson(ops)) {
            refreshes.push({
              id: existing.id,
              summary: `${marker} ${f.message}`.slice(0, 500),
              ops: ops as unknown[],
            });
          }
          continue;
        }
        // Also dedups within this batch (findingKey dedup makes an in-batch
        // marker collision near-impossible; the sentinel keeps it harmless).
        openByMarker.set(marker, { id: '', status: 'proposed', ops });

        const { risk } = classifyRisk({
          findings: [
            {
              code: f.code,
              severity: f.severity,
              message: f.message,
              nodeIds: f.nodeIds,
              structural: ops.some((o) => o.op === 'add' || o.op === 'remove'),
            },
          ],
          firmLevel: false, // runCheckNow is strategy-scoped by contract (see above)
          opCount: ops.length,
        });
        const cs = (await this.changeSets.create(
          tenantId,
          userId,
          {
            strategyId,
            runId,
            summary: `${marker} ${f.message}`.slice(0, 500),
            ops: ops as unknown[],
            risk,
          } as CreateChangeSetDto,
          // JOIN this tx: the dedup read and the create must commit together
          // under the strategy-row lock, or the dedup races (see above).
          { risk, tx },
        )) as { id: string };
        ids.push(cs.id);
      }
      return { ids, refreshes };
    });

    for (const r of refreshes) {
      await this.changeSets.refreshProposedOps(tenantId, userId, r.id, {
        summary: r.summary,
        ops: r.ops,
      });
    }
    return ids;
  }

  // ---- artifact back-link mismatches (check-h seam input) -------------------

  // (computed here, folded by the pure module — see computeArtifactMismatches)

  // ---- persistence helpers ---------------------------------------------------

  /**
   * Replay path: the same-day run is already ready_for_review (no legal
   * self-transition), so shallow-merge the fresh findings onto the run in a
   * state-guarded update (CAS on ready_for_review — a concurrent
   * complete/cancel makes the predicate miss and we 409 instead of resurrecting
   * a reviewed run) and audit the recheck.
   */
  private async refreshFindings(
    tenantId: string,
    userId: string | null,
    runId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.inTx(tenantId, userId, async (tx) => {
      const run = await tx.spAgentRun.findFirst({ where: { id: runId } });
      if (!run) throw new NotFoundException('Run not found');
      const prev =
        run.findings && typeof run.findings === 'object' && !Array.isArray(run.findings)
          ? (run.findings as Record<string, unknown>)
          : {};
      const cas = await tx.spAgentRun.updateMany({
        where: { id: runId, state: 'ready_for_review' },
        data: { findings: { ...prev, ...payload } as Prisma.InputJsonValue },
      });
      if (cas.count === 0) {
        throw new ConflictException(
          'Run state changed concurrently — re-check with a fresh idempotencyKey',
        );
      }
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: userId ? 'person' : 'meri',
        action: 'watch.rechecked',
        entityType: 'run',
        entityId: runId,
        after: { findingCount: (payload.findings as unknown[]).length },
      });
    });
  }

  /** Audit-only watcher event (e.g. watch.noop) in its own small tx. */
  private async logWatch(
    tenantId: string,
    userId: string | null,
    action: string,
    runId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.inTx(tenantId, userId, (tx) =>
      this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: userId ? 'person' : 'meri',
        action,
        entityType: 'run',
        entityId: runId,
        after,
      }),
    );
  }

  /**
   * Best-effort: fail the run we were driving; the original error still throws.
   *
   * P0-2: `failed_terminal`, not the legacy `failed`. A watcher check is
   * suggest-only and its mission mints a brand-NEW run on the next cadence tick,
   * so this attempt is genuinely over — there is nothing for the run reconciler to
   * recover here, and marking it `failed_recoverable` would park a dead check run
   * in the recovery sweep forever.
   */
  private async failRun(
    tenantId: string,
    userId: string | null,
    runId: string,
    err: unknown,
  ): Promise<void> {
    try {
      await this.runs.transition(tenantId, userId, runId, {
        to: 'failed_terminal',
        error: String((err as Error)?.message ?? err).slice(0, 4000),
      } as TransitionRunDto);
    } catch {
      // The primary error is what the caller needs to see.
    }
  }

  private inTx<T>(
    tenantId: string,
    userId: string | null,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return userId
      ? this.prisma.withTenantUser(tenantId, userId, fn)
      : this.prisma.withTenant(tenantId, fn);
  }

  /**
   * Merge run metrics (phase / latency; model+prompt are seams for the
   * deterministic check pass) onto run.findings ADDITIVELY — stampRunMetrics
   * preserves checkedOn/findings/riskClassification. BEST-EFFORT: an
   * observability write must never fail a check, so a throw is logged and
   * swallowed, and it is NOT audited (a silent annotation, not a domain
   * mutation). ai_usage agent_run_id linkage is a documented cross-app seam
   * (see run-metrics.ts).
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

/**
 * The dedup marker a watcher proposal summary starts with. BOUNDED: summaries
 * are hard-capped at 500 chars (CreateChangeSetDto @MaxLength), and a marker
 * whose closing ']' fell to that slice would be invisible to parseWatchMarker
 * — the open-set dedup would then fail FOREVER for that finding (one duplicate
 * proposal per run). A dependency-slippage finding can carry a dozen+ node
 * uuids (13 ids ≈ 508 chars of marker alone), so when the plain
 * `[watch:<code>:<sorted ids>]` form runs long, the id list collapses to a
 * stable digest of the same sorted ids. Both the fresh marker and the one
 * parsed back out of a stored summary go through THIS function's output, so
 * dedup equality is preserved — the digest just has to be deterministic.
 */
const WATCH_MARKER_MAX = 200; // leaves ≥299 chars of human-readable message in the 500 budget

function watchMarker(f: Pick<Finding, 'code' | 'nodeIds'>): string {
  const plain = `[watch:${findingKey(f)}]`;
  if (plain.length <= WATCH_MARKER_MAX) return plain;
  const digest = createHash('sha256')
    .update([...f.nodeIds].sort().join('+'))
    .digest('hex')
    .slice(0, 16);
  return `[watch:${f.code}:ids#${digest}]`;
}

const WATCH_MARKER_RE = /^\[watch:[^\]]+\]/;

function parseWatchMarker(summary: string): string | null {
  return WATCH_MARKER_RE.exec(summary)?.[0] ?? null;
}

/**
 * Key-order-independent JSON identity for the date-staleness ops comparison:
 * Postgres jsonb does NOT preserve object key order, so a stored op and its
 * freshly recomputed twin must not read as "different" on ordering alone.
 */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.keys(val as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((acc, key) => {
            acc[key] = (val as Record<string, unknown>)[key];
            return acc;
          }, {})
      : val,
  );
}

/**
 * Check-h input (the pure module's documented SEAM): sp_node_artifact rows are
 * back-links into OTHER services (ws_draft / outreach_records) which we cannot
 * cross-service-verify cheaply from here, so "mismatch" is defined
 * CONSERVATIVELY as facts this schema alone can prove:
 *   - ORPHAN: the artifact row's node is no longer in the plan (the FK cascade
 *     makes this near-impossible, but a row observed mid-delete stays covered);
 *   - REGRESSION: the node has produced work (an artifact exists) yet its
 *     status moved back to a pre-work state (draft/suggested) — the link and
 *     the plan disagree about whether the step ever ran.
 * Anything requiring a live workspace/outreach lookup (deleted draft, retracted
 * outreach) is deliberately out of scope until a cheap cross-service check
 * exists — extend HERE, not in watcher-checks.ts.
 */
export function computeArtifactMismatches(
  nodes: Array<{ id: string; status: string }>,
  artifacts: Array<{ nodeId: string }>,
): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const mismatched = new Set<string>();
  for (const a of artifacts) {
    const node = byId.get(a.nodeId);
    if (!node || node.status === 'draft' || node.status === 'suggested') {
      mismatched.add(a.nodeId);
    }
  }
  return [...mismatched];
}
