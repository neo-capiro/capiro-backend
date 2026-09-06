/**
 * Regression coverage for a real production incident: `loadMembers` referenced
 * a non-existent `congress_member.state_code` column (the real column is
 * `state`) and coerced the INTEGER `district` column against an empty string
 * literal — both fatal at the Postgres parse/analyze stage, so the whole
 * priority-intelligence endpoint 500'd for every client and district, not
 * just the one that surfaced it in a live canary. No spec existed for this
 * service before this incident — these tests exist so a future regression to
 * the same query (or a new unguarded rail) is caught before it reaches a
 * real drawer again.
 *
 * The SQL correctness fix, the state-code-to-full-name conversion, and the
 * member-rail failure isolation tests below also exist, unchanged, in the
 * separate migration-free hotfix (already merged) — this file is the
 * superset, additionally covering GSA baseline/observation_kind semantics
 * (Phase 3), which depend on the migration this branch adds.
 */
import { describe, expect, jest, test } from '@jest/globals';
import { DistrictNexusPriorityIntelligenceService } from './priority-intelligence.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { DistrictNexusService } from '../district-nexus.service.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';

function sqlTextOf(strings: TemplateStringsArray): string {
  return Array.isArray(strings) ? strings.join('?') : String(strings);
}

/**
 * A Prisma stand-in whose `withTenant`/`withSystem` run against a fake `tx`
 * that resolves every raw query to `[]` and every model call to a benign
 * empty/found-nothing default, EXCEPT the congress_member lookup, which is
 * controllable per test (so we can prove both the fixed SQL shape and the
 * graceful-degradation path when it fails).
 */
function makePrisma(opts: {
  congressMemberBehavior: 'empty' | 'throw' | ((sql: string) => Array<{ bioguide_id: string }>);
}) {
  const capturedCongressMemberSql: string[] = [];
  const capturedCongressMemberValues: unknown[][] = [];
  const queryRaw = jest.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const sql = sqlTextOf(strings);
    if (sql.includes('congress_member')) {
      capturedCongressMemberSql.push(sql);
      capturedCongressMemberValues.push(_values);
      if (opts.congressMemberBehavior === 'throw') {
        throw new Error('column cm.state_code does not exist');
      }
      if (opts.congressMemberBehavior === 'empty') return [];
      return opts.congressMemberBehavior(sql);
    }
    return [];
  });
  // Every model/raw-query call this service can make, whether reached
  // directly on the injected PrismaService or through a withTenant/withSystem
  // transaction callback — both paths are exercised by this one service, so
  // both must resolve to the same benign defaults.
  const shared = {
    client: {
      findFirst: jest.fn<() => Promise<{ id: string; name: string; status: string }>>(async () => ({
        id: CLIENT,
        name: 'L3 Harris',
        status: 'active',
      })),
    },
    communityFundingIngestRun: {
      findMany: jest.fn<() => Promise<unknown[]>>(async () => []),
    },
    communityFundingRequest: {
      findMany: jest.fn<() => Promise<unknown[]>>(async () => []),
    },
    communityFundingRequestSource: {
      findMany: jest.fn<() => Promise<unknown[]>>(async () => []),
    },
    gsaRealPropertySourceRun: {
      findMany: jest.fn<() => Promise<unknown[]>>(async () => []),
    },
    gsaRealProperty: {
      findMany: jest.fn<() => Promise<unknown[]>>(async () => []),
    },
    districtEconomicFact: {
      findMany: jest.fn<() => Promise<unknown[]>>(async () => []),
    },
    districtNexusChange: {
      findMany: jest.fn<(args?: { where?: Record<string, unknown> }) => Promise<unknown[]>>(
        async () => [],
      ),
    },
    $queryRaw: queryRaw,
  };
  const withTenant = jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(shared));
  const withSystem = jest.fn((fn: (tx: unknown) => unknown) => fn(shared));
  return {
    prisma: { ...shared, withTenant, withSystem } as unknown as PrismaService,
    capturedCongressMemberSql,
    capturedCongressMemberValues,
  };
}

function makeNexusStub(): DistrictNexusService {
  return {
    getClientDistrictNexus: jest.fn<() => Promise<{ districts: unknown[] }>>(async () => ({
      districts: [],
    })),
  } as unknown as DistrictNexusService;
}

describe('DistrictNexusPriorityIntelligenceService — loadMembers SQL', () => {
  test('queries congress_member.state (not the non-existent state_code) for both chambers', async () => {
    const { prisma, capturedCongressMemberSql } = makePrisma({ congressMemberBehavior: 'empty' });
    const svc = new DistrictNexusPriorityIntelligenceService(prisma, makeNexusStub());
    // loadMembers is private; this is the one query this incident was about,
    // so we exercise it directly rather than mock the whole public method's
    // five other collaborators just to reach it.
    const loadMembers = (
      svc as unknown as {
        loadMembers: (
          tenantId: string,
          state: string,
          district: string,
        ) => Promise<{ houseMemberBioguideIds: string[]; senatorBioguideIds: string[] }>;
      }
    ).loadMembers.bind(svc);

    await loadMembers(TENANT, 'FL', '08');

    expect(capturedCongressMemberSql).toHaveLength(2); // house query + senate query
    for (const sql of capturedCongressMemberSql) {
      expect(sql).toMatch(/cm\.state\s*=/);
      expect(sql).not.toMatch(/cm\.state_code/);
    }
    // The house query also casts the INTEGER district column to text before
    // coalescing against an empty-string literal.
    expect(capturedCongressMemberSql[0]).toMatch(/COALESCE\(cm\.district::text, ''\)/);
  });

  test('converts the 2-letter state code to the full name congress_member.state actually stores', async () => {
    // Verified live against production: congress_member.state holds "Florida",
    // never "FL". The fixed column reference (cm.state, not cm.state_code)
    // stopped the query from throwing, but comparing a 2-letter code against
    // this column would still silently match zero rows forever — no error,
    // so this was invisible until checked against real data post-deploy.
    const { prisma, capturedCongressMemberValues } = makePrisma({
      congressMemberBehavior: 'empty',
    });
    const svc = new DistrictNexusPriorityIntelligenceService(prisma, makeNexusStub());
    const loadMembers = (
      svc as unknown as {
        loadMembers: (tenantId: string, state: string, district: string) => Promise<unknown>;
      }
    ).loadMembers.bind(svc);

    await loadMembers(TENANT, 'FL', '08');

    expect(capturedCongressMemberValues).toHaveLength(2);
    for (const values of capturedCongressMemberValues) {
      expect(values).toContain('Florida');
      expect(values).not.toContain('FL');
    }
  });

  test('an unmapped/unknown state code falls back to passing the code through unchanged', async () => {
    const { prisma, capturedCongressMemberValues } = makePrisma({
      congressMemberBehavior: 'empty',
    });
    const svc = new DistrictNexusPriorityIntelligenceService(prisma, makeNexusStub());
    const loadMembers = (
      svc as unknown as {
        loadMembers: (tenantId: string, state: string, district: string) => Promise<unknown>;
      }
    ).loadMembers.bind(svc);

    await loadMembers(TENANT, 'ZZ', '08');

    expect(capturedCongressMemberValues[0]).toContain('ZZ');
  });

  test('maps real bioguide ids from both chambers', async () => {
    const { prisma } = makePrisma({
      congressMemberBehavior: (sql) =>
        sql.includes("chamber = 'house'")
          ? [{ bioguide_id: 'M001234' }]
          : [{ bioguide_id: 'S005678' }],
    });
    const svc = new DistrictNexusPriorityIntelligenceService(prisma, makeNexusStub());
    const loadMembers = (
      svc as unknown as {
        loadMembers: (
          tenantId: string,
          state: string,
          district: string,
        ) => Promise<{
          houseMemberBioguideIds: string[];
          senatorBioguideIds: string[];
          representation: string;
        }>;
      }
    ).loadMembers.bind(svc);
    const result = await loadMembers(TENANT, 'FL', '08');
    expect(result.houseMemberBioguideIds).toEqual(['M001234']);
    expect(result.senatorBioguideIds).toEqual(['S005678']);
  });

  test('house attribution stays source-backed: an empty result is empty, never a guessed member', async () => {
    const { prisma } = makePrisma({ congressMemberBehavior: 'empty' });
    const svc = new DistrictNexusPriorityIntelligenceService(prisma, makeNexusStub());
    const loadMembers = (
      svc as unknown as {
        loadMembers: (
          tenantId: string,
          state: string,
          district: string,
        ) => Promise<{ houseMemberBioguideIds: string[] }>;
      }
    ).loadMembers.bind(svc);
    const result = await loadMembers(TENANT, 'FL', '08');
    expect(result.houseMemberBioguideIds).toEqual([]);
  });

  test('senate query never filters on district — Senate requests are statewide', async () => {
    const { prisma, capturedCongressMemberSql } = makePrisma({ congressMemberBehavior: 'empty' });
    const svc = new DistrictNexusPriorityIntelligenceService(prisma, makeNexusStub());
    const loadMembers = (
      svc as unknown as {
        loadMembers: (tenantId: string, state: string, district: string) => Promise<unknown>;
      }
    ).loadMembers.bind(svc);
    await loadMembers(TENANT, 'FL', '08');
    const senateSql = capturedCongressMemberSql.find((sql) => sql.includes("chamber = 'senate'"));
    expect(senateSql).toBeDefined();
    expect(senateSql).not.toMatch(/district/i);
  });

  test('a sentinel/at-large district value ("00") is passed through, not silently rejected client-side', async () => {
    // Guards against a future regression that special-cases at-large (single
    // statewide House seat, district code "00") as if it were an invalid or
    // "sentinel" value — it is a real, source-backed district code.
    const { prisma, capturedCongressMemberSql } = makePrisma({ congressMemberBehavior: 'empty' });
    const svc = new DistrictNexusPriorityIntelligenceService(prisma, makeNexusStub());
    const loadMembers = (
      svc as unknown as {
        loadMembers: (tenantId: string, state: string, district: string) => Promise<unknown>;
      }
    ).loadMembers.bind(svc);
    await loadMembers(TENANT, 'MT', '00');
    const houseSql = capturedCongressMemberSql.find((sql) => sql.includes("chamber = 'house'"));
    expect(houseSql).toBeDefined();
  });
});

describe('DistrictNexusPriorityIntelligenceService — GSA baseline suppression (Phase 3)', () => {
  test('loadChanges() queries observationKind: "change" — baseline rows are excluded at the DB level, not client-side', async () => {
    // A DB-level filter (not a post-fetch slice) is what actually protects
    // the `take: 20` window: if baseline rows were filtered in JS after
    // fetching only 20 rows ordered by recency, a district with >20 baseline
    // rows would still see zero real events. Filtering in the WHERE clause
    // means the 20-row window is drawn only from genuine 'change' rows to
    // begin with — this test proves the query shape, not just the output.
    const { prisma } = makePrisma({ congressMemberBehavior: 'empty' });
    const findMany = (prisma as unknown as { districtNexusChange: { findMany: jest.Mock } })
      .districtNexusChange.findMany;
    const svc = new DistrictNexusPriorityIntelligenceService(prisma, makeNexusStub());

    await svc.getClientDistrictPriorityIntelligence(TENANT, CLIENT, 'FL', '08');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ observationKind: 'change' }),
        take: 20,
      }),
    );
  });

  test('a district with many baseline rows still surfaces genuine change rows within the 20-row window (pagination coexistence)', async () => {
    // Simulate the real shape: the mocked findMany is asked to filter to
    // observationKind:'change', and returns ONLY the genuine change rows
    // (as the real WHERE clause would) even though far more than 20 baseline
    // rows exist in the underlying table for this district.
    const changeRow = {
      changeKind: 'cpf_cds_request_new',
      source: 'cpf',
      sourceRecordId: 'req-1',
      stateCode: 'FL',
      districtCode: '08',
      boundaryCongress: null,
      oldValue: null,
      newValue: { requestedAmountUsd: '500000' },
      oldState: null,
      newState: 'requested',
      observedAt: new Date('2026-09-05T00:00:00.000Z'),
      effectiveAt: null,
      sourceYear: 2026,
      geographyVintage: 'source_unknown',
      severity: 'notable',
      provenance: {},
    };
    const { prisma } = makePrisma({ congressMemberBehavior: 'empty' });
    const districtNexusChange = (
      prisma as unknown as {
        districtNexusChange: {
          findMany: jest.Mock<
            (args?: { where?: { observationKind?: string } }) => Promise<unknown[]>
          >;
        };
      }
    ).districtNexusChange;
    districtNexusChange.findMany.mockImplementation(async (args) =>
      args?.where?.observationKind === 'change' ? [changeRow] : [],
    );
    const svc = new DistrictNexusPriorityIntelligenceService(prisma, makeNexusStub());

    const result = await svc.getClientDistrictPriorityIntelligence(TENANT, CLIENT, 'FL', '08');

    expect(result.priorityIntelligence.recentChanges).toHaveLength(1);
    expect(result.priorityIntelligence.recentChanges[0]!.changeKind).toBe('cpf_cds_request_new');
  });
});

describe('DistrictNexusPriorityIntelligenceService — member-rail failure isolation', () => {
  test('a failed congress_member query degrades to a warning, not a 500', async () => {
    const { prisma } = makePrisma({ congressMemberBehavior: 'throw' });
    const svc = new DistrictNexusPriorityIntelligenceService(prisma, makeNexusStub());

    const result = await svc.getClientDistrictPriorityIntelligence(TENANT, CLIENT, 'FL', '08');

    expect(result.member).toEqual({
      houseMemberBioguideIds: [],
      senatorBioguideIds: [],
      representation: 'Representation unavailable',
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Representation could not be loaded')]),
    );
    // Other rails still populate — a member-query failure must not blank them.
    expect(result.priorityIntelligence).toBeDefined();
    expect(result.priorityIntelligence.federalProperty).toBeDefined();
  });

  test('a healthy congress_member query returns real representation with no warning about it', async () => {
    const { prisma } = makePrisma({
      congressMemberBehavior: (sql) =>
        sql.includes("chamber = 'house'") ? [{ bioguide_id: 'M001234' }] : [],
    });
    const svc = new DistrictNexusPriorityIntelligenceService(prisma, makeNexusStub());

    const result = await svc.getClientDistrictPriorityIntelligence(TENANT, CLIENT, 'FL', '08');

    expect(result.member.houseMemberBioguideIds).toEqual(['M001234']);
    expect(result.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining('Representation could not be loaded')]),
    );
  });

  test('the full service call resolves 200-shaped output end to end (controller/service path) with a realistic fixture', async () => {
    const { prisma } = makePrisma({
      congressMemberBehavior: (sql) =>
        sql.includes("chamber = 'house'")
          ? [{ bioguide_id: 'M001234' }]
          : [{ bioguide_id: 'S005678' }, { bioguide_id: 'S009012' }],
    });
    const svc = new DistrictNexusPriorityIntelligenceService(prisma, makeNexusStub());

    const result = await svc.getClientDistrictPriorityIntelligence(TENANT, CLIENT, 'FL', '08');

    expect(result.clientId).toBe(CLIENT);
    expect(result.state).toBe('FL');
    expect(result.district).toBe('08');
    expect(result.member.houseMemberBioguideIds).toEqual(['M001234']);
    expect(result.member.senatorBioguideIds).toEqual(['S005678', 'S009012']);
    expect(result.priorityIntelligence).toBeDefined();
    expect(result.computedAt).toEqual(expect.any(String));
  });
});
