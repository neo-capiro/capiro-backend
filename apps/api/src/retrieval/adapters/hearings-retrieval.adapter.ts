import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RetrievalSourceAdapter } from '../retrieval-source.adapter.js';
import type { RetrievalRequest, RetrievalSourceResult, SemanticDatasetDescriptor } from '../retrieval-v2.types.js';
import {
  currentReadError, governmentPageSize, governmentResult, visibleGovernmentClients,
} from './government-work-retrieval.helpers.js';
import type { KnowledgeJsonObject } from '../../knowledge/knowledge.types.js';
import { encodeHearingContentCursor, hearingContentChunks, hearingContentRecordId, parseHearingContentCursor } from './hearing-content-chunks.js';

const DOMAIN = 'hearings' as const;
const QUERY_CLASSES = new Set(['lookup', 'change_detection', 'portfolio_scan', 'exhaustive_search', 'comparison']);

interface HearingRow {
  key: string;
  sourceTable: string;
  sourceId: string;
  hearingId: string | null;
  occurredAt: Date | null;
  updatedAt: Date | null;
  payload: KnowledgeJsonObject;
}

/**
 * Reads the authoritative LegiWatch public capture/transcript/intelligence tables,
 * plus authorized tenant relevance. Long official transcripts are separate,
 * pageable text chunks, never clipped to a misleading "full transcript" excerpt.
 * Browser-session encrypted material remains owned by intel-api's decryption
 * service and is explicitly excluded from domain-completeness claims.
 */
@Injectable()
export class HearingsRetrievalAdapter implements RetrievalSourceAdapter {
  readonly key = 'hearings';
  readonly domains = [DOMAIN] as const;
  constructor(private readonly prisma: PrismaService) {}

  async retrieve(dataset: SemanticDatasetDescriptor, request: RetrievalRequest, cursor?: string): Promise<RetrievalSourceResult> {
    const invalid = currentReadError(request);
    if (dataset.domain !== DOMAIN || !QUERY_CLASSES.has(request.queryClass) || invalid) {
      return governmentResult(DOMAIN, request, { stopReason: invalid ?? 'query_class_not_supported' });
    }
    let contentCursor: ReturnType<typeof parseHearingContentCursor> = null;
    try {
      if (cursor) contentCursor = parseHearingContentCursor(cursor);
      if (cursor && (cursor.length > 1024 || (!contentCursor && !/^(event|official|segment|insight|relevance):/.test(cursor)))) throw new Error('invalid');
    } catch {
      return governmentResult(DOMAIN, request, { stopReason: 'invalid_cursor' });
    }
    return this.prisma.withTenantUser(request.caller.tenantId, request.caller.userId, async (tx) => {
      const clients = await visibleGovernmentClients(tx, request);
      if (clients.denied) return governmentResult(DOMAIN, request, {
        sourceStatus: 'unauthorized', stopReason: 'client_wall_or_security_envelope_denied',
      });
      if (request.caller.clientIds?.length && !clients.ids.length && clients.excludedArchived) {
        return governmentResult(DOMAIN, request, { stopReason: 'archived_client_subjects_excluded' });
      }
      const clientSql = clients.ids.length ? Prisma.join(clients.ids) : Prisma.sql`NULL`;
      const tenant = request.caller.tenantId;
      const user = request.caller.userId;
      // SubjectScope is an explicit request, not whichever client is selected in UI.
      const subjectScoped = Boolean(request.caller.clientIds?.length);
      const filter = request.hearingFilters;
      const hearingFilter = filter?.hearingId ? Prisma.sql`AND h.id = ${filter.hearingId}` : Prisma.empty;
      const chamberFilter = filter?.chamber ? Prisma.sql`AND lower(h.chamber) = lower(${filter.chamber})` : Prisma.empty;
      const committeeFilter = filter?.committeeName ? Prisma.sql`AND h.committee_name ILIKE ${`%${filter.committeeName.replace(/[\\%_]/g, (char) => `\\${char}`)}%`} ESCAPE '\\'` : Prisma.empty;
      const subjectClause = subjectScoped ? Prisma.sql`
        AND (
          EXISTS (SELECT 1 FROM hearing_subscription sub
            WHERE sub.tenant_id = ${tenant}::uuid AND sub.user_id = ${user}
              AND sub.hearing_id = h.id AND sub.client_ids && ARRAY[${clientSql}]::text[])
          OR EXISTS (SELECT 1 FROM hearing_follow f
            WHERE f.tenant_id = ${tenant}::uuid AND f.user_id = ${user}
              AND f.hearing_id = h.id AND f.client_ids::text[] && ARRAY[${clientSql}]::text[])
          OR EXISTS (SELECT 1 FROM tenant_hearing_relevance r
            WHERE r.tenant_id = ${tenant}::uuid AND r.client_id::text IN (${clientSql}) AND r.hearing_id = h.id)
        )` : Prisma.empty;
      const query = request.query?.trim();
      const queryClause = query ? Prisma.sql`AND combined.payload::text ILIKE ${`%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`} ESCAPE '\\'` : Prisma.empty;
      const cursorClause = contentCursor ? Prisma.sql`AND combined.key >= ${contentCursor.key}`
        : cursor ? Prisma.sql`AND combined.key > ${cursor}` : Prisma.empty;
      const startClause = request.windowStart ? (request.queryClass === 'change_detection'
        ? Prisma.sql`AND combined.updated_at >= ${request.windowStart}`
        : Prisma.sql`AND (combined.occurred_at >= ${request.windowStart} OR (combined.occurred_at IS NULL AND combined.event_day >= ${request.windowStart}::date))`) : Prisma.empty;
      const endClause = request.windowEnd ? (request.queryClass === 'change_detection'
        ? Prisma.sql`AND combined.updated_at < ${request.windowEnd}`
        : Prisma.sql`AND (combined.occurred_at < ${request.windowEnd} OR (combined.occurred_at IS NULL AND combined.event_day::timestamp < ${request.windowEnd}::timestamp))`) : Prisma.empty;
      const pageSize = governmentPageSize(request);
      const rows = await tx.$queryRaw<HearingRow[]>(Prisma.sql`
        WITH visible_hearings AS (
          SELECT h.* FROM committee_hearing h WHERE h.visibility = 'public' ${subjectClause} ${hearingFilter} ${chamberFilter} ${committeeFilter}
        ), combined AS (
          SELECT 'event:' || h.id AS key, 'committee_hearing' AS source_table, h.id AS source_id,
            h.id AS hearing_id, h.starts_at AS occurred_at, h.date AS event_day,
            h.synced_at AS updated_at,
            jsonb_build_object('kind', 'hearing', 'id', h.id, 'title', h.title,
              'committee', h.committee_name, 'chamber', h.chamber, 'congress', h.congress,
              'date', h.date, 'startsAt', h.starts_at, 'timezone', h.timezone,
              'eventStatus', h.event_status, 'coverageStatus', h.coverage_status,
              'sourceUrl', h.url, 'witnesses', h.witnesses,
              'sourceRevision', h.source_revision, 'lastOfficialUpdateAt', h.last_official_update_at,
              'syncedAt', h.synced_at) AS payload
          FROM visible_hearings h
          UNION ALL
          SELECT 'official:' || t.id || ':' || lpad(ch.part::text, 10, '0'),
            'official_hearing_transcript', t.id, t.hearing_id, NULL::timestamptz, t.date, t.fetched_at,
            jsonb_build_object('kind', 'official_transcript_chunk', 'id', t.id, 'hearingId', t.hearing_id,
              'title', t.title, 'date', t.date, 'congress', t.congress, 'chamber', t.chamber,
              'sourceUrl', t.source_url, 'publishedAt', t.published_at, 'fetchedAt', t.fetched_at,
              'text', substring(t.text FROM ch.part * 6000 + 1 FOR 6000),
              'characterStart', ch.part * 6000, 'characterEnd', LEAST((ch.part + 1) * 6000, length(t.text)),
              'totalCharacters', length(t.text), 'chunkCount', (length(t.text) + 5999) / 6000,
              'textIsCompleteChunk', true, 'isOfficialTranscript', true)
          FROM official_hearing_transcript t
          CROSS JOIN LATERAL generate_series(0, GREATEST(0, (length(t.text) - 1) / 6000)) ch(part)
          WHERE EXISTS (SELECT 1 FROM visible_hearings h WHERE h.id = t.hearing_id)
            OR (${!subjectScoped && !filter?.hearingId && !filter?.chamber && !filter?.committeeName} AND t.hearing_id IS NULL)
          UNION ALL
          SELECT 'segment:' || s.id, 'public_hearing_transcript_segment', s.id, c.hearing_id,
            h.starts_at, h.date, s.created_at,
            jsonb_build_object('kind', 'machine_transcript_segment', 'id', s.id, 'hearingId', c.hearing_id,
              'captureId', s.capture_id, 'sequence', s.sequence, 'startMs', s.start_ms, 'endMs', s.end_ms,
              'text', s.text, 'speakerLabel', s.speaker_label, 'speakerConfidence', s.speaker_confidence,
              'transcriptionConfidence', s.transcription_confidence, 'hasGapBefore', s.has_gap_before,
              'revision', s.revision, 'sourceUrl', h.url, 'isOfficialTranscript', false,
              'captureStatus', c.status, 'transcriptGapSeconds', c.transcript_gap_seconds)
          FROM public_hearing_transcript_segment s
          JOIN public_hearing_capture c ON c.id = s.capture_id
          JOIN visible_hearings h ON h.id = c.hearing_id
          WHERE s.is_final = true
          UNION ALL
          SELECT 'insight:' || i.id, 'public_hearing_insight', i.id, i.hearing_id,
            h.starts_at, h.date, i.updated_at,
            jsonb_build_object('kind', 'hearing_intelligence', 'id', i.id, 'hearingId', i.hearing_id,
              'segmentId', i.segment_id, 'startMs', i.start_ms, 'endMs', i.end_ms,
              'insightType', i.insight_type, 'title', i.title, 'summary', i.summary,
              'evidenceText', i.evidence_text, 'speakerName', i.speaker_name,
              'confidence', i.confidence, 'preliminary', i.preliminary, 'entities', i.entities,
              'sourceUrl', h.url, 'derivedFromMachineTranscript', true)
          FROM public_hearing_insight i JOIN visible_hearings h ON h.id = i.hearing_id
          UNION ALL
          SELECT 'relevance:' || r.id, 'tenant_hearing_relevance', r.id, r.hearing_id,
            h.starts_at, h.date, r.updated_at,
            jsonb_build_object('kind', 'client_hearing_relevance', 'id', r.id, 'clientId', r.client_id,
              'hearingId', r.hearing_id, 'insightId', r.insight_id, 'score', r.score,
              'matchedOn', r.matched_on, 'rationale', r.rationale, 'updatedAt', r.updated_at)
          FROM tenant_hearing_relevance r JOIN visible_hearings h ON h.id = r.hearing_id
          WHERE r.tenant_id = ${tenant}::uuid AND r.client_id::text IN (${clientSql})
        )
        SELECT key, source_table AS "sourceTable", source_id AS "sourceId", hearing_id AS "hearingId",
          occurred_at AS "occurredAt", updated_at AS "updatedAt", payload
        FROM combined WHERE TRUE ${cursorClause} ${queryClause} ${startClause} ${endClause}
        ORDER BY key ASC LIMIT ${pageSize + 1}
      `);
      if (contentCursor && rows[0]?.key !== contentCursor.key) {
        return governmentResult(DOMAIN, request, { stopReason: 'hearing_content_changed_restart_read' });
      }
      const records: RetrievalSourceResult['records'] = [];
      let hasMore = false;
      let nextCursor: string | undefined;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex]!;
        const { hash, chunks } = hearingContentChunks(row.payload);
        const firstPart = rowIndex === 0 && contentCursor ? contentCursor.part : 0;
        if (rowIndex === 0 && contentCursor && (hash !== contentCursor.hash || firstPart >= chunks.length)) {
          return governmentResult(DOMAIN, request, { stopReason: 'hearing_content_changed_restart_read' });
        }
        for (let part = firstPart; part < chunks.length; part += 1) {
          records.push({
            domain: DOMAIN, recordId: hearingContentRecordId(row.key, hash, chunks.length === 1 ? undefined : part),
            occurredAt: row.occurredAt, updatedAt: row.updatedAt, payload: chunks[part]!,
            provenance: { adapter: this.key, sourceTable: row.sourceTable, sourceRecordId: row.sourceId,
              hearingId: row.hearingId, contentHash: hash, sourceKey: row.key,
              ...(row.sourceTable === 'tenant_hearing_relevance' ? { tenantId: tenant } : {}) },
          });
          if (records.length === pageSize) {
            hasMore = part + 1 < chunks.length || rowIndex + 1 < rows.length;
            if (hasMore) nextCursor = part + 1 < chunks.length
              ? encodeHearingContentCursor({ key: row.key, part: part + 1, hash }) : row.key;
            break;
          }
        }
        if (records.length === pageSize) break;
      }
      return governmentResult(DOMAIN, request, {
        records, returned: records.length, hasMore, truncated: hasMore,
        ...(nextCursor ? { nextCursor } : {}),
        sourceStatus: 'degraded', recordsEvaluated: rows.length,
        requestedEntityCount: clients.requested, searchedEntityCount: clients.ids.length,
        pagesRead: 1, paginationComplete: !hasMore, coverageComplete: false,
        stopReason: hasMore ? 'page_boundary_reached_browser_session_rail_not_supported'
          : 'stored_public_and_official_hearings_complete_browser_session_rail_not_supported',
      });
    });
  }
}
