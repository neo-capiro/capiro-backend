import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
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

export const ELIGIBLE_PUBLIC_HEARING_EVENT_TYPES = [
  'hearing',
  'markup',
  'meeting',
  'business meeting',
  'business_meeting',
  'roundtable',
  'forum',
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
  private readonly captureAllPublicEvents = captureAllPublicEventsEnabled();

  constructor(private readonly prisma: PrismaService) {}

  async getHearing(hearingId: string): Promise<PublicHearingCaptureEvent | null> {
    const rows = await this.prisma.$queryRawUnsafe<PublicHearingCaptureEvent[]>(
      `SELECT id,
              event_status AS "eventStatus",
              CASE WHEN visibility='private' THEN 'CLOSED' ELSE 'PUBLIC' END AS "publicAccess",
              starts_at AS "scheduledStart",
              url AS "officialPageUrl"
       FROM committee_hearing
       WHERE id = $1
       LIMIT 1`,
      hearingId,
    );
    return rows[0] ?? null;
  }

  async getDemand(hearingId: string): Promise<PublicCaptureDemand> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count
         FROM hearing_subscription
         WHERE hearing_id = $1`,
        hearingId,
      ),
    );
    return {
      activeSubscriptionCount: rows[0]?.count ?? 0,
      globalCoverageRequested: this.captureAllPublicEvents,
    };
  }

  async listDueHearingIds(now: Date): Promise<string[]> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ hearingId: string }>>(
        `SELECT DISTINCT h.id AS "hearingId"
         FROM committee_hearing h
         LEFT JOIN hearing_subscription s ON s.hearing_id = h.id
         LEFT JOIN public_hearing_capture c ON c.hearing_id = h.id
         WHERE h.event_status IN ('scheduled','postponed','in_progress')
           AND LOWER(COALESCE(h.type,'')) = ANY($3::text[])
           AND (
             s.hearing_id IS NOT NULL OR
             ($2::boolean = true AND h.visibility = 'public')
           )
           AND (
             c.id IS NULL OR
             c.domain_status NOT IN ('COMPLETE','COMPLETE_WITH_GAPS','FAILED','CANCELED','BLOCKED')
           )
           AND (c.id IS NULL OR c.next_preflight_at IS NULL OR c.next_preflight_at <= $1)
         ORDER BY h.id`,
        now,
        this.captureAllPublicEvents,
        [...ELIGIBLE_PUBLIC_HEARING_EVENT_TYPES],
      ),
    );
    return rows.map((row) => row.hearingId);
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
    return this.updateResolution(input,
      ' AND (worker_lease_owner IS NULL OR lease_expires_at <= clock_timestamp())', []);
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

export function captureAllPublicEventsEnabled(
  value = process.env.LEGIWATCH_CAPTURE_ALL_PUBLIC_EVENTS,
): boolean {
  return ['1', 'true', 'on', 'enabled', 'yes'].includes((value ?? '').trim().toLowerCase());
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
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
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
