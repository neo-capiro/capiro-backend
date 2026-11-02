import { BILL_EXTRACTION_VERSION } from '../ingestion/bill-document-structure.js';
import { FEDERAL_FY26_SQL, STATE_FY26_SQL } from '../ingestion/bill-text-scope.js';

export const BILL_JURISDICTIONS = [
  'US',
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
] as const;
export type BillTextFilters = {
  jurisdictions?: string[];
  session?: string;
  billId?: string;
  billNumber?: string;
  status?: string;
  version?: string;
  kind?: 'text' | 'amendment' | 'supplement';
  dateFrom?: string;
  dateBefore?: string;
  dateBasis?: 'published' | 'introduced' | 'action';
  fiscalYear?: 2026;
};
export type BillTextSearchRequest = BillTextFilters & {
  mode: 'exact' | 'keyword' | 'semantic';
  query?: string;
  section?: string;
  page?: number;
  limit?: number;
};
export type BillTextIdentity = {
  sourceKind: 'federal' | 'state';
  billId: string;
  billNumber: string;
  jurisdiction: string;
  session: string;
  version: string | null;
  versionId: string;
  providerDocumentId: string | null;
  revisionId: string;
  revisionHash: string;
  documentHash: string;
  originalBytesHash: string | null;
  extractionId: string | null;
  structureHash: string | null;
  textHash: string | null;
  extractionVersion: string | null;
  sourceUrl: string | null;
  publishedDate: string | null;
};
export type BillTextDocumentRow = BillTextIdentity & {
  title: string;
  kind: string;
  status: string | null;
  completeness: string | null;
  text: string | null;
  structure: unknown;
  warnings: string[] | null;
  score?: number;
  total?: number;
  passageMetadata?: Record<string, unknown>;
  hitOffset?: number;
};

function short(value: unknown, name: string, max = 160): void {
  if (
    value !== undefined &&
    (typeof value !== 'string' ||
      !value.trim() ||
      value.length > max ||
      /[\u0000-\u001f]/.test(value))
  )
    throw Error(`INVALID_${name}`);
}
export function validateBillTextFilters(request: BillTextFilters): void {
  if (
    request.jurisdictions !== undefined &&
    (!Array.isArray(request.jurisdictions) ||
      !request.jurisdictions.length ||
      request.jurisdictions.length > 52 ||
      request.jurisdictions.some(
        (j) => !BILL_JURISDICTIONS.includes(j as (typeof BILL_JURISDICTIONS)[number]),
      ))
  )
    throw Error('INVALID_JURISDICTIONS');
  for (const key of ['session', 'billId', 'billNumber', 'status', 'version'] as const)
    short(request[key], key.toUpperCase());
  if (request.kind !== undefined && !['text', 'amendment', 'supplement'].includes(request.kind))
    throw Error('INVALID_DOCUMENT_KIND');
  if (
    request.dateBasis !== undefined &&
    !['published', 'introduced', 'action'].includes(request.dateBasis)
  )
    throw Error('INVALID_DATE_BASIS');
  if (request.fiscalYear !== undefined && request.fiscalYear !== 2026)
    throw Error('INVALID_FISCAL_YEAR');
  for (const value of [request.dateFrom, request.dateBefore]) {
    if (
      value !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      throw Error('INVALID_DATE');
  }
  if (request.dateFrom && request.dateBefore && request.dateFrom >= request.dateBefore)
    throw Error('INVALID_DATE_RANGE');
}
export function validateBillTextSearch(request: BillTextSearchRequest) {
  const allowed = new Set([
    'mode',
    'query',
    'section',
    'page',
    'limit',
    'jurisdictions',
    'session',
    'billId',
    'billNumber',
    'status',
    'version',
    'kind',
    'dateFrom',
    'dateBefore',
    'dateBasis',
    'fiscalYear',
  ]);
  if (!request || Object.keys(request).some((key) => !allowed.has(key)))
    throw Error('INVALID_SEARCH_FIELD');
  validateBillTextFilters(request);
  if (!['exact', 'keyword', 'semantic'].includes(request.mode)) throw Error('INVALID_SEARCH_MODE');
  const limit = request.limit ?? 8,
    page = request.page ?? 1;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 20 ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10000
  )
    throw Error('INVALID_PAGINATION');
  if (request.mode === 'exact') {
    if (
      !request.billId &&
      !(request.billNumber && request.session && request.jurisdictions?.length === 1)
    )
      throw Error('EXACT_BILL_REQUIRES_ID_OR_JURISDICTION_SESSION_NUMBER');
  } else short(request.query, 'QUERY', 1000);
  if (request.mode !== 'exact' && !request.query) throw Error('QUERY_REQUIRED');
  short(request.section, 'SECTION', 200);
  if (request.section && request.mode !== 'exact') throw Error('SECTION_REQUIRES_EXACT_MODE');
  return { ...request, limit, page };
}

/** Quoted phrases are literal, case-insensitive, with whitespace folded. Punctuation and stopwords remain significant. */
export function billKeywordParts(query: string): { terms: string; phrases: string[] } {
  const phrases: string[] = [];
  const terms = query
    .replace(/"([^"\n]+)"/g, (_all, phrase: string) => {
      phrases.push(phrase.toLowerCase().replace(/\s+/g, ' ').trim());
      return ' ';
    })
    .trim();
  if (terms.includes('"') || phrases.length > 8 || (!terms && !phrases.length))
    throw Error('INVALID_KEYWORD_QUERY');
  return { terms, phrases };
}

/** Public immutable evidence owners; no current-only join drops retained revisions. */
export const BILL_DOCUMENTS_SQL = `WITH sources AS (
 SELECT 'federal'::text AS "sourceKind",b.id AS "billId",upper(b.bill_type)||b.bill_number AS "billNumber",'US'::text jurisdiction,
 b.congress::text session,r.version_code version,r.package_id AS "versionId",coalesce(r.metadata_jsonb->>'amendmentId',r.package_id) AS "providerDocumentId",
 r.id::text AS "revisionId",r.extraction_hash AS "revisionHash",r.content_hash AS "documentHash",r.metadata_jsonb->>'rawBytesHash' AS "originalBytesHash",r.source_url AS "sourceUrl",
 (r.published_at AT TIME ZONE 'UTC')::date::text AS "publishedDate",b.title,CASE r.collection WHEN 'AMENDMENTS' THEN 'amendment' ELSE 'text' END AS kind,b.status,b.introduced_date::text AS "introducedDate",
 (${FEDERAL_FY26_SQL}) AS "fy26",r.id AS revision_uuid,
 ARRAY(SELECT a.date::date::text FROM congress_bill_action a WHERE a.bill_id=b.id) AS "actionDates"
 FROM federal_evidence_revision r JOIN congress_bill b ON b.id=r.bill_id WHERE r.collection IN ('BILLS','AMENDMENTS')
 UNION ALL
 SELECT 'state',b.id,b.bill_number,b.state,b.session_key,r.evidence->>'versionType',r.source_identity,r.evidence->>'providerId',
 r.id::text,r.revision_hash,coalesce(r.evidence->>'contentHash',''),r.evidence->>'contentHash',r.evidence->>'url',r.event_date,b.title,
 coalesce(r.evidence->>'documentKind','text'),b.status,
 (SELECT min(p->>'date') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.legiscan_progress)='array' THEN b.legiscan_progress ELSE '[]'::jsonb END) p WHERE p->>'event'='1'),
 (${STATE_FY26_SQL}),r.id,
 ARRAY(SELECT a.event_date FROM state_bill_published_record a WHERE a.bill_key=b.id AND a.kind='action'
 UNION SELECT a.date::date::text FROM state_bill_action a WHERE a.bill_key=b.id
 UNION SELECT p->>'date' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.legiscan_progress)='array' THEN b.legiscan_progress ELSE '[]'::jsonb END) p)
 FROM state_bill_published_record r JOIN state_bill b ON b.id=r.bill_key WHERE r.kind='document'
), documents AS (
 SELECT s.*,e.id::text AS "extractionId",e.structure_hash AS "structureHash",e.text_hash AS "textHash",e.parser_version AS "extractionVersion",
 e.extracted_text text,e.structure_jsonb structure,e.completeness,e.warnings_jsonb warnings
 FROM sources s LEFT JOIN LATERAL (
 SELECT e.* FROM bill_text_extraction e WHERE e.source_kind=s."sourceKind" AND e.revision_id=s.revision_uuid
 AND ($1::text IS NULL OR e.id::text=$1) AND ($1::text IS NOT NULL OR e.parser_version=$2)
 ORDER BY CASE e.completeness WHEN 'complete' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,e.created_at DESC,e.id DESC LIMIT 1
 ) e ON true
)`;

export function billDocumentQuery(filters: BillTextFilters, extractionId: string | null = null) {
  validateBillTextFilters(filters);
  const values: unknown[] = [extractionId, BILL_EXTRACTION_VERSION];
  const conditions: string[] = [];
  const add = (value: unknown, sql: (p: string) => string) => {
    values.push(value);
    conditions.push(sql(`$${values.length}`));
  };
  if (filters.jurisdictions) add(filters.jurisdictions, (p) => `d.jurisdiction=ANY(${p}::text[])`);
  if (filters.session) add(filters.session, (p) => `d.session=${p}`);
  if (filters.billId) add(filters.billId, (p) => `d."billId"=${p}`);
  if (filters.billNumber)
    add(
      filters.billNumber.replace(/[ .-]/g, '').toUpperCase(),
      (p) => `upper(regexp_replace(d."billNumber",'[ .-]','','g'))=${p}`,
    );
  if (filters.status) add(filters.status, (p) => `d.status=${p}`);
  if (filters.version) add(filters.version, (p) => `(d.version=${p} OR d."versionId"=${p})`);
  if (filters.kind) add(filters.kind, (p) => `d.kind=${p}`);
  if (filters.fiscalYear) conditions.push('d.fy26');
  const date =
    filters.dateBasis === 'introduced'
      ? 'd."introducedDate"'
      : filters.dateBasis === 'action'
        ? 'ad.date'
        : 'd."publishedDate"';
  const dates: string[] = [];
  if (filters.dateFrom) {
    values.push(filters.dateFrom);
    dates.push(`${date}>=$${values.length}`);
  }
  if (filters.dateBefore) {
    values.push(filters.dateBefore);
    dates.push(`${date}<$${values.length}`);
  }
  if (dates.length)
    conditions.push(
      filters.dateBasis === 'action'
        ? `EXISTS(SELECT 1 FROM unnest(d."actionDates") ad(date) WHERE ${dates.join(' AND ')})`
        : dates.join(' AND '),
    );
  return { sql: BILL_DOCUMENTS_SQL, values, conditions };
}
