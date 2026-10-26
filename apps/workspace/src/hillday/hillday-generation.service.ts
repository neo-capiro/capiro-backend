import { admitHillDayDocument } from './hillday-access.js';
import { prepareAnthropicRequest } from '@capiro/shared/ai-model-policy';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiCredentialService, type ResolvedAiCredential } from '../generation/ai-credential.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assembleUnitPrompt, parseUnitOutput, type UnitPromptInput } from './generation-prompt.js';
import {
  DEFAULT_LOOKBACK_DAYS,
  buildCarryUnits,
  effectiveCarry,
  toThreadRef,
} from './hillday-context.service.js';
import { HillDaySourceService, type MessageRow, type StrategyRow } from './hillday-source.service.js';
import {
  LEASE_LOST_REASON,
  PROVIDER_UNCERTAIN_REASON,
  claimFence,
  finalLifecycle,
  jobQuality,
  recoverInterruptedUnits,
  requeueFailedUnits,
  runnableUnits,
  unitStateForFailure,
  type JobClaim,
} from './hillday-job-state.js';
import type {
  CalendarEvent,
  JobEvent,
  JobLifecycle,
  JobStartResult,
  JobStatus,
  JobUnit,
  LatestJobResponse,
  MeetingContextRecord,
  MeetingResolution,
  MeetingSection,
  SectionFlag,
  SourceSet,
  SourceStatus,
} from './hillday.types.js';
import { confirmationReason, emptyOffice, normalizeAddress, rollUpMeeting } from './resolution.rules.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const UNIT_TIMEOUT_MS = 90_000;
const UNIT_MAX_TOKENS = 1600;
/** Two units in flight: keeps a 12-meeting week under a minute without 429s. */
const UNIT_CONCURRENCY = 2;
const MAX_UNSUPPORTED_FLAGS = 5;

/** Every persisted job lifecycle value, for normalizing a row read back. */
const JOB_LIFECYCLES: readonly JobLifecycle[] = ['queued', 'running', 'complete', 'failed', 'cancelled'];

/** The lifecycle a start call reports for an existing job, from the stored string. */
function startStatus(raw: string): JobLifecycle {
  return (JOB_LIFECYCLES as readonly string[]).includes(raw) ? (raw as JobLifecycle) : 'queued';
}

/** A transaction client, narrowed to the one statement the lock needs. */
type LockTx = { $executeRaw: (parts: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> };

/**
 * Take a row lock on the owning document. Every start/retry/cancel for a
 * document serializes on it, so two racing callers cannot each believe they are
 * the only one — the standard database feature this needs, with no new
 * lock/ledger owner of our own.
 */
async function lockDocument(tx: LockTx, tenantId: string, documentId: string): Promise<void> {
  await tx.$executeRaw`
    SELECT id FROM ws_hillday_document
     WHERE id = ${documentId}::uuid AND tenant_id = ${tenantId}::uuid
     FOR UPDATE
  `;
}

/** Prisma's unique-constraint violation, i.e. a race that lost at the database. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

interface SharedRunContext {
  firmName: string;
  client: { name: string; description: string | null };
  objectives: { status: SourceStatus; items: StrategyRow[] };
  credential: ResolvedAiCredential | null;
  credentialError: string | null;
  userId: string | null;
  timeZone: string;
  lookbackDays: number;
}

interface MeetingRow {
  id: string;
  eventId: string;
  ordinal: number;
  event: unknown;
  resolution: unknown;
  context: unknown;
  section: unknown;
}

interface JobState {
  id: string;
  units: JobUnit[];
  events: JobEvent[];
  seq: number;
}

type ModelResult = { ok: true; text: string } | { ok: false; reason: string; detail: string };

async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!items.length) return;
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await worker(items[index]!, index);
      }
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generation (requirements §7): one job per document, one unit of work per
 * selected meeting. Focus and Background are drafted per meeting from the
 * objectives, the CARRIED Directory units, the user note (verbatim) and the
 * selected correspondence. A failed unit resolves its section to `unavailable`
 * with the reason attached — the document still assembles, the facts stay,
 * and single-section regeneration is offered in the editor.
 *
 * Progress is persisted on the job row (units + an ordered event log) so the
 * SSE stream and the poll fallback read the same truth.
 *
 * Durability (WS-10): the job row is the only owner of job identity and
 * progress. A start request is bound to a `requestId`, an already-active job is
 * returned rather than invalidated, and the job is executed by the durable
 * {@link HillDayJobWorkerService} after a race-free lease claim — never by an
 * in-process dispatch. A worker that loses its lease stops without writing, and
 * a unit whose provider call may already have been issued is parked as
 * `unknown` (never auto-replayed) for a deliberate retry.
 */
@Injectable()
export class HillDayGenerationService {
  private readonly logger = new Logger(HillDayGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly source: HillDaySourceService,
    private readonly credentials: AiCredentialService,
  ) {}

  /**
   * Request-bound durable start (WS-10).
   *
   * The job row is the only source of job identity. Start is LINEARIZED per
   * document inside one transaction that takes a row lock on the owning
   * document, so two racing starts cannot both create a job:
   *   - a request identity already bound to a job returns that job;
   *   - otherwise the document's active job is reused, and the new identity is
   *     bound to it — a start answered by an already-active job is therefore
   *     still replayable after that job finishes, instead of reissuing the work;
   *   - otherwise the job row is created.
   * A unique-key race that slips past the lock is caught and the committed
   * winner is returned. Nothing executes here: the worker claims the row.
   */
  async start(
    tenantId: string,
    actorId: string,
    documentId: string,
    requestId?: string,
  ): Promise<JobStartResult> {
    const doc = await this.assertDoc(tenantId, documentId, actorId);
    if (doc.ownerId !== actorId) throw new ForbiddenException('Only the document owner can generate it');

    try {
      const job = await this.prisma.$transaction(async (tx) => {
        await lockDocument(tx, tenantId, documentId);

        if (requestId) {
          const bound = await tx.wsHillDayJob.findFirst({
            where: { tenantId, documentId, requestIds: { has: requestId } },
          });
          if (bound) return bound;
        }

        // Whoever already holds the document's job keeps it; whether it is still
        // alive is decided by its lease, not by a process-local Set.
        const active = await tx.wsHillDayJob.findFirst({
          where: { tenantId, documentId, status: { in: ['queued', 'running'] } },
          orderBy: { createdAt: 'desc' },
        });
        if (active) {
          if (!requestId || (active.requestIds ?? []).includes(requestId)) return active;
          return tx.wsHillDayJob.update({
            where: { id: active.id },
            data: { requestIds: { push: requestId } },
          });
        }

        const meetings = await tx.wsHillDayMeeting.findMany({
          where: { tenantId, documentId },
          orderBy: { ordinal: 'asc' },
          select: { id: true },
        });
        if (!meetings.length) throw new BadRequestException('Select at least one meeting before generating');

        const now = new Date().toISOString();
        const units: JobUnit[] = meetings.map((m) => ({
          meetingId: m.id,
          state: 'queued',
          sectionId: m.id,
          reason: null,
          at: now,
        }));
        const created = await tx.wsHillDayJob.create({
          data: {
            tenantId,
            documentId,
            actorId,
            status: 'queued',
            requestId: requestId ?? null,
            requestIds: requestId ? [requestId] : [],
            units: units as never,
            events: [] as never,
          },
        });
        await tx.wsHillDayDocument.update({
          where: { id: documentId },
          data: { status: 'generating' },
        });
        return created;
      });
      return { jobId: job.id, status: startStatus(job.status) };
    } catch (err) {
      // A same-request race that beat the document lock: return the committed
      // winner rather than surfacing a unique violation or inventing a job.
      if (!isUniqueViolation(err)) throw err;
      const winner = await this.prisma.wsHillDayJob.findFirst({
        where: requestId
          ? { tenantId, documentId, requestIds: { has: requestId } }
          : { tenantId, documentId, status: { in: ['queued', 'running'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (!winner) throw err;
      return { jobId: winner.id, status: startStatus(winner.status) };
    }
  }

  async jobStatus(tenantId: string, documentId: string, jobId: string, actorId: string): Promise<JobStatus> {
    await this.assertDoc(tenantId, documentId, actorId);
    const job = await this.prisma.wsHillDayJob.findFirst({ where: { id: jobId, tenantId, documentId } });
    if (!job) throw new NotFoundException('Generation job not found');
    return this.toJobStatus(job, documentId);
  }

  /**
   * Authorized latest-job read (WS-10). The wizard reloads with this instead of
   * keeping a job id in local state: an active job always wins, otherwise the
   * newest finished job is returned so a reload renders the real outcome.
   */
  async latestJob(tenantId: string, actorId: string, documentId: string): Promise<LatestJobResponse> {
    await this.assertDoc(tenantId, documentId, actorId);
    const active = await this.activeJob(tenantId, documentId);
    const job =
      active ??
      (await this.prisma.wsHillDayJob.findFirst({
        where: { tenantId, documentId },
        orderBy: { createdAt: 'desc' },
      }));
    return { job: job ? this.toJobStatus(job, documentId) : null };
  }

  /**
   * Deliberate retry of the units that are safe to retry: definitively failed
   * units, and units whose outcome was lost with a lease (`unknown`). Units
   * already `done` — including sections the user edited by hand — are never
   * re-queued, so successful content and manual edits survive.
   */
  async retryFailedUnits(
    tenantId: string,
    actorId: string,
    documentId: string,
    jobId: string,
  ): Promise<JobStatus> {
    const doc = await this.assertDoc(tenantId, documentId, actorId);
    if (doc.ownerId !== actorId) throw new ForbiddenException('Only the document owner can retry its generation');

    // Serialized per document, and the rewrite is conditional on the state that
    // was actually read: a delayed second retry cannot drag a job a worker has
    // already re-claimed back to `queued`.
    await this.prisma.$transaction(async (tx) => {
      await lockDocument(tx, tenantId, documentId);
      const job = await tx.wsHillDayJob.findFirst({ where: { id: jobId, tenantId, documentId } });
      if (!job) throw new NotFoundException('Generation job not found');
      if (job.status === 'queued' || job.status === 'running') {
        throw new ConflictException('This generation job is still running');
      }
      const otherActive = await tx.wsHillDayJob.findFirst({
        where: { tenantId, documentId, status: { in: ['queued', 'running'] }, NOT: { id: jobId } },
      });
      if (otherActive) {
        throw new ConflictException('Another generation job is already active for this document');
      }

      const { units, requeued } = requeueFailedUnits((job.units as JobUnit[] | null) ?? [], new Date().toISOString());
      if (!requeued.length) return;

      const { count } = await tx.wsHillDayJob.updateMany({
        where: { id: jobId, tenantId, documentId, status: job.status },
        data: {
          status: 'queued',
          units: units as never,
          quality: null,
          error: null,
          cancelRequestedAt: null,
          completedAt: null,
        },
      });
      // The state moved under us (a claim, or another transition): report what
      // is actually persisted instead of overwriting it.
      if (count === 0) return;

      await tx.wsHillDayDocument.update({
        where: { id: documentId },
        data: { status: 'generating' },
      });
    });

    return this.jobStatus(tenantId, documentId, jobId, actorId);
  }

  /**
   * Record a cancellation. Honest by construction: a job that has not been
   * claimed yet has no provider work to stop, so it is cancelled outright; a
   * `running` job keeps its status and gains `cancelRequestedAt`, the worker
   * stops before the NEXT unit, and the call already in flight completes.
   *
   * The transition is conditional on the status that was read, so a worker that
   * claims the job in between cannot be reported as `cancelled` while provider
   * work is in flight — the request is recorded and the CURRENT running outcome
   * is returned instead. Symmetrically, once cancellation lands, the claim
   * predicate no longer matches `queued` and no unit may start.
   */
  async requestCancel(
    tenantId: string,
    actorId: string,
    documentId: string,
    jobId: string,
  ): Promise<JobStatus> {
    const doc = await this.assertDoc(tenantId, documentId, actorId);
    if (doc.ownerId !== actorId) throw new ForbiddenException('Only the document owner can cancel its generation');

    await this.prisma.$transaction(async (tx) => {
      await lockDocument(tx, tenantId, documentId);
      const job = await tx.wsHillDayJob.findFirst({ where: { id: jobId, tenantId, documentId } });
      if (!job) throw new NotFoundException('Generation job not found');

      if (job.status === 'queued') {
        const { count } = await tx.wsHillDayJob.updateMany({
          where: { id: jobId, tenantId, documentId, status: 'queued' },
          data: { status: 'cancelled', cancelRequestedAt: new Date(), completedAt: new Date() },
        });
        if (count === 1) {
          await tx.wsHillDayDocument.update({
            where: { id: documentId },
            data: { status: 'partial' },
          });
          return;
        }
        // A worker claimed it between our read and the update: fall through and
        // record only the request against the now-running job.
      }

      // Running (or claimed while we were here): the in-flight provider call
      // cannot be recalled, so record the request and let the worker observe it.
      await tx.wsHillDayJob.updateMany({
        where: { id: jobId, tenantId, documentId, status: 'running' },
        data: { cancelRequestedAt: new Date() },
      });
    });

    return this.jobStatus(tenantId, documentId, jobId, actorId);
  }

  /** The one active job for a document (queued or running), or null. */
  private async activeJob(tenantId: string, documentId: string) {
    return this.prisma.wsHillDayJob.findFirst({
      where: { tenantId, documentId, status: { in: ['queued', 'running'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  private toJobStatus(
    job: {
      id: string;
      status: string;
      units: unknown;
      quality: number | null;
      error: string | null;
      cancelRequestedAt: Date | null;
      startedAt: Date | null;
      completedAt: Date | null;
    },
    documentId: string,
  ): JobStatus {
    return {
      jobId: job.id,
      documentId,
      status: job.status as JobStatus['status'],
      units: (job.units as JobUnit[] | null) ?? [],
      quality: job.quality,
      error: job.error,
      cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null,
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  }

  async jobEvents(
    tenantId: string,
    documentId: string,
    jobId: string,
    afterSeq: number,
    actorId: string,
  ): Promise<{ status: JobStatus['status']; events: JobEvent[] }> {
    await this.assertDoc(tenantId, documentId, actorId);
    const job = await this.prisma.wsHillDayJob.findFirst({ where: { id: jobId, tenantId, documentId } });
    if (!job) throw new NotFoundException('Generation job not found');
    const events = ((job.events as JobEvent[] | null) ?? []).filter((e) => e.seq > afterSeq);
    return { status: job.status as JobStatus['status'], events };
  }

  /** Redraft one section against the current context; clears any user edit on it. */
  async regenerateSection(
    tenantId: string,
    actorId: string,
    documentId: string,
    sectionId: string,
  ): Promise<{ section: MeetingSection; sourceSet: SourceSet }> {
    const doc = await this.assertDoc(tenantId, documentId, actorId);
    if (doc.ownerId !== actorId) throw new ForbiddenException('Only the document owner can regenerate it');
    // The durable job row is the truth: a process-local Set cannot see a job
    // another replica is running.
    if (await this.activeJob(tenantId, documentId)) {
      throw new ConflictException('A generation job is already running');
    }
    const meeting = (await this.prisma.wsHillDayMeeting.findFirst({
      where: { id: sectionId, tenantId, documentId },
    })) as MeetingRow | null;
    if (!meeting) throw new NotFoundException('Section not found');
    const shared = await this.sharedContext(tenantId, actorId, doc);
    const result = await this.generateUnit(tenantId, meeting, shared);
    // The interactive path persists its own result — the durable run loop fences
    // its publication by the claim instead, so generation never writes.
    await this.prisma.wsHillDayMeeting.update({
      where: { id: meeting.id },
      data: { section: result.section as never, sourceSet: result.sourceSet as never },
    });
    return { section: result.section, sourceSet: result.sourceSet };
  }

  /**
   * "Refine with Meri" — a lightweight, stateless polish pass on one field of
   * one section's already-drafted (or user-edited) text, distinct from
   * regenerateSection: no source assembly, no persistence, just the model
   * tightening prose the user is actively editing. The editor holds the
   * result in its own local draft state; nothing is written here until the
   * user's own "Save section" persists it via the existing patchDocument path.
   */
  async refineText(
    tenantId: string,
    actorId: string,
    documentId: string,
    sectionId: string,
    field: 'focus' | 'background',
    text: string,
  ): Promise<{ text: string }> {
    const doc = await this.assertDoc(tenantId, documentId, actorId);
    if (doc.ownerId !== actorId) throw new ForbiddenException('Only the document owner can refine it');
    const meeting = (await this.prisma.wsHillDayMeeting.findFirst({
      where: { id: sectionId, tenantId, documentId },
    })) as MeetingRow | null;
    if (!meeting) throw new NotFoundException('Section not found');
    if (!text.trim()) throw new BadRequestException('Nothing to refine — the field is empty');

    let credential: ResolvedAiCredential | null = null;
    try {
      credential = await this.credentials.resolveAnthropic(tenantId);
    } catch (err) {
      throw new ServiceUnavailableException(`No model credential is configured for this firm: ${(err as Error).message}`);
    }
    if (!credential) throw new ServiceUnavailableException('No model credential is configured for this firm');

    const event = meeting.event as CalendarEvent;
    const resolution = meeting.resolution as MeetingResolution | null;
    const member = resolution?.office.member ?? event.subject;
    const fieldLabel = field === 'focus' ? 'Focus' : 'Background';
    const system =
      'You refine one paragraph of a congressional Hill Day meeting-prep document that a government relations ' +
      'team will hand to a client. Tighten the prose, fix grammar, and keep the tone clear and professional. ' +
      'Keep every fact, name, number, and claim already in the draft — never invent, add, or drop one. ' +
      'Return ONLY the refined paragraph text: no preamble, no markdown, no quotes around it.';
    const user = `Meeting: ${member}\nSection: ${fieldLabel}\n\nCurrent draft:\n${text.trim()}`;

    const result = await this.callModel(credential, system, user);
    if (!result.ok) {
      throw new ServiceUnavailableException(`Meri could not refine this text right now (${result.detail})`);
    }
    if (!result.text.trim()) {
      throw new ServiceUnavailableException('Meri returned an empty refinement — the original text is unchanged');
    }
    return { text: result.text };
  }

  // ── run loop (durable worker entry point) ──────────────────────────────────

  /**
   * Execute one claimed job — the durable worker's entry point, called after a
   * race-free lease claim. `claim` is the identity of THAT claim (holder plus
   * generation) and `renew` extends its lease.
   *
   * EVERY write this pass performs is fenced by the claim: progress, the
   * section/source provenance, the terminal status and the final event land only
   * while this is still the job's current running owner. A superseded holder —
   * another process, or a later claim in this same process — stops instead of
   * publishing, so a late provider return cannot overwrite the new holder's
   * units, events or sections.
   *
   * Restart safety: units already `done` are kept, units a previous holder left
   * `running` become `unknown` — their provider call may have been issued and
   * charged, so replaying them is not safe — and only `queued` units run.
   *
   * No database transaction is held across provider work: each fence is a single
   * conditional statement.
   */
  async runClaimedJob(
    jobId: string,
    claim: JobClaim,
    renew: () => Promise<boolean>,
  ): Promise<JobStatus['status']> {
    const state: JobState = { id: jobId, units: [], events: [], seq: 0 };
    let documentId: string | null = null;
    let claimLost = false;
    try {
      const job = await this.prisma.wsHillDayJob.findUnique({ where: { id: jobId } });
      if (!job) return 'failed';
      const { tenantId, actorId } = job;
      // Narrow once: the closures below must see a non-null document id.
      const docId: string = job.documentId;
      documentId = docId;
      state.units = (job.units as JobUnit[] | null) ?? [];
      state.events = (job.events as JobEvent[] | null) ?? [];
      state.seq = state.events.reduce((max, e) => Math.max(max, e.seq), 0);

      // Whatever a previous holder left in flight is parked, not replayed.
      const recovered = recoverInterruptedUnits(state.units, new Date().toISOString());
      if (recovered.recovered.length) {
        state.units = recovered.units;
        for (const meetingId of recovered.recovered) {
          await this.emit(state, claim, 'unit', {
            meetingId,
            state: 'unknown',
            sectionId: meetingId,
            reason: LEASE_LOST_REASON,
          });
        }
        this.logger.warn(
          `Hill Day job ${jobId}: parked ${recovered.recovered.length} unit(s) as unknown after a lost lease`,
        );
      }

      // Current access at admission; re-checked per unit below.
      const doc = await this.assertDoc(tenantId, docId, actorId);
      if (!(await this.persistClaimed(jobId, claim, { startedAt: job.startedAt ?? new Date(), units: state.units }))) {
        this.logger.warn(`Hill Day job ${jobId}: claim superseded before the pass started`);
        return 'running';
      }
      const meetings = (await this.prisma.wsHillDayMeeting.findMany({
        where: { tenantId, documentId: docId },
        orderBy: { ordinal: 'asc' },
      })) as MeetingRow[];
      const byMeetingId = new Map(meetings.map((m) => [m.id, m]));
      const shared = await this.sharedContext(tenantId, actorId, doc);

      await forEachBounded(runnableUnits(state.units), UNIT_CONCURRENCY, async (unit) => {
        const meeting = byMeetingId.get(unit.meetingId);
        if (!meeting) {
          // The meeting was removed after the job was queued: fail that unit only.
          await this.emit(state, claim, 'unit', {
            meetingId: unit.meetingId,
            state: 'failed',
            sectionId: unit.meetingId,
            reason: 'meeting_removed',
          });
          return;
        }
        // Heartbeat. Once the claim is gone another worker owns this job.
        if (!(await renew())) {
          claimLost = true;
          return;
        }
        // Cancellation is observed BETWEEN units: the call already in flight finishes.
        if (await this.cancelRequested(jobId)) return;
        await this.assertDoc(tenantId, docId, actorId);
        const section = meeting.section as MeetingSection | null;
        if (section?.edited?.focus || section?.edited?.background) {
          // Edited sections are excluded from bulk regeneration (requirements §6 PATCH).
          await this.emit(state, claim, 'unit', {
            meetingId: meeting.id,
            state: 'done',
            sectionId: meeting.id,
            reason: 'edited_preserved',
          });
          return;
        }
        if (!(await this.emit(state, claim, 'unit', { meetingId: meeting.id, state: 'running', sectionId: meeting.id }))) {
          claimLost = true;
          return;
        }
        const result = await this.generateUnit(tenantId, meeting, shared);
        // Fenced publication: the section lands only while we still hold the
        // claim AND the section was not hand-edited while the call was out.
        const publication = await this.publishUnit(jobId, claim, meeting.id, result.section, result.sourceSet);
        if (publication === 'lost') {
          claimLost = true;
          return;
        }
        if (publication === 'edited') {
          // The user's own text wins; the generated text is dropped honestly.
          await this.emit(state, claim, 'unit', {
            meetingId: meeting.id,
            state: 'done',
            sectionId: meeting.id,
            reason: 'edited_during_generation',
          });
          return;
        }
        const done = result.section.status === 'done';
        await this.emit(state, claim, 'unit', {
          meetingId: meeting.id,
          state: done ? 'done' : unitStateForFailure(result.section.reason),
          sectionId: meeting.id,
          reason: done ? undefined : (result.section.reason ?? 'unknown'),
        });
      });

      if (claimLost) {
        this.logger.warn(`Hill Day job ${jobId}: claim superseded mid-run; stopping without a terminal status`);
        return 'running';
      }

      const cancelled = await this.cancelRequested(jobId);
      const lifecycle = finalLifecycle(cancelled);
      const total = state.units.length;
      const failed = state.units.filter((u) => u.state !== 'done').length;
      const quality = jobQuality(state.units);
      const completedAt = new Date();
      // The terminal status AND the final event commit in ONE fenced write, so a
      // crash cannot leave a terminal status with no final event.
      state.seq += 1;
      state.events.push({
        seq: state.seq,
        event: 'complete',
        data: { documentId: docId, cancelled, sections: total, failed, quality, at: completedAt.toISOString() },
      });
      if (!(await this.persistClaimed(jobId, claim, {
        status: lifecycle,
        quality,
        completedAt,
        units: state.units,
        events: state.events,
      }))) {
        this.logger.warn(`Hill Day job ${jobId}: claim superseded before the terminal write`);
        return 'running';
      }
      await this.prisma.wsHillDayDocument.update({
        where: { id: docId },
        data: {
          status: failed > 0 ? 'partial' : 'generated',
          generatedAt: completedAt,
          provenance: {
            jobId,
            generatedAt: completedAt.toISOString(),
            model: shared.credential?.model ?? null,
            credentialSource: shared.credential ? (shared.credential.usedTenantKey ? 'tenant' : 'platform') : null,
            sections: total,
            failed,
            quality,
          } as never,
        },
      });
      return lifecycle;
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Hill Day job ${jobId} failed: ${message}`);
      const cancelled = await this.cancelRequested(jobId).catch(() => false);
      const lifecycle: JobStatus['status'] = cancelled ? 'cancelled' : 'failed';
      state.seq += 1;
      state.events.push({
        seq: state.seq,
        event: cancelled ? 'complete' : 'failed',
        data: { documentId, reason: message, cancelled, at: new Date().toISOString() },
      });
      // Fenced too: a superseded holder must not fail the NEW holder's job.
      const published = await this.persistClaimed(jobId, claim, {
        status: lifecycle,
        error: cancelled ? null : message,
        quality: jobQuality(state.units),
        completedAt: new Date(),
        units: state.units,
        events: state.events,
      }).catch(() => false);
      if (published && documentId) {
        await this.prisma.wsHillDayDocument
          .update({ where: { id: documentId }, data: { status: 'partial' } })
          .catch(() => undefined);
      }
      return published ? lifecycle : 'running';
    }
  }

  /**
   * Fenced job-row write: lands only while `claim` is the job's current running
   * owner (same lease holder AND same claim generation). `false` means the claim
   * was superseded and this pass must stop rather than publish.
   */
  private async persistClaimed(
    jobId: string,
    claim: JobClaim,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    const { count } = await this.prisma.wsHillDayJob.updateMany({
      where: claimFence(jobId, claim),
      data: data as never,
    });
    return count === 1;
  }

  /**
   * Publish one generated unit's section + source provenance through a SINGLE
   * conditional statement that enforces both gates at once: the write lands only
   * while this claim is still the current running owner, and only while the
   * section has not been hand-edited while the provider call was out. `edited`
   * means a manual edit won and the generated text must be dropped.
   */
  private async publishUnit(
    jobId: string,
    claim: JobClaim,
    meetingId: string,
    section: MeetingSection,
    sourceSet: SourceSet,
  ): Promise<'published' | 'edited' | 'lost'> {
    const affected = await this.prisma.$executeRaw`
      UPDATE ws_hillday_meeting
         SET section = ${JSON.stringify(section)}::jsonb,
             source_set = ${JSON.stringify(sourceSet)}::jsonb
       WHERE id = ${meetingId}::uuid
         AND (section -> 'edited' ->> 'focus') IS DISTINCT FROM 'true'
         AND (section -> 'edited' ->> 'background') IS DISTINCT FROM 'true'
         AND EXISTS (
           SELECT 1 FROM ws_hillday_job
            WHERE id = ${jobId}::uuid
              AND lease_holder = ${claim.holder}
              AND attempt_count = ${claim.attempt}
              AND status = 'running'
         )
    `;
    if (affected === 1) return 'published';
    // No row written: either the claim is gone, or a manual edit appeared. The
    // claim check decides, and neither case may overwrite what is persisted.
    const held = await this.prisma.wsHillDayJob.findFirst({
      where: claimFence(jobId, claim),
      select: { id: true },
    });
    return held ? 'edited' : 'lost';
  }

  /** Has cancellation been requested for this job? */
  private async cancelRequested(jobId: string): Promise<boolean> {
    const row = await this.prisma.wsHillDayJob.findUnique({
      where: { id: jobId },
      select: { cancelRequestedAt: true },
    });
    return Boolean(row?.cancelRequestedAt);
  }

  /**
   * Append one unit event to the persisted log and persist unit progress, under
   * the claim fence. Returns false when this claim is no longer current — the
   * caller must then stop rather than keep writing.
   */
  private async emit(
    state: JobState,
    claim: JobClaim,
    event: JobEvent['event'],
    data: Record<string, unknown>,
  ): Promise<boolean> {
    state.seq += 1;
    const at = new Date().toISOString();
    const payload: JobEvent = { seq: state.seq, event, data: { ...data, at } };
    state.events.push(payload);
    if (event === 'unit') {
      const meetingId = String(data.meetingId ?? '');
      const idx = state.units.findIndex((u) => u.meetingId === meetingId);
      const next: JobUnit = {
        meetingId,
        state: (data.state as JobUnit['state']) ?? 'queued',
        sectionId: (data.sectionId as string | undefined) ?? meetingId,
        reason: (data.reason as string | undefined) ?? null,
        at,
      };
      if (idx >= 0) state.units[idx] = next;
      else state.units.push(next);
    }
    return this.persistClaimed(state.id, claim, {
      units: state.units as never,
      events: state.events as never,
    });
  }

  // ── one unit ──────────────────────────────────────────────────────────────

  private async sharedContext(
    tenantId: string,
    actorId: string,
    doc: { clientId: string; clientName: string; timeZone: string; lookbackDays: number },
  ): Promise<SharedRunContext> {
    const userId = await this.source.resolveUserId(actorId).catch(() => null);
    const firmName = (await this.source.tenantName(tenantId).catch(() => null)) ?? 'Your firm';
    let client = { name: doc.clientName, description: null as string | null };
    try {
      const row = await this.source.getClient(tenantId, userId, doc.clientId);
      if (row) {
        client = {
          name: row.name,
          description: [row.sectorTag, row.description ?? row.productDescription].filter(Boolean).join(' — ') || null,
        };
      }
    } catch (err) {
      this.logger.warn(`client read failed: ${(err as Error).message}`);
    }
    let objectives: SharedRunContext['objectives'] = { status: 'unavailable', items: [] };
    try {
      objectives = { status: 'ok', items: await this.source.listStrategies(tenantId, doc.clientId) };
    } catch (err) {
      this.logger.warn(`objectives read failed: ${(err as Error).message}`);
    }
    let credential: ResolvedAiCredential | null = null;
    let credentialError: string | null = null;
    try {
      credential = await this.credentials.resolveAnthropic(tenantId);
      if (!credential) credentialError = 'model_credential_missing';
    } catch (err) {
      credentialError = `model_credential_error: ${(err as Error).message}`;
    }
    return {
      firmName,
      client,
      objectives,
      credential,
      credentialError,
      userId,
      timeZone: doc.timeZone || 'America/New_York',
      lookbackDays: doc.lookbackDays || DEFAULT_LOOKBACK_DAYS,
    };
  }

  private async generateUnit(
    tenantId: string,
    meeting: MeetingRow,
    shared: SharedRunContext,
  ): Promise<{ section: MeetingSection; sourceSet: SourceSet }> {
    const event = meeting.event as CalendarEvent;
    const resolution = (meeting.resolution as MeetingResolution | null) ?? minimalResolution(meeting.id, event);
    const record = meeting.context as MeetingContextRecord | null;
    const units = buildCarryUnits(resolution, record);
    const carry = effectiveCarry(units);
    const note = record?.note ?? '';
    const lookbackDays = record?.lookbackDays ?? shared.lookbackDays;
    const doc = await this.prisma.wsHillDayDocument.findFirst({
      where: { id: (await this.prisma.wsHillDayMeeting.findUnique({ where: { id: meeting.id }, select: { documentId: true } }))?.documentId ?? '' },
      select: { clientId: true },
    });
    const clientId = doc?.clientId ?? '';

    // Correspondence: only the selected threads, and only inside the window.
    const threads: UnitPromptInput['threads'] = { status: 'ok', items: [] };
    const selectedThreadIds = record?.threadIds ?? [];
    if (selectedThreadIds.length) {
      try {
        const since = new Date(Date.now() - lookbackDays * 86_400_000);
        const addresses = resolution.attendees.map((a) => a.address).filter((a): a is string => Boolean(a));
        const rows = await this.source.listThreads(tenantId, shared.userId, clientId, addresses, since);
        const inWindow = rows.filter((r) => selectedThreadIds.includes(r.id));
        const messages = inWindow.length
          ? await this.source.threadMessages(tenantId, inWindow.map((r) => r.id))
          : [];
        const byThread = new Map<string, MessageRow[]>();
        for (const m of messages) {
          const list = byThread.get(m.threadId) ?? [];
          list.push(m);
          byThread.set(m.threadId, list);
        }
        threads.items = inWindow.map((r) => {
          const ref = toThreadRef(r, clientId);
          return { id: r.id, subject: r.subject, participants: ref.participants, messages: byThread.get(r.id) ?? [] };
        });
      } catch (err) {
        this.logger.warn(`correspondence read failed for meeting ${meeting.id}: ${(err as Error).message}`);
        threads.status = 'unavailable';
      }
    }

    let prior: UnitPromptInput['prior'] = [];
    try {
      const addresses = resolution.attendees
        .filter((a) => a.state === 'resolved')
        .map((a) => a.address)
        .filter((a): a is string => Boolean(a));
      prior = await this.source.priorMeetings(
        tenantId,
        shared.userId,
        clientId,
        addresses,
        new Date(event.startsAt),
        event.eventId,
      );
    } catch (err) {
      this.logger.warn(`prior engagement read failed: ${(err as Error).message}`);
    }

    const prompt = assembleUnitPrompt({
      firmName: shared.firmName,
      client: shared.client,
      event,
      timeZone: shared.timeZone,
      resolution,
      units,
      carry,
      note,
      objectives: shared.objectives,
      threads,
      prior,
      model: shared.credential?.model ?? null,
    });

    const flags: SectionFlag[] = [];
    if (resolution.state === 'partial') {
      flags.push({
        kind: 'partial_resolution',
        detail: resolution.office.memberId
          ? 'One or more attendees are not resolved to a Directory record.'
          : 'The office for this meeting is not resolved.',
      });
    }
    if (resolution.needsConfirmation) {
      const reason = confirmationReason(resolution);
      flags.push({
        kind: 'needs_confirmation',
        detail:
          reason === 'no_invite'
            ? 'Added manually from the Directory — confirm attendees before delivery.'
            : 'Scheduler-only invite — confirm attendees before delivery.',
      });
    }

    const generatedAt = new Date().toISOString();
    let section: MeetingSection;
    if (!shared.credential) {
      section = unavailableSection(meeting.id, shared.credentialError ?? 'model_credential_missing', flags, generatedAt, null);
    } else {
      const result = await this.callModel(shared.credential, prompt.system, prompt.user);
      if (!result.ok) {
        section = unavailableSection(meeting.id, result.reason, [...flags, { kind: 'generation_failed', detail: result.detail }], generatedAt, shared.credential.model);
      } else {
        let parsed = parseUnitOutput(result.text);
        if (!parsed) {
          const retry = await this.callModel(
            shared.credential,
            prompt.system,
            `${prompt.user}\n\nReturn ONLY the JSON object described in the instructions — no prose.`,
          );
          parsed = retry.ok ? parseUnitOutput(retry.text) : null;
        }
        if (!parsed) {
          section = unavailableSection(
            meeting.id,
            'provider_output_unparseable',
            [...flags, { kind: 'generation_failed', detail: 'The model did not return the expected JSON.' }],
            generatedAt,
            shared.credential.model,
          );
        } else {
          for (const sentence of parsed.unsupported.slice(0, MAX_UNSUPPORTED_FLAGS)) {
            flags.push({ kind: 'unsupported_claim', detail: sentence.trim().slice(0, 400) });
          }
          section = {
            sectionId: meeting.id,
            status: 'done',
            focus: parsed.focus || null,
            background: parsed.background || null,
            reason: null,
            flags,
            generatedAt,
            model: shared.credential.model,
            edited: { focus: false, background: false, at: null },
          };
        }
      }
    }

    return { section, sourceSet: prompt.sourceSet };
  }

  private async callModel(cred: ResolvedAiCredential, system: string, user: string): Promise<ModelResult> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UNIT_TIMEOUT_MS);
      try {
        const res = await fetch(ANTHROPIC_URL, {
          method: 'POST',
          headers: {
            'x-api-key': cred.secret,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify(prepareAnthropicRequest({
            model: cred.model,
            max_tokens: UNIT_MAX_TOKENS,
            system,
            messages: [{ role: 'user', content: user }],
          })),
          signal: controller.signal,
        });
        if (!res.ok) {
          // Status only: a provider error body can echo the prompt (client context).
          this.logger.warn(`Hill Day generation: provider HTTP ${res.status}`);
          if (res.status === 429 && attempt === 1) {
            // 429 means the provider refused the request, so one retry cannot
            // duplicate a charge. Any other status is ambiguous: a 5xx may have
            // been processed, so it is reported as uncertain and NEVER retried.
            await sleep(2_500);
            continue;
          }
          return res.status >= 500
            ? { ok: false, reason: PROVIDER_UNCERTAIN_REASON, detail: `Generation provider failed (HTTP ${res.status})` }
            : { ok: false, reason: 'provider_unavailable', detail: `Generation provider failed (HTTP ${res.status})` };
        }
        const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
        const text = (data.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('')
          .trim();
        return { ok: true, text };
      } catch (err) {
        // A thrown transport error (or a read failure after the response began)
        // happens AFTER the request may already have been accepted and charged.
        // Retrying it here would be an automatic second provider call for work
        // that may have already been done, so it is reported as UNCERTAIN and
        // never replayed: only a deliberate retry re-runs this unit.
        const aborted = (err as Error).name === 'AbortError';
        return {
          ok: false,
          reason: aborted ? 'provider_timeout' : PROVIDER_UNCERTAIN_REASON,
          detail: aborted ? `Generation timed out after ${UNIT_TIMEOUT_MS / 1000}s` : (err as Error).message,
        };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private async assertDoc(tenantId: string, documentId: string, actorId: string) {
    return admitHillDayDocument(this.prisma, this.source, tenantId, actorId, documentId);
  }
}

function unavailableSection(
  sectionId: string,
  reason: string,
  flags: SectionFlag[],
  generatedAt: string,
  model: string | null,
): MeetingSection {
  return {
    sectionId,
    status: 'unavailable',
    focus: null,
    background: null,
    reason,
    flags: flags.some((f) => f.kind === 'generation_failed')
      ? flags
      : [...flags, { kind: 'generation_failed', detail: reason }],
    generatedAt,
    model,
    edited: { focus: false, background: false, at: null },
  };
}

/** When generation is invoked before resolution ran: facts from the calendar only. */
function minimalResolution(meetingId: string, event: CalendarEvent): MeetingResolution {
  const attendees = (event.attendees ?? [])
    .map((a) => normalizeAddress(a.address))
    .filter((a): a is string => Boolean(a))
    .map((address) => ({
      attendeeId: `att_${address}`,
      address,
      state: 'unresolved' as const,
      stafferId: null,
      name: address,
      role: null,
      issueAreas: [],
      topics: [],
      directoryOffice: null,
      inviteOffice: null,
      committee: null,
      detail: 'Resolution has not run for this meeting.',
      manual: false,
      correction: null,
      directoryRecord: null,
    }));
  const office = { ...emptyOffice(), room: event.location ?? null };
  const roll = rollUpMeeting(attendees, office);
  return {
    meetingId,
    eventId: event.eventId,
    state: 'partial',
    office,
    attendees,
    internalParticipants: [],
    needsConfirmation: roll.needsConfirmation,
    resolvedAt: new Date().toISOString(),
    sources: [{ source: 'directory', status: 'unavailable', detail: 'Resolution has not run' }],
  };
}
