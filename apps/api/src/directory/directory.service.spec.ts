import { describe, expect, jest, test } from '@jest/globals';
import { DirectoryService, matchFacilityDistrictCode } from './directory.service.js';

/**
 * WS-D, LegiStorm gaps/enrichment plan — the at-large bridge that resolves a
 * client_facilities-style URL code ('00' for at-large, zero-padded 2-digit
 * otherwise) back to LegiStorm's own raw districtNo storage. Pinned because
 * LegiStorm reports districtNo="1" (never a "0"/null sentinel) even for a
 * jurisdiction's sole House seat — verified live 2026-07-24 via DC's
 * non-voting delegate — so a naive direct-equality match against '00' would
 * silently return nothing for every genuinely at-large state.
 */
describe('matchFacilityDistrictCode', () => {
  const row = (districtNo: string | null) => ({ districtNo });

  test('"00" matches the sole House row for a state, regardless of its raw districtNo value', () => {
    const houseRows = [row('1')]; // Wyoming-style: LegiStorm's own numbering, not "0"
    expect(matchFacilityDistrictCode(houseRows, '00')).toBe(houseRows[0]);
  });

  test('"00" matches NOTHING when the state genuinely has more than one House row', () => {
    const houseRows = [row('4'), row('24'), row('32')]; // e.g. Texas
    expect(matchFacilityDistrictCode(houseRows, '00')).toBeNull();
  });

  test('"00" matches nothing when there are zero House rows for this state+status', () => {
    expect(matchFacilityDistrictCode([], '00')).toBeNull();
  });

  test('a zero-padded single-digit code strips its leading zero to match the bare-number storage', () => {
    const houseRows = [row('2'), row('7')];
    expect(matchFacilityDistrictCode(houseRows, '02')).toBe(houseRows[0]);
  });

  test('a two-digit code matches directly, no padding to strip', () => {
    const houseRows = [row('7'), row('25')];
    expect(matchFacilityDistrictCode(houseRows, '25')).toBe(houseRows[1]);
  });

  test('returns null when the requested district genuinely does not exist among the rows', () => {
    const houseRows = [row('4'), row('24')];
    expect(matchFacilityDistrictCode(houseRows, '99')).toBeNull();
  });

  test('never matches a Senate-shaped row (districtNo=null) against "00", even if it is the only row', () => {
    // Defense in depth: resolveLegislativeDistrict always pre-filters to
    // chamber='house' before calling this function, so a null-districtNo row
    // should never actually reach it in practice — but the function must not
    // depend SOLELY on that upstream filter. A lone null-districtNo row must
    // not be treated as a valid at-large match.
    const houseRows = [row(null)];
    expect(matchFacilityDistrictCode(houseRows, '00')).toBeNull();
  });
});

/**
 * WS-F, LegiStorm gaps/enrichment plan — getContactTrips (privately funded
 * travel surfaced on a member OR staffer profile).
 *
 * getContactTrips needs only this.prisma.legistormTrip — not S3, not
 * getDirectoryData(), not RepresentationResolverService — so a minimal fake
 * DirectoryService construction is enough; no directory snapshot fixture
 * needed.
 */
describe('DirectoryService.getContactTrips (WS-F)', () => {
  function makeService(trips: unknown[] = []) {
    const config = { get: jest.fn().mockReturnValue('us-east-1') } as any;
    const prisma = {
      legistormTrip: { findMany: jest.fn().mockResolvedValue(trips) },
    } as any;
    const representation = {} as any;
    return { service: new DirectoryService(config, prisma, representation), prisma };
  }

  const baseTrip = {
    id: 1,
    approverMemberId: null,
    approverName: null,
    travelerMemberId: null,
    travelerStaffId: null,
    travelerName: null,
    companionName: null,
    startDate: null,
    endDate: null,
    durationDays: null,
    purpose: null,
    totalCost: null,
    destinations: [],
    sponsors: [],
    filedDate: null,
  };

  test('a member contactId queries by approverMemberId OR travelerMemberId', async () => {
    const { service, prisma } = makeService([]);
    await service.getContactTrips('member-101');
    expect(prisma.legistormTrip.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ approverMemberId: 101 }, { travelerMemberId: 101 }] },
      }),
    );
  });

  test('a staff contactId queries by travelerStaffId only', async () => {
    const { service, prisma } = makeService([]);
    await service.getContactTrips('staff-800');
    expect(prisma.legistormTrip.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { travelerStaffId: 800 } }),
    );
  });

  test('a member who approved a staffer trip gets role=approver with the traveler as otherPartyName', async () => {
    const trip = {
      ...baseTrip,
      approverMemberId: 101,
      approverName: 'Rep. Smith',
      travelerStaffId: 500,
      travelerName: 'Jane Staffer',
    };
    const { service } = makeService([trip]);
    const result = await service.getContactTrips('member-101');
    expect(result.trips[0]).toMatchObject({ role: 'approver', otherPartyName: 'Jane Staffer' });
  });

  test('a member who traveled themselves gets role=traveler with the approver as otherPartyName', async () => {
    const trip = {
      ...baseTrip,
      approverMemberId: 999,
      approverName: 'Rep. Approver',
      travelerMemberId: 101,
      travelerName: 'Rep. Smith',
    };
    const { service } = makeService([trip]);
    const result = await service.getContactTrips('member-101');
    expect(result.trips[0]).toMatchObject({ role: 'traveler', otherPartyName: 'Rep. Approver' });
  });

  test('a self-approved trip (approver === traveler) is labeled traveler, never approver', async () => {
    const trip = {
      ...baseTrip,
      approverMemberId: 101,
      approverName: 'Rep. Smith',
      travelerMemberId: 101,
      travelerName: 'Rep. Smith',
    };
    const { service } = makeService([trip]);
    const result = await service.getContactTrips('member-101');
    expect(result.trips[0]!.role).toBe('traveler');
  });

  test('a staff contactId is always role=traveler, even with a coincidental numeric collision on approverMemberId', async () => {
    const trip = {
      ...baseTrip,
      approverMemberId: 800, // coincidentally the same number as the staff id
      approverName: 'Approver',
      travelerStaffId: 800,
      travelerName: 'Staffer Name',
    };
    const { service } = makeService([trip]);
    const result = await service.getContactTrips('staff-800');
    expect(result.trips[0]).toMatchObject({ role: 'traveler', otherPartyName: 'Approver' });
  });

  test('a non-numeric contactId suffix returns an empty list rather than throwing or querying', async () => {
    const { service, prisma } = makeService([]);
    const result = await service.getContactTrips('member-not-a-number');
    expect(result.trips).toEqual([]);
    expect(prisma.legistormTrip.findMany).not.toHaveBeenCalled();
  });

  test('gracefully defaults non-array destinations/sponsors to [] rather than throwing', async () => {
    const trip = { ...baseTrip, approverMemberId: 101, destinations: null, sponsors: null };
    const { service } = makeService([trip]);
    const result = await service.getContactTrips('member-101');
    expect(result.trips[0]!.destinations).toEqual([]);
    expect(result.trips[0]!.sponsors).toEqual([]);
  });
});

/**
 * WS-G, LegiStorm gaps/enrichment plan (optional temporal enrichment) —
 * getAllCommitteeMemberships. This method exists purely to give
 * emit-committee-changes.ts (a plain script, no NestJS DI) a way to reuse
 * DirectoryService's already-built committee index without re-implementing
 * its private buildContacts/buildCommitteeIndex logic standalone. Testing
 * it directly here (rather than only through the script) pins the
 * endedAt===null filter, since membershipsByCommitteeId is documented to
 * include FORMER memberships too ("current or former" — directory-
 * indexes.ts's own doc comment on committeesByPersonId).
 */
describe('DirectoryService.getAllCommitteeMemberships (WS-G)', () => {
  function makeService(membershipsByCommitteeId: Map<string, unknown[]>): DirectoryService {
    const config = { get: jest.fn().mockReturnValue('us-east-1') } as any;
    const prisma = {} as any;
    const representation = {} as any;
    const service = new DirectoryService(config, prisma, representation);
    // getDirectoryData() is private and S3-backed; stub it directly rather
    // than construct a full snapshot fixture, mirroring how this method's
    // ONLY job is to flatten+filter base.indexes.membershipsByCommitteeId.
    // jest.spyOn on a cast-to-any reference is this codebase's established
    // pattern for overriding a private method on a hand-built instance
    // (see intelligence.district-bills.spec.ts's identical technique).
    jest.spyOn(service as any, 'getDirectoryData').mockResolvedValue({
      indexes: { membershipsByCommitteeId },
    } as any);
    return service;
  }

  const activeMembership = (overrides: Record<string, unknown> = {}) => ({
    committeeId: 'committee-2053',
    person: { id: 'member-533', fullName: 'Roger Wicker' },
    membershipType: 'member',
    position: 'Co-Chair',
    party: 'Republican',
    rank: 1,
    status: null,
    startedAt: '2025-12-09',
    endedAt: null,
    sourceUpdatedAt: '2026-07-22T12:46:32',
    ...overrides,
  });

  test('flattens memberships across multiple committees into one list', async () => {
    const map = new Map<string, unknown[]>([
      ['committee-2053', [activeMembership()]],
      ['committee-100', [activeMembership({ committeeId: 'committee-100', person: { id: 'member-2', fullName: 'Other Member' } })]],
    ]);
    const service = makeService(map);

    const result = await service.getAllCommitteeMemberships();

    expect(result).toHaveLength(2);
    expect(result.map((m) => m.committeeId).sort()).toEqual(['committee-100', 'committee-2053']);
  });

  test('excludes a FORMER membership (endedAt set) — membershipsByCommitteeId includes both current and former', async () => {
    const map = new Map<string, unknown[]>([
      [
        'committee-2053',
        [
          activeMembership(), // current — endedAt: null
          activeMembership({
            person: { id: 'member-999', fullName: 'Former Member' },
            endedAt: '2024-01-01',
          }),
        ],
      ],
    ]);
    const service = makeService(map);

    const result = await service.getAllCommitteeMemberships();

    expect(result).toHaveLength(1);
    expect(result[0]!.person.id).toBe('member-533');
  });

  test('returns an empty array when there are no committees at all, never throws', async () => {
    const service = makeService(new Map());
    const result = await service.getAllCommitteeMemberships();
    expect(result).toEqual([]);
  });
});
