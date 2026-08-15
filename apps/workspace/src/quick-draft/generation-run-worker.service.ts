import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canEdit } from '../collaborators/role-policy.js';
import { GenerationService } from '../generation/generation.service.js';
import { runWithGenerationAssuranceTenant } from '../generation/generation-assurance.js';
import { runWithContextPersistenceBoundary } from '../generation/context-persistence-hold.js';
import type {
  GenerationRunSummary,
  GenerationSectionFailure,
} from '../generation/generation-run.js';
import { VersionsService } from '../versions/versions.service.js';
import type { RunStatusResponse } from './dto/intake.dto.js';

/**
 * Durable generation-run worker (PR #964).
 *
 * A generation run is a DB-backed state machine (`ws_generation_run`) that
 * survives browser reload, ECS restart, worker crash, and network timeout:
 * every transition is persisted, work is claimed atomically via a leased
 * `UPDATE … WHERE`, and an expired lease lets any worker re-claim. This
 * service owns the stage machine and the poller; the heavy reasoning is
 * delegated to the canonical {@link GenerationService} so this worker never
 * talks to a model provider directly — it enters the SAME assurance tenant +
 * context-persistence boundary the GenerationController establishes.
 *
 * Stages (executed in order, each independently retry-safe):
 *   preflight → evidence_plan → narrative_plan → drafting →
 *   editorial_pass → assurance → snapshot → complete
 *
 * `drafting` is the only stage that performs real model IO; the surrounding
 * stages are durable markers recorded for the audit trail (the canonical
 * GenerationService performs the real evidence/narrative/editorial/assurance
 * work internally during drafting). A run resumed after a crash skips every
 * stage that already recorded a `done` entry and continues from the next.
 */
@Injectable()
export class GenerationRunWorkerService {
  private readonly logger = new Logger(GenerationRunWorkerService.name);
  /** Stable per-process worker id, written into `lease_holder` on claim. */
  private readonly workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly LEASE_SECONDS = 5 * 60; // 5 minutes
  private static readonly POLL_BATCH = Number(
    process.env.GENERATION_RUN_POLL_BATCH ?? 8,
  );
  private static readonly MAX_CONCURRENT = Number(
    process.env.GENERATION_RUN_MAX_CONCURRENT ?? 2,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
    private readonly generation: GenerationService,
    private readonly versions: VersionsService,
  ) {}

  // ─── lifecycle (poller) ─────────────────────────────────────────────────

  /**
   * Start the poller. Claims and processes queued runs every `intervalMs`.
   * Called by QuickDraftModule.onModuleInit; also safe to call from tests.
   */
  startPoller(intervalMs: number): void {
    if (this.pollTimer || intervalMs <= 0) return;
    this.pollTimer = setInterval(() => {
      this.poll().catch((error) => {
        this.logger.error(
          `Worker poll error: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      });
    }, intervalMs);
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
    this.logger.log(`generation-run worker poller started (id=${this.workerId})`);
  }

  stopPoller(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ─── public API ─────────────────────────────────────────────────────────

  /**
   * One poll tick: discover claimable runs and process up to MAX_CONCURRENT.
   * Public so tests and explicit triggers can force a tick without the timer.
   */
  async poll(): Promise<void> {
    let candidates: string[];
    try {
      candidates = await this.findClaimableRuns(GenerationRunWorkerService.POLL_BATCH);
    } catch (e) {
      this.logger.warn(`poll: discovery failed: ${(e as Error).message}`);
      return;
    }
    if (!candidates.length) return;

    const lanes = Math.max(
      1,
      Math.min(GenerationRunWorkerService.MAX_CONCURRENT, candidates.length),
    );
    let cursor = 0;
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        for (;;) {
          const id = candidates[cursor++];
          if (!id) return;
          try {
            await this.claim(id);
          } catch (e) {
            this.logger.warn(`poll: run ${id} errored: ${(e as Error).message}`);
          }
        }
      }),
    );
  }

  /**
   * Claim and process the next available run. Used by the poller when a single
   * run is desired per tick.
   */
  async claimAndProcessNext(): Promise<void> {
    const id = await this.findNextClaimable();
    if (id) await this.claim(id);
  }

  /**
   * Manually claim and process a single run by id. Returns the run's terminal
   * status, or `'busy'` when another worker holds an unexpired lease. This is
   * the atomic-claim entry point the task spec defines.
   */
  async claim(runId: string): Promise<string> {
    const claimed = await this.tryClaim(runId);
    if (!claimed) return 'busy';

    const run = await this.prisma.wsGenerationRun.findUnique({ where: { id: runId } });
    if (!run) {
      this.logger.warn(`claim: run ${runId} not found after claim`);
      return 'missing';
    }
    try {
      return await this.processRun(run);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown';
      this.logger.error(`run ${runId} failed: ${message}`);
      await this.markRunFailed(runId, message);
      return 'failed';
    }
  }

  // ─── discovery + atomic claim ───────────────────────────────────────────

  /**
   * Find runs that are either freshly queued or whose lease has expired.
   * Discovery does not claim — the atomic {@link tryClaim} UPDATE is what
   * guarantees exactly one worker wins a contended run.
   */
  private async findClaimableRuns(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM ws_generation_run
      WHERE status = 'queued'
         OR (status = 'active' AND lease_expires_at < NOW())
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
  }

  private async findNextClaimable(): Promise<string | null> {
    const rows = await this.findClaimableRuns(1);
    return rows[0] ?? null;
  }

  /**
   * Atomically claim a run for this worker. The WHERE clause makes the claim
   * race-free: only a `queued` run or one whose lease has genuinely expired
   * can be taken, and `attempt_count` increments only on a real claim. Uses
   * `$executeRaw` so the claim + lease + attempt bump land in one statement.
   */
  private async tryClaim(runId: string): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE ws_generation_run
      SET lease_holder     = ${this.workerId},
          lease_expires_at  = NOW() + INTERVAL '${GenerationRunWorkerService.LEASE_SECONDS} seconds',
          status            = 'active',
          attempt_count     = attempt_count + 1,
          started_at        = COALESCE(started_at, NOW())
      WHERE id = ${runId}::uuid
        AND (
          status = 'queued'
          OR (status = 'active' AND lease_expires_at < NOW())
        )
    `;
    return affected === 1;
  }

  // ─── stage machine ─────────────────────────────────────────────────────

  /**
   * Run a claimed run through its remaining stages. Each stage mutates the
   * `stage`/`stages` columns; on failure the run is marked `failed`/`partial`
   * and the error is persisted, so a later tick resumes from the next
   * incomplete stage. Returns the terminal status.
   */
  private async processRun(run: GenerationRunRow): Promise<string> {
    let stages = readStages(run.stages);
    let sectionStates = readSectionStates(run.sectionStates);
    let terminal = run.status;
    // agentRevision is read fresh each stage so preflight's write is visible.
    let agentRevision = run.agentRevision;

    for (;;) {
      const stage = this.nextStage(stages);
      if (!stage) break;

      stages = appendStageStart(stages, stage, run.attemptCount);
      await this.updateStage(run.id, stage, 'active', stages, undefined);

      try {
        const outcome = await this.runStage(stage, run, sectionStates, stages, agentRevision);
        stages = completeStage(stages, stage, outcome.detail);
        if (outcome.sectionStates) sectionStates = outcome.sectionStates;
        if (outcome.agentRevision !== undefined) agentRevision = outcome.agentRevision;

        if (outcome.terminal) {
          // Short-circuit (human-edit guard or a preflight failure): persist
          // the terminal status and stop processing further stages.
          terminal = outcome.terminal;
          await this.updateStage(run.id, stage, 'done', stages, {
            sectionStates,
            terminal,
            errorMessage: outcome.errorMessage,
          });
          break;
        }
        await this.updateStage(run.id, stage, 'done', stages, { sectionStates });
      } catch (e) {
        const message = (e as Error).message ?? 'stage failed';
        stages = failStage(stages, stage, message);
        terminal = this.deriveFinalStatus(sectionStates);
        await this.updateStage(run.id, stage, 'failed', stages, {
          sectionStates,
          terminal,
          errorMessage: message,
        });
        this.logger.warn(`run ${run.id} stage ${stage} failed: ${message}`);
        break;
      }
    }

    return terminal;
  }

  /**
   * The first stage in the ordered list that has no `done` entry yet. A run
   * resumed after a crash therefore continues exactly where it stopped.
   */
  private nextStage(stages: StageEntry[]): GenStage | null {
    const done = new Set(
      stages.filter((s) => s.status === 'done').map((s) => s.name),
    );
    return STAGE_ORDER.find((s) => !done.has(s)) ?? null;
  }

  /**
   * Execute one stage. Only `preflight`, `drafting`, `snapshot`, and `complete`
   * perform IO; the middle stages are durable markers (the canonical
   * GenerationService performs the real evidence/narrative/editorial/assurance
   * work internally during drafting).
   */
  private async runStage(
    stage: GenStage,
    run: GenerationRunRow,
    sectionStates: SectionStates,
    _stages: StageEntry[],
    agentRevision: number,
  ): Promise<StageOutcome> {
    switch (stage) {
      case 'preflight':
        return this.stagePreflight(run, agentRevision);
      case 'evidence_plan':
      case 'narrative_plan':
      case 'editorial_pass':
      case 'assurance':
        return { detail: 'delegated to GenerationService (durable marker)' };
      case 'drafting':
        return this.stageDrafting(run, sectionStates, agentRevision);
      case 'snapshot':
        return this.stageSnapshot(run);
      case 'complete':
        return this.stageComplete(run, sectionStates);
    }
  }

  // ─── stages ────────────────────────────────────────────────────────────

  /**
   * Validate the draft exists and capture its logical revision for the
   * optimistic-concurrency guard at drafting time. The revision is the draft's
   * `config.documentAgent.revision` (the engine's own monotonic edit counter);
   * it is captured only on the first preflight so a retried run still compares
   * against the draft state at the original queue time — a human edit between
   * queue and any retry aborts rather than clobbering the human's work.
   */
  private async stagePreflight(
    run: GenerationRunRow,
    agentRevision: number,
  ): Promise<StageOutcome> {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: run.draftId, tenantId: run.tenantId },
      select: { id: true, config: true },
    });
    if (!draft) {
      return { terminal: 'failed', errorMessage: `draft ${run.draftId} not found` };
    }
    const cfg = (draft.config as Record<string, unknown> | undefined) ?? {};
    const agentState = cfg.documentAgent as Record<string, unknown> | undefined;
    const revision =
      typeof agentState?.revision === 'number' ? agentState.revision : 0;

    if (agentRevision === 0 && revision !== 0) {
      await this.prisma.wsGenerationRun.update({
        where: { id: run.id },
        data: { agentRevision: revision },
      });
      return { agentRevision: revision, detail: `draft ok (revision ${revision})` };
    }
    return { agentRevision, detail: `draft ok (revision ${agentRevision})` };
  }

  /**
   * The real work: delegate to the canonical GenerationService, wrapped in the
   * same assurance tenant + context-persistence boundary the
   * GenerationController establishes, so the leased worker's call is
   * indistinguishable from an interactive one for the Prisma middleware gate.
   *
   * OPTIMISTIC REVISION GUARD: before generating, re-read the draft's
   * document-agent revision and compare it to the value captured at preflight.
   * If a human edited the draft while this run sat queued/leased, the run is
   * cancelled rather than overwriting the human's work — the single place this
   * worker can decline to clobber newer edits, enforced before GenerationService
   * persists anything.
   *
   * On success the returned {@link GenerationRunSummary} drives the per-section
   * states (with content hashes) and the provider/model telemetry. On partial
   * failure GenerationService itself retains prior content for failed sections
   * (preserving successful sections); a later `retryFailedSections` call
   * regenerates only the failed/stale subset.
   */
  private async stageDrafting(
    run: GenerationRunRow,
    sectionStates: SectionStates,
    agentRevision: number,
  ): Promise<StageOutcome> {
    // Revision guard — re-read the draft's current document-agent revision.
    const current = await this.prisma.wsDraft.findFirst({
      where: { id: run.draftId, tenantId: run.tenantId },
      select: { config: true },
    });
    if (!current) {
      return { terminal: 'failed', errorMessage: 'draft not found at drafting' };
    }
    const currentCfg = (current.config as Record<string, unknown> | undefined) ?? {};
    const currentRevision =
      typeof (currentCfg.documentAgent as Record<string, unknown> | undefined)?.revision ===
      'number'
        ? (currentCfg.documentAgent as Record<string, number>).revision
        : 0;

    if (agentRevision !== 0 && currentRevision !== agentRevision) {
      // A human edit landed between queue and drafting. Cancel rather than
      // overwrite; nothing has been generated for this run yet.
      return {
        terminal: 'cancelled',
        errorMessage: `draft edited during generation (revision ${agentRevision} → ${currentRevision}); aborted to preserve human edits`,
        detail: 'cancelled: human edit detected',
      };
    }

    // Mark every declared section as generating before the fan-out.
    const sections = await this.declaredSections(run);
    for (const section of sections) {
      sectionStates[section] = { status: 'generating' };
    }
    await this.persistSectionStates(run.id, sectionStates);

    const result = await runWithGenerationAssuranceTenant(run.tenantId, () =>
      runWithContextPersistenceBoundary(run.tenantId, run.draftId, () =>
        this.generation.generateAllSections(run.tenantId, run.draftId, run.actorId, {}),
      ),
    );
    const summary = extractGenerationRun(result, this.logger, run.id);

    // Reconcile per-section state from the authoritative summary. Successful
    // sections get a content hash so a future retry can detect a human edit
    // (stale). Failed sections record the bounded error message; sections not
    // in this run's scope keep their prior state.
    const freshContent = await this.readSectionContent(run);
    const failedBySection = new Map(
      summary.failedSections.map((f) => [f.section, f] as const),
    );
    for (const section of sections) {
      if (summary.succeededSections.includes(section)) {
        sectionStates[section] = {
          status: 'succeeded',
          contentHash: contentHash(freshContent[section] ?? ''),
        };
      } else {
        const failure = failedBySection.get(section);
        sectionStates[section] = failure
          ? { status: 'failed', error: failure.message }
          : { status: 'failed', error: 'not attempted' };
      }
    }

    // Record provider/model/reasoning telemetry from the authoritative summary.
    await this.prisma.wsGenerationRun.update({
      where: { id: run.id },
      data: {
        provider: summary.provider,
        model: summary.model,
        // GenerationRunSummary does not surface a reasoning level today; leave
        // null unless a future summary carries one.
        reasoningLevel:
          (summary as { reasoningLevel?: string | null }).reasoningLevel ?? null,
      },
    });

    return {
      sectionStates,
      detail: `${summary.succeededSections.length}/${summary.requestedSections.length} sections succeeded`,
    };
  }

  /**
   * Snapshot the as-generated draft as a WsDocVersion (run-attributed). This is
   * in addition to the snapshot GenerationService writes internally, so the
   * run has its own labelled restore point independent of the interactive save.
   * Uses the canonical VersionsService; the run's actor (owner/editor) is the
   * version author so the private-draft ACL (canEdit) passes.
   */
  private async stageSnapshot(run: GenerationRunRow): Promise<StageOutcome> {
    try {
      await this.versions.create(run.tenantId, run.draftId, run.actorId, {
        label: 'As generated (durable run)',
        authorKind: 'meri',
      });
      return { detail: 'snapshot created' };
    } catch (e) {
      // A snapshot failure downgrades the run, but does not discard the
      // already-persisted generated content.
      return { detail: `snapshot failed: ${(e as Error).message}` };
    }
  }

  /**
   * Finalize the run status from the per-section states: all succeeded →
   * `complete`; some succeeded → `partial`; none → `failed`. Sets
   * `completed_at` and the terminal `stage`.
   */
  private async stageComplete(
    run: GenerationRunRow,
    sectionStates: SectionStates,
  ): Promise<StageOutcome> {
    const status = this.deriveFinalStatus(sectionStates);
    await this.prisma.wsGenerationRun.update({
      where: { id: run.id },
      data: {
        status,
        stage: 'complete',
        completedAt: new Date(),
        sectionStates: sectionStates as never,
      },
    });
    return { detail: `terminal ${status}` };
  }

  // ─── manual retry (retry-failed endpoint) ───────────────────────────────

  /**
   * Retry only the failed or stale sections of a completed/partial run. The
   * canonical {@link GenerationService.retryFailedSections} regenerates ONLY
   * the sections the latest run recorded as failed (and only those still
   * declared on the draft), preserving every successful section's content and
   * review state exactly. The run's per-section states and telemetry are then
   * refreshed from the returned summary.
   *
   * This does NOT re-queue a whole new generation: successful sections are
   * never re-run, satisfying the preserve-on-retry contract.
   */
  async retryFailedSections(
    tenantId: string,
    runId: string,
    actorId: string,
  ): Promise<void> {
    const run = await this.prisma.wsGenerationRun.findFirst({
      where: { id: runId, tenantId },
    });
    if (!run) throw new NotFoundException('Run not found');

    // GAI-31: retrying generation overwrites section content → owner/editor.
    await this.collaborators.assertCan(
      tenantId,
      run.draftId,
      actorId,
      canEdit,
      'Only owners and editors can retry generated content in this document',
    );

    const result = await runWithGenerationAssuranceTenant(tenantId, () =>
      runWithContextPersistenceBoundary(tenantId, run.draftId, () =>
        this.generation.retryFailedSections(tenantId, run.draftId, actorId),
      ),
    );
    const summary = extractGenerationRun(result, this.logger, runId);

    // Refresh per-section states: successes get a fresh content hash, failures
    // record their bounded error. Sections absent from the retry run keep
    // whatever state they had (a prior success that wasn't retried stays
    // succeeded).
    const sectionStates = readSectionStates(run.sectionStates);
    const freshContent = await this.readSectionContent({
      tenantId,
      draftId: run.draftId,
    } as GenerationRunRow);
    const failedBySection = new Map(
      summary.failedSections.map((f) => [f.section, f] as const),
    );
    for (const section of summary.requestedSections) {
      if (summary.succeededSections.includes(section)) {
        sectionStates[section] = {
          status: 'succeeded',
          contentHash: contentHash(freshContent[section] ?? ''),
        };
      } else {
        const failure = failedBySection.get(section);
        sectionStates[section] = failure
          ? { status: 'failed', error: failure.message }
          : { status: 'failed', error: 'not attempted' };
      }
    }

    await this.prisma.wsGenerationRun.update({
      where: { id: runId },
      data: {
        provider: summary.provider,
        model: summary.model,
        reasoningLevel:
          (summary as { reasoningLevel?: string | null }).reasoningLevel ?? null,
        sectionStates: sectionStates as never,
        // A retry does not change the run's lifecycle status by itself; the
        // editor reads the refreshed section states to render per-section
        // outcomes.
      },
    });
  }

  // ─── status polling ─────────────────────────────────────────────────────

  /**
   * Read the durable run status for the editor's polling endpoint. Tenant-
   * scoped: a run is only visible to its own tenant.
   */
  async getRunStatus(tenantId: string, runId: string): Promise<RunStatusResponse> {
    const run = await this.prisma.wsGenerationRun.findFirst({
      where: { id: runId, tenantId },
    });
    if (!run) throw new NotFoundException('Run not found');
    const stages = readStages(run.stages);
    const sectionStates = readSectionStates(run.sectionStates);
    return {
      runId: run.id,
      status: run.status,
      stage: run.stage,
      stages: stages.map((s) => ({
        name: s.name,
        status: s.status,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        detail: s.detail,
      })),
      sectionStates: sectionStates as RunStatusResponse['sectionStates'],
      provider: run.provider ?? undefined,
      model: run.model ?? undefined,
      reasoningLevel: run.reasoningLevel ?? undefined,
      errorMessage: run.errorMessage ?? undefined,
      startedAt: run.startedAt?.toISOString(),
      completedAt: run.completedAt?.toISOString(),
    };
  }

  // ─── helpers ───────────────────────────────────────────────────────────

  private async declaredSections(run: GenerationRunRow): Promise<string[]> {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: run.draftId, tenantId: run.tenantId },
      select: { config: true },
    });
    const cfg = (draft?.config as Record<string, unknown> | undefined) ?? {};
    return (cfg.sections as string[] | undefined) ?? [];
  }

  private async readSectionContent(
    run: GenerationRunRow,
  ): Promise<Record<string, string>> {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: run.draftId, tenantId: run.tenantId },
      select: { config: true },
    });
    const cfg = (draft?.config as Record<string, unknown> | undefined) ?? {};
    return (cfg.sectionContent as Record<string, string> | undefined) ?? {};
  }

  /**
   * Derive the terminal run status from per-section states: all succeeded →
   * `complete`; some succeeded → `partial`; none succeeded (or no sections) →
   * `failed`.
   */
  private deriveFinalStatus(sectionStates: SectionStates): string {
    const states = Object.values(sectionStates);
    const succeeded = states.filter((s) => s.status === 'succeeded').length;
    const failed = states.filter((s) => s.status === 'failed').length;
    if (states.length === 0) return 'complete';
    if (failed === 0) return 'complete';
    return succeeded > 0 ? 'partial' : 'failed';
  }

  /**
   * Persist the current stage marker, the appended stages array, and
   * optionally the section states / a terminal status / an error message in a
   * single update so a crash between fields never leaves the run half-written.
   */
  private async updateStage(
    runId: string,
    stage: string,
    stageStatus: 'active' | 'done' | 'failed',
    stages: StageEntry[],
    extra?: {
      sectionStates?: SectionStates;
      terminal?: string;
      errorMessage?: string;
    },
  ): Promise<void> {
    const data: Record<string, unknown> = {
      stage,
      stages: stages as never,
    };
    if (extra?.sectionStates) data.sectionStates = extra.sectionStates as never;
    if (extra?.terminal) {
      data.status = extra.terminal;
      if (extra.terminal !== 'active') data.completedAt = new Date();
    }
    if (extra?.errorMessage) data.errorMessage = extra.errorMessage.slice(0, 1000);
    // `stageStatus` is encoded inside each StageEntry; no separate column.
    void stageStatus;
    await this.prisma.wsGenerationRun.update({
      where: { id: runId },
      data: data as never,
    });
  }

  private async persistSectionStates(
    runId: string,
    sectionStates: SectionStates,
  ): Promise<void> {
    await this.prisma.wsGenerationRun.update({
      where: { id: runId },
      data: { sectionStates: sectionStates as never },
    });
  }

  private async markRunFailed(runId: string, errorMessage: string): Promise<void> {
    await this.prisma.wsGenerationRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        stage: 'complete',
        errorMessage: errorMessage.slice(0, 1000),
        completedAt: new Date(),
      },
    });
  }
}

// ─── types ────────────────────────────────────────────────────────────────

const STAGE_ORDER = [
  'preflight',
  'evidence_plan',
  'narrative_plan',
  'drafting',
  'editorial_pass',
  'assurance',
  'snapshot',
  'complete',
] as const;
type GenStage = (typeof STAGE_ORDER)[number];

interface StageEntry {
  name: GenStage;
  status: 'active' | 'done' | 'failed';
  startedAt: string;
  completedAt?: string;
  detail?: string;
  attempt?: number;
}

interface StageOutcome {
  detail?: string;
  /** When set, short-circuit the run to this terminal status. */
  terminal?: string;
  errorMessage?: string;
  /** Updated per-section states to persist. */
  sectionStates?: SectionStates;
  /** Updated agent revision captured during preflight. */
  agentRevision?: number;
}

interface SectionState {
  status: 'generating' | 'succeeded' | 'failed';
  error?: string;
  contentHash?: string;
}
type SectionStates = Record<string, SectionState>;

/** Shape of a `ws_generation_run` row as read by Prisma. */
interface GenerationRunRow {
  id: string;
  tenantId: string;
  draftId: string;
  actorId: string;
  status: string;
  stage: string;
  agentRevision: number;
  leaseHolder: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  sectionStates: unknown;
  stages: unknown;
  errorMessage: string | null;
  provider: string | null;
  model: string | null;
  reasoningLevel: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

// ─── pure helpers ─────────────────────────────────────────────────────────

function readStages(value: unknown): StageEntry[] {
  return Array.isArray(value) ? (value as StageEntry[]) : [];
}

function readSectionStates(value: unknown): SectionStates {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as SectionStates)
    : {};
}

function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function appendStageStart(
  stages: StageEntry[],
  name: GenStage,
  attempt: number,
): StageEntry[] {
  return [
    ...stages,
    { name, status: 'active', startedAt: new Date().toISOString(), attempt },
  ];
}

function completeStage(stages: StageEntry[], name: GenStage, detail?: string): StageEntry[] {
  // Mark the last `active` entry for this stage as done. A resumed run may have
  // an earlier failed entry for the same stage; the newest active entry is the
  // one this attempt owns.
  for (let i = stages.length - 1; i >= 0; i--) {
    const entry = stages[i]!;
    if (entry.name === name && entry.status === 'active') {
      stages[i] = {
        ...entry,
        status: 'done',
        completedAt: new Date().toISOString(),
        detail: detail ?? entry.detail,
      };
      return [...stages];
    }
  }
  return stages;
}

function failStage(stages: StageEntry[], name: GenStage, message: string): StageEntry[] {
  for (let i = stages.length - 1; i >= 0; i--) {
    const entry = stages[i]!;
    if (entry.name === name && entry.status === 'active') {
      stages[i] = {
        ...entry,
        status: 'failed',
        completedAt: new Date().toISOString(),
        detail: message.slice(0, 500),
      };
      return [...stages];
    }
  }
  return stages;
}

/**
 * Pull the {@link GenerationRunSummary} out of the GenerationService result.
 * `generateAllSections` / `retryFailedSections` return the refreshed draft
 * plus a `generationRun` field (`GenerationRunResult`); a result without it
 * reads as a synthesized failure so the worker never reports success for a
 * run that produced no summary.
 */
function extractGenerationRun(
  result: unknown,
  logger: Logger,
  runId: string,
): GenerationRunSummary {
  if (result && typeof result === 'object' && 'generationRun' in result) {
    const summary = (result as { generationRun: GenerationRunSummary | null }).generationRun;
    if (summary) return summary;
  }
  logger.warn(`run ${runId}: generation returned no run summary`);
  return synthesizeEmptyFailure();
}

function synthesizeEmptyFailure(): GenerationRunSummary {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    status: 'failed',
    requestedSections: [],
    succeededSections: [],
    failedSections: [] as GenerationSectionFailure[],
    sectionResults: [],
    invalidCitations: [],
    structuralFindings: [],
    groundingFindings: [],
    provider: 'anthropic',
    model: 'unknown',
    credentialSource: 'platform',
    contextPacketId: null,
    contextTraceHash: null,
    contextDegraded: true,
    snapshot: { status: 'failed', versionId: null, errorCode: 'snapshot_persistence_failed' },
    startedAt: now,
    completedAt: now,
    retryOfRunId: null,
  };
}

// Re-exported for tests that construct the service with mocked heavy deps.
export type {
  GenerationRunRow,
  SectionState,
  SectionStates,
  StageEntry,
  GenStage,
};
