import type { Prisma } from '../../generated/prisma-client/index.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type {
  PublicHearingEntity,
  PublicHearingInsight,
  PublicHearingInsightSink,
} from './public-hearing-intelligence.types.js';
import { assertPublicHearingBoundary } from './public-hearing-boundary.js';

interface PublicInsightRow {
  id: string;
  hearingId: string;
  captureId: string;
  segmentId: string;
  sequence: number;
  startMs: number;
  endMs: number;
  insightType: PublicHearingInsight['insightType'];
  title: string;
  summary: string;
  evidenceText: string | null;
  speakerName: string | null;
  confidence: number | null;
  preliminary: boolean;
  entities: unknown;
  extractor: string;
  extractorVersion: string;
  createdAt: Date;
}

function entities(value: unknown): PublicHearingEntity[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      entityType: String(item.entityType ?? 'OTHER') as PublicHearingEntity['entityType'],
      label: String(item.label ?? '').trim(),
      canonicalId:
        typeof item.canonicalId === 'string' && item.canonicalId.trim()
          ? item.canonicalId.trim()
          : undefined,
    }))
    .filter((item) => Boolean(item.label));
}

function mapRow(row: PublicInsightRow): PublicHearingInsight {
  return {
    id: row.id,
    hearingId: row.hearingId,
    captureId: row.captureId,
    segmentId: row.segmentId,
    sequence: row.sequence,
    startMs: row.startMs,
    endMs: row.endMs,
    insightType: row.insightType,
    title: row.title,
    summary: row.summary,
    evidenceText: row.evidenceText ?? undefined,
    speakerName: row.speakerName ?? undefined,
    confidence: row.confidence ?? undefined,
    preliminary: row.preliminary,
    entities: entities(row.entities),
    extractor: row.extractor,
    extractorVersion: row.extractorVersion,
    createdAt: row.createdAt.toISOString(),
  };
}

function assertSegmentScope(
  segmentId: string,
  insights: readonly PublicHearingInsight[],
): void {
  if (insights.some((insight) => insight.segmentId !== segmentId)) {
    throw new Error(`Cannot replace ${segmentId} with insights from another segment`);
  }
  assertPublicHearingBoundary(insights);
}

/**
 * SQL-owned Phase 8 public insight store.
 *
 * The generated intel-api Prisma schema intentionally does not own apps/api's
 * global LegiWatch tables. Raw SQL is therefore the explicit cross-application
 * boundary, and every payload is checked for tenant/client/watchlist material
 * before it can reach the global table.
 */
export class PostgresPublicHearingInsightStore implements PublicHearingInsightSink {
  constructor(private readonly prisma: PrismaService) {}

  async upsertMany(insights: readonly PublicHearingInsight[]): Promise<void> {
    if (!insights.length) return;
    assertPublicHearingBoundary(insights);
    await this.prisma.withSystem(async (tx) => {
      for (const insight of insights) await this.upsertOne(tx, insight);
    });
  }

  /**
   * Replace the derived insight set for one transcript segment. Intended for
   * administrative repair where the caller already owns the revision decision.
   * Runtime workers should use the revision-fenced method below.
   */
  async replaceSegmentInsights(
    segmentId: string,
    insights: readonly PublicHearingInsight[],
  ): Promise<void> {
    assertSegmentScope(segmentId, insights);
    await this.prisma.withSystem(async (tx) => {
      await this.replaceInTransaction(tx, segmentId, insights);
    });
  }

  /**
   * Atomically prove the canonical segment is still at the revision the worker
   * claimed, then replace its derived insight set while holding a SHARE lock on
   * that row. A concurrent transcript correction must wait until this transaction
   * commits; an already-observed newer revision returns false and writes nothing.
   * This is the persistence fence that makes stale workers harmless, not merely
   * eventually correct.
   */
  async replaceSegmentInsightsIfCurrent(input: {
    segmentId: string;
    expectedRevision: number;
    insights: readonly PublicHearingInsight[];
  }): Promise<boolean> {
    assertSegmentScope(input.segmentId, input.insights);
    return this.prisma.withSystem(
      async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ revision: number; isFinal: boolean }>>(
          `SELECT revision, is_final AS "isFinal"
           FROM public_hearing_transcript_segment
           WHERE id=$1
           FOR SHARE`,
          input.segmentId,
        );
        const current = rows[0];
        if (
          !current ||
          !current.isFinal ||
          current.revision !== input.expectedRevision
        ) {
          return false;
        }
        await this.replaceInTransaction(tx, input.segmentId, input.insights);
        return true;
      },
      { timeoutMs: 30_000 },
    );
  }

  async byIds(ids: readonly string[]): Promise<PublicHearingInsight[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.$queryRawUnsafe<PublicInsightRow[]>(
      `SELECT id,
              hearing_id AS "hearingId",
              capture_id AS "captureId",
              segment_id AS "segmentId",
              sequence,
              start_ms AS "startMs",
              end_ms AS "endMs",
              insight_type AS "insightType",
              title,
              summary,
              evidence_text AS "evidenceText",
              speaker_name AS "speakerName",
              confidence,
              preliminary,
              entities,
              extractor,
              extractor_version AS "extractorVersion",
              created_at AS "createdAt"
       FROM public_hearing_insight
       WHERE id = ANY($1::text[])
       ORDER BY sequence ASC, id ASC`,
      [...ids],
    );
    const mapped = rows.map(mapRow);
    assertPublicHearingBoundary(mapped);
    return mapped;
  }

  async byHearing(hearingId: string, limit = 2_000): Promise<PublicHearingInsight[]> {
    const rows = await this.prisma.$queryRawUnsafe<PublicInsightRow[]>(
      `SELECT id,
              hearing_id AS "hearingId",
              capture_id AS "captureId",
              segment_id AS "segmentId",
              sequence,
              start_ms AS "startMs",
              end_ms AS "endMs",
              insight_type AS "insightType",
              title,
              summary,
              evidence_text AS "evidenceText",
              speaker_name AS "speakerName",
              confidence,
              preliminary,
              entities,
              extractor,
              extractor_version AS "extractorVersion",
              created_at AS "createdAt"
       FROM public_hearing_insight
       WHERE hearing_id=$1
       ORDER BY sequence ASC, id ASC
       LIMIT $2`,
      hearingId,
      Math.max(1, Math.min(10_000, limit)),
    );
    const mapped = rows.map(mapRow);
    assertPublicHearingBoundary(mapped);
    return mapped;
  }

  private async replaceInTransaction(
    tx: Prisma.TransactionClient,
    segmentId: string,
    insights: readonly PublicHearingInsight[],
  ): Promise<void> {
    const ids = insights.map((insight) => insight.id);
    await tx.$executeRawUnsafe(
      `DELETE FROM public_hearing_insight
       WHERE segment_id=$1
         AND NOT (id = ANY($2::text[]))`,
      segmentId,
      ids,
    );
    for (const insight of insights) await this.upsertOne(tx, insight);
  }

  private async upsertOne(
    tx: Prisma.TransactionClient,
    insight: PublicHearingInsight,
  ): Promise<void> {
    assertPublicHearingBoundary(insight);
    await tx.$executeRawUnsafe(
      `INSERT INTO public_hearing_insight (
         id, hearing_id, capture_id, segment_id, sequence, start_ms, end_ms,
         insight_type, title, summary, evidence_text, speaker_name, confidence,
         preliminary, entities, extractor, extractor_version, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13,
         $14, $15::jsonb, $16, $17, $18::timestamptz, now()
       )
       ON CONFLICT (id) DO UPDATE SET
         hearing_id=EXCLUDED.hearing_id,
         capture_id=EXCLUDED.capture_id,
         segment_id=EXCLUDED.segment_id,
         sequence=EXCLUDED.sequence,
         start_ms=EXCLUDED.start_ms,
         end_ms=EXCLUDED.end_ms,
         insight_type=EXCLUDED.insight_type,
         title=EXCLUDED.title,
         summary=EXCLUDED.summary,
         evidence_text=EXCLUDED.evidence_text,
         speaker_name=EXCLUDED.speaker_name,
         confidence=EXCLUDED.confidence,
         preliminary=EXCLUDED.preliminary,
         entities=EXCLUDED.entities,
         extractor=EXCLUDED.extractor,
         extractor_version=EXCLUDED.extractor_version,
         updated_at=now()`,
      insight.id,
      insight.hearingId,
      insight.captureId,
      insight.segmentId,
      insight.sequence,
      insight.startMs,
      insight.endMs,
      insight.insightType,
      insight.title,
      insight.summary,
      insight.evidenceText ?? null,
      insight.speakerName ?? null,
      insight.confidence ?? null,
      Boolean(insight.preliminary),
      JSON.stringify(insight.entities ?? []),
      insight.extractor,
      insight.extractorVersion,
      insight.createdAt,
    );
  }
}
