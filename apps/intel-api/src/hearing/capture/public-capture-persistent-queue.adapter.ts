import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  PublicCaptureQueuePort,
  PublicCaptureRetryQueuePort,
} from './public-capture.orchestrator.js';

export type PublicCaptureJobType = 'preflight' | 'capture';
export type PublicCaptureJobStatus = 'pending' | 'leased' | 'completed' | 'failed';

export interface PublicCaptureJob {
  id: string;
  jobType: PublicCaptureJobType;
  dedupeKey: string;
  hearingId: string;
  captureId?: string;
  status: PublicCaptureJobStatus;
  dueAt: Date;
  attempts: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

interface JobRow {
  id: string;
  jobType: PublicCaptureJobType;
  dedupeKey: string;
  hearingId: string;
  captureId: string | null;
  status: PublicCaptureJobStatus;
  dueAt: Date;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

const JOB_COLUMNS = `
  id,
  job_type AS "jobType",
  dedupe_key AS "dedupeKey",
  hearing_id AS "hearingId",
  capture_id AS "captureId",
  status,
  due_at AS "dueAt",
  attempts,
  max_attempts AS "maxAttempts",
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  last_error AS "lastError",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt"`;

const CLAIMED_JOB_COLUMNS = `
  job.id,
  job.job_type AS "jobType",
  job.dedupe_key AS "dedupeKey",
  job.hearing_id AS "hearingId",
  job.capture_id AS "captureId",
  job.status,
  job.due_at AS "dueAt",
  job.attempts,
  job.max_attempts AS "maxAttempts",
  job.lease_owner AS "leaseOwner",
  job.lease_expires_at AS "leaseExpiresAt",
  job.last_error AS "lastError",
  job.created_at AS "createdAt",
  job.updated_at AS "updatedAt",
  job.completed_at AS "completedAt"`;

/**
 * Global durable queue for scheduled public hearing work.
 *
 * Queue rows contain only canonical public identifiers and the boolean
 * `mustReresolve` marker. They deliberately have no tenant/client columns and
 * never contain media URLs, provider credentials, or Deepgram session data.
 * Claims are leased with `FOR UPDATE SKIP LOCKED`, so multiple Fargate workers
 * can drain the same queue without serializing or processing one job twice.
 */
@Injectable()
export class PublicCapturePersistentQueueAdapter
  implements PublicCaptureQueuePort, PublicCaptureRetryQueuePort
{
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(input: {
    dedupeKey: string;
    captureId: string;
    hearingId: string;
    mustReresolve: true;
  }): Promise<{ enqueued: boolean; jobId?: string }> {
    assertStableJobInput(input);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO public_hearing_capture_job
         (job_type, dedupe_key, hearing_id, capture_id, status, due_at, payload, created_at, updated_at)
       VALUES ('capture', $1, $2, $3, 'pending', now(), $4::jsonb, now(), now())
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      bounded(input.dedupeKey, 300),
      input.hearingId,
      input.captureId,
      JSON.stringify({ mustReresolve: true }),
    );
    return rows[0] ? { enqueued: true, jobId: rows[0].id } : { enqueued: false };
  }

  async schedulePreflight(input: {
    dedupeKey: string;
    hearingId: string;
    dueAt: Date;
  }): Promise<void> {
    assertDate(input.dueAt, 'dueAt');
    assertId(input.hearingId, 'hearingId');
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_capture_job
         (job_type, dedupe_key, hearing_id, capture_id, status, due_at, payload, created_at, updated_at)
       VALUES ('preflight', $1, $2, NULL, 'pending', $3, '{}'::jsonb, now(), now())
       ON CONFLICT (dedupe_key) DO UPDATE SET
         due_at = LEAST(public_hearing_capture_job.due_at, EXCLUDED.due_at),
         status = CASE
           WHEN public_hearing_capture_job.status IN ('completed','failed') THEN 'pending'
           ELSE public_hearing_capture_job.status
         END,
         attempts = CASE
           WHEN public_hearing_capture_job.status IN ('completed','failed') THEN 0
           ELSE public_hearing_capture_job.attempts
         END,
         lease_owner = CASE
           WHEN public_hearing_capture_job.status IN ('completed','failed') THEN NULL
           ELSE public_hearing_capture_job.lease_owner
         END,
         lease_expires_at = CASE
           WHEN public_hearing_capture_job.status IN ('completed','failed') THEN NULL
           ELSE public_hearing_capture_job.lease_expires_at
         END,
         completed_at = NULL,
         last_error = NULL,
         updated_at = now()
       WHERE public_hearing_capture_job.status <> 'leased'`,
      bounded(input.dedupeKey, 300),
      input.hearingId,
      input.dueAt,
    );
  }

  async scheduleRetry(input: {
    dedupeKey: string;
    captureId: string;
    hearingId: string;
    dueAt: Date;
    mustReresolve: true;
  }): Promise<void> {
    assertStableJobInput(input);
    assertDate(input.dueAt, 'dueAt');
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_capture_job
         (job_type, dedupe_key, hearing_id, capture_id, status, due_at, payload, created_at, updated_at)
       VALUES ('capture', $1, $2, $3, 'pending', $4, $5::jsonb, now(), now())
       ON CONFLICT (dedupe_key) DO NOTHING`,
      bounded(input.dedupeKey, 300),
      input.hearingId,
      input.captureId,
      input.dueAt,
      JSON.stringify({ mustReresolve: true, recovery: true }),
    );
  }

  async claimDue(input: {
    jobType: PublicCaptureJobType;
    workerId: string;
    now: Date;
    limit?: number;
    leaseDurationMs?: number;
  }): Promise<PublicCaptureJob[]> {
    const workerId = requiredWorkerId(input.workerId);
    assertDate(input.now, 'now');
    const limit = boundedPositiveInteger(input.limit ?? 10, 100, 'limit');
    const leaseDurationMs = boundedPositiveInteger(
      input.leaseDurationMs ?? 10 * 60_000,
      24 * 60 * 60_000,
      'leaseDurationMs',
    );
    const leaseExpiresAt = new Date(input.now.getTime() + leaseDurationMs);

    const rows = await this.prisma.$queryRawUnsafe<JobRow[]>(
      `WITH due AS (
         SELECT id
         FROM public_hearing_capture_job
         WHERE job_type = $1
           AND attempts < max_attempts
           AND (
             (status = 'pending' AND due_at <= $2) OR
             (status = 'leased' AND lease_expires_at <= $2)
           )
         ORDER BY due_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $3
       )
       UPDATE public_hearing_capture_job AS job
       SET status = 'leased',
           lease_owner = $4,
           lease_expires_at = $5,
           attempts = job.attempts + 1,
           updated_at = $2
       FROM due
       WHERE job.id = due.id
       RETURNING ${CLAIMED_JOB_COLUMNS}`,
      input.jobType,
      input.now,
      limit,
      workerId,
      leaseExpiresAt,
    );
    return rows.map(mapJob);
  }

  async renewLease(input: {
    jobId: string;
    workerId: string;
    now: Date;
    leaseDurationMs?: number;
  }): Promise<Date> {
    const workerId = requiredWorkerId(input.workerId);
    assertDate(input.now, 'now');
    const leaseDurationMs = boundedPositiveInteger(
      input.leaseDurationMs ?? 5 * 60_000,
      24 * 60 * 60_000,
      'leaseDurationMs',
    );
    const expiresAt = new Date(input.now.getTime() + leaseDurationMs);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ leaseExpiresAt: Date }>>(
      `UPDATE public_hearing_capture_job
       SET lease_expires_at=$4, updated_at=$3
       WHERE id=$1::uuid AND status='leased' AND lease_owner=$2
       RETURNING lease_expires_at AS "leaseExpiresAt"`,
      input.jobId,
      workerId,
      input.now,
      expiresAt,
    );
    if (!rows[0]) throw new Error(`capture queue renewal lost lease: ${input.jobId}`);
    return rows[0].leaseExpiresAt;
  }

  async complete(input: {
    jobId: string;
    workerId: string;
    now: Date;
  }): Promise<void> {
    assertDate(input.now, 'now');
    const count = await this.prisma.$executeRawUnsafe(
      `UPDATE public_hearing_capture_job
       SET status='completed', completed_at=$3, updated_at=$3,
           lease_owner=NULL, lease_expires_at=NULL, last_error=NULL
       WHERE id=$1::uuid AND status='leased' AND lease_owner=$2`,
      input.jobId,
      requiredWorkerId(input.workerId),
      input.now,
    );
    if (count === 0) throw new Error(`capture queue completion lost lease: ${input.jobId}`);
  }

  async fail(input: {
    jobId: string;
    workerId: string;
    now: Date;
    error: unknown;
    retryAt?: Date;
  }): Promise<'REQUEUED' | 'FAILED'> {
    assertDate(input.now, 'now');
    if (input.retryAt) assertDate(input.retryAt, 'retryAt');
    const message = boundedError(input.error);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ status: PublicCaptureJobStatus }>>(
      `UPDATE public_hearing_capture_job
       SET status = CASE
             WHEN $4::timestamptz IS NOT NULL AND attempts < max_attempts THEN 'pending'
             ELSE 'failed'
           END,
           due_at = COALESCE($4::timestamptz, due_at),
           completed_at = CASE
             WHEN $4::timestamptz IS NOT NULL AND attempts < max_attempts THEN NULL
             ELSE $3
           END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error = $5,
           updated_at = $3
       WHERE id=$1::uuid AND status='leased' AND lease_owner=$2
       RETURNING status`,
      input.jobId,
      requiredWorkerId(input.workerId),
      input.now,
      input.retryAt ?? null,
      message,
    );
    if (!rows[0]) throw new Error(`capture queue failure lost lease: ${input.jobId}`);
    return rows[0].status === 'pending' ? 'REQUEUED' : 'FAILED';
  }

  async pendingCounts(now = new Date()): Promise<{
    preflight: number;
    capture: number;
    expiredLeases: number;
    failed: number;
  }> {
    assertDate(now, 'now');
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ preflight: number; capture: number; expiredLeases: number; failed: number }>
    >(
      `SELECT
         COUNT(*) FILTER (WHERE job_type='preflight' AND status='pending')::int AS preflight,
         COUNT(*) FILTER (WHERE job_type='capture' AND status='pending')::int AS capture,
         COUNT(*) FILTER (WHERE status='leased' AND lease_expires_at <= $1)::int AS "expiredLeases",
         COUNT(*) FILTER (WHERE status='failed')::int AS failed
       FROM public_hearing_capture_job`,
      now,
    );
    return rows[0] ?? { preflight: 0, capture: 0, expiredLeases: 0, failed: 0 };
  }
}

function mapJob(row: JobRow): PublicCaptureJob {
  return {
    id: row.id,
    jobType: row.jobType,
    dedupeKey: row.dedupeKey,
    hearingId: row.hearingId,
    captureId: row.captureId ?? undefined,
    status: row.status,
    dueAt: row.dueAt,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt ?? undefined,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? undefined,
  };
}

function assertStableJobInput(input: {
  hearingId: string;
  captureId: string;
  mustReresolve: true;
}): void {
  assertId(input.hearingId, 'hearingId');
  assertId(input.captureId, 'captureId');
  if (input.mustReresolve !== true) {
    throw new Error('public capture jobs must require worker-side re-resolution');
  }
}

function assertId(value: string, field: string): void {
  if (!value?.trim() || value.length > 500) {
    throw new Error(`${field} is required and bounded`);
  }
}

function requiredWorkerId(value: string): string {
  const workerId = bounded(value, 200);
  if (!workerId) throw new Error('capture queue workerId is required');
  return workerId;
}

function assertDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${field} must be a valid Date`);
  }
}

function bounded(value: string, max: number): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function boundedError(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error), 1_000);
}

function boundedPositiveInteger(value: number, max: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`);
  const integer = Math.floor(value);
  if (integer > max) throw new Error(`${field} must be at most ${max}`);
  return integer;
}

export const PUBLIC_CAPTURE_JOB_COLUMNS_FOR_TEST = JOB_COLUMNS;
