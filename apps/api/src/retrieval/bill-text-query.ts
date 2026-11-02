import { BILL_EXTRACTION_VERSION } from '../ingestion/bill-document-structure.js';
import { CHUNKER_VERSION } from '../ingestion/bill-text-passages.js';
import {
  FEDERAL_FY26_SQL,
  STATE_FY26_SQL,
  validBillCalendarDateSql,
} from '../ingestion/bill-text-scope.js';

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
  candidatePassages?: number;
  hitOffset?: number;
};

/** Upper bound on the nearest passage shortlist, not a count of the searchable corpus. */
export const BILL_SEMANTIC_CANDIDATE_LIMIT = 1000;

/** Trusted SQL expressions only. Search and coverage must prove the same public, unchanged embedding input. */
export function billPassageVectorProofSql(input: {
  vector: string;
  passage: string;
  sourceKind: string;
  billId: string;
  revisionId: string;
  extractionId: string;
  structureHash: string;
  textHash: string;
  chunker: string;
  model: string;
}) {
  const { vector: v, passage: p } = input;
  return `${v}.tenant_id IS NULL AND ${v}.client_id IS NULL AND ${v}.owner_user_id IS NULL
    AND ${v}.source_type=CASE ${input.sourceKind} WHEN 'federal' THEN 'bill_passage' ELSE 'state_bill_passage' END
    AND ${v}.model=${input.model} AND ${p}.chunker_version=${input.chunker}
    AND ${p}.metadata_jsonb->>'semanticAvailable'='true'
    AND ${v}.source_id=${input.chunker}||':'||${input.extractionId}||':'||${p}.ordinal::text
    AND ${v}.content_text=${p}.content_text
    AND ${v}.content_hash=encode(sha256(convert_to(${p}.content_text,'UTF8')),'hex')
    AND ${v}.metadata_jsonb->>'billId'=${input.billId}
    AND ${v}.metadata_jsonb->>'revisionId'=${input.revisionId}
    AND ${v}.metadata_jsonb->>'extractionId'=${input.extractionId}
    AND ${v}.metadata_jsonb->>'structureHash'=${input.structureHash}
    AND ${v}.metadata_jsonb->>'textHash'=${input.textHash}
    AND ${v}.metadata_jsonb->>'extractionVersion'='${BILL_EXTRACTION_VERSION}'
    AND ${v}.metadata_jsonb->>'chunkerVersion'=${input.chunker}`;
}

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
  if (request.mode === 'semantic' && (page - 1) * limit >= BILL_SEMANTIC_CANDIDATE_LIMIT)
    throw Error('SEMANTIC_PAGE_EXCEEDS_CANDIDATE_LIMIT');
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

/** Literal phrases may match a substring at either edge. Only interior whitespace-delimited
 * alphabetic words are safe lexeme prefilters; edge fragments and punctuation still use the literal verifier. */
export function billPhrasePrefilterTerms(phrases: string[]): string {
  return phrases
    .flatMap((phrase) => [...phrase.matchAll(/(?<= )[a-z]+(?= )/g)].map((match) => match[0]))
    .join(' ');
}

/** Public immutable evidence owners; no current-only join drops retained revisions.
 * Semantic hydration joins only the already bounded revision keys before reading
 * source metadata/action arrays or selecting an extraction. */
function billDocumentsSql(shortlisted = false) {
  const keys = (kind: 'federal' | 'state') =>
    shortlisted
      ? ` JOIN semantic_revision_keys k ON k.source_kind='${kind}' AND k.revision_uuid=r.id`
      : '';
  return `WITH sources AS (
 SELECT 'federal'::text AS "sourceKind",b.id AS "billId",upper(b.bill_type)||b.bill_number AS "billNumber",'US'::text jurisdiction,
 b.congress::text session,r.version_code version,r.package_id AS "versionId",coalesce(r.metadata_jsonb->>'providerDocumentId',r.metadata_jsonb->>'amendmentId',r.package_id) AS "providerDocumentId",
 r.id::text AS "revisionId",r.extraction_hash AS "revisionHash",r.content_hash AS "documentHash",r.metadata_jsonb->>'rawBytesHash' AS "originalBytesHash",r.source_url AS "sourceUrl",
 (r.published_at AT TIME ZONE 'UTC')::date::text AS "publishedDate",b.title,CASE r.collection WHEN 'AMENDMENTS' THEN 'amendment' ELSE 'text' END AS kind,b.status,b.introduced_date::text AS "introducedDate",
 (${FEDERAL_FY26_SQL}) AS "fy26",r.id AS revision_uuid,
 ARRAY(SELECT a.date::date::text FROM congress_bill_action a WHERE a.bill_id=b.id) AS "actionDates"
 FROM federal_evidence_revision r${keys('federal')} JOIN congress_bill b ON b.id=r.bill_id WHERE r.collection IN ('BILLS','AMENDMENTS','PLAW')
 UNION ALL
 SELECT 'state',b.id,b.bill_number,b.state,b.session_key,r.evidence->>'versionType',r.source_identity,r.evidence->>'providerId',
 r.id::text,r.revision_hash,coalesce(r.evidence->>'contentHash',''),r.evidence->>'contentHash',r.evidence->>'url',CASE WHEN ${validBillCalendarDateSql('r.event_date')} THEN r.event_date END,b.title,
 coalesce(r.evidence->>'documentKind','text'),b.status,
 (SELECT min(p->>'date') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.legiscan_progress)='array' THEN b.legiscan_progress ELSE '[]'::jsonb END) p WHERE p->>'event'='1' AND ${validBillCalendarDateSql("p->>'date'")}),
 (${STATE_FY26_SQL}),r.id,
 ARRAY(SELECT a.event_date FROM state_bill_published_record a WHERE a.bill_key=b.id AND a.kind='action' AND ${validBillCalendarDateSql('a.event_date')}
 UNION SELECT a.date::date::text FROM state_bill_action a WHERE a.bill_key=b.id
 UNION SELECT p->>'date' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.legiscan_progress)='array' THEN b.legiscan_progress ELSE '[]'::jsonb END) p WHERE ${validBillCalendarDateSql("p->>'date'")})
 FROM state_bill_published_record r${keys('state')} JOIN state_bill b ON b.id=r.bill_key WHERE r.kind='document'
), documents AS ${shortlisted ? 'MATERIALIZED ' : ''}(
 SELECT s.*,e.id::text AS "extractionId",e.structure_hash AS "structureHash",e.text_hash AS "textHash",e.parser_version AS "extractionVersion",
 e.extracted_text text,e.structure_jsonb structure,e.completeness,e.warnings_jsonb warnings
 FROM sources s LEFT JOIN LATERAL (
 SELECT e.* FROM bill_text_extraction e WHERE e.source_kind=s."sourceKind" AND e.revision_id=s.revision_uuid
 AND ($1::text IS NULL OR e.id::text=$1) AND ($1::text IS NOT NULL OR e.parser_version=$2)
 ORDER BY CASE e.completeness WHEN 'complete' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,e.created_at DESC,e.id DESC LIMIT 1
 ) e ON true
)`;
}
export const BILL_DOCUMENTS_SQL = billDocumentsSql();

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

export function billTextSearchQuery(
  request: ReturnType<typeof validateBillTextSearch>,
  semantic?: { vector: number[]; model: string },
) {
  const q = billDocumentQuery(request);
  const parameter = (value: unknown) => {
    q.values.push(value);
    return `$${q.values.length}`;
  };
  const limit = parameter(request.limit + (request.mode === 'semantic' ? 1 : 0));
  const offset = parameter((request.page - 1) * request.limit);
  let anchor = '',
    sql: string;
  if (request.mode === 'semantic') {
    if (!semantic) throw Error('BILL_QUERY_VECTOR_REQUIRED');
    const embedding = parameter(`[${semantic.vector.join(',')}]`);
    const model = parameter(semantic.model);
    const chunker = parameter(CHUNKER_VERSION);
    const cap = parameter(BILL_SEMANTIC_CANDIDATE_LIMIT);
    const vectorFilters = [
      `e.metadata_jsonb->>'chunkerVersion'=${chunker}`,
      `e.metadata_jsonb->>'extractionVersion'=${parameter(BILL_EXTRACTION_VERSION)}`,
    ];
    if (request.jurisdictions)
      vectorFilters.push(
        `e.metadata_jsonb->>'jurisdiction'=ANY(${parameter(request.jurisdictions)}::text[])`,
      );
    if (request.billId)
      vectorFilters.push(`e.metadata_jsonb->>'billId'=${parameter(request.billId)}`);
    const proof = billPassageVectorProofSql({
      vector: 'e',
      passage: 'p',
      sourceKind: 'd."sourceKind"',
      billId: 'd."billId"',
      revisionId: 'd."revisionId"',
      extractionId: 'd."extractionId"',
      structureHash: 'd."structureHash"',
      textHash: 'd."textHash"',
      chunker,
      model,
    });
    // Keep canonical joins out of the nearest-vector stage. A correlated EXISTS
    // here can become a document-first nested loop that rescans the RLS vector
    // owner before LIMIT. Public scope/model/cheap metadata filters stay here;
    // every canonical filter and immutable input proof still applies afterward.
    // The planner may use HNSW or a small indexed exact scan without forced GUCs.
    sql = `WITH semantic_candidates AS MATERIALIZED (
        SELECT e.source_id,e.source_type,e.tenant_id,e.client_id,e.owner_user_id,e.model,
          e.metadata_jsonb,e.content_text,e.content_hash,
          e.metadata_jsonb->>'extractionId' AS extraction_id,
          CASE e.source_type WHEN 'bill_passage' THEN 'federal' ELSE 'state' END AS source_kind,
          CASE WHEN e.metadata_jsonb->>'revisionId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
            THEN (e.metadata_jsonb->>'revisionId')::uuid END AS revision_uuid,
          e.embedding <=> ${embedding}::vector AS distance
        FROM context_embeddings e
        WHERE e.tenant_id IS NULL AND e.client_id IS NULL AND e.owner_user_id IS NULL
          AND e.source_type IN ('bill_passage','state_bill_passage') AND e.model=${model}
          AND ${vectorFilters.join(' AND ')}
        ORDER BY e.embedding <=> ${embedding}::vector LIMIT ${cap}
      ), semantic_revision_keys AS MATERIALIZED (
        SELECT DISTINCT source_kind,revision_uuid FROM semantic_candidates WHERE revision_uuid IS NOT NULL
      ), ${billDocumentsSql(true).slice('WITH '.length)}, revision_candidates AS (
        SELECT DISTINCT ON (d."sourceKind",d."revisionId") d.*,e.distance,
          p.start_offset AS "hitOffset"
        FROM semantic_candidates e JOIN documents d ON d.revision_uuid=e.revision_uuid
          AND d."sourceKind"=e.source_kind AND d."extractionId"=e.extraction_id
        JOIN bill_text_passage p ON p.extraction_id=d."extractionId"::uuid AND p.chunker_version=${chunker}
          AND e.source_id=${chunker}||':'||d."extractionId"||':'||p.ordinal::text
        WHERE d.completeness='complete' AND ${q.conditions.join(' AND ') || 'true'} AND ${proof}
        ORDER BY d."sourceKind",d."revisionId",e.distance,e.source_id
      )
      SELECT d.*,(1-d.distance)::float8 score,(SELECT count(*)::int FROM semantic_candidates) AS "candidatePassages"
      FROM revision_candidates d ORDER BY d.distance,d.jurisdiction,d.session,d."billId",d."revisionId"
      LIMIT ${limit} OFFSET ${offset}`;
  } else if (request.mode === 'keyword') {
    const parts = billKeywordParts(request.query!);
    const terms = parameter(parts.terms);
    const phrases = parameter(parts.phrases);
    const safePhraseTerms = parameter(billPhrasePrefilterTerms(parts.phrases));
    const chunker = parameter(CHUNKER_VERSION);
    q.conditions.push(`d.completeness IN ('complete','partial') AND length(d.text)>0`);
    q.conditions.push(`NOT EXISTS(SELECT 1 FROM unnest(${phrases}::text[]) phrase(value)
      WHERE strpos(lower(regexp_replace(d.text,'\\s+',' ','g')),phrase.value)=0)`);
    // Seed GIN hits once per lexeme, then intersect at extraction level so AND terms can
    // occur in distant sections. Literal verification remains over exact full text.
    // No safe lexeme (including all-stopword phrases) deliberately scans extracted text,
    // without an arbitrary corpus cap that could silently discard matches.
    sql = `${q.sql}, keyword_words AS MATERIALIZED (
      SELECT value FROM unnest(tsvector_to_array(to_tsvector('english',${terms}||' '||${safePhraseTerms}))) word(value)
      WHERE ${terms}='' OR cardinality(tsvector_to_array(to_tsvector('english',${terms})))>0
    ), lexeme_hits AS MATERIALIZED (
      SELECT p.extraction_id,word.value,min(p.start_offset) AS hit_offset,
        max(ts_rank_cd(p.search_vector,to_tsquery('simple',quote_literal(word.value)))) AS score
      FROM keyword_words word JOIN bill_text_passage p
        ON p.search_vector @@ to_tsquery('simple',quote_literal(word.value)) AND p.chunker_version=${chunker}
      GROUP BY p.extraction_id,word.value
    ), keyword_candidates AS (
      SELECT extraction_id,min(hit_offset) AS hit_offset,sum(score)::float8 score FROM lexeme_hits
      GROUP BY extraction_id HAVING count(*)=(SELECT count(*) FROM keyword_words)
      UNION ALL
      SELECT e.id,0,0::float8 FROM bill_text_extraction e
      WHERE NOT EXISTS(SELECT 1 FROM keyword_words) AND ${terms}=''
    )
    SELECT d.*,k.score,count(*) OVER()::int total,k.hit_offset AS "hitOffset"
    FROM keyword_candidates k JOIN bill_text_extraction x ON x.id=k.extraction_id
    JOIN documents d ON d.revision_uuid=x.revision_id AND d."sourceKind"=x.source_kind
      AND d."extractionId"::uuid=k.extraction_id
    WHERE ${q.conditions.join(' AND ')}
    ORDER BY score DESC,d.jurisdiction,d.session,d."billId",d."revisionId" LIMIT ${limit} OFFSET ${offset}`;
    anchor = parts.phrases[0] ?? parts.terms.split(/\s+/)[0] ?? '';
  } else {
    sql = `${q.sql} SELECT d.*,0::float8 score,count(*) OVER()::int total FROM documents d
      WHERE ${q.conditions.join(' AND ') || 'true'}
      ORDER BY d.jurisdiction,d.session,d."billId",d."revisionId" LIMIT ${limit} OFFSET ${offset}`;
  }
  return { sql, values: q.values, anchor };
}
