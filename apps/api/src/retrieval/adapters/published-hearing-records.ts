import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { RetrievalRequest } from '../retrieval-v2.types.js';
import {
  governmentResult,
  visibleGovernmentClients,
  governmentJson,
} from './government-work-retrieval.helpers.js';
import {
  hearingContentChunks,
  encodeHearingContentCursor,
  parseHearingContentCursor,
} from './hearing-content-chunks.js';

/** Additive exact-event read inside the existing hearings context adapter. */
export async function retrievePublishedHearingRecords(
  prisma: PrismaService,
  request: RetrievalRequest,
  cursor?: string,
) {
  const filter = request.hearingFilters!,
    eventId = filter.hearingId;
  if (!eventId)
    return governmentResult('hearings', request, { stopReason: 'exact_event_required' });
  return prisma.withTenantUser(
    request.caller.tenantId,
    request.caller.userId,
    async (tx) => {
      const clients = await visibleGovernmentClients(tx, request);
      if (clients.denied)
        return governmentResult('hearings', request, {
          sourceStatus: 'unauthorized',
          stopReason: 'client_wall_or_security_envelope_denied',
        });
      const actor = await tx.$queryRaw<
        Array<{ actor: string }>
      >`SELECT u.clerk_user_id AS actor FROM users u JOIN tenant_memberships m ON m.user_id=u.id
      WHERE u.id=${request.caller.userId}::uuid AND m.tenant_id=${request.caller.tenantId}::uuid AND m.status::text='active'`;
      const flags = await tx.$queryRaw<
        Array<{ enabled: boolean }>
      >`SELECT enabled FROM intel_feature_flag WHERE tenant_id=${request.caller.tenantId} AND feature='legiwatch_published_records_v1'`;
      if (!actor[0] || !flags[0]?.enabled)
        return governmentResult('hearings', request, {
          sourceStatus: 'unauthorized',
          stopReason: 'published_record_access_unavailable',
        });
      let payload: unknown, key: string;
      if (filter.recordsView === 'published') {
        if (!filter.recordId)
          return governmentResult('hearings', request, { stopReason: 'exact_record_id_required' });
        const cutoff = request.asOf ?? request.observedThrough ?? new Date();
        const rows = await tx.$queryRaw<
          Array<{
            id: string;
            hash: string;
            evidence: unknown;
            observed: Date;
            date: string | null;
            billId: string | null;
            kind: string;
            current: boolean;
          }>
        >(Prisma.sql`
        SELECT r.id::text,r.revision_hash AS hash,r.evidence-'contentSnapshotBase64'-'raw' AS evidence,r.first_observed_at AS observed,r.event_date AS date,r.bill_key AS "billId",r.kind,
          coalesce(o.state_record_id=r.id,NOT EXISTS(SELECT 1 FROM state_bill_published_record later WHERE later.bill_key=r.bill_key AND later.kind=r.kind AND later.source_identity=r.source_identity AND (later.first_observed_at,later.id)>(r.first_observed_at,r.id))) AS current
        FROM state_bill_published_record r LEFT JOIN published_record_source_current o ON o.source_key='state:'||r.bill_key||':'||r.kind||':'||r.source_identity JOIN state_bill b ON b.id=r.bill_key JOIN committee_hearing h ON h.id=${eventId} AND h.visibility='public'
        WHERE r.id::text=${filter.recordId} AND b.state=h.geographic_jurisdiction AND b.session_key=h.legislative_session AND r.first_observed_at<=${cutoff}
          AND EXISTS(SELECT 1 FROM legislative_agenda_item a WHERE a.hearing_id=h.id AND a.active AND a.state_bill_key=b.id)
        UNION ALL SELECT r.id::text,r.extraction_hash,jsonb_build_object('text',r.extracted_text,'url',r.source_url,'publisher','GPO / GovInfo','parserVersion',r.parser_version,'contentHash',r.content_hash,'metadata',r.metadata),r.observed_at,r.published_date,NULL,'official_transcript',
          coalesce(o.official_revision_id=r.id,NOT EXISTS(SELECT 1 FROM official_hearing_transcript_revision later WHERE later.package_id=r.package_id AND (later.observed_at,later.id)>(r.observed_at,r.id)))
        FROM official_hearing_transcript_revision r LEFT JOIN published_record_source_current o ON o.source_key='govinfo:'||r.package_id JOIN official_hearing_transcript_event e ON e.revision_id=r.id JOIN committee_hearing h ON h.id=e.hearing_id AND h.visibility='public'
        WHERE e.hearing_id=${eventId} AND r.id::text=${filter.recordId} AND r.observed_at<=${cutoff}`);
        if (!rows[0])
          return governmentResult('hearings', request, {
            stopReason: 'record_version_unavailable',
          });
        if (!request.asOf && !request.observedThrough && !rows[0].current)
          return governmentResult('hearings', request, {
            stopReason: 'record_superseded_explicit_historical_read_required',
          });
        payload = {
          ...rows[0],
          eventId,
          historical: Boolean(request.asOf || request.observedThrough),
          authority:
            'Published source version; bill agenda membership alone does not establish hearing occurrence',
        };
        key = 'published:' + rows[0].id;
      } else {
        const secret = process.env.INTERNAL_SERVICE_SECRET;
        if (!secret)
          return governmentResult('hearings', request, {
            sourceStatus: 'degraded',
            stopReason: 'record_owner_service_unavailable',
          });
        const clientId =
          request.caller.clientIds?.length === 1 ? request.caller.clientIds[0] : undefined;
        if (clientId && !clients.ids.includes(clientId))
          return governmentResult('hearings', request, {
            sourceStatus: 'unauthorized',
            stopReason: 'exact_authorized_client_required',
          });
        if (filter.recordsView === 'briefs' && (!clientId || !clients.ids.includes(clientId)))
          return governmentResult('hearings', request, {
            stopReason: 'exact_authorized_client_required',
          });
        const response = await fetch(
          (process.env.TRACKER_APP_BASE_URL ?? 'https://app.capiro.ai').replace(/\/+$/, '') +
            '/intel-api/internal/hearing-record-retrieval',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-internal-service-secret': secret },
            signal: AbortSignal.timeout(15000),
            redirect: 'error',
            body: JSON.stringify({
              tenantId: request.caller.tenantId,
              actor: actor[0].actor,
              eventId,
              view: filter.recordsView,
              id: filter.recordId,
              clientId,
              asOf: (request.asOf ?? request.observedThrough)?.toISOString(),
            }),
          },
        );
        if (!response.ok)
          return governmentResult('hearings', request, {
            sourceStatus: 'degraded',
            stopReason: 'record_owner_version_or_access_unavailable',
          });
        payload = await response.json();
        key = filter.recordsView + ':' + filter.recordId;
      }
      const parts = hearingContentChunks(governmentJson(payload));
      let part = 0;
      if (cursor) {
        try {
          const parsed = parseHearingContentCursor(cursor);
          if (
            !parsed ||
            parsed.key !== key ||
            parsed.hash !== parts.hash ||
            parsed.part >= parts.chunks.length
          )
            throw Error();
          part = parsed.part;
        } catch {
          return governmentResult('hearings', request, {
            stopReason: 'record_content_changed_restart_read',
          });
        }
      }
      const hasMore = part + 1 < parts.chunks.length;
      return governmentResult('hearings', request, {
        records: [
          {
            domain: 'hearings',
            recordId: key + ':' + parts.hash + ':' + part,
            occurredAt: null,
            updatedAt: null,
            payload: parts.chunks[part]!,
            provenance: {
              adapter: 'hearings',
              sourceTable:
                filter.recordsView === 'published'
                  ? 'published_legislative_record'
                  : 'intel_hearing_record_' + filter.recordsView,
              sourceRecordId: filter.recordId!,
              hearingId: eventId,
              contentHash: parts.hash,
              ...(filter.recordsView !== 'published' ? { tenantId: request.caller.tenantId } : {}),
              historical: Boolean(request.asOf),
            },
          },
        ],
        returned: 1,
        recordsEvaluated: 1,
        pagesRead: 1,
        hasMore,
        truncated: hasMore,
        nextCursor: hasMore
          ? encodeHearingContentCursor({ key, hash: parts.hash, part: part + 1 })
          : undefined,
        paginationComplete: !hasMore,
        coverageComplete: false,
        sourceStatus: 'degraded',
        stopReason: hasMore
          ? 'exact_version_continues'
          : 'exact_selected_version_complete_publisher_coverage_not_asserted',
      });
    },
    { timeoutMs: 25000 },
  );
}
