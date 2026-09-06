import { createHash } from 'node:crypto';
import type { KnowledgeJsonObject } from '../../knowledge/knowledge.types.js';
import type {
  RetrievalDomain,
  RetrievalRecord,
  RetrievalRequest,
  RetrievalSourceResult,
} from '../retrieval-v2.types.js';

export interface PublicDomainCursor {
  page: number;
  subject: number;
  family: number;
}

export function publicPageSize(request: RetrievalRequest): number {
  const size = request.pageSize ?? 50;
  return Number.isFinite(size) ? Math.min(100, Math.max(1, Math.trunc(size))) : 50;
}

function fingerprint(domain: RetrievalDomain, request: RetrievalRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        domain,
        tenantId: request.caller.tenantId,
        userId: request.caller.userId,
        clientIds: request.caller.clientIds ?? [],
        query: request.query?.trim() ?? '',
        queryClass: request.queryClass,
        windowStart: request.windowStart?.toISOString(),
        windowEnd: request.windowEnd?.toISOString(),
        pageSize: publicPageSize(request),
      }),
    )
    .digest('hex');
}

/** Cursors cannot be replayed into another tenant, subject, filter or page size. */
export function encodePublicCursor(
  domain: RetrievalDomain,
  request: RetrievalRequest,
  position: PublicDomainCursor,
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      fingerprint: fingerprint(domain, request),
      ...position,
    }),
  ).toString('base64url');
}

export function decodePublicCursor(
  domain: RetrievalDomain,
  request: RetrievalRequest,
  cursor?: string,
): PublicDomainCursor | null {
  if (!cursor) return { page: 1, subject: 0, family: 0 };
  if (cursor.length > 2048) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value.v !== 1 || value.fingerprint !== fingerprint(domain, request)) return null;
    if (![value.page, value.subject, value.family].every(Number.isSafeInteger)) return null;
    if (value.page < 1 || value.page > 1_000_000 || value.subject < 0 || value.family < 0)
      return null;
    return { page: value.page, subject: value.subject, family: value.family };
  } catch {
    return null;
  }
}

export function publicJson(value: unknown): KnowledgeJsonObject {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  ) as KnowledgeJsonObject;
}

export function sourceDate(value: unknown): Date | undefined {
  if (!(value instanceof Date) && typeof value !== 'string') return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function oldestSourceDate(values: unknown[]): Date | undefined {
  const dates = values.map(sourceDate).filter((date): date is Date => Boolean(date));
  return dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : undefined;
}

export function publicResult(
  domain: RetrievalDomain,
  request: RetrievalRequest,
  fields: Partial<RetrievalSourceResult> &
    Pick<RetrievalSourceResult, 'sourceStatus' | 'stopReason'>,
): RetrievalSourceResult {
  return {
    domain,
    records: [],
    returned: 0,
    hasMore: false,
    truncated: false,
    recordsEvaluated: 0,
    requestedEntityCount:
      request.canonicalEntityIds?.length ?? request.caller.clientIds?.length ?? 0,
    searchedEntityCount: 0,
    pagesRead: 0,
    paginationComplete: false,
    coverageComplete: false,
    ...fields,
  };
}

export function publicRecord(
  domain: RetrievalDomain,
  recordId: string,
  payload: unknown,
  provenance: KnowledgeJsonObject,
  dates: { occurredAt?: unknown; updatedAt?: unknown } = {},
): RetrievalRecord {
  return {
    domain,
    recordId,
    occurredAt: sourceDate(dates.occurredAt) ?? null,
    updatedAt: sourceDate(dates.updatedAt) ?? null,
    payload: publicJson(payload),
    provenance: {
      adapter: 'public-domain-services',
      coverageBasis: 'ingested_source_records',
      ...provenance,
    },
  };
}
