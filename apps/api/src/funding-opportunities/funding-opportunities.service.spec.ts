import { describe, expect, jest, test } from '@jest/globals';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  FundingOpportunitiesService,
  parsePlaceOfPerformance,
} from './funding-opportunities.service.js';

/**
 * Service tests against a hand-built fake PrismaService, following the repo's
 * existing pattern (see intelligence.manual-mapping.spec.ts). No database: what
 * is under test here is the combining, filtering, bounding, tenant-safety and
 * honest-empty-state logic, all of which is deterministic given rows.
 */

const TENANT = '00000000-0000-0000-0000-000000000001';
const OTHER_TENANT = '00000000-0000-0000-0000-000000000002';
const CLIENT = '00000000-0000-0000-0000-000000000010';
const USER = '00000000-0000-0000-0000-000000000100';
const FACILITY = '00000000-0000-0000-0000-000000000200';
const SAM_ID = '00000000-0000-0000-0000-0000000003aa';

interface FakeState {
  client: Record<string, unknown> | null;
  mappings: Array<Record<string, unknown>>;
  grants: Array<Record<string, unknown>>;
  sam: Array<Record<string, unknown>>;
  workflows: Array<Record<string, unknown>>;
  users: Array<Record<string, unknown>>;
  facilities: Array<Record<string, unknown>>;
  syncRuns: Array<Record<string, unknown>>;
  assistanceHistory: Array<Record<string, unknown>>;
  contractHistory: Array<Record<string, unknown>>;
  grantCounts: Array<{ total: bigint; active: bigint }>;
  samCounts: Array<{ total: bigint; active: bigint }>;
  /** When set, every $queryRaw rejects — the "source read failed" case. */
  queryRawThrows?: Error;
}

function grantRow(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'GRANT-1',
    title: 'Advanced Manufacturing Research',
    agency: 'Department of Energy',
    subAgency: null,
    opportunityNumber: 'DE-FOA-0001',
    category: null,
    fundingInstrument: 'Grant',
    // Populated so the default fixture CLEARS the suggestion floor: the grant
    // scorer bands applicantType as strong, and one strong signal is the bar.
    // An empty eligibility array plus the default client's other facts produces
    // zero signals, which is correctly filtered out — a fixture that relied on
    // that would be testing nothing.
    eligibility: ['Small businesses'],
    cfdaNumbers: ['81.086'],
    awardCeiling: null,
    awardFloor: null,
    estimatedFunding: null,
    expectedAwards: null,
    openDate: new Date('2026-06-01T00:00:00Z'),
    closeDate: new Date('2026-12-01T00:00:00Z'),
    status: 'posted',
    description: 'Research into advanced manufacturing.',
    url: 'https://www.grants.gov/x',
    costSharing: null,
    responseDateDesc: null,
    lastUpdatedAt: new Date('2026-07-01T00:00:00Z'),
    detailSyncedAt: null,
    syncedAt: new Date('2026-07-20T00:00:00Z'),
    ...partial,
  };
}

function samRow(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SAM_ID,
    noticeId: 'NOTICE-1',
    solicitationNumber: 'W911-26-R-0001',
    title: 'Turbofan Engine Sustainment',
    noticeType: 'Solicitation',
    baseType: 'Presolicitation',
    agency: 'Department of the Army',
    subAgency: null,
    office: 'ACC-APG',
    pscCode: '1560',
    naicsCode: '336411',
    setAside: null,
    setAsideCode: null,
    postedDate: new Date('2026-07-01T00:00:00Z'),
    responseDeadline: new Date('2026-09-01T00:00:00Z'),
    archiveDate: new Date('2026-10-01T00:00:00Z'),
    description: 'Sustainment of turbofan engines.',
    placeOfPerformance: { city: { name: 'El Paso' }, state: { code: 'TX' } },
    sourceUrl: 'https://sam.gov/opp/NOTICE-1/view',
    active: true,
    lastSyncedAt: new Date('2026-07-25T00:00:00Z'),
    updatedAt: new Date('2026-07-25T00:00:00Z'),
    matches: [],
    ...partial,
  };
}

function makeState(partial: Partial<FakeState> = {}): FakeState {
  return {
    client: {
      id: CLIENT,
      name: 'Acme Defense',
      uei: 'ABC123456789',
      cageCode: null,
      naicsCodes: ['336411'],
      pscCodes: [],
      applicantTypes: ['Small businesses'],
      setAsideCertifications: [],
      sectorTag: 'DEFENSE',
      capabilities: [{ name: 'turbofan', tags: [], keywords: [], peNumbers: [] }],
      facilities: [
        { id: FACILITY, name: 'El Paso Plant', city: 'El Paso', state: 'TX', zip: '79906', congressionalDistrict: '16' },
      ],
    },
    mappings: [],
    grants: [grantRow()],
    sam: [samRow()],
    workflows: [],
    users: [{ id: USER, firstName: 'Ada', lastName: 'Byron', email: 'ada@example.com' }],
    facilities: [
      { id: FACILITY, name: 'El Paso Plant', city: 'El Paso', state: 'TX', zip: '79906', congressionalDistrict: '16', clientId: CLIENT },
    ],
    syncRuns: [
      { source: 'sync-grants', finished_at: new Date('2026-07-28T00:00:00Z'), error_count: 0, status: 'success' },
      { source: 'sync-sam-opportunities-all-federal', finished_at: new Date('2026-07-27T00:00:00Z'), error_count: 0, status: 'success' },
    ],
    assistanceHistory: [],
    contractHistory: [],
    grantCounts: [{ total: 1n, active: 1n }],
    samCounts: [{ total: 1n, active: 1n }],
    ...partial,
  };
}

/**
 * The fake. `withTenant` records the tenant it was called with, which is how the
 * tenant-isolation assertions below verify that nothing reads outside scope.
 */
function makeFake(state: FakeState) {
  const tenantsSeen: string[] = [];
  let nextId = 1;

  const tx = {
    client: {
      findFirst: jest.fn(async (args: any) => {
        if (!state.client) return null;
        if (args?.where?.id && args.where.id !== state.client.id) return null;
        return state.client;
      }),
    },
    clientIntelMapping: {
      findMany: jest.fn(async () => state.mappings),
    },
    clientFundingOpportunity: {
      findMany: jest.fn(async () => state.workflows),
      findFirst: jest.fn(async (args: any) => {
        const w = args?.where ?? {};
        return (
          state.workflows.find(
            (row) =>
              (w.clientId === undefined || row.clientId === w.clientId) &&
              (w.source === undefined || row.source === w.source) &&
              (w.grantOpportunityId === undefined ||
                row.grantOpportunityId === w.grantOpportunityId) &&
              (w.samOpportunityId === undefined || row.samOpportunityId === w.samOpportunityId),
          ) ?? null
        );
      }),
      create: jest.fn(async (args: any) => {
        const row = {
          id: `wf-${nextId++}`,
          createdAt: new Date('2026-07-28T00:00:00Z'),
          updatedAt: new Date('2026-07-28T00:00:00Z'),
          notes: null,
          dismissedReason: null,
          outcomeNote: null,
          ownerUserId: null,
          facilityId: null,
          staleAt: null,
          userCreated: false,
          ...args.data,
        };
        state.workflows.push(row);
        return row;
      }),
      update: jest.fn(async (args: any) => {
        const row = state.workflows.find((r) => r.id === args.where.id);
        if (!row) throw new Error('no row');
        Object.assign(row, args.data, { updatedAt: new Date('2026-07-28T01:00:00Z') });
        return row;
      }),
    },
    user: { findMany: jest.fn(async () => state.users), findFirst: jest.fn(async (args: any) => state.users.find((u) => u.id === args?.where?.id) ?? null) },
    clientFacility: {
      findMany: jest.fn(async () => state.facilities),
      findFirst: jest.fn(async (args: any) => {
        const w = args?.where ?? {};
        return (
          state.facilities.find(
            (f) =>
              f.id === w.id && (w.clientId === undefined || f.clientId === w.clientId),
          ) ?? null
        );
      }),
    },
    $queryRaw: jest.fn(async () => []),
  };

  const prisma = {
    withTenant: jest.fn(async (tenantId: string, fn: (t: typeof tx) => unknown) => {
      tenantsSeen.push(tenantId);
      return fn(tx);
    }),
    withSystem: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    $queryRaw: jest.fn(async (strings: unknown) => {
      if (state.queryRawThrows) throw state.queryRawThrows;
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('sync_run')) return state.syncRuns;
      if (sql.includes('FROM federal_assistance_award')) return state.assistanceHistory;
      if (sql.includes('FROM federal_award')) return state.contractHistory;
      if (sql.includes('FROM federal_grant')) return state.grantCounts;
      if (sql.includes('FROM sam_opportunity')) return state.samCounts;
      return [];
    }),
    federalGrant: {
      findMany: jest.fn(async () => state.grants),
      findUnique: jest.fn(async (args: any) =>
        state.grants.find((g) => g.id === args.where.id) ?? null,
      ),
      groupBy: jest.fn(async () => [{ status: 'posted', _count: { _all: state.grants.length } }]),
    },
    samOpportunity: {
      findMany: jest.fn(async () => state.sam),
      findUnique: jest.fn(async (args: any) => state.sam.find((s) => s.id === args.where.id) ?? null),
      groupBy: jest.fn(async () => [{ active: true, _count: { _all: state.sam.length } }]),
    },
  };

  return { prisma, tx, tenantsSeen };
}

function makeService(state: FakeState) {
  const fake = makeFake(state);
  return {
    service: new FundingOpportunitiesService(fake.prisma as never),
    ...fake,
    state,
  };
}

// ── Discovery without producer rows ──────────────────────────────────────────

describe('grant + contract discovery works with NO producer candidate rows', () => {
  test('a client with matching NAICS sees the contract opportunity with no workflow row anywhere', async () => {
    const { service, state } = makeService(makeState());
    expect(state.workflows).toHaveLength(0);

    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    const sam = res.opportunities.find((o) => o.source === 'sam_gov');
    expect(sam).toBeDefined();
    expect(sam?.workflow).toBeNull();
    expect(sam?.matchedSignals.map((s) => s.signal)).toContain('naicsExact');
  });

  test('a grant matching on prior Assistance Listing surfaces from award history alone', async () => {
    const state = makeState({
      mappings: [
        {
          source: 'assistance_recipient',
          externalId: 'ABC123456789',
          externalName: 'ACME DEFENSE',
          rollUpAwards: true,
        },
      ],
    });
    const { service, prisma } = makeService(state);
    // The award-history query returns the client's prior listing/agency.
    (prisma.$queryRaw as jest.Mock).mockImplementation(async (strings: unknown) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('sync_run')) return state.syncRuns;
      if (sql.includes('federal_assistance_award')) {
        return [{ assistance_listing_number: '81.086', awarding_agency: 'Department of Energy' }];
      }
      return [];
    });

    const res = await service.listClientOpportunities(TENANT, CLIENT, { source: 'grants_gov' });
    const grant = res.opportunities.find((o) => o.source === 'grants_gov');
    expect(grant?.matchedSignals.map((s) => s.signal)).toContain('assistanceListing');
  });

  test('an UNCONFIRMED mapping contributes no award history', async () => {
    // Scoring a client's relevance off a guessed corporate identity is how a wrong
    // suggestion acquires a credible-looking justification.
    const state = makeState({ mappings: [] });
    const { service, tx } = makeService(state);
    await service.listClientOpportunities(TENANT, CLIENT, {});
    const call = (tx.clientIntelMapping.findMany as jest.Mock).mock.calls[0]?.[0] as any;
    expect(call.where.confirmed).toBe(true);
    expect(call.where.reviewStatus).toBe('confirmed');
    expect(call.where.rollUpAwards).toBe(true);
  });

  test('an undecided corporate roll-up mapping is excluded by the scoped query', async () => {
    const state = makeState({
      mappings: [
        {
          source: 'contracting',
          externalId: 'ABC123456789',
          externalName: 'ACME HOLDINGS',
          confirmed: true,
          reviewStatus: 'confirmed',
          rollUpAwards: null,
        },
      ],
    });
    const { service, tx } = makeService(state);
    await service.listClientOpportunities(TENANT, CLIENT, { source: 'sam_gov' });
    const call = (tx.clientIntelMapping.findMany as jest.Mock).mock.calls[0]?.[0] as any;
    expect(call.where).toEqual(
      expect.objectContaining({ confirmed: true, reviewStatus: 'confirmed', rollUpAwards: true }),
    );
  });

  test('assistance-only identities never trigger a contract-history query', async () => {
    const baseClient = makeState().client as Record<string, unknown>;
    const state = makeState({
      client: { ...baseClient, uei: null },
      mappings: [
        {
          source: 'assistance_recipient',
          externalId: 'ASSIST123456',
          externalName: 'ACME FOUNDATION',
          confirmed: true,
          reviewStatus: 'confirmed',
          rollUpAwards: true,
        },
      ],
      assistanceHistory: [
        { assistance_listing_number: '81.086', awarding_agency: 'Department of Energy' },
      ],
    });
    const { service, prisma } = makeService(state);
    await service.listClientOpportunities(TENANT, CLIENT, {});
    const contractCalls = (prisma.$queryRaw as jest.Mock).mock.calls.filter((call: unknown[]) =>
      Array.isArray(call[0]) && (call[0] as unknown[]).join('?').includes('FROM federal_award'),
    );
    expect(contractCalls).toHaveLength(0);
  });

  test('contract-only identities never trigger an assistance-history query', async () => {
    const baseClient = makeState().client as Record<string, unknown>;
    const state = makeState({
      client: { ...baseClient, uei: null },
      mappings: [
        {
          source: 'contracting',
          externalId: 'CONTRACT1234',
          externalName: 'ACME CONTRACTING',
          confirmed: true,
          reviewStatus: 'confirmed',
          rollUpAwards: true,
        },
      ],
      contractHistory: [
        { awarding_agency: 'Department of the Army', awarding_office: 'ACC-APG' },
      ],
    });
    const { service, prisma } = makeService(state);
    await service.listClientOpportunities(TENANT, CLIENT, {});
    const assistanceCalls = (prisma.$queryRaw as jest.Mock).mock.calls.filter((call: unknown[]) =>
      Array.isArray(call[0]) && (call[0] as unknown[]).join('?').includes('FROM federal_assistance_award'),
    );
    expect(assistanceCalls).toHaveLength(0);
  });
});

// ── Money honesty ────────────────────────────────────────────────────────────

describe('unknown money is null, never zero', () => {
  test('a SAM notice reports null estimatedValue with an explicit basis', async () => {
    const { service } = makeService(makeState());
    const res = await service.listClientOpportunities(TENANT, CLIENT, { source: 'sam_gov' });
    const sam = res.opportunities[0]!;
    expect(sam.contractValue?.estimatedValue).toBeNull();
    expect(sam.contractValue?.basis).toBe('not_stated_by_source');
    // A contract has no grant funding block at all — the asymmetry is in the type.
    expect(sam.grantFunding).toBeNull();
  });

  test('a grant with no stated funding reports nulls, not zeros', async () => {
    const { service } = makeService(makeState({ sam: [] }));
    const res = await service.listClientOpportunities(TENANT, CLIENT, { source: 'grants_gov' });
    const grant = res.opportunities[0]!;
    expect(grant.grantFunding?.estimatedProgramFunding).toBeNull();
    expect(grant.grantFunding?.awardCeiling).toBeNull();
    expect(grant.grantFunding?.awardFloor).toBeNull();
    expect(grant.contractValue).toBeNull();
  });

  test('there is no blended amount field anywhere on the response', async () => {
    const { service } = makeService(makeState());
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    const keys = Object.keys(res.counts);
    for (const k of keys) expect(k.toLowerCase()).not.toContain('amount');
    for (const o of res.opportunities) {
      expect(Object.keys(o)).not.toContain('totalAmount');
    }
  });
});

// ── Notice lifecycle ─────────────────────────────────────────────────────────

describe('notice stage and pursuability', () => {
  test('an award notice is not pursuable and is excluded from active counts', async () => {
    const { service } = makeService(
      makeState({ grants: [], sam: [samRow({ noticeType: 'Award Notice' })] }),
    );
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    expect(res.counts.activeContracts).toBe(0);
  });

  test('baseKind exposes what an amended notice STARTED as', async () => {
    const { service } = makeService(makeState({ grants: [] }));
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    expect(res.opportunities[0]?.kind).toBe('solicitation');
    expect(res.opportunities[0]?.baseKind).toBe('presolicitation');
  });

  test('a notice whose response deadline has passed is not active even when SAM still says active', async () => {
    // SAM archives some time AFTER the response date, so `active: true` with a
    // deadline in the past is normal and must not read as an open pursuit.
    const { service } = makeService(
      makeState({
        grants: [],
        sam: [
          samRow({
            active: true,
            responseDeadline: new Date('2020-01-01T00:00:00Z'),
            archiveDate: new Date('2099-01-01T00:00:00Z'),
          }),
        ],
      }),
    );
    const res = await service.listClientOpportunities(TENANT, CLIENT, { activeState: 'all' });
    expect(res.opportunities[0]?.isActive).toBe(false);
  });

  test('a grant with a null close date and an open status IS active', async () => {
    // "continuous" and "TBD" deadlines are real; treating them as expired hides
    // live money.
    const { service } = makeService(
      makeState({ sam: [], grants: [grantRow({ closeDate: null, responseDateDesc: 'Continuous' })] }),
    );
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    expect(res.opportunities[0]?.isActive).toBe(true);
    expect(res.opportunities[0]?.responseDeadlineNote).toBe('Continuous');
  });
});

// ── SAM summary that is a link, not prose ────────────────────────────────────

describe('a SAM description that is a URL is flagged', () => {
  test('summaryIsLink is true for a link and false for prose', async () => {
    const { service } = makeService(
      makeState({
        grants: [],
        sam: [samRow({ description: 'https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=x' })],
      }),
    );
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    expect(res.opportunities[0]?.summaryIsLink).toBe(true);
  });

  test('a link summary is not searched by the text filter', async () => {
    const { service } = makeService(
      makeState({ grants: [], sam: [samRow({ description: 'https://api.sam.gov/x?noticeid=turbofan' })] }),
    );
    // 'noticeid' appears only inside the URL. A hit there is a false positive the
    // user cannot see the reason for.
    const res = await service.listClientOpportunities(TENANT, CLIENT, { q: 'noticeid' });
    expect(res.opportunities).toHaveLength(0);
  });
});

// ── District attribution ─────────────────────────────────────────────────────

describe('a future opportunity never fabricates a district', () => {
  test('no districtKey without an explicit project-site link', async () => {
    const { service } = makeService(makeState());
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    for (const o of res.opportunities) {
      expect(o.districtKey).toBeNull();
      expect(o.districtBasis).toBeNull();
    }
  });

  test('a linked project site is the ONLY thing that sets a districtKey', async () => {
    const state = makeState({
      workflows: [
        {
          id: 'wf-1',
          clientId: CLIENT,
          source: 'sam_gov',
          grantOpportunityId: null,
          samOpportunityId: SAM_ID,
          workflowStatus: 'pursuing',
          ownerUserId: null,
          facilityId: FACILITY,
          notes: null,
          dismissedReason: null,
          outcomeNote: null,
          userCreated: true,
          staleAt: null,
          createdAt: new Date('2026-07-01T00:00:00Z'),
          updatedAt: new Date('2026-07-02T00:00:00Z'),
        },
      ],
    });
    const { service } = makeService(state);
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    const sam = res.opportunities.find((o) => o.source === 'sam_gov')!;
    expect(sam.districtKey).toBe('TX-16');
    expect(sam.districtBasis).toBe('linked_project_site');
  });
});

// ── Workflow ─────────────────────────────────────────────────────────────────

describe('workflow persistence', () => {
  test('saving creates a user_action row with a deterministic snapshot', async () => {
    const state = makeState();
    const { service } = makeService(state);
    const wf = await service.setWorkflowStatus(TENANT, CLIENT, 'sam_gov', SAM_ID, {
      status: 'pursuing',
      actorUserId: USER,
    });
    expect(wf.status).toBe('pursuing');
    const row = state.workflows[0]!;
    expect(row.evidenceSourceType).toBe('user_action');
    expect(row.userCreated).toBe(true);
    expect(row.samOpportunityId).toBe(SAM_ID);
    expect(row.grantOpportunityId).toBeNull();
    expect(typeof row.relevanceScore).toBe('number');
  });

  test('saving twice UPDATES the same row rather than creating a second', async () => {
    const state = makeState();
    const { service } = makeService(state);
    await service.setWorkflowStatus(TENANT, CLIENT, 'sam_gov', SAM_ID, { status: 'saved', actorUserId: USER });
    await service.setWorkflowStatus(TENANT, CLIENT, 'sam_gov', SAM_ID, { status: 'pursuing', actorUserId: USER });
    expect(state.workflows).toHaveLength(1);
    expect(state.workflows[0]!.workflowStatus).toBe('pursuing');
  });

  test('a human action clears a producer stale flag', async () => {
    const state = makeState({
      workflows: [
        {
          id: 'wf-1',
          clientId: CLIENT,
          source: 'sam_gov',
          grantOpportunityId: null,
          samOpportunityId: SAM_ID,
          workflowStatus: 'suggested',
          ownerUserId: null,
          facilityId: null,
          notes: null,
          dismissedReason: null,
          outcomeNote: null,
          userCreated: false,
          staleAt: new Date('2026-07-10T00:00:00Z'),
          createdAt: new Date('2026-07-01T00:00:00Z'),
          updatedAt: new Date('2026-07-01T00:00:00Z'),
        },
      ],
    });
    const { service } = makeService(state);
    await service.setWorkflowStatus(TENANT, CLIENT, 'sam_gov', SAM_ID, { status: 'saved', actorUserId: USER });
    expect(state.workflows[0]!.staleAt).toBeNull();
    expect(state.workflows[0]!.userCreated).toBe(true);
  });

  test('dismiss records the reason; restore clears it and lands on saved, not suggested', async () => {
    const state = makeState();
    const { service } = makeService(state);
    await service.dismiss(TENANT, CLIENT, 'sam_gov', SAM_ID, { actorUserId: USER, reason: 'Wrong NAICS' });
    expect(state.workflows[0]!.workflowStatus).toBe('dismissed');
    expect(state.workflows[0]!.dismissedReason).toBe('Wrong NAICS');

    const restored = await service.restore(TENANT, CLIENT, 'sam_gov', SAM_ID, { actorUserId: USER });
    // 'suggested' means "a machine proposed this and nobody has looked"; a human
    // has now looked twice.
    expect(restored.status).toBe('saved');
    expect(state.workflows[0]!.dismissedReason).toBeNull();
  });

  test('restore refuses a row that is not dismissed', async () => {
    const state = makeState();
    const { service } = makeService(state);
    await service.setWorkflowStatus(TENANT, CLIENT, 'sam_gov', SAM_ID, { status: 'saved', actorUserId: USER });
    await expect(
      service.restore(TENANT, CLIENT, 'sam_gov', SAM_ID, { actorUserId: USER }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('patching a non-existent row is a 404 with actionable wording, not a silent create', async () => {
    const { service } = makeService(makeState());
    await expect(
      service.patchWorkflow(TENANT, CLIENT, 'sam_gov', SAM_ID, { actorUserId: USER, notes: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  test('a workflow row is refused for a source record that does not exist', async () => {
    // The pointer is FK-less, so the database will not catch this: a row pointing
    // at a missing notice would render as a blank card forever.
    const { service } = makeService(makeState({ sam: [] }));
    await expect(
      service.setWorkflowStatus(TENANT, CLIENT, 'sam_gov', SAM_ID, { status: 'saved', actorUserId: USER }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  test('dismissed opportunities are hidden by default and shown on request', async () => {
    const state = makeState();
    const { service } = makeService(state);
    await service.dismiss(TENANT, CLIENT, 'sam_gov', SAM_ID, { actorUserId: USER });

    const hidden = await service.listClientOpportunities(TENANT, CLIENT, { source: 'sam_gov' });
    expect(hidden.opportunities).toHaveLength(0);

    const shown = await service.listClientOpportunities(TENANT, CLIENT, {
      source: 'sam_gov',
      workflowStatus: ['dismissed'],
    });
    expect(shown.opportunities).toHaveLength(1);
  });

  test('a saved opportunity survives a relevance threshold that would exclude it', async () => {
    const state = makeState();
    const { service } = makeService(state);
    await service.setWorkflowStatus(TENANT, CLIENT, 'sam_gov', SAM_ID, { status: 'pursuing', actorUserId: USER });
    const res = await service.listClientOpportunities(TENANT, CLIENT, {
      source: 'sam_gov',
      minRelevance: 100,
    });
    expect(res.opportunities).toHaveLength(1);
    expect(res.opportunities[0]?.workflow?.status).toBe('pursuing');
  });


  test('concurrent first saves recover from the partial unique-index race', async () => {
    const state = makeState();
    const { service, tx } = makeService(state);
    const create = tx.clientFundingOpportunity.create as jest.Mock;
    let first = true;
    create.mockImplementation(async (args: any) => {
      if (first) {
        first = false;
        state.workflows.push({
          id: 'winner',
          clientId: CLIENT,
          source: 'sam_gov',
          grantOpportunityId: null,
          samOpportunityId: SAM_ID,
          workflowStatus: 'suggested',
          ownerUserId: null,
          facilityId: null,
          notes: null,
          dismissedReason: null,
          outcomeNote: null,
          userCreated: false,
          staleAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        throw new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      return { id: 'unexpected', ...args.data, createdAt: new Date(), updatedAt: new Date() };
    });

    const saved = await service.setWorkflowStatus(TENANT, CLIENT, 'sam_gov', SAM_ID, {
      status: 'pursuing',
      actorUserId: USER,
    });
    expect(saved.id).toBe('winner');
    expect(state.workflows).toHaveLength(1);
    expect(state.workflows[0]?.workflowStatus).toBe('pursuing');
  });
});

// ── Tenant safety ────────────────────────────────────────────────────────────

describe('tenant safety', () => {
  test('every tenant-scoped read uses the caller tenant, never another', async () => {
    const { service, tenantsSeen } = makeService(makeState());
    await service.listClientOpportunities(TENANT, CLIENT, {});
    expect(tenantsSeen.length).toBeGreaterThan(0);
    expect(new Set(tenantsSeen)).toEqual(new Set([TENANT]));
    expect(tenantsSeen).not.toContain(OTHER_TENANT);
  });

  test('an owner from another tenant is refused', async () => {
    // A uuid in a request body proves nothing about whose tenant that user is in.
    const state = makeState({ users: [] });
    const { service } = makeService(state);
    await expect(
      service.setWorkflowStatus(TENANT, CLIENT, 'sam_gov', SAM_ID, {
        status: 'saved',
        actorUserId: USER,
        ownerUserId: '00000000-0000-0000-0000-0000000009ff',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test("a facility belonging to another CLIENT in the same tenant is refused", async () => {
    const state = makeState({
      facilities: [
        {
          id: FACILITY,
          name: 'Someone Else Plant',
          state: 'TX',
          congressionalDistrict: '16',
          clientId: '00000000-0000-0000-0000-0000000000ff',
        },
      ],
    });
    const { service } = makeService(state);
    await expect(
      service.setWorkflowStatus(TENANT, CLIENT, 'sam_gov', SAM_ID, {
        status: 'saved',
        actorUserId: USER,
        facilityId: FACILITY,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('an unknown client is a 404 on every entry point', async () => {
    const { service } = makeService(makeState({ client: null }));
    await expect(service.listClientOpportunities(TENANT, CLIENT, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.getClientSummary(TENANT, CLIENT)).rejects.toBeInstanceOf(NotFoundException);
  });

  test('a non-uuid SAM id is a 400, not a driver-level 500', async () => {
    const { service } = makeService(makeState());
    await expect(
      service.getOpportunity(TENANT, 'sam_gov', 'not-a-uuid', null),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ── Pagination ───────────────────────────────────────────────────────────────

describe('pagination is bounded and stable', () => {
  test('page size is clamped to the maximum', async () => {
    const { service } = makeService(makeState());
    const res = await service.listClientOpportunities(TENANT, CLIENT, { pageSize: 5000 });
    expect(res.pageSize).toBeLessThanOrEqual(100);
  });

  test('paging never repeats or skips a row', async () => {
    const sam = Array.from({ length: 7 }, (_, i) =>
      samRow({
        id: `00000000-0000-0000-0000-0000000004${String(i).padStart(2, '0')}`,
        noticeId: `N-${i}`,
        title: `Notice ${i}`,
      }),
    );
    const { service } = makeService(makeState({ grants: [], sam }));
    const p1 = await service.listClientOpportunities(TENANT, CLIENT, { pageSize: 3, page: 1 });
    const p2 = await service.listClientOpportunities(TENANT, CLIENT, { pageSize: 3, page: 2 });
    const p3 = await service.listClientOpportunities(TENANT, CLIENT, { pageSize: 3, page: 3 });
    const ids = [...p1.opportunities, ...p2.opportunities, ...p3.opportunities].map((o) => o.id);
    expect(new Set(ids).size).toBe(7);
    expect(p1.total).toBe(7);
  });
});

// ── Sorting ──────────────────────────────────────────────────────────────────

describe('sort order is workflow → relevance → deadline → source update', () => {
  test('a pursued opportunity outranks a higher-scoring suggestion', async () => {
    const other = '00000000-0000-0000-0000-0000000005aa';
    const state = makeState({
      grants: [],
      sam: [
        // Higher-scoring: exact NAICS.
        samRow({ id: other, noticeId: 'N-HI', title: 'High scorer', naicsCode: '336411' }),
        // Lower-scoring but pursued.
        samRow({ id: SAM_ID, noticeId: 'N-LO', title: 'Pursued', naicsCode: '999999' }),
      ],
      workflows: [
        {
          id: 'wf-1',
          clientId: CLIENT,
          source: 'sam_gov',
          grantOpportunityId: null,
          samOpportunityId: SAM_ID,
          workflowStatus: 'pursuing',
          ownerUserId: null,
          facilityId: null,
          notes: null,
          dismissedReason: null,
          outcomeNote: null,
          userCreated: true,
          staleAt: null,
          createdAt: new Date('2026-07-01T00:00:00Z'),
          updatedAt: new Date('2026-07-02T00:00:00Z'),
        },
      ],
    });
    const { service } = makeService(state);
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    expect(res.opportunities[0]?.title).toBe('Pursued');
  });

  test('a null deadline sorts last, not first', async () => {
    const a = '00000000-0000-0000-0000-0000000006aa';
    const b = '00000000-0000-0000-0000-0000000006bb';
    const { service } = makeService(
      makeState({
        grants: [],
        sam: [
          samRow({ id: a, noticeId: 'N-NULL', title: 'No deadline', responseDeadline: null }),
          samRow({ id: b, noticeId: 'N-SOON', title: 'Soon', responseDeadline: new Date('2026-08-01T00:00:00Z') }),
        ],
      }),
    );
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    expect(res.opportunities.map((o) => o.title)).toEqual(['Soon', 'No deadline']);
  });
});

// ── Honest empty states ──────────────────────────────────────────────────────

describe('an empty list always says WHY', () => {
  test('no source records at all', async () => {
    const { service } = makeService(makeState({ grants: [], sam: [] }));
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    expect(res.emptyReason).toBe('no_source_records');
    expect(res.emptyExplanation).toContain('has been ingested');
  });

  test('a rail that never synced is reported as such, not as an empty market', async () => {
    const { service } = makeService(makeState({ grants: [], sam: [], syncRuns: [] }));
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    expect(res.emptyReason).toBe('source_never_synced');
    expect(res.freshness.every((f) => f.neverSynced)).toBe(true);
  });

  test('a profile with nothing any signal reads is reported as too thin', async () => {
    const state = makeState({
      client: {
        id: CLIENT,
        name: 'Thin Client',
        uei: null,
        cageCode: null,
        naicsCodes: [],
        pscCodes: [],
        applicantTypes: [],
        setAsideCertifications: [],
        sectorTag: null,
        capabilities: [],
        facilities: [],
      },
    });
    const { service } = makeService(state);
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    expect(res.emptyReason).toBe('client_profile_too_thin');
    expect(res.emptyExplanation).toContain('says nothing about the opportunity universe');
  });

  test('records exist but nothing clears the floor', async () => {
    const state = makeState({
      client: {
        id: CLIENT,
        name: 'Some Client',
        uei: null,
        cageCode: null,
        naicsCodes: ['999999'],
        pscCodes: [],
        applicantTypes: [],
        setAsideCertifications: [],
        sectorTag: null,
        capabilities: [],
        facilities: [],
      },
    });
    const { service } = makeService(state);
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    expect(res.opportunities).toHaveLength(0);
    expect(res.emptyReason).toBe('no_match_above_threshold');
  });

  test('missing profile fields are listed so the empty state is actionable', async () => {
    const state = makeState({
      client: {
        id: CLIENT,
        name: 'Thin Client',
        uei: null,
        cageCode: null,
        naicsCodes: [],
        pscCodes: [],
        applicantTypes: [],
        setAsideCertifications: [],
        sectorTag: null,
        capabilities: [],
        facilities: [],
      },
    });
    const { service } = makeService(state);
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    const fields = res.missingProfileFields.map((f) => f.field);
    expect(fields).toContain('naicsCodes');
    expect(fields).toContain('capabilities');
    expect(fields).toContain('contractorIdentity');
    for (const f of res.missingProfileFields) {
      expect(f.impact.length).toBeGreaterThan(20);
    }
  });
});

// ── Source failure is not emptiness ──────────────────────────────────────────

describe('a failed source read is never rendered as an empty list', () => {
  test('a catalog read that throws propagates as an error, not an empty page', async () => {
    const state = makeState();
    const { service, prisma } = makeService(state);
    (prisma.samOpportunity.findMany as jest.Mock).mockImplementation(async () => {
      throw new Error('connection reset');
    });
    await expect(service.listClientOpportunities(TENANT, CLIENT, {})).rejects.toThrow(
      'connection reset',
    );
  });

  test('a freshness read that fails degrades to UNKNOWN, not to never-synced', async () => {
    // Claiming never-synced would be a claim we cannot support; claiming current
    // would be worse.
    const state = makeState({ queryRawThrows: new Error('sync_run unavailable') });
    const { service } = makeService(state);
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    expect(
      res.freshness.every(
        (f) =>
          f.lastSyncedAt === null &&
          f.neverSynced === false &&
          f.countsUnavailable === true &&
          f.recordCount === null &&
          f.activeRecordCount === null &&
          f.lastRunDegraded === null,
      ),
    ).toBe(true);
    // The opportunities still came back — freshness is context, not correctness.
    expect(res.opportunities.length).toBeGreaterThan(0);
  });
});

// ── Freshness ────────────────────────────────────────────────────────────────

describe('source freshness', () => {
  test('both rails are always reported, with verb and label', async () => {
    const { service } = makeService(makeState());
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    expect(res.freshness.map((f) => f.verb).sort()).toEqual([
      'sync-grants',
      'sync-sam-opportunities-all-federal',
    ]);
    for (const f of res.freshness) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.lastSyncedAt).not.toBeNull();
    }
  });

  test('a degraded last run is flagged', async () => {
    const { service } = makeService(
      makeState({
        syncRuns: [
          { source: 'sync-grants', finished_at: new Date(), error_count: 12, status: 'success_with_errors' },
          { source: 'sync-sam-opportunities-all-federal', finished_at: new Date(), error_count: 0, status: 'success' },
        ],
      }),
    );
    const res = await service.listClientOpportunities(TENANT, CLIENT, {});
    expect(res.freshness.find((f) => f.verb === 'sync-grants')?.lastRunDegraded).toBe(true);
  });
});

// ── The always-rendering client card ─────────────────────────────────────────

describe('the client-profile summary always returns a payload', () => {
  test('zero matches still yields counts, gaps, freshness and an explanation', async () => {
    const { service } = makeService(makeState({ grants: [], sam: [] }));
    const summary = await service.getClientSummary(TENANT, CLIENT);
    expect(summary.clientId).toBe(CLIENT);
    expect(summary.counts.activeGrants).toBe(0);
    expect(summary.counts.activeContracts).toBe(0);
    expect(summary.topGrants).toEqual([]);
    expect(summary.topContracts).toEqual([]);
    expect(summary.emptyReason).not.toBeNull();
    expect(summary.emptyExplanation).not.toBeNull();
    expect(summary.freshness).toHaveLength(2);
  });

  test('grants and contracts are counted separately, never blended', async () => {
    const { service } = makeService(makeState());
    const summary = await service.getClientSummary(TENANT, CLIENT);
    expect(Object.keys(summary.counts)).toEqual(
      expect.arrayContaining(['activeGrants', 'activeContracts', 'saved', 'pursuing', 'deadlinesIn30Days']),
    );
  });

  test('saved/pursuing counts come from workflow rows, not from the scanned page', async () => {
    // A saved opportunity whose notice has scrolled out of the bounded scan is
    // still saved; "0 saved" because of a scan cap is wrong in a way the user
    // cannot diagnose.
    const state = makeState({
      grants: [],
      sam: [],
      workflows: [
        {
          id: 'wf-1',
          clientId: CLIENT,
          source: 'grants_gov',
          grantOpportunityId: 'SOME-OTHER-GRANT',
          samOpportunityId: null,
          workflowStatus: 'saved',
          ownerUserId: null,
          facilityId: null,
          notes: null,
          dismissedReason: null,
          outcomeNote: null,
          userCreated: true,
          staleAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    const { service } = makeService(state);
    const summary = await service.getClientSummary(TENANT, CLIENT);
    expect(summary.counts.saved).toBe(1);
  });
});

// ── placeOfPerformance parsing ───────────────────────────────────────────────

describe('parsePlaceOfPerformance never assumes the vendor JSON shape', () => {
  test('nested SAM shape', () => {
    expect(
      parsePlaceOfPerformance({ city: { name: 'El Paso' }, state: { code: 'TX' }, zip: '79906' }),
    ).toEqual({ city: 'El Paso', state: 'TX', zip: '79906', country: null });
  });

  test('flat shape', () => {
    expect(parsePlaceOfPerformance({ city: 'Dayton', state: 'OH' })).toEqual({
      city: 'Dayton',
      state: 'OH',
      zip: null,
      country: null,
    });
  });

  test('an empty object is null, not an object of nulls', () => {
    // "No place of performance" must be distinguishable from "a place of
    // performance with no fields".
    expect(parsePlaceOfPerformance({})).toBeNull();
    expect(parsePlaceOfPerformance(null)).toBeNull();
    expect(parsePlaceOfPerformance([])).toBeNull();
    expect(parsePlaceOfPerformance('TX')).toBeNull();
  });
});
