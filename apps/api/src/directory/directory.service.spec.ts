import { describe, expect, jest, test } from '@jest/globals';
import { DirectoryService } from './directory.service.js';

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
