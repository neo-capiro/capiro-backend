import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  CaptureLeaseAcquireResult,
  PublicCaptureDemand,
  PublicCaptureRecord,
  PublicCaptureStorePort,
  PublicHearingCaptureEvent,
} from './public-capture.orchestrator.js';
import type { CaptureGap, CaptureLease, CaptureStateSnapshot } from './public-hearing-capture-state.js';
import type { ClassifiedStreamResolution } from './stream-resolution-policy.js';

type CaptureRow = Omit<PublicCaptureRecord, 'lease' | 'gaps'> & {
  scheduledStart?: Date | null;
  actualStart?: Date | null;
  actualEnd?: Date | null;
  workerLeaseOwner?: string | null;
  leaseExpiresAt?: Date | null;
  leaseAcquiredAt?: Date | null;
  fencingToken: number;
  gaps: unknown;
};

const CAPTURE_COLUMNS = `id, hearing_id AS "hearingId", status, version,
  scheduled_start AS "scheduledStart", actual_start AS "actualStart", actual_end AS "actualEnd",
  failure_code AS "failureCode", failure_detail AS "failureDetail",
  resolution_state AS "resolutionState", last_resolution_at AS "lastResolutionAt",
  consecutive_source_errors AS "consecutiveSourceErrors", next_preflight_at AS "nextPreflightAt",
  worker_lease_owner AS "workerLeaseOwner", lease_expires_at AS "leaseExpiresAt",
  lease_acquired_at AS "leaseAcquiredAt", fencing_token AS "fencingToken",
  captured_ms AS "capturedMs", gaps`;

export class OptimisticCaptureWriteError extends Error {
  constructor() { super('optimistic concurrency conflict for public hearing capture'); }
}
export class StaleCaptureFencingTokenError extends Error {
  constructor() { super('stale fencing token for public hearing capture'); }
}

@Injectable()
export class PublicHearingCaptureStore implements PublicCaptureStorePort {
  constructor(private readonly prisma: PrismaService) {}

  async getHearing(hearingId: string): Promise<PublicHearingCaptureEvent | null> {
    const rows = await this.prisma.$queryRawUnsafe<PublicHearingCaptureEvent[]>(
      `SELECT id, event_status AS "eventStatus", visibility AS "publicAccess",
              starts_at AS "scheduledStart", url AS "officialPageUrl"
         FROM committee_hearing WHERE id = $1 LIMIT 1`, hearingId);
    return rows[0] ?? null;
  }

  async getDemand(hearingId: string): Promise<PublicCaptureDemand> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM hearing_subscription WHERE hearing_id = $1`, hearingId);
    return { activeSubscriptionCount: rows[0]?.count ?? 0, globalCoverageRequested: false };
  }

  async listDueHearingIds(now: Date): Promise<string[]> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ hearingId: string }>>(
      `SELECT DISTINCT h.id AS "hearingId" FROM committee_hearing h
       JOIN hearing_subscription s ON s.hearing_id = h.id
       LEFT JOIN public_hearing_capture c ON c.hearing_id = h.id
       WHERE h.event_status NOT IN ('canceled','completed')
         AND (c.id IS NULL OR c.next_preflight_at IS NULL OR c.next_preflight_at <= $1)
       ORDER BY h.id`, now);
    return rows.map((row) => row.hearingId);
  }

  async ensureCapture(input: { hearingId: string; idempotencyKey: string; scheduledStart?: Date; now: Date }): Promise<PublicCaptureRecord> {
    void input.idempotencyKey;
    const inserted = await this.prisma.$queryRawUnsafe<CaptureRow[]>(
      `INSERT INTO public_hearing_capture (id, hearing_id, status, scheduled_start, created_at, updated_at)
       VALUES (gen_random_uuid(),$1,'scheduled',$2,$3,$3) ON CONFLICT (hearing_id) DO NOTHING RETURNING ${CAPTURE_COLUMNS}`,
      input.hearingId, input.scheduledStart ?? null, input.now);
    if (inserted[0]) return mapCapture(inserted[0]);
    const rows = await this.prisma.$queryRawUnsafe<CaptureRow[]>(
      `SELECT ${CAPTURE_COLUMNS} FROM public_hearing_capture WHERE hearing_id = $1`, input.hearingId);
    if (!rows[0]) throw new Error(`capture disappeared after conflict: ${input.hearingId}`);
    return mapCapture(rows[0]);
  }

  async saveState(input: { captureId: string; expectedVersion: number; next: CaptureStateSnapshot }): Promise<PublicCaptureRecord> {
    return this.updateState(input, 'id = $1 AND version = $2', [input.captureId, input.expectedVersion], false);
  }

  async recordResolution(input: { captureId: string; expectedVersion: number; classified: ClassifiedStreamResolution; attemptedAt: Date; nextPreflightAt?: Date }): Promise<PublicCaptureRecord> {
    return this.updateResolution(input, '', []);
  }

  async recordFencedResolution(input: { captureId: string; ownerId: string; fencingToken: number; expectedVersion: number; classified: ClassifiedStreamResolution; attemptedAt: Date; nextPreflightAt?: Date }): Promise<PublicCaptureRecord> {
    return this.updateResolution(input, ' AND worker_lease_owner = $6 AND fencing_token = $7', [input.ownerId, input.fencingToken], true);
  }

  async tryAcquireLease(input: { captureId: string; ownerId: string; now: Date; leaseDurationMs: number }): Promise<CaptureLeaseAcquireResult> {
    const expires = new Date(input.now.getTime() + input.leaseDurationMs);
    const rows = await this.prisma.$queryRawUnsafe<CaptureRow[]>(
      `UPDATE public_hearing_capture SET
         reconnect_count = reconnect_count + CASE WHEN worker_lease_owner IS NULL THEN 0 ELSE 1 END,
         worker_lease_owner=$2, lease_acquired_at=$3, lease_expires_at=$4,
         fencing_token=fencing_token+1, version=version+1, updated_at=$3
       WHERE id=$1 AND (worker_lease_owner IS NULL OR lease_expires_at <= $3)
       RETURNING ${CAPTURE_COLUMNS}`, input.captureId, input.ownerId, input.now, expires);
    if (rows[0]) return { acquired: true, capture: mapCapture(rows[0]), lease: leaseFrom(rows[0]) };
    const current = await this.byId(input.captureId);
    if (!current) throw new Error(`public hearing capture not found: ${input.captureId}`);
    return { acquired: false, capture: current };
  }

  async renewLease(input: { captureId: string; ownerId: string; fencingToken: number; now: Date; leaseDurationMs: number }): Promise<CaptureLease> {
    const rows = await this.prisma.$queryRawUnsafe<CaptureRow[]>(
      `UPDATE public_hearing_capture SET lease_expires_at=$4, updated_at=$3
       WHERE id=$1 AND worker_lease_owner=$2 AND fencing_token=$5 RETURNING ${CAPTURE_COLUMNS}`,
      input.captureId, input.ownerId, input.now, new Date(input.now.getTime()+input.leaseDurationMs), input.fencingToken);
    if (!rows[0]) throw new StaleCaptureFencingTokenError();
    return leaseFrom(rows[0]);
  }

  async releaseLease(input: { captureId: string; ownerId: string; fencingToken: number; now: Date }): Promise<void> {
    const count = await this.prisma.$executeRawUnsafe(
      `UPDATE public_hearing_capture SET worker_lease_owner=NULL, lease_expires_at=NULL, updated_at=$4
       WHERE id=$1 AND worker_lease_owner=$2 AND fencing_token=$3`,
      input.captureId, input.ownerId, input.fencingToken, input.now);
    if (count === 0) throw new StaleCaptureFencingTokenError();
  }

  async saveFencedState(input: { captureId: string; ownerId: string; fencingToken: number; expectedVersion: number; next: CaptureStateSnapshot; capturedMs?: number; gaps?: CaptureGap[] }): Promise<PublicCaptureRecord> {
    return this.updateState(input, 'id=$1 AND version=$2 AND worker_lease_owner=$3 AND fencing_token=$4',
      [input.captureId,input.expectedVersion,input.ownerId,input.fencingToken], true, input.capturedMs, input.gaps);
  }

  private async byId(id: string): Promise<PublicCaptureRecord | null> {
    const rows = await this.prisma.$queryRawUnsafe<CaptureRow[]>(`SELECT ${CAPTURE_COLUMNS} FROM public_hearing_capture WHERE id=$1`, id);
    return rows[0] ? mapCapture(rows[0]) : null;
  }

  private async updateResolution(input: { captureId:string; expectedVersion:number; classified:ClassifiedStreamResolution; attemptedAt:Date; nextPreflightAt?:Date }, fenceSql:string, fenceParams:unknown[], fenced=false): Promise<PublicCaptureRecord> {
    const errors = input.classified.state === 'SOURCE_ERROR' ? 1 : 0;
    const rows = await this.prisma.$queryRawUnsafe<CaptureRow[]>(
      `UPDATE public_hearing_capture SET resolution_state=$3, last_resolution_at=$4,
       next_preflight_at=$5, consecutive_source_errors=CASE WHEN $3='SOURCE_ERROR' THEN consecutive_source_errors+1 ELSE 0 END,
       version=version+1, updated_at=$4 WHERE id=$1 AND version=$2${fenceSql} RETURNING ${CAPTURE_COLUMNS}`,
      input.captureId,input.expectedVersion,input.classified.state,input.attemptedAt,input.nextPreflightAt ?? null,...fenceParams);
    void errors;
    if (!rows[0]) throw fenced ? new StaleCaptureFencingTokenError() : new OptimisticCaptureWriteError();
    return mapCapture(rows[0]);
  }

  private async updateState(input: { next: CaptureStateSnapshot }, where:string, params:unknown[], fenced:boolean, capturedMs?:number, gaps?:CaptureGap[]): Promise<PublicCaptureRecord> {
    const p = params.length;
    const rows = await this.prisma.$queryRawUnsafe<CaptureRow[]>(
      `UPDATE public_hearing_capture SET status=$${p+1}, failure_code=$${p+2}, failure_detail=$${p+3},
       captured_ms=COALESCE($${p+4},captured_ms), captured_seconds=COALESCE(($${p+4}::int / 1000),captured_seconds),
       gaps=COALESCE($${p+5}::jsonb,gaps), version=version+1, updated_at=$${p+6}
       WHERE ${where} RETURNING ${CAPTURE_COLUMNS}`,
      ...params,storageStatus(input.next.status),input.next.failureCode ?? null,input.next.failureDetail ?? null,capturedMs ?? null,
      gaps ? JSON.stringify(gaps) : null,input.next.updatedAt);
    if (!rows[0]) throw fenced ? new StaleCaptureFencingTokenError() : new OptimisticCaptureWriteError();
    return { ...mapCapture(rows[0]), status: input.next.status };
  }
}

function mapCapture(row: CaptureRow): PublicCaptureRecord {
  const lease = row.workerLeaseOwner && row.leaseExpiresAt && row.leaseAcquiredAt
    ? { ownerId: row.workerLeaseOwner, acquiredAt: row.leaseAcquiredAt, expiresAt: row.leaseExpiresAt, fencingToken: row.fencingToken } : undefined;
  const { scheduledStart: _scheduledStart, actualStart: _actualStart, actualEnd: _actualEnd, ...record } = row;
  return { ...record, status: domainStatus(String(row.status)), failureCode: row.failureCode ?? undefined,
    failureDetail: row.failureDetail ?? undefined, lastResolutionAt: row.lastResolutionAt ?? undefined,
    nextPreflightAt: row.nextPreflightAt ?? undefined, gaps: Array.isArray(row.gaps) ? row.gaps as CaptureGap[] : [], lease };
}
function storageStatus(status: CaptureStateSnapshot['status']): string {
  if (status === 'SCHEDULED') return 'scheduled';
  if (status === 'CAPTURING' || status === 'RECOVERING') return 'capturing';
  if (status === 'COMPLETE' || status === 'COMPLETE_WITH_GAPS') return 'ended';
  if (status === 'FAILED') return 'failed';
  if (status === 'CANCELED' || status === 'BLOCKED') return 'no_stream';
  return status === 'READY' ? 'leased' : 'paused';
}
function domainStatus(status:string): CaptureStateSnapshot['status'] {
  switch(status) { case 'scheduled': return 'SCHEDULED'; case 'leased': return 'READY'; case 'capturing': return 'CAPTURING';
    case 'ended': return 'COMPLETE'; case 'failed': return 'FAILED'; case 'no_stream': return 'BLOCKED'; default: return 'PREPARING'; }
}
function leaseFrom(row: CaptureRow): CaptureLease {
  if (!row.workerLeaseOwner || !row.leaseAcquiredAt || !row.leaseExpiresAt) throw new Error('lease columns missing');
  return { ownerId:row.workerLeaseOwner, acquiredAt:row.leaseAcquiredAt, expiresAt:row.leaseExpiresAt, fencingToken:row.fencingToken };
}
