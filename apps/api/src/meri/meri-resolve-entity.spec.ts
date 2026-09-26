import { MeriToolsService } from './meri-tools.service.js';

/**
 * SC2.2 contract for resolve_entity: canonical ids, external ids, and bill
 * designations resolve to registry rows; zero matches returns an EXPLICIT
 * not-found note (never a fabricated identifier). Prototype-call with a fake
 * prisma — the impl has no other dependencies.
 */

const MEMBER = {
  bioguideId: 'V000128',
  fullName: 'Van Hollen, Chris',
  party: 'Democratic',
  state: 'Maryland',
  district: null,
  chamber: 'senate',
  lisId: 'S390',
  isCurrent: true,
  updateDate: new Date('2026-04-30'),
  lastSyncedAt: new Date('2026-05-01'),
};

const COMMITTEE = {
  systemCode: 'hsag00',
  name: 'House Committee on Agriculture',
  chamber: 'house',
  parentSystemCode: null,
  isCurrent: true,
  url: 'https://www.congress.gov/committee/house-agriculture/hsag00',
  urlSource: 'congress_gov',
  urlVerifiedAt: new Date('2026-05-02'),
  lastSyncedAt: new Date('2026-05-02'),
};

const BILL = {
  id: '119-hr-8800',
  title: 'National Defense Authorization Act FY2027',
  congress: 119,
  sponsorName: 'Rogers, Mike',
  sponsorBioguideId: 'R000575',
  latestActionText: 'Referred to the Committee on Armed Services.',
  latestActionDate: new Date('2026-06-01'),
  url: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
  updateDate: new Date('2026-06-01T15:00:00Z'),
  lastSyncedAt: new Date('2026-06-02'),
};

type FakeTx = {
  stateBill: {
    findUnique: (args: { where: { id: string } }) => Promise<unknown>;
    findMany: (args: unknown) => Promise<unknown[]>;
  };
  stateLegislator: {
    findUnique: (args: { where: { id: string } }) => Promise<unknown>;
    findMany: (args: unknown) => Promise<unknown[]>;
  };
};
type FakePrisma = {
  congressMember: {
    findUnique: (args: { where: { bioguideId: string } }) => Promise<unknown>;
    findMany: (args: unknown) => Promise<unknown[]>;
  };
  congressCommittee: {
    findUnique: (args: { where: { systemCode: string } }) => Promise<unknown>;
    findMany: (args: unknown) => Promise<unknown[]>;
  };
  congressBill: { findUnique: (args: { where: { id: string } }) => Promise<unknown> };
  entityCrosswalk: { findMany: (args: unknown) => Promise<unknown[]> };
  // State Legislation Platform (S6.2) — resolve_entity's state_bill/
  // state_legislator tiers always run (they're gated on `!type ||
  // type === '...'`, not on whether an earlier tier already matched), so
  // EVERY test — including federal-only ones — must provide these.
  withSystem: <T>(fn: (tx: FakeTx) => Promise<T> | T) => Promise<T> | T;
};

function emptyPrisma(): FakePrisma {
  const tx: FakeTx = {
    stateBill: { findUnique: async () => null, findMany: async () => [] },
    stateLegislator: { findUnique: async () => null, findMany: async () => [] },
  };
  return {
    congressMember: { findUnique: async () => null, findMany: async () => [] },
    congressCommittee: { findUnique: async () => null, findMany: async () => [] },
    congressBill: { findUnique: async () => null },
    entityCrosswalk: { findMany: async () => [] },
    withSystem: (fn) => fn(tx),
  };
}

const invoke = (prisma: FakePrisma, input: Record<string, unknown>) => {
  const service = Object.create(MeriToolsService.prototype) as {
    prisma: FakePrisma;
    resolveEntity(i: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  service.prisma = prisma;
  return service.resolveEntity(input);
};

describe('resolve_entity (SC2.2)', () => {
  it('resolves a bioguide id directly (case-normalized)', async () => {
    const prisma = emptyPrisma();
    prisma.congressMember.findUnique = async ({ where }) =>
      where.bioguideId === 'V000128' ? MEMBER : null;
    const out = (await invoke(prisma, { query: 'v000128' })) as {
      matchesFound: number;
      matches: Array<{ canonicalId: string; matchedBy: string; entityType: string }>;
    };
    expect(out.matchesFound).toBe(1);
    expect(out.matches[0]).toMatchObject({
      entityType: 'member',
      canonicalId: 'V000128',
      matchedBy: 'bioguide-id',
      sourceRef: {
        namespace: 'congress_member',
        recordId: 'V000128',
        sourceUrl: null,
        eventDate: null,
        sourceUpdatedAt: MEMBER.updateDate,
        sourceCheckedAt: null,
        syncedAt: new Date('2026-05-01'),
      },
    });
  });

  it('resolves a committee systemCode directly', async () => {
    const prisma = emptyPrisma();
    prisma.congressCommittee.findUnique = async ({ where }) =>
      where.systemCode === 'hsag00' ? COMMITTEE : null;
    const out = (await invoke(prisma, { query: 'HSAG00' })) as {
      matches: Array<{ canonicalId: string; matchedBy: string }>;
    };
    expect(out.matches[0]).toMatchObject({
      canonicalId: 'hsag00',
      matchedBy: 'system-code',
      sourceRef: {
        namespace: 'congress_committee',
        recordId: 'hsag00',
        sourceUrl: COMMITTEE.url,
        sourceCheckedAt: COMMITTEE.urlVerifiedAt,
        syncedAt: COMMITTEE.lastSyncedAt,
        urlAuthority: 'congress_gov',
      },
    });
  });

  it('resolves a human bill designation ("H.R. 8800") to the canonical bill id', async () => {
    const prisma = emptyPrisma();
    prisma.congressBill.findUnique = async ({ where }) =>
      where.id === '119-hr-8800' ? BILL : null;
    const out = (await invoke(prisma, { query: 'H.R. 8800 (119th)' })) as {
      matches: Array<{ canonicalId: string; matchedBy: string; sponsorBioguideId: string }>;
    };
    expect(out.matches[0]).toMatchObject({
      canonicalId: '119-hr-8800',
      matchedBy: 'bill-id',
      sponsorBioguideId: 'R000575',
      sourceRef: {
        namespace: 'congress_bill',
        recordId: '119-hr-8800',
        sourceUrl: BILL.url,
        eventDate: BILL.latestActionDate,
        sourceUpdatedAt: BILL.updateDate,
        syncedAt: BILL.lastSyncedAt,
      },
    });
  });

  it('does not assume the current Congress for an unqualified federal designation', async () => {
    const prisma = emptyPrisma();
    const findUnique = jest.fn(async () => BILL);
    prisma.congressBill.findUnique = findUnique;
    const out = (await invoke(prisma, { query: 'H.R. 8800', type: 'bill' })) as {
      matchesFound: number;
      resolution: string;
      note: string;
    };
    expect(out.matchesFound).toBe(0);
    expect(out.resolution).toBe('needs_context');
    expect(out.note).toMatch(/Congress number/i);
    expect(findUnique).not.toHaveBeenCalled();

    const qualified = (await invoke(prisma, {
      query: 'H.R. 8800',
      type: 'bill',
      congress: 119,
    })) as { matches: Array<{ canonicalId: string }> };
    expect(qualified.matches[0]?.canonicalId).toBe('119-hr-8800');
  });

  it('rejects conflicting Congress context on a canonical bill id', async () => {
    const out = (await invoke(emptyPrisma(), {
      query: '119-hr-8800',
      congress: 118,
    })) as { resolution: string; matchesFound: number; note: string };
    expect(out.resolution).toBe('invalid_context');
    expect(out.matchesFound).toBe(0);
    expect(out.note).toMatch(/does not belong to Congress 118/i);
  });

  it('falls back to the entity crosswalk for external ids (LIS)', async () => {
    const prisma = emptyPrisma();
    prisma.entityCrosswalk.findMany = async () => [
      {
        id: 'crosswalk-1',
        idType: 'lis',
        idValue: 'S390',
        entityType: 'member',
        entityKey: 'V000128',
        source: 'sync-congress-members',
        confidence: 1,
        lastSyncedAt: new Date('2026-05-03'),
      },
    ];
    prisma.congressMember.findUnique = async ({ where }) =>
      where.bioguideId === 'V000128' ? MEMBER : null;
    const out = (await invoke(prisma, { query: 'S390' })) as {
      matches: Array<{ canonicalId: string; matchedBy: string }>;
    };
    expect(out.matches[0]).toMatchObject({
      canonicalId: 'V000128',
      matchedBy: 'lis-crosswalk',
      sourceRef: {
        namespace: 'congress_member',
        recordId: 'V000128',
        crosswalk: {
          namespace: 'entity_crosswalk',
          recordId: 'crosswalk-1',
          idType: 'lis',
          idValue: 'S390',
          source: 'sync-congress-members',
          confidence: 1,
          syncedAt: new Date('2026-05-03'),
        },
      },
    });
  });

  it('falls back to name search, current members first', async () => {
    const prisma = emptyPrisma();
    prisma.congressMember.findMany = async () => [MEMBER];
    const out = (await invoke(prisma, { query: 'Van Hollen' })) as {
      matches: Array<{ matchedBy: string }>;
    };
    expect(out.matches[0]).toMatchObject({ matchedBy: 'name-search' });
  });

  it('flags an ambiguous name even when the requested display limit is one', async () => {
    const prisma = emptyPrisma();
    const findMany = jest.fn(async () => [MEMBER, { ...MEMBER, bioguideId: 'V000129' }]);
    prisma.congressMember.findMany = findMany;
    const out = (await invoke(prisma, {
      query: 'Van Hollen', type: 'member', limit: 1,
    })) as {
      resolution: string;
      matchesFound: number;
      candidateCountAtLeast: number;
      note: string;
    };
    expect(out.resolution).toBe('ambiguous');
    expect(out.matchesFound).toBe(1);
    expect(out.candidateCountAtLeast).toBe(2);
    expect(out.note).toMatch(/do not choose the first result/i);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
  });

  it('says NO ENTITY explicitly (never fabricates) when nothing matches', async () => {
    const out = (await invoke(emptyPrisma(), { query: 'Senator Nonexistent' })) as {
      matchesFound: number;
      note: string;
    };
    expect(out.matchesFound).toBe(0);
    expect(out.note).toContain('No canonical entity matched');
    expect(out.note).toContain('do NOT fabricate');
  });
});

describe('resolve_entity — state_bill / state_legislator (State Legislation Platform S6.2)', () => {
  const STATE_BILL = {
    id: 'tx-2025-hb1234',
    title: 'Relating to a study on state legislative data.',
    state: 'TX',
    sessionKey: '2025',
    sponsorName: 'Rep. Jane Doe',
    latestActionText: 'Referred to Committee on State Affairs',
    latestActionDate: new Date('2025-03-15'),
    stateUrl: 'https://capitol.texas.gov/BillLookup/History.aspx?LegSess=89R&Bill=HB1234',
    url: 'https://legiscan.com/TX/bill/HB1234/2025',
    sourceCheckedAt: new Date('2025-03-16T10:00:00Z'),
    syncedAt: new Date('2025-03-16'),
  };
  const STATE_LEGISLATOR = {
    id: 'ocd-person/abc',
    name: 'Rep. Jane Doe',
    state: 'TX',
    chamber: 'lower',
    district: '12',
    party: 'D',
    active: true,
    url: 'https://openstates.org/person/abc',
    syncedAt: new Date('2025-04-01'),
  };

  it('resolves a canonical state bill key directly ("tx-2025-hb1234")', async () => {
    const prisma = emptyPrisma();
    prisma.withSystem = (fn) =>
      fn({
        stateBill: {
          findUnique: async ({ where }) => (where.id === 'tx-2025-hb1234' ? STATE_BILL : null),
          findMany: async () => [{ id: 'tx-2025-hb1234' }],
        },
        stateLegislator: { findUnique: async () => null, findMany: async () => [] },
      });
    const out = (await invoke(prisma, { query: 'tx-2025-hb1234' })) as {
      matches: Array<{ entityType: string; canonicalId: string; matchedBy: string }>;
    };
    expect(out.matches[0]).toMatchObject({
      entityType: 'state_bill',
      canonicalId: 'tx-2025-hb1234',
      matchedBy: 'state-bill-key',
      sourceRef: {
        namespace: 'state_bill',
        recordId: 'tx-2025-hb1234',
        sourceUrl: STATE_BILL.stateUrl,
        eventDate: STATE_BILL.latestActionDate,
        sourceCheckedAt: STATE_BILL.sourceCheckedAt,
        syncedAt: STATE_BILL.syncedAt,
      },
    });
  });

  it('resolves a state bill designation ("TX HB 1234")', async () => {
    const prisma = emptyPrisma();
    prisma.withSystem = (fn) =>
      fn({
        stateBill: {
          findUnique: async ({ where }) => (where.id === 'tx-2025-hb1234' ? STATE_BILL : null),
          findMany: async () => [{ id: 'tx-2025-hb1234' }],
        },
        stateLegislator: { findUnique: async () => null, findMany: async () => [] },
      });
    const out = (await invoke(prisma, { query: 'TX HB 1234' })) as {
      matches: Array<{ entityType: string; canonicalId: string }>;
    };
    expect(out.matches[0]).toMatchObject({
      entityType: 'state_bill',
      canonicalId: 'tx-2025-hb1234',
    });
  });

  it('requires session disambiguation for a designation reused in two sessions', async () => {
    const prisma = emptyPrisma();
    const findUnique = jest.fn(async ({ where }: { where: { id: string } }) =>
      where.id === STATE_BILL.id ? STATE_BILL : null,
    );
    const findMany = jest.fn(async (args: unknown) => {
      const where = (args as { where: { sessionKey?: string } }).where;
      return where.sessionKey === '2025'
        ? [{ id: 'tx-2025-hb1234' }]
        : [{ id: 'tx-2027-hb1234' }, { id: 'tx-2025-hb1234' }];
    });
    prisma.withSystem = (fn) => fn({
      stateBill: { findUnique, findMany },
      stateLegislator: { findUnique: async () => null, findMany: async () => [] },
    });

    const ambiguous = (await invoke(prisma, {
      query: 'TX HB 1234',
      type: 'state_bill',
    })) as {
      matchesFound: number;
      resolution: string;
      candidateIds: string[];
      note: string;
    };
    expect(ambiguous.matchesFound).toBe(0);
    expect(ambiguous.resolution).toBe('ambiguous');
    expect(ambiguous.candidateIds).toEqual(['tx-2027-hb1234', 'tx-2025-hb1234']);
    expect(ambiguous.note).toMatch(/Specify sessionKey/i);
    expect(findUnique).not.toHaveBeenCalled();

    const qualified = (await invoke(prisma, {
      query: 'TX HB 1234',
      type: 'state_bill',
      state: 'TX',
      sessionKey: '2025',
    })) as { matches: Array<{ canonicalId: string; matchedBy: string }> };
    expect(qualified.matches[0]).toMatchObject({
      canonicalId: 'tx-2025-hb1234',
      matchedBy: 'state-bill-designation',
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ state: 'TX', sessionKey: '2025' }),
    }));
  });

  it('rejects conflicting state or session context for canonical state bill keys', async () => {
    const wrongState = (await invoke(emptyPrisma(), {
      query: 'tx-2025-hb1234',
      type: 'state_bill',
      state: 'CA',
    })) as { resolution: string; note: string };
    expect(wrongState.resolution).toBe('invalid_context');
    expect(wrongState.note).toMatch(/not in state CA/);

    const wrongSession = (await invoke(emptyPrisma(), {
      query: 'tx-2025-hb1234',
      type: 'state_bill',
      sessionKey: '2027',
    })) as { resolution: string; note: string };
    expect(wrongSession.resolution).toBe('invalid_context');
    expect(wrongSession.note).toMatch(/not in session 2027/);
  });

  it('resolves a state legislator via entity_crosswalk (LegiScan/OpenStates external id)', async () => {
    const prisma = emptyPrisma();
    prisma.entityCrosswalk.findMany = async () => [
      {
        idType: 'legiscan_people',
        idValue: '12345',
        entityType: 'state_legislator',
        entityKey: 'ocd-person/abc',
        source: 'sync-openstates',
        confidence: 0.98,
        lastSyncedAt: new Date('2025-04-02'),
      },
    ];
    prisma.withSystem = (fn) =>
      fn({
        stateBill: { findUnique: async () => null, findMany: async () => [] },
        stateLegislator: {
          findUnique: async ({ where }) =>
            where.id === 'ocd-person/abc' ? STATE_LEGISLATOR : null,
          findMany: async () => [],
        },
      });
    const out = (await invoke(prisma, { query: '12345' })) as {
      matches: Array<{ entityType: string; canonicalId: string; matchedBy: string }>;
    };
    expect(out.matches[0]).toMatchObject({
      entityType: 'state_legislator',
      canonicalId: 'ocd-person/abc',
      matchedBy: 'legiscan_people-crosswalk',
      sourceRef: {
        namespace: 'state_legislator',
        recordId: 'ocd-person/abc',
        sourceUrl: STATE_LEGISLATOR.url,
        syncedAt: STATE_LEGISLATOR.syncedAt,
        crosswalk: {
          namespace: 'entity_crosswalk',
          idType: 'legiscan_people',
          idValue: '12345',
          source: 'sync-openstates',
          confidence: 0.98,
          syncedAt: new Date('2025-04-02'),
        },
      },
    });
  });

  it('resolves a canonical OpenStates person id directly with state-qualified provenance', async () => {
    const prisma = emptyPrisma();
    prisma.withSystem = (fn) => fn({
      stateBill: { findUnique: async () => null, findMany: async () => [] },
      stateLegislator: {
        findUnique: async ({ where }) => where.id === STATE_LEGISLATOR.id ? STATE_LEGISLATOR : null,
        findMany: async () => [],
      },
    });
    const out = (await invoke(prisma, {
      query: 'ocd-person/abc', type: 'state_legislator', jurisdiction: 'state', state: 'TX',
    })) as { matches: Array<{ canonicalId: string; sourceRef: { namespace: string; sourceUrl: string } }> };
    expect(out.matches[0]).toMatchObject({
      canonicalId: 'ocd-person/abc',
      matchedBy: 'openstates-person-id',
      sourceRef: {
        namespace: 'state_legislator',
        recordId: 'ocd-person/abc',
        sourceUrl: STATE_LEGISLATOR.url,
        syncedAt: STATE_LEGISLATOR.syncedAt,
      },
    });
  });

  it('falls back to state legislator name search when nothing else matches', async () => {
    const prisma = emptyPrisma();
    prisma.withSystem = (fn) =>
      fn({
        stateBill: { findUnique: async () => null, findMany: async () => [] },
        stateLegislator: { findUnique: async () => null, findMany: async () => [STATE_LEGISLATOR] },
      });
    const out = (await invoke(prisma, { query: 'Jane Doe' })) as {
      matches: Array<{ entityType: string; matchedBy: string }>;
    };
    expect(out.matches[0]).toMatchObject({
      entityType: 'state_legislator',
      matchedBy: 'name-search',
    });
  });

  it('a `type` filter of "state_bill" never returns a member/committee match', async () => {
    const prisma = emptyPrisma();
    prisma.congressMember.findMany = async () => [MEMBER]; // would match if type filter were ignored
    const out = (await invoke(prisma, { query: 'Van Hollen', type: 'state_bill' })) as {
      matchesFound: number;
    };
    expect(out.matchesFound).toBe(0);
  });

  it('does not leak a crosswalk match from another state or session', async () => {
    const prisma = emptyPrisma();
    prisma.entityCrosswalk.findMany = async () => [{
      idType: 'legiscan_bill',
      idValue: '12345',
      entityType: 'state_bill',
      entityKey: 'tx-2025-hb1234',
    }];
    prisma.withSystem = (fn) => fn({
      stateBill: { findUnique: async () => STATE_BILL, findMany: async () => [] },
      stateLegislator: { findUnique: async () => null, findMany: async () => [] },
    });
    const wrongState = (await invoke(prisma, {
      query: '12345', type: 'state_bill', jurisdiction: 'state', state: 'CA',
    })) as { matchesFound: number };
    const wrongSession = (await invoke(prisma, {
      query: '12345', type: 'state_bill', jurisdiction: 'state', state: 'TX', sessionKey: '2027',
    })) as { matchesFound: number };
    expect(wrongState.matchesFound).toBe(0);
    expect(wrongSession.matchesFound).toBe(0);
  });
});
