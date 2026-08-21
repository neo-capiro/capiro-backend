import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RetrievalSourceAdapter } from '../retrieval-source.adapter.js';
import type {
  RetrievalRecord,
  RetrievalRequest,
  RetrievalSourceResult,
  SemanticDatasetDescriptor,
} from '../retrieval-v2.types.js';

interface StrategyWorkRow {
  recordKey: string;
  recordId: string;
  recordKind: 'strategy' | 'context_document' | 'context_fact' | 'context_conflict';
  clientId: string | null;
  updatedAt: Date | null;
  payload: Record<string, unknown>;
}

const DOMAIN = 'strategies_work' as const;
const SUPPORTED_QUERY_CLASSES = new Set([
  'lookup',
  'change_detection',
  'portfolio_scan',
  'exhaustive_search',
  'comparison',
]);

/**
 * Shared Retrieval V2 adapter for Strategy-owned durable state.
 *
 * api-strategy remains the sole WRITER of the sp_* tables. This adapter is a
 * tenant/client-filtered read projection so Strategy generation can consume the
 * same Context Plane as every other product instead of calling a feature-local
 * Context Pack. It includes active plans, active Context Steward documents,
 * active source-anchored facts, and open material conflicts. Agent runs,
 * approvals, outbox rows, execution tokens, and private chat bodies are never
 * projected.
 */
@Injectable()
export class StrategyWorkRetrievalAdapter implements RetrievalSourceAdapter {
  readonly key = 'strategies-work';
  readonly domains = [DOMAIN] as const;

  constructor(private readonly prisma: PrismaService) {}

  async retrieve(
    dataset: SemanticDatasetDescriptor,
    request: RetrievalRequest,
    cursor?: string,
  ): Promise<RetrievalSourceResult> {
    if (dataset.domain !== DOMAIN || !SUPPORTED_QUERY_CLASSES.has(request.queryClass)) {
      return result({
        sourceStatus: 'unsupported',
        requestedEntityCount: request.caller.clientIds?.length ?? 0,
        stopReason: 'query_class_not_supported',
      });
    }

    const requestedClientIds = unique(request.caller.clientIds ?? []);
    const authorizedClientIds = new Set(request.caller.authorizedClientIds ?? []);
    if (
      requestedClientIds.length === 0 ||
      requestedClientIds.some((clientId) => !authorizedClientIds.has(clientId))
    ) {
      return result({
        sourceStatus: 'unauthorized',
        requestedEntityCount: requestedClientIds.length,
        stopReason:
          requestedClientIds.length === 0
            ? 'client_subject_required'
            : 'client_outside_security_envelope',
      });
    }

    const pageSize = Math.min(Math.max(request.pageSize ?? 50, 1), 100);
    const query = request.query?.trim();
    const queryPattern = query ? `%${escapeLike(query)}%` : null;

    return this.prisma.withTenantUser(
      request.caller.tenantId,
      request.caller.userId,
      async (tx) => {
        // The explicit SecurityScope envelope is necessary but not sufficient.
        // Intersect it again with current CRM state and ethical-wall grants at
        // the adapter boundary so a stale/forged envelope cannot expose sp_*.
        const visibleClients = await tx.client.findMany({
          where: {
            tenantId: request.caller.tenantId,
            id: { in: requestedClientIds },
            status: { not: 'archived' },
            OR: [
              { memoryWall: false },
              { memoryAccessGrants: { some: { userId: request.caller.userId } } },
            ],
          },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        const clientIds = visibleClients.map((client) => client.id);
        if (clientIds.length !== requestedClientIds.length) {
          return result({
            sourceStatus: 'unauthorized',
            requestedEntityCount: requestedClientIds.length,
            searchedEntityCount: clientIds.length,
            stopReason: 'client_wall_or_status_denied',
          });
        }

        const clientSql = Prisma.join(clientIds.map((id) => Prisma.sql`${id}::uuid`));
        const cursorClause = cursor
          ? Prisma.sql`AND combined.record_key > ${cursor}`
          : Prisma.empty;
        const queryClause = queryPattern
          ? Prisma.sql`AND combined.payload::text ILIKE ${queryPattern} ESCAPE '\\'`
          : Prisma.empty;

        const rows = await tx.$queryRaw<StrategyWorkRow[]>(Prisma.sql`
          WITH strategy_rows AS (
            SELECT
              'strategy:' || s.id::text AS record_key,
              s.id::text AS record_id,
              'strategy'::text AS record_kind,
              s.client_id::text AS client_id,
              s.updated_at,
              jsonb_build_object(
                'kind', 'strategy',
                'id', s.id::text,
                'clientId', s.client_id::text,
                'title', s.title,
                'type', s.type::text,
                'goal', s.goal,
                'meriContext', s.meri_context,
                'meriSummary', s.meri_summary,
                'targetDate', s.target_date,
                'updatedAt', s.updated_at,
                'nodes', COALESCE((
                  SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', n.id::text,
                      'kind', n.kind::text,
                      'subject', n.subject::text,
                      'title', n.title,
                      'note', n.note,
                      'status', n.status::text,
                      'startsOn', n.starts_on,
                      'endsOn', n.ends_on,
                      'dependsOnIds', n.depends_on_ids,
                      'provenance', n.provenance
                    ) ORDER BY n.starts_on ASC, n.created_at ASC
                  )
                  FROM sp_node n
                  WHERE n.tenant_id = s.tenant_id
                    AND n.strategy_id = s.id
                    AND n.archived_at IS NULL
                ), '[]'::jsonb)
              ) AS payload
            FROM sp_strategy s
            WHERE s.tenant_id = ${request.caller.tenantId}::uuid
              AND s.client_id IN (${clientSql})
              AND s.archived_at IS NULL
          ),
          document_rows AS (
            SELECT
              'document:' || d.id::text AS record_key,
              d.id::text AS record_id,
              'context_document'::text AS record_kind,
              d.client_id::text AS client_id,
              d.updated_at,
              jsonb_build_object(
                'kind', 'context_document',
                'id', d.id::text,
                'clientId', d.client_id::text,
                'scope', d.scope::text,
                'scopeRef', d.scope_ref::text,
                'templateKey', d.template_key,
                'title', d.title,
                'state', d.state::text,
                'validUntil', d.valid_until,
                'updatedAt', d.updated_at
              ) AS payload
            FROM sp_context_document d
            WHERE d.tenant_id = ${request.caller.tenantId}::uuid
              AND (d.client_id IS NULL OR d.client_id IN (${clientSql}))
              AND d.state = 'active'::sp_context_doc_state
              AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)
          ),
          fact_rows AS (
            SELECT
              'fact:' || f.id::text AS record_key,
              f.id::text AS record_id,
              'context_fact'::text AS record_kind,
              f.client_id::text AS client_id,
              f.updated_at,
              jsonb_build_object(
                'kind', 'context_fact',
                'id', f.id::text,
                'clientId', f.client_id::text,
                'documentId', f.document_id::text,
                'documentTitle', d.title,
                'templateKey', d.template_key,
                'fact', f.fact,
                'sourceRef', f.source_ref,
                'authority', f.authority,
                'asOf', f.as_of,
                'confidence', f.confidence,
                'citation', f.citation,
                'updatedAt', f.updated_at
              ) AS payload
            FROM sp_context_fact f
            JOIN sp_context_document d
              ON d.tenant_id = f.tenant_id
             AND d.id = f.document_id
            WHERE f.tenant_id = ${request.caller.tenantId}::uuid
              AND (f.client_id IS NULL OR f.client_id IN (${clientSql}))
              AND f.state = 'active'::sp_fact_state
              AND d.state = 'active'::sp_context_doc_state
              AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)
          ),
          conflict_rows AS (
            SELECT
              'conflict:' || c.id::text AS record_key,
              c.id::text AS record_id,
              'context_conflict'::text AS record_kind,
              COALESCE(a.client_id, b.client_id)::text AS client_id,
              c.updated_at,
              jsonb_build_object(
                'kind', 'context_conflict',
                'id', c.id::text,
                'factAId', a.id::text,
                'factBId', b.id::text,
                'factA', a.fact,
                'factB', b.fact,
                'material', c.material,
                'state', c.state::text,
                'updatedAt', c.updated_at
              ) AS payload
            FROM sp_context_conflict c
            JOIN sp_context_fact a
              ON a.tenant_id = c.tenant_id AND a.id = c.fact_a_id
            JOIN sp_context_fact b
              ON b.tenant_id = c.tenant_id AND b.id = c.fact_b_id
            WHERE c.tenant_id = ${request.caller.tenantId}::uuid
              AND c.state = 'open'::sp_conflict_state
              AND c.material = TRUE
              AND (a.client_id IS NULL OR a.client_id IN (${clientSql}))
              AND (b.client_id IS NULL OR b.client_id IN (${clientSql}))
          ),
          combined AS (
            SELECT * FROM strategy_rows
            UNION ALL SELECT * FROM document_rows
            UNION ALL SELECT * FROM fact_rows
            UNION ALL SELECT * FROM conflict_rows
          )
          SELECT
            combined.record_key AS "recordKey",
            combined.record_id AS "recordId",
            combined.record_kind AS "recordKind",
            combined.client_id AS "clientId",
            combined.updated_at AS "updatedAt",
            combined.payload AS payload
          FROM combined
          WHERE TRUE
            ${cursorClause}
            ${queryClause}
          ORDER BY combined.record_key ASC
          LIMIT ${pageSize + 1}
        `);

        const hasMore = rows.length > pageSize;
        const page = rows.slice(0, pageSize);
        const records: RetrievalRecord[] = page.map((row) => ({
          domain: DOMAIN,
          recordId: `${row.recordKind}:${row.recordId}`,
          updatedAt: row.updatedAt,
          payload: row.payload as never,
          provenance: {
            adapter: this.key,
            sourceTable: sourceTable(row.recordKind),
            sourceRecordId: row.recordId,
            tenantId: request.caller.tenantId,
            clientId: row.clientId,
          },
          retrievalSignals: {
            clientRelevance: row.clientId == null ? 0.75 : 1,
            temporalValidity: 1,
          },
        }));
        const lastSyncAt = page.reduce<Date | undefined>((latest, row) => {
          if (!row.updatedAt) return latest;
          return !latest || row.updatedAt > latest ? row.updatedAt : latest;
        }, undefined);

        return {
          domain: DOMAIN,
          records,
          returned: records.length,
          hasMore,
          ...(hasMore && page.length
            ? { nextCursor: page[page.length - 1]!.recordKey }
            : {}),
          truncated: hasMore,
          sourceStatus: 'healthy',
          ...(lastSyncAt ? { lastSyncAt } : {}),
          recordsEvaluated: page.length + (hasMore ? 1 : 0),
          requestedEntityCount: requestedClientIds.length,
          searchedEntityCount: clientIds.length,
          pagesRead: 1,
          paginationComplete: !hasMore,
          coverageComplete: !hasMore,
          stopReason: hasMore ? 'page_limit_reached' : 'complete',
        };
      },
    );
  }
}

function result(input: {
  sourceStatus: RetrievalSourceResult['sourceStatus'];
  requestedEntityCount: number;
  searchedEntityCount?: number;
  stopReason: string;
}): RetrievalSourceResult {
  return {
    domain: DOMAIN,
    records: [],
    returned: 0,
    hasMore: false,
    truncated: false,
    sourceStatus: input.sourceStatus,
    recordsEvaluated: 0,
    requestedEntityCount: input.requestedEntityCount,
    searchedEntityCount: input.searchedEntityCount ?? 0,
    pagesRead: 0,
    paginationComplete: false,
    coverageComplete: false,
    stopReason: input.stopReason,
  };
}

function sourceTable(kind: StrategyWorkRow['recordKind']): string {
  if (kind === 'strategy') return 'sp_strategy/sp_node';
  if (kind === 'context_document') return 'sp_context_document';
  if (kind === 'context_fact') return 'sp_context_fact';
  return 'sp_context_conflict';
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
