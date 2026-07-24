import {
  RepresentationResolverService,
  districtMatchesHouse,
  type FacilityDistrictInput,
} from './representation-resolver.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

interface FakeMember {
  bioguideId: string;
  fullName: string;
  party: string;
  state: string;
  district: number | null;
  chamber: string;
}
interface FakeStateLegislator {
  id: string;
  name: string;
  state: string;
  chamber: string;
  district: string;
  party: string;
}

const HOUSE_MEMBER: FakeMember = {
  bioguideId: 'D000001',
  fullName: 'Jane Doe',
  party: 'Democratic',
  state: 'FL',
  district: 2,
  chamber: 'house',
};
const AT_LARGE_MEMBER: FakeMember = {
  bioguideId: 'W000001',
  fullName: 'Wyoming Rep',
  party: 'Republican',
  state: 'WY',
  district: null,
  chamber: 'house',
};
const SENATOR_1: FakeMember = { bioguideId: 'S000001', fullName: 'Sen A', party: 'D', state: 'FL', district: null, chamber: 'senate' };
const SENATOR_2: FakeMember = { bioguideId: 'S000002', fullName: 'Sen B', party: 'R', state: 'FL', district: null, chamber: 'senate' };
const STATE_LOWER: FakeStateLegislator = { id: 'ocd-1', name: 'State Rep X', state: 'FL', chamber: 'lower', district: '009', party: 'D' };
const STATE_UPPER: FakeStateLegislator = { id: 'ocd-2', name: 'State Sen Y', state: 'FL', chamber: 'upper', district: '3', party: 'R' };

function fakePrisma(opts: {
  houseMembers?: FakeMember[];
  senators?: FakeMember[];
  stateLower?: FakeStateLegislator[];
  stateUpper?: FakeStateLegislator[];
}) {
  return {
    congressMember: {
      findMany: jest.fn(async (args: { where: { chamber: string } }) =>
        args.where.chamber === 'house' ? (opts.houseMembers ?? []) : (opts.senators ?? []),
      ),
    },
    stateLegislator: {
      findMany: jest.fn(async (args: { where: { chamber: string } }) =>
        args.where.chamber === 'lower' ? (opts.stateLower ?? []) : (opts.stateUpper ?? []),
      ),
    },
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) => fn({})),
  } as unknown as PrismaService;
}

const MATCHED_FACILITY: FacilityDistrictInput = {
  state: 'FL',
  congressionalDistrict: '02',
  stateHouseDistrict: '9',
  stateSenateDistrict: '3',
  geocodeStatus: 'matched',
};

describe('RepresentationResolverService.representativesForFacility', () => {
  it('unresolved (no_state) when the facility has no state', async () => {
    const svc = new RepresentationResolverService(fakePrisma({}));
    const out = await svc.representativesForFacility({ ...MATCHED_FACILITY, state: null });
    expect(out).toEqual({ unresolved: true, reason: 'no_state' });
  });

  // REGRESSION: CongressMember.state stores the FULL state name
  // ("Florida"), but ClientFacility.state is a 2-letter code ("FL"). The
  // resolver must translate before querying, or it silently matches zero
  // rows for every facility in the country (the fixture mock above ignores
  // `where.state` entirely, so only asserting on the captured call args
  // actually catches a regression here).
  it('queries congressMember with the translated FULL state name, not the facility 2-letter code', async () => {
    const prisma = fakePrisma({ houseMembers: [HOUSE_MEMBER], senators: [SENATOR_1, SENATOR_2] });
    const svc = new RepresentationResolverService(prisma);
    await svc.representativesForFacility(MATCHED_FACILITY);
    const calls = (prisma.congressMember.findMany as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2); // house + senate
    for (const [args] of calls) {
      expect(args.where.state).toBe('Florida');
    }
  });

  it('an unresolvable state code fails closed (no house match, empty senate) instead of throwing', async () => {
    const svc = new RepresentationResolverService(fakePrisma({}));
    const out = await svc.representativesForFacility({ ...MATCHED_FACILITY, state: 'ZZ' });
    expect(out.unresolved).toBe(false);
    if (!out.unresolved) {
      expect(out.federal.house).toBeNull();
      expect(out.federal.senate).toEqual([]);
    }
  });

  it('unresolved (no_geocode) when the facility has no district at all', async () => {
    const svc = new RepresentationResolverService(fakePrisma({}));
    const out = await svc.representativesForFacility({
      ...MATCHED_FACILITY,
      geocodeStatus: 'no_match',
      congressionalDistrict: null,
      stateHouseDistrict: null,
      stateSenateDistrict: null,
    });
    expect(out).toEqual({ unresolved: true, reason: 'no_geocode' });
  });

  // REGRESSION (2026-07-10, W2.2): a manually-entered facility
  // (`districtSource='user'`) that never ran through the geocoder must still
  // resolve using whichever district(s) were hand-typed — the old gate
  // (`geocodeStatus !== 'matched' && !congressionalDistrict`) silently treated
  // ANY non-matched facility with only a state district as fully unresolved.
  it('a manually-entered facility (not geocoded) with only a hand-typed state house district resolves the state legislator, not federal', async () => {
    const svc = new RepresentationResolverService(
      fakePrisma({ stateLower: [STATE_LOWER] }),
    );
    const out = await svc.representativesForFacility({
      state: 'FL',
      congressionalDistrict: null,
      stateHouseDistrict: '9',
      stateSenateDistrict: null,
      geocodeStatus: null, // never geocoded — this is the manual-entry case
    });
    expect(out.unresolved).toBe(false);
    if (out.unresolved) throw new Error('expected resolved');
    expect(out.state.lower?.id).toBe('ocd-1');
    expect(out.federal.house).toBeNull(); // no congressionalDistrict supplied -> correctly null, not a guess
  });

  it('a manually-entered facility (geocodeStatus=error) with a hand-typed congressional district still resolves federal House', async () => {
    const svc = new RepresentationResolverService(
      fakePrisma({ houseMembers: [HOUSE_MEMBER], senators: [SENATOR_1, SENATOR_2] }),
    );
    const out = await svc.representativesForFacility({
      state: 'FL',
      congressionalDistrict: '02',
      stateHouseDistrict: null,
      stateSenateDistrict: null,
      geocodeStatus: 'error', // geocoder failed, but the user supplied a district by hand
    });
    expect(out.unresolved).toBe(false);
    if (out.unresolved) throw new Error('expected resolved');
    expect(out.federal.house?.bioguideId).toBe('D000001');
  });

  it('resolves federal House + both senators + state upper/lower for a fixtured facility (M1-D)', async () => {
    const svc = new RepresentationResolverService(
      fakePrisma({
        houseMembers: [HOUSE_MEMBER],
        senators: [SENATOR_1, SENATOR_2],
        stateLower: [STATE_LOWER],
        stateUpper: [STATE_UPPER],
      }),
    );
    const out = await svc.representativesForFacility(MATCHED_FACILITY);
    expect(out.unresolved).toBe(false);
    if (out.unresolved) throw new Error('expected resolved');
    expect(out.federal.house?.bioguideId).toBe('D000001');
    expect(out.federal.senate.map((s) => s.bioguideId).sort()).toEqual(['S000001', 'S000002']);
    expect(out.state.lower?.id).toBe('ocd-1');
    expect(out.state.upper?.id).toBe('ocd-2');
  });

  it('at-large facility ("00") matches a House member stored with district=NULL (PD1.3/M1.3)', async () => {
    const svc = new RepresentationResolverService(
      fakePrisma({ houseMembers: [AT_LARGE_MEMBER], senators: [] }),
    );
    const out = await svc.representativesForFacility({
      state: 'WY',
      congressionalDistrict: '00',
      stateHouseDistrict: null,
      stateSenateDistrict: null,
      geocodeStatus: 'matched',
    });
    expect(out.unresolved).toBe(false);
    if (out.unresolved) throw new Error('expected resolved');
    expect(out.federal.house?.bioguideId).toBe('W000001');
  });

  it('a naive Number("00")=0 join would miss the at-large member — proves the fix is load-bearing', () => {
    // The exact bug PD1.3 warns about: at-large stores district=NULL, not 0.
    expect(districtMatchesHouse('00', 0)).toBe(true); // still matches if some future sync ever stores 0
    expect(districtMatchesHouse('00', null)).toBe(true); // the REAL stored shape
    expect(districtMatchesHouse('02', null)).toBe(false); // a non-at-large district never matches a null
  });

  it('state chamber match normalizes district formatting ("009" stored vs "9" resolved)', async () => {
    const svc = new RepresentationResolverService(
      fakePrisma({ stateLower: [{ ...STATE_LOWER, district: '009' }] }),
    );
    const out = await svc.representativesForFacility({
      ...MATCHED_FACILITY,
      stateHouseDistrict: '9',
      stateSenateDistrict: null,
    });
    expect(out.unresolved).toBe(false);
    if (out.unresolved) throw new Error('expected resolved');
    expect(out.state.lower?.id).toBe('ocd-1');
  });

  it('no state-chamber match (e.g. district mismatch) resolves to null, never a guess', async () => {
    const svc = new RepresentationResolverService(fakePrisma({ stateLower: [STATE_LOWER] }));
    const out = await svc.representativesForFacility({
      ...MATCHED_FACILITY,
      stateHouseDistrict: '99',
      stateSenateDistrict: null,
    });
    expect(out.unresolved).toBe(false);
    if (out.unresolved) throw new Error('expected resolved');
    expect(out.state.lower).toBeNull();
  });
});

describe('RepresentationResolverService.facilitiesForMember (inverse)', () => {
  it('federal house: finds a client facility in the member district, respecting the at-large sentinel', async () => {
    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({
          clientFacility: {
            findMany: jest.fn(async () => [
              { id: 'fac-1', name: 'HQ', congressionalDistrict: '00' },
              { id: 'fac-2', name: 'Branch', congressionalDistrict: '05' },
            ]),
          },
        }),
      ),
    } as unknown as PrismaService;
    const svc = new RepresentationResolverService(prisma);
    const out = await svc.facilitiesForMember('t1', 'c1', {
      type: 'federal',
      chamber: 'house',
      state: 'WY',
      district: null,
    });
    expect(out).toEqual([{ id: 'fac-1', name: 'HQ' }]);
  });

  it('state chamber: matches on normalized district', async () => {
    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({
          clientFacility: {
            findMany: jest.fn(async () => [
              { id: 'fac-1', name: 'HQ', stateHouseDistrict: '9', stateSenateDistrict: '3' },
              { id: 'fac-2', name: 'Branch', stateHouseDistrict: '12', stateSenateDistrict: '4' },
            ]),
          },
        }),
      ),
    } as unknown as PrismaService;
    const svc = new RepresentationResolverService(prisma);
    const out = await svc.facilitiesForMember('t1', 'c1', {
      type: 'state',
      chamber: 'lower',
      state: 'FL',
      district: '009',
    });
    expect(out).toEqual([{ id: 'fac-1', name: 'HQ' }]);
  });

  // REGRESSION (2026-07-10, Wave-2 closure): all THREE facilitiesForMember
  // branches (federal senate, federal house, state chamber) must query with the
  // resolvable-facility OR, never a bare `geocodeStatus:'matched'`. The other
  // tests in this block use fake findMany impls that IGNORE `where`, so this is
  // the only pin on the query shape for the path that carries a manually-entered
  // facility into the chokepoint footprint (blueprint W2.2 SC-5/M1-B). Without
  // it, a future edit reintroducing the geocode-only filter would silently drop
  // manual facilities from the footprint again, with all tests still green.
  it.each([
    ['federal senate', { type: 'federal', chamber: 'senate', state: 'FL', district: null }],
    ['federal house', { type: 'federal', chamber: 'house', state: 'WY', district: null }],
    ['state chamber', { type: 'state', chamber: 'lower', state: 'FL', district: '9' }],
  ] as const)('%s branch queries with RESOLVABLE_FACILITY_OR, not a bare geocodeStatus filter', async (_label, member) => {
    const findMany = jest.fn(async (_args: { where: Record<string, unknown> }) => []);
    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({ clientFacility: { findMany } }),
      ),
    } as unknown as PrismaService;
    const svc = new RepresentationResolverService(prisma);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await svc.facilitiesForMember('t1', 'c1', member as any);
    const call = findMany.mock.calls[0];
    if (!call) throw new Error('expected clientFacility.findMany to have been called');
    const where = call[0].where;
    expect(where.geocodeStatus).toBeUndefined();
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { geocodeStatus: 'matched' },
        { congressionalDistrict: { not: null } },
        { stateHouseDistrict: { not: null } },
        { stateSenateDistrict: { not: null } },
      ]),
    );
  });
});

describe('RepresentationResolverService.clientsRepresentedByMember (M1.4 — tenant-wide inverse)', () => {
  function fakeTenantWidePrisma(facilities: Array<Record<string, unknown>>) {
    return {
      withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({ clientFacility: { findMany: jest.fn(async () => facilities) } }),
      ),
    } as unknown as PrismaService;
  }

  // REGRESSION (2026-07-10, W2.2): pins the actual Prisma `where` shape — the
  // other tests in this block use a fake findMany that ignores its `where`
  // arg entirely, so they can't catch a regression back to a bare
  // `geocodeStatus: 'matched'` filter that would silently re-exclude every
  // manually-entered (not-yet-geocoded) facility from this query.
  it('queries with the resolvable-facility OR (not a bare geocodeStatus filter)', async () => {
    const findMany = jest.fn(
      async (_args: { where: { OR?: unknown[]; geocodeStatus?: unknown } }) =>
        [] as Array<Record<string, unknown>>,
    );
    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({ clientFacility: { findMany } }),
      ),
    } as unknown as PrismaService;
    const svc = new RepresentationResolverService(prisma);
    await svc.clientsRepresentedByMember('t1', {
      bioguideId: 'W000001',
      chamber: 'house',
      state: 'WY',
      district: null,
    });
    const call = findMany.mock.calls[0];
    if (!call) throw new Error('expected findMany to have been called');
    const where = call[0].where;
    expect(where.geocodeStatus).toBeUndefined();
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { geocodeStatus: 'matched' },
        { congressionalDistrict: { not: null } },
        { stateHouseDistrict: { not: null } },
        { stateSenateDistrict: { not: null } },
      ]),
    );
  });

  it('groups matching facilities by client, across every client in the tenant (House, at-large)', async () => {
    const prisma = fakeTenantWidePrisma([
      {
        id: 'fac-1',
        name: 'HQ',
        congressionalDistrict: '00',
        clientId: 'client-a',
        client: { id: 'client-a', name: 'Acme' },
      },
      {
        id: 'fac-2',
        name: 'Branch',
        congressionalDistrict: '00',
        clientId: 'client-a',
        client: { id: 'client-a', name: 'Acme' },
      },
      {
        id: 'fac-3',
        name: 'Other Co HQ',
        congressionalDistrict: '00',
        clientId: 'client-b',
        client: { id: 'client-b', name: 'Other Co' },
      },
    ]);
    const svc = new RepresentationResolverService(prisma);
    const out = await svc.clientsRepresentedByMember('t1', {
      bioguideId: 'W000001',
      chamber: 'house',
      state: 'WY',
      district: null, // at-large member, per PD1.3
    });
    expect(out).toEqual([
      { clientId: 'client-a', clientName: 'Acme', facilities: [{ id: 'fac-1', name: 'HQ' }, { id: 'fac-2', name: 'Branch' }] },
      { clientId: 'client-b', clientName: 'Other Co', facilities: [{ id: 'fac-3', name: 'Other Co HQ' }] },
    ]);
  });

  it('senate matches on state alone, regardless of district', async () => {
    const prisma = fakeTenantWidePrisma([
      {
        id: 'fac-1',
        name: 'HQ',
        congressionalDistrict: '12',
        clientId: 'client-a',
        client: { id: 'client-a', name: 'Acme' },
      },
    ]);
    const svc = new RepresentationResolverService(prisma);
    const out = await svc.clientsRepresentedByMember('t1', {
      bioguideId: 'S000001',
      chamber: 'senate',
      state: 'FL',
      district: null,
    });
    expect(out).toEqual([{ clientId: 'client-a', clientName: 'Acme', facilities: [{ id: 'fac-1', name: 'HQ' }] }]);
  });

  it('a non-matching district produces no clients', async () => {
    const prisma = fakeTenantWidePrisma([
      {
        id: 'fac-1',
        name: 'HQ',
        congressionalDistrict: '05',
        clientId: 'client-a',
        client: { id: 'client-a', name: 'Acme' },
      },
    ]);
    const svc = new RepresentationResolverService(prisma);
    const out = await svc.clientsRepresentedByMember('t1', {
      bioguideId: 'D000001',
      chamber: 'house',
      state: 'FL',
      district: 2,
    });
    expect(out).toEqual([]);
  });

  it('no state on the member resolves to empty (never a guess)', async () => {
    const svc = new RepresentationResolverService(fakeTenantWidePrisma([]));
    const out = await svc.clientsRepresentedByMember('t1', {
      bioguideId: 'X',
      chamber: 'house',
      state: null,
      district: null,
    });
    expect(out).toEqual([]);
  });
});
