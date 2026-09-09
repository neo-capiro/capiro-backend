import { describe, expect, jest, test } from '@jest/globals';
import { ClientTargetsService, classifyStaffKind } from './client-targets.service.js';
import type { DirectoryService } from '../directory/directory.service.js';
import type { RepresentationResolverService } from './representation-resolver.service.js';
import type { DirectoryStaffDetail } from '../directory/directory-detail.types.js';

/**
 * WS-E, LegiStorm gaps/enrichment plan — the "does this saved target
 * represent one of the client's facilities" enrichment on listTargets().
 *
 * Pinned regressions:
 *  1. Resolution uses the CURRENT directory/state_legislator row, never the
 *     ClientTarget row's own denormalized (and possibly stale) `state` text.
 *  2. House at-large (district <= 0 or non-numeric) maps to district: null,
 *     mirroring getMemberRepresentationSummary's already-shipped convention
 *     for this exact data source.
 *  3. Staff targets and unresolvable members are `null` (not applicable /
 *     unknown), never an empty array (which means "resolved, zero matches").
 *  4. Exactly ONE getAllContacts() call and ONE stateLegislator.findMany()
 *     call regardless of target count — no N+1.
 *  5. A per-target facilitiesForMember failure never fails the whole list.
 */
describe('ClientTargetsService.listTargets — WS-E district-nexus enrichment', () => {
  const ctx = { tenantId: 't1', userId: 'u1', role: 'standard_user' } as any;
  const clientId = 'client-1';

  function makeService(opts: {
    rows: any[];
    contacts?: any[];
    stateLegislators?: any[];
    facilitiesForMember?: jest.Mock;
    getStaffDetail?: jest.Mock;
  }) {
    const tx = {
      client: { findFirst: jest.fn<() => Promise<{ id: string }>>().mockResolvedValue({ id: clientId }) },
      clientTarget: { findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue(opts.rows) },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, fn: (tx: any) => Promise<any>) => fn(tx)),
      stateLegislator: { findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue(opts.stateLegislators ?? []) },
    };
    const directory = {
      getAllContacts: jest.fn<() => Promise<any[]>>().mockResolvedValue(opts.contacts ?? []),
      getStaffDetail:
        opts.getStaffDetail ?? jest.fn<() => Promise<any>>().mockRejectedValue(new Error('not stubbed')),
    } as unknown as DirectoryService;
    const representation = {
      facilitiesForMember: opts.facilitiesForMember ?? jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
    } as unknown as RepresentationResolverService;
    const service = new ClientTargetsService(prisma as any, directory, representation);
    return { service, prisma, directory, representation };
  }

  test('resolves federal facilities from the CURRENT directory contact, not the stale row.state text', async () => {
    const row = {
      id: 'target-1',
      memberId: 'member-101',
      sourceDirectory: 'congress',
      state: 'TX-99', // deliberately wrong/stale — must NOT be trusted
    };
    const contact = { id: 'member-101', chamber: 'House', state: 'TX', district: '12' };
    const facilitiesForMember = jest.fn<() => Promise<any[]>>().mockResolvedValue([{ id: 'fac-1', name: 'Acme HQ' }]);
    const { service } = makeService({ rows: [row], contacts: [contact], facilitiesForMember });

    const result = await service.listTargets(ctx, clientId);

    expect(facilitiesForMember).toHaveBeenCalledWith('t1', clientId, {
      type: 'federal',
      chamber: 'house',
      state: 'TX',
      district: 12,
    });
    expect(result[0]!.representedFacilities).toEqual([{ id: 'fac-1', name: 'Acme HQ' }]);
  });

  test('a House member with district "0" (or non-numeric) is treated as at-large — district: null', async () => {
    const row = { id: 'target-1', memberId: 'member-1', sourceDirectory: 'congress', state: null };
    const contact = { id: 'member-1', chamber: 'House', state: 'WY', district: '0' };
    const facilitiesForMember = jest.fn<() => Promise<any[]>>().mockResolvedValue([]);
    const { service } = makeService({ rows: [row], contacts: [contact], facilitiesForMember });

    await service.listTargets(ctx, clientId);

    expect(facilitiesForMember).toHaveBeenCalledWith('t1', clientId, {
      type: 'federal',
      chamber: 'house',
      state: 'WY',
      district: null,
    });
  });

  test('resolves state-legislator facilities from the CURRENT state_legislator row, including a named district', async () => {
    const row = { id: 'target-2', memberId: 'ocd-person/abc', sourceDirectory: 'state', state: null };
    const leg = { id: 'ocd-person/abc', state: 'MA', chamber: 'lower', district: '12th Suffolk' };
    const facilitiesForMember = jest.fn<() => Promise<any[]>>().mockResolvedValue([{ id: 'fac-2', name: 'Boston Office' }]);
    const { service } = makeService({ rows: [row], stateLegislators: [leg], facilitiesForMember });

    const result = await service.listTargets(ctx, clientId);

    expect(facilitiesForMember).toHaveBeenCalledWith('t1', clientId, {
      type: 'state',
      chamber: 'lower',
      state: 'MA',
      district: '12th Suffolk',
    });
    expect(result[0]!.representedFacilities).toEqual([{ id: 'fac-2', name: 'Boston Office' }]);
  });

  test('staff targets are "not applicable" — null, never an empty array', async () => {
    const row = { id: 'target-3', memberId: 'staff-1', sourceDirectory: 'staff', state: null };
    const { service } = makeService({ rows: [row] });

    const result = await service.listTargets(ctx, clientId);

    expect(result[0]!.representedFacilities).toBeNull();
  });

  test('a congress target whose member is no longer in the current directory resolves to null, not []', async () => {
    const row = { id: 'target-4', memberId: 'member-gone', sourceDirectory: 'congress', state: 'TX-1' };
    const { service } = makeService({ rows: [row], contacts: [] });

    const result = await service.listTargets(ctx, clientId);

    expect(result[0]!.representedFacilities).toBeNull();
  });

  test('a Governor-chamber contact resolves to null — not a legislative district at all', async () => {
    const row = { id: 'target-5', memberId: 'gov-1', sourceDirectory: 'congress', state: null };
    const contact = { id: 'gov-1', chamber: 'Governor', state: 'TX', district: null };
    const { service } = makeService({ rows: [row], contacts: [contact] });

    const result = await service.listTargets(ctx, clientId);

    expect(result[0]!.representedFacilities).toBeNull();
  });

  test('a state target with an unrecognized chamber value resolves to null rather than defaulting to "upper"', async () => {
    const row = { id: 'target-7', memberId: 'leg-x', sourceDirectory: 'state', state: null };
    const leg = { id: 'leg-x', state: 'CA', chamber: 'unknown-chamber', district: '5' };
    const facilitiesForMember = jest.fn<() => Promise<any[]>>().mockResolvedValue([{ id: 'fac-x', name: 'Should not be reached' }]);
    const { service } = makeService({ rows: [row], stateLegislators: [leg], facilitiesForMember });

    const result = await service.listTargets(ctx, clientId);

    expect(facilitiesForMember).not.toHaveBeenCalled();
    expect(result[0]!.representedFacilities).toBeNull();
  });

  test('batches: exactly ONE getAllContacts() call and ONE stateLegislator.findMany() call regardless of target count', async () => {
    const rows = [
      { id: 't1', memberId: 'm1', sourceDirectory: 'congress', state: null },
      { id: 't2', memberId: 'm2', sourceDirectory: 'congress', state: null },
      { id: 't3', memberId: 'leg1', sourceDirectory: 'state', state: null },
      { id: 't4', memberId: 'leg2', sourceDirectory: 'state', state: null },
    ];
    const { service, prisma, directory } = makeService({
      rows,
      contacts: [
        { id: 'm1', chamber: 'House', state: 'TX', district: '1' },
        { id: 'm2', chamber: 'Senate', state: 'TX', district: null },
      ],
      stateLegislators: [
        { id: 'leg1', state: 'MA', chamber: 'lower', district: '1' },
        { id: 'leg2', state: 'MA', chamber: 'upper', district: '2' },
      ],
    });

    await service.listTargets(ctx, clientId);

    expect(directory.getAllContacts).toHaveBeenCalledTimes(1);
    expect(prisma.stateLegislator.findMany).toHaveBeenCalledTimes(1);
  });

  test('a per-target facilitiesForMember failure resolves to null for that target, never throws the whole list', async () => {
    const row = { id: 'target-6', memberId: 'member-1', sourceDirectory: 'congress', state: null };
    const contact = { id: 'member-1', chamber: 'House', state: 'TX', district: '1' };
    const facilitiesForMember = jest.fn<() => Promise<any[]>>().mockRejectedValue(new Error('db down'));
    const { service } = makeService({ rows: [row], contacts: [contact], facilitiesForMember });

    const result = await service.listTargets(ctx, clientId);

    expect(result[0]!.representedFacilities).toBeNull();
  });

  test('getAllContacts() is never called when there are no congress targets', async () => {
    const row = { id: 'target-8', memberId: 'leg-1', sourceDirectory: 'state', state: null };
    const leg = { id: 'leg-1', state: 'CA', chamber: 'upper', district: '10' };
    const { service, directory } = makeService({ rows: [row], stateLegislators: [leg] });

    await service.listTargets(ctx, clientId);

    expect(directory.getAllContacts).not.toHaveBeenCalled();
  });
});

/**
 * Q09 (evidence #127/#129/#133): "Relationships → Government identifies
 * Abigail Fachtmann as Committee Staff. Her detail says District Director;
 * the recovered directory profile places her in Young Kim's CA-40 office,
 * without a committee affiliation." Personal-office and committee staff must
 * be distinguished using the directory record — never a single hardcoded
 * label for every 'staff' target regardless of what the record shows.
 */
function staffDetail(overrides: Partial<DirectoryStaffDetail> = {}): DirectoryStaffDetail {
  return {
    kind: 'staff',
    id: 'staff-1',
    source: { snapshotId: 's', staffId: 1, lastUpdatedAt: null },
    identity: {
      staffId: 1,
      firstName: 'Abigail',
      lastName: 'Fachtmann',
      preferredFirstName: null,
      preferredLastName: null,
      suffix: null,
      gender: null,
    },
    bioDetails: {
      dob: null,
      dateOfDeath: null,
      hometown: null,
      placeOfBirth: null,
      nativeOf: null,
      majMin: null,
      partyName: null,
      occupation: null,
      pronunciation: null,
      raceName: null,
      religionName: null,
    },
    photoUrl: null,
    photoSource: null,
    emails: [],
    socialContacts: [],
    officeAddresses: [],
    positions: [],
    memberAssociations: [],
    committeeAssociations: [],
    issues: [],
    roles: [],
    availability: { photo: 'not_provided', socialContacts: 'not_provided' },
    ...overrides,
  } as DirectoryStaffDetail;
}

describe('classifyStaffKind (Q09)', () => {
  test('a personal-office staffer — current position carries a Member — classifies as personal_office', () => {
    // Mirrors the reported case exactly: District Director in a Member's
    // own office (Young Kim, CA-40), no committee affiliation at all.
    const staff = staffDetail({
      positions: [
        {
          officeId: 950,
          officeName: "Rep. Kim's Office",
          memberId: 40,
          title: 'District Director',
          positionType: 'district_director',
          isCurrent: true,
          isOnLeave: false,
          startDate: null,
          endDate: null,
          updatedAt: null,
          member: { memberId: 40, fullName: 'Young Kim', party: 'R', state: 'CA', district: '40', officeTypeId: 'HM' },
        },
      ],
      committeeAssociations: [],
    });

    expect(classifyStaffKind(staff)).toBe('personal_office');
  });

  test('real committee staff — current position has no Member, and committeeAssociations is populated — classifies as committee', () => {
    const staff = staffDetail({
      positions: [
        {
          officeId: 100,
          officeName: 'House Armed Services Committee',
          memberId: null,
          title: 'Staff Director',
          positionType: 'ch',
          isCurrent: true,
          isOnLeave: false,
          startDate: null,
          endDate: null,
          updatedAt: null,
          member: null,
        },
      ],
      committeeAssociations: [
        {
          committeeId: 'committee-100',
          person: {
            personType: 'staff',
            id: 'staff-1',
            sourceId: 1,
            fullName: 'Grace Hopper',
            title: 'Staff Director',
            photoUrl: null,
            photoSource: null,
            party: null,
            state: null,
            district: null,
            isCurrent: true,
          },
          membershipType: 'staff',
          position: 'Staff Director',
          party: null,
          rank: null,
          status: 'current',
          startedAt: null,
          endedAt: null,
          sourceUpdatedAt: null,
        },
      ],
    });

    expect(classifyStaffKind(staff)).toBe('committee');
  });

  test('no current position, only a FORMER personal-office position — falls back to it (mirrors resolveStaffSnapshot)', () => {
    const staff = staffDetail({
      positions: [
        {
          officeId: 950,
          officeName: "Rep. Kim's Office",
          memberId: 40,
          title: 'District Director',
          positionType: 'district_director',
          isCurrent: false,
          isOnLeave: false,
          startDate: null,
          endDate: '2025-01-01',
          updatedAt: null,
          member: { memberId: 40, fullName: 'Young Kim', party: 'R', state: 'CA', district: '40', officeTypeId: 'HM' },
        },
      ],
    });

    expect(classifyStaffKind(staff)).toBe('personal_office');
  });

  test('neither signal present — unknown, never a guess', () => {
    expect(classifyStaffKind(staffDetail({ positions: [], committeeAssociations: [] }))).toBeNull();
  });
});

describe('ClientTargetsService.listTargets — Q09 staffKind enrichment', () => {
  const ctx = { tenantId: 't1', userId: 'u1', role: 'standard_user' } as any;
  const clientId = 'client-1';

  function makeService(opts: {
    rows: any[];
    getStaffDetail?: jest.Mock;
  }) {
    const tx = {
      client: { findFirst: jest.fn<() => Promise<{ id: string }>>().mockResolvedValue({ id: clientId }) },
      clientTarget: { findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue(opts.rows) },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, fn: (tx: any) => Promise<any>) => fn(tx)),
      stateLegislator: { findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([]) },
    };
    const directory = {
      getAllContacts: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
      getStaffDetail: opts.getStaffDetail ?? jest.fn<() => Promise<any>>().mockRejectedValue(new Error('not stubbed')),
    } as unknown as DirectoryService;
    const representation = {
      facilitiesForMember: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
    } as unknown as RepresentationResolverService;
    const service = new ClientTargetsService(prisma as any, directory, representation);
    return { service, directory };
  }

  test('the reported case: a staff target whose CURRENT directory record shows a personal-office role gets staffKind personal_office, not hardcoded as committee', async () => {
    const row = {
      id: 'target-1',
      memberId: 'staff-396593',
      sourceDirectory: 'staff',
      memberName: 'Abigail Fachtmann',
      // Stale row: this target was added BEFORE this fix shipped, so its own
      // denormalized staffKind column is null — the fresh read must win.
      staffKind: null,
    };
    const getStaffDetail = jest.fn<() => Promise<DirectoryStaffDetail>>().mockResolvedValue(
      staffDetail({
        id: 'staff-396593',
        positions: [
          {
            officeId: 950,
            officeName: "Rep. Kim's Office",
            memberId: 40,
            title: 'District Director',
            positionType: 'district_director',
            isCurrent: true,
            isOnLeave: false,
            startDate: null,
            endDate: null,
            updatedAt: null,
            member: { memberId: 40, fullName: 'Young Kim', party: 'R', state: 'CA', district: '40', officeTypeId: 'HM' },
          },
        ],
        committeeAssociations: [],
      }),
    );
    const { service, directory } = makeService({ rows: [row], getStaffDetail });

    const result = await service.listTargets(ctx, clientId);

    expect(directory.getStaffDetail).toHaveBeenCalledWith('staff-396593');
    expect(result[0]!.staffKind).toBe('personal_office');
  });

  test('a genuine committee-staff target resolves to committee', async () => {
    const row = { id: 'target-2', memberId: 'staff-800', sourceDirectory: 'staff', staffKind: null };
    const getStaffDetail = jest.fn<() => Promise<DirectoryStaffDetail>>().mockResolvedValue(
      staffDetail({
        id: 'staff-800',
        positions: [
          {
            officeId: 100,
            officeName: 'House Armed Services Committee',
            memberId: null,
            title: 'Staff Director',
            positionType: 'ch',
            isCurrent: true,
            isOnLeave: false,
            startDate: null,
            endDate: null,
            updatedAt: null,
            member: null,
          },
        ],
        committeeAssociations: [
          {
            committeeId: 'committee-100',
            person: {
              personType: 'staff',
              id: 'staff-800',
              sourceId: 800,
              fullName: 'Grace Hopper',
              title: 'Staff Director',
              photoUrl: null,
              photoSource: null,
              party: null,
              state: null,
              district: null,
              isCurrent: true,
            },
            membershipType: 'staff',
            position: 'Staff Director',
            party: null,
            rank: null,
            status: 'current',
            startedAt: null,
            endedAt: null,
            sourceUpdatedAt: null,
          },
        ],
      }),
    );
    const { service } = makeService({ rows: [row], getStaffDetail });

    const result = await service.listTargets(ctx, clientId);

    expect(result[0]!.staffKind).toBe('committee');
  });

  test('directory unavailable for this staffer: falls back to the row\'s own stored staffKind rather than clearing it', async () => {
    const row = { id: 'target-3', memberId: 'staff-999', sourceDirectory: 'staff', staffKind: 'personal_office' };
    const getStaffDetail = jest.fn<() => Promise<DirectoryStaffDetail>>().mockRejectedValue(new Error('directory down'));
    const { service } = makeService({ rows: [row], getStaffDetail });

    const result = await service.listTargets(ctx, clientId);

    expect(result[0]!.staffKind).toBe('personal_office');
  });

  test('non-staff targets never call getStaffDetail, and their staffKind is null', async () => {
    const row = { id: 'target-4', memberId: 'member-1', sourceDirectory: 'congress', staffKind: null };
    const getStaffDetail = jest.fn<() => Promise<DirectoryStaffDetail>>();
    const { service, directory } = makeService({ rows: [row], getStaffDetail });

    const result = await service.listTargets(ctx, clientId);

    expect(directory.getStaffDetail).not.toHaveBeenCalled();
    expect(result[0]!.staffKind).toBeNull();
  });
});
