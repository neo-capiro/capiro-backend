import { createHash } from 'node:crypto';
import type { PrismaService } from '../../prisma/prisma.service.js';

export interface PublicHearingIntelligenceJob {
  id: string;
  segmentId: string;
  captureId: string;
  hearingId: string;
  segmentRevision: number;
  attempts: number;
}

export interface TenantHearingRelevanceJob {
  id: string;
  tenantId: string;
  hearingId: string;
  publicInsightIds: string[];
  attempts: number;
}

interface CompletionRow {
  status: string;
  segmentRevision?: number;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 1_000);
}

function batchKey(hearingId: string, insightIds: readonly string[]): string {
  const digest = createHash('sha256')
    .update(`${hearingId}\u001f${[...insightIds].sort().join('\u001f')}`)
    .digest('hex');
  return `hearing-relevance:v1:${digest}`;
}

/** Lease/fencing boundary for both restart-safe Phase 8 queues. */
export class HearingIntelligenceJobStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly options: { maxAttempts?: number; leaseSeconds?: number } = {},
  ) {}

  private get maxAttempts(): number {
    return Math.max(1, this.options.maxAttempts ?? 8);
  }

  private get leaseSeconds(): number {
    return Math.max(15, this.options.leaseSeconds ?? 180);
  }

  async claimPublic(workerId: string, limit = 25): Promise<PublicHearingIntelligenceJob[]> {
    return this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<PublicHearingIntelligenceJob[]>(
        `WITH picked AS (
           SELECT id
           FROM public_hearing_intelligence_job
           WHERE attempts < $1
             AND (
               (status IN ('pending','failed') AND due_at <= now())
               OR (status='leased' AND lease_expires_at < now())
             )
           ORDER BY due_at ASC, created_at ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE public_hearing_intelligence_job job
         SET status='leased',
             attempts=job.attempts + 1,
             lease_owner=$3,
             lease_expires_at=now() + ($4::int * interval '1 second'),
             last_error=NULL,
             updated_at=now()
         FROM picked
         WHERE job.id=picked.id
         RETURNING job.id::text AS id,
                   job.segment_id AS "segmentId",
                   job.capture_id AS "captureId",
                   job.hearing_id AS "hearingId",
                   job.segment_revision AS "segmentRevision",
                   job.attempts`,
        this.maxAttempts,
        Math.max(1, Math.min(250, limit)),
        workerId,
        this.leaseSeconds,
      ),
    );
  }

  /**
   * Complete only the revision actually processed. If the transcript trigger
   * observed a newer revision during the lease, this atomically requeues it.
   */
  async completePublic(
    job: PublicHearingIntelligenceJob,
    workerId: string,
  ): Promise<'completed' | 'requeued' | 'stale_lease'> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<CompletionRow[]>(
        `UPDATE public_hearing_intelligence_job
         SET status=CASE WHEN segment_revision=$3 THEN 'completed' ELSE 'pending' END,
             due_at=CASE WHEN segment_revision=$3 THEN due_at ELSE now() END,
             lease_owner=NULL,
             lease_expires_at=NULL,
             completed_at=CASE WHEN segment_revision=$3 THEN now() ELSE NULL END,
             updated_at=now()
         WHERE id=$1::uuid
           AND status='leased'
           AND lease_owner=$2
         RETURNING status, segment_revision AS "segmentRevision"`,
        job.id,
        workerId,
        job.segmentRevision,
      ),
    );
    if (!rows[0]) return 'stale_lease';
    return rows[0].status === 'completed' ? 'completed' : 'requeued';
  }

  async failPublic(
    job: PublicHearingIntelligenceJob,
    workerId: string,
    error: unknown,
  ): Promise<boolean> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE public_hearing_intelligence_job
         SET status='failed',
             due_at=now() + (LEAST(900, GREATEST(5, power(2, attempts)::int * 5)) * interval '1 second'),
             lease_owner=NULL,
             lease_expires_at=NULL,
             completed_at=NULL,
             last_error=$3,
             updated_at=now()
         WHERE id=$1::uuid
           AND status='leased'
           AND lease_owner=$2
         RETURNING id::text AS id`,
        job.id,
        workerId,
        boundedError(error),
      ),
    );
    return Boolean(rows[0]);
  }

  async enqueueTenantJobs(input: {
    tenantIds: readonly string[];
    hearingId: string;
    publicInsightIds: readonly string[];
  }): Promise<number> {
    const ids = [...new Set(input.publicInsightIds)].sort();
    if (!ids.length || !input.tenantIds.length) return 0;
    const key = batchKey(input.hearingId, ids);
    return this.prisma.withSystem(async (tx) => {
      let enqueued = 0;
      for (const tenantId of [...new Set(input.tenantIds)]) {
        const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO tenant_hearing_relevance_job (
             tenant_id, hearing_id, public_insight_ids, batch_key, status,
             attempts, due_at, created_at, updated_at
           ) VALUES (
             $1::uuid, $2, $3::text[], $4, 'pending', 0, now(), now(), now()
           )
           ON CONFLICT (tenant_id, batch_key) DO UPDATE SET
             public_insight_ids=EXCLUDED.public_insight_ids,
             status=CASE
               WHEN tenant_hearing_relevance_job.status='failed' THEN 'pending'
               ELSE tenant_hearing_relevance_job.status
             END,
             attempts=CASE
               WHEN tenant_hearing_relevance_job.status='failed' THEN 0
               ELSE tenant_hearing_relevance_job.attempts
             END,
             due_at=CASE
               WHEN tenant_hearing_relevance_job.status='failed' THEN now()
               ELSE tenant_hearing_relevance_job.due_at
             END,
             last_error=CASE
               WHEN tenant_hearing_relevance_job.status='failed' THEN NULL
               ELSE tenant_hearing_relevance_job.last_error
             END,
             completed_at=CASE
               WHEN tenant_hearing_relevance_job.status='failed' THEN NULL
               ELSE tenant_hearing_relevance_job.completed_at
             END,
             updated_at=now()
           RETURNING id::text AS id`,
          tenantId,
          input.hearingId,
          ids,
          key,
        );
        if (rows[0]) enqueued += 1;
      }
      return enqueued;
    });
  }

  async claimTenant(workerId: string, limit = 25): Promise<TenantHearingRelevanceJob[]> {
    return this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<TenantHearingRelevanceJob[]>(
        `WITH picked AS (
           SELECT id
           FROM tenant_hearing_relevance_job
           WHERE attempts < $1
             AND (
               (status IN ('pending','failed') AND due_at <= now())
               OR (status='leased' AND lease_expires_at < now())
             )
           ORDER BY due_at ASC, created_at ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE tenant_hearing_relevance_job job
         SET status='leased',
             attempts=job.attempts + 1,
             lease_owner=$3,
             lease_expires_at=now() + ($4::int * interval '1 second'),
             last_error=NULL,
             updated_at=now()
         FROM picked
         WHERE job.id=picked.id
         RETURNING job.id::text AS id,
                   job.tenant_id::text AS "tenantId",
                   job.hearing_id AS "hearingId",
                   job.public_insight_ids AS "publicInsightIds",
                   job.attempts`,
        this.maxAttempts,
        Math.max(1, Math.min(250, limit)),
        workerId,
        this.leaseSeconds,
      ),
    );
  }

  async completeTenant(job: TenantHearingRelevanceJob, workerId: string): Promise<boolean> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE tenant_hearing_relevance_job
         SET status='completed',
             lease_owner=NULL,
             lease_expires_at=NULL,
             completed_at=now(),
             updated_at=now()
         WHERE id=$1::uuid
           AND status='leased'
           AND lease_owner=$2
         RETURNING id::text AS id`,
        job.id,
        workerId,
      ),
    );
    return Boolean(rows[0]);
  }

  async failTenant(
    job: TenantHearingRelevanceJob,
    workerId: string,
    error: unknown,
  ): Promise<boolean> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE tenant_hearing_relevance_job
         SET status='failed',
             due_at=now() + (LEAST(900, GREATEST(5, power(2, attempts)::int * 5)) * interval '1 second'),
             lease_owner=NULL,
             lease_expires_at=NULL,
             completed_at=NULL,
             last_error=$3,
             updated_at=now()
         WHERE id=$1::uuid
           AND status='leased'
           AND lease_owner=$2
         RETURNING id::text AS id`,
        job.id,
        workerId,
        boundedError(error),
      ),
    );
    return Boolean(rows[0]);
  }

  async backfillFinalSegments(limit = 100_000): Promise<number> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ inserted: number }>>(
        `WITH candidates AS (
           SELECT s.id, s.capture_id, c.hearing_id, GREATEST(s.revision, 1) AS revision
           FROM public_hearing_transcript_segment s
           JOIN public_hearing_capture c ON c.id=s.capture_id
           LEFT JOIN public_hearing_intelligence_job job ON job.segment_id=s.id
           WHERE s.is_final=true AND job.id IS NULL
           ORDER BY s.created_at ASC, s.id ASC
           LIMIT $1
         ), inserted AS (
           INSERT INTO public_hearing_intelligence_job (
             segment_id, capture_id, hearing_id, segment_revision, status,
             attempts, due_at, created_at, updated_at
           )
           SELECT id, capture_id, hearing_id, revision, 'pending', 0, now(), now(), now()
           FROM candidates
           ON CONFLICT (segment_id) DO NOTHING
           RETURNING 1
         )
         SELECT COUNT(*)::int AS inserted FROM inserted`,
        Math.max(1, Math.min(1_000_000, limit)),
      ),
    );
    return rows[0]?.inserted ?? 0;
  }
}
