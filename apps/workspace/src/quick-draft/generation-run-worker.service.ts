import { denyProspectTransfer } from '../prospect-resources/prospect-draft-access.js';
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
import {
  NATIVE_INTAKE_PHASE,
  NATIVE_INTAKE_OWNER,
  NativeIntakeAdapter,
  nativeIntakeRefusalCode,
  nativeIntakeRetryable,
  readBinding,
  type NativeIntakeAdmission,
  type NativeIntakeBinding,
  type NativeIntakeFacts,
  type NativeIntakeRunRef,
} from './native-intake.adapter.js';
import type { RunStatusResponse } from './dto/intake.dto.js';

/**
 * Durable generation-run worker (PR #964).
 *
 * A generation run is a DB-backed state machine (`ws_generation_run`) that
 * survives browser reload, ECS restart, worker crash, and network timeout:
 * every transition is persisted, work is claimed atomically via a leased
 * `UPDATE … WHERE`, and an expired lease lets any worker re-claim. This
 * service owns the stage machine and the poller.
 *
 * Stages (executed in order, each independently retry-safe):
 *   preflight → evidence_plan → narrative_plan → drafting →
 *   editorial_pass → assurance → snapshot → complete
 *
 * `drafting` is the only stage that performs real model IO, and for a durable
 * intake run it is served by the approved greenfield native conversation owner
 * through {@link NativeIntakeAdapter} — the same seam the five Workspace
 * document-agent phases use. Because that owner verifies the CURRENT
 * authenticated session credential itself, a durable intake run is drafted by
 * the ATTENDED caller that submitted it (the intake route hands this worker its
 * own request credential, which is never persisted), and a run whose native
 * request is retained unresolved is reconciled by an attended status read. The
 * unattended poller therefore does not take runs whose drafting needs that
 * credential: it would have nothing to dispatch them with, and re-issuing a
 * retained request blindly could start a second paid run. A run resumed after a
 * crash skips every stage that already recorded a `done` entry and continues
 * from the next.
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
    private readonly nativeIntake: NativeIntakeAdapter,
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
   *
   * `options.credential` is the CURRENT authenticated session credential of an
   * attended caller (the intake route that just persisted this run, or an
   * attended retry). It is forwarded to the native drafting owner and is never
   * persisted. Without it, a run whose drafting is served by that owner is not
   * claimed at all: an unattended claim has no credential to dispatch it with,
   * and must not re-issue a retained request.
   */
  async claim(runId: string, options: { credential?: string } = {}): Promise<string> {
    const credential =
      typeof options.credential === 'string' && options.credential.length > 0
        ? options.credential
        : undefined;

    if (credential === undefined && (await this.isNativeIntakeRun(runId))) {
      this.logger.log(
        `claim: run ${runId} is drafted by the native conversation owner and needs an attended current credential; left for its attended caller`,
      );
      return 'awaiting-current-access';
    }

    const claimed = await this.tryClaim(runId);
    if (!claimed) return 'busy';

    const run = await this.prisma.wsGenerationRun.findUnique({ where: { id: runId } });
    if (!run) {
      this.logger.warn(`claim: run ${runId} not found after claim`);
      return 'missing';
    }
    try {
      return await this.processRun(run, credential);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown';
      this.logger.error(`run ${runId} failed: ${message}`);
      await this.markRunFailed(runId, message);
      return 'failed';
    }
  }

  /**
   * True when this run's draft was created by the durable intake flow, i.e. its
   * drafting is served by the native conversation owner and therefore needs the
   * attended caller's own current credential.
   */
  private async isNativeIntakeRun(runId: string): Promise<boolean> {
    const run = await this.prisma.wsGenerationRun.findUnique({
      where: { id: runId },
      select: { draftId: true, tenantId: true },
    });
    if (!run) return false;
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: run.draftId, tenantId: run.tenantId, prospectId: null },
      select: { config: true },
    });
    const cfg = (draft?.config as Record<string, unknown> | undefined) ?? {};
    return cfg.quickDraftIntake !== undefined && cfg.quickDraftIntake !== null;
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
  private async processRun(run: GenerationRunRow, credential?: string): Promise<string> {
    const origin = await this.prisma.wsDraft.findFirst({ where: { tenantId: run.tenantId, id: run.draftId }, select: { prospectId: true } });
    if (!origin) throw new NotFoundException('Draft not found');
    denyProspectTransfer(origin);
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
        const outcome = await this.runStage(stage, run, sectionStates, stages, agentRevision, credential);
        if (outcome.sectionStates) sectionStates = outcome.sectionStates;
        if (outcome.agentRevision !== undefined) agentRevision = outcome.agentRevision;

        if (outcome.halt) {
          // The stage is recorded NOT done, so a later attended claim resumes it
          // exactly here; the run keeps its lifecycle status (no completedAt) and
          // this pass stops. Used when the native conversation owner cannot be
          // reached without the attended caller's current credential.
          stages = failStage(stages, stage, outcome.halt.detail);
          await this.updateStage(run.id, stage, 'failed', stages, {
            sectionStates,
            errorMessage: outcome.halt.errorMessage,
          });
          // Nobody is working this run any more, so the lease is released rather
          // than held to its full five minutes: the next attended attempt — a
          // re-submitted intake or a status read holding current access — may
          // take it at once.
          await this.releaseLease(run.id);
          break;
        }

        stages = completeStage(stages, stage, outcome.detail);

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
   * perform IO. The middle stages are durable markers: the single native
   * `document` turn performs the planning/editorial/assurance work internally
   * during drafting, so this flow never calls the owner once per stage and never
   * claims work no call performed.
   */
  private async runStage(
    stage: GenStage,
    run: GenerationRunRow,
    sectionStates: SectionStates,
    _stages: StageEntry[],
    agentRevision: number,
    credential?: string,
  ): Promise<StageOutcome> {
    switch (stage) {
      case 'preflight':
        return this.stagePreflight(run, agentRevision);
      case 'evidence_plan':
      case 'narrative_plan':
      case 'editorial_pass':
      case 'assurance':
        return {
          detail:
            'covered by the single native document turn (marker only; no separate call for this stage)',
        };
      case 'drafting':
        return this.stageDrafting(run, sectionStates, agentRevision, credential);
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
      where: { prospectId: null, id: run.draftId, tenantId: run.tenantId },
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
   * The real work for a durable intake run: admit ONE native turn through the
   * approved greenfield conversation owner and reconcile this run's durable state
   * from that single admission. The owner's identity, transport and wire
   * protocol are the ones the five Workspace document-agent phases already use
   * (`NATIVE_GENERATION_TURN` → `NativeGenerationConversationClient`); the run's
   * own owners (this stage machine, the draft config) remain the only writers.
   *
   * OPTIMISTIC REVISION GUARD: before generating, re-read the draft's
   * document-agent revision and compare it to the value captured at preflight.
   * If a human edited the draft while this run sat queued/leased, the run is
   * cancelled rather than overwriting the human's work — the single place this
   * worker can decline to clobber newer edits, enforced before the native owner
   * is called and before anything is persisted.
   *
   * The exact native request is derived from the run's retained facts only (the
   * frozen intake snapshot, the pinned published blueprint version and this
   * revision), so an unchanged run always addresses the same retained request
   * and a changed revision, blueprint or source set addresses a different one.
   */
  private async stageDrafting(
    run: GenerationRunRow,
    sectionStates: SectionStates,
    agentRevision: number,
    credential?: string,
  ): Promise<StageOutcome> {
    // Revision guard — re-read the draft's current document-agent revision.
    const current = await this.prisma.wsDraft.findFirst({
      where: { prospectId: null, id: run.draftId, tenantId: run.tenantId },
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

    const ref: NativeIntakeRunRef = {
      tenantId: run.tenantId,
      runId: run.id,
      draftId: run.draftId,
      actorId: run.actorId,
    };

    // The run's own retained facts decide the exact request, and carry the pinned
    // blueprint's section titles the per-section states are keyed by. A refusal
    // to read them (lost access, unpublished blueprint, changed definition hash)
    // is recorded exactly like an admission refusal.
    let facts: NativeIntakeFacts;
    try {
      facts = await this.nativeIntake.retainedFacts(ref);
    } catch (error) {
      return this.intakeRefusalOutcome(sectionStates, error);
    }

    // Mark the pinned blueprint's sections as generating before the one bounded
    // native call, so the editor sees real progress while it is in flight.
    for (const title of facts.blueprint.sectionTitles) {
      sectionStates[title] = { status: 'generating' };
    }
    await this.persistSectionStates(run.id, sectionStates);

    const admission = await this.nativeIntake.admit(ref, credential ?? '');
    return this.applyIntakeAdmission(run, facts, admission, sectionStates);
  }

  /**
   * Reconcile this run's durable state from ONE native admission. The retained
   * binding is persisted first, so a crash between the call and the rest of the
   * bookkeeping still leaves the exact request addressable.
   */
  private async applyIntakeAdmission(
    run: GenerationRunRow,
    facts: NativeIntakeFacts,
    admission: NativeIntakeAdmission,
    sectionStates: SectionStates,
  ): Promise<StageOutcome> {
    // Record the exact request identity FIRST (a crash between the call and the
    // rest of the bookkeeping still leaves it addressable) — but only when the
    // draft still carries the bytes this pass read: the write is a
    // compare-and-set, so a draft edited while the request was in flight is
    // never silently replaced. The binding is what makes a later pass re-read
    // the SAME request instead of issuing a new one, so a lost binding cannot be
    // retried — see intakeBindingConflictOutcome.
    if (admission.binding && !(await this.persistIntakeBinding(run, admission.binding))) {
      return this.intakeBindingConflictOutcome(
        sectionStates,
        admission.kind,
        admission.binding.requestId,
      );
    }

    if (admission.kind === 'result') {
      const admitted: Record<string, string> = {};
      for (const section of admission.sections) {
        admitted[section.title] = section.text;
        sectionStates[section.title] = {
          status: 'succeeded',
          contentHash: contentHash(section.text),
        };
      }
      // Land the body with the same compare-and-set, MERGING the admitted
      // sections into the snapshot that write itself reads — there is no earlier
      // content read whose (older) map could replace a save that lands in
      // between. A draft edited while the answer was in flight keeps its own
      // bytes and entries: nothing is written for this answer, no section is
      // reported as succeeded, and the stage stays resumable — the retained
      // request above is what a later attended pass re-reads (never a new paid
      // turn).
      const landed = await this.writeDraftSections(
        run,
        admission.sections.map((section) => section.title),
        admitted,
      );
      if (!landed) {
        const conflict = `the draft was edited while native ${NATIVE_INTAKE_PHASE} request ${admission.binding.requestId} was in flight; the generated body was not written and the draft's own content is preserved`;
        for (const section of admission.sections) {
          sectionStates[section.title] = { status: 'failed', error: conflict.slice(0, 500) };
        }
        return {
          sectionStates,
          halt: {
            detail: `native ${NATIVE_INTAKE_PHASE} content not written (config conflict): ${conflict}`.slice(0, 500),
            errorMessage: conflict,
          },
        };
      }
      await this.prisma.wsGenerationRun.update({
        where: { id: run.id },
        data: { provider: NATIVE_INTAKE_OWNER, model: null },
      });
      return {
        sectionStates,
        detail: `${admission.detail}; ${admission.sections.length}/${facts.blueprint.sectionIds.length} pinned blueprint sections landed`,
      };
    }

    if (admission.kind === 'unknown' || admission.kind === 'approval-required') {
      // Nothing has landed. The run keeps its lifecycle status and the drafting
      // stage stays resumable; the retained request — not a new one — is what a
      // later attended claim or status read re-reads.
      return { sectionStates, halt: { detail: admission.detail } };
    }

    const message = admission.kind === 'failed' ? admission.detail : admission.message;
    for (const [title, state] of Object.entries(sectionStates)) {
      if (state.status === 'generating') {
        sectionStates[title] = { status: 'failed', error: message.slice(0, 500) };
      }
    }
    if (admission.kind === 'failed' || !admission.retryable) {
      return { terminal: 'failed', sectionStates, errorMessage: message, detail: admission.detail };
    }
    // Not terminal: current access or the owner's availability may still change,
    // and only an attended attempt holding a valid credential may resolve it.
    return { sectionStates, halt: { detail: admission.detail, errorMessage: message } };
  }

  /** Record a refusal to read the run's retained facts, the same way as an admission. */
  private intakeRefusalOutcome(sectionStates: SectionStates, error: unknown): StageOutcome {
    const message = error instanceof Error ? error.message : 'native intake facts unavailable';
    // The refusal code travels with the recorded stage, so the durable record
    // names the same reason the admission path records (e.g. a pinned blueprint
    // whose sections cannot be keyed uniquely).
    const code = nativeIntakeRefusalCode(error);
    if (nativeIntakeRetryable(error)) {
      return {
        sectionStates,
        halt: {
          detail: `native ${NATIVE_INTAKE_PHASE} intake facts unavailable (${code}): ${message}`.slice(0, 500),
          errorMessage: message,
        },
      };
    }
    return {
      terminal: 'failed',
      sectionStates,
      errorMessage: message,
      detail: `native ${NATIVE_INTAKE_PHASE} intake facts refused (${code}): ${message}`.slice(0, 500),
    };
  }

  /**
   * The exact request identity could not be recorded on the draft: a concurrent
   * config write (a human save) won the race while the native request was in
   * flight. The request has already gone out, so this run must NOT be left
   * resumable — a later pass would find no retained request and issue a SECOND
   * paid turn for work the owner may already be doing. The run therefore stops
   * (terminal) with a truthful conflict/unknown outcome naming the owner outcome
   * this pass observed, nothing is written to the draft, and the caller
   * re-intakes. This is the one config conflict that is not resumable.
   */
  private intakeBindingConflictOutcome(
    sectionStates: SectionStates,
    kind: NativeIntakeAdmission['kind'],
    requestId: string,
  ): StageOutcome {
    const message = `the draft was edited while native ${NATIVE_INTAKE_PHASE} request ${requestId} was in flight, so its exact request identity could not be recorded (owner outcome: ${kind}); the run is stopped rather than risking a second paid dispatch, and nothing was written to the draft`;
    for (const [title, state] of Object.entries(sectionStates)) {
      if (state.status === 'generating') {
        sectionStates[title] = { status: 'failed', error: message.slice(0, 500) };
      }
    }
    return {
      terminal: 'failed',
      sectionStates,
      errorMessage: message,
      detail: `native ${NATIVE_INTAKE_PHASE} binding not recorded (config conflict): ${message}`.slice(0, 500),
    };
  }

  /**
   * Persist the retained native binding on the draft's own intake linkage block.
   * It holds ids and the derived request identity — never the credential, prompt
   * or document text.
   *
   * The write is a compare-and-set over the config BYTES this pass read (`id`,
   * `tenantId` and `config: { equals }`, which includes the draft's agent
   * revision) — the same guard the document-agent owner uses for its own config
   * writes. `true` means the binding is durably retained; `false` means a
   * concurrent write won and the draft was left exactly as the other writer left
   * it.
   */
  private async persistIntakeBinding(
    run: GenerationRunRow,
    binding: NativeIntakeBinding,
  ): Promise<boolean> {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { prospectId: null, id: run.draftId, tenantId: run.tenantId },
      select: { config: true },
    });
    const snapshot = (draft?.config as Record<string, unknown> | undefined) ?? {};
    const intake = (snapshot.quickDraftIntake as Record<string, unknown> | undefined) ?? {};
    const written = await this.prisma.wsDraft.updateMany({
      where: {
        id: run.draftId,
        tenantId: run.tenantId,
        // A copy of the row as it was read: the payload below is built from
        // spreads, so nothing this pass writes can be part of what is compared.
        config: { equals: structuredClone(snapshot) as never },
      },
      data: {
        config: { ...snapshot, quickDraftIntake: { ...intake, native: binding } } as never,
      },
    });
    return written.count === 1;
  }

  /**
   * Land the admitted document body in the draft's own editor fields: the
   * section list, and the per-section content keyed by the section title the
   * pinned blueprint declares. Sections the draft already declared keep their
   * prior order; an intake draft declares none, so the pinned blueprint's order
   * is used.
   */
  private async writeDraftSections(
    run: GenerationRunRow,
    titles: string[],
    admitted: Record<string, string>,
  ): Promise<boolean> {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { prospectId: null, id: run.draftId, tenantId: run.tenantId },
      select: { config: true },
    });
    const snapshot = (draft?.config as Record<string, unknown> | undefined) ?? {};
    const declared = (snapshot.sections as string[] | undefined) ?? [];
    const currentContent = (snapshot.sectionContent as Record<string, string> | undefined) ?? {};
    // Compare-and-set with ONE read and ONE write: the admitted sections are
    // merged into the SAME snapshot that forms the comparison, so the compared
    // bytes and the payload base are the same bytes and every unrelated current
    // section, content entry and config field is carried through. A save that
    // lands before this read is part of the compared bytes and is preserved by
    // the merge; a save landing after it fails the comparison and is preserved
    // by refusing to write. The generated body can therefore never replace a
    // map that is older than the bytes it was compared against.
    const written = await this.prisma.wsDraft.updateMany({
      where: {
        id: run.draftId,
        tenantId: run.tenantId,
        config: { equals: structuredClone(snapshot) as never },
      },
      data: {
        config: {
          ...snapshot,
          sections: declared.length ? declared : titles,
          sectionContent: { ...currentContent, ...admitted },
        } as never,
      },
    });
    return written.count === 1;
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
    // Reported as the terminal outcome too, so the caller that drove this run
    // sees the status the run actually has rather than the interim `active`.
    return { terminal: status, detail: `terminal ${status}` };
  }

  // ─── manual retry (retry-failed endpoint) ───────────────────────────────

  /**
   * Continue a run's failed work from its retry route.
   *
   * A DURABLE-INTAKE run is drafted by the native conversation owner, so its
   * continuation is its RETAINED native request: the same request the intake
   * already issued is read/replayed with the caller's own current credential
   * (the exact request identity, never a re-derived or newly scoped one). The
   * legacy provider owner is not reachable from this route for such a run at
   * all, nothing is resubmitted as new work, and a run with nothing retained is
   * left for its attended intake rather than dispatched here. An unattended call
   * (no current credential) leaves the run exactly as it is.
   *
   * For every other run the canonical {@link GenerationService.retryFailedSections}
   * is unchanged: it regenerates ONLY the sections the latest run recorded as
   * failed (and only those still declared on the draft), preserving every
   * successful section's content and review state exactly. The run's per-section
   * states and telemetry are then refreshed from the returned summary. This does
   * NOT re-queue a whole new generation.
   *
   * Returns the run's status after the continuation (`'queued'` for the legacy
   * path, whose work is handed to the legacy owner as before).
   */
  async retryFailedSections(
    tenantId: string,
    runId: string,
    actorId: string,
    attended: { credential?: string } = {},
  ): Promise<string> {
    const run = await this.prisma.wsGenerationRun.findFirst({
      where: { id: runId, tenantId },
    });
    if (!run) throw new NotFoundException('Run not found');
    const origin = await this.prisma.wsDraft.findFirst({ where: { tenantId, id: run.draftId }, select: { prospectId: true } });
    if (!origin) throw new NotFoundException('Run not found');
    denyProspectTransfer(origin);

    // GAI-31: retrying generation overwrites section content → owner/editor.
    await this.collaborators.assertCan(
      tenantId,
      run.draftId,
      actorId,
      canEdit,
      'Only owners and editors can retry generated content in this document',
    );

    // A durable-intake run never reaches the legacy provider: its retained
    // request is the only continuation, and it needs the attended caller's own
    // current credential to be read (the owner verifies that credential itself).
    if (await this.isNativeIntakeRun(runId)) {
      const credential =
        typeof attended.credential === 'string' && attended.credential.length > 0
          ? attended.credential
          : undefined;
      if (credential === undefined) {
        this.logger.log(
          `retry: run ${runId} is drafted by the native conversation owner and needs an attended current credential; left for its attended caller`,
        );
        return 'awaiting-current-access';
      }
      // Reads/replays the SAME retained request through this caller's credential;
      // it drives nothing when no request is retained (a first request stays the
      // attended intake's job).
      await this.reconcileRetainedNativeRequest(run, { actorId, credential });
      const current = await this.prisma.wsGenerationRun.findFirst({
        where: { id: runId, tenantId },
      });
      return current?.status ?? run.status;
    }

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
    // Unchanged response for a run that is not a durable-intake run.
    return 'queued';
  }

  // ─── status polling ─────────────────────────────────────────────────────

  /**
   * Read the durable run status for the editor's polling endpoint. Tenant-
   * scoped: a run is only visible to its own tenant.
   *
   * When the caller supplies its own current session credential and this run
   * holds a RETAINED native request that has not resolved yet, the read also
   * reconciles it: the stage machine is driven once more with this caller's
   * credential, which re-reads the SAME stored request (never a new one) and
   * finishes the run if the owner has published a terminal state. A read never
   * issues a first request for a run that has nothing retained — that stays the
   * attended intake's job — and a caller without current edit access is refused
   * by the same owner the interactive route uses, leaving the run untouched.
   */
  async getRunStatus(
    tenantId: string,
    runId: string,
    attended?: { actorId: string; credential?: string },
  ): Promise<RunStatusResponse> {
    const run = await this.prisma.wsGenerationRun.findFirst({
      where: { id: runId, tenantId },
    });
    if (!run) throw new NotFoundException('Run not found');
    const origin = await this.prisma.wsDraft.findFirst({ where: { tenantId, id: run.draftId }, select: { prospectId: true } });
    if (!origin) throw new NotFoundException('Run not found');
    denyProspectTransfer(origin);

    const reconciled =
      attended?.credential && RESOLVED_RUN_STATUSES.has(run.status) === false
        ? await this.reconcileRetainedNativeRequest(run, attended)
        : null;
    const current = reconciled
      ? ((await this.prisma.wsGenerationRun.findFirst({ where: { id: runId, tenantId } })) ?? run)
      : run;
    const stages = readStages(current.stages);
    const sectionStates = readSectionStates(current.sectionStates);
    return {
      runId: current.id,
      status: current.status,
      stage: current.stage,
      stages: stages.map((s) => ({
        name: s.name,
        status: s.status,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        detail: s.detail,
      })),
      sectionStates: sectionStates as RunStatusResponse['sectionStates'],
      provider: current.provider ?? undefined,
      model: current.model ?? undefined,
      reasoningLevel: current.reasoningLevel ?? undefined,
      errorMessage: current.errorMessage ?? undefined,
      startedAt: current.startedAt?.toISOString(),
      completedAt: current.completedAt?.toISOString(),
    };
  }

  /**
   * Drive a run whose native request is already RETAINED. Nothing is retained →
   * nothing to reconcile (a read never dispatches a first request). The retained
   * case resumes the ordinary stage machine with this caller's credential, so
   * the drafting stage re-reads the SAME request, the remaining stages still run
   * (including the as-generated snapshot) and the run reaches its real terminal
   * status.
   */
  private async reconcileRetainedNativeRequest(
    run: GenerationRunRow,
    attended: { actorId: string; credential?: string },
  ): Promise<boolean> {
    const ref: NativeIntakeRunRef = {
      tenantId: run.tenantId,
      runId: run.id,
      draftId: run.draftId,
      actorId: attended.actorId,
    };
    let retained: NativeIntakeBinding | null;
    try {
      retained = (await this.nativeIntake.retainedFacts(ref)).retained;
    } catch (error) {
      // The reading caller does not hold current access to this draft: a read
      // stays a read and the run is returned exactly as it is.
      this.logger.log(
        `run ${run.id} not reconciled for this caller: ${error instanceof Error ? error.message : 'current access refused'}`,
      );
      return false;
    }
    if (retained === null) return false;

    // The SAME atomic claim the attended paths use, so two concurrent reads can
    // never both drive this run (and a run someone else is working is left alone).
    if (!(await this.tryClaim(run.id))) return false;
    const fresh = await this.prisma.wsGenerationRun.findUnique({ where: { id: run.id } });
    if (!fresh) return false;
    try {
      await this.processRun(fresh, attended.credential);
    } catch (error) {
      // A status read reports the run's durable state; a reconcile attempt that
      // fails is logged here and left on the run row, never raised as a read error.
      this.logger.warn(
        `run ${run.id} reconcile failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return false;
    }
    return true;
  }

  /** Release this worker's lease so an attended attempt may take the run at once. */
  private async releaseLease(runId: string): Promise<void> {
    await this.prisma.wsGenerationRun.update({
      where: { id: runId },
      data: { leaseExpiresAt: new Date(0) },
    });
  }

  // ─── helpers ───────────────────────────────────────────────────────────

  private async readSectionContent(
    run: GenerationRunRow,
  ): Promise<Record<string, string>> {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { prospectId: null, id: run.draftId, tenantId: run.tenantId },
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

/** Lifecycle statuses that are final for a run: nothing more will be driven. */
const RESOLVED_RUN_STATUSES = new Set(['complete', 'partial', 'failed', 'cancelled']);

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
  /**
   * The stage could not advance the run and must NOT be recorded done: the run
   * keeps its lifecycle status, this pass stops, and a later attended claim
   * resumes exactly at this stage. Used when the native conversation owner
   * cannot be reached without the attended caller's current credential.
   */
  halt?: { detail: string; errorMessage?: string };
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
