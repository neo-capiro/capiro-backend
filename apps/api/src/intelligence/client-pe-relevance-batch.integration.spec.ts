import { performance } from 'node:perf_hooks';
import { Prisma, PrismaClient } from '@prisma/client';
import { scorePeCandidateBatch } from './client-pe-relevance-batch.js';
import { createPeRelevanceBudget, enumeratePeCandidates, type PeCandidateSignals, type PeQuery } from './client-pe-candidates.js';
import { ClientPeRelevanceService, KEYWORD_SIMILARITY_FLOOR as KEYWORD, NAME_SIMILARITY_FLOOR as NAME } from './client-pe-relevance.service.js';
import type { PathResult } from './client-pe-relevance.scoring.js';

// Never fall back to DATABASE_URL or allow a shared database to be truncated.
const fixtureUrl = 'postgresql://portfolio_qa@127.0.0.1:55492/portfolio_relevance_test?schema=public';
const databaseUrl = process.env.PORTFOLIO_RELEVANCE_TEST_DATABASE_URL;
if (databaseUrl && databaseUrl !== fixtureUrl) throw new Error('Refusing non-fixture PE integration database');
const describeDatabase = databaseUrl ? describe : describe.skip;
type PairScorer = { scoreClientPe(signals: PeCandidateSignals, code: string, query: PeQuery): Promise<{ score: number; paths: PathResult[] }> };
const signals = (): PeCandidateSignals => ({
  uei: 'SYNTHETIC-UEI', name: 'Synthetic Client', keywordTerms: ['hypersonics'],
  capabilityPeCodes: new Set(['0600001F']), facilityDistricts: [{ state: 'TX', district: '5' }],
  intelNames: ['Confirmed Alias'],
});

// Public-fact SQL/budget integration, not full-schema, HTTP or RLS acceptance.
describeDatabase('PE batch scoring against isolated PostgreSQL', () => {
  let db: PrismaClient;
  let oracle: PairScorer;
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    oracle = new ClientPeRelevanceService(db as never) as unknown as PairScorer;
    for (const ddl of [
      'CREATE EXTENSION IF NOT EXISTS pg_trgm',
      'CREATE TABLE IF NOT EXISTS program_element (pe_code text PRIMARY KEY, title text, description text)',
      'CREATE TABLE IF NOT EXISTS program_element_project (id text, pe_code text, title text, mission text)',
      'CREATE TABLE IF NOT EXISTS program_element_source (id text, pe_code text, snippet text)',
      'CREATE TABLE IF NOT EXISTS program_element_performer (pe_code text, performer text, is_named_company boolean)',
      'CREATE TABLE IF NOT EXISTS federal_award (id text PRIMARY KEY, pe_code text, recipient_uei text, contractor_name text, amount numeric, pop_state text, pop_congressional_district text)',
    ]) await db.$executeRawUnsafe(ddl);
  }, 30_000);
  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE program_element, program_element_project, program_element_source, program_element_performer, federal_award`;
  });
  afterAll(async () => { await db?.$disconnect(); });

  async function seedPes(codes: string[], keywordCodes: Set<string>) {
    for (const code of codes) await db.$executeRaw`INSERT INTO program_element (pe_code, title, description)
      VALUES (${code}, ${keywordCodes.has(code) ? 'hypersonics' : 'Unrelated'}, NULL)`;
  }

  test('five paths match the unchanged scorer without leaking between PEs', async () => {
    const codes = Array.from({ length: 6 }, (_, index) => `060000${index + 1}F`);
    await seedPes(codes, new Set([codes[1]!]));
    await db.$executeRaw`INSERT INTO federal_award
      (id, pe_code, recipient_uei, contractor_name, amount, pop_state, pop_congressional_district) VALUES
      ('award-uei', ${codes[2]}, 'SYNTHETIC-UEI', NULL, 250000, NULL, NULL),
      ('award-facility', ${codes[3]}, NULL, NULL, 100000, ' TX ', ' 005 ')`;
    await db.$executeRaw`INSERT INTO program_element_performer VALUES
      (${codes[4]}, 'Confirmed Alias', true), (${codes[4]}, 'Confirmed Alias', true),
      (${codes[4]}, 'Confirmed Alias Noise', false)`;
    const input = signals();
    const budget = createPeRelevanceBudget();
    await db.$transaction(async (tx) => {
      const { query } = budget.bind(tx);
      const batch = await scorePeCandidateBatch(query, input, codes, KEYWORD, NAME);
      expect(batch.map((row) => row.paths.map((path) => path.path))).toEqual([
        ['capability_pe_direct'], ['capability_keyword'], ['prior_award'],
        ['facility_district'], ['ecosystem'], [],
      ]);
      for (let index = 0; index < codes.length; index++) {
        expect(batch[index]).toEqual({ peCode: codes[index], ...await oracle.scoreClientPe(input, codes[index]!, query) });
      }
      expect(batch[4]!.paths[0]!.evidence).toEqual(['Ecosystem performer(s): Confirmed Alias']);
    }, { timeout: 15_000 });
  }, 30_000);

  test('200 real candidates retain results with eight fact reads instead of 804', async () => {
    const codes = Array.from({ length: 200 }, (_, index) => `${String(600000 + index).padStart(7, '0')}F`);
    await seedPes(codes, new Set(codes));
    const input = { ...signals(), capabilityPeCodes: new Set(codes) };
    let batchReads = 0;
    const started = performance.now();
    const budget = createPeRelevanceBudget();
    const batch = await db.$transaction(async (tx) => {
      const bound = budget.bind(tx);
      const query: PeQuery = <T>(sql: Prisma.Sql) => { batchReads++; return bound.query<T>(sql); };
      const candidates = await enumeratePeCandidates(query, input, KEYWORD, NAME);
      expect(candidates.candidateCoverage).toMatchObject({ complete: true, evaluated: 200, discoveredAtLeast: 200 });
      expect(candidates.codes).toEqual(codes);
      return scorePeCandidateBatch(query, input, candidates.codes, KEYWORD, NAME);
    }, { timeout: 15_000 });
    const batchMs = performance.now() - started;
    expect(batch).toHaveLength(200);
    expect(batchReads).toBe(8);
    expect(batchMs).toBeLessThan(15_000);

    // Negative control: existing per-PE reader outside the batch's 15s budget.
    let oldReads = 0;
    const oldQuery: PeQuery = <T>(sql: Prisma.Sql) => { oldReads++; return db.$queryRaw<T>(sql); };
    const oldStarted = performance.now();
    const oldCandidates = await enumeratePeCandidates(oldQuery, input, KEYWORD, NAME);
    const oldRows = [];
    for (const peCode of oldCandidates.codes) oldRows.push({ peCode, ...await oracle.scoreClientPe(input, peCode, oldQuery) });
    expect(oldReads).toBe(804);
    expect(batch).toEqual(oldRows);
    console.info('Native PE comparison', { candidates: codes.length, batchReads, oldReads, batchMs, oldMs: performance.now() - oldStarted });
  }, 60_000);

  test('a real PostgreSQL error rejects the batch instead of becoming empty success', async () => {
    const budget = createPeRelevanceBudget();
    await expect(db.$transaction(async (tx) => {
      const bound = budget.bind(tx);
      const failingQuery: PeQuery = <T>(_sql: Prisma.Sql) => bound.query<T>(Prisma.sql`SELECT * FROM portfolio_relevance_missing_table`);
      return scorePeCandidateBatch(failingQuery, signals(), ['0600001F'], KEYWORD, NAME);
    }, { timeout: 15_000 })).rejects.toMatchObject({ code: 'P2010', meta: { code: '42P01' } });
  });

  test('empty candidates perform no fact reads', async () => {
    let reads = 0;
    const query: PeQuery = async <T>(_sql: Prisma.Sql) => { reads++; throw new Error('Unexpected fact read'); };
    expect(await scorePeCandidateBatch(query, signals(), [], KEYWORD, NAME)).toEqual([]);
    expect(reads).toBe(0);
  });
});
