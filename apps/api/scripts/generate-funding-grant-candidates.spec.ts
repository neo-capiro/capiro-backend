import { describe, expect, jest, test } from '@jest/globals';
import type { PrismaClient } from '@prisma/client';
import {
  CLIENT_CAP,
  DEFAULT_MIN_RELEVANCE,
  OPPORTUNITY_SCAN_CAP,
  generateFundingGrantCandidates,
  parseArgs,
  resolveTenantIds,
} from './generate-funding-grant-candidates.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000010';
const GRANT = 'grant-93-778';

function grantRow(partial: Record<string, unknown> = {}) {
  return {
    id: GRANT,
    title: 'Medicaid innovation grants',
    agency: 'Department of Health and Human Services',
    category: 'Health',
    eligibility: ['Small businesses'],
    cfdaNumbers: ['93.778'],
    description: 'Support for Medicaid innovation.',
    status: 'posted',
    closeDate: new Date('2027-01-15T00:00:00Z'),
    lastUpdatedAt: new Date('2026-07-20T00:00:00Z'),
    detailSyncedAt: new Date('2026-07-18T00:00:00Z'),
    syncedAt: new Date('2026-07-18T00:00:00Z'),
    ...partial,
  };
}

/**
 * Shaped to CLIENT_PROFILE_SELECT, the one select all three profile callers share
 * since P01. It carries more columns than grant scoring reads — `naicsCodes`,
 * `cageCode`, facility ids — because the producer now builds the WHOLE versioned
 * profile so a parity test can compare it against the SAM producer and the read
 * path. A fake missing them is a fake that cannot detect drift.
 */
function clientRow(partial: Record<string, unknown> = {}) {
  return {
    id: CLIENT,
    name: 'Acme Health LLC',
    uei: 'ABC123456789',
    cageCode: null,
    naicsCodes: [],
    pscCodes: [],
    applicantTypes: ['Small businesses'],
    setAsideCertifications: [],
    sectorTag: 'HEALTH',
    capabilities: [
      { name: 'Medicaid analytics', tags: ['health'], keywords: [], peNumbers: [] },
    ],
    facilities: [
      {
        id: '00000000-0000-0000-0000-0000000000f1',
        name: 'Richmond office',
        city: null,
        state: 'VA',
        zip: null,
        congressionalDistrict: null,
      },
    ],
    ...partial,
  };
}

function makeFake(options: {
  grants?: Array<Record<string, unknown>>;
  clients?: Array<Record<string, unknown>>;
  mappings?: Array<Record<string, unknown>>;
  existing?: Array<Record<string, unknown>>;
  flagRows?: Array<{ tenant_id: string }>;
} = {}) {
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const clientWhere: unknown[] = [];
  const mappingWhere: unknown[] = [];
  const bypassCalls: string[] = [];

  const fake: Record<string, any> = {};
  fake.$transaction = jest.fn(async (fn: (tx: PrismaClient) => Promise<unknown>) =>
    fn(fake as PrismaClient),
  );
  fake.$executeRawUnsafe = jest.fn(async (sql: string) => {
    bypassCalls.push(sql);
    return 0;
  });
  fake.$queryRaw = jest.fn(async (strings: TemplateStringsArray) => {
    const sql = Array.from(strings).join('?');
    if (sql.includes('intel_feature_flag')) {
      return options.flagRows ?? [{ tenant_id: TENANT }];
    }
    if (sql.includes('federal_assistance_award')) {
      return [
        {
          assistance_listing_number: '93.778',
          awarding_agency: 'Department of Health and Human Services',
        },
      ];
    }
    return [];
  });
  fake.federalGrant = {
    findMany: jest.fn(async () => options.grants ?? [grantRow()]),
  };
  fake.client = {
    findMany: jest.fn(async (args: { where?: unknown }) => {
      clientWhere.push(args.where);
      return options.clients ?? [clientRow()];
    }),
  };
  fake.clientIntelMapping = {
    findMany: jest.fn(async (args: { where?: unknown }) => {
      mappingWhere.push(args.where);
      return (
        options.mappings ?? [
          {
            clientId: CLIENT,
            // `source` is required since P01: the shared query selects BOTH
            // award-bearing sources and the split happens in code, so a row with
            // no source belongs to neither rail and contributes no history.
            source: 'assistance_recipient',
            externalId: 'ABC123456789',
            externalName: 'Acme Health LLC',
          },
        ]
      );
    }),
  };
  fake.clientFundingOpportunity = {
    findMany: jest.fn(async () => options.existing ?? []),
    create: jest.fn(async (args: { data: unknown }) => {
      created.push(args.data);
      return args.data;
    }),
    update: jest.fn(async (args: unknown) => {
      updated.push(args);
      return args;
    }),
  };

  return {
    prisma: fake as PrismaClient,
    created,
    updated,
    clientWhere,
    mappingWhere,
    bypassCalls,
  };
}

describe('funding grant producer CLI', () => {
  test('dry run is the default and all supported filters parse', () => {
    expect(parseArgs([])).toEqual({
      commit: false,
      tenantId: null,
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
    });
    expect(
      parseArgs([
        'node',
        'script',
        '--commit',
        '--tenant',
        TENANT,
        '--client',
        CLIENT,
        '--min-relevance=40',
      ]),
    ).toEqual({ commit: true, tenantId: TENANT, clientId: CLIENT, minRelevance: 40 });
  });

  test('invalid relevance fails before any database work', () => {
    expect(() => parseArgs(['--min-relevance=101'])).toThrow(/0 to 100/);
  });
});

describe('generateFundingGrantCandidates', () => {
  test('read-time visibility is not required: dry run evaluates real data but writes nothing', async () => {
    const { prisma, created, updated } = makeFake();
    const result = await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: false,
    });
    expect(result.evaluated).toBe(1);
    expect(result.created).toBe(1);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  test('commit creates a producer-owned Grants.gov workflow snapshot', async () => {
    const { prisma, created } = makeFake();
    await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: true,
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual(
      expect.objectContaining({
        tenantId: TENANT,
        clientId: CLIENT,
        source: 'grants_gov',
        grantOpportunityId: GRANT,
        samOpportunityId: null,
        workflowStatus: 'suggested',
        evidenceSourceType: 'deterministic_relevance_v1',
        userCreated: false,
        sourceStatusSnapshot: 'posted',
      }),
    );
  });

  test('human workflow decisions are preserved on rerun', async () => {
    const { prisma, created, updated } = makeFake({
      existing: [
        {
          id: 'wf-1',
          clientId: CLIENT,
          grantOpportunityId: GRANT,
          workflowStatus: 'pursuing',
          userCreated: true,
          evidenceSourceType: 'user_action',
          staleAt: null,
        },
      ],
    });
    const result = await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: true,
    });
    expect(result.humanDecisionsPreserved).toBe(1);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  test('award-history mappings require confirmed review and explicit roll-up', async () => {
    const { prisma, mappingWhere } = makeFake();
    await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: false,
    });
    expect(mappingWhere[0]).toEqual(
      expect.objectContaining({
        tenantId: TENANT,
        confirmed: true,
        reviewStatus: 'confirmed',
        // `true`, not "not false": a null roll-up is an unanswered question, not
        // consent for a subsidiary's awards to count as the client's.
        rollUpAwards: true,
      }),
    );
    // P01 widened this from `source: 'assistance_recipient'` to the shared
    // query, which reads BOTH award-bearing rails and splits them in code — the
    // grant producer now builds the whole versioned profile, not just its half.
    // The list must stay exactly these two: every other mapping source
    // (contractor candidates, LDA, FEC, compliance-sensitive rows) is not
    // award-bearing identity and must never reach award history.
    expect((mappingWhere[0] as { source: { in: string[] } }).source.in.slice().sort()).toEqual([
      'assistance_recipient',
      'contracting',
    ]);
  });

  test('--client narrows the tenant sweep', async () => {
    const { prisma, clientWhere } = makeFake();
    await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: CLIENT,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: false,
    });
    expect(clientWhere[0]).toEqual(expect.objectContaining({ tenantId: TENANT, id: CLIENT }));
  });

  test('tenant reads use RLS bypass plus an explicit tenant filter', async () => {
    const { prisma, bypassCalls, clientWhere } = makeFake();
    await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: false,
    });
    expect(bypassCalls.some((sql) => sql.includes('app.bypass_rls'))).toBe(true);
    expect((clientWhere[0] as { tenantId?: string }).tenantId).toBe(TENANT);
  });

  test('hitting a coverage cap is reported as an error, never clean success', async () => {
    const grants = Array.from({ length: OPPORTUNITY_SCAN_CAP }, (_, index) =>
      grantRow({ id: `grant-${index}`, cfdaNumbers: [] }),
    );
    const { prisma } = makeFake({ grants, clients: [] });
    const result = await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: false,
    });
    expect(result.capped).toBe(true);
    expect(result.errors).toBeGreaterThan(0);
  });

  test('caps remain explicit and nonzero', () => {
    expect(OPPORTUNITY_SCAN_CAP).toBeGreaterThan(0);
    expect(CLIENT_CAP).toBeGreaterThan(0);
  });
});

describe('resolveTenantIds', () => {
  test('an explicit tenant wins regardless of flag state', async () => {
    const { prisma } = makeFake({ flagRows: [] });
    await expect(resolveTenantIds(prisma, TENANT)).resolves.toEqual([TENANT]);
  });

  test('otherwise only funding_opportunities-enabled tenants are selected', async () => {
    const { prisma } = makeFake({ flagRows: [{ tenant_id: TENANT }] });
    await expect(resolveTenantIds(prisma, null)).resolves.toEqual([TENANT]);
  });

  test('there is no implicit internal-tenant write path', async () => {
    const { prisma } = makeFake({ flagRows: [] });
    await expect(resolveTenantIds(prisma, null)).resolves.toEqual([]);
  });
});
