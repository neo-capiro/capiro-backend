import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { normalizeOpportunitySearchCriteria } from '@capiro/shared';
import type { PrismaTransactionOptions } from '../prisma/prisma-transaction-deadline.js';
import { searchSourceSql } from './funding-opportunity-v2-search.sql.js';

// The same explicitly owned synthetic cluster as the Portfolio SQL regressions.
// Never use generic DATABASE_URL, and refuse a wrong target before connecting.
const fixtureUrl = 'postgresql://portfolio_qa@127.0.0.1:55492/portfolio_relevance_test?schema=public';
const databaseUrl = process.env.PORTFOLIO_RELEVANCE_TEST_DATABASE_URL;
if (databaseUrl && databaseUrl !== fixtureUrl) throw new Error('Refusing non-fixture catalog projection database');
const describeDatabase = databaseUrl ? describe : describe.skip;
const firstId = '10000000-0000-4000-8000-000000000001';
const laterId = '10000000-0000-4000-8000-000000000002';
const criteria = () => normalizeOpportunitySearchCriteria({
  mode: 'all', sources: ['sam_gov'], lifecycle: [], sort: 'title', direction: 'asc', page: 1, pageSize: 1,
}).criteria;

describeDatabase('catalog SQL defers unused source projections until page retrieval', () => {
  let db: PrismaClient;
  const adapter = {
    withSystem<T>(read: (tx: { $queryRaw: <R>(query: Prisma.Sql) => Promise<R> }) => Promise<T>, options?: PrismaTransactionOptions): Promise<T> {
      return db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL search_path = portfolio_catalog_projection, public`;
        return read(tx);
      }, { timeout: options?.timeoutMs ?? 20_000 });
    },
  };
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await db.$executeRaw`CREATE SCHEMA IF NOT EXISTS portfolio_catalog_projection`;
    await db.$executeRaw`CREATE TABLE IF NOT EXISTS portfolio_catalog_projection.sam_source (
      id uuid PRIMARY KEY, notice_id text, title text, agency text, source_url text, notice_type text,
      base_type text, response_deadline timestamptz, archive_date timestamptz, posted_date timestamptz,
      active boolean DEFAULT true, description text, naics_code text, psc_code text, set_aside_code text,
      set_aside text, place_of_performance_jsonb jsonb DEFAULT '{}', solicitation_number text,
      last_synced_at timestamptz DEFAULT now(), poc_name text, poc_email text, raw_payload jsonb DEFAULT '{}'
    )`;
    // Immutable, test-only instrumentation: source facts outside the requested
    // page must not be hydrated merely to count matching rows. This is not a
    // malformed-data fallback; requesting that row must still propagate error.
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION portfolio_catalog_projection.page_payload(payload jsonb, notice text)
      RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
        IF notice = 'later-page' THEN RAISE EXCEPTION 'UNSELECTED_PROJECTION_WAS_EVALUATED'; END IF;
        RETURN payload;
      END $$`);
    await db.$executeRaw`CREATE OR REPLACE VIEW portfolio_catalog_projection.sam_opportunity AS
      SELECT s.*, portfolio_catalog_projection.page_payload(s.raw_payload, s.notice_id) AS raw_jsonb
      FROM portfolio_catalog_projection.sam_source s`;
    await db.$executeRaw`TRUNCATE portfolio_catalog_projection.sam_source`;
    await db.$executeRaw`INSERT INTO portfolio_catalog_projection.sam_source
      (id, notice_id, title, agency, notice_type, response_deadline, description, raw_payload, naics_code) VALUES
      (${firstId}::uuid, 'first-page', 'A synthetic first notice', 'Synthetic Department', 'Solicitation',
       '2099-12-31'::timestamptz, 'Synthetic first description', '{"lastModifiedDate":"2026-11-01T00:00:00Z"}'::jsonb, '336411'),
      (${laterId}::uuid, 'later-page', 'Z synthetic later notice', 'Synthetic Department', 'Solicitation',
       '2099-12-31'::timestamptz, 'Synthetic later description', '{"lastModifiedDate":"2026-11-02T00:00:00Z"}'::jsonb, '336411')`;
  }, 30_000);
  afterAll(async () => {
    if (db) {
      await db.$executeRaw`TRUNCATE portfolio_catalog_projection.sam_source`;
      await db.$disconnect();
    }
  });

  test('counts all matching notices without hydrating off-page source facts', async () => {
    const result = await searchSourceSql(adapter, 'sam_gov', criteria(), null);
    expect(result).toMatchObject({ count: 2, contractsCount: 2, activeCount: 2, grantsCount: 0 });
    expect(result.records.map((record) => record.sourceRecordId)).toEqual([firstId]);
    expect(result.records[0]?.sourceFacts).toMatchObject({ noticeId: 'first-page' });
  });
  test('an exact requested record still propagates a real source-projection error', async () => {
    await expect(searchSourceSql(adapter, 'sam_gov', criteria(), null, laterId))
      .rejects.toThrow('UNSELECTED_PROJECTION_WAS_EVALUATED');
  });
  test('matched scores and complete counts remain intact without off-page source facts', async () => {
    const result = await searchSourceSql(adapter, 'sam_gov', { ...criteria(), mode: 'matched', clientId: firstId }, {
      clientId: firstId, naicsCodes: ['336411'], pscCodes: [], agencies: [], sectors: [], applicantTypes: [],
    });
    expect(result).toMatchObject({ count: 2, activeCount: 2, actualUnscoredCount: 0 });
    expect(result.records.map((record) => [record.sourceRecordId, record.relevanceScore])).toEqual([[firstId, 85]]);
  });
  test('exact identity retrieval does not hydrate unrelated records', async () => {
    const result = await searchSourceSql(adapter, 'sam_gov', criteria(), null, firstId);
    expect(result.count).toBe(1);
    expect(result.records.map((record) => record.sourceRecordId)).toEqual([firstId]);
  });
});
