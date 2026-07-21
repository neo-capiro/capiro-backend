import { ExplorerService } from './explorer.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * The State Legislators directory cards show a Bills / Enacted / Committees
 * stat strip. committeeCount is always a real number, but bill counts join
 * StateBillSponsor by legiscanPeopleId — so a legislator that was never
 * crosswalked (legiscanPeopleId == null) must get billCount/enactedCount
 * === null, NOT 0. Rendering 0 would fabricate a "sponsors nothing" claim
 * for a state whose bills simply haven't been ingested — the same
 * null-vs-empty discipline stateLegislatorDetail keeps for sponsoredBills.
 */

type LegRow = {
  id: string;
  name: string;
  state: string;
  chamber: string | null;
  district: string | null;
  party: string | null;
  email: string | null;
  image: string | null;
  url: string | null;
  legiscanPeopleId: number | null;
  _count: { committeeMemberships: number };
};

const ROWS: LegRow[] = [
  {
    id: 'a',
    name: 'Alice Crosswalked',
    state: 'FL',
    chamber: 'lower',
    district: '1',
    party: 'Republican',
    email: 'a@flhouse.gov',
    image: null,
    url: null,
    legiscanPeopleId: 101, // 4 bills, 1 enacted
    _count: { committeeMemberships: 3 },
  },
  {
    id: 'b',
    name: 'Bob Linked-No-Enacted',
    state: 'FL',
    chamber: 'upper',
    district: '2',
    party: 'Democratic',
    email: null,
    image: null,
    url: null,
    legiscanPeopleId: 202, // 2 bills, 0 enacted
    _count: { committeeMemberships: 1 },
  },
  {
    id: 'c',
    name: 'Carol Never-Crosswalked',
    state: 'GA',
    chamber: 'lower',
    district: '3',
    party: 'Independent',
    email: null,
    image: null,
    url: null,
    legiscanPeopleId: null,
    _count: { committeeMemberships: 0 },
  },
];

function makePrisma(rows: LegRow[]) {
  const groupBy = jest.fn(async (args: { where?: { bill?: { status?: string } } }) => {
    const enacted = args.where?.bill?.status === 'enacted';
    return enacted
      ? [{ legiscanPeopleId: 101, _count: { _all: 1 } }]
      : [
          { legiscanPeopleId: 101, _count: { _all: 4 } },
          { legiscanPeopleId: 202, _count: { _all: 2 } },
        ];
  });
  return {
    prisma: {
      stateLegislator: {
        findMany: jest.fn(async () => rows),
        count: jest.fn(async () => rows.length),
      },
      stateBillSponsor: { groupBy },
    } as unknown as PrismaService,
    groupBy,
  };
}

describe('ExplorerService.stateLegislators — card stat counts', () => {
  it('returns real bill/enacted/committee counts for a crosswalked legislator', async () => {
    const { prisma } = makePrisma(ROWS);
    const svc = new ExplorerService(prisma);
    const { rows } = await svc.stateLegislators({});
    const a = rows.find((r) => r.id === 'a')!;
    expect(a.billCount).toBe(4);
    expect(a.enactedCount).toBe(1);
    expect(a.committeeCount).toBe(3);
  });

  it('reports 0 enacted (not null) for a linked legislator with no enacted bills', async () => {
    const { prisma } = makePrisma(ROWS);
    const svc = new ExplorerService(prisma);
    const { rows } = await svc.stateLegislators({});
    const b = rows.find((r) => r.id === 'b')!;
    expect(b.billCount).toBe(2);
    expect(b.enactedCount).toBe(0);
    expect(b.committeeCount).toBe(1);
  });

  it('reports null (not 0) bill counts for a legislator never crosswalked to LegiScan', async () => {
    const { prisma } = makePrisma(ROWS);
    const svc = new ExplorerService(prisma);
    const { rows } = await svc.stateLegislators({});
    const c = rows.find((r) => r.id === 'c')!;
    expect(c.billCount).toBeNull();
    expect(c.enactedCount).toBeNull();
    // committeeCount is still a real count — 0 committees is an honest zero.
    expect(c.committeeCount).toBe(0);
  });

  it('skips the sponsor groupBy entirely when no row is crosswalked', async () => {
    const noneCrosswalked = ROWS.map((r) => ({ ...r, legiscanPeopleId: null }));
    const { prisma, groupBy } = makePrisma(noneCrosswalked);
    const svc = new ExplorerService(prisma);
    const { rows } = await svc.stateLegislators({});
    expect(groupBy).not.toHaveBeenCalled();
    expect(rows.every((r) => r.billCount === null && r.enactedCount === null)).toBe(true);
  });
});
