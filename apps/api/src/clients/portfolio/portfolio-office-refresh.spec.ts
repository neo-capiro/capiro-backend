import { refreshSourcedOffices } from './portfolio-office-refresh.js';
import { geographicSignal, officeFit } from './portfolio-office-signals.js';
import { servingBoundaryVersion } from '../../external/census-geocoder/geographic-boundary.js';
import { PortfolioProposalStore } from './portfolio-proposal.store.js';
import { proposalSchema } from './portfolio.contracts.js';
const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  clerkUserId: 'clerk_fixture',
  tenantSlug: 'fixture',
  role: 'standard_user',
} as const;
const clientId = '30000000-0000-4000-8000-000000000003';
const capabilityId = '40000000-0000-4000-8000-000000000004';
const pressId = '50000000-0000-4000-8000-000000000005';
const now = new Date('2026-11-04T12:00:00Z');
const member = {
  bioguideId: 'fixture-member',
  isCurrent: true,
  congresses: [119],
  chamber: 'house',
  state: 'Virginia',
  district: 1,
};
function fixture() {
  const tx = {
    client: { findFirst: jest.fn().mockResolvedValue({ issueCodes: ['DEF'] }) },
    ldaIssueCode: { findMany: jest.fn().mockResolvedValue([{ name: 'Defense' }]) },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    clientTarget: { findFirst: jest.fn().mockResolvedValue(null) },
    clientCapabilityTerm: {
      findMany: jest.fn().mockResolvedValue([{ kind: 'keyword', value: 'radar', evidence: [] }]),
    },
    clientFacility: { findMany: jest.fn().mockResolvedValue([]) },
    clientOrderedOwner: { findMany: jest.fn().mockResolvedValue([{ userId: ctx.userId }]) },
    tenantMembership: { findFirst: jest.fn().mockResolvedValue({ userId: ctx.userId }) },
    congressMember: { findUnique: jest.fn().mockResolvedValue(member) },
    memberPressItem: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: pressId,
          bioguideId: member.bioguideId,
          title: 'Synthetic radar fixture',
          summary: 'Synthetic radar parsing marker, not an attributed statement.',
          link: 'https://fixture.house.gov/radar',
          publishedAt: new Date('2026-10-01'),
          syncedAt: now,
        },
      ]),
    },
    clientPortfolioProposal: { findMany: jest.fn().mockResolvedValue([]) },
    congressBill: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: '119-hr-1',
          title: 'National Defense Authorization radar testing',
          url: 'https://www.congress.gov/bill/119th-congress/house-bill/1',
          sponsorBioguideId: member.bioguideId,
          subjects: ['radar'],
          peCodes: [],
          lastSyncedAt: now,
        },
      ]),
    },
    congressCommitteeMembership: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const store = {
    propose: jest.fn(async (_tx, _ctx, _id, raw) => proposalSchema.parse(raw)),
    refreshGeneratedOffice: jest.fn(async (_tx, _ctx, _id, raw) => proposalSchema.parse(raw)),
    input: jest.fn(),
  };
  const ranked = [{ memberId: member.bioguideId, committee: null }];
  return { tx, store, ranked };
}
describe('sourced office refresh', () => {
  beforeAll(() => jest.useFakeTimers().setSystemTime(now));
  afterAll(() => jest.useRealTimers());
  it('stages a canonical dated statement and sourced sponsor/defense fit with actual owner', async () => {
    const f = fixture();
    const result = await refreshSourcedOffices(
      f.tx as never,
      f.store as never,
      ctx,
      clientId,
      f.ranked as never,
      capabilityId,
    );
    expect(result.statementProposals[0]?.payload).toEqual(
      expect.objectContaining({
        officeTerm: 'congress:119',
        pressItemId: pressId,
        statementDate: '2026-10-01T00:00:00.000Z',
      }),
    );
    expect(result.proposals[0]?.payload).toEqual(
      expect.objectContaining({
        officeTerm: 'congress:119',
        fitRating: 'moderate',
        stance: 'unknown',
        suggestedOwnerUserId: ctx.userId,
      }),
    );
    expect(result.proposals[0]?.evidence[0]?.url).toContain('congress.gov');
  });
  it('uses the canonical client issue label for whole-client fit without requiring a capability', async () => {
    const f = fixture();
    f.tx.clientCapabilityTerm.findMany.mockResolvedValue([]);
    const result = await refreshSourcedOffices(
      f.tx as never,
      f.store as never,
      ctx,
      clientId,
      f.ranked as never,
    );
    expect(f.tx.ldaIssueCode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: { in: ['DEF'] } } }),
    );
    expect(result.proposals).toHaveLength(1);
  });
  it('rejects nonofficial press and unrelated bills', async () => {
    const f = fixture();
    f.tx.memberPressItem.findMany.mockResolvedValue([
      {
        id: pressId,
        bioguideId: member.bioguideId,
        title: 'Radar',
        summary: 'Radar',
        link: 'https://example.com/radar',
        publishedAt: now,
        syncedAt: now,
      },
    ]);
    f.tx.congressBill.findMany.mockResolvedValue([]);
    const result = await refreshSourcedOffices(
      f.tx as never,
      f.store as never,
      ctx,
      clientId,
      f.ranked as never,
      capabilityId,
    );
    expect(result.proposals).toHaveLength(0);
    expect(result.statementProposals).toHaveLength(0);
    expect(result.gaps).not.toHaveLength(0);
  });
  it('requires current verified precise geography', () => {
    const facility = {
      name: 'Synthetic facility',
      country: 'US',
      state: 'VA',
      siteStatus: 'operating',
      siteVerificationStatus: 'verified',
      geographicResolution: {
        status: 'resolved',
        requiresReview: false,
        source: 'census_tigerweb',
        version: servingBoundaryVersion(),
        resolvedAt: now.toISOString(),
        districts: [{ chamber: 'house', code: '01', congress: 119, stateFips: '51' }],
      },
    };
    expect(geographicSignal(member as never, facility as never)?.evidence.sourceType).toBe(
      'official',
    );
    for (const delta of [
      { siteVerificationStatus: 'unverified' },
      { siteStatus: 'unknown' },
      { geographicResolution: { ...facility.geographicResolution, requiresReview: true } },
      {
        geographicResolution: {
          ...facility.geographicResolution,
          version: { ...servingBoundaryVersion(), congress: 118 },
        },
      },
    ])
      expect(geographicSignal(member as never, { ...facility, ...delta } as never)).toBeNull();
    expect(officeFit([{ kind: 'sponsor' }, { kind: 'sponsor' }] as never)).toBe('limited');
  });
  it.each([
    ['Virginia', 'VA', '51', '01', 'house', 1],
    ['Virginia', 'VA', '51', '01', 'senate', null],
    ['Wyoming', 'WY', '56', '00', 'house', null],
    ['Wyoming', 'WY', '56', '00', 'house', 0],
    ['District of Columbia', 'DC', '11', '98', 'house', null],
  ] as const)('matches canonical %s state and district %s/%s/%s for %s/%s',
    (stateName, state, stateFips, code, chamber, district) => {
      const office = { ...member, state: stateName, chamber, district };
      const facility = {
        name: 'Synthetic constituency fixture', country: 'US', state,
        siteStatus: 'operating', siteVerificationStatus: 'verified',
        geographicResolution: {
          status: 'resolved', requiresReview: false, source: 'census_tigerweb',
          version: servingBoundaryVersion(), resolvedAt: now.toISOString(),
          districts: [{ chamber: 'house', code, congress: 119, stateFips }],
        },
      };
      expect(geographicSignal(office as never, facility as never)?.kind).toBe('geography');
      expect(geographicSignal({ ...office, state: 'Maryland' } as never, facility as never)).toBeNull();
      expect(geographicSignal(office as never, {
        ...facility,
        geographicResolution: { ...facility.geographicResolution,
          districts: [{ chamber: 'house', code, congress: 119, stateFips: '24' }] },
      } as never)).toBeNull();
      if (chamber === 'house')
        expect(geographicSignal({ ...office, district: 7 } as never, facility as never)).toBeNull();
      expect(geographicSignal(office as never, {
        ...facility, geographicResolution: { ...facility.geographicResolution, boundaryAdjacent: true },
      } as never)).toBeNull();
    });
});
describe('automatic proposals preserve human review', () => {
  const raw = {
    kind: 'office_recommendation',
    payload: {
      memberId: 'fixture-member',
      sourceDirectory: 'congress',
      officeTerm: 'congress:119',
      rationale: 'Sourced rationale',
      entryPoint: 'Official office',
      whyNot: 'No support established',
      stance: 'interested',
    },
    evidence: [
      {
        url: 'https://example.gov/source',
        title: 'Fixture',
        excerpt: 'Evidence fixture',
        observedAt: '2026-01-01T00:00:00Z',
        sourceType: 'official',
      },
    ],
  };
  function storeFixture(status: string, reviewHistory: unknown[]) {
    const row = {
      id: pressId,
      tenantId: ctx.tenantId,
      clientId,
      kind: raw.kind,
      status,
      version: 2,
      payload: raw.payload,
      evidence: raw.evidence,
      reviewHistory,
    };
    const tx = {
      clientPortfolioProposal: {
        findUnique: jest.fn().mockResolvedValue(row),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({ ...row, version: 3 }),
      },
    };
    const store = new PortfolioProposalStore({} as never);
    jest.spyOn(store, 'validateEvidence').mockResolvedValue(undefined);
    jest.spyOn(store, 'publicProposal').mockResolvedValue(row as never);
    return { tx, store };
  }
  it.each(['approved', 'rejected'])('never overwrites %s after new evidence', async (status) => {
    const f = storeFixture(status, [{ action: 'source_refreshed', sourceRevision: 'old' }]);
    await f.store.refreshGeneratedOffice(f.tx as never, ctx, clientId, raw, 'new');
    expect(f.tx.clientPortfolioProposal.updateMany).not.toHaveBeenCalled();
  });
  it('preserves person edits and legacy proposals', async () => {
    for (const events of [[{ action: 'edited' }], [{ action: 'proposed' }], []]) {
      const f = storeFixture('proposed', events);
      await f.store.refreshGeneratedOffice(f.tx as never, ctx, clientId, raw, 'new');
      expect(f.tx.clientPortfolioProposal.updateMany).not.toHaveBeenCalled();
    }
  });
  it('refreshes an untouched draft with a version compare and retained history', async () => {
    const f = storeFixture('proposed', [{ action: 'source_refreshed', sourceRevision: 'old' }]);
    await f.store.refreshGeneratedOffice(f.tx as never, ctx, clientId, raw, 'new');
    expect(f.tx.clientPortfolioProposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'proposed', version: 2 }),
        data: expect.objectContaining({
          version: { increment: 1 },
          reviewHistory: expect.arrayContaining([
            { action: 'source_refreshed', sourceRevision: 'old' },
          ]),
        }),
      }),
    );
  });
});
