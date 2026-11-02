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
 * The two funding reads also rank 'funding_attachment_chunk' passages (chunks of
 * an opportunity's attached documents, parent opportunity_attachment.id) and join
 * each back to its grant or notice through the attachment's soft parent link, so
 * one opportunity is returned once, with its closest passage from either text.
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
  /** opportunity_attachment column naming this family's parent; bills have no attachments. */
  readonly attachmentParent?: 'federal_grant_id' | 'sam_opportunity_id';
}

/** Chunks of attached opportunity documents (embed-funding-catalog `attachment`), shared by both funding reads. */
export const ATTACHMENT_SOURCE_TYPE = 'funding_attachment_chunk';
const UUID_TEXT = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

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
    attachmentParent: 'federal_grant_id',
  },
  semantic_search_contract_opportunities: {
    sourceType: 'funding_notice_chunk',
    filters: ['agency', 'naics', 'includeInactive', 'dateFrom', 'dateTo'],
    dateField: 'response deadline',
    reference: 'sam_opportunity',
    attachmentParent: 'sam_opportunity_id',
  },
});

export const SEMANTIC_SEARCH_SOURCE_TYPES: Readonly<Record<SemanticSearchOperation, string>> =
  Object.freeze(
    Object.fromEntries(
      SEMANTIC_SEARCH_OPERATIONS.map((operation) => [operation, FAMILIES[operation].sourceType]),
    ) as Record<SemanticSearchOperation, string>,
  );

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

/** Rows the family statements return: `record` carries the canonical fields, `passage` the closest passage's
 * citation metadata and `documents` the opportunity's attachment text coverage (both null for bills). */
export interface SemanticSearchRow {
  parent_id: string;
  score: number;
  snippet: string;
  record: Record<string, unknown>;
  passage?: Record<string, unknown> | null;
  documents?: Record<string, unknown> | null;
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
      if (input.congress !== undefined) parts.push(Prisma.sql`cb.congress = ${input.congress}::int`);
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

/** Citation metadata of the closest passage as embed-funding-catalog stored it (documentPlan): start and end are
 * UTF-16 offsets into the normalized extracted text, never pages; documentHash names the text version. */
const PASSAGE = Prisma.sql`jsonb_build_object(
          'sourceTable', best.meta->>'sourceTable', 'sourceUrl', best.meta->>'sourceUrl', 'fileName', pa.file_name,
          'documentHash', best.meta->>'documentHash', 'chunkIndex', best.meta->'chunkIndex', 'start', best.meta->'start',
          'end', best.meta->'end', 'extractionMethod', best.meta->>'extractionMethod', 'truncated', best.meta->'truncated',
          'embeddedAt', best.embedded_at)`;

/** Attachment text coverage of one opportunity by the embedder's own text rule (funding-document-text.ts):
 * provider text wins; local parser text counts only while it is bound to the archived bytes. */
function documentCoverage(parentColumn: 'federal_grant_id' | 'sam_opportunity_id', parent: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CROSS JOIN LATERAL (SELECT jsonb_build_object(
          'attachments', count(*)::int,
          'withText', (count(*) FILTER (WHERE x.provider_text OR x.local_chars > 10))::int,
          'truncated', (count(*) FILTER (WHERE NOT x.provider_text AND x.local_truncated))::int,
          'indexed', (count(*) FILTER (WHERE (x.provider_text OR x.local_chars > 10) AND a.embedded_at IS NOT NULL))::int) AS documents
        FROM opportunity_attachment a
        LEFT JOIN LATERAL (SELECT t.char_count, t.truncated FROM opportunity_document_text t
          WHERE t.attachment_id = a.id AND t.attachment_content_sha256 = a.content_sha256
            AND t.status = 'available' AND t.extraction_method = 'local_parser' LIMIT 1) t ON TRUE
        CROSS JOIN LATERAL (SELECT coalesce(length(a.provider_data->>'extracted_text'), 0) > 10 AS provider_text,
          coalesce(t.char_count, 0) AS local_chars, coalesce(t.truncated, FALSE) AS local_truncated) x
       WHERE a.${Prisma.raw(parentColumn)} = ${parent}) d`;
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
      // openForApplications is the posted-and-not-closed rule; a forecasted grant is announced, not yet open.
      return Prisma.sql`FROM best JOIN federal_grant g ON g.id = best.parent_id
        LEFT JOIN opportunity_attachment pa ON pa.id = best.attachment_id
        CROSS JOIN LATERAL (SELECT jsonb_build_object(
          'id', g.id, 'title', g.title, 'agency', g.agency, 'subAgency', g.sub_agency,
          'opportunityNumber', g.opportunity_number, 'category', g.category, 'fundingInstrument', g.funding_instrument,
          'awardCeiling', g.award_ceiling, 'awardFloor', g.award_floor, 'estimatedFunding', g.estimated_funding,
          'openDate', g.open_date, 'closeDate', g.close_date, 'responseDateDesc', g.response_date_desc, 'status', g.status,
          'openForApplications', (g.status = 'posted' AND (g.close_date IS NULL OR g.close_date >= CURRENT_DATE)),
          'url', g.url) AS record, ${PASSAGE} AS passage) r
        ${documentCoverage('federal_grant_id', Prisma.sql`g.id`)}`;
    case 'semantic_search_contract_opportunities':
      // currentNotice is the ingestion's current-notice rule; whether offers are taken also depends on noticeType.
      return Prisma.sql`FROM best JOIN sam_opportunity o ON o.id::text = best.parent_id
        LEFT JOIN opportunity_attachment pa ON pa.id = best.attachment_id
        CROSS JOIN LATERAL (SELECT jsonb_build_object(
          'id', o.id, 'noticeId', o.notice_id, 'solicitationNumber', o.solicitation_number, 'title', o.title,
          'noticeType', o.notice_type, 'agency', o.agency, 'subAgency', o.sub_agency, 'office', o.office,
          'setAside', o.set_aside, 'naicsCode', o.naics_code, 'pscCode', o.psc_code, 'postedDate', o.posted_date,
          'responseDeadline', o.response_deadline, 'active', o.active,
          'currentNotice', (o.active AND (o.response_deadline IS NULL OR o.response_deadline >= now())),
          'url', o.source_url) AS record, ${PASSAGE} AS passage) r
        ${documentCoverage('sam_opportunity_id', Prisma.sql`o.id`)}`;
  }
}

/**
 * One statement per read: the nearest `candidateLimit` vectors of each passage family (each served by its own
 * partial HNSW index), the best passage per parent record above the similarity floor, then the canonical record
 * with its filters. The funding reads rank description and attachment passages together; an attachment passage
 * reaches its opportunity only through an existing opportunity_attachment row whose parent link names this
 * family, so a passage whose attachment or opportunity is gone never reaches the page.
 * `vector` must come from `vectorLiteral(await embedText(query))`.
 */
export function semanticSearchSql(
  operation: SemanticSearchOperation,
  input: SemanticSearchInput,
  vector: string,
  model: string,
): Prisma.Sql {
  // Every source_type is a literal from this closed module, never caller text: the planner can only match a
  // family's partial HNSW index (WHERE source_type = '...') against a literal predicate, as
  // intelligence-tracked-bill-discovery.ts does for bills. The limits are literals from the frozen
  // SEMANTIC_SEARCH_LIMITS table for the same reason, and because Prisma binds a JavaScript integer as
  // bigint: `left(text, bigint)` has no Postgres signature (42883, seen live on 2 November 2026), and
  // LIMIT / comparison operands keep their natural int type. The one caller integer (limit, validated
  // 1..maxLimit) is bound with an explicit ::int cast.
  const family = FAMILIES[operation];
  const limits = SEMANTIC_SEARCH_LIMITS;
  const nearest = (sourceType: string, parent: Prisma.Sql) => Prisma.sql`
      SELECT ${parent} AS parent_id, ce.content_text, ce.metadata_jsonb AS meta, ce.updated_at AS embedded_at,
             (1 - (ce.embedding <=> ${vector}::vector))::float8 AS score
        FROM context_embeddings ce
       WHERE ce.source_type = ${Prisma.raw(`'${sourceType}'`)}
         AND ce.tenant_id IS NULL AND ce.client_id IS NULL AND ce.owner_user_id IS NULL
         AND ce.model = ${model}
         AND ce.embedding IS NOT NULL
       ORDER BY ce.embedding <=> ${vector}::vector
       LIMIT ${Prisma.raw(String(limits.candidateLimit))}`;
  const parent = family.attachmentParent;
  const candidates = parent
    ? Prisma.sql`description AS (${nearest(family.sourceType, Prisma.sql`ce.metadata_jsonb->>'parentId'`)}
    ), attachment AS (${nearest(ATTACHMENT_SOURCE_TYPE, Prisma.sql`ce.metadata_jsonb->>'parentId'`)}
    ), candidates AS (
      SELECT parent_id, content_text, meta, embedded_at, NULL::uuid AS attachment_id, score FROM description
      UNION ALL
      SELECT a.${Prisma.raw(parent)}::text, x.content_text, x.meta, x.embedded_at, a.id, x.score
        FROM attachment x
        JOIN opportunity_attachment a
          ON a.id = CASE WHEN x.parent_id ~ ${Prisma.raw(`'${UUID_TEXT}'`)} THEN x.parent_id::uuid END
       WHERE a.${Prisma.raw(parent)} IS NOT NULL`
    : Prisma.sql`candidates AS (${nearest(family.sourceType, Prisma.sql`ce.source_id`)}`;
  return Prisma.sql`
    WITH ${candidates}
    ), best AS (
      SELECT DISTINCT ON (parent_id) parent_id, content_text, meta, embedded_at, ${parent ? Prisma.sql`attachment_id` : Prisma.sql`NULL::uuid AS attachment_id`}, score
        FROM candidates
       WHERE parent_id IS NOT NULL AND score >= ${Prisma.raw(String(limits.similarityFloor))}::float8
       ORDER BY parent_id, score DESC
    )
    SELECT best.parent_id, best.score, left(best.content_text, ${Prisma.raw(String(limits.snippetChars))}) AS snippet, r.record,
           ${parent ? Prisma.sql`r.passage, d.documents` : Prisma.sql`NULL::jsonb AS passage, NULL::jsonb AS documents`}
    ${familyProjection(operation)}
    ${familyFilters(operation, input)}
    ORDER BY best.score DESC, best.parent_id ASC
    LIMIT ${input.limit}::int`;
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

/** Where the closest passage came from, as stored by embed-funding-catalog; every field is null when not recorded. */
export interface SemanticPassage {
  /** federal_grant or sam_opportunity for the opportunity's own description, opportunity_attachment for an attached document. */
  sourceTable: 'federal_grant' | 'sam_opportunity' | 'opportunity_attachment' | null;
  sourceUrl: string | null;
  fileName: string | null;
  documentHash: string | null;
  chunkIndex: number | null;
  /** UTF-16 offsets into the normalized extracted text, not pages. */
  start: number | null;
  end: number | null;
  extractionMethod: string | null;
  truncated: boolean | null;
  embeddedAt: string | null;
}

/** Attached documents of the opportunity: how many carry searchable text, truncated text or passages. */
export interface SemanticDocumentCoverage {
  attachments: number;
  withText: number;
  truncated: number;
  indexed: number;
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
    passage?: SemanticPassage;
    documents?: SemanticDocumentCoverage;
  }>;
}

const PASSAGE_TABLES = ['federal_grant', 'sam_opportunity', 'opportunity_attachment'] as const;
const nullableText = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);
const nullableCount = (value: unknown) => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null);
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function projectPassage(raw: unknown): SemanticPassage | undefined {
  if (!isObject(raw)) return undefined;
  const table = PASSAGE_TABLES.find((name) => name === raw.sourceTable) ?? null;
  // jsonb_build_object renders timestamptz as PostgreSQL text ("2026-11-01T09:30:00.123456+00:00"); publish ISO 8601 UTC.
  const at = raw.embeddedAt instanceof Date ? raw.embeddedAt : typeof raw.embeddedAt === 'string' ? new Date(raw.embeddedAt) : null;
  const embeddedAt = at && Number.isFinite(at.getTime()) ? at.toISOString() : null;
  return {
    sourceTable: table,
    sourceUrl: nullableText(raw.sourceUrl),
    fileName: table === 'opportunity_attachment' ? nullableText(raw.fileName) : null,
    documentHash: nullableText(raw.documentHash),
    chunkIndex: nullableCount(raw.chunkIndex),
    start: nullableCount(raw.start),
    end: nullableCount(raw.end),
    extractionMethod: nullableText(raw.extractionMethod),
    truncated: typeof raw.truncated === 'boolean' ? raw.truncated : null,
    embeddedAt,
  };
}

function projectDocuments(raw: unknown): SemanticDocumentCoverage | undefined {
  if (!isObject(raw)) return undefined;
  const attachments = nullableCount(raw.attachments) ?? 0;
  const bounded = (value: unknown) => Math.min(nullableCount(value) ?? 0, attachments);
  return { attachments, withText: bounded(raw.withText), truncated: bounded(raw.truncated), indexed: bounded(raw.indexed) };
}

const STATUS_NOTES: Partial<Record<SemanticSearchOperation, string>> = {
  semantic_search_grants:
    'openForApplications is status posted with a close date not yet passed or not set; a forecasted grant is announced and not yet accepting applications, so name it as forecasted. A null closeDate is an unknown deadline: read responseDateDesc before calling it continuous. awardCeiling is the most one award can receive and estimatedFunding the program total; neither is money awarded, and who received awards is in the federal awards data.',
  semantic_search_contract_opportunities:
    'currentNotice is the active flag with a response deadline not yet passed or not set. Whether offers are taken also depends on noticeType: a Solicitation or Combined Synopsis/Solicitation takes offers, Sources Sought and Presolicitation gather interest, an Award Notice announces a winner. A solicitation number can be shared by several notices of one procurement; cite the notice id.',
};

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
        isObject(row.record),
    )
    .map((row) => {
      const passage = family.attachmentParent ? projectPassage(row.passage) : undefined;
      const documents = family.attachmentParent ? projectDocuments(row.documents) : undefined;
      return {
        reference: `${family.reference}:${row.parent_id}`,
        score: Math.round(row.score * 1000) / 1000,
        snippet: typeof row.snippet === 'string' ? row.snippet : '',
        record: row.record,
        ...(passage ? { passage } : {}),
        ...(documents ? { documents } : {}),
      };
    });
  const filters = family.filters.filter((key) => input[key] !== undefined && input[key] !== false);
  const ranked = family.attachmentParent
    ? `the ${SEMANTIC_SEARCH_LIMITS.candidateLimit} closest description passages and the ${SEMANTIC_SEARCH_LIMITS.candidateLimit} closest attached-document passages, best passage per record`
    : `the ${SEMANTIC_SEARCH_LIMITS.candidateLimit} closest vectors`;
  const gaps = results.filter(
    (row) => row.documents && (row.documents.withText < row.documents.attachments || row.documents.truncated > 0 || row.documents.indexed < row.documents.withText),
  ).length;
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
      `Nearest-meaning ${kind} records by embedding similarity: ${ranked}${filters.length ? `, then ${filters.join(', ')} filters` : ''}; similarity is not relevance. Date filters apply to the ${family.dateField}.`,
      `${coverage.indexedRecords} of ${coverage.totalRecords} stored ${kind} records are indexed for this read; a record without an index entry cannot be found here, so an empty page means no close match among the indexed records, never that none exists${unindexed > 0 ? ` (${unindexed} records are not indexed yet)` : ''}.`,
      ...(results.length
        ? []
        : [`No close match among the indexed ${kind} records for this query${filters.length ? ' and these filters' : ''}; say that the indexed records held no close match and that ${unindexed > 0 ? `${unindexed} records are not indexed yet` : 'the whole set is indexed'}, not that no such record exists.`]),
      'Each reference is a stable record identifier; use exact reads or SQL for counts, joins and fields beyond this record.',
      ...(family.attachmentParent
        ? [
            'passage is the cited text: sourceTable names the opportunity description or opportunity_attachment (an attached document, fileName); start and end are UTF-16 offsets into the normalized extracted text, not page numbers; documentHash is the text version. A passage is relevance evidence, not proof of eligibility. The record fields are current; a passage embedded (embeddedAt) before the opportunity last changed can describe earlier text.',
            STATUS_NOTES[operation]!,
          ]
        : []),
      ...(gaps
        ? [`${gaps} of these records have attached documents without searchable text, with truncated text or not indexed yet (see documents); a requirement missing from the passages is a coverage gap, not proof it is absent.`]
        : []),
    ],
    results,
  };
}
