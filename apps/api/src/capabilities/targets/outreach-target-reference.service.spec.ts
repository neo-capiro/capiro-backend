import { CapabilityError } from '../capability-errors.js';
import { OutreachTargetReferenceService } from './outreach-target-reference.service.js';
import type { DirectoryCommitteeStaffer } from '../../directory/directory.service.js';

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
