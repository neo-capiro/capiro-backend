import { describe, expect, test } from '@jest/globals';
import {
  parseArgs,
  resolveTenantIds,
  generateCandidates,
  DEFAULT_MIN_RELEVANCE,
  type CandidatesPrisma,
} from './generate-grant-opportunity-candidates.js';

const TENANT = 'tenant-1';

function makeGrant(
  overrides: Partial<{
    id: string;
    title: string;
    agency: string;
    status: string | null;
    closeDate: Date | null;
    eligibility: string[];
    cfdaNumbers: string[];
    category: string | null;
    description: string | null;
  }> = {},
) {
  return {
    id: 'grant-1',
    title: 'Advanced Manufacturing R&D',
    agency: 'DOD',
    status: 'posted',
    closeDate: null,
    eligibility: [],
    cfdaNumbers: ['12.345'],
    category: null,
    description: null,
    ...overrides,
  };
}

function makeClient(
  overrides: Partial<{
    id: string;
    sectorTag: string | null;
    status: string;
    profileStatus: string;
    applicantTypes: string[];
    capabilities: Array<{ name: string; sector: string | null; tags: unknown }>;
    facilities: Array<{ state: string | null }>;
  }> = {},
) {
  return {
    id: 'client-1',
    sectorTag: null,
    status: 'active',
    profileStatus: 'ACTIVE',
    // Defaults to empty, which is what every existing row gets from
    // `20260809010000_client_applicant_types`. Empty means "we do not know",
    // so eligibility stays `needs_review` rather than claiming `eligible`.
    applicantTypes: [] as string[],
    capabilities: [] as Array<{ name: string; sector: string | null; tags: unknown }>,
    facilities: [] as Array<{ state: string | null }>,
    ...overrides,
  };
}

interface ExistingLink {
  id: string;
  tenantId: string;
  clientId: string;
  grantOpportunityId: string;
  relationshipType: string;
  evidenceSourceType: string;
  verificationStatus: string;
}

function makePrismaMock(
  seed: {
    clients?: ReturnType<typeof makeClient>[];
    mappings?: Array<{ clientId: string; source: string; externalId: string | null; externalName: string | null }>;
    grants?: ReturnType<typeof makeGrant>[];
    priorAssistanceRows?: Array<{ assistance_listing_number: string | null; awarding_agency: string | null }>;
    existingLinks?: ExistingLink[];
  } = {},
) {
  const clients = seed.clients ?? [];
  const mappings = seed.mappings ?? [];
  const grants = seed.grants ?? [];
  const priorAssistanceRows = seed.priorAssistanceRows ?? [];
  const links: ExistingLink[] = [...(seed.existingLinks ?? [])];
  const createCalls: Array<{ data: Record<string, unknown> }> = [];
  const updateCalls: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];

  const prisma: CandidatesPrisma = {
    $transaction: (async (fn: (tx: CandidatesPrisma) => unknown) => fn(prisma)) as CandidatesPrisma['$transaction'],
    $executeRawUnsafe: (async () => 0) as CandidatesPrisma['$executeRawUnsafe'],
    $queryRaw: (async () => priorAssistanceRows) as unknown as CandidatesPrisma['$queryRaw'],
    client: {
      findMany: (async () =>
        clients
          // Simulates `where: { status: { not: 'archived' }, profileStatus: 'ACTIVE' }`.
          .filter((c) => c.status !== 'archived' && c.profileStatus === 'ACTIVE')
          .map(({ id, sectorTag, applicantTypes, capabilities, facilities }) => ({
            id,
            sectorTag,
            applicantTypes,
            capabilities,
            facilities,
          }))) as CandidatesPrisma['client']['findMany'],
    },
    clientIntelMapping: {
      findMany: (async () => mappings) as CandidatesPrisma['clientIntelMapping']['findMany'],
    },
    federalGrant: {
      findMany: (async () => grants) as CandidatesPrisma['federalGrant']['findMany'],
    },
    clientGrantNexus: {
      findMany: (async (args: { where: Record<string, string> }) => {
        const w = args.where;
        return links
          .filter(
            (l) =>
              l.tenantId === w.tenantId &&
              l.clientId === w.clientId &&
              l.relationshipType === w.relationshipType &&
              l.evidenceSourceType === w.evidenceSourceType,
          )
          .map((l) => ({
            id: l.id,
            grantOpportunityId: l.grantOpportunityId,
            verificationStatus: l.verificationStatus,
          }));
      }) as CandidatesPrisma['clientGrantNexus']['findMany'],
      create: (async (args: { data: Record<string, unknown> }) => {
        createCalls.push(args);
        const row = { id: `new-${links.length}`, verificationStatus: 'unverified', ...args.data } as ExistingLink;
        links.push(row);
        return row;
      }) as CandidatesPrisma['clientGrantNexus']['create'],
      update: (async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updateCalls.push(args);
        const row = links.find((l) => l.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      }) as CandidatesPrisma['clientGrantNexus']['update'],
    },
  };

  return { prisma, createCalls, updateCalls, links };
}

describe('parseArgs', () => {
  test('defaults to dry-run with the default relevance floor', () => {
    expect(parseArgs([])).toEqual({ commit: false, tenantId: null, minRelevance: DEFAULT_MIN_RELEVANCE });
  });

  test('reads --commit, --tenant, and --min-relevance', () => {
    expect(parseArgs(['--commit', '--tenant', 't-9', '--min-relevance=55'])).toEqual({
      commit: true,
      tenantId: 't-9',
      minRelevance: 55,
    });
  });
});

describe('resolveTenantIds', () => {
  test('an explicit --tenant bypasses the flag lookup entirely', async () => {
    const { prisma } = makePrismaMock();
    const ids = await resolveTenantIds(prisma, 'explicit-tenant', undefined);
    expect(ids).toEqual(['explicit-tenant']);
  });
});

describe('generateCandidates', () => {
  test('dry run writes nothing but still reports a real preview', async () => {
    const { prisma, createCalls, updateCalls } = makePrismaMock({
      clients: [makeClient({ capabilities: [{ name: 'Advanced Manufacturing', sector: null, tags: [] }] })],
      grants: [makeGrant()],
    });

    const result = await generateCandidates(prisma, { tenantIds: [TENANT], minRelevance: 1, commit: false });

    expect(createCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
    expect(result.evaluated).toBe(1);
    expect(result.inserted).toBe(1);
  });

  test('a below-floor score creates nothing', async () => {
    const { prisma, createCalls } = makePrismaMock({
      clients: [makeClient()], // no capabilities/sector/priors — zero-signal profile
      grants: [makeGrant()],
    });

    const result = await generateCandidates(prisma, {
      tenantIds: [TENANT],
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: true,
    });

    expect(createCalls).toHaveLength(0);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('a second run updates rather than duplicating', async () => {
    const client = makeClient({ capabilities: [{ name: 'Advanced Manufacturing', sector: null, tags: [] }] });
    const grant = makeGrant();
    const { prisma, createCalls, updateCalls } = makePrismaMock({ clients: [client], grants: [grant] });

    const first = await generateCandidates(prisma, { tenantIds: [TENANT], minRelevance: 1, commit: true });
    expect(first.inserted).toBe(1);
    expect(createCalls).toHaveLength(1);

    const second = await generateCandidates(prisma, { tenantIds: [TENANT], minRelevance: 1, commit: true });
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
    expect(createCalls).toHaveLength(1); // still just the one row — no duplicate
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('an archived client is skipped', async () => {
    const { prisma, createCalls } = makePrismaMock({
      clients: [
        makeClient({
          id: 'archived-client',
          status: 'archived',
          capabilities: [{ name: 'Advanced Manufacturing', sector: null, tags: [] }],
        }),
      ],
      grants: [makeGrant()],
    });

    const result = await generateCandidates(prisma, { tenantIds: [TENANT], minRelevance: 1, commit: true });

    expect(createCalls).toHaveLength(0);
    expect(result.evaluated).toBe(0);
  });

  test('a previously-generated row that drops below the floor is marked rejected, not deleted', async () => {
    const client = makeClient(); // zero-signal profile — will not clear the default floor
    const grant = makeGrant();
    const { prisma, updateCalls, links } = makePrismaMock({
      clients: [client],
      grants: [grant],
      existingLinks: [
        {
          id: 'existing-1',
          tenantId: TENANT,
          clientId: client.id,
          grantOpportunityId: grant.id,
          relationshipType: 'opportunity_candidate',
          evidenceSourceType: 'deterministic_relevance_v1',
          verificationStatus: 'unverified',
        },
      ],
    });

    const result = await generateCandidates(prisma, {
      tenantIds: [TENANT],
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: true,
    });

    expect(result.inserted).toBe(0);
    expect(links).toHaveLength(1); // not deleted
    expect(links[0]?.verificationStatus).toBe('rejected');
    expect(updateCalls.some((c) => c.data?.verificationStatus === 'rejected')).toBe(true);
  });

  test('a human-created row for the same pair is never read or touched', async () => {
    const client = makeClient({ capabilities: [{ name: 'Advanced Manufacturing', sector: null, tags: [] }] });
    const grant = makeGrant();
    const { prisma, createCalls, updateCalls } = makePrismaMock({
      clients: [client],
      grants: [grant],
      existingLinks: [
        {
          id: 'human-1',
          tenantId: TENANT,
          clientId: client.id,
          grantOpportunityId: grant.id,
          relationshipType: 'opportunity_candidate',
          evidenceSourceType: 'analyst_manual_entry',
          verificationStatus: 'verified',
        },
      ],
    });

    await generateCandidates(prisma, { tenantIds: [TENANT], minRelevance: 1, commit: true });

    // The human row is untouched...
    expect(updateCalls.some((c) => c.where.id === 'human-1')).toBe(false);
    // ...and the script creates its OWN row rather than silently no-op'ing
    // because a same-pair relationship already exists (see plan §6 open
    // decision on the missing unique index — a known, accepted duplication
    // risk between two DIFFERENT evidenceSourceTypes, not this script's bug).
    expect(createCalls).toHaveLength(1);
  });

  // ── Regression: the inner grant loop must not stop at the first miss ──────
  //
  // Until 2026-07-27 this loop used `return` where it meant `continue`. That
  // `return` sat inside the `async (tx) => {…}` callback handed to withBypass,
  // so it exited the entire per-client transaction and abandoned every
  // remaining grant. Live effect: the producer evaluated exactly ONE grant per
  // client (`evaluated=12` for 12 clients × 567 grants, reproduced across
  // eight dry runs at every floor from 10 to 40), so F3 could never emit a row.
  //
  // Every test above passes a SINGLE-element grants array, which makes `return`
  // and `continue` indistinguishable — that is precisely how the bug shipped
  // behind a fully green suite. The non-clearing grant MUST come first here or
  // the test has no teeth.
  test('keeps evaluating after a grant falls below the floor', async () => {
    const { prisma, createCalls } = makePrismaMock({
      clients: [makeClient({ capabilities: [{ name: 'Advanced Manufacturing', sector: null, tags: [] }] })],
      grants: [
        makeGrant({ id: 'g-miss', title: 'Unrelated Widget Program' }), // no keyword hit -> 0
        makeGrant({ id: 'g-hit-1' }), // 'Advanced Manufacturing R&D' -> keyword hit, 15
        makeGrant({ id: 'g-hit-2' }),
      ],
    });

    const result = await generateCandidates(prisma, { tenantIds: [TENANT], minRelevance: 10, commit: true });

    expect(result.evaluated).toBe(3); // pre-fix: 1
    expect(result.skipped).toBe(1);
    expect(result.inserted).toBe(2); // pre-fix: 0
    expect(createCalls.map((c) => c.data.grantOpportunityId)).toEqual(['g-hit-1', 'g-hit-2']);
  });

  test('evaluates every (client, opportunity) pair', async () => {
    const { prisma } = makePrismaMock({
      clients: [makeClient({ id: 'c-1' }), makeClient({ id: 'c-2' }), makeClient({ id: 'c-3' })],
      grants: [
        makeGrant({ id: 'g-1' }),
        makeGrant({ id: 'g-2' }),
        makeGrant({ id: 'g-3' }),
        makeGrant({ id: 'g-4' }),
      ],
    });

    const result = await generateCandidates(prisma, {
      tenantIds: [TENANT],
      minRelevance: DEFAULT_MIN_RELEVANCE,
      commit: false,
    });

    // Zero-signal clients, so all 12 pairs miss the floor. That "every pair
    // misses" shape is exactly what the `return` bug hid behind, so assert the
    // full cross product is walked rather than only the write count.
    expect(result.evaluated).toBe(12);
    expect(result.skipped).toBe(12);
  });

  test('a mid-loop failure is counted but does not abandon the remaining grants', async () => {
    const { prisma } = makePrismaMock({
      clients: [makeClient({ capabilities: [{ name: 'Advanced Manufacturing', sector: null, tags: [] }] })],
      grants: [makeGrant({ id: 'g-1' }), makeGrant({ id: 'g-boom' }), makeGrant({ id: 'g-3' })],
    });

    // Post-batching, the per-grant DB call is the write (create/update), not a
    // read — the existence check is now a single findMany done once per client
    // (see the batching test below). Simulate a write failure for one grant.
    const passthrough = prisma.clientGrantNexus.create;
    prisma.clientGrantNexus.create = (async (args: { data: { grantOpportunityId: string } }) => {
      if (args.data.grantOpportunityId === 'g-boom') throw new Error('simulated write failure');
      return passthrough(args);
    }) as CandidatesPrisma['clientGrantNexus']['create'];

    const result = await generateCandidates(prisma, { tenantIds: [TENANT], minRelevance: 10, commit: true });

    expect(result.evaluated).toBe(3);
    expect(result.errors).toBe(1);
    expect(result.inserted).toBe(2); // g-1 and g-3 are still linked
  });

  // ── B3: the per-grant findFirst is now a single per-client findMany ────────
  test('fetches existing links once per client, not once per (client, grant) pair', async () => {
    const client = makeClient({ capabilities: [{ name: 'Advanced Manufacturing', sector: null, tags: [] }] });
    const { prisma } = makePrismaMock({
      clients: [client],
      grants: [makeGrant({ id: 'g-1' }), makeGrant({ id: 'g-2' }), makeGrant({ id: 'g-3' })],
    });

    let findManyCalls = 0;
    const passthrough = prisma.clientGrantNexus.findMany;
    prisma.clientGrantNexus.findMany = (async (args: unknown) => {
      findManyCalls++;
      return passthrough(args);
    }) as CandidatesPrisma['clientGrantNexus']['findMany'];

    const result = await generateCandidates(prisma, { tenantIds: [TENANT], minRelevance: 10, commit: true });

    expect(result.evaluated).toBe(3);
    expect(findManyCalls).toBe(1); // one client -> one batched fetch, not three
  });
});
