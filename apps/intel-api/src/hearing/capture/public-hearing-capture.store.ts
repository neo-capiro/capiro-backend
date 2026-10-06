import {
  blockedRecoveryCaptureSql,
  blockedRecoveryCandidateSql,
  blockedRecoveryProbeDueSql,
  type BlockedRecoveryCandidate,
  type BlockedRecoveryProbe,
} from './blocked-source-recovery.js';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { approvedPublicCapture, publicAudioEnabled } from './public-capture-permission.js';
import type {
  CaptureLeaseAcquireResult,
  PublicCaptureDemand,
  PublicCaptureRecord,
  PublicCaptureStorePort,
  PublicHearingCaptureEvent,
} from './public-capture.orchestrator.js';
import type {
  CaptureGap,
  CaptureLease,
  CaptureStateSnapshot,
  PublicHearingCaptureStatus,
} from './public-hearing-capture-state.js';
import type { ClassifiedStreamResolution } from './stream-resolution-policy.js';
import {
  capturableHearingView,
  isEnabledFlagValue,
  stateCaptureEnabled,
} from '../state-capture-policy.js';

/** Planner/worker agreement window for the DB capture-all switch. */
const CAPTURE_ALL_CACHE_MS = 30_000;

type CaptureRow = Omit<PublicCaptureRecord, 'status' | 'lease' | 'gaps'> & {
  status: string;
  domainStatus?: string | null;
  scheduledStart?: Date | null;
  actualStart?: Date | null;
  actualEnd?: Date | null;
  workerLeaseOwner?: string | null;
  leaseExpiresAt?: Date | null;
  leaseAcquiredAt?: Date | null;
  fencingToken: number;
  gaps: unknown;
  resolutionReasonCode?: string | null;
  resolutionCapturePolicy?: string | null;
  resolutionProvider?: string | null;
  resolutionReference?: string | null;
  terminalReasonCode?: string | null;
};

const CAPTURE_COLUMNS = `id, hearing_id AS "hearingId", status,
  domain_status AS "domainStatus", version,
  scheduled_start AS "scheduledStart", actual_start AS "actualStart", actual_end AS "actualEnd",
  failure_code AS "failureCode", failure_detail AS "failureDetail",
  resolution_state AS "resolutionState", last_resolution_at AS "lastResolutionAt",
  resolution_reason_code AS "resolutionReasonCode",
  resolution_capture_policy AS "resolutionCapturePolicy",
  resolution_provider AS "resolutionProvider",
  resolution_reference AS "resolutionReference",
  terminal_reason_code AS "terminalReasonCode",
  consecutive_source_errors AS "consecutiveSourceErrors", next_preflight_at AS "nextPreflightAt",
  worker_lease_owner AS "workerLeaseOwner", lease_expires_at AS "leaseExpiresAt",
  lease_acquired_at AS "leaseAcquiredAt", fencing_token AS "fencingToken",
  captured_ms AS "capturedMs", gaps`;

/**
 * Automatic server-capture demand: a subscription only asks the SERVER to
 * attend when attendance_mode='automatic' AND it has an explicit schedule
 * origin (user-scheduled or rule-scheduled) — the same predicate as
 * public-capture-permission.ts. Browser attendance rows (Wave 1 writer:
 * attendance_mode='browser', scheduled_by_user=false) and bare notification
 * interest must not create server capture demand. cancelSchedule clears
 * scheduled_by_user but keeps scheduled_by_rule_id, so a surviving rule
 * remains automatic demand after manual cancellation.
 */
const AUTOMATIC_DEMAND_SQL = `s.attendance_mode='automatic' AND (s.scheduled_by_user OR s.scheduled_by_rule_id IS NOT NULL)`;

/**
 * Event types eligible for PUBLIC automatic capture, matched against
 * LOWER(h.type) with exact string equality. `committee_hearing.type` stores
 * the source's own wording verbatim (the Senate schedule adapter records the
 * official string), so the official `Open Hearing` / `Open Business Meeting`
 * must be listed here — the same fold normalizeEventType already encodes.
 * Exact equality means closed/executive variants ('Closed Hearing', ...)
 * never match, and unknown wordings stay ineligible.
 */
export const ELIGIBLE_PUBLIC_HEARING_EVENT_TYPES = [
  'hearing',
  'markup',
  'meeting',
  'business meeting',
  'business_meeting',
  'roundtable',
  'forum',
  'open hearing',
  'open business meeting',
] as const;

export class OptimisticCaptureWriteError extends Error {
  constructor() {
    super('optimistic concurrency conflict for public hearing capture');
  }
}

export class StaleCaptureFencingTokenError extends Error {
  constructor() {
    super('stale fencing token for public hearing capture');
  }
}

@Injectable()
export class PublicHearingCaptureStore implements PublicCaptureStorePort {
  private readonly logger = new Logger(PublicHearingCaptureStore.name);
  private captureAllCache?: { value: boolean; expiresAt: number };

  constructor(private readonly prisma: PrismaService) {}

  async getCapture(captureId: string): Promise<PublicCaptureRecord | null> {
    return this.byId(captureId);
  }

  async getHearing(hearingId: string): Promise<PublicHearingCaptureEvent | null> {
    const rows = await this.prisma.$queryRawUnsafe<PublicHearingCaptureEvent[]>(
      `SELECT id,
              event_status AS "eventStatus",
              CASE WHEN visibility='private' THEN 'CLOSED' ELSE 'PUBLIC' END AS "publicAccess",
              starts_at AS "scheduledStart",
              url AS "officialPageUrl"
       FROM ${capturableHearingView()}
       WHERE id = $1
       LIMIT 1`,
      hearingId,
    );
    return rows[0] ?? null;
  }

  async getDemand(hearingId: string): Promise<PublicCaptureDemand> {
    if (!stateCaptureEnabled()) {
      const state = await this.prisma.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM committee_hearing WHERE id=${hearingId} AND geographic_jurisdiction IS NOT NULL AND geographic_jurisdiction<>'US'`;
      if (state.length) return { activeSubscriptionCount: 0, globalCoverageRequested: false };
    }
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count
         FROM hearing_subscription s
         WHERE s.hearing_id = $1 AND ${AUTOMATIC_DEMAND_SQL}`,
        hearingId,
      ),
    );
    return {
      activeSubscriptionCount: rows[0]?.count ?? 0,
      globalCoverageRequested: await this.captureAllPublicEvents(),
    };
  }

  /**
   * The API planner flips capture-all in legiwatch_cutover_state; the worker
   * reads the same row (env stays as the fallback) so both sides agree, cached
   * briefly so a due scan does not re-query it per hearing.
   */
  private async captureAllPublicEvents(): Promise<boolean> {
    const now = Date.now();
    if (this.captureAllCache && this.captureAllCache.expiresAt > now) {
      return this.captureAllCache.value;
    }
    let fromDb = false;
    try {
      const rows = await this.prisma.withSystem(
        (tx) =>
          tx.$queryRaw<
            Array<{ enabled: boolean | null }>
          >`SELECT capture_all_public_events AS enabled FROM legiwatch_cutover_state WHERE id='global' LIMIT 1`,
      );
      fromDb = rows[0]?.enabled === true;
    } catch {
      // A schema without the planner row must not stall the worker; env decides.
    }
    const value = fromDb || captureAllPublicEventsEnabled();
    this.captureAllCache = { value, expiresAt: now + CAPTURE_ALL_CACHE_MS };
    return value;
  }

  async listDueHearingIds(now: Date): Promise<string[]> {
    const captureAll = await this.captureAllPublicEvents();
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ hearingId: string }>>(
        `SELECT DISTINCT h.id AS "hearingId", h.starts_at
         FROM ${capturableHearingView()} h
         LEFT JOIN hearing_subscription s ON s.hearing_id = h.id
         LEFT JOIN public_hearing_capture c ON c.hearing_id = h.id
         WHERE h.event_status IN ('scheduled','postponed','in_progress')
           AND h.starts_at IS NOT NULL
           AND (h.starts_at BETWEEN $1 - interval '6 hours' AND $1 + interval '14 days'
             OR c.domain_status IN ('CAPTURING','RECOVERING','FINALIZING'))
           AND LOWER(COALESCE(h.type,'')) = ANY($3::text[])
           AND (
             (${AUTOMATIC_DEMAND_SQL}) OR
             ($2::boolean = true AND h.visibility = 'public')
           )
           AND (
             c.id IS NULL OR
             c.domain_status NOT IN ('COMPLETE','COMPLETE_WITH_GAPS','FAILED','CANCELED','BLOCKED') OR
             (${blockedRecoveryCaptureSql('$1')} AND EXISTS (
               SELECT 1 FROM hearing_stream_candidate sc JOIN committee_source src ON src.id=sc.source_id
               WHERE ${blockedRecoveryCandidateSql('$1')}
                 AND ${blockedRecoveryProbeDueSql('$1')}
             ))
           )
           -- An active worker owns reconciliation until its lease expires.
           -- Do not let these oldest rows occupy every bounded discovery slot.
           AND (c.worker_lease_owner IS NULL OR c.lease_expires_at IS NULL OR c.lease_expires_at <= $1)
           AND (c.id IS NULL OR c.next_preflight_at IS NULL OR c.next_preflight_at <= $1)
         ORDER BY h.starts_at ASC, h.id ASC`,
        now,
        captureAll,
        [...ELIGIBLE_PUBLIC_HEARING_EVENT_TYPES],
      ),
    );
    return rows.map((row) => row.hearingId);
  }

  async getBlockedRecoveryCandidate(
    captureId: string,
    now: Date,
  ): Promise<BlockedRecoveryCandidate | null> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<BlockedRecoveryCandidate[]>(
        `SELECT sc.id,sc.hearing_id AS "hearingId",sc.source_id AS "sourceId",
        sc.official_page_url AS "officialPageUrl",sc.media_url AS "mediaUrl",sc.first_seen_at::text AS "firstSeenAt",sc.updated_at::text AS "updatedAt"
       FROM public_hearing_capture c JOIN ${capturableHearingView()} h ON h.id=c.hearing_id
       JOIN hearing_stream_candidate sc ON sc.hearing_id=h.id
       JOIN committee_source src ON src.id=sc.source_id
       WHERE c.id=$1 AND ${blockedRecoveryCaptureSql('$2')}
         AND ${blockedRecoveryCandidateSql('$2')}
         AND LOWER(COALESCE(h.type,''))=ANY($3::text[])
         AND ${blockedRecoveryProbeDueSql('$2')}
       ORDER BY sc.first_seen_at ASC,sc.id ASC LIMIT 1`,
        captureId,
        now,
        [...ELIGIBLE_PUBLIC_HEARING_EVENT_TYPES],
      ),
    );
    return rows[0] ?? null;
  }

  async reopenBlockedCapture(input: {
    captureId: string;
    expectedVersion: number;
    probe: BlockedRecoveryProbe;
    now: Date;
  }): Promise<PublicCaptureRecord | null> {
    const { candidate, classified, attemptedAt } = input.probe;
    if (
      classified.state !== 'READY_FOR_SERVER_CAPTURE' ||
      classified.capturePolicy !== 'SERVER_CAPTURE_ALLOWED' ||
      classified.reasonCode !== 'FIRST_PARTY_STREAM_READY' ||
      !classified.media ||
      !Number.isFinite(attemptedAt.getTime()) ||
      attemptedAt > input.now ||
      input.now.getTime() - attemptedAt.getTime() > 60_000
    )
      return null;
    const captureAll = captureAllPublicEventsEnabled();
    let priorResolution: { reason: string; state: string } | undefined;
    const recovered = await this.prisma.withSystem(async (tx) => {
      // Lock the capture, canonical event, candidate and provenance owner before
      // repeating every predicate. Ordinary manual-stop/lease writes serialize here.
      const eligible = await tx.$queryRawUnsafe<
        Array<{ id: string; reason: string; state: string }>
      >(
        `SELECT c.id,c.resolution_reason_code AS reason,c.resolution_state AS state FROM public_hearing_capture c
         JOIN committee_hearing h ON h.id=c.hearing_id
         JOIN hearing_stream_candidate sc ON sc.hearing_id=h.id
         JOIN committee_source src ON src.id=sc.source_id
         WHERE c.id=$1 AND c.version=$2 AND sc.id=$3
           AND sc.official_page_url=$4 AND sc.media_url IS NOT DISTINCT FROM $5::text
           AND sc.source_id=$6 AND sc.first_seen_at=$7::timestamptz
           AND ${blockedRecoveryCaptureSql('GREATEST($8,clock_timestamp())')} AND ${blockedRecoveryCandidateSql('GREATEST($8,clock_timestamp())')}
           AND sc.last_probe_at=$9 AND sc.updated_at=$9 AND sc.last_probe_at > c.last_resolution_at
           AND sc.last_probe_at >= clock_timestamp()-interval '1 minute'
           AND sc.capture_policy='SERVER_CAPTURE_ALLOWED' AND sc.resolution_state='READY'
           AND EXISTS(SELECT 1 FROM ${capturableHearingView()} v WHERE v.id=h.id)
           AND LOWER(COALESCE(h.type,''))=ANY($11::text[])
           AND ($10::boolean OR EXISTS (SELECT 1 FROM legiwatch_cutover_state WHERE id='global' AND capture_all_public_events)
             OR EXISTS (SELECT 1 FROM hearing_subscription s
             WHERE s.hearing_id=h.id AND ${AUTOMATIC_DEMAND_SQL}))
         FOR UPDATE OF c,h,sc,src`,
        input.captureId,
        input.expectedVersion,
        candidate.id,
        candidate.officialPageUrl,
        candidate.mediaUrl,
        candidate.sourceId,
        candidate.firstSeenAt,
        input.now,
        attemptedAt,
        captureAll,
        [...ELIGIBLE_PUBLIC_HEARING_EVENT_TYPES],
      );
      if (!eligible.length) return null;
      priorResolution = eligible[0];
      const rows = await tx.$queryRawUnsafe<CaptureRow[]>(
        `UPDATE public_hearing_capture SET status='leased',domain_status='READY',terminal_reason_code=NULL,
          selected_stream_candidate_id=$3,resolution_state='READY_FOR_SERVER_CAPTURE',
          resolution_capture_policy='SERVER_CAPTURE_ALLOWED',resolution_reason_code='FIRST_PARTY_STREAM_READY',
          resolution_provider=$4,resolution_reference=$5,last_resolution_at=$6,last_outcome_at=$6,
          next_preflight_at=NULL,consecutive_source_errors=0,version=version+1,updated_at=$6
         WHERE id=$1 AND version=$2 AND domain_status='BLOCKED'
         RETURNING ${CAPTURE_COLUMNS}`,
        input.captureId,
        input.expectedVersion,
        candidate.id,
        boundedNullable(classified.provider, 200),
        candidate.officialPageUrl,
        attemptedAt,
      );
      return rows[0] ? mapCapture(rows[0]) : null;
    });
    if (recovered)
      this.logger.log({
        event: 'late_first_party_source_capture_recovered',
        hearingId: candidate.hearingId,
        captureId: input.captureId,
        candidateId: candidate.id,
        priorVersion: input.expectedVersion,
        priorResolution,
        priorTerminalReason: 'CAPTURE_BLOCKED',
      });
    return recovered;
  }

  async assertCaptureAllowed(hearingId: string): Promise<void> {
    const terminal = await this.prisma.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM public_hearing_capture
      WHERE hearing_id=${hearingId} AND domain_status IN ('CANCELED','BLOCKED','FAILED','COMPLETE','COMPLETE_WITH_GAPS')`;
    if (terminal.length) throw Error('CAPTURE_INTENTIONALLY_STOPPED');
    const hearing = await this.getHearing(hearingId),
      demand = await this.getDemand(hearingId);
    if (
      !hearing ||
      /^(canceled|cancelled)$/i.test(hearing.eventStatus) ||
      hearing.publicAccess !== 'PUBLIC' ||
      (!demand.activeSubscriptionCount && !demand.globalCoverageRequested)
    )
      throw Error('CAPTURE_ACCESS_OR_DEMAND_WITHDRAWN');
    const retained = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM intel_public_hearing_audio_epoch WHERE hearing_id=${hearingId} AND state='recording' LIMIT 1`,
    );
    if (
      retained.length &&
      (!publicAudioEnabled() || !(await approvedPublicCapture(this.prisma, hearingId)).length)
    )
      throw Error('CAPTURE_SOURCE_PERMISSION_WITHDRAWN');
  }

  async ensureCapture(input: {
    hearingId: string;
    idempotencyKey: string;
    scheduledStart?: Date;
    now: Date;
  }): Promise<PublicCaptureRecord> {
    void input.idempotencyKey;
    const inserted = await this.prisma.$queryRawUnsafe<CaptureRow[]>(
      `INSERT INTO public_hearing_capture
         (id, hearing_id, status, domain_status, scheduled_start, created_at, updated_at)
       VALUES (gen_random_uuid(),$1,'scheduled','SCHEDULED',$2,$3,$3)
       ON CONFLICT (hearing_id) DO NOTHING
       RETURNING ${CAPTURE_COLUMNS}`,
      input.hearingId,
      input.scheduledStart ?? null,
      input.now,
    );
    if (inserted[0]) return mapCapture(inserted[0]);
    // RESCHEDULE PROPAGATION (2026-09-04): the official start can change after
    // the capture row was created (field-hearing time correction). Propagate the
    // corrected instant into the EXISTING capture row — idempotently, and only
    // while the capture is still waiting on an allowlist of pre-start states
    // (domain_status: the physical status column stores LEGACY lowercase values
    // — an uppercase allowlist against `status` can never match a real row):
    // never rewrite a terminal row, never rewrite one that is capturing or
    // already started (actual_start is history, not schedule). No second capture
    // row is created; the dedupe key (hearing_id) is untouched.
    const rescheduled = await this.prisma.$queryRawUnsafe<CaptureRow[]>(
      `UPDATE public_hearing_capture
          SET scheduled_start = $2, updated_at = $3
        WHERE hearing_id = $1
          AND domain_status IN ('SCHEDULED','PREPARING','WAITING_FOR_STREAM','READY')
          AND actual_start IS NULL
          AND (scheduled_start IS NULL OR scheduled_start <> $2)
        RETURNING ${CAPTURE_COLUMNS}`,
      input.hearingId,
      input.scheduledStart ?? null,
      input.now,
    );
    if (rescheduled[0]) return mapCapture(rescheduled[0]);
    const rows = await this.prisma.$queryRawUnsafe<CaptureRow[]>(
      `SELECT ${CAPTURE_COLUMNS} FROM public_hearing_capture WHERE hearing_id = $1`,
      input.hearingId,
    );
    if (!rows[0]) throw new Error(`capture disappeared after conflict: ${input.hearingId}`);
    return mapCapture(rows[0]);
  }

  async saveState(input: {
    captureId: string;
    expectedVersion: number;
    next: CaptureStateSnapshot;
  }): Promise<PublicCaptureRecord> {
    return this.updateState(
      input,
      'id = $1 AND version = $2 AND (worker_lease_owner IS NULL OR lease_expires_at <= clock_timestamp())',
      [input.captureId, input.expectedVersion],
      false,
    );
  }

  async recordResolution(input: {
    captureId: string;
    expectedVersion: number;
    classified: ClassifiedStreamResolution;
    attemptedAt: Date;
    nextPreflightAt?: Date;
  }): Promise<PublicCaptureRecord> {
    return this.updateResolution(
      input,
      ' AND (worker_lease_owner IS NULL OR lease_expires_at <= clock_timestamp())',
      [],
    );
  }

  async recordFencedResolution(input: {
    captureId: string;
    ownerId: string;
    fencingToken: number;
    expectedVersion: number;
    classified: ClassifiedStreamResolution;
    attemptedAt: Date;
    nextPreflightAt?: Date;
  }): Promise<PublicCaptureRecord> {
    return this.updateResolution(
      input,
      ' AND worker_lease_owner = $10 AND fencing_token = $11 AND lease_expires_at > clock_timestamp()',
      [input.ownerId, input.fencingToken],
      true,
    );
  }

  async tryAcquireLease(input: {
    captureId: string;
    ownerId: string;
    now: Date;
    leaseDurationMs: number;
  }): Promise<CaptureLeaseAcquireResult> {
    const expires = new Date(input.now.getTime() + input.leaseDurationMs);
    const rows = await this.prisma.$queryRawUnsafe<CaptureRow[]>(
      `UPDATE public_hearing_capture SET
         reconnect_count = reconnect_count + CASE WHEN worker_lease_owner IS NULL THEN 0 ELSE 1 END,
         worker_lease_owner=$2, lease_acquired_at=$3, lease_expires_at=$4,
         fencing_token=fencing_token+1, version=version+1, updated_at=$3
       WHERE id=$1 AND (worker_lease_owner IS NULL OR lease_expires_at <= $3)
       RETURNING ${CAPTURE_COLUMNS}`,
      input.captureId,
      input.ownerId,
      input.now,
      expires,
    );
    if (rows[0]) {
      return { acquired: true, capture: mapCapture(rows[0]), lease: leaseFrom(rows[0]) };
    }
    const current = await this.byId(input.captureId);
    if (!current) throw new Error(`public hearing capture not found: ${input.captureId}`);
    return { acquired: false, capture: current };
  }

  async renewLease(input: {
    captureId: string;
    ownerId: string;
    fencingToken: number;
    now: Date;
    leaseDurationMs: number;
  }): Promise<CaptureLease> {
    const rows = await this.prisma.$queryRawUnsafe<CaptureRow[]>(
      `UPDATE public_hearing_capture
       SET lease_expires_at=$4, updated_at=$3
       WHERE id=$1 AND worker_lease_owner=$2 AND fencing_token=$5
         AND lease_expires_at > clock_timestamp()
       RETURNING ${CAPTURE_COLUMNS}`,
      input.captureId,
      input.ownerId,
      input.now,
      new Date(input.now.getTime() + input.leaseDurationMs),
      input.fencingToken,
    );
    if (!rows[0]) throw new StaleCaptureFencingTokenError();
    return leaseFrom(rows[0]);
  }

  async releaseLease(input: {
    captureId: string;
    ownerId: string;
    fencingToken: number;
    now: Date;
  }): Promise<void> {
    const count = await this.prisma.$executeRawUnsafe(
      `UPDATE public_hearing_capture
       SET worker_lease_owner=NULL, lease_expires_at=NULL, updated_at=$4
       WHERE id=$1 AND worker_lease_owner=$2 AND fencing_token=$3`,
      input.captureId,
      input.ownerId,
      input.fencingToken,
      input.now,
    );
    if (count === 0) throw new StaleCaptureFencingTokenError();
  }

  async saveFencedState(input: {
    captureId: string;
    ownerId: string;
    fencingToken: number;
    expectedVersion: number;
    next: CaptureStateSnapshot;
    capturedMs?: number;
    gaps?: CaptureGap[];
  }): Promise<PublicCaptureRecord> {
    return this.updateState(
      input,
      'id=$1 AND version=$2 AND worker_lease_owner=$3 AND fencing_token=$4 AND lease_expires_at > clock_timestamp()',
      [input.captureId, input.expectedVersion, input.ownerId, input.fencingToken],
      true,
      input.capturedMs,
      input.gaps,
    );
  }

  private async byId(id: string): Promise<PublicCaptureRecord | null> {
    const rows = await this.prisma.$queryRawUnsafe<CaptureRow[]>(
      `SELECT ${CAPTURE_COLUMNS} FROM public_hearing_capture WHERE id=$1`,
      id,
    );
    return rows[0] ? mapCapture(rows[0]) : null;
  }

  private async updateResolution(
    input: {
      captureId: string;
      expectedVersion: number;
      classified: ClassifiedStreamResolution;
      attemptedAt: Date;
      nextPreflightAt?: Date;
    },
    fenceSql: string,
    fenceParams: unknown[],
    fenced = false,
  ): Promise<PublicCaptureRecord> {
    const rows = await this.prisma.$queryRawUnsafe<CaptureRow[]>(
      `UPDATE public_hearing_capture SET
         resolution_state=$3,
         resolution_reason_code=$4,
         resolution_capture_policy=$5,
         resolution_provider=$6,
         resolution_reference=$7,
         last_resolution_at=$8,
         last_outcome_at=$8,
         next_preflight_at=$9,
         consecutive_source_errors=CASE
           WHEN $3='SOURCE_ERROR' THEN consecutive_source_errors+1
           ELSE 0
         END,
         version=version+1,
         updated_at=$8
       WHERE id=$1 AND version=$2${fenceSql}
       RETURNING ${CAPTURE_COLUMNS}`,
      input.captureId,
      input.expectedVersion,
      input.classified.state,
      input.classified.reasonCode,
      input.classified.capturePolicy,
      boundedNullable(input.classified.provider, 200),
      safeResolutionReference(input.classified),
      input.attemptedAt,
      input.nextPreflightAt ?? null,
      ...fenceParams,
    );
    if (!rows[0]) {
      throw fenced ? new StaleCaptureFencingTokenError() : new OptimisticCaptureWriteError();
    }
    return mapCapture(rows[0]);
  }

  private async updateState(
    input: { next: CaptureStateSnapshot },
    where: string,
    params: unknown[],
    fenced: boolean,
    capturedMs?: number,
    gaps?: CaptureGap[],
  ): Promise<PublicCaptureRecord> {
    const p = params.length;
    const terminal = isTerminalCaptureStatus(input.next.status);
    const reason = publicCaptureTerminalReasonCode(input.next);
    const rows = await this.prisma.$queryRawUnsafe<CaptureRow[]>(
      `UPDATE public_hearing_capture SET
         status=$${p + 1},
         domain_status=$${p + 2},
         failure_code=$${p + 3},
         failure_detail=$${p + 4},
         terminal_reason_code=CASE
           WHEN $${p + 5}::boolean THEN $${p + 6}
           ELSE terminal_reason_code
         END,
         last_outcome_at=CASE
           WHEN $${p + 5}::boolean THEN $${p + 9}
           ELSE last_outcome_at
         END,
         captured_ms=COALESCE($${p + 7},captured_ms),
         captured_seconds=COALESCE(($${p + 7}::int / 1000),captured_seconds),
         gaps=COALESCE($${p + 8}::jsonb,gaps),
         version=version+1,
         updated_at=$${p + 9}
       WHERE ${where}
       RETURNING ${CAPTURE_COLUMNS}`,
      ...params,
      publicCaptureStorageStatus(input.next.status),
      input.next.status,
      input.next.failureCode ?? null,
      input.next.failureDetail ?? null,
      terminal,
      reason,
      capturedMs ?? null,
      gaps ? JSON.stringify(gaps) : null,
      input.next.updatedAt,
    );
    if (!rows[0]) {
      throw fenced ? new StaleCaptureFencingTokenError() : new OptimisticCaptureWriteError();
    }
    return mapCapture(rows[0]);
  }
}

/** Env half of the capture-all switch; the DB row in legiwatch_cutover_state takes precedence. */
export function captureAllPublicEventsEnabled(
  value = process.env.LEGIWATCH_CAPTURE_ALL_PUBLIC_EVENTS,
): boolean {
  return isEnabledFlagValue(value);
}

function mapCapture(row: CaptureRow): PublicCaptureRecord {
  const lease =
    row.workerLeaseOwner && row.leaseExpiresAt && row.leaseAcquiredAt
      ? {
          ownerId: row.workerLeaseOwner,
          acquiredAt: row.leaseAcquiredAt,
          expiresAt: row.leaseExpiresAt,
          fencingToken: row.fencingToken,
        }
      : undefined;
  const {
    scheduledStart: _scheduledStart,
    actualStart: _actualStart,
    actualEnd: _actualEnd,
    domainStatus: _domainStatus,
    resolutionReasonCode: _resolutionReasonCode,
    resolutionCapturePolicy: _resolutionCapturePolicy,
    resolutionProvider: _resolutionProvider,
    resolutionReference: _resolutionReference,
    terminalReasonCode: _terminalReasonCode,
    ...record
  } = row;
  return {
    ...record,
    status: isDomainStatus(row.domainStatus)
      ? row.domainStatus
      : publicCaptureLegacyDomainStatus(row.status),
    failureCode: row.failureCode ?? undefined,
    failureDetail: row.failureDetail ?? undefined,
    lastResolutionAt: row.lastResolutionAt ?? undefined,
    nextPreflightAt: row.nextPreflightAt ?? undefined,
    gaps: Array.isArray(row.gaps) ? (row.gaps as CaptureGap[]) : [],
    lease,
  };
}

export function publicCaptureStorageStatus(status: PublicHearingCaptureStatus): string {
  if (status === 'SCHEDULED') return 'scheduled';
  if (status === 'READY') return 'leased';
  if (status === 'CAPTURING' || status === 'RECOVERING') return 'capturing';
  if (status === 'COMPLETE' || status === 'COMPLETE_WITH_GAPS') return 'ended';
  if (status === 'FAILED') return 'failed';
  if (status === 'CANCELED' || status === 'BLOCKED') return 'no_stream';
  return 'paused';
}

export function publicCaptureLegacyDomainStatus(status: string): PublicHearingCaptureStatus {
  switch (status) {
    case 'scheduled':
      return 'SCHEDULED';
    case 'leased':
      return 'READY';
    case 'capturing':
      return 'CAPTURING';
    case 'ended':
      return 'COMPLETE';
    case 'failed':
      return 'FAILED';
    case 'no_stream':
      return 'BLOCKED';
    default:
      return 'PREPARING';
  }
}

function isDomainStatus(value: string | null | undefined): value is PublicHearingCaptureStatus {
  return [
    'SCHEDULED',
    'PREPARING',
    'WAITING_FOR_STREAM',
    'READY',
    'CAPTURING',
    'RECOVERING',
    'FINALIZING',
    'COMPLETE',
    'COMPLETE_WITH_GAPS',
    'FAILED',
    'CANCELED',
    'BLOCKED',
  ].includes(value ?? '');
}

export function isTerminalCaptureStatus(status: PublicHearingCaptureStatus): boolean {
  return ['COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED', 'CANCELED', 'BLOCKED'].includes(status);
}

export function publicCaptureTerminalReasonCode(next: CaptureStateSnapshot): string | null {
  switch (next.status) {
    case 'COMPLETE':
      return 'CAPTURE_COMPLETE';
    case 'COMPLETE_WITH_GAPS':
      return 'CAPTURE_COMPLETE_WITH_GAPS';
    case 'FAILED':
      return next.failureCode ?? 'CAPTURE_FAILED';
    case 'CANCELED':
      return 'EVENT_CANCELED';
    case 'BLOCKED':
      return next.failureCode ?? 'CAPTURE_BLOCKED';
    default:
      return null;
  }
}

function safeResolutionReference(classified: ClassifiedStreamResolution): string | null {
  const value = classified.reference?.trim();
  if (!value || value === classified.media?.url) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString().slice(0, 2_000);
  } catch {
    return null;
  }
}

function boundedNullable(value: string | undefined, max: number): string | null {
  if (!value?.trim()) return null;
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, max);
}

function leaseFrom(row: CaptureRow): CaptureLease {
  if (!row.workerLeaseOwner || !row.leaseAcquiredAt || !row.leaseExpiresAt) {
    throw new Error('lease columns missing');
  }
  return {
    ownerId: row.workerLeaseOwner,
    acquiredAt: row.leaseAcquiredAt,
    expiresAt: row.leaseExpiresAt,
    fencingToken: row.fencingToken,
  };
}
