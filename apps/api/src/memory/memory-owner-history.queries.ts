import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { ownerMemoryAccessSql } from './memory-owner-read-policy.js';
import { governedRecallEligibilitySql } from './memory-recall-suppression.helpers.js';

export interface HistoryRow {
  id: string;
  predecessor: string | null;
  revision: string;
  createdAt: string;
  title: string;
  sections: unknown;
  contentOversized?: boolean;
  current: boolean;
  eligible: boolean;
  sourceType: string | null;
  cycle: boolean;
}
export function ownerAnchorQuery(
  ctx: TenantContext,
  id: string,
  roster?: readonly string[],
  superseded = false,
) {
  return Prisma.sql`SELECT mi.id::text AS id,
    to_char(mi.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision
    FROM memory_items mi LEFT JOIN clients c ON c.tenant_id=mi.tenant_id AND c.id=mi.client_id
    WHERE mi.id=${id}::uuid AND ${ownerMemoryAccessSql(ctx, roster)}
    AND memory_retention_visible(mi.tenant_id,mi.retention_subject_id)
    AND ${
      superseded
        ? Prisma.sql`mi.status='superseded' AND mi.governed_status='superseded'
      AND (mi.effective_from IS NULL OR mi.effective_from<=clock_timestamp())
      AND (mi.valid_until IS NULL OR mi.valid_until>clock_timestamp())
      AND (mi.expires_at IS NULL OR mi.expires_at>clock_timestamp())`
        : Prisma.sql`
      (mi.controlling_item_id IS NULL OR mi.controlling_item_id=mi.id)
      AND ${Prisma.raw(governedRecallEligibilitySql('mi'))}`
    }`;
}
export function ownerHistoryQuery(ctx: TenantContext, id: string, roster?: readonly string[]) {
  const retained = Prisma.sql`(${ownerMemoryAccessSql(ctx, roster)}
    AND memory_retention_visible(mi.tenant_id,mi.retention_subject_id)
    AND ((mi.status='superseded' AND mi.governed_status='superseded')
      OR ${Prisma.raw(governedRecallEligibilitySql('mi'))})
    AND (mi.effective_from IS NULL OR mi.effective_from<=clock_timestamp())
    AND (mi.valid_until IS NULL OR mi.valid_until>clock_timestamp())
    AND (mi.expires_at IS NULL OR mi.expires_at>clock_timestamp()))`;
  return Prisma.sql`WITH RECURSIVE lineage AS (
    SELECT mi.id,mi.supersedes_id,ARRAY[mi.id] AS visited,false AS cycle
      FROM memory_items mi WHERE mi.tenant_id=${ctx.tenantId}::uuid AND mi.id=${id}::uuid
    UNION ALL
    SELECT parent.id,parent.supersedes_id,l.visited||parent.id,parent.id=ANY(l.visited)
      FROM lineage l JOIN memory_items parent ON parent.id=l.supersedes_id
      AND parent.tenant_id=${ctx.tenantId}::uuid
      WHERE NOT l.cycle AND cardinality(l.visited)<1000
  ) SELECT mi.id::text AS id,mi.supersedes_id::text AS predecessor,l.cycle,
    to_char(mi.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision,
    to_char(mi.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
    CASE WHEN ${retained} THEN mi.title ELSE '' END AS title,
    CASE WHEN ${retained} AND octet_length(mi.sections_jsonb::text)<=524288 THEN mi.sections_jsonb ELSE NULL END AS sections,
    (${retained} AND octet_length(mi.sections_jsonb::text)>524288) AS "contentOversized",
    CASE WHEN ${retained} THEN mi.source_type ELSE NULL END AS "sourceType",
    mi.id=${id}::uuid AS current,${retained} AS eligible
    FROM lineage l JOIN memory_items mi ON mi.id=l.id AND mi.tenant_id=${ctx.tenantId}::uuid
    LEFT JOIN clients c ON c.tenant_id=mi.tenant_id AND c.id=mi.client_id
    ORDER BY mi.created_at DESC,mi.id DESC LIMIT 1000`;
}
