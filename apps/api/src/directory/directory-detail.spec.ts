import { describe, expect, test } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { DirectoryService } from './directory.service.js';
import { buildDirectoryIndexes } from './directory-indexes.js';
import { parsePhotoOverlay } from './directory-photo.js';
import type { DirectoryCommittee } from './directory.service.js';
import type { AppConfig } from '../config/config.schema.js';

function committee(overrides: Partial<DirectoryCommittee> & { officeId: number }): DirectoryCommittee {
  return {
    id: `committee-${overrides.officeId}`,
    officeId: overrides.officeId,
    name: overrides.name ?? `Committee ${overrides.officeId}`,
    chamber: overrides.chamber ?? 'House',
    kind: overrides.kind ?? 'committee',
    committeeCode: overrides.committeeCode ?? null,
    parentOfficeId: overrides.parentOfficeId ?? null,
    staffCount: 0,
    chair: null,
    rankingMember: null,
    viceChairs: [],
    phone: '',
    officeLocation: '',
  };
}

const COMMITTEES: DirectoryCommittee[] = [
  committee({ officeId: 100, name: 'House Armed Services Committee', committeeCode: 'HSAS' }),
  committee({ officeId: 101, name: 'HASC Tactical Air Subcommittee', kind: 'subcommittee', parentOfficeId: 100 }),
];

const MEMBERS = [
  {
    member: {
      member_id: 500,
      bioguide_id: 'R000500',
      icpsr_id: 123,
      lis_member_id: null,
      profile: {
        first_name: 'Mike',
        last_name: 'Rogers',
        preferred_first_name: 'Mike',
        gender: 'M',
        bio_details: {
          dob: '1958-07-16',
          party_name: 'Republican',
          hometown: 'Saks, AL',
          pob: 'Hammond, IN',
          occupation: 'Attorney',
          pronunciation: 'ROJ-erz',
          race_name: 'White',
          religion_name: 'Baptist',
        },
      },
    },
    photos: [{ id: 9, url: 'https://x.invalid/rogers.jpg', status: 'public', is_directory: true, updated_at: '2026-07-01T00:00:00Z' }],
    social_media: [{ contact_type: 'Website, official', contact_string: 'https://rogers.house.gov', updated_at: '2026-07-01T00:00:00Z' }],
    member_offices: [
      { office: { office_id: 950, name: 'Rep. Rogers Office' }, office_type_id: 'HM', state_id: 'AL', district_no: 3, party: 'R', status: 'In office', start_date: '2003-01-03', end_date: '2100-01-01', updated_at: '2026-07-01T00:00:00Z' },
    ],
    committees: [{ id: 1, committee_office: { office_id: 100 }, position: 'Chair', rank: 1, party_id: 'R', updated_at: '2026-07-01T00:00:00Z' }],
    leaderships: [{ position: 'Chairman', start_date: '2025-01-03', end_date: null, updated_at: '2026-07-01T00:00:00Z' }],
    staffer_roles: [{ role_name: 'Legislative Director', staffer: { id: 800, member_id: 500 } }],
    staffer_issues: [{ issue_name: 'Armed forces and national security', member_id: 500 }],
  },
];

const STAFF = [
  {
    staff: { id: 800, first_name: 'Grace', last_name: 'Hopper', gender: 'F', bio_details: { occupation: 'Counsel' } },
    staff_emails: [{ contact_type: 'Email, official', contact_string: 'grace.hopper@hasc.house.gov', updated_at: '2026-07-01T00:00:00Z' }],
    positions: [
      { id: 20, office: { office_id: 100, name: 'House Armed Services Committee' }, position_title: 'Staff Director', position_type: 'ch', is_current: true, updated_at: '2026-07-01T00:00:00Z' },
      { id: 21, office: { office_id: 950, name: 'Rep. Rogers Office' }, member: { member_id: 500 }, position_title: 'Counsel', is_current: true },
    ],
  },
];

function makeService(): DirectoryService {
  const config = { get: () => 'us-east-1' } as unknown as ConfigService<AppConfig, true>;
  const service = new DirectoryService(config, {} as never, {} as never);
  const indexes = buildDirectoryIndexes({ members: MEMBERS, staff: STAFF, committees: COMMITTEES });
  const photoOverlay = parsePhotoOverlay({
    people: { 'staff-800': { url: 'https://x.invalid/grace.jpg', source: 'firm', addedAt: 't', addedBy: 'neo', manualOverride: false } },
  });
  (service as any).cache = {
    expiresAt: Number.MAX_SAFE_INTEGER,
    data: {
      sourceId: 'bucket/UPDATED DIRECTORY/snapshots/active-current-20260501T024354Z',
      contacts: [{ id: 'member-500', bio: { narrative: 'Chairman bio.' }, rssFeedUrl: 'https://feed', newsPressUrl: '' }],
      staffers: [],
      committees: COMMITTEES,
      committeeStaff: new Map(),
      indexes,
      photoOverlay,
      totals: { all: 1, house: 1, senate: 0, governors: 0, staff: 1 },
      availableStates: [],
      availableFilters: {},
    },
  };
  return service;
}

describe('DirectoryService member detail', () => {
  test('assembles complete member detail from the source row + overlays', async () => {
    const detail = await makeService().getMemberDetail('member-500');
    expect(detail.kind).toBe('member');
    expect(detail.identity).toMatchObject({ memberId: 500, bioguideId: 'R000500', icpsrId: 123, firstName: 'Mike' });
    expect(detail.bioDetails).toMatchObject({ partyName: 'Republican', hometown: 'Saks, AL', raceName: 'White' });
    expect(detail.photos).toHaveLength(1);
    expect(detail.selectedPhotoUrl).toBe('https://x.invalid/rogers.jpg');
    expect(detail.photoSource).toBe('legistorm');
    expect(detail.offices[0]).toMatchObject({ officeId: 950, state: 'AL', district: '3' });
    expect(detail.committees.map((c) => c.committeeId)).toContain('committee-100');
    expect(detail.committees.find((c) => c.committeeId === 'committee-100')!.position).toBe('Chair');
    expect(detail.leaderships.map((l) => l.position)).toContain('Chairman');
    expect(detail.socialContacts.map((s) => s.value)).toContain('https://rogers.house.gov');
    expect(detail.staffRoles.map((r) => r.roleName)).toContain('Legislative Director');
    expect(detail.staffIssues.map((i) => i.issueName)).toContain('Armed forces and national security');
    expect(detail.enrichments).toEqual({ bioOverlay: true, pressOverlay: true });
  });

  test('accepts a bare numeric id and 404s an unknown member', async () => {
    await expect(makeService().getMemberDetail('500')).resolves.toMatchObject({ id: 'member-500' });
    await expect(makeService().getMemberDetail('member-999')).rejects.toThrow(/not found/i);
  });
});

describe('DirectoryService staff detail', () => {
  test('assembles staff detail with member + committee associations and photo availability', async () => {
    const detail = await makeService().getStaffDetail('staff-800');
    expect(detail.identity).toMatchObject({ staffId: 800, firstName: 'Grace' });
    expect(detail.emails.map((e) => e.value)).toContain('grace.hopper@hasc.house.gov');
    expect(detail.positions).toHaveLength(2);
    expect(detail.memberAssociations).toEqual([{ id: 'member-500', memberId: 500, fullName: 'Mike Rogers' }]);
    expect(detail.committeeAssociations.map((c) => c.committeeId)).toEqual(['committee-100']);
    // Overlay photo present -> available, sourced from the preserved overlay (never a member photo).
    expect(detail.photoUrl).toBe('https://x.invalid/grace.jpg');
    expect(detail.photoSource).toBe('capiro_overlay');
    expect(detail.availability.photo).toBe('available');
    expect(detail.availability.socialContacts).toBe('not_provided');
  });

  test('404s an unknown staffer', async () => {
    await expect(makeService().getStaffDetail('staff-999')).rejects.toThrow(/not found/i);
  });
});

describe('DirectoryService committee detail + contacts', () => {
  test('committee detail carries subcommittees, full roster, and counts', async () => {
    const detail = await makeService().getCommitteeDetail('committee-100');
    expect(detail.parentCommittee).toBeNull();
    expect(detail.subcommittees.map((s) => s.id)).toEqual(['committee-101']);
    const ids = detail.contacts.map((c) => c.person.id);
    expect(ids).toContain('member-500');
    expect(ids).toContain('staff-800');
    expect(detail.memberCount).toBe(1);
    expect(detail.currentStaffCount).toBe(1);
  });

  test('subcommittee links to its parent', async () => {
    const detail = await makeService().getCommitteeDetail('committee-101');
    expect(detail.parentCommittee).toMatchObject({ id: 'committee-100', officeId: 100 });
  });

  test('committee contacts filter by person type', async () => {
    const staffOnly = await makeService().getCommitteeContacts('committee-100', { personType: 'staff' });
    expect(staffOnly.contacts.map((c) => c.person.id)).toEqual(['staff-800']);
    expect(staffOnly.total).toBe(1);
  });

  test('404 unknown committee detail', async () => {
    await expect(makeService().getCommitteeDetail('committee-999')).rejects.toThrow(/not found/i);
  });
});

describe('DirectoryService unified people search', () => {
  test('inverts a staff name to the staffer and a member name to the member', async () => {
    const byStaff = await makeService().getPeople({ q: 'grace' });
    expect(byStaff.people.map((p) => p.id)).toEqual(['staff-800']);
    const byMember = await makeService().getPeople({ q: 'rogers' });
    expect(byMember.people.map((p) => p.id)).toEqual(['member-500']);
  });

  test('filters by committee + person type', async () => {
    const members = await makeService().getPeople({ committeeId: 'committee-100', personType: 'member' });
    expect(members.people.map((p) => p.id)).toEqual(['member-500']);
    expect(members.people[0]!.title).toBe('Rep. Rogers Office');
  });
});
