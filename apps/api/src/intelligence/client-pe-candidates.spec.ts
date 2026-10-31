import { performance } from 'node:perf_hooks';
import { Prisma } from '@prisma/client';
import {
  boundPeCandidates,
  enumeratePeCandidates,
  peKeywordMatchesSql,
  createPeRelevanceBudget,
  type PeCandidateSignals,
} from './client-pe-candidates.js';
import { ClientPeRelevanceService } from './client-pe-relevance.service.js';

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

describe('whole relevance request deadline', () => {
  beforeEach(() => jest.mocked(performance.now).mockReset().mockReturnValue(0));
  test('sets a positive LOCAL server timeout and awaits the original query failure', async () => {
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      $queryRaw: jest.fn(async () => {
        throw Error('SQL failed');
      }),
    };
    const { query } = createPeRelevanceBudget().bind(tx as never);
    await expect(
      Promise.all([query(Prisma.sql`SELECT 1`), query(Prisma.sql`SELECT 2`)]),
    ).rejects.toThrow('SQL failed');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledWith(expect.any(Array), '15000ms');
  });
  test('an exhausted shared budget never submits another query or a zero timeout', async () => {
    jest.mocked(performance.now).mockReturnValueOnce(0).mockReturnValue(15001);
    const tx = { $executeRaw: jest.fn(), $queryRaw: jest.fn() };
    const { query } = createPeRelevanceBudget().bind(tx as never);
    await expect(query(Prisma.sql`SELECT 1`)).rejects.toThrow('PE relevance query budget exceeded');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  function requestFixture(options: { waitMs?: number; titleMs?: number } = {}) {
    let elapsed = 0;
    jest.mocked(performance.now).mockImplementation(() => elapsed);
    const timeouts: number[] = [];
    const seen: string[] = [];
    const tx: any = {
      $executeRaw: jest.fn(async (_strings: any, ms: string) => {
        timeouts.push(parseInt(ms));
        return 1;
      }),
      client: {
        findUnique: jest.fn(async () => {
          elapsed += 2000;
          return { id: 'client', name: 'Synthetic', uei: null };
        }),
      },
      clientCapability: {
        findMany: async () => [
          {
            peNumbers: ['0600001F'],
            peNumber: null,
            name: 'hypersonics',
            keywords: ['hypersonics'],
            tags: [],
          },
        ],
      },
      clientFacility: { findMany: async () => [{ state: 'TX', congressionalDistrict: '5' }] },
      clientIntelMapping: { findMany: async () => [] },
      programElement: {
        findMany: jest.fn(async () => {
          seen.push('title');
          elapsed += options.titleMs ?? 1000;
          return [{ peCode: '0600001F', title: 'Synthetic' }];
        }),
      },
      $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
        elapsed += 1000;
        seen.push(sql.sql);
        return [];
      }),
    };
    let rolledBack = false;
    const prisma: any = {
      withTenant: jest.fn(async (_t: string, work: any) => {
        elapsed += options.waitMs ?? 0;
        try {
          return await work(tx);
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      }),
      $queryRaw: jest.fn(() => {
        throw Error('Unbudgeted public query');
      }),
      programElement: {
        findMany: jest.fn(() => {
          throw Error('Unbudgeted title read');
        }),
      },
    };
    const run = () =>
      new ClientPeRelevanceService(prisma).getRelevantPesForClient(
        { tenantId: 'tenant' } as any,
        'client',
      );
    return { run, timeouts, seen, prisma, tx, rolledBack: () => rolledBack };
  }

  test('actual service uses diminishing budget for signals, four discovery queries, every scorer and titles', async () => {
    const h = requestFixture();
    const result = await h.run();
    expect(result.data).toHaveLength(1); // direct path still scores1 without public evidence
    expect(h.timeouts).toEqual([
      15000, 13000, 13000, 13000, 13000, 12000, 11000, 10000, 9000, 8000, 7000, 6000, 5000,
    ]);
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(8);
    expect(h.seen.at(-1)).toBe('title');
    expect(h.prisma.withTenant).toHaveBeenCalledWith('tenant', expect.any(Function), {
      timeoutMs: 15000,
    });
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  test('title lookup cannot reset the budget or release a late successful response', async () => {
    const h = requestFixture({ titleMs: 5001 });
    await expect(h.run()).rejects.toThrow('PE relevance query budget exceeded');
    expect(h.rolledBack()).toBe(true);
    expect(h.timeouts.at(-1)).toBe(5000);
  });

  test('connection wait consumes the request budget before any signal query', async () => {
    const h = requestFixture({ waitMs: 15001 });
    await expect(h.run()).rejects.toThrow('PE relevance query budget exceeded');
    expect(h.tx.client.findUnique).not.toHaveBeenCalled();
    expect(h.tx.$queryRaw).not.toHaveBeenCalled();
    expect(h.tx.$executeRaw).not.toHaveBeenCalled();
  });
});
