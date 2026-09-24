import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const CURSOR_VERSION = 1;

type ReadCursor = {
  v: 1;
  kind: 'qualified-mentions' | 'lifecycle-timeline';
  scope: string;
  createdAt: string;
  id: string;
};

export interface FederalEvidenceReadPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface FederalEvidenceReadOptions {
  limit?: number;
  cursor?: string | null;
}

export interface FederalEvidenceTimelineScope {
  peCode?: string;
  billId?: string;
}

/** Public, read-only projection over the append-only federal evidence tables. */
@Injectable()
export class FederalEvidenceReadService {
  constructor(private readonly prisma: PrismaService) {}

  /** Current qualified mentions for one PE, excluding superseded/removed source observations. */
  async currentQualifiedMentions(
    peCode: string,
    options: FederalEvidenceReadOptions = {},
  ): Promise<FederalEvidenceReadPage<Record<string, unknown>>> {
    const normalizedPeCode = normalizeRequired(peCode, 'peCode');
    const limit = pageLimit(options.limit);
    const scope = `pe:${normalizedPeCode}`;
    const cursor = decodeCursor(options.cursor, 'qualified-mentions', scope);
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `WITH current_observation AS (
         SELECT DISTINCT ON (source_key) source_key, revision_id, state
         FROM federal_evidence_observation
         ORDER BY source_key, id DESC
       )
       SELECT m.id, m.raw_mention AS "rawMention",
              COALESCE(m.canonical_pe_code, resolved.canonical_pe_code) AS "canonicalPeCode",
              m.match_type AS "matchType",
              CASE WHEN resolved.canonical_pe_code IS NOT NULL THEN 'qualified'
                   ELSE m.qualification_state END AS "qualificationState",
              m.confidence, m.locator, m.evidence, m.language_hash AS "languageHash",
              m.matcher_version AS "matcherVersion", m.qualified_by AS "qualifiedBy",
              m.created_at AS "createdAt", r.id AS "revisionId", r.source_key AS "sourceKey",
              r.provider, r.collection, r.package_id AS "packageId", r.bill_id AS "billId",
              r.version_code AS "versionCode", r.lineage_key AS "lineageKey",
              r.content_hash AS "contentHash", r.extraction_hash AS "extractionHash",
              r.source_url AS "sourceUrl", r.source_modified_at AS "sourceModifiedAt",
              r.published_at AS "publishedAt", r.fetched_at AS "fetchedAt"
       FROM current_observation o
       JOIN federal_evidence_revision r ON r.id = o.revision_id
       JOIN federal_evidence_mention m ON m.revision_id = r.id
       LEFT JOIN LATERAL (
         SELECT e.canonical_pe_code
           FROM federal_evidence_mention_event e
          WHERE e.event_type = 'resolved' AND e.current_revision_id = m.revision_id
            AND e.candidate_key = m.candidate_key
          ORDER BY e.created_at DESC LIMIT 1
       ) resolved ON TRUE
       WHERE o.state = 'present'
         AND (m.qualification_state = 'qualified' OR resolved.canonical_pe_code IS NOT NULL)
         AND COALESCE(m.canonical_pe_code, resolved.canonical_pe_code) = $1
         AND ($2::timestamptz IS NULL OR (m.created_at, m.id) < ($2::timestamptz, $3::uuid))
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $4`,
      normalizedPeCode,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    );
    return page(rows, limit, 'qualified-mentions', scope);
  }

  /** Append-only lifecycle events, filterable by PE and/or bill. */
  async lifecycleTimeline(
    requestedScope: FederalEvidenceTimelineScope,
    options: FederalEvidenceReadOptions = {},
  ): Promise<FederalEvidenceReadPage<Record<string, unknown>>> {
    const scope: FederalEvidenceTimelineScope = {
      ...(requestedScope.peCode ? { peCode: normalizeRequired(requestedScope.peCode, 'peCode') } : {}),
      ...(requestedScope.billId ? { billId: normalizeRequired(requestedScope.billId, 'billId') } : {}),
    };
    if (!scope.peCode && !scope.billId) {
      throw new BadRequestException('At least one of peCode or billId is required');
    }
    const limit = pageLimit(options.limit);
    const scopeKey = timelineScopeKey(scope);
    const cursor = decodeCursor(options.cursor, 'lifecycle-timeline', scopeKey);
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT e.id, e.event_key AS "eventKey", e.source_key AS "sourceKey", e.bill_id AS "billId",
              e.event_type AS "eventType", e.candidate_key AS "candidateKey", e.raw_mention AS "rawMention",
              e.canonical_pe_code AS "canonicalPeCode", e.previous_revision_id AS "previousRevisionId",
              e.current_revision_id AS "currentRevisionId", e.before_jsonb AS "before",
              e.after_jsonb AS "after", e.historical,
              e.created_at AS "createdAt", r.id AS "revisionId", r.provider, r.collection,
              r.package_id AS "packageId", r.version_code AS "versionCode", r.lineage_key AS "lineageKey",
              r.content_hash AS "contentHash", r.extraction_hash AS "extractionHash",
              r.source_url AS "sourceUrl", r.source_modified_at AS "sourceModifiedAt",
              r.published_at AS "publishedAt", r.fetched_at AS "fetchedAt",
              m.locator, m.evidence, m.language_hash AS "languageHash", m.match_type AS "matchType",
              m.qualification_state AS "qualificationState", m.confidence
       FROM federal_evidence_mention_event e
       LEFT JOIN federal_evidence_revision r
         ON r.id = COALESCE(e.current_revision_id, e.previous_revision_id)
       LEFT JOIN federal_evidence_mention m
         ON m.revision_id = r.id AND m.candidate_key = e.candidate_key
       WHERE ($1::text IS NULL OR e.canonical_pe_code = $1)
         AND ($2::text IS NULL OR e.bill_id = $2)
         AND ($3::timestamptz IS NULL OR (e.created_at, e.id) < ($3::timestamptz, $4::uuid))
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT $5`,
      scope.peCode ?? null,
      scope.billId ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    );
    return page(rows, limit, 'lifecycle-timeline', scopeKey);
  }
}

function pageLimit(value?: number): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new BadRequestException(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  return value;
}

function normalizeRequired(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new BadRequestException(`${label} is required`);
  return normalized;
}

function timelineScopeKey(scope: FederalEvidenceTimelineScope): string {
  return `pe:${scope.peCode ?? ''}|bill:${scope.billId ?? ''}`;
}

function decodeCursor(
  encoded: string | null | undefined,
  kind: ReadCursor['kind'],
  scope: string,
): ReadCursor | null {
  if (!encoded) return null;
  try {
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<ReadCursor>;
    if (
      decoded.v !== CURSOR_VERSION || decoded.kind !== kind || decoded.scope !== scope ||
      typeof decoded.createdAt !== 'string' || !Number.isFinite(Date.parse(decoded.createdAt)) ||
      typeof decoded.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(decoded.id)
    ) throw new Error('invalid cursor');
    return decoded as ReadCursor;
  } catch {
    throw new BadRequestException('Invalid or mismatched federal evidence cursor');
  }
}

function page<T extends Record<string, unknown>>(
  rows: T[],
  limit: number,
  kind: ReadCursor['kind'],
  scope: string,
): FederalEvidenceReadPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  const createdAt = last?.createdAt;
  const id = last?.id;
  return {
    items,
    hasMore,
    nextCursor: hasMore && createdAt instanceof Date && typeof id === 'string'
      ? Buffer.from(JSON.stringify({ v: CURSOR_VERSION, kind, scope, createdAt: createdAt.toISOString(), id } satisfies ReadCursor)).toString('base64url')
      : null,
  };
}
