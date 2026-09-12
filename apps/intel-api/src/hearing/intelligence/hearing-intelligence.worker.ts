import type { PrismaService } from '../../prisma/prisma.service.js';
import type {
  PublicHearingContext,
  PublicTranscriptSegmentInput,
} from './public-hearing-intelligence.types.js';
import { PublicHearingIntelligenceProcessor } from './public-hearing-intelligence.processor.js';
import { TenantHearingRelevanceProcessor } from './tenant-hearing-relevance.processor.js';
import {
  HearingIntelligenceJobStore,
  type PublicHearingIntelligenceJob,
  type TenantHearingRelevanceJob,
} from './hearing-intelligence-job.store.js';
import { PostgresPublicHearingInsightStore } from './postgres-public-hearing-insight.store.js';
import { PostgresTenantHearingContextProvider } from './postgres-tenant-hearing-context.provider.js';
import { PostgresTenantHearingRelevanceStore } from './postgres-tenant-hearing-relevance.store.js';

interface SegmentSourceRow {
  segmentId: string;
  captureId: string;
  hearingId: string;
  sequence: number;
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel: string | null;
  speakerConfidence: number | null;
  transcriptionConfidence: number | null;
  isFinal: boolean;
  hasGapBefore: boolean;
  revision: number;
  title: string;
  chamber: string;
  committeeSystemCode: string | null;
  committeeName: string;
  subcommitteeSystemCode: string | null;
  subcommitteeName: string | null;
  witnesses: string[] | null;
  visibility: string;
}

export interface HearingIntelligenceDrainResult {
  publicClaimed: number;
  publicCompleted: number;
  publicRequeued: number;
  publicFailed: number;
  publicInsightsPersisted: number;
  tenantJobsEnqueued: number;
  tenantClaimed: number;
  tenantCompleted: number;
  tenantFailed: number;
  tenantMatchesPersisted: number;
}

export interface HearingIntelligenceWorkerOptions {
  publicBatchSize?: number;
  tenantBatchSize?: number;
  log?: (message: string) => void;
}

/**
 * Restart-safe Phase 8 worker. The two stages have separate leases and failure
 * domains: tenant context trouble can never roll back a canonical public fact.
 */
export class HearingIntelligenceWorker {
  private readonly publicProcessor = new PublicHearingIntelligenceProcessor();
  private readonly tenantProcessor = new TenantHearingRelevanceProcessor({ minimumScore: 20 });
  private readonly jobs: HearingIntelligenceJobStore;
  private readonly publicStore: PostgresPublicHearingInsightStore;
  private readonly contexts: PostgresTenantHearingContextProvider;
  private readonly tenantStore: PostgresTenantHearingRelevanceStore;
  private readonly log: (message: string) => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly workerId: string,
    private readonly options: HearingIntelligenceWorkerOptions = {},
  ) {
    this.jobs = new HearingIntelligenceJobStore(prisma);
    this.publicStore = new PostgresPublicHearingInsightStore(prisma);
    this.contexts = new PostgresTenantHearingContextProvider(prisma);
    this.tenantStore = new PostgresTenantHearingRelevanceStore(prisma);
    this.log = options.log ?? (() => {});
  }

  async drainOnce(): Promise<HearingIntelligenceDrainResult> {
    const result: HearingIntelligenceDrainResult = {
      publicClaimed: 0,
      publicCompleted: 0,
      publicRequeued: 0,
      publicFailed: 0,
      publicInsightsPersisted: 0,
      tenantJobsEnqueued: 0,
      tenantClaimed: 0,
      tenantCompleted: 0,
      tenantFailed: 0,
      tenantMatchesPersisted: 0,
    };

    const publicJobs = await this.jobs.claimPublic(
      this.workerId,
      this.options.publicBatchSize ?? 25,
    );
    result.publicClaimed = publicJobs.length;
    for (const job of publicJobs) {
      try {
        const counts = await this.processPublicJob(job);
        result.publicInsightsPersisted += counts.insights;
        result.tenantJobsEnqueued += counts.tenantJobs;
        const completion = await this.jobs.completePublic(job, this.workerId);
        if (completion === 'completed') result.publicCompleted += 1;
        else if (completion === 'requeued') result.publicRequeued += 1;
        else this.log(`[phase8] public job ${job.id} lost its lease before completion`);
      } catch (error) {
        result.publicFailed += 1;
        await this.jobs.failPublic(job, this.workerId, error);
        this.log(`[phase8] public job ${job.id} failed: ${boundedError(error)}`);
      }
    }

    const tenantJobs = await this.jobs.claimTenant(
      this.workerId,
      this.options.tenantBatchSize ?? 25,
    );
    result.tenantClaimed = tenantJobs.length;
    for (const job of tenantJobs) {
      try {
        const matches = await this.processTenantJob(job);
        result.tenantMatchesPersisted += matches;
        if (await this.jobs.completeTenant(job, this.workerId)) result.tenantCompleted += 1;
        else this.log(`[phase8] tenant job ${job.id} lost its lease before completion`);
      } catch (error) {
        result.tenantFailed += 1;
        await this.jobs.failTenant(job, this.workerId, error);
        this.log(`[phase8] tenant job ${job.id} failed: ${boundedError(error)}`);
      }
    }

    return result;
  }

  async backfill(limit = 100_000): Promise<number> {
    return this.jobs.backfillFinalSegments(limit);
  }

  /**
   * Re-score already-persisted public facts after tenant client context changes.
   * This never re-extracts or rewrites public truth; it only resets completed
   * tenant relevance batches and lets the normal FORCE-RLS queue process them.
   */
  async backfillTenantRelevance(
    hearingLimit = 1_000,
  ): Promise<{ hearings: number; tenantIds: number; jobs: number }> {
    const [tenantIds, batches] = await Promise.all([
      this.contexts.activeTenantIds(),
      this.jobs.persistedInsightBatches(hearingLimit),
    ]);
    let jobs = 0;
    for (const batch of batches) {
      jobs += await this.jobs.enqueueTenantJobs({
        tenantIds,
        hearingId: batch.hearingId,
        publicInsightIds: batch.publicInsightIds,
        forceCompleted: true,
      });
    }
    return { hearings: batches.length, tenantIds: tenantIds.length, jobs };
  }

  private async processPublicJob(
    job: PublicHearingIntelligenceJob,
  ): Promise<{ insights: number; tenantJobs: number }> {
    const source = await this.loadSource(job.segmentId);
    if (!source) {
      // Segment/capture was removed after the queue lease. The FK normally
      // cascades the job, but an already-leased worker may still hold the id.
      return { insights: 0, tenantJobs: 0 };
    }
    if (!source.isFinal) {
      throw new Error(`Segment ${source.segmentId} is not final`);
    }

    const processed =
      source.visibility === 'public'
        ? await this.publicProcessor.processSegment({
            segment: toSegment(source),
            context: toContext(source),
          })
        : { insights: [] };

    const persisted = await this.publicStore.replaceSegmentInsightsIfCurrent({
      segmentId: source.segmentId,
      expectedRevision: job.segmentRevision,
      insights: processed.insights,
    });
    if (!persisted) {
      this.log(
        `[phase8] segment ${source.segmentId} changed after revision ${job.segmentRevision}; stale extraction discarded`,
      );
      return { insights: 0, tenantJobs: 0 };
    }

    const tenantIds = await this.contexts.activeTenantIds();
    const tenantJobs = await this.jobs.enqueueTenantJobs({
      tenantIds,
      hearingId: source.hearingId,
      publicInsightIds: processed.insights.map((insight) => insight.id),
    });
    this.log(
      `[phase8] segment ${source.segmentId} -> ${processed.insights.length} public insights, ${tenantJobs} tenant jobs`,
    );
    return { insights: processed.insights.length, tenantJobs };
  }

  private async processTenantJob(job: TenantHearingRelevanceJob): Promise<number> {
    const insights = await this.publicStore.byIds(job.publicInsightIds);
    const source = await this.loadHearingContext(job.hearingId);
    if (!source) {
      await this.tenantStore.replaceForInsights({
        tenantId: job.tenantId,
        hearingId: job.hearingId,
        insightIds: job.publicInsightIds,
        matches: [],
      });
      return 0;
    }
    const tenantContext = await this.contexts.contextForTenant(job.tenantId);
    const matches = this.tenantProcessor.score({
      insights,
      context: source,
      tenantContext,
    });
    await this.tenantStore.replaceForInsights({
      tenantId: job.tenantId,
      hearingId: job.hearingId,
      insightIds: job.publicInsightIds,
      matches,
    });
    return matches.length;
  }

  private async loadSource(segmentId: string): Promise<SegmentSourceRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<SegmentSourceRow[]>(
      `SELECT s.id AS "segmentId",
              s.capture_id AS "captureId",
              c.hearing_id AS "hearingId",
              s.sequence,
              s.start_ms AS "startMs",
              s.end_ms AS "endMs",
              s.text,
              s.speaker_label AS "speakerLabel",
              s.speaker_confidence AS "speakerConfidence",
              s.transcription_confidence AS "transcriptionConfidence",
              s.is_final AS "isFinal",
              s.has_gap_before AS "hasGapBefore",
              s.revision,
              h.title,
              h.chamber,
              h.committee_system_code AS "committeeSystemCode",
              h.committee_name AS "committeeName",
              h.subcommittee_system_code AS "subcommitteeSystemCode",
              sub.name AS "subcommitteeName",
              h.witnesses,
              h.visibility
       FROM public_hearing_transcript_segment s
       JOIN public_hearing_capture c ON c.id=s.capture_id
       JOIN federal_committee_hearing h ON h.id=c.hearing_id
       LEFT JOIN congress_committee sub ON sub.system_code=h.subcommittee_system_code
       WHERE s.id=$1
       LIMIT 1`,
      segmentId,
    );
    return rows[0] ?? null;
  }

  private async loadHearingContext(hearingId: string): Promise<PublicHearingContext | null> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        hearingId: string;
        title: string;
        chamber: string;
        committeeSystemCode: string | null;
        committeeName: string;
        subcommitteeSystemCode: string | null;
        subcommitteeName: string | null;
        witnesses: string[] | null;
        visibility: string;
      }>
    >(
      `SELECT h.id AS "hearingId",
              h.title,
              h.chamber,
              h.committee_system_code AS "committeeSystemCode",
              h.committee_name AS "committeeName",
              h.subcommittee_system_code AS "subcommitteeSystemCode",
              sub.name AS "subcommitteeName",
              h.witnesses,
              h.visibility
       FROM federal_committee_hearing h
       LEFT JOIN congress_committee sub ON sub.system_code=h.subcommittee_system_code
       WHERE h.id=$1
       LIMIT 1`,
      hearingId,
    );
    const row = rows[0];
    if (!row || row.visibility !== 'public') return null;
    return {
      hearingId: row.hearingId,
      title: row.title,
      chamber: row.chamber,
      committeeId: row.committeeSystemCode ?? undefined,
      committeeName: row.committeeName,
      subcommitteeId: row.subcommitteeSystemCode ?? undefined,
      subcommitteeName: row.subcommitteeName ?? undefined,
      publicWitnesses: (row.witnesses ?? []).map((name) => ({ name })),
    };
  }
}

function toSegment(row: SegmentSourceRow): PublicTranscriptSegmentInput {
  return {
    id: row.segmentId,
    captureId: row.captureId,
    hearingId: row.hearingId,
    sequence: row.sequence,
    startMs: row.startMs,
    endMs: row.endMs,
    text: row.text,
    speakerName: row.speakerLabel ?? undefined,
    speakerLabel: row.speakerLabel ?? undefined,
    confidence: row.transcriptionConfidence ?? row.speakerConfidence ?? undefined,
    isFinal: row.isFinal,
    gapBefore: row.hasGapBefore,
  };
}

function toContext(row: SegmentSourceRow): PublicHearingContext {
  return {
    hearingId: row.hearingId,
    title: row.title,
    chamber: row.chamber,
    committeeId: row.committeeSystemCode ?? undefined,
    committeeName: row.committeeName,
    subcommitteeId: row.subcommitteeSystemCode ?? undefined,
    subcommitteeName: row.subcommitteeName ?? undefined,
    publicWitnesses: (row.witnesses ?? []).map((name) => ({ name })),
  };
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 1_000);
}
