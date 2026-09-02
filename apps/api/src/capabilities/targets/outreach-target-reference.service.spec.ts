import { CapabilityError } from '../capability-errors.js';
import { OutreachTargetReferenceService } from './outreach-target-reference.service.js';
import type {
  DirectoryCommitteeStaffer,
  DirectoryContact,
} from '../../directory/directory.service.js';
import type { DirectoryMemberDetail, DirectoryMemberOffice } from '../../directory/directory-detail.types.js';

/**
 * Focused unit coverage for the `committee_staff` locator source added
 * alongside the vNext Outreach Targets step's new "Committee staff" tab.
 * Every other locator source resolves through DirectoryService's existing
 * detail endpoints or Prisma directly (see the sibling private resolvers in
 * outreach-target-reference.service.ts); `resolveCommitteeStaff` is the one
 * new code path, so it gets its own narrow spec rather than piggybacking on
 * outreach-command-engine.service.spec.ts's fully-mocked resolver.
 */
function staffer(overrides: Partial<DirectoryCommitteeStaffer> = {}): DirectoryCommitteeStaffer {
  return {
    id: 'staff-42',
    fullName: 'Jordan Rivera',
    title: 'Professional Staff Member',
    email: 'jordan.rivera@mail.house.gov',
    phone: '202-555-0100',
    officeLocation: '2129 RHOB',
    isCurrent: true,
    committee: {
      id: 'committee-118',
      name: 'Committee on Armed Services',
      chamber: 'house',
      kind: 'standing',
    },
    ...overrides,
  } as DirectoryCommitteeStaffer;
}

function buildService(getCommitteeStafferById: jest.Mock) {
  const directory = { getCommitteeStafferById } as unknown as ConstructorParameters<
    typeof OutreachTargetReferenceService
  >[1];
  // resolveCommitteeStaff never touches Prisma or the authorization service —
  // it is a pure DirectoryService lookup + mapping — so both remaining
  // constructor dependencies are safely undefined for this narrow test.
  return new OutreachTargetReferenceService(
    undefined as unknown as ConstructorParameters<typeof OutreachTargetReferenceService>[0],
    directory,
    undefined as unknown as ConstructorParameters<typeof OutreachTargetReferenceService>[2],
  );
}

describe('OutreachTargetReferenceService — committee_staff locator', () => {
  it('resolves a current committee staffer into a federal, current, complete-profile target ref', async () => {
    const getCommitteeStafferById = jest.fn(async () => ({
      staffer: staffer(),
      sourceId: 'directory-sync-2026-08-01',
    }));
    const service = buildService(getCommitteeStafferById);

    const resolved = await service.resolveOneWithinTx(
      undefined as never,
      { tenantId: 't1', userId: 'u1' } as never,
      { source: 'committee_staff', id: 'staff-42' },
    );

    expect(getCommitteeStafferById).toHaveBeenCalledWith('staff-42');
    expect(resolved).toEqual(
      expect.objectContaining({
        displayName: 'Jordan Rivera',
        email: 'jordan.rivera@mail.house.gov',
        phone: '202-555-0100',
        title: 'Professional Staff Member',
        organization: 'Committee on Armed Services',
        clientId: null,
        roleStatus: 'current',
        emailStatus: 'available',
        profileStatus: 'complete',
      }),
    );
    expect(resolved.jurisdiction).toEqual(
      expect.objectContaining({
        governmentLevel: 'federal',
        chamber: 'house',
        state: null,
        district: null,
        committees: ['Committee on Armed Services'],
      }),
    );
    expect(resolved.sourceSnapshot).toEqual(
      expect.objectContaining({ system: 'capiro_directory', version: 'directory-sync-2026-08-01' }),
    );
  });

  it('marks a former committee staffer historical rather than current', async () => {
    const getCommitteeStafferById = jest.fn(async () => ({
      staffer: staffer({ isCurrent: false }),
      sourceId: 'directory-sync-2026-08-01',
    }));
    const service = buildService(getCommitteeStafferById);

    const resolved = await service.resolveOneWithinTx(
      undefined as never,
      { tenantId: 't1', userId: 'u1' } as never,
      { source: 'committee_staff', id: 'staff-42' },
    );

    expect(resolved.roleStatus).toBe('historical');
  });

  it('reports a missing email as a blocker rather than fabricating one', async () => {
    const getCommitteeStafferById = jest.fn(async () => ({
      staffer: staffer({ email: '' }),
      sourceId: 'directory-sync-2026-08-01',
    }));
    const service = buildService(getCommitteeStafferById);

    const resolved = await service.resolveOneWithinTx(
      undefined as never,
      { tenantId: 't1', userId: 'u1' } as never,
      { source: 'committee_staff', id: 'staff-42' },
    );

    expect(resolved.email).toBeNull();
    expect(resolved.emailStatus).toBe('missing');
  });

  it('fails closed with CAPABILITY_NOT_FOUND when the staffer id does not resolve', async () => {
    const getCommitteeStafferById = jest.fn(async () => null);
    const service = buildService(getCommitteeStafferById);

    await expect(
      service.resolveOneWithinTx(
        undefined as never,
        { tenantId: 't1', userId: 'u1' } as never,
        { source: 'committee_staff', id: 'staff-does-not-exist' },
      ),
    ).rejects.toThrow(CapabilityError);
  });
});

/**
 * Regression coverage for the `directory_member` locator's `roleStatus`.
 * LegiStorm gives a currently-serving office a real `end_date` too — a
 * Senate seat's is that class's constitutionally fixed term-end, set from
 * day one of the term — so `endDate === null` is not a reliable "still in
 * office" signal. `resolveDirectoryMember` used to require it anyway, which
 * fell through to `offices[0]` (the OLDEST term) for almost every member and
 * read that stale term's end date as proof they had left office.
 */
function memberOffice(overrides: Partial<DirectoryMemberOffice> = {}): DirectoryMemberOffice {
  return {
    officeId: 1,
    name: 'Senate office, MD',
    officeTypeId: 'SM',
    state: 'MD',
    district: null,
    party: 'Democrat',
    senateClass: '1',
    outgoingStatus: null,
    status: 'In office',
    startDate: '2025-01-03',
    endDate: '2031-01-03',
    updatedAt: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

function memberContact(overrides: Partial<DirectoryContact> = {}): DirectoryContact {
  return {
    id: 'member-1',
    fullName: 'Sen. Angela Alsobrooks',
    memberName: 'Angela Alsobrooks',
    chamber: 'Senate',
    state: 'MD',
    district: '',
    committees: [],
    focusAreas: [],
    title: 'United States Senator',
    office: 'Senate office, MD',
    email: 'scheduling_alsobrooks@alsobrooks.senate.gov',
    phone: '202-224-4524',
    outgoingStatus: null,
    bio: {
      hometown: 'Prince George’s County, MD',
      occupation: 'Attorney',
      education: 'University of Maryland',
      military: '',
    },
    ...overrides,
  } as unknown as DirectoryContact;
}

function memberDetail(offices: DirectoryMemberOffice[]): DirectoryMemberDetail {
  return {
    kind: 'member',
    id: 'member-1',
    source: { snapshotId: 'directory-sync-2026-08-01', memberId: 1, lastUpdatedAt: null },
    offices,
    socialContacts: [],
  } as unknown as DirectoryMemberDetail;
}

function buildMemberService(
  getMemberDetail: jest.Mock,
  getAllContacts: jest.Mock,
) {
  const directory = { getMemberDetail, getAllContacts } as unknown as ConstructorParameters<
    typeof OutreachTargetReferenceService
  >[1];
  return new OutreachTargetReferenceService(
    undefined as unknown as ConstructorParameters<typeof OutreachTargetReferenceService>[0],
    directory,
    undefined as unknown as ConstructorParameters<typeof OutreachTargetReferenceService>[2],
  );
}

describe('OutreachTargetReferenceService — directory_member locator', () => {
  it('marks a sitting Senator current even though her term office already carries a real end date', async () => {
    const getMemberDetail = jest.fn(async () => memberDetail([memberOffice()]));
    const getAllContacts = jest.fn(async () => [memberContact()]);
    const service = buildMemberService(getMemberDetail, getAllContacts);

    const resolved = await service.resolveOneWithinTx(
      undefined as never,
      { tenantId: 't1', userId: 'u1' } as never,
      { source: 'directory_member', id: 'member-1' },
    );

    expect(resolved.roleStatus).toBe('current');
  });

  it('marks a member historical when no office is in office and falls back to the newest term, not the oldest', async () => {
    const getMemberDetail = jest.fn(async () =>
      memberDetail([
        memberOffice({
          name: 'House office, TX-1 (former term)',
          status: 'Left office',
          startDate: '2019-01-03',
          endDate: '2021-01-03',
        }),
        memberOffice({
          name: 'House office, TX-2 (most recent term)',
          status: 'Left office',
          startDate: '2021-01-03',
          endDate: '2023-01-03',
        }),
      ]),
    );
    const getAllContacts = jest.fn(async () => [memberContact()]);
    const service = buildMemberService(getMemberDetail, getAllContacts);

    const resolved = await service.resolveOneWithinTx(
      undefined as never,
      { tenantId: 't1', userId: 'u1' } as never,
      { source: 'directory_member', id: 'member-1' },
    );

    expect(resolved.roleStatus).toBe('historical');
    expect(resolved.organization).toBe('House office, TX-2 (most recent term)');
  });

  it('still marks a member historical when they are flagged outgoing, even while technically in office', async () => {
    const getMemberDetail = jest.fn(async () => memberDetail([memberOffice()]));
    const getAllContacts = jest.fn(async () => [
      memberContact({ outgoingStatus: 'Not seeking re-election' }),
    ]);
    const service = buildMemberService(getMemberDetail, getAllContacts);

    const resolved = await service.resolveOneWithinTx(
      undefined as never,
      { tenantId: 't1', userId: 'u1' } as never,
      { source: 'directory_member', id: 'member-1' },
    );

    expect(resolved.roleStatus).toBe('historical');
  });
});
