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
      `CREATE TABLE federal_grant ( id text PRIMARY KEY, title text NOT NULL, agency text NOT NULL, sub_agency text, opportunity_number text, category text, funding_instrument text, award_ceiling double precision, award_floor double precision, estimated_funding double precision, open_date date, close_date date, status text, url text, embedded_at timestamptz(6))`,
      `CREATE TABLE sam_opportunity ( id uuid PRIMARY KEY, notice_id text NOT NULL UNIQUE, solicitation_number text, title text NOT NULL, notice_type varchar(32) NOT NULL, agency text, sub_agency text, office text, set_aside text, psc_code varchar(8), naics_code varchar(8), posted_date timestamptz(6), response_deadline timestamptz(6), source_url text, active boolean NOT NULL DEFAULT true, embedded_at timestamptz(6))`,
      `GRANT SELECT ON congress_bill, federal_grant, sam_opportunity TO "${qualification.appRole}"`,
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
