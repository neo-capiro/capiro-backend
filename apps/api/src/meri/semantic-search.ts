import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Pure shape of Meri's three semantic (embedding) reads over the public
 * records that already carry Titan v2 vectors in `context_embeddings`:
 *
 *   semantic_search_bills                  source_type 'bill'                 (sync-congress, one row per bill)
 *   semantic_search_grants                 source_type 'funding_grant_chunk'  (embed-funding-catalog, chunks per grant)
 *   semantic_search_contract_opportunities source_type 'funding_notice_chunk' (embed-funding-catalog, chunks per SAM notice)
 *
 * Every row these reads rank is tenant-less public data (`tenant_id IS NULL`),
 * so no client wall applies; the HTTP owner still requires the verified
 * service identity, the signed-in member and an active membership before any
 * query runs. No SQL here interpolates caller text: the query vector is a
 * float literal Core produced itself and every other value is bound.
 */
export const SEMANTIC_SEARCH_OPERATIONS = [
  'semantic_search_bills',
  'semantic_search_grants',
  'semantic_search_contract_opportunities',
] as const;
export type SemanticSearchOperation = (typeof SEMANTIC_SEARCH_OPERATIONS)[number];

export const SEMANTIC_SEARCH_LIMITS = Object.freeze({
  maxQueryChars: 2000,
  /** Nearest-neighbour candidates read before chunk de-duplication and filters. */
  candidateLimit: 200,
  defaultLimit: 10,
  maxLimit: 25,
  /** Cosine similarity (1 - distance) a candidate must reach; the tracked-bill
   * matcher uses the same default floor for on-topic bills. */
  similarityFloor: 0.35,
  snippetChars: 400,
  embedTimeoutMs: 4000,
  statementTimeoutMs: 8000,
});

export interface SemanticSearchInput {
  query: string;
  limit: number;
  congress?: number;
  status?: string;
  agency?: string;
  naics?: string;
  includeInactive?: boolean;
  dateFrom?: string;
  dateTo?: string;
}

interface FamilyShape {
  readonly sourceType: string;
  readonly filters: readonly (keyof SemanticSearchInput)[];
  readonly dateField: string;
  readonly reference: string;
}

const FAMILIES: Readonly<Record<SemanticSearchOperation, FamilyShape>> = Object.freeze({
  semantic_search_bills: {
    sourceType: 'bill',
    filters: ['congress', 'status', 'dateFrom', 'dateTo'],
    dateField: 'latest action date',
    reference: 'congress_bill',
  },
  semantic_search_grants: {
    sourceType: 'funding_grant_chunk',
    filters: ['agency', 'status', 'dateFrom', 'dateTo'],
    dateField: 'close date',
    reference: 'federal_grant',
  },
  semantic_search_contract_opportunities: {
    sourceType: 'funding_notice_chunk',
    filters: ['agency', 'naics', 'includeInactive', 'dateFrom', 'dateTo'],
    dateField: 'response deadline',
    reference: 'sam_opportunity',
  },
});

export const SEMANTIC_SEARCH_SOURCE_TYPES: Readonly<Record<SemanticSearchOperation, string>> =
  Object.freeze(
    Object.fromEntries(
      SEMANTIC_SEARCH_OPERATIONS.map((operation) => [operation, FAMILIES[operation].sourceType]),
    ) as Record<SemanticSearchOperation, string>,
  );

export function isSemanticSearchOperation(name: string): name is SemanticSearchOperation {
  return (SEMANTIC_SEARCH_OPERATIONS as readonly string[]).includes(name);
}

const invalid = (message: string) => new BadRequestException(message);
const GRANT_STATUSES = ['posted', 'forecasted', 'closed', 'archived'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`${name} must be a string`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) throw invalid(`${name} must contain at most ${max} characters`);
  return text;
}

function optionalDate(value: unknown, name: string): string | undefined {
  const text = optionalText(value, name, 10);
  if (text === undefined) return undefined;
  if (!ISO_DATE.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`)))
    throw invalid(`${name} must be a calendar date (YYYY-MM-DD)`);
  return text;
}

/** One admitted input shape for all three reads; a filter the family does not
 * support is refused rather than ignored, so the model never believes a
 * constraint was applied. */
export function parseSemanticSearchInput(
  operation: SemanticSearchOperation,
  raw: unknown,
): SemanticSearchInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('Input must be an object');
  const body = raw as Record<string, unknown>;
  const family = FAMILIES[operation];
  const admitted = new Set<string>(['query', 'limit', ...family.filters]);
  const rejected = Object.keys(body).filter((key) => !admitted.has(key));
  if (rejected.length)
    throw invalid(`${operation} does not accept: ${rejected.sort().join(', ')}`);
  if (typeof body.query !== 'string') throw invalid('query must be a string');
  const query = body.query.replace(/\s+/g, ' ').trim();
  if (query.length < 3) throw invalid('query must contain at least 3 characters');
  if (query.length > SEMANTIC_SEARCH_LIMITS.maxQueryChars)
    throw invalid(`query must contain at most ${SEMANTIC_SEARCH_LIMITS.maxQueryChars} characters`);
  let limit: number = SEMANTIC_SEARCH_LIMITS.defaultLimit;
  if (body.limit !== undefined) {
    if (
      typeof body.limit !== 'number' ||
      !Number.isInteger(body.limit) ||
      body.limit < 1 ||
      body.limit > SEMANTIC_SEARCH_LIMITS.maxLimit
    )
      throw invalid(`limit must be an integer between 1 and ${SEMANTIC_SEARCH_LIMITS.maxLimit}`);
    limit = body.limit;
  }
  const input: SemanticSearchInput = { query, limit };
  if (family.filters.includes('congress') && body.congress !== undefined) {
    if (typeof body.congress !== 'number' || !Number.isInteger(body.congress) || body.congress < 93 || body.congress > 130)
      throw invalid('congress must be an integer Congress number (93-130)');
    input.congress = body.congress;
  }
  if (family.filters.includes('status')) {
    const status = optionalText(body.status, 'status', 40);
    if (status !== undefined) {
      if (operation === 'semantic_search_grants' && !GRANT_STATUSES.includes(status.toLowerCase()))
        throw invalid(`status must be one of ${GRANT_STATUSES.join(', ')}`);
      input.status = operation === 'semantic_search_grants' ? status.toLowerCase() : status;
    }
  }
  if (family.filters.includes('agency')) input.agency = optionalText(body.agency, 'agency', 240);
  if (family.filters.includes('naics')) {
    const naics = optionalText(body.naics, 'naics', 6);
    if (naics !== undefined && !/^\d{2,6}$/.test(naics)) throw invalid('naics must be 2-6 digits');
    input.naics = naics;
  }
  if (family.filters.includes('includeInactive') && body.includeInactive !== undefined) {
    if (typeof body.includeInactive !== 'boolean') throw invalid('includeInactive must be a boolean');
    input.includeInactive = body.includeInactive;
  }
  input.dateFrom = optionalDate(body.dateFrom, 'dateFrom');
  input.dateTo = optionalDate(body.dateTo, 'dateTo');
  if (input.dateFrom && input.dateTo && input.dateTo < input.dateFrom)
    throw invalid('dateTo must not be before dateFrom');
  return input;
}

/** Rows the family statements return; `record` carries the canonical fields. */
export interface SemanticSearchRow {
  parent_id: string;
  score: number;
  snippet: string;
  record: Record<string, unknown>;
}

function dateRange(column: Prisma.Sql, input: SemanticSearchInput): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  if (input.dateFrom) parts.push(Prisma.sql`${column} >= ${input.dateFrom}::date`);
  if (input.dateTo) parts.push(Prisma.sql`${column} <= ${input.dateTo}::date`);
  return parts;
}

function where(parts: Prisma.Sql[]): Prisma.Sql {
  return parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
}

function familyFilters(operation: SemanticSearchOperation, input: SemanticSearchInput): Prisma.Sql {
  switch (operation) {
    case 'semantic_search_bills': {
      const parts: Prisma.Sql[] = [];
      if (input.congress !== undefined) parts.push(Prisma.sql`cb.congress = ${input.congress}`);
      if (input.status !== undefined) parts.push(Prisma.sql`cb.status = ${input.status}`);
      parts.push(...dateRange(Prisma.sql`cb.latest_action_date`, input));
      return where(parts);
    }
    case 'semantic_search_grants': {
      const parts: Prisma.Sql[] = [];
      if (input.agency !== undefined) parts.push(Prisma.sql`g.agency ILIKE ${`%${input.agency}%`}`);
      if (input.status !== undefined) parts.push(Prisma.sql`g.status = ${input.status}`);
      parts.push(...dateRange(Prisma.sql`g.close_date`, input));
      return where(parts);
    }
    case 'semantic_search_contract_opportunities': {
      const parts: Prisma.Sql[] = [];
      if (!input.includeInactive) parts.push(Prisma.sql`o.active = TRUE`);
      if (input.agency !== undefined)
        parts.push(
          Prisma.sql`(o.agency ILIKE ${`%${input.agency}%`} OR o.sub_agency ILIKE ${`%${input.agency}%`})`,
        );
      if (input.naics !== undefined) parts.push(Prisma.sql`o.naics_code LIKE ${`${input.naics}%`}`);
      parts.push(...dateRange(Prisma.sql`o.response_deadline::date`, input));
      return where(parts);
    }
  }
}

function familyProjection(operation: SemanticSearchOperation): Prisma.Sql {
  switch (operation) {
    case 'semantic_search_bills':
      return Prisma.sql`FROM best JOIN congress_bill cb ON cb.id = best.parent_id
        CROSS JOIN LATERAL (SELECT jsonb_build_object(
          'id', cb.id, 'congress', cb.congress, 'billType', cb.bill_type, 'billNumber', cb.bill_number,
          'title', cb.title, 'sponsorName', cb.sponsor_name, 'sponsorParty', cb.sponsor_party,
          'sponsorState', cb.sponsor_state, 'policyArea', cb.policy_area, 'subjects', cb.subjects,
          'status', cb.status, 'introducedDate', cb.introduced_date, 'latestActionDate', cb.latest_action_date,
          'latestActionText', cb.latest_action_text, 'url', cb.url) AS record) r`;
    case 'semantic_search_grants':
      return Prisma.sql`FROM best JOIN federal_grant g ON g.id = best.parent_id
        CROSS JOIN LATERAL (SELECT jsonb_build_object(
          'id', g.id, 'title', g.title, 'agency', g.agency, 'subAgency', g.sub_agency,
          'opportunityNumber', g.opportunity_number, 'category', g.category, 'fundingInstrument', g.funding_instrument,
          'awardCeiling', g.award_ceiling, 'awardFloor', g.award_floor, 'estimatedFunding', g.estimated_funding,
          'openDate', g.open_date, 'closeDate', g.close_date, 'status', g.status, 'url', g.url) AS record) r`;
    case 'semantic_search_contract_opportunities':
      return Prisma.sql`FROM best JOIN sam_opportunity o ON o.id::text = best.parent_id
        CROSS JOIN LATERAL (SELECT jsonb_build_object(
          'id', o.id, 'noticeId', o.notice_id, 'solicitationNumber', o.solicitation_number, 'title', o.title,
          'noticeType', o.notice_type, 'agency', o.agency, 'subAgency', o.sub_agency, 'office', o.office,
          'setAside', o.set_aside, 'naicsCode', o.naics_code, 'pscCode', o.psc_code, 'postedDate', o.posted_date,
          'responseDeadline', o.response_deadline, 'active', o.active, 'url', o.source_url) AS record) r`;
  }
}

/**
 * One statement per read: the nearest `candidateLimit` vectors of the family
 * (served by the family's partial HNSW index), the best chunk per parent record
 * above the similarity floor, then the canonical record with its filters.
 * `vector` must come from `vectorLiteral(await embedText(query))`.
 */
export function semanticSearchSql(
  operation: SemanticSearchOperation,
  input: SemanticSearchInput,
  vector: string,
  model: string,
): Prisma.Sql {
  const family = FAMILIES[operation];
  const parent =
    operation === 'semantic_search_bills'
      ? Prisma.sql`ce.source_id`
      : Prisma.sql`ce.metadata_jsonb->>'parentId'`;
  return Prisma.sql`
    WITH candidates AS (
      SELECT ${parent} AS parent_id, ce.content_text,
             (1 - (ce.embedding <=> ${vector}::vector))::float8 AS score
        FROM context_embeddings ce
       WHERE ce.source_type = ${family.sourceType}
         AND ce.tenant_id IS NULL AND ce.client_id IS NULL AND ce.owner_user_id IS NULL
         AND ce.model = ${model}
         AND ce.embedding IS NOT NULL
       ORDER BY ce.embedding <=> ${vector}::vector
       LIMIT ${SEMANTIC_SEARCH_LIMITS.candidateLimit}
    ), best AS (
      SELECT DISTINCT ON (parent_id) parent_id, content_text, score
        FROM candidates
       WHERE parent_id IS NOT NULL AND score >= ${SEMANTIC_SEARCH_LIMITS.similarityFloor}
       ORDER BY parent_id, score DESC
    )
    SELECT best.parent_id, best.score, left(best.content_text, ${SEMANTIC_SEARCH_LIMITS.snippetChars}) AS snippet, r.record
    ${familyProjection(operation)}
    ${familyFilters(operation, input)}
    ORDER BY best.score DESC, best.parent_id ASC
    LIMIT ${input.limit}`;
}

/** How much of the family is reachable by this read: records with a current-model vector versus all records.
 * One statement, exact counts; the funding workers mark completion on the record, bills only in the vector table. */
export function semanticCoverageSql(operation: SemanticSearchOperation, model: string): Prisma.Sql {
  switch (operation) {
    case 'semantic_search_bills':
      return Prisma.sql`SELECT (SELECT count(*) FROM context_embeddings ce
          WHERE ce.source_type = 'bill' AND ce.tenant_id IS NULL AND ce.model = ${model})::int AS indexed,
        (SELECT count(*) FROM congress_bill)::int AS total`;
    case 'semantic_search_grants':
      return Prisma.sql`SELECT (SELECT count(*) FROM federal_grant WHERE embedded_at IS NOT NULL)::int AS indexed,
        (SELECT count(*) FROM federal_grant)::int AS total`;
    case 'semantic_search_contract_opportunities':
      return Prisma.sql`SELECT (SELECT count(*) FROM sam_opportunity WHERE embedded_at IS NOT NULL)::int AS indexed,
        (SELECT count(*) FROM sam_opportunity)::int AS total`;
  }
}

export interface SemanticCoverageRow {
  indexed: number;
  total: number;
}

export interface SemanticSearchResult {
  tool: SemanticSearchOperation;
  generatedAt: string;
  query: string;
  model: string;
  similarityFloor: number;
  candidateLimit: number;
  /** Records returned (never a corpus count). */
  total: number;
  /** Records of this kind with a current-model vector versus all stored records: only indexed records can be found. */
  coverage: { indexedRecords: number; totalRecords: number };
  notes: string[];
  results: Array<{
    reference: string;
    score: number;
    snippet: string;
    record: Record<string, unknown>;
  }>;
}

export function projectSemanticSearch(
  operation: SemanticSearchOperation,
  input: SemanticSearchInput,
  rows: readonly SemanticSearchRow[],
  coverageRow: SemanticCoverageRow | undefined,
  model: string,
  generatedAt: string,
): SemanticSearchResult {
  const family = FAMILIES[operation];
  const count = (value: unknown) => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0);
  const coverage = { indexedRecords: count(coverageRow?.indexed), totalRecords: count(coverageRow?.total) };
  if (coverage.indexedRecords > coverage.totalRecords) coverage.indexedRecords = coverage.totalRecords;
  const kind = family.reference.replace(/_/g, ' ');
  const unindexed = coverage.totalRecords - coverage.indexedRecords;
  const results = rows
    .filter(
      (row) =>
        typeof row.parent_id === 'string' &&
        row.parent_id.length > 0 &&
        Number.isFinite(row.score) &&
        row.score >= SEMANTIC_SEARCH_LIMITS.similarityFloor &&
        row.score <= 1 &&
        row.record &&
        typeof row.record === 'object' &&
        !Array.isArray(row.record),
    )
    .map((row) => ({
      reference: `${family.reference}:${row.parent_id}`,
      score: Math.round(row.score * 1000) / 1000,
      snippet: typeof row.snippet === 'string' ? row.snippet : '',
      record: row.record,
    }));
  const filters = family.filters.filter((key) => input[key] !== undefined && input[key] !== false);
  return {
    tool: operation,
    generatedAt,
    query: input.query,
    model,
    similarityFloor: SEMANTIC_SEARCH_LIMITS.similarityFloor,
    candidateLimit: SEMANTIC_SEARCH_LIMITS.candidateLimit,
    total: results.length,
    coverage,
    notes: [
      `Nearest-meaning ${kind} records by embedding similarity: the ${SEMANTIC_SEARCH_LIMITS.candidateLimit} closest vectors${filters.length ? `, then ${filters.join(', ')} filters` : ''}; similarity is not relevance. Date filters apply to the ${family.dateField}.`,
      `${coverage.indexedRecords} of ${coverage.totalRecords} stored ${kind} records are indexed for this read; a record without an index entry cannot be found here, so an empty page means no close match among the indexed records, never that none exists${unindexed > 0 ? ` (${unindexed} records are not indexed yet)` : ''}.`,
      ...(results.length
        ? []
        : [`No close match among the indexed ${kind} records for this query${filters.length ? ' and these filters' : ''}; say that the indexed records held no close match and that ${unindexed > 0 ? `${unindexed} records are not indexed yet` : 'the whole set is indexed'}, not that no such record exists.`]),
      'Each reference is a stable record identifier; use exact reads or SQL for counts, joins and fields beyond this record.',
    ],
    results,
  };
}
