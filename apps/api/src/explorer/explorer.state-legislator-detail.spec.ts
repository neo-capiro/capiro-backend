import { ExplorerService } from './explorer.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * stateLegislatorDetail sponsored-bill resolution: the stored crosswalk id
 * (state_legislator.legiscan_people_id) OR, when it hasn't been stamped yet, an
 * UNAMBIGUOUS same-state name fallback — so a legislator whose bills are sitting
 * in state_bill_sponsor doesn't read blank just because the crosswalk hasn't
 * linked them. Zero or multiple distinct name-matches leave sponsoredBills null
 * (never a guessed identity — PD2).
 */

const LEGISLATOR = {
  id: 'ocd-person/abc',
  name: 'John Smith',
  state: 'TX',
  chamber: 'lower',
  district: '12',
  party: 'R',
  email: null,
  image: null,
  url: null,
  active: true,
  legiscanPeopleId: null as number | null,
  syncedAt: new Date('2026-07-01T00:00:00Z'),
  committeeMemberships: [] as unknown[],
};

const BILL_ROW = {
  sponsorType: 'primary',
  bill: {
    id: 'tx-2025-hb1234',
    identifier: 'HB 1234',
    title: 'An act.',
    chamber: 'lower',
    status: 'introduced',
    statusAt: null,
  },
};

function makePrisma(opts: {
  legiscanPeopleId: number | null;
  /** distinct legiscan_people_ids returned by the fallback name query. */
  nameMatchIds?: (number | null)[];
}) {
  const billsCallArgs: unknown[] = [];
  const prisma = {
    stateLegislator: {
      findUnique: jest.fn(async () => ({
        ...LEGISLATOR,
        legiscanPeopleId: opts.legiscanPeopleId,
      })),
    },
    stateBillSponsor: {
      findMany: jest.fn(
        async (args: { select?: unknown; where?: { legiscanPeopleId?: number } }) => {
          if (args.select) {
            // Fallback distinct-name query.
            return (opts.nameMatchIds ?? []).map((legiscanPeopleId) => ({ legiscanPeopleId }));
          }
          // Bills query.
          billsCallArgs.push(args.where);
          return [BILL_ROW];
        },
      ),
      count: jest.fn(async () => 1),
    },
  } as unknown as PrismaService;
  return { prisma, billsCallArgs };
}

describe('ExplorerService.stateLegislatorDetail — sponsored-bill resolution', () => {
  it('uses the stored crosswalk id when present', async () => {
    const { prisma, billsCallArgs } = makePrisma({ legiscanPeopleId: 777 });
    const svc = new ExplorerService(prisma);
    const r = await svc.stateLegislatorDetail('ocd-person/abc');
    expect(r?.sponsoredBills).toHaveLength(1);
    expect(r?.sponsoredBillsTotal).toBe(1);
    expect(billsCallArgs).toEqual([{ legiscanPeopleId: 777 }]);
  });

  it('falls back to an unambiguous same-state name match when the id is null', async () => {
    const { prisma, billsCallArgs } = makePrisma({
      legiscanPeopleId: null,
      nameMatchIds: [4242],
    });
    const svc = new ExplorerService(prisma);
    const r = await svc.stateLegislatorDetail('ocd-person/abc');
    expect(r?.sponsoredBills).toHaveLength(1);
    expect(billsCallArgs).toEqual([{ legiscanPeopleId: 4242 }]);
  });

  it('does NOT guess when the name matches multiple distinct people (PD2)', async () => {
    const { prisma } = makePrisma({ legiscanPeopleId: null, nameMatchIds: [1, 2] });
    const svc = new ExplorerService(prisma);
    const r = await svc.stateLegislatorDetail('ocd-person/abc');
    expect(r?.sponsoredBills).toBeNull();
    expect(r?.sponsoredBillsTotal).toBe(0);
  });

  it('leaves sponsoredBills null when nothing in-state carries the name', async () => {
    const { prisma } = makePrisma({ legiscanPeopleId: null, nameMatchIds: [] });
    const svc = new ExplorerService(prisma);
    const r = await svc.stateLegislatorDetail('ocd-person/abc');
    expect(r?.sponsoredBills).toBeNull();
  });

  it('ignores null legiscan_people_ids among the name matches (only real ids count)', async () => {
    // A single non-null id alongside nulls is still unambiguous.
    const { prisma, billsCallArgs } = makePrisma({
      legiscanPeopleId: null,
      nameMatchIds: [null, 909],
    });
    const svc = new ExplorerService(prisma);
    const r = await svc.stateLegislatorDetail('ocd-person/abc');
    expect(billsCallArgs).toEqual([{ legiscanPeopleId: 909 }]);
    expect(r?.sponsoredBills).toHaveLength(1);
  });
});
