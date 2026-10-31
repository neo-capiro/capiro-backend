import { performance } from 'node:perf_hooks';
import { Prisma } from '@prisma/client';
import {
  boundPeCandidates,
  enumeratePeCandidates,
  peKeywordMatchesSql,
  withPeCandidateDeadline,
  type PeCandidateSignals,
} from './client-pe-candidates.js';

jest.mock('node:perf_hooks', () => ({ performance: { now: jest.fn(() => 0) } }));

const empty = () => ({
  capability_pe_direct: [],
  capability_keyword: [],
  prior_award: [],
  facility_district: [],
  ecosystem: [],
});
const signals = (): PeCandidateSignals => ({
  uei: 'synthetic-uei',
  name: 'Synthetic Client',
  keywordTerms: ['hypersonics'],
  capabilityPeCodes: new Set(['0600001F']),
  facilityDistricts: [{ state: 'TX', district: '5' }],
  intelNames: ['Confirmed Alias'],
});

test('deduplicates and orders the union independently of source and row order', () => {
  const a = boundPeCandidates({
    ...empty(),
    prior_award: [{ peCode: '0600003F' }, { peCode: '0600001f' }],
    ecosystem: [{ peCode: '0600002F' }, { peCode: '0600003F' }],
  });
  const b = boundPeCandidates({
    ...empty(),
    prior_award: [{ peCode: '0600002F' }, { peCode: '0600003F' }],
    ecosystem: [{ peCode: '0600001F' }],
  });
  expect(a).toEqual(b);
  expect(a.codes).toEqual(['0600001F', '0600002F', '0600003F']);
  expect(a.candidateCoverage).toMatchObject({ complete: true, evaluated: 3, discoveredAtLeast: 3 });
});

test.each([400, 401])('distinguishes exact capacity from an overflow probe (%s)', (count) => {
  const rows = Array.from({ length: count }, (_, n) => ({
    peCode: String(n).padStart(7, '0') + 'F',
  }));
  const result = boundPeCandidates({ ...empty(), capability_keyword: rows });
  expect(result.codes).toHaveLength(400);
  expect(result.candidateCoverage.complete).toBe(count === 400);
  expect(result.candidateCoverage.discoveredAtLeast).toBe(count);
  expect(result.candidateCoverage.truncatedPaths).toEqual(
    count === 400 ? [] : ['capability_keyword'],
  );
});

test('union overflow is incomplete even when each individual source is within capacity', () => {
  const rows = Array.from({ length: 401 }, (_, n) => ({
    peCode: String(n).padStart(7, '0') + 'F',
  }));
  const result = boundPeCandidates({
    ...empty(),
    prior_award: rows.slice(0, 200),
    ecosystem: rows.slice(200),
  });
  expect(result.candidateCoverage).toMatchObject({
    complete: false,
    evaluated: 400,
    discoveredAtLeast: 401,
    truncatedPaths: [],
    omittedPaths: [],
    totalScope: 'evaluated_candidates',
  });
});

test('enumerates every required public path with limit+1 and existing match semantics', async () => {
  const queries: Prisma.Sql[] = [];
  const result = await enumeratePeCandidates(
    async <T>(sql: Prisma.Sql) => {
      queries.push(sql);
      return [] as T;
    },
    signals(),
    0.5,
    0.3,
  );
  expect(result.codes).toEqual(['0600001F']);
  expect(queries).toHaveLength(4);
  for (const sql of queries) {
    expect(sql.sql).toContain('ORDER BY "peCode" LIMIT');
    expect(sql.values.at(-1)).toBe(401);
    expect(sql.sql).toContain('COLLATE "C"');
  }
  const keyword = queries.find((q) => q.sql.includes('keyword_candidate_matches'))!;
  const scorer = peKeywordMatchesSql(['hypersonics'], 0.5, '0600001F');
  for (const sql of [keyword, scorer]) {
    expect(sql.sql).toContain('program_element_project');
    expect(sql.sql).toContain('p.title');
    expect(sql.sql).toContain('p.mission');
    expect(sql.sql).toContain('program_element_source');
    expect(sql.sql).toContain('ORDER BY id LIMIT 50');
    expect(sql.sql).toContain('similarity(pe.corpus, t.term) >=');
    expect(sql.values).toContain(0.5);
    expect(sql.values).toContainEqual(['hypersonics']);
  }
  expect(scorer.sql).toContain('WHERE pe.pe_code =');
  expect(keyword.sql).not.toContain('WHERE pe.pe_code =');
  const ecosystem = queries.find((q) => q.sql.includes('ecosystem_candidates'))!;
  expect(ecosystem.sql).toContain('is_named_company = true');
  expect(ecosystem.sql).toContain('contractor_name IS NOT NULL');
  expect(ecosystem.sql).toContain('similarity(e.name, c.name) >');
  expect(ecosystem.values).toContainEqual(['Synthetic Client', 'Confirmed Alias']);
  expect(ecosystem.values).toContain('synthetic-uei');
  expect(ecosystem.values).toContain(0.3);
});

test('absent signals produce no keyword/facility/ecosystem scan and no omitted path', async () => {
  const query = jest.fn(async () => []);
  const result = await enumeratePeCandidates(
    query as never,
    { ...signals(), name: '', keywordTerms: [], facilityDistricts: [], intelNames: [] },
    0.5,
    0.3,
  );
  expect(query).toHaveBeenCalledTimes(1); // existing prior-award UEI path still applies
  expect(result.candidateCoverage).toMatchObject({ complete: true, omittedPaths: [] });
});

describe('candidate SQL deadline', () => {
  beforeEach(() => jest.mocked(performance.now).mockReset().mockReturnValue(0));
  test('sets a positive LOCAL server timeout and awaits the original query failure', async () => {
    let rolledBack = false;
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      $queryRaw: jest.fn(async () => {
        throw Error('SQL failed');
      }),
    };
    const prisma = {
      $transaction: jest.fn(async (work: any) => {
        try {
          return await work(tx);
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      }),
    };
    await expect(
      withPeCandidateDeadline(prisma as never, (query) => query(Prisma.sql`SELECT 1`)),
    ).rejects.toThrow('SQL failed');
    expect(rolledBack).toBe(true);
    expect(tx.$executeRaw).toHaveBeenCalledWith(expect.any(Array), '15000ms');
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 1000,
      timeout: 16000,
    });
  });
  test('an exhausted shared budget never submits another query or a zero timeout', async () => {
    jest.mocked(performance.now).mockReturnValueOnce(0).mockReturnValue(15001);
    const tx = { $executeRaw: jest.fn(), $queryRaw: jest.fn() };
    const prisma = { $transaction: async (work: any) => work(tx) };
    await expect(
      withPeCandidateDeadline(prisma as never, (query) => query(Prisma.sql`SELECT 1`)),
    ).rejects.toThrow('PE candidate query budget exceeded');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
