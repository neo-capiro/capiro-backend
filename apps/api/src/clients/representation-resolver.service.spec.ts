import {
  RepresentationResolverService,
  districtMatchesHouse,
  normalizeDistrictCode,
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

  it('unresolved (no_geocode) when the facility has no district at all', async () => {
    const svc = new RepresentationResolverService(fakePrisma({}));
    const out = await svc.representativesForFacility({
      ...MATCHED_FACILITY,
      geocodeStatus: 'no_match',
      congressionalDistrict: null,
    });
    expect(out).toEqual({ unresolved: true, reason: 'no_geocode' });
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

describe('normalizeDistrictCode', () => {
  it('strips leading zeros', () => expect(normalizeDistrictCode('003')).toBe('3'));
  it('strips a non-digit prefix', () => expect(normalizeDistrictCode('HD-9')).toBe('9'));
  it('trims whitespace', () => expect(normalizeDistrictCode(' 3 ')).toBe('3'));
  it('null passthrough', () => expect(normalizeDistrictCode(null)).toBeNull());
  it('empty string -> null', () => expect(normalizeDistrictCode('')).toBeNull());
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
});

describe('RepresentationResolverService.clientsRepresentedByMember (M1.4 — tenant-wide inverse)', () => {
  function fakeTenantWidePrisma(facilities: Array<Record<string, unknown>>) {
    return {
      withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({ clientFacility: { findMany: jest.fn(async () => facilities) } }),
      ),
    } as unknown as PrismaService;
  }

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
