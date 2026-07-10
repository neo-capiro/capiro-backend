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
};

const COMMITTEE = {
  systemCode: 'hsag00',
  name: 'House Committee on Agriculture',
  chamber: 'house',
  parentSystemCode: null,
  isCurrent: true,
};

const BILL = {
  id: '119-hr-8800',
  title: 'National Defense Authorization Act FY2027',
  congress: 119,
  sponsorName: 'Rogers, Mike',
  sponsorBioguideId: 'R000575',
  latestActionText: 'Referred to the Committee on Armed Services.',
  latestActionDate: new Date('2026-06-01'),
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

const invoke = (prisma: FakePrisma, input: Record<string, unknown>) =>
  (
    MeriToolsService.prototype as unknown as {
      resolveEntity(i: Record<string, unknown>): Promise<Record<string, unknown>>;
    }
  ).resolveEntity.call({ prisma }, input);

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
    });
  });

  it('resolves a committee systemCode directly', async () => {
    const prisma = emptyPrisma();
    prisma.congressCommittee.findUnique = async ({ where }) =>
      where.systemCode === 'hsag00' ? COMMITTEE : null;
    const out = (await invoke(prisma, { query: 'HSAG00' })) as {
      matches: Array<{ canonicalId: string; matchedBy: string }>;
    };
    expect(out.matches[0]).toMatchObject({ canonicalId: 'hsag00', matchedBy: 'system-code' });
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
    });
  });

  it('falls back to the entity crosswalk for external ids (LIS)', async () => {
    const prisma = emptyPrisma();
    prisma.entityCrosswalk.findMany = async () => [
      { idType: 'lis', idValue: 'S390', entityType: 'member', entityKey: 'V000128' },
    ];
    prisma.congressMember.findUnique = async ({ where }) =>
      where.bioguideId === 'V000128' ? MEMBER : null;
    const out = (await invoke(prisma, { query: 'S390' })) as {
      matches: Array<{ canonicalId: string; matchedBy: string }>;
    };
    expect(out.matches[0]).toMatchObject({ canonicalId: 'V000128', matchedBy: 'lis-crosswalk' });
  });

  it('falls back to name search, current members first', async () => {
    const prisma = emptyPrisma();
    prisma.congressMember.findMany = async () => [MEMBER];
    const out = (await invoke(prisma, { query: 'Van Hollen' })) as {
      matches: Array<{ matchedBy: string }>;
    };
    expect(out.matches[0]).toMatchObject({ matchedBy: 'name-search' });
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
  };
  const STATE_LEGISLATOR = {
    id: 'ocd-person/abc',
    name: 'Rep. Jane Doe',
    state: 'TX',
    chamber: 'lower',
    district: '12',
    party: 'D',
    active: true,
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

  it('resolves a state legislator via entity_crosswalk (LegiScan/OpenStates external id)', async () => {
    const prisma = emptyPrisma();
    prisma.entityCrosswalk.findMany = async () => [
      {
        idType: 'legiscan_people',
        idValue: '12345',
        entityType: 'state_legislator',
        entityKey: 'ocd-person/abc',
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
});
