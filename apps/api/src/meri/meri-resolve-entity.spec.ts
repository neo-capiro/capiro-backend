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
};

function emptyPrisma(): FakePrisma {
  return {
    congressMember: { findUnique: async () => null, findMany: async () => [] },
    congressCommittee: { findUnique: async () => null, findMany: async () => [] },
    congressBill: { findUnique: async () => null },
    entityCrosswalk: { findMany: async () => [] },
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
