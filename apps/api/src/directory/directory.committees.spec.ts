import { describe, expect, test } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { DirectoryService } from './directory.service.js';
import type { AppConfig } from '../config/config.schema.js';

/**
 * Unit test for the committee index built from the LegiStorm office-list +
 * staff-list. Exercises the private `buildCommitteeIndex` directly with a tiny
 * fixture: it must keep only federal House/Senate/Joint committees & subcommittees
 * (dropping STATE committees), attach staff via `positions[].office`, dedupe a
 * person within a committee preferring their current position, and rank current
 * staff first.
 */
function makeService(): DirectoryService {
  const config = {
    get: () => 'us-east-1',
  } as unknown as ConfigService<AppConfig, true>;
  const prisma = {} as never;
  const representation = {} as never;
  return new DirectoryService(config, prisma, representation);
}

const OFFICES = {
  office: [
    {
      office_id: 100,
      name: 'House Armed Services Committee',
      office_type: 'House Committee',
      congress_committee_code: 'HSAS',
    },
    {
      office_id: 101,
      name: 'House Armed Services Committee Tactical Air Subcommittee',
      office_type: 'House Subcommittee',
      parent_office: { office_id: 100 },
    },
    {
      office_id: 200,
      name: 'Senate Appropriations Committee',
      office_type: 'Senate Committee',
      congress_committee_code: 'SSAP',
    },
    { office_id: 300, name: 'Joint Committee on Taxation', office_type: 'Joint Committee' },
    // Should be excluded — state legislature committee + a member office.
    {
      office_id: 900,
      name: 'Alaska House Finance Committee',
      office_type: 'State House Committee',
    },
    { office_id: 950, name: 'Rep. Example Office', office_type: 'House Member' },
  ],
  office_member_addresses: [
    {
      is_main: true,
      office: { office_id: 100 },
      phone: '202-225-4151',
      address1: '2216 RHOB',
      city: 'Washington',
      state_id: 'DC',
      zip: '20515',
    },
  ],
};

// Members carry committee leadership (committees[].position) — inverted into the
// committee index. Member 500 chairs HASC; member 600 is its Ranking Member.
const MEMBERS = [
  {
    member: { member_id: 500, profile: { preferred_first_name: 'Mike', last_name: 'Rogers' } },
    committees: [
      {
        committee_office: { office_id: 100, name: 'House Armed Services Committee' },
        position: 'Chair',
      },
    ],
  },
  {
    member: { member_id: 600, profile: { first_name: 'Adam', last_name: 'Smith' } },
    committees: [
      {
        committee_office: { office_id: 100, name: 'House Armed Services Committee' },
        position: 'Ranking Member',
      },
    ],
  },
];

const STAFF = [
  {
    staff: { id: 1, first_name: 'Ada', last_name: 'Byron' },
    staff_emails: [{ contact_string: 'ada@hasc.house.gov' }],
    office_member_addresses: [
      {
        is_main: true,
        phone: '202-555-0001',
        address1: '2120 RHOB',
        city: 'Washington',
        state_id: 'DC',
      },
    ],
    positions: [
      {
        is_current: false,
        position_title: 'Fellow',
        office: { office_id: 100, name: 'House Armed Services Committee' },
      },
      {
        is_current: true,
        position_title: 'Staff Director',
        office: { office_id: 100, name: 'House Armed Services Committee' },
      },
    ],
  },
  {
    staff: { id: 2, preferred_first_name: 'Grace', last_name: 'Hopper' },
    staff_emails: [],
    office_member_addresses: [],
    positions: [
      { is_current: true, position_title: 'Professional Staff Member', office: { office_id: 100 } },
    ],
  },
  {
    staff: { id: 3, first_name: 'Alan', last_name: 'Turing' },
    positions: [{ is_current: true, position_title: 'Counsel', office: { office_id: 300 } }],
  },
  // Staffer attached only to a STATE committee — must not surface anywhere.
  {
    staff: { id: 4, first_name: 'State', last_name: 'Only' },
    positions: [{ is_current: true, position_title: 'Aide', office: { office_id: 900 } }],
  },
];

describe('DirectoryService.buildCommitteeIndex', () => {
  test('keeps only federal committees/subcommittees and ranks by current staff', () => {
    const service = makeService();
    const { committees, committeeStaff } = (service as any).buildCommitteeIndex(
      OFFICES,
      STAFF,
      MEMBERS,
    ) as {
      committees: any[];
      committeeStaff: Map<string, any[]>;
    };

    // 4 federal offices kept; state committee + member office dropped.
    expect(committees.map((c) => c.officeId).sort((a, b) => a - b)).toEqual([100, 101, 200, 300]);
    expect(committees.some((c) => c.officeId === 900)).toBe(false);

    // Subcommittee carries its parent + kind.
    const sub = committees.find((c) => c.officeId === 101);
    expect(sub.kind).toBe('subcommittee');
    expect(sub.parentOfficeId).toBe(100);

    // HASC has 2 current staffers; sorted first by headcount.
    const hasc = committees.find((c) => c.officeId === 100);
    expect(hasc.staffCount).toBe(2);
    expect(committees[0].officeId).toBe(100);

    // Dedupe: Ada appears once under HASC with her CURRENT title.
    const roster = committeeStaff.get('committee-100')!;
    expect(roster.filter((s) => s.id === 'staff-1')).toHaveLength(1);
    expect(roster.find((s) => s.id === 'staff-1').title).toBe('Staff Director');
    expect(roster.find((s) => s.id === 'staff-1').email).toBe('ada@hasc.house.gov');

    // Empty committee (Senate Appropriations, no staff) still present with 0.
    expect(committees.find((c) => c.officeId === 200).staffCount).toBe(0);

    // State-only staffer never surfaces.
    const allStaffIds = [...committeeStaff.values()].flat().map((s) => s.id);
    expect(allStaffIds).not.toContain('staff-4');

    // Leadership inverted from members + phone from office-list addresses.
    expect(hasc.chair).toEqual({ id: 'member-500', name: 'Mike Rogers' });
    expect(hasc.rankingMember).toEqual({ id: 'member-600', name: 'Adam Smith' });
    expect(hasc.phone).toBe('202-225-4151');
    // A committee with no leadership/phone data stays null/empty (no crash).
    expect(committees.find((c) => c.officeId === 300).chair).toBeNull();
    expect(committees.find((c) => c.officeId === 300).phone).toBe('');
  });

  // Regression: the LIVE combined office file is an ARRAY of `{ office, ... }` rows,
  // not the legacy `{ office: [...] }` object. The old code assumed the object shape
  // and returned an empty committee catalog against real data.
  const OFFICES_ARRAY = [
    {
      office: {
        office_id: 100,
        name: 'House Armed Services Committee',
        office_type: 'House Committee',
        congress_committee_code: 'HSAS',
      },
      office_member_addresses: [
        {
          is_main: true,
          office: { office_id: 100 },
          phone: '202-225-4151',
          address1: '2216 RHOB',
          city: 'Washington',
          state_id: 'DC',
          zip: '20515',
        },
      ],
      contacts: [{ contact_type: 'Website', contact_string: 'https://armedservices.house.gov' }],
    },
    {
      office: {
        office_id: 101,
        name: 'House Armed Services Committee Tactical Air Subcommittee',
        office_type: 'House Subcommittee',
        parent_office: { office_id: 100 },
      },
      office_member_addresses: [],
    },
    {
      office: {
        office_id: 200,
        name: 'Senate Appropriations Committee',
        office_type: 'Senate Committee',
        congress_committee_code: 'SSAP',
      },
      office_member_addresses: [],
    },
    { office: { office_id: 300, name: 'Joint Committee on Taxation', office_type: 'Joint Committee' } },
    { office: { office_id: 900, name: 'Alaska House Finance Committee', office_type: 'State House Committee' } },
    { office: { office_id: 950, name: 'Rep. Example Office', office_type: 'House Member' } },
  ];

  test('builds committees from the live office-list ARRAY shape', () => {
    const service = makeService();
    const { committees } = (service as any).buildCommitteeIndex(
      OFFICES_ARRAY,
      STAFF,
      MEMBERS,
    ) as { committees: any[]; committeeStaff: Map<string, any[]> };

    // Non-empty: the array shape now yields the same 4 federal committees.
    expect(committees.map((c) => c.officeId).sort((a, b) => a - b)).toEqual([100, 101, 200, 300]);
    const hasc = committees.find((c) => c.officeId === 100);
    expect(hasc.phone).toBe('202-225-4151');
    expect(hasc.chair).toEqual({ id: 'member-500', name: 'Mike Rogers' });
    expect(hasc.committeeCode).toBe('HSAS');
    const sub = committees.find((c) => c.officeId === 101);
    expect(sub.kind).toBe('subcommittee');
    expect(sub.parentOfficeId).toBe(100);
  });
});

describe('DirectoryService.primaryPhoto', () => {
  test('prefers public directory, then public primary, then any public, else empty', () => {
    const service = makeService();
    const pick = (photos: unknown) => (service as any).primaryPhoto(photos) as string;

    expect(
      pick([
        { url: 'primary.jpg', status: 'public', is_primary: true },
        { url: 'directory.jpg', status: 'public', is_directory: true },
      ]),
    ).toBe('directory.jpg');
    expect(
      pick([
        { url: 'other.jpg', status: 'public', is_primary: false },
        { url: 'primary.jpg', status: 'public', is_primary: true },
      ]),
    ).toBe('primary.jpg');
    expect(pick([{ url: 'any-public.jpg', status: 'public' }])).toBe('any-public.jpg');
    expect(pick([{ url: 'hidden.jpg', status: 'private', is_directory: true }])).toBe('');
    expect(pick(null)).toBe('');
  });
});

describe('DirectoryService staffer-coverage merge', () => {
  // staff 10: member-office position (member.member_id=500), NOT in staffer_roles.
  // staff 11: tagged in member 500's staffer_roles + staffer_issues.
  const MERGE_STAFF = [
    {
      staff: { id: 10, first_name: 'Pat', last_name: 'Aide' },
      staff_emails: [{ contact_string: 'pat@rogers.house.gov' }],
      office_member_addresses: [
        { is_main: true, phone: '202-555-1000', address1: '1 office', city: 'DC', state_id: 'DC' },
      ],
      positions: [
        {
          is_current: true,
          position_title: 'Scheduler',
          member: { member_id: 500 },
          office: { office_id: 950 },
        },
      ],
    },
    {
      staff: { id: 11, first_name: 'Sam', last_name: 'Counsel' },
      staff_emails: [{ contact_string: 'sam@rogers.house.gov' }],
      office_member_addresses: [],
      positions: [
        {
          is_current: true,
          position_title: 'Legislative Director',
          member: { member_id: 500 },
          office: { office_id: 950 },
        },
      ],
    },
  ];
  const MEMBER_ROW = {
    member: { member_id: 500, profile: { first_name: 'Mike', last_name: 'Rogers' } },
    staffer_roles: [
      {
        role_name: 'Legislative Director',
        staffer: { id: 11, first_name: 'Sam', last_name: 'Counsel' },
      },
    ],
    staffer_issues: [{ issue_name: 'Armed forces and national security', staffer: { id: 11 } }],
  };

  test('buildStaffIdsByMember collects current member-office staff', () => {
    const service = makeService();
    const map = (service as any).buildStaffIdsByMember(MERGE_STAFF) as Map<number, number[]>;
    expect(new Set(map.get(500))).toEqual(new Set([10, 11]));
  });

  test('buildMemberStaff merges position-linked staffers with tagged ones', () => {
    const service = makeService();
    const staffById = (service as any).buildStaffDetailsById(MERGE_STAFF);
    const extra = (service as any).buildStaffIdsByMember(MERGE_STAFF).get(500) ?? [];
    const staff = (service as any).buildMemberStaff(MEMBER_ROW, staffById, extra) as any[];

    const ids = staff.map((s) => s.id).sort();
    expect(ids).toEqual(['staff-10', 'staff-11']);
    // Tagged staffer keeps roles/issues; position-only staffer has empty tags + a title.
    const sam = staff.find((s) => s.id === 'staff-11');
    expect(sam.roles).toContain('Legislative Director');
    expect(sam.issueAreas).toContain('Armed forces and national security');
    const pat = staff.find((s) => s.id === 'staff-10');
    expect(pat.title).toBe('Scheduler');
    expect(pat.roles).toEqual([]);
    expect(pat.email).toBe('pat@rogers.house.gov');
  });
});

describe('DirectoryService issue + class helpers', () => {
  test('buildTopIssues ranks issues by distinct staffer headcount', () => {
    const service = makeService();
    const staff = [
      { issueAreas: ['Health', 'Energy'] },
      { issueAreas: ['Health'] },
      { issueAreas: ['Energy', 'Guns'] },
    ];
    const top = (service as any).buildTopIssues(staff) as Array<{
      issue: string;
      stafferCount: number;
    }>;
    expect(top[0]).toEqual({ issue: 'Energy', stafferCount: 2 });
    expect(top.find((t) => t.issue === 'Health')!.stafferCount).toBe(2);
    expect(top.find((t) => t.issue === 'Guns')!.stafferCount).toBe(1);
  });

  test('buildCommitteeLeadershipLabels keeps only ranking roles', () => {
    const service = makeService();
    const labels = (service as any).buildCommitteeLeadershipLabels([
      { committee_office: { name: 'House Armed Services Committee' }, position: 'Chair' },
      { committee_office: { name: 'House Budget Committee' }, position: '' }, // plain membership
    ]) as string[];
    expect(labels).toEqual(['Chair — House Armed Services Committee']);
  });

  test('parseSenateClass only accepts 1/2/3', () => {
    const service = makeService();
    expect((service as any).parseSenateClass(2)).toBe(2);
    expect((service as any).parseSenateClass('3')).toBe(3);
    expect((service as any).parseSenateClass(0)).toBeNull();
    expect((service as any).parseSenateClass(null)).toBeNull();
  });
});
