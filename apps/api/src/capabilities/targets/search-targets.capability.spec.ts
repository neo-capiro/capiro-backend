import { SearchTargetsCapability } from './search-targets.capability.js';

const ctx = {
  actorUserId: '00000000-0000-4000-8000-000000000001',
  clerkUserId: 'user_test',
  tenantId: '00000000-0000-4000-8000-000000000002',
  tenantSlug: 'test',
  role: 'standard_user',
  clientScope: null,
  impersonation: null,
  requestId: 'request-1',
  surface: 'outreach' as const,
};

function harness() {
  const tx = {
    clientPerson: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    engagementContact: { findMany: jest.fn(async () => []) },
    clientTargetRecommendation: { findUnique: jest.fn(async () => null) },
  };
  const prisma = {
    stateLegislator: { findMany: jest.fn(async () => []) },
    withTenantUser: jest.fn(async (_tenantId: string, _userId: string, fn: Function) => fn(tx)),
  };
  const directory = {
    getContacts: jest.fn(async () => ({
      contacts: [
        {
          id: 'member-1',
          memberName: 'Rep. Example',
          fullName: 'Representative Example',
          title: 'Representative',
          office: 'U.S. House',
          chamber: 'House',
          state: 'VA',
          district: '7',
          committees: ['House Armed Services Committee'],
          focusAreas: ['Defense'],
          leadershipPositions: [],
          outgoingStatus: null,
          lastTouchpoint: '2026-07-01T00:00:00.000Z',
          email: null,
          phone: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
      sourceId: 'snapshot-1',
    })),
    getStaffers: jest.fn(async () => ({ staffers: [], total: 0, page: 1, pageSize: 25 })),
  };
  const authorization = { authorizeClient: jest.fn(async () => ({ id: 'client' })) };
  return {
    capability: new SearchTargetsCapability(prisma as never, directory as never, authorization as never),
    prisma,
    tx,
    directory,
    authorization,
  };
}

const criteria: {
  governmentLevels: Array<'state' | 'agency' | 'federal' | 'local' | 'mixed'>;
  chambers: Array<'house' | 'senate' | 'state_house' | 'state_senate'>;
  committees: string[];
  agencies: string[];
  states: string[];
  relationshipPreference: 'any' | 'mixed' | 'new';
  includeStaff: boolean;
  includePrincipals: boolean;
} = {
  governmentLevels: ['federal'],
  chambers: ['house'],
  committees: ['Armed Services'],
  agencies: [],
  states: ['VA'],
  relationshipPreference: 'any',
  includeStaff: true,
  includePrincipals: true,
};

describe('SearchTargetsCapability', () => {
  it('returns explainable public Directory targets for a no-client campaign', async () => {
    const h = harness();
    const result = await h.capability.execute(ctx, {
      query: null,
      clientId: null,
      sources: ['directory_member'],
      criteria,
      limit: 20,
      excludeTargetKeys: [],
      rejectedRecommendationRefs: [],
    });
    expect(result.data.candidates).toHaveLength(1);
    expect(result.data.candidates[0]).toMatchObject({
      targetKey: 'directory_member:member-1',
      locator: { source: 'directory_member', id: 'member-1' },
      roleStatus: 'current',
      signals: expect.arrayContaining([
        expect.objectContaining({ code: 'committee_match' }),
        expect.objectContaining({ code: 'current_role' }),
      ]),
    });
    expect(result.scope).toEqual({ tenantId: ctx.tenantId, clientId: null });
    expect(h.authorization.authorizeClient).not.toHaveBeenCalled();
  });

  it('authorizes client-scoped contact sources before querying them', async () => {
    const h = harness();
    const clientId = '00000000-0000-4000-8000-000000000010';
    h.tx.clientPerson.findMany.mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000011',
        name: 'Client Contact',
        title: 'General Counsel',
        role: 'decision maker',
        email: 'contact@example.test',
        lastContact: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);
    const result = await h.capability.execute(ctx, {
      query: null,
      clientId,
      sources: ['client_person'],
      criteria: { ...criteria, governmentLevels: [] },
      limit: 20,
      excludeTargetKeys: [],
      rejectedRecommendationRefs: [],
    });
    expect(h.authorization.authorizeClient).toHaveBeenCalledWith(ctx, clientId);
    expect(result.data.candidates[0]).toMatchObject({
      locator: {
        source: 'client_person',
        id: '00000000-0000-4000-8000-000000000011',
        clientId,
      },
      clientId,
    });
  });

  it('excludes already selected targets and exact rejected recommendation refs', async () => {
    const h = harness();
    const first = await h.capability.execute(ctx, {
      query: null,
      clientId: null,
      sources: ['directory_member'],
      criteria,
      limit: 20,
      excludeTargetKeys: [],
      rejectedRecommendationRefs: [],
    });
    const candidate = first.data.candidates[0]!;
    const excluded = await h.capability.execute(ctx, {
      query: null,
      clientId: null,
      sources: ['directory_member'],
      criteria,
      limit: 20,
      excludeTargetKeys: [candidate.targetKey],
      rejectedRecommendationRefs: [],
    });
    expect(excluded.data.candidates).toEqual([]);
    const rejected = await h.capability.execute(ctx, {
      query: null,
      clientId: null,
      sources: ['directory_member'],
      criteria,
      limit: 20,
      excludeTargetKeys: [],
      rejectedRecommendationRefs: [candidate.recommendationRef],
    });
    expect(rejected.data.candidates).toEqual([]);
  });

  it('queries only active state legislators', async () => {
    const h = harness();
    await h.capability.execute(ctx, {
      query: null,
      clientId: null,
      sources: ['state_legislator'],
      criteria: { ...criteria, governmentLevels: ['state'], chambers: ['state_house'] },
      limit: 20,
      excludeTargetKeys: [],
      rejectedRecommendationRefs: [],
    });
    expect(h.prisma.stateLegislator.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ active: true }) }),
    );
  });

  it('reports unsupported agency/local criteria rather than inventing targets', async () => {
    const h = harness();
    const result = await h.capability.execute(ctx, {
      query: null,
      clientId: null,
      sources: [],
      criteria: {
        ...criteria,
        governmentLevels: ['agency', 'local'],
        agencies: ['Department of Defense'],
      },
      limit: 20,
      excludeTargetKeys: [],
      rejectedRecommendationRefs: [],
    });
    expect(result.freshness.degraded).toBe(true);
    expect(result.data.unsupportedCriteria).toHaveLength(3);
  });
});
