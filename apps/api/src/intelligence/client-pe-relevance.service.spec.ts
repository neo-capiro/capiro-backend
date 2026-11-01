import type { TenantContext } from '@capiro/shared';
import {
  ClientPeRelevanceService,
  normalizeDistrictForComparison,
} from './client-pe-relevance.service.js';
import {
  ECOSYSTEM_SCORE,
  FACILITY_DISTRICT_SCORE,
  PE_DIRECT_SCORE,
  PRIOR_AWARD_BASE_SCORE,
} from './client-pe-relevance.scoring.js';

const ctx: TenantContext = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  tenantSlug: 'capiro',
  userId: '00000000-0000-0000-0000-000000000002',
  clerkUserId: 'user_test',
  role: 'standard_user',
};

const PE = '0604256F';

/** A blank capability/facility/mapping baseline; tests override only the signal under test. */
type ClientFixture = {
  id?: string;
  name?: string;
  uei?: string | null;
  capabilities?: Array<{
    peNumber?: string | null;
    peNumbers?: string[];
    keywords?: string[];
    tags?: unknown;
    name?: string;
  }>;
  facilities?: Array<{ state: string | null; congressionalDistrict: string | null }>;
  mappings?: Array<{ externalName: string }>;
};

/**
 * Build a mock prisma whose tenant tx returns the given client fixture and whose global
 * reads (federal_award, program_element*) are driven by `global`. `$queryRaw` is dispatched
 * by inspecting the SQL text the service emits, so each path can be tested in isolation.
 */
function makePrisma(opts: {
  client?: ClientFixture | null;
  // Per-path raw-query results, keyed by a substring of the SQL.
  keywordRows?: Array<{ term: string; sim: number }>;
  priorAward?: { cnt: number; total: number };
  awardDistricts?: Array<{ state: string; district: string }>;
  ecosystem?: Array<{ performer: string }>;
  // Candidate PE codes the client-side enumeration returns (award + facility unions).
  candidateAwardPes?: Array<{ peCode: string }>;
  candidateFacilityPes?: Array<{ peCode: string }>;
  candidateKeywordPes?: Array<{ peCode: string }>;
  candidateEcosystemPes?: Array<{ peCode: string }>;
  // For getRelevantClientsForPe: candidate client ids in the tenant for a PE.
  candidateClientIds?: Array<{ clientId: string }>;
  // For getRelevantTenantClientsForPe: system candidate (tenant, client) pairs.
  systemCandidates?: Array<{ tenantId: string; clientId: string }>;
  // PE corpus for the keyword path.
  pe?: { title: string; description: string | null } | null;
  projects?: Array<{ title: string; mission: string | null }>;
  sources?: Array<{ snippet: string | null }>;
  peTitles?: Array<{ peCode: string; title: string | null }>;
}) {
  const client =
    opts.client === null
      ? null
      : {
          id: opts.client?.id ?? 'client-1',
          name: opts.client?.name ?? 'Acme Defense',
          uei: opts.client?.uei ?? null,
        };
  const capabilities = (opts.client?.capabilities ?? []).map((c) => ({
    peNumber: c.peNumber ?? null,
    peNumbers: c.peNumbers ?? [],
    keywords: c.keywords ?? [],
    tags: c.tags ?? [],
    name: c.name ?? '',
  }));
  const facilities = opts.client?.facilities ?? [];
  const mappings = opts.client?.mappings ?? [];

  // Global $queryRaw dispatcher (this.prisma.$queryRaw) — inspect the SQL fragments.
  const globalQueryRaw = jest.fn(async (sql: { strings?: string[]; sql?: string }) => {
    const text = sqlText(sql);
    if (text.includes('keyword_candidate_matches')) return opts.candidateKeywordPes ?? [];
    if (text.includes('ecosystem_candidates')) return opts.candidateEcosystemPes ?? [];
    if (text.includes('similarity(') && text.includes('unnest(') && text.includes('t(term)')) {
      return opts.keywordRows ?? [];
    }
    if (text.includes('COALESCE(SUM(amount)')) {
      const a = opts.priorAward ?? { cnt: 0, total: 0 };
      return [{ cnt: a.cnt, total: a.total }];
    }
    if (text.includes('program_element_performer') && text.includes('ecosystem')) {
      return opts.ecosystem ?? [];
    }
    // Candidate-facility PE enumeration (JOIN unnest over the client's districts) — must be
    // matched BEFORE the per-PE award-district read, which also references pop_state.
    if (text.includes('JOIN unnest(') && text.includes('pop_state')) {
      return opts.candidateFacilityPes ?? [];
    }
    // Candidate-award PE enumeration: award rows by UEI/name, bounded by LIMIT.
    if (text.includes('recipient_uei') && text.includes('LIMIT')) {
      return opts.candidateAwardPes ?? [];
    }
    // Per-PE award-district read for the facility path: DISTINCT pop_state AS "state".
    if (text.includes('pop_state AS "state"')) {
      return opts.awardDistricts ?? [];
    }
    return [];
  });

  const tx = {
    $executeRaw: jest.fn(async () => 1),
    programElement: { findMany: jest.fn(async () => opts.peTitles ?? []) },
    client: { findUnique: jest.fn(async () => client) },
    clientCapability: { findMany: jest.fn(async () => capabilities) },
    clientFacility: { findMany: jest.fn(async () => facilities) },
    clientIntelMapping: { findMany: jest.fn(async () => mappings) },
    $queryRaw: jest.fn(async (sql: { strings?: string[]; sql?: string }) => {
      const text = sqlText(sql);
      // candidate client ids for a PE (tenant tx) — has client_capabilities + UNION.
      if (text.includes('client_capabilities') && text.includes('UNION')) {
        return opts.candidateClientIds ?? [];
      }
      return globalQueryRaw(sql);
    }),
  };

  return {
    $queryRaw: globalQueryRaw,
    programElement: {
      findUnique: jest.fn(async () => opts.pe ?? null),
      findMany: jest.fn(async () => opts.peTitles ?? []),
    },
    programElementProject: { findMany: jest.fn(async () => opts.projects ?? []) },
    programElementSource: { findMany: jest.fn(async () => opts.sources ?? []) },
    withTenant: jest.fn(async (_tenantId: string, fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
    withSystem: jest.fn(async (fn: (t: { $queryRaw: jest.Mock }) => Promise<unknown>) =>
      fn({
        $queryRaw: jest.fn(async () => opts.systemCandidates ?? []),
      }),
    ),
    __tx: tx,
  };
}

/** Reconstruct the SQL text from a Prisma.sql tagged-template object for inspection. */
function sqlText(sql: { strings?: string[]; sql?: string; values?: unknown[] }): string {
  if (typeof sql === 'string') return sql;
  if (Array.isArray(sql?.strings)) return sql.strings.join(' ');
  if (typeof sql?.sql === 'string') return sql.sql;
  return JSON.stringify(sql ?? '');
}

describe('all-path bounded PE discovery', () => {
  test('discovers a keyword-only PE without direct, award or facility candidates', async () => {
    const prisma = makePrisma({
      client: { capabilities: [{ keywords: ['hypersonics'] }] },
      candidateKeywordPes: [{ peCode: PE }],
      pe: { title: 'Hypersonics', description: null },
      keywordRows: [{ term: 'hypersonics', sim: 0.72 }],
    });
    const result = await new ClientPeRelevanceService(prisma as never).getRelevantPesForClient(ctx, 'client-1');
    expect(result.data).toEqual([expect.objectContaining({ peCode: PE, score: 0.72,
      paths: [expect.objectContaining({ path: 'capability_keyword' })] })]);
    expect(result.candidateCoverage).toMatchObject({ complete: true, evaluated: 1, omittedPaths: [] });
  });

  test('discovers performer-only PE through a confirmed external identity', async () => {
    const prisma = makePrisma({ client: { mappings: [{ externalName: 'Synthetic Aerospace' }] },
      candidateEcosystemPes: [{ peCode: PE }], ecosystem: [{ performer: 'Synthetic Aerospace' }] });
    const result = await new ClientPeRelevanceService(prisma as never).getRelevantPesForClient(ctx, 'client-1');
    expect(result.data).toEqual([expect.objectContaining({ peCode: PE, score: ECOSYSTEM_SCORE })]);
    expect(prisma.__tx.clientIntelMapping.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { clientId: 'client-1', confirmed: true },
    }));
  });

  test('reports a capacity hit instead of a complete total, including empty filtered results', async () => {
    const prisma = makePrisma({ candidateEcosystemPes: Array.from({ length: 401 }, (_, i) => ({
      peCode: String(i).padStart(7, '0') + 'F',
    })) });
    const result = await new ClientPeRelevanceService(prisma as never).getRelevantPesForClient(ctx, 'client-1');
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.candidateCoverage).toEqual({ complete: false, evaluated: 400, limit: 400,
      discoveredAtLeast: 401, truncatedPaths: ['ecosystem'], omittedPaths: [], totalScope: 'evaluated_candidates' });
  });

  test('candidate query failure propagates and cannot become a complete empty success', async () => {
    const prisma = makePrisma({});
    prisma.__tx.$queryRaw.mockRejectedValueOnce(new Error('candidate deadline'));
    await expect(new ClientPeRelevanceService(prisma as never).getRelevantPesForClient(ctx, 'client-1'))
      .rejects.toThrow('candidate deadline');
  });
});

describe('normalizeDistrictForComparison', () => {
  test('strips leading zeros so BARE and zero-padded codes compare equal', () => {
    expect(normalizeDistrictForComparison('05')).toBe('5');
    expect(normalizeDistrictForComparison('5')).toBe('5');
    expect(normalizeDistrictForComparison('52')).toBe('52');
  });

  test('all-zero codes normalize to "" (the at-large district)', () => {
    expect(normalizeDistrictForComparison('00')).toBe('');
    expect(normalizeDistrictForComparison('0')).toBe('');
  });

  test('USAspending "90"/"98" sentinels keep their zeros and never collapse', () => {
    expect(normalizeDistrictForComparison('90')).toBe('90');
    expect(normalizeDistrictForComparison('98')).toBe('98');
  });
});

describe('facility discovery/scorer normalization parity', () => {
  test.each([
    ['reviewer witness', 'TX', '5', ' TX ', ' 05 ', true],
    ['both sides padded', ' tx ', ' 005 ', 'TX', '05', true],
    ['tabs and line breaks', '\tTX\n', '\r5\t', '\n tx\r', '\t005\n', true],
    ['nonbreaking spaces', '\u00a0TX\u00a0', '5', '\u00a0tx\u00a0', '\u00a0005\u00a0', true],
    ['BOM and Unicode space', 'TX', '5', '\ufeffTX\u2003', '\u3000005\ufeff', true],
    ['at-large zero', 'WY', '0', ' WY ', ' 00 ', true],
    ['at-large padded', ' wy ', ' 00 ', '\tWY\n', '\n000\t', true],
    ['different state', 'TX', '5', ' CA ', ' 05 ', false],
    ['different district', 'TX', '5', ' TX ', ' 06 ', false],
    ['internal whitespace remains', 'TX', '5', 'T X', '05', false],
    ['internal district whitespace remains', 'TX', '5', 'TX', '0 5', false],
    ['sentinel is not at-large', 'WY', '00', ' WY ', ' 98 ', false],
  ])('%s', async (_label, facilityState, facilityDistrict, awardState, awardDistrict, expected) => {
    const code = '0600001F';
    const award = { state: awardState as string, district: awardDistrict as string };
    const tx: any = {
      $executeRaw: jest.fn(async () => 1),
      client: { findUnique: async () => ({ id: 'client', name: 'Unrelated Client', uei: null }) },
      clientCapability: { findMany: async () => [] },
      clientFacility: { findMany: async () => [{ state: facilityState, congressionalDistrict: facilityDistrict }] },
      clientIntelMapping: { findMany: async () => [] },
      programElement: { findMany: async () => [{ peCode: code, title: 'Synthetic' }] },
    };
    // Adapted from the independent review's actual pair+discovery witness. This
    // models only the emitted equality/upper/BTRIM/LTRIM predicates, not PostgreSQL.
    // It also runs against the old no-trim predicate as a negative control.
    const btrim = (value: string, characters: string) => {
      let start = 0, end = value.length;
      while (start < end && characters.includes(value[start]!)) start++;
      while (end > start && characters.includes(value[end - 1]!)) end--;
      return value.slice(start, end);
    };
    const raw = async (sql: any) => {
      if (sql.sql.includes('JOIN unnest(')) {
        const states = sql.values[0] as string[];
        const districts = sql.values[1] as string[];
        const trims = sql.sql.includes('BTRIM(fa.pop_state,');
        if (trims) {
          expect(sql.sql).toContain("LTRIM(BTRIM(fa.pop_congressional_district,");
          expect(sql.values[2]).toBe(sql.values[3]);
        } else {
          expect(sql.sql).toContain('upper(fa.pop_state) = d.state');
          expect(sql.sql).toContain("LTRIM(fa.pop_congressional_district, '0') = LTRIM(d.district, '0')");
        }
        const state = (trims ? btrim(award.state, sql.values[2]) : award.state).toUpperCase();
        const district = (trims ? btrim(award.district, sql.values[3]) : award.district).replace(/^0+/, '');
        return states.some((s, index) => s === state && districts[index]!.replace(/^0+/, '') === district)
          ? [{ peCode: code }] : [];
      }
      if (sql.sql.includes('pop_state AS "state"')) return [award];
      return [];
    };
    tx.$queryRaw = raw;
    const service = new ClientPeRelevanceService({
      withTenant: async (_t: any, fn: any) => fn(tx), $queryRaw: raw,
    } as any);
    const paired = await service.computeForClientPe(tx, 'client', code);
    expect(paired.score).toBe(expected ? FACILITY_DISTRICT_SCORE : 0);
    const discovered = await service.getRelevantPesForClient(ctx, 'client');
    expect(discovered.candidateCoverage).toMatchObject({ complete: true, evaluated: expected ? 1 : 0 });
    expect(discovered.data.map((row) => row.peCode)).toEqual(expected ? [code] : []);
    if (expected) expect(discovered.data[0]?.paths).toEqual(paired.paths);
  });
});

describe('ClientPeRelevanceService', () => {
  describe('computeForClientPe — per-path isolation', () => {
    test('capability_pe_direct only → full score, evidence lists the PE', async () => {
      const prisma = makePrisma({
        client: { capabilities: [{ peNumbers: [PE] }] },
        pe: { title: 'Some PE', description: null },
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const result = await service.computeForClientPe(prisma.__tx as never, 'client-1', PE);

      expect(result.paths).toHaveLength(1);
      expect(result.paths[0]!.path).toBe('capability_pe_direct');
      expect(result.score).toBe(PE_DIRECT_SCORE);
      expect(result.paths[0]!.evidence.join(' ')).toContain(PE);
    });

    test('legacy peNumber also satisfies the direct path', async () => {
      const prisma = makePrisma({
        client: { capabilities: [{ peNumber: PE.toLowerCase() }] },
        pe: { title: 'Some PE', description: null },
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const result = await service.computeForClientPe(prisma.__tx as never, 'client-1', PE);
      expect(result.paths[0]!.path).toBe('capability_pe_direct');
      expect(result.score).toBe(1.0);
    });

    test('capability_keyword only → similarity score, keywords in evidence', async () => {
      const prisma = makePrisma({
        client: { capabilities: [{ keywords: ['hypersonics'] }] },
        pe: { title: 'Hypersonic Glide Body', description: 'hypersonics work' },
        keywordRows: [{ term: 'hypersonics', sim: 0.72 }],
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const result = await service.computeForClientPe(prisma.__tx as never, 'client-1', PE);

      expect(result.paths).toHaveLength(1);
      expect(result.paths[0]!.path).toBe('capability_keyword');
      expect(result.paths[0]!.score).toBe(0.72);
      expect(result.score).toBe(0.72);
      expect(result.paths[0]!.evidence.join(' ')).toContain('hypersonics');
    });

    test('capability_keyword: no rows at/above floor → path absent', async () => {
      const prisma = makePrisma({
        client: { capabilities: [{ keywords: ['hypersonics'] }] },
        pe: { title: 'Unrelated', description: null },
        keywordRows: [],
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const result = await service.computeForClientPe(prisma.__tx as never, 'client-1', PE);
      expect(result.score).toBe(0);
      expect(result.paths).toHaveLength(0);
    });

    test('prior_award only → base score, evidence describes the award', async () => {
      const prisma = makePrisma({
        client: { uei: 'ABC123DEF456' },
        pe: { title: 'Some PE', description: null },
        priorAward: { cnt: 1, total: 250_000 },
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const result = await service.computeForClientPe(prisma.__tx as never, 'client-1', PE);

      expect(result.paths).toHaveLength(1);
      expect(result.paths[0]!.path).toBe('prior_award');
      expect(result.score).toBe(PRIOR_AWARD_BASE_SCORE);
      expect(result.paths[0]!.evidence[0]).toContain('1 prior award');
    });

    test('facility_district only → fixed score, "ST-NN" evidence (bare number stored)', async () => {
      const prisma = makePrisma({
        // facility stores BARE district "12", state "TX" separately.
        client: { facilities: [{ state: 'TX', congressionalDistrict: '12' }] },
        pe: { title: 'Some PE', description: null },
        awardDistricts: [{ state: 'TX', district: '12' }],
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const result = await service.computeForClientPe(prisma.__tx as never, 'client-1', PE);

      expect(result.paths).toHaveLength(1);
      expect(result.paths[0]!.path).toBe('facility_district');
      expect(result.score).toBe(FACILITY_DISTRICT_SCORE);
      expect(result.paths[0]!.evidence.join(' ')).toContain('TX-12');
    });

    test('facility_district: BARE facility district matches the zero-padded award code', async () => {
      const prisma = makePrisma({
        // facility stores the BARE "5" (app convention); USAspending awards keep "05".
        client: { facilities: [{ state: 'CA', congressionalDistrict: '5' }] },
        pe: { title: 'Some PE', description: null },
        awardDistricts: [{ state: 'CA', district: '05' }],
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const result = await service.computeForClientPe(prisma.__tx as never, 'client-1', PE);

      expect(result.paths).toHaveLength(1);
      expect(result.paths[0]!.path).toBe('facility_district');
      expect(result.score).toBe(FACILITY_DISTRICT_SCORE);
    });

    test('facility_district: at-large "00" matches an at-large award district', async () => {
      const prisma = makePrisma({
        client: { facilities: [{ state: 'WY', congressionalDistrict: '00' }] },
        pe: { title: 'Some PE', description: null },
        awardDistricts: [{ state: 'WY', district: '00' }],
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const result = await service.computeForClientPe(prisma.__tx as never, 'client-1', PE);
      expect(result.paths[0]!.path).toBe('facility_district');
      expect(result.score).toBe(FACILITY_DISTRICT_SCORE);
      // The at-large key stays in the documented "ST-NN" evidence shape.
      expect(result.paths[0]!.evidence.join(' ')).toContain('WY-00');
    });

    test('facility_district: no district overlap → path absent', async () => {
      const prisma = makePrisma({
        client: { facilities: [{ state: 'TX', congressionalDistrict: '12' }] },
        pe: { title: 'Some PE', description: null },
        awardDistricts: [{ state: 'CA', district: '23' }],
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const result = await service.computeForClientPe(prisma.__tx as never, 'client-1', PE);
      expect(result.score).toBe(0);
    });

    test('ecosystem only → fixed score, performer in evidence', async () => {
      const prisma = makePrisma({
        client: { name: 'Acme Aerospace' },
        pe: { title: 'Some PE', description: null },
        ecosystem: [{ performer: 'Acme Aerospace' }],
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const result = await service.computeForClientPe(prisma.__tx as never, 'client-1', PE);

      expect(result.paths).toHaveLength(1);
      expect(result.paths[0]!.path).toBe('ecosystem');
      expect(result.score).toBe(ECOSYSTEM_SCORE);
      expect(result.paths[0]!.evidence.join(' ')).toContain('Acme Aerospace');
    });
  });

  describe('computeForClientPe — multi-path & no-signal', () => {
    test('two strong paths → combined score uses the diversity bonus', async () => {
      const prisma = makePrisma({
        client: {
          uei: 'ABC123DEF456',
          facilities: [{ state: 'TX', congressionalDistrict: '12' }],
        },
        pe: { title: 'Some PE', description: null },
        priorAward: { cnt: 1, total: 100_000 }, // 0.8
        awardDistricts: [{ state: 'TX', district: '12' }], // 0.6
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const result = await service.computeForClientPe(prisma.__tx as never, 'client-1', PE);

      // base 0.8 + one diversity step 0.05 (two distinct strong paths).
      expect(result.score).toBe(0.85);
      expect(result.paths.map((p) => p.path).sort()).toEqual(
        ['facility_district', 'prior_award'].sort(),
      );
    });

    test('no-signal client → score 0, no paths', async () => {
      const prisma = makePrisma({
        client: {}, // no capabilities/facilities/mappings/uei
        pe: { title: 'Some PE', description: null },
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const result = await service.computeForClientPe(prisma.__tx as never, 'client-1', PE);
      expect(result).toEqual({ score: 0, paths: [] });
    });

    test('missing client → score 0, no paths', async () => {
      const prisma = makePrisma({ client: null });
      const service = new ClientPeRelevanceService(prisma as never);
      const result = await service.computeForClientPe(prisma.__tx as never, 'missing', PE);
      expect(result).toEqual({ score: 0, paths: [] });
    });
  });

  describe('getRelevantPesForClient', () => {
    test('filters out PEs below minScore and paginates the survivors', async () => {
      // Candidate PEs: PE (direct, 1.0) plus PE_FACILITY (facility-only, 0.6).
      const PE_FACILITY = '0207141F';
      const prisma = makePrisma({
        client: {
          capabilities: [{ peNumbers: [PE] }],
          facilities: [{ state: 'TX', congressionalDistrict: '12' }],
        },
        candidateFacilityPes: [{ peCode: PE_FACILITY }],
        // global award-district read returns the TX-12 match for whichever PE is scored.
        awardDistricts: [{ state: 'TX', district: '12' }],
        peTitles: [
          { peCode: PE, title: 'Direct PE' },
          { peCode: PE_FACILITY, title: 'Facility PE' },
        ],
      });
      const service = new ClientPeRelevanceService(prisma as never);

      // minScore 0.7 keeps the direct PE (1.0) but drops the facility-only PE (0.6).
      const page1 = await service.getRelevantPesForClient(ctx, 'client-1', {
        minScore: 0.7,
        page: 1,
        limit: 1,
      });

      expect(page1.total).toBe(1);
      expect(page1.data).toHaveLength(1);
      expect(page1.data[0]!.peCode).toBe(PE);
      expect(page1.data[0]!.title).toBe('Direct PE');
      expect(page1.data[0]!.score).toBe(1);
    });

    test('default minScore 0.5 keeps both, limit paginates', async () => {
      const PE_FACILITY = '0207141F';
      const prisma = makePrisma({
        client: {
          capabilities: [{ peNumbers: [PE] }],
          facilities: [{ state: 'TX', congressionalDistrict: '12' }],
        },
        candidateFacilityPes: [{ peCode: PE_FACILITY }],
        awardDistricts: [{ state: 'TX', district: '12' }],
        peTitles: [
          { peCode: PE, title: 'Direct PE' },
          { peCode: PE_FACILITY, title: 'Facility PE' },
        ],
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const page1 = await service.getRelevantPesForClient(ctx, 'client-1', { limit: 1, page: 1 });
      expect(page1.total).toBe(2);
      expect(page1.data).toHaveLength(1);
      // Sorted desc by score → the direct PE (1.0) comes first.
      expect(page1.data[0]!.peCode).toBe(PE);

      const page2 = await service.getRelevantPesForClient(ctx, 'client-1', { limit: 1, page: 2 });
      expect(page2.data).toHaveLength(1);
      expect(page2.data[0]!.peCode).toBe(PE_FACILITY);
    });

    test('missing client → empty result set', async () => {
      const prisma = makePrisma({ client: null });
      const service = new ClientPeRelevanceService(prisma as never);
      const out = await service.getRelevantPesForClient(ctx, 'missing');
      expect(out).toEqual({ data: [], total: 0, page: 1, limit: 50, candidateCoverage: null });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('getRelevantClientsForPe', () => {
    test('scores tenant candidates and filters below minScore', async () => {
      const prisma = makePrisma({
        client: { id: 'client-1', name: 'Acme Defense', capabilities: [{ peNumbers: [PE] }] },
        candidateClientIds: [{ clientId: 'client-1' }],
        pe: { title: 'Some PE', description: null },
        peTitles: [{ peCode: PE, title: 'Some PE' }],
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const out = await service.getRelevantClientsForPe(ctx, PE, { minScore: 0.5 });
      expect(out).toHaveLength(1);
      expect(out[0]!.clientId).toBe('client-1');
      expect(out[0]!.score).toBe(1);
      expect(out[0]!.paths[0]!.path).toBe('capability_pe_direct');
    });

    test('no tenant candidates → empty array', async () => {
      const prisma = makePrisma({ candidateClientIds: [] });
      const service = new ClientPeRelevanceService(prisma as never);
      const out = await service.getRelevantClientsForPe(ctx, PE);
      expect(out).toEqual([]);
    });

    test('getRelevantClientsForPeByTenantId: same scoring via a bare tenantId (no full ctx)', async () => {
      const prisma = makePrisma({
        client: { id: 'client-1', name: 'Acme Defense', capabilities: [{ peNumbers: [PE] }] },
        candidateClientIds: [{ clientId: 'client-1' }],
        pe: { title: 'Some PE', description: null },
        peTitles: [{ peCode: PE, title: 'Some PE' }],
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const out = await service.getRelevantClientsForPeByTenantId(ctx.tenantId, PE, {
        minScore: 0.5,
      });
      expect(out).toHaveLength(1);
      expect(out[0]!.clientId).toBe('client-1');
      expect(out[0]!.score).toBe(1);
      expect(out[0]!.paths[0]!.path).toBe('capability_pe_direct');
      // It scopes by the bare tenantId (no TenantContext required).
      expect(prisma.withTenant.mock.calls[0]![0]).toBe(ctx.tenantId);
    });

    test('clientId-ownership guard: a wrong-tenant candidate (RLS clients read returns null) is skipped', async () => {
      // client_capabilities/client_facilities lack RLS, so the candidate enumeration can
      // surface a clientId that does not belong to this tenant. The RLS-protected `clients`
      // read (mocked here as null, as Postgres RLS would do for a wrong-tenant id) must cause
      // that candidate to be skipped → empty result, no cross-tenant read.
      const prisma = makePrisma({
        client: null,
        candidateClientIds: [{ clientId: 'wrong-tenant-client' }],
        pe: { title: 'Some PE', description: null },
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const out = await service.getRelevantClientsForPe(ctx, PE, { minScore: 0.5 });
      expect(out).toEqual([]);
    });
  });

  describe('getRelevantTenantClientsForPe (system cross-tenant)', () => {
    test('scores each system candidate under its tenant and filters by minScore', async () => {
      const prisma = makePrisma({
        client: { id: 'client-1', name: 'Acme Defense', capabilities: [{ peNumbers: [PE] }] },
        systemCandidates: [{ tenantId: ctx.tenantId, clientId: 'client-1' }],
        pe: { title: 'Some PE', description: null },
      });
      const service = new ClientPeRelevanceService(prisma as never);

      const out = await service.getRelevantTenantClientsForPe(PE, { minScore: 0.5 });
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({ tenantId: ctx.tenantId, clientId: 'client-1', score: 1 });
      // Uses the system (RLS-bypass) read to enumerate, then a tenant tx to score.
      expect(prisma.withSystem).toHaveBeenCalled();
      expect(prisma.withTenant).toHaveBeenCalledWith(ctx.tenantId, expect.any(Function));
    });

    test('no system candidates → empty array, no per-tenant scoring', async () => {
      const prisma = makePrisma({ systemCandidates: [] });
      const service = new ClientPeRelevanceService(prisma as never);

      const out = await service.getRelevantTenantClientsForPe(PE);
      expect(out).toEqual([]);
      expect(prisma.withTenant).not.toHaveBeenCalled();
    });
  });
});
