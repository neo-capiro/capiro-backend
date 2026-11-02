import { Prisma, PrismaClient } from '@prisma/client';
import {
  createQualificationDatabase,
  qualificationAdminUrl,
  type QualificationDatabase,
} from '../../test/memory-postgres-qualification/harness.js';
import { vectorLiteral } from '../embeddings/embedder.js';
import {
  parseSemanticSearchInput,
  semanticCoverageSql,
  semanticSearchSql,
  SEMANTIC_SEARCH_LIMITS,
  type SemanticCoverageRow,
  type SemanticSearchOperation,
  type SemanticSearchRow,
} from './semantic-search.js';

/**
 * The three semantic statements executed by the real Prisma client against
 * PostgreSQL 16 with pgvector, as the application role. The unit specs mock the
 * database and so could not see that Prisma binds a JavaScript integer as
 * bigint: `left(text, bigint)` has no signature (42883) and every semantic read
 * answered 500 on 2 November 2026. Same disposable-database contract as the
 * memory qualification harness; a run without MEMORY_POSTGRES_REQUIRE_VECTOR=1
 * skips, since nothing here is meaningful without the vector operator.
 */
const adminUrl = qualificationAdminUrl();
const run = adminUrl && process.env.MEMORY_POSTGRES_REQUIRE_VECTOR === '1' ? describe : describe.skip;
const MODEL = 'qualification-current-1024';
const TENANT = '10000000-0000-4000-8000-000000000001';
const SAM_A = '60000000-0000-4000-8000-000000000001';
const SAM_B = '60000000-0000-4000-8000-000000000002';
const SAM_INACTIVE = '60000000-0000-4000-8000-000000000003';
const ATT_GRANT = '70000000-0000-4000-8000-000000000001';
const ATT_NOTICE_LOCAL = '70000000-0000-4000-8000-000000000002';
const ATT_NOTICE_EMPTY = '70000000-0000-4000-8000-000000000003';
const ATT_MISSING = '70000000-0000-4000-8000-000000000009';

function axis(index: number, second?: number): string {
  const vector = Array<number>(1024).fill(0);
  vector[index] = second === undefined ? 1 : Math.SQRT1_2;
  if (second !== undefined) vector[second] = Math.SQRT1_2;
  return vectorLiteral(vector);
}

run('semantic search statements on PostgreSQL with pgvector', () => {
  jest.setTimeout(120_000);
  let qualification: QualificationDatabase | undefined;
  let app: PrismaClient | undefined;
  const longText = 'water infrastructure resilience '.repeat(40); // 1,280 characters, above the 400-character snippet

  beforeAll(async () => {
    qualification = await createQualificationDatabase(adminUrl!, true);
    const admin = qualification.admin;
    // Column names and types of the canonical records the projections read, from schema.prisma.
    const ddl = [
      `CREATE TABLE congress_bill ( id text PRIMARY KEY, congress integer NOT NULL, bill_type text NOT NULL, bill_number text NOT NULL, title text NOT NULL, introduced_date date, sponsor_name text, sponsor_state text, sponsor_party text, latest_action_text text, latest_action_date date, policy_area text, subjects text[] NOT NULL DEFAULT '{}', status text, url text)`,
      `CREATE TABLE federal_grant ( id text PRIMARY KEY, title text NOT NULL, agency text NOT NULL, sub_agency text, opportunity_number text, category text, funding_instrument text, award_ceiling double precision, award_floor double precision, estimated_funding double precision, open_date date, close_date date, response_date_desc text, status text, url text, embedded_at timestamptz(6))`,
      `CREATE TABLE sam_opportunity ( id uuid PRIMARY KEY, notice_id text NOT NULL UNIQUE, solicitation_number text, title text NOT NULL, notice_type varchar(32) NOT NULL, agency text, sub_agency text, office text, set_aside text, psc_code varchar(8), naics_code varchar(8), posted_date timestamptz(6), response_deadline timestamptz(6), source_url text, active boolean NOT NULL DEFAULT true, embedded_at timestamptz(6))`,
      `CREATE TABLE opportunity_attachment ( id uuid PRIMARY KEY, sam_opportunity_id uuid, federal_grant_id text, source_url text NOT NULL, file_name text, content_sha256 text, provider_data jsonb, embedded_at timestamptz(6))`,
      `CREATE TABLE opportunity_document_text ( id uuid PRIMARY KEY DEFAULT gen_random_uuid(), attachment_id uuid NOT NULL, attachment_content_sha256 text NOT NULL, status text NOT NULL, extraction_method text, char_count integer, truncated boolean NOT NULL DEFAULT false)`,
      `GRANT SELECT ON congress_bill, federal_grant, sam_opportunity, opportunity_attachment, opportunity_document_text TO "${qualification.appRole}"`,
      `INSERT INTO tenants (id) VALUES ('${TENANT}')`,
    ];
    for (const statement of ddl) await admin.$executeRawUnsafe(statement);
    await admin.$executeRaw`INSERT INTO congress_bill (id, congress, bill_type, bill_number, title, status, latest_action_date, sponsor_name)
      VALUES ('119-hr-1', 119, 'hr', '1', 'Water Infrastructure Act', 'introduced', '2026-02-01', 'Rep. River'),
             ('119-s-2', 119, 's', '2', 'Rural Broadband Act', 'passed_house', '2026-03-01', 'Sen. Fiber'),
             ('118-hr-3', 118, 'hr', '3', 'Old Water Act', 'introduced', '2024-01-01', 'Rep. Past')`;
    await admin.$executeRaw`INSERT INTO federal_grant (id, title, agency, opportunity_number, close_date, status, embedded_at)
      VALUES ('G-1', 'Clean Water Grants', 'Environmental Protection Agency', 'EPA-W-1', '2027-01-15', 'posted', now()),
             ('G-2', 'Broadband Grants', 'Department of Commerce', 'DOC-B-2', '2026-12-01', 'posted', now()),
             ('G-3', 'Unindexed Grant', 'Department of Energy', 'DOE-3', '2026-12-01', 'posted', NULL)`;
    await admin.$executeRaw`INSERT INTO sam_opportunity (id, notice_id, solicitation_number, title, notice_type, agency, naics_code, response_deadline, active, embedded_at)
      VALUES (${SAM_A}::uuid, 'N-1', 'SOL-1', 'Water Treatment Services', 'Solicitation', 'Department of the Navy', '336411', '2026-12-31T17:00:00Z', true, now()),
             (${SAM_B}::uuid, 'N-2', 'SOL-2', 'Network Cabling', 'Solicitation', 'Department of the Army', '238210', '2026-11-30T17:00:00Z', true, now()),
             (${SAM_INACTIVE}::uuid, 'N-3', 'SOL-3', 'Expired Water Notice', 'Solicitation', 'Department of the Navy', '336411', '2026-01-01T17:00:00Z', false, now())`;
    // Attachments: provider text on a grant, truncated local text bound to the archived bytes on a notice, and a
    // notice attachment without text; a chunk whose attachment row is gone and one with a malformed parent are never ranked.
    await admin.$executeRaw`INSERT INTO opportunity_attachment (id, federal_grant_id, sam_opportunity_id, source_url, file_name, content_sha256, provider_data, embedded_at)
      VALUES (${ATT_GRANT}::uuid, 'G-2', NULL, 'https://example.test/g2.pdf', 'G2 NOFO.pdf', 'sha-g2', '{"extracted_text":"Eligible applicants include rural counties."}'::jsonb, now()),
             (${ATT_NOTICE_LOCAL}::uuid, NULL, ${SAM_B}::uuid, 'https://example.test/n2.pdf', 'N2 SOW.pdf', 'sha-n2', '{}'::jsonb, NULL),
             (${ATT_NOTICE_EMPTY}::uuid, NULL, ${SAM_A}::uuid, 'https://example.test/n1.pdf', 'N1 scan.pdf', 'sha-n1', '{}'::jsonb, NULL)`;
    await admin.$executeRaw`INSERT INTO opportunity_document_text (attachment_id, attachment_content_sha256, status, extraction_method, char_count, truncated)
      VALUES (${ATT_NOTICE_LOCAL}::uuid, 'sha-n2', 'available', 'local_parser', 5000, true),
             (${ATT_NOTICE_EMPTY}::uuid, 'sha-old', 'available', 'local_parser', 900, false)`;
    const attachmentMeta = (parentId: string, method: string) =>
      JSON.stringify({ parentId, sourceTable: 'opportunity_attachment', sourceUrl: 'https://example.test/file.pdf', documentHash: `doc-${parentId.slice(-1)}`, chunkIndex: 1, start: 5600, end: 11600, offsetBasis: 'plain_text_normalized_utf16', extractionMethod: method, ...(method === 'local_parser' ? { truncated: true } : {}) });
    const rows: Array<[string | null, string, string, string, string, string]> = [
      // [tenant, source_type, source_id, metadata, vector, text]
      [null, 'bill', '119-hr-1', '{}', axis(0), longText],
      [null, 'bill', '119-s-2', '{}', axis(1), 'broadband'],
      [null, 'bill', '118-hr-3', '{}', axis(0, 1), 'old water'],
      [TENANT, 'bill', '119-hr-1', '{}', axis(0), 'tenant-scoped copy, never public'],
      [null, 'funding_grant_chunk', 'G-1:0', '{"parentId":"G-1"}', axis(0, 1), 'grant chunk one'],
      [null, 'funding_grant_chunk', 'G-1:1', '{"parentId":"G-1"}', axis(0), 'grant chunk two, the closest'],
      [null, 'funding_grant_chunk', 'G-2:0', '{"parentId":"G-2"}', axis(1), 'broadband grant'],
      [null, 'funding_notice_chunk', `${SAM_A}:0`, `{"parentId":"${SAM_A}"}`, axis(0), 'water notice'],
      [null, 'funding_notice_chunk', `${SAM_B}:0`, `{"parentId":"${SAM_B}"}`, axis(1), 'cabling notice'],
      [null, 'funding_notice_chunk', `${SAM_INACTIVE}:0`, `{"parentId":"${SAM_INACTIVE}"}`, axis(0), 'expired water notice'],
      [null, 'funding_attachment_chunk', `${ATT_GRANT}:1`, attachmentMeta(ATT_GRANT, 'provider'), axis(3), 'rural counties eligibility passage'],
      [null, 'funding_attachment_chunk', `${ATT_NOTICE_LOCAL}:1`, attachmentMeta(ATT_NOTICE_LOCAL, 'local_parser'), axis(4), 'statement of work passage'],
      [null, 'funding_attachment_chunk', `${ATT_MISSING}:0`, attachmentMeta(ATT_MISSING, 'provider'), axis(3), 'attachment row gone, never ranked'],
      [null, 'funding_attachment_chunk', 'not-a-uuid:0', attachmentMeta('not-a-uuid', 'provider'), axis(4), 'malformed parent, never ranked'],
      [null, 'bill', '119-hr-1', '{}', axis(2), 'other model, never ranked'],
    ];
    for (const [index, [tenant, sourceType, sourceId, metadata, vector, text]] of rows.entries()) {
      const model = index === rows.length - 1 ? 'qualification-old-1024' : MODEL;
      await admin.$executeRaw`INSERT INTO context_embeddings (tenant_id, source_type, source_id, model, content_text, content_hash, embedding, metadata_jsonb)
        VALUES (${tenant}::uuid, ${sourceType}, ${sourceId}, ${model}, ${text}, ${`hash-${index}`}, ${vector}::vector, ${metadata}::jsonb)`;
    }
    app = new PrismaClient({ datasources: { db: { url: qualification.appUrl } } });
    await app.$connect();
  });

  afterAll(async () => {
    await app?.$disconnect();
    await qualification?.dispose();
  });

  async function read(operation: SemanticSearchOperation, body: Record<string, unknown>, vector = axis(0)) {
    const input = parseSemanticSearchInput(operation, body);
    return app!.$queryRaw<SemanticSearchRow[]>(semanticSearchSql(operation, input, vector, MODEL));
  }

  it('executes the bill statement with Prisma-bound parameters and truncates the snippet to the limit', async () => {
    const rows = await read('semantic_search_bills', { query: 'water' });
    expect(rows.map((row) => row.parent_id)).toEqual(['119-hr-1', '118-hr-3']);
    expect(rows[0]!.snippet).toHaveLength(SEMANTIC_SEARCH_LIMITS.snippetChars);
    expect(rows[0]!.score).toBeCloseTo(1, 5);
    expect(rows[1]!.score).toBeCloseTo(Math.SQRT1_2, 5);
    expect(rows[0]!.record).toMatchObject({ id: '119-hr-1', congress: 119, billType: 'hr', billNumber: '1', status: 'introduced', sponsorName: 'Rep. River' });
  });

  it('binds every bill filter with its natural type and caps the page', async () => {
    expect((await read('semantic_search_bills', { query: 'water', congress: 118 })).map((row) => row.parent_id)).toEqual(['118-hr-3']);
    expect((await read('semantic_search_bills', { query: 'water', status: 'introduced', dateFrom: '2026-01-01' })).map((row) => row.parent_id)).toEqual(['119-hr-1']);
    expect((await read('semantic_search_bills', { query: 'water', dateTo: '2025-12-31' })).map((row) => row.parent_id)).toEqual(['118-hr-3']);
    expect((await read('semantic_search_bills', { query: 'water', limit: 1 })).map((row) => row.parent_id)).toEqual(['119-hr-1']);
  });

  it('keeps the best chunk per grant and applies agency, status and close-date filters', async () => {
    // The orthogonal broadband chunk scores 0, under the 0.35 floor: only the water grant's best chunk returns.
    const rows = await read('semantic_search_grants', { query: 'water' });
    expect(rows.map((row) => [row.parent_id, row.snippet])).toEqual([['G-1', 'grant chunk two, the closest']]);
    expect(rows[0]!.record).toMatchObject({ id: 'G-1', opportunityNumber: 'EPA-W-1', agency: 'Environmental Protection Agency' });
    expect((await read('semantic_search_grants', { query: 'broadband', agency: 'commerce' }, axis(1))).map((row) => row.parent_id)).toEqual(['G-2']);
    expect(await read('semantic_search_grants', { query: 'broadband', agency: 'no such agency' }, axis(1))).toHaveLength(0);
    expect(await read('semantic_search_grants', { query: 'water', status: 'closed' })).toHaveLength(0);
    expect((await read('semantic_search_grants', { query: 'water', dateFrom: '2027-01-01' })).map((row) => row.parent_id)).toEqual(['G-1']);
  });

  it('joins notices through the uuid parent, excludes inactive notices by default and filters naics and deadline', async () => {
    expect((await read('semantic_search_contract_opportunities', { query: 'water' })).map((row) => row.parent_id)).toEqual([SAM_A]);
    const withInactive = await read('semantic_search_contract_opportunities', { query: 'water', includeInactive: true });
    expect(withInactive.map((row) => row.parent_id)).toEqual([SAM_A, SAM_INACTIVE]);
    expect((await read('semantic_search_contract_opportunities', { query: 'cabling' }, axis(1))).map((row) => row.parent_id)).toEqual([SAM_B]);
    expect((await read('semantic_search_contract_opportunities', { query: 'water', naics: '3364' })).map((row) => row.parent_id)).toEqual([SAM_A]);
    expect(await read('semantic_search_contract_opportunities', { query: 'water', agency: 'navy', dateTo: '2026-12-30' })).toHaveLength(0);
    expect(withInactive[0]!.record).toMatchObject({ id: SAM_A, noticeId: 'N-1', solicitationNumber: 'SOL-1', naicsCode: '336411', active: true });
  });

  it('ranks attachment passages with descriptions, joins each to its own opportunity and reports attachment text coverage', async () => {
    const grants = await read('semantic_search_grants', { query: 'rural eligibility' }, axis(3));
    expect(grants.map((row) => row.parent_id)).toEqual(['G-2']);
    expect(grants[0]!.passage).toMatchObject({ sourceTable: 'opportunity_attachment', fileName: 'G2 NOFO.pdf', chunkIndex: 1, start: 5600, end: 11600, extractionMethod: 'provider' });
    expect(grants[0]!.documents).toEqual({ attachments: 1, withText: 1, truncated: 0, indexed: 1 });
    expect(grants[0]!.record).toMatchObject({ id: 'G-2', status: 'posted', responseDateDesc: null, openForApplications: Date.now() < Date.parse('2026-12-02T00:00:00Z') });
    // A notice attachment never surfaces as a grant, and a passage whose attachment row is gone or malformed is dropped.
    expect(await read('semantic_search_grants', { query: 'statement of work' }, axis(4))).toHaveLength(0);
    const notices = await read('semantic_search_contract_opportunities', { query: 'statement of work' }, axis(4));
    expect(notices.map((row) => row.parent_id)).toEqual([SAM_B]);
    expect(notices[0]!.passage).toMatchObject({ sourceTable: 'opportunity_attachment', fileName: 'N2 SOW.pdf', extractionMethod: 'local_parser', truncated: true });
    // Local text counts only while bound to the archived bytes: the scan's stale-hash text is not searchable text.
    expect(notices[0]!.documents).toEqual({ attachments: 1, withText: 1, truncated: 1, indexed: 0 });
    const water = await read('semantic_search_contract_opportunities', { query: 'water' });
    expect(water[0]!.passage).toMatchObject({ sourceTable: null, fileName: null });
    expect(water[0]!.documents).toEqual({ attachments: 1, withText: 0, truncated: 0, indexed: 0 });
    expect(water[0]!.record).toMatchObject({ id: SAM_A, active: true, currentNotice: Date.now() <= Date.parse('2026-12-31T17:00:00Z') });
    const inactive = await read('semantic_search_contract_opportunities', { query: 'water', includeInactive: true });
    expect(inactive.find((row) => row.parent_id === SAM_INACTIVE)!.record).toMatchObject({ active: false, currentNotice: false });
  });

  it('ranks only public rows of the stored model: tenant copies and other models never reach the page', async () => {
    // The tenant-scoped bill row shares the parent, so it would surface as a duplicate score if ranked.
    const rows = await read('semantic_search_bills', { query: 'water' }, axis(2));
    expect(rows.map((row) => row.parent_id)).not.toContain('119-hr-1');
  });

  it('reads coverage as exact integer counts per family', async () => {
    const coverage = async (operation: SemanticSearchOperation) =>
      (await app!.$queryRaw<SemanticCoverageRow[]>(semanticCoverageSql(operation, MODEL)))[0];
    expect(await coverage('semantic_search_bills')).toEqual({ indexed: 3, total: 3 });
    expect(await coverage('semantic_search_grants')).toEqual({ indexed: 2, total: 3 });
    expect(await coverage('semantic_search_contract_opportunities')).toEqual({ indexed: 3, total: 3 });
  });

  it('is the statement the service sends: a bigint-typed snippet length is what failed live', async () => {
    // Prisma types a bound integer as bigint; the statement must not hand one to left().
    await expect(app!.$queryRaw`SELECT left('abc'::text, ${400}) AS snippet`).rejects.toMatchObject({ code: 'P2010' });
    const input = parseSemanticSearchInput('semantic_search_bills', { query: 'water' });
    const sql = semanticSearchSql('semantic_search_bills', input, axis(0), MODEL);
    expect(sql.sql).toContain(`left(best.content_text, ${SEMANTIC_SEARCH_LIMITS.snippetChars})`);
    expect(sql.values).not.toContain(SEMANTIC_SEARCH_LIMITS.snippetChars);
    expect(Prisma.sql`${1}`.values).toEqual([1]);
  });
});
