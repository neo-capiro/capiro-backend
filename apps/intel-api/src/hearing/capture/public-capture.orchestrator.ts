import {
  completionStatusForCapture,
  mergeCaptureGaps,
  publicCaptureIdempotencyKey,
  transitionCapture,
  type CaptureGap,
  type CaptureLease,
  type CaptureStateSnapshot,
  type PublicHearingCaptureStatus,
} from './public-hearing-capture-state.js';
import {
  classifyStreamResolution,
  type ClassifiedStreamResolution,
  type ResolverResultLike,
  type StreamResolutionState,
} from './stream-resolution-policy.js';
import { nextStreamPreflightAt } from './stream-preflight-policy.js';
import { STATE_CAPTURE_LINK_ONLY } from '../state-capture-policy.js';

export interface PublicHearingCaptureEvent {
  id: string;
  eventStatus: string;
  publicAccess: string;
  scheduledStart?: Date;
  officialPageUrl?: string;
}

export interface PublicCaptureRecord extends CaptureStateSnapshot {
  id: string;
  hearingId: string;
  resolutionState: StreamResolutionState;
  lastResolutionAt?: Date;
  consecutiveSourceErrors: number;
  nextPreflightAt?: Date;
  lease?: CaptureLease;
  capturedMs: number;
  gaps: CaptureGap[];
}

export interface PublicCaptureDemand {
  activeSubscriptionCount: number;
  /** Enables an administrator-approved capture-all-public-events policy. */
  globalCoverageRequested: boolean;
}

export interface CaptureLeaseAcquireResult {
  acquired: boolean;
  capture: PublicCaptureRecord;
  lease?: CaptureLease;
}

/**
 * Persistence seam for the Phase 2 global capture repository. Every mutating
 * method must use optimistic versioning; fenced methods must additionally check
 * owner and fencing token in the same database statement.
 */
export interface PublicCaptureStorePort {
  assertCaptureAllowed?(hearingId: string): Promise<void>;
  getHearing(hearingId: string): Promise<PublicHearingCaptureEvent | null>;
  getDemand(hearingId: string): Promise<PublicCaptureDemand>;
  ensureCapture(input: {
    hearingId: string;
    idempotencyKey: string;
    scheduledStart?: Date;
    now: Date;
  }): Promise<PublicCaptureRecord>;
  saveState(input: {
    captureId: string;
    expectedVersion: number;
    next: CaptureStateSnapshot;
  }): Promise<PublicCaptureRecord>;
  recordResolution(input: {
    captureId: string;
    expectedVersion: number;
    classified: ClassifiedStreamResolution;
    attemptedAt: Date;
    nextPreflightAt?: Date;
  }): Promise<PublicCaptureRecord>;
  recordFencedResolution(input: {
    captureId: string;
    ownerId: string;
    fencingToken: number;
    expectedVersion: number;
    classified: ClassifiedStreamResolution;
    attemptedAt: Date;
    nextPreflightAt?: Date;
  }): Promise<PublicCaptureRecord>;
  tryAcquireLease(input: {
    captureId: string;
    ownerId: string;
    now: Date;
    leaseDurationMs: number;
  }): Promise<CaptureLeaseAcquireResult>;
  renewLease(input: {
    captureId: string;
    ownerId: string;
    fencingToken: number;
    now: Date;
    leaseDurationMs: number;
  }): Promise<CaptureLease>;
  releaseLease(input: {
    captureId: string;
    ownerId: string;
    fencingToken: number;
    now: Date;
  }): Promise<void>;
  saveFencedState(input: {
    captureId: string;
    ownerId: string;
    fencingToken: number;
    expectedVersion: number;
    next: CaptureStateSnapshot;
    /** Optional atomic runtime progress written under the same fencing check. */
    capturedMs?: number;
    gaps?: CaptureGap[];
  }): Promise<PublicCaptureRecord>;
}

export interface PublicStreamResolverPort {
  resolve(input: { pageUrl?: string; hearingId?: string }): Promise<ResolverResultLike>;
}

export interface PublicCaptureQueuePort {
  enqueue(input: {
    dedupeKey: string;
    captureId: string;
    hearingId: string;
    /** The worker must resolve again in its own network environment. */
    mustReresolve: true;
  }): Promise<{ enqueued: boolean; jobId?: string }>;
  schedulePreflight(input: { dedupeKey: string; hearingId: string; dueAt: Date }): Promise<void>;
}

export interface PublicCaptureRuntimePort {
  run(input: {
    captureId: string;
    hearingId: string;
    lease: Pick<CaptureLease, 'ownerId' | 'fencingToken'>;
    mediaUrl: string;
    officialPageUrl?: string;
    /** Existing canonical timeline cursor when a fenced replacement worker resumes. */
    timelineOffsetMs: number;
    signal: AbortSignal;
  }): Promise<{
    /** Total canonical timeline cursor, including timelineOffsetMs. */
    capturedMs: number;
    /** Gaps observed by this runtime attempt. */
    gaps: CaptureGap[];
  }>;
}

export interface PublicCaptureRuntimeFailure extends Error {
  /** Audio that was not represented by a canonical transcript segment. */
  captureGaps?: CaptureGap[];
  /** Best-known canonical timeline cursor when the runtime stopped. */
  capturedMs?: number;
}

export interface PublicCaptureAttemptPort {
  recordAttempt(input: {
    captureId: string;
    startedAt?: Date;
    endedAt?: Date;
    workerLeaseOwner?: string;
    outcome?: 'succeeded' | 'failed' | 'superseded' | 'timed_out';
    failureCode?: string;
    failureDetail?: string;
    capturedMs?: number;
  }): Promise<unknown>;
  countAttempts(captureId: string): Promise<number>;
}

export interface PublicCaptureRetryQueuePort {
  scheduleRetry(input: {
    dedupeKey: string;
    captureId: string;
    hearingId: string;
    dueAt: Date;
    mustReresolve: true;
  }): Promise<void>;
}

export type CaptureReconcileOutcome =
  | { action: 'NOT_FOUND' }
  | { action: 'NO_CAPTURE_DEMAND' }
  | { action: 'TERMINAL'; captureId: string; status: PublicHearingCaptureStatus }
  | { action: 'CAPTURE_IN_PROGRESS'; captureId: string }
  | { action: 'PREFLIGHT_SCHEDULED'; captureId: string; dueAt: Date }
  | {
      action: 'WAITING_FOR_STREAM';
      captureId: string;
      dueAt?: Date;
      resolution: ClassifiedStreamResolution;
    }
  | { action: 'BROWSER_ONLY'; captureId: string; resolution: ClassifiedStreamResolution }
  | { action: 'BLOCKED'; captureId: string; resolution: ClassifiedStreamResolution }
  | { action: 'CAPTURE_JOB_ENQUEUED'; captureId: string; enqueued: boolean; jobId?: string };

export interface PublicCaptureOrchestratorOptions {
  now?: () => Date;
  delayedStartGraceMs?: number;
}

/**
 * Scheduler-side orchestrator. It creates one global capture record, runs
 * background preflight, and enqueues one idempotent worker job. No tenant id or
 * client context is copied into the public capture layer.
 */
export class PublicCaptureOrchestrator {
  private readonly now: () => Date;
  private readonly delayedStartGraceMs: number;

  constructor(
    private readonly store: PublicCaptureStorePort,
    private readonly resolver: PublicStreamResolverPort,
    private readonly queue: PublicCaptureQueuePort,
    options: PublicCaptureOrchestratorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.delayedStartGraceMs = options.delayedStartGraceMs ?? 90 * 60 * 1000;
  }

  async reconcile(hearingId: string): Promise<CaptureReconcileOutcome> {
    const hearing = await this.store.getHearing(hearingId);
    if (!hearing) return { action: 'NOT_FOUND' };

    const demand = await this.store.getDemand(hearingId);
    if (demand.activeSubscriptionCount <= 0 && !demand.globalCoverageRequested) {
      return { action: 'NO_CAPTURE_DEMAND' };
    }

    const now = this.now();
    let capture = await this.store.ensureCapture({
      hearingId,
      idempotencyKey: publicCaptureIdempotencyKey(hearingId),
      scheduledStart: hearing.scheduledStart,
      now,
    });
    if (isTerminal(capture.status)) {
      return { action: 'TERMINAL', captureId: capture.id, status: capture.status };
    }
    // The scheduler must not advance the optimistic version underneath a
    // four-hour worker. That worker owns resolution and finalization until its
    // lease ends; an expired lease remains eligible for ordinary recovery.
    if (capture.lease && capture.lease.expiresAt.getTime() > now.getTime()) {
      return { action: 'CAPTURE_IN_PROGRESS', captureId: capture.id };
    }

    if (isCanceled(hearing.eventStatus)) {
      capture = await this.moveUnfenced(capture, 'CANCELED', now);
      return { action: 'TERMINAL', captureId: capture.id, status: capture.status };
    }
    if (isClosed(hearing.publicAccess)) {
      capture = await this.moveUnfenced(capture, 'BLOCKED', now);
      return {
        action: 'BLOCKED',
        captureId: capture.id,
        resolution: classifyStreamResolution(
          { status: 'unresolvable', note: 'Closed or classified proceeding' },
          {
            now,
            scheduledStart: hearing.scheduledStart,
            eventStatus: hearing.eventStatus,
            publicAccess: hearing.publicAccess,
          },
        ),
      };
    }

    const nextDue = nextStreamPreflightAt({
      now,
      scheduledStart: hearing.scheduledStart,
      eventStatus: hearing.eventStatus,
      resolutionState: capture.resolutionState,
      lastAttemptAt: capture.lastResolutionAt,
      consecutiveSourceErrors: capture.consecutiveSourceErrors,
      config: { delayedStartGraceMs: this.delayedStartGraceMs },
    });
    if (nextDue && nextDue.getTime() > now.getTime()) {
      await this.queue.schedulePreflight({
        dedupeKey: `hearing-stream-preflight:v1:${hearingId.toLowerCase()}`,
        hearingId,
        dueAt: nextDue,
      });
      return { action: 'PREFLIGHT_SCHEDULED', captureId: capture.id, dueAt: nextDue };
    }

    if (capture.status === 'SCHEDULED' || capture.status === 'WAITING_FOR_STREAM') {
      capture = await this.moveUnfenced(capture, 'PREPARING', now);
    }

    let raw: ResolverResultLike;
    try {
      raw = await this.resolver.resolve({
        pageUrl: hearing.officialPageUrl,
        hearingId: hearing.id,
      });
    } catch (error) {
      raw = { status: 'unresolvable', note: boundedError(error) };
    }
    const classified = classifyStreamResolution(raw, {
      now,
      scheduledStart: hearing.scheduledStart,
      delayedStartGraceMs: this.delayedStartGraceMs,
      eventStatus: hearing.eventStatus,
      publicAccess: hearing.publicAccess,
    });
    const afterAttempt = nextStreamPreflightAt({
      now,
      scheduledStart: hearing.scheduledStart,
      eventStatus: hearing.eventStatus,
      resolutionState: classified.state,
      lastAttemptAt: now,
      consecutiveSourceErrors:
        classified.state === 'SOURCE_ERROR' ? capture.consecutiveSourceErrors + 1 : 0,
      config: { delayedStartGraceMs: this.delayedStartGraceMs },
    });
    capture = await this.store.recordResolution({
      captureId: capture.id,
      expectedVersion: capture.version,
      classified,
      attemptedAt: now,
      nextPreflightAt: afterAttempt ?? undefined,
    });

    if (classified.state === 'READY_FOR_SERVER_CAPTURE' && classified.media) {
      if (capture.status === 'PREPARING' || capture.status === 'WAITING_FOR_STREAM') {
        capture = await this.moveUnfenced(capture, 'READY', now);
      }
      const queued = await this.queue.enqueue({
        dedupeKey: publicCaptureIdempotencyKey(hearingId),
        captureId: capture.id,
        hearingId,
        mustReresolve: true,
      });
      return {
        action: 'CAPTURE_JOB_ENQUEUED',
        captureId: capture.id,
        enqueued: queued.enqueued,
        jobId: queued.jobId,
      };
    }

    if (classified.state === 'WAITING_FOR_STREAM' || classified.state === 'SOURCE_ERROR') {
      if (capture.status === 'PREPARING')
        capture = await this.moveUnfenced(capture, 'WAITING_FOR_STREAM', now);
      if (afterAttempt) {
        await this.queue.schedulePreflight({
          dedupeKey: `hearing-stream-preflight:v1:${hearingId.toLowerCase()}`,
          hearingId,
          dueAt: afterAttempt,
        });
      }
      return {
        action: 'WAITING_FOR_STREAM',
        captureId: capture.id,
        dueAt: afterAttempt ?? undefined,
        resolution: classified,
      };
    }

    if (classified.state === 'BROWSER_CAPTURE_ONLY') {
      capture = await this.moveUnfenced(capture, 'BLOCKED', now);
      return { action: 'BROWSER_ONLY', captureId: capture.id, resolution: classified };
    }

    capture = await this.moveUnfenced(
      capture,
      classified.state === 'CANCELED' ? 'CANCELED' : 'BLOCKED',
      now,
    );
    return { action: 'BLOCKED', captureId: capture.id, resolution: classified };
  }

  private async moveUnfenced(
    capture: PublicCaptureRecord,
    status: PublicHearingCaptureStatus,
    now: Date,
  ): Promise<PublicCaptureRecord> {
    const next = transitionCapture(capture, status, now);
    return this.store.saveState({ captureId: capture.id, expectedVersion: capture.version, next });
  }
}

export interface PublicCaptureWorkerOptions {
  assertRuntimeAllowed?: () => Promise<void>;
  now?: () => Date;
  leaseDurationMs?: number;
  leaseRenewIntervalMs?: number;
  delayedStartGraceMs?: number;
  attempts?: PublicCaptureAttemptPort;
  retryQueue?: PublicCaptureRetryQueuePort;
  /** Maximum total runtime attempts, including the initial attempt. */
  maxAttempts?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

export type PublicCaptureWorkerOutcome =
  | { action: 'LEASE_HELD_BY_OTHER' }
  | { action: 'NOT_FOUND' }
  | { action: 'TERMINAL'; status: PublicHearingCaptureStatus }
  | { action: 'NO_LONGER_CAPTURABLE'; resolution: ClassifiedStreamResolution }
  | {
      action: 'COMPLETE';
      status: 'COMPLETE' | 'COMPLETE_WITH_GAPS';
      capturedMs: number;
      gaps: CaptureGap[];
    }
  | {
      action: 'RECOVERING';
      captureId: string;
      dueAt: Date;
      attemptNumber: number;
      gaps: CaptureGap[];
    }
  | { action: 'FAILED'; error: string };

/**
 * Worker-side coordinator. It acquires a fenced global lease, re-resolves the
 * stream in the worker's own egress environment, and never receives tenant
 * context or a stale media URL from the queue.
 */
export class PublicCaptureWorkerCoordinator {
  private readonly assertRuntimeAllowed?: () => Promise<void>;
  private readonly now: () => Date;
  private readonly leaseDurationMs: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly delayedStartGraceMs: number;
  private readonly attempts?: PublicCaptureAttemptPort;
  private readonly retryQueue?: PublicCaptureRetryQueuePort;
  private readonly maxAttempts: number;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  constructor(
    private readonly store: PublicCaptureStorePort,
    private readonly resolver: PublicStreamResolverPort,
    private readonly runtime: PublicCaptureRuntimePort,
    options: PublicCaptureWorkerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.assertRuntimeAllowed = options.assertRuntimeAllowed;
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.leaseRenewIntervalMs = options.leaseRenewIntervalMs ?? 20_000;
    this.delayedStartGraceMs = options.delayedStartGraceMs ?? 90 * 60 * 1000;
    this.attempts = options.attempts;
    this.retryQueue = options.retryQueue;
    this.maxAttempts = boundedPositiveInteger(options.maxAttempts ?? 3, 20, 'maxAttempts');
    this.initialRetryDelayMs = boundedPositiveInteger(
      options.initialRetryDelayMs ?? 5_000,
      24 * 60 * 60 * 1000,
      'initialRetryDelayMs',
    );
    this.maxRetryDelayMs = Math.max(
      this.initialRetryDelayMs,
      boundedPositiveInteger(
        options.maxRetryDelayMs ?? 5 * 60 * 1000,
        24 * 60 * 60 * 1000,
        'maxRetryDelayMs',
      ),
    );
  }

  async run(input: {
    captureId: string;
    hearingId: string;
    workerId: string;
  }): Promise<PublicCaptureWorkerOutcome> {
    const hearing = await this.store.getHearing(input.hearingId);
    if (!hearing) return { action: 'NOT_FOUND' };
    const acquired = await this.store.tryAcquireLease({
      captureId: input.captureId,
      ownerId: input.workerId,
      now: this.now(),
      leaseDurationMs: this.leaseDurationMs,
    });
    if (!acquired.acquired || !acquired.lease) return { action: 'LEASE_HELD_BY_OTHER' };

    let capture = acquired.capture;
    let lease = acquired.lease;
    if (capture.hearingId !== input.hearingId) {
      try {
        await this.store.releaseLease({
          captureId: input.captureId,
          ownerId: input.workerId,
          fencingToken: lease.fencingToken,
          now: this.now(),
        });
      } finally {
        throw new Error(STATE_CAPTURE_LINK_ONLY);
      }
    }
    if (isTerminal(capture.status)) {
      try {
        await this.store.releaseLease({
          captureId: input.captureId,
          ownerId: input.workerId,
          fencingToken: lease.fencingToken,
          now: this.now(),
        });
      } catch {
        // The row is already terminal; a stale lease is harmless here.
      }
      return { action: 'TERMINAL', status: capture.status };
    }
    if (capture.status === 'CAPTURING') {
      const recovering = transitionCapture(capture, 'RECOVERING', this.now());
      capture = await this.store.saveFencedState({
        captureId: capture.id,
        ownerId: input.workerId,
        fencingToken: lease.fencingToken,
        expectedVersion: capture.version,
        next: recovering,
      });
    }
    const abort = new AbortController();
    const attemptStartedAt = this.now();
    const attemptNumber = this.attempts ? (await this.attempts.countAttempts(capture.id)) + 1 : 1;
    let runtimeStarted = false;
    let renewFailure: Error | undefined;
    let renewing = false;
    let leaseDeadline: ReturnType<typeof setTimeout> | undefined;
    const armLeaseDeadline = () => {
      if (leaseDeadline) clearTimeout(leaseDeadline);
      leaseDeadline = setTimeout(
        () => {
          renewFailure = new Error('Public hearing capture lease expired before renewal');
          abort.abort(renewFailure);
        },
        Math.max(0, lease.expiresAt.getTime() - this.now().getTime()),
      );
    };
    armLeaseDeadline();
    let checkingAccess = false;
    const checkAccess = async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await this.assertRuntimeAllowed?.();
            await this.store.assertCaptureAllowed?.(input.hearingId);
          })(),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error('CAPTURE_ACCESS_CHECK_UNAVAILABLE')),
              5000,
            );
          }),
        ]);
      } finally {
        if (deadline) clearTimeout(deadline);
      }
    };
    const accessChecks = setInterval(() => {
      if (checkingAccess || abort.signal.aborted) return;
      checkingAccess = true;
      void checkAccess()
        .catch((error) => abort.abort(error))
        .finally(() => {
          checkingAccess = false;
        });
    }, 20000);
    const renewal = setInterval(() => {
      if (renewing || abort.signal.aborted) return;
      renewing = true;
      void this.store
        .renewLease({
          captureId: input.captureId,
          ownerId: input.workerId,
          fencingToken: lease.fencingToken,
          now: this.now(),
          leaseDurationMs: this.leaseDurationMs,
        })
        .then((next) => {
          if (abort.signal.aborted) return;
          lease = next;
          armLeaseDeadline();
        })
        .catch((error: unknown) => {
          renewFailure = error instanceof Error ? error : new Error(String(error));
          abort.abort(renewFailure);
        })
        .finally(() => {
          renewing = false;
        });
    }, this.leaseRenewIntervalMs);

    try {
      await checkAccess();
      let raw: ResolverResultLike;
      try {
        raw = await this.resolver.resolve({
          pageUrl: hearing.officialPageUrl,
          hearingId: hearing.id,
        });
      } catch (error) {
        raw = { status: 'unresolvable', note: boundedError(error) };
      }
      const resolution = classifyStreamResolution(raw, {
        now: this.now(),
        scheduledStart: hearing.scheduledStart,
        delayedStartGraceMs: this.delayedStartGraceMs,
        eventStatus: hearing.eventStatus,
        publicAccess: hearing.publicAccess,
      });
      capture = await this.store.recordFencedResolution({
        captureId: capture.id,
        ownerId: input.workerId,
        fencingToken: lease.fencingToken,
        expectedVersion: capture.version,
        classified: resolution,
        attemptedAt: this.now(),
      });
      if (resolution.state !== 'READY_FOR_SERVER_CAPTURE' || !resolution.media) {
        const waiting =
          resolution.state === 'WAITING_FOR_STREAM' || resolution.state === 'SOURCE_ERROR';
        const mapped: PublicHearingCaptureStatus = waiting
          ? capture.status === 'PREPARING' || capture.status === 'WAITING_FOR_STREAM'
            ? 'WAITING_FOR_STREAM'
            : 'PREPARING'
          : resolution.state === 'CANCELED'
            ? 'CANCELED'
            : 'BLOCKED';
        const next = transitionCapture(capture, mapped, this.now());
        await this.store.saveFencedState({
          captureId: capture.id,
          ownerId: input.workerId,
          fencingToken: lease.fencingToken,
          expectedVersion: capture.version,
          next,
        });
        return { action: 'NO_LONGER_CAPTURABLE', resolution };
      }

      if (capture.status === 'SCHEDULED') {
        const preparing = transitionCapture(capture, 'PREPARING', this.now());
        capture = await this.store.saveFencedState({
          captureId: capture.id,
          ownerId: input.workerId,
          fencingToken: lease.fencingToken,
          expectedVersion: capture.version,
          next: preparing,
        });
      }
      if (capture.status === 'PREPARING' || capture.status === 'WAITING_FOR_STREAM') {
        const ready = transitionCapture(capture, 'READY', this.now());
        capture = await this.store.saveFencedState({
          captureId: capture.id,
          ownerId: input.workerId,
          fencingToken: lease.fencingToken,
          expectedVersion: capture.version,
          next: ready,
        });
      }
      const capturing = transitionCapture(capture, 'CAPTURING', this.now());
      capture = await this.store.saveFencedState({
        captureId: capture.id,
        ownerId: input.workerId,
        fencingToken: lease.fencingToken,
        expectedVersion: capture.version,
        next: capturing,
      });

      runtimeStarted = true;
      const result = await this.runtime.run({
        captureId: capture.id,
        hearingId: hearing.id,
        lease: { ownerId: input.workerId, fencingToken: lease.fencingToken },
        mediaUrl: resolution.media.url,
        officialPageUrl: hearing.officialPageUrl,
        timelineOffsetMs: capture.capturedMs,
        signal: abort.signal,
      });
      if (renewFailure) throw renewFailure;
      if (result.capturedMs <= capture.capturedMs) {
        throw new Error('Capture runtime completed without new audio');
      }
      const allGaps = result.gaps.reduce(
        (current, gap) => mergeCaptureGaps(current, gap),
        capture.gaps,
      );

      const finalizing = transitionCapture(capture, 'FINALIZING', this.now());
      capture = await this.store.saveFencedState({
        captureId: capture.id,
        ownerId: input.workerId,
        fencingToken: lease.fencingToken,
        expectedVersion: capture.version,
        next: finalizing,
        capturedMs: result.capturedMs,
        gaps: allGaps,
      });
      const finalStatus = completionStatusForCapture({
        capturedMs: result.capturedMs,
        gaps: allGaps,
      });
      const completed = transitionCapture(capture, finalStatus, this.now());
      await this.store.saveFencedState({
        captureId: capture.id,
        ownerId: input.workerId,
        fencingToken: lease.fencingToken,
        expectedVersion: capture.version,
        next: completed,
      });
      try {
        await this.recordAttempt({
          captureId: capture.id,
          workerLeaseOwner: input.workerId,
          startedAt: attemptStartedAt,
          endedAt: this.now(),
          outcome: 'succeeded',
          capturedMs: result.capturedMs,
        });
      } catch {
        // Capture completion is already durably fenced; history is best-effort.
      }
      return {
        action: 'COMPLETE',
        status: finalStatus as 'COMPLETE' | 'COMPLETE_WITH_GAPS',
        capturedMs: result.capturedMs,
        gaps: allGaps,
      };
    } catch (error) {
      const message = boundedError(error);
      const failure = asRuntimeFailure(error);
      const allGaps = mergeRuntimeFailureGaps(capture.gaps, failure);
      const recoveryCursor = Math.max(
        capture.capturedMs,
        failure.capturedMs ?? capture.capturedMs,
        ...allGaps.map((gap) => gap.endMs),
      );
      const canScheduleRecovery =
        runtimeStarted &&
        !abort.signal.aborted &&
        !renewFailure &&
        !isCanceled(hearing.eventStatus) &&
        !isClosed(hearing.publicAccess) &&
        Boolean(this.attempts && this.retryQueue) &&
        attemptNumber < this.maxAttempts;

      try {
        await this.recordAttempt({
          captureId: capture.id,
          workerLeaseOwner: input.workerId,
          startedAt: attemptStartedAt,
          endedAt: this.now(),
          outcome: 'failed',
          failureCode: abort.signal.aborted
            ? 'CAPTURE_LEASE_OR_RUNTIME_ABORT'
            : 'CAPTURE_RUNTIME_FAILED',
          failureDetail: message,
          capturedMs: recoveryCursor,
        });
      } catch {
        // Attempt history is best-effort; fenced state remains authoritative.
      }

      // Losing ownership is a retryable task failure, not permission to mark
      // the shared capture terminal. Let the durable queue arrange takeover.
      if (renewFailure) throw renewFailure;

      try {
        if (canScheduleRecovery) {
          const recovering = transitionCapture(capture, 'RECOVERING', this.now());
          const next = await this.store.saveFencedState({
            captureId: input.captureId,
            ownerId: input.workerId,
            fencingToken: lease.fencingToken,
            expectedVersion: capture.version,
            next: {
              ...recovering,
              failureCode: 'CAPTURE_RUNTIME_RECOVERING',
              failureDetail: message,
            },
            capturedMs: recoveryCursor,
            gaps: allGaps,
          });
          const dueAt = new Date(
            this.now().getTime() +
              Math.min(
                this.maxRetryDelayMs,
                this.initialRetryDelayMs * 2 ** Math.max(0, attemptNumber - 1),
              ),
          );
          await this.retryQueue!.scheduleRetry({
            dedupeKey: `public-hearing-capture-retry:v1:${next.id}:${attemptNumber + 1}`,
            captureId: next.id,
            hearingId: next.hearingId,
            dueAt,
            mustReresolve: true,
          });
          return {
            action: 'RECOVERING',
            captureId: next.id,
            dueAt,
            attemptNumber,
            gaps: allGaps,
          };
        }

        const failed = transitionCapture(capture, 'FAILED', this.now(), {
          code: abort.signal.aborted ? 'CAPTURE_LEASE_OR_RUNTIME_ABORT' : 'CAPTURE_RUNTIME_FAILED',
          detail: message,
        });
        await this.store.saveFencedState({
          captureId: input.captureId,
          ownerId: input.workerId,
          fencingToken: lease.fencingToken,
          expectedVersion: capture.version,
          next: failed,
          capturedMs: recoveryCursor,
          gaps: allGaps,
        });
      } catch {
        // A stale worker must not overwrite the replacement worker's state.
      }
      return { action: 'FAILED', error: message };
    } finally {
      clearInterval(accessChecks);
      clearInterval(renewal);
      if (leaseDeadline) clearTimeout(leaseDeadline);
      abort.abort();
      try {
        await this.store.releaseLease({
          captureId: input.captureId,
          ownerId: input.workerId,
          fencingToken: lease.fencingToken,
          now: this.now(),
        });
      } catch {
        // Lease may already have expired or been fenced off.
      }
    }
  }

  private async recordAttempt(
    input: Parameters<PublicCaptureAttemptPort['recordAttempt']>[0],
  ): Promise<void> {
    if (!this.attempts) return;
    await this.attempts.recordAttempt(input);
  }
}

function isCanceled(status: string): boolean {
  const value = status.trim().toUpperCase();
  return value === 'CANCELED' || value === 'CANCELLED';
}

function isClosed(access: string): boolean {
  const value = access.trim().toUpperCase();
  return value === 'CLOSED' || value === 'CLASSIFIED';
}

function isTerminal(status: PublicHearingCaptureStatus): boolean {
  return ['COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED', 'CANCELED', 'BLOCKED'].includes(status);
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 1_000);
}

function asRuntimeFailure(error: unknown): PublicCaptureRuntimeFailure {
  if (error instanceof Error) return error as PublicCaptureRuntimeFailure;
  return Object.assign(new Error(String(error)), {
    capturedMs: undefined,
    captureGaps: undefined,
  });
}

function mergeRuntimeFailureGaps(
  existing: CaptureGap[],
  failure: PublicCaptureRuntimeFailure,
): CaptureGap[] {
  return (failure.captureGaps ?? []).reduce(
    (gaps, gap) => mergeCaptureGaps(gaps, gap),
    [...existing],
  );
}

function boundedPositiveInteger(value: number, max: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`);
  const integer = Math.floor(value);
  if (integer > max) throw new Error(`${field} must be at most ${max}`);
  return integer;
}
