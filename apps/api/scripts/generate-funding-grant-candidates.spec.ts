import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  DEFAULT_MIN_RELEVANCE,
  PAGE_SIZE,
  generateFundingGrantCandidates,
  parseArgs,
  resolveTenantIds,
} from './generate-funding-grant-candidates.js';
import { scoreOpportunityRelevance } from '../src/district-nexus/grant-opportunity-relevance.js';
import { buildClientOpportunityProfile } from '../src/funding-opportunities/client-opportunity-profile.builder.js';
import {
  buildAwardHistoryIdentity,
  contractorIdsToResolve,
} from '../src/funding-opportunities/award-history-identity.js';
import {
  asProfileReadClient,
  readAwardHistoryByBasis,
  readClientProfileFactsMany,
  resolveContractorUeis,
} from '../src/funding-opportunities/client-opportunity-profile.repository.js';

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
    capabilities: [{ name: 'Medicaid analytics', tags: ['health'], keywords: [], peNumbers: [] }],
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

function makeFake(
  options: {
    grants?: Array<Record<string, unknown>>;
    clients?: Array<Record<string, unknown>>;
    mappings?: Array<Record<string, unknown>>;
    existing?: Array<Record<string, unknown>>;
    flagRows?: Array<{ tenant_id: string }>;
  } = {},
) {
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const clientWhere: unknown[] = [];
  const mappingWhere: unknown[] = [];
  const grantPageArgs: Array<{ where?: any; take?: number; orderBy?: unknown }> = [];
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
  // Keyset-aware fakes. The producer pages with `id > cursor ORDER BY id`, so a
  // fake that ignored the cursor and returned the whole array on every call would
  // loop forever. These emulate the real semantics, which is also what makes the
  // boundary and resume tests below meaningful rather than decorative.
  const allGrants = () => options.grants ?? [grantRow()];
  const allClients = () => options.clients ?? [clientRow()];

  function page<T extends { id: string }>(
    rows: T[],
    where: Record<string, any> | undefined,
    take: number | undefined,
  ): T[] {
    const gt = (where?.id as { gt?: string } | undefined)?.gt;
    const exact = typeof where?.id === 'string' ? (where.id as string) : null;
    let out = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (exact) out = out.filter((r) => r.id === exact);
    if (gt) out = out.filter((r) => r.id > gt);
    return take == null ? out : out.slice(0, take);
  }

  fake.federalGrant = {
    findMany: jest.fn(async (args: { where?: any; take?: number }) => {
      grantPageArgs.push(args);
      return page(allGrants() as Array<{ id: string }>, args.where, args.take);
    }),
  };
  fake.client = {
    findMany: jest.fn(async (args: { where?: any; take?: number }) => {
      clientWhere.push(args.where);
      return page(allClients() as Array<{ id: string }>, args.where, args.take);
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
    findMany: jest.fn(async (args: { where?: any; select?: Record<string, boolean> }) => {
      const rows = options.existing ?? [];
      const ids = args?.where?.grantOpportunityId?.in as string[] | undefined;
      // The producer scopes this read to the current grant page. Honouring that
      // here is what proves the scoping is real rather than cosmetic.
      const scoped = ids ? rows.filter((r: any) => ids.includes(r.grantOpportunityId)) : rows;
      // Honour projection too: a safety check cannot preserve a decision the
      // production query never selected, even if a permissive fake returned it.
      return args.select
        ? scoped.map((row) =>
            Object.fromEntries(
              Object.entries(args.select!)
                .filter(([, selected]) => selected)
                .map(([key]) => [key, row[key]]),
            ),
          )
        : scoped;
    }),
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
    grantPageArgs,
  };
}

describe('funding grant producer CLI', () => {
  test('dry run is the default and all supported filters parse', () => {
    expect(parseArgs([])).toEqual({
      commit: false,
      tenantId: null,
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      resumeClient: null,
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
    ).toEqual({
      commit: true,
      tenantId: TENANT,
      clientId: CLIENT,
      minRelevance: 40,
      resumeClient: null,
    });
    // P03 resume flag: an INCOMPLETE run reports a cursor and this is how an
    // operator finishes the walk.
    expect(parseArgs(['node', 'script', '--resume-client', 'client-00042']).resumeClient).toBe(
      'client-00042',
    );
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
});

// ── P03: complete coverage ──────────────────────────────────────────────────

/** Zero-padded so lexicographic id order matches numeric order. */
const pad = (n: number) => String(n).padStart(5, '0');

describe('coverage is complete, not capped', () => {
  test('4,001 grants and 501 clients: the LAST row of each is evaluated', async () => {
    // The old bound was 4,000 grants and 500 clients, so both dimensions here sit
    // exactly one past it. Before P03 the 4,001st grant and the 501st client were
    // never read at all and the run reported an error counter instead.
    const grants = Array.from({ length: 4001 }, (_, i) =>
      grantRow({ id: `grant-${pad(i)}`, cfdaNumbers: [] }),
    );
    const clients = Array.from({ length: 501 }, (_, i) => clientRow({ id: `client-${pad(i)}` }));
    const { prisma } = makeFake({ grants, clients, mappings: [] });

    const result = await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: false,
    });

    expect(result.completion).toBe('COMPLETE');
    expect(result.clientsRead).toBe(501);
    expect(result.opportunitiesRead).toBe(4001);
    expect(result.evaluated).toBe(4001 * 501);
    // A complete run is a clean success: no error counter standing in for
    // truncation, and no `partial` status.
    expect(result.complete).not.toBe(false);
    expect(result.errors).toBe(0);
    expect(result.resumeClientCursor).toBeNull();
  }, 120000);

  test('a page-sized corpus is COMPLETE, not mistaken for a full page with more behind it', async () => {
    // The boundary a naive walk gets wrong: exactly PAGE_SIZE rows returns a FULL
    // page, so the walk must ask once more and get zero rather than assuming it is
    // done or assuming there is more.
    const grants = Array.from({ length: PAGE_SIZE }, (_, i) =>
      grantRow({ id: `grant-${pad(i)}`, cfdaNumbers: [] }),
    );
    const { prisma } = makeFake({ grants, mappings: [] });
    const result = await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: false,
    });
    expect(result.completion).toBe('COMPLETE');
    expect(result.opportunitiesRead).toBe(PAGE_SIZE);
  }, 60000);

  test('an empty corpus is COMPLETE with nothing evaluated', async () => {
    const { prisma } = makeFake({ grants: [], mappings: [] });
    const result = await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: false,
    });
    expect(result.completion).toBe('COMPLETE');
    expect(result.evaluated).toBe(0);
  });

  test('the grant walk pages by keyset, never by close date', async () => {
    // closeDate is nullable, non-unique and mutable. Paging on it can show a row
    // twice or never — which is why the pre-P03 read ordered by it and could only
    // ever be a capped snapshot, not a walk.
    const grants = Array.from({ length: PAGE_SIZE + 10 }, (_, i) =>
      grantRow({ id: `grant-${pad(i)}`, cfdaNumbers: [] }),
    );
    const { prisma, grantPageArgs } = makeFake({ grants, mappings: [] });
    await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: false,
    });
    expect(grantPageArgs.length).toBeGreaterThan(1);
    for (const args of grantPageArgs) {
      expect(args.orderBy).toEqual({ id: 'asc' });
      expect(JSON.stringify(args.orderBy)).not.toContain('closeDate');
      expect(args.take).toBe(PAGE_SIZE);
    }
    // Second and later pages must be cursor-scoped, or the walk re-reads page one
    // forever.
    expect(grantPageArgs[1]!.where.id).toEqual({ gt: `grant-${pad(PAGE_SIZE - 1)}` });
  }, 60000);

  test('re-running after completion is idempotent', async () => {
    const grants = [grantRow()];
    const first = makeFake({ grants });
    const a = await generateFundingGrantCandidates(first.prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: true,
    });
    expect(a.created).toBe(1);
    expect(first.created).toHaveLength(1);

    // Second pass sees the row the first pass wrote.
    const second = makeFake({
      grants,
      existing: [
        {
          id: 'wf-1',
          clientId: CLIENT,
          grantOpportunityId: GRANT,
          workflowStatus: 'suggested',
          userCreated: false,
          evidenceSourceType: 'deterministic_relevance_v1',
          staleAt: null,
        },
      ],
    });
    const b = await generateFundingGrantCandidates(second.prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: true,
    });
    expect(b.created).toBe(0);
    expect(b.refreshed).toBe(1);
    expect(second.created).toHaveLength(0);
  });

  test('a resumed run starts strictly AFTER the cursor and skips nothing after it', async () => {
    const clients = Array.from({ length: 5 }, (_, i) => clientRow({ id: `client-${pad(i)}` }));
    const { prisma, clientWhere } = makeFake({ clients, mappings: [] });
    const result = await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: false,
      resumeClientCursor: `client-${pad(1)}`,
    });
    // Strictly after: client-00000 and client-00001 are not re-processed, and
    // 00002..00004 all are. `id > cursor` is what makes both halves true at once —
    // an `id >= cursor` resume would re-process one row, and an offset resume
    // would skip rows if anything was inserted meanwhile.
    expect((clientWhere[0] as { id?: unknown }).id).toEqual({ gt: `client-${pad(1)}` });
    expect(result.clientsRead).toBe(3);
    expect(result.completion).toBe('COMPLETE');
  });

  test('queries are bounded per PAGE, never one per (client, grant) pair', async () => {
    const grants = Array.from({ length: 40 }, (_, i) =>
      grantRow({ id: `grant-${pad(i)}`, cfdaNumbers: [] }),
    );
    const clients = Array.from({ length: 20 }, (_, i) => clientRow({ id: `client-${pad(i)}` }));
    const { prisma } = makeFake({ grants, clients, mappings: [] });
    const result = await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: false,
    });

    // 800 pairs evaluated...
    expect(result.evaluated).toBe(800);
    // ...from ONE grant page and ONE existing-row read, because both corpora fit
    // in a single page. The N x M shape this guards against would be 800 reads.
    expect((prisma.federalGrant.findMany as jest.Mock).mock.calls.length).toBeLessThanOrEqual(2);
    expect(
      (prisma.clientFundingOpportunity.findMany as jest.Mock).mock.calls.length,
    ).toBeLessThanOrEqual(2);
    // Award history is per client per rail, not per pair.
    const historyCalls = (prisma.$queryRaw as jest.Mock).mock.calls.filter(([strings]) =>
      Array.from(strings as TemplateStringsArray)
        .join('?')
        .includes('federal_a'),
    );
    expect(historyCalls.length).toBeLessThanOrEqual(2 * clients.length);
  }, 60000);

  test('the existing-row read is scoped to the current grant page', async () => {
    const grants = Array.from({ length: PAGE_SIZE + 5 }, (_, i) =>
      grantRow({ id: `grant-${pad(i)}`, cfdaNumbers: [] }),
    );
    const { prisma } = makeFake({ grants, mappings: [] });
    await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: false,
    });
    for (const [args] of (prisma.clientFundingOpportunity.findMany as jest.Mock).mock.calls) {
      const where = (args as { where: { grantOpportunityId?: { in?: string[] } } }).where;
      // Unscoped, this read grows with a client's entire suggestion history rather
      // than with the page being processed.
      expect(where.grantOpportunityId?.in).toBeDefined();
      expect(where.grantOpportunityId!.in!.length).toBeLessThanOrEqual(PAGE_SIZE);
    }
  }, 60000);

  test('no output tells an operator to raise a cap', async () => {
    // Completion is algorithmic. There is no cap to raise, so no message may
    // suggest one — that message was the old producer's only remedy for partial
    // coverage.
    // Comments are stripped first: the file legitimately EXPLAINS the caps it
    // replaced, so scanning raw text would fail on the explanation rather than on
    // any behaviour. Same technique as funding-opportunities.boundaries.spec.ts.
    const source = readFileSync(join(__dirname, 'generate-funding-grant-candidates.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n\r]*/g, '');
    expect(source).not.toMatch(/raise the (audited )?caps?/i);
    expect(source).not.toMatch(/\bCAPPED\b/);
    expect(source).not.toMatch(/OPPORTUNITY_SCAN_CAP|CLIENT_CAP/);
  });
});

// ── G1: the producer must not own a floor of its own ────────────────────────

/**
 * The producer used to inline `strong >= 1 || moderate >= 2`, which is the SAM
 * rail's floor. The grant rail's floor has a third arm — one moderate
 * `capabilityKeyword` together with a distinctive weak topical signal — because
 * this rail has only ONE moderate signal, so keyword-driven fits were invisible.
 * Compounded by a numeric default of ~29 (the assistance-listing floor) against
 * a keyword+sector pair that scores ~18.
 *
 * Live consequence, measured the day this was fixed: 164,428 real (client,
 * grant) pairs across 101 clients produced FOUR candidates. 65 of those clients
 * have a sector and 60 have capabilities; only 2 have applicant-type data —
 * exactly the profile shape the re-derived floor discarded.
 */

/** The producer's own mapping from a grant row to an OpportunityProfile. */
function opportunityProfileOf(grant: Record<string, unknown>) {
  return {
    assistanceListingNumber: (grant.cfdaNumbers as string[])[0] ?? null,
    agency: grant.agency as string | null,
    fundingCategory: grant.category as string | null,
    title: grant.title as string | null,
    description: grant.description as string | null,
    eligibleApplicantTypes: grant.eligibility as string[],
    geographicRestrictions: [] as string[],
  };
}

/**
 * The scorer's verdict for one (client, grant) pair, reached through the SAME
 * profile pipeline the producer uses — the repository read, the identity rails,
 * and the shared builder — so this is the scorer's answer, not a second
 * implementation of the producer's.
 */
async function scorerFloor(
  clientPartial: Record<string, unknown>,
  grantPartial: Record<string, unknown>,
): Promise<{ meetsSuggestionFloor: boolean; relevanceScore: number }> {
  const { prisma } = makeFake({
    clients: [clientRow(clientPartial)],
    grants: [grantRow(grantPartial)],
    mappings: [],
  });
  const facts = await readClientProfileFactsMany(asProfileReadClient(prisma), {
    tenantId: TENANT,
  });
  const contractorUeis = await resolveContractorUeis(prisma, contractorIdsToResolve(facts));
  const history = await readAwardHistoryByBasis(
    prisma,
    buildAwardHistoryIdentity(facts[0]!, contractorUeis),
  );
  const profile = buildClientOpportunityProfile(facts[0]!, history).grant;
  const scored = scoreOpportunityRelevance(profile, opportunityProfileOf(grantRow(grantPartial)));
  return {
    meetsSuggestionFloor: scored.meetsSuggestionFloor,
    relevanceScore: scored.relevanceScore,
  };
}

/**
 * What the producer decided, isolated to its floor. `minRelevance: 0` removes
 * the numeric backstop, so `created === 1` is true exactly when the producer's
 * floor said yes.
 */
async function producerAcceptedOnFloorAlone(
  clientPartial: Record<string, unknown>,
  grantPartial: Record<string, unknown>,
): Promise<boolean> {
  const { prisma } = makeFake({
    clients: [clientRow(clientPartial)],
    grants: [grantRow(grantPartial)],
    mappings: [],
  });
  const result = await generateFundingGrantCandidates(prisma, {
    tenantIds: [TENANT],
    clientId: null,
    minRelevance: 0,
    commit: false,
  });
  expect(result.evaluated).toBe(1);
  expect(result.errors).toBe(0);
  return result.created === 1;
}

/** A client with nothing in it, so each case below states its own signals. */
const BARE_CLIENT = {
  uei: null,
  applicantTypes: [] as string[],
  sectorTag: null,
  capabilities: [] as unknown[],
  facilities: [] as unknown[],
};

/** A grant with nothing in it, for the same reason. */
const BARE_GRANT = {
  title: 'A notice with no particular subject',
  agency: null,
  category: null,
  eligibility: [] as string[],
  cfdaNumbers: [] as string[],
  description: null,
};

/**
 * The live case, reproduced: a real DOE grant against a real client whose
 * capability is literally "grid resilience". Sector overlap, keyword match, no
 * applicant types, no UEI award history — the commonest real profile shape.
 */
const GRID_CLIENT = {
  ...BARE_CLIENT,
  sectorTag: 'ENERGY',
  capabilities: [{ name: 'grid resilience', tags: [], keywords: [], peNumbers: [] }],
};
const GRID_GRANT = {
  ...BARE_GRANT,
  title: 'Grid Resilience and Innovation Partnerships',
  agency: 'Department of Energy',
  description: 'Strengthening the electric energy grid against extreme weather.',
};

describe('the producer uses the shared suggestion floor (G1)', () => {
  test.each([
    { workflowStatus: 'suggested', userCreated: false, humanDecision: null, stale: true },
    { workflowStatus: 'suggested', userCreated: true, humanDecision: null, stale: false },
    { workflowStatus: 'suggested', userCreated: false, humanDecision: 'monitor', stale: false },
    { workflowStatus: 'suggested', userCreated: false, humanDecision: 'pass', stale: false },
    { workflowStatus: 'saved', userCreated: false, humanDecision: null, stale: false },
    { workflowStatus: 'pursuing', userCreated: false, humanDecision: null, stale: false },
    { workflowStatus: 'dismissed', userCreated: false, humanDecision: null, stale: false },
  ])(
    'rescoring applicant-only $workflowStatus ($humanDecision, userCreated=$userCreated) preserves human choices',
    async ({ workflowStatus, userCreated, humanDecision, stale }) => {
      const { prisma, created, updated } = makeFake({
        clients: [clientRow({ ...BARE_CLIENT, applicantTypes: ['Small businesses'] })],
        grants: [grantRow({ ...BARE_GRANT, eligibility: ['Small businesses'] })],
        mappings: [],
        existing: [
          {
            id: 'old-applicant-only',
            clientId: CLIENT,
            grantOpportunityId: GRANT,
            workflowStatus,
            userCreated,
            humanDecision,
            evidenceSourceType: 'deterministic_relevance_v1',
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
      expect(result.errors).toBe(0);
      expect(created).toEqual([]);
      expect(result.markedStale).toBe(stale ? 1 : 0);
      expect(result.humanDecisionsPreserved).toBe(stale ? 0 : 1);
      expect(updated).toEqual(
        stale
          ? [
              {
                where: { id: 'old-applicant-only' },
                data: { staleAt: expect.any(Date) },
              },
            ]
          : [],
      );
    },
  );

  test("the numeric default is the read path's, not the assistance-listing floor", () => {
    // 29 (the listing floor) sits ABOVE a keyword+sector pair at ~18, so the
    // numeric backstop refused everything the floor's third arm admitted. 15
    // matches the SAM producer and the sibling District Nexus producer.
    expect(DEFAULT_MIN_RELEVANCE).toBe(15);
  });

  test('the proven live case: a "grid resilience" client gets the DOE grid grant', async () => {
    const { prisma } = makeFake({
      clients: [clientRow(GRID_CLIENT)],
      grants: [grantRow(GRID_GRANT)],
      mappings: [],
    });
    const result = await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: false,
    });
    // `create`, not `skip_below_floor`. Before this fix the producer refused
    // this pair while the on-demand read path surfaced it.
    expect(result.created).toBe(1);
    expect(result.evaluated).toBe(1);
    expect(result.errors).toBe(0);
  });

  test('the pair really is keyword+sector, and really does score ~18', async () => {
    // Pins WHY the case is the one that matters: it clears the floor's third arm
    // and lands between the new numeric default (15) and the old one (~29).
    const { prisma } = makeFake({
      clients: [clientRow(GRID_CLIENT)],
      grants: [grantRow(GRID_GRANT)],
      mappings: [],
    });
    const facts = await readClientProfileFactsMany(asProfileReadClient(prisma), {
      tenantId: TENANT,
    });
    const history = await readAwardHistoryByBasis(
      prisma,
      buildAwardHistoryIdentity(facts[0]!, new Map()),
    );
    const scored = scoreOpportunityRelevance(
      buildClientOpportunityProfile(facts[0]!, history).grant,
      opportunityProfileOf(grantRow(GRID_GRANT)),
    );
    expect(scored.matchedSignals.map((s) => s.signal)).toEqual(['capabilityKeyword', 'sector']);
    expect(scored.meetsSuggestionFloor).toBe(true);
    expect(scored.relevanceScore).toBe(18);
  });

  test('BOTH halves of the fix are load-bearing: the old numeric default alone still refuses it', async () => {
    // Proven, and the reason this shipped as one change: routing the producer
    // through the shared floor changes nothing while decideProducerAction is
    // still comparing 18 against 29.
    const { prisma } = makeFake({
      clients: [clientRow(GRID_CLIENT)],
      grants: [grantRow(GRID_GRANT)],
      mappings: [],
    });
    const result = await generateFundingGrantCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 29,
      commit: false,
    });
    expect(result.created).toBe(0);
  });

  /**
   * THE INVARIANT, which is the actual bug class. A test on the specific DOE
   * grant would not have caught the next producer that re-derives a floor.
   */
  describe('the producer floor and scoreOpportunityRelevance never disagree', () => {
    const cases: Array<{
      name: string;
      client: Record<string, unknown>;
      grant: Record<string, unknown>;
      expected: boolean;
    }> = [
      {
        name: 'capabilityKeyword + sector (the third arm this rail exists for)',
        client: GRID_CLIENT,
        grant: GRID_GRANT,
        expected: true,
      },
      {
        name: 'capabilityKeyword + fundingCategory (the third arm, other weak signal)',
        client: {
          ...BARE_CLIENT,
          sectorTag: 'Health',
          capabilities: [{ name: 'medicaid analytics', tags: [], keywords: [], peNumbers: [] }],
        },
        grant: {
          ...BARE_GRANT,
          title: 'Medicaid analytics modernization',
          category: 'Health',
          description: 'A program.',
        },
        expected: true,
      },
      {
        name: 'capabilityKeyword alone (moderate, unaccompanied)',
        client: {
          ...BARE_CLIENT,
          capabilities: [{ name: 'grid resilience', tags: [], keywords: [], peNumbers: [] }],
        },
        grant: { ...BARE_GRANT, title: 'Grid Resilience and Innovation Partnerships' },
        expected: false,
      },
      {
        name: 'sector alone (weak, unaccompanied)',
        client: { ...BARE_CLIENT, sectorTag: 'ENERGY' },
        grant: { ...BARE_GRANT, description: 'Energy programs for rural utilities.' },
        expected: false,
      },
      {
        name: 'applicantType alone (eligibility is not substantive fit)',
        client: { ...BARE_CLIENT, applicantTypes: ['Small businesses'] },
        grant: { ...BARE_GRANT, eligibility: ['Small businesses'] },
        expected: false,
      },
      {
        name: 'generic research capability plus sector and eligibility',
        client: {
          ...BARE_CLIENT,
          applicantTypes: ['Small businesses'],
          sectorTag: 'Health',
          capabilities: [
            { name: 'research and development', tags: [], keywords: [], peNumbers: [] },
          ],
        },
        grant: {
          ...BARE_GRANT,
          title: 'Health research and development',
          eligibility: ['Small businesses'],
        },
        expected: false,
      },
      {
        name: 'the same energy topic repeated in capability, sector and category',
        client: {
          ...BARE_CLIENT,
          sectorTag: 'ENERGY',
          capabilities: [{ name: 'energy', tags: ['energy'], keywords: ['energy'], peNumbers: [] }],
        },
        grant: { ...BARE_GRANT, title: 'Energy funding', category: 'Energy' },
        expected: false,
      },
      {
        name: 'assistanceListing from real award history (strong)',
        client: { ...BARE_CLIENT, uei: 'ABC123456789' },
        grant: { ...BARE_GRANT, cfdaNumbers: ['93.778'] },
        expected: true,
      },
      {
        name: 'no signal at all',
        client: BARE_CLIENT,
        grant: BARE_GRANT,
        expected: false,
      },
    ];

    test.each(cases)('$name', async ({ client, grant, expected }) => {
      const scorer = await scorerFloor(client, grant);
      const producer = await producerAcceptedOnFloorAlone(client, grant);
      // Stated three ways on purpose: the two must agree, AND they must both
      // agree with the value this case was written to exercise — otherwise a
      // symmetric mistake would pass.
      expect(scorer.meetsSuggestionFloor).toBe(expected);
      expect(producer).toBe(expected);
      expect(producer).toBe(scorer.meetsSuggestionFloor);
    });
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
