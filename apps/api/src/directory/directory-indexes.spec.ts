import { describe, expect, test } from '@jest/globals';
import { buildDirectoryIndexes, normalizePersonName } from './directory-indexes.js';
import type { DirectoryCommittee } from './directory.service.js';

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
    member: { member_id: 500, bioguide_id: 'R000500', profile: { first_name: 'Mike', last_name: 'Rogers' } },
    photos: [{ url: 'https://x.invalid/rogers.jpg', status: 'public', is_directory: true }],
    member_offices: [{ office: { office_id: 950 }, state_id: 'AL', district_no: 3, party: 'R' }],
    committees: [
      { id: 1, committee_office: { office_id: 100 }, position: 'Chair', rank: 1, party_id: 'R', updated_at: '2026-07-01T00:00:00Z' },
    ],
  },
  {
    // ORDINARY member (no leadership title) — must still be indexed.
    member: { member_id: 600, bioguide_id: 'O000600', profile: { first_name: 'Ada', last_name: 'Ordinary' } },
    photos: [],
    member_offices: [{ office: { office_id: 951 }, state_id: 'CA', district_no: 12, party: 'D' }],
    committees: [
      { id: 2, committee_office: { office_id: 100 }, position: 'Member', rank: 9 },
      { id: 3, committee_office: { office_id: 101 }, position: 'Member' },
    ],
  },
];

const STAFF = [
  {
    staff: { id: 1, first_name: 'Grace', last_name: 'Hopper' },
    positions: [
      { id: 20, office: { office_id: 100 }, position_title: 'Staff Director', is_current: true },
      // Duplicate source membership id -> must dedupe to one.
      { id: 20, office: { office_id: 100 }, position_title: 'Staff Director', is_current: true },
      // A member-office position (not a committee) -> must NOT become a committee membership.
      { id: 21, office: { office_id: 950 }, member: { member_id: 500 }, position_title: 'LA', is_current: true },
    ],
  },
];

describe('buildDirectoryIndexes', () => {
  const idx = buildDirectoryIndexes({ members: MEMBERS, staff: STAFF, committees: COMMITTEES });

  test('retains raw source rows keyed by stable id + bioguide', () => {
    expect(idx.membersById.get(500)).toBe(MEMBERS[0]);
    expect(idx.membersByBioguideId.get('R000500')).toBe(MEMBERS[0]);
    expect(idx.staffById.get(1)).toBe(STAFF[0]);
  });

  test('keeps EVERY committee membership, not just leadership', () => {
    const roster = idx.membershipsByCommitteeId.get('committee-100')!;
    const ids = roster.map((m) => m.person.id);
    expect(ids).toContain('member-500'); // Chair
    expect(ids).toContain('member-600'); // ordinary Member
    expect(ids).toContain('staff-1'); // committee staff
    const ordinary = roster.find((m) => m.person.id === 'member-600')!;
    expect(ordinary.position).toBe('Member');
    expect(ordinary.membershipType).toBe('member');
  });

  test('joins staff committee positions by exact office id and dedupes by source membership id', () => {
    const roster = idx.membershipsByCommitteeId.get('committee-100')!;
    const staffRows = roster.filter((m) => m.person.id === 'staff-1');
    expect(staffRows).toHaveLength(1); // deduped despite the repeated position id 20
    expect(staffRows[0]!.membershipType).toBe('staff');
    // The staff member-office position (office 950) is NOT a committee membership.
    expect(idx.committeesByPersonId.get('staff-1')).toEqual(['committee-100']);
  });

  test('builds the reverse person -> committee index (incl. subcommittee)', () => {
    expect(new Set(idx.committeesByPersonId.get('member-600'))).toEqual(
      new Set(['committee-100', 'committee-101']),
    );
    expect(idx.committeesByPersonId.get('member-500')).toEqual(['committee-100']);
  });

  test('normalized person-name index inverts ordinary members AND staff to person ids', () => {
    expect(idx.normalizedPersonNameIndex.get('ada ordinary')).toEqual(['member-600']);
    expect(idx.normalizedPersonNameIndex.get('grace hopper')).toEqual(['staff-1']);
    expect(idx.normalizedPersonNameIndex.get('mike rogers')).toEqual(['member-500']);
  });

  test('committee aliases map normalized name + code to office id (for query matching only)', () => {
    expect(idx.committeeAliases.get('hsas')).toBe(100);
    expect(idx.committeeAliases.get('house armed services committee')).toBe(100);
  });

  test('member ref carries source photo provenance; ordinary member without a photo is null', () => {
    const roster = idx.membershipsByCommitteeId.get('committee-100')!;
    const chair = roster.find((m) => m.person.id === 'member-500')!;
    expect(chair.person.photoUrl).toBe('https://x.invalid/rogers.jpg');
    expect(chair.person.photoSource).toBe('legistorm');
    const ordinary = roster.find((m) => m.person.id === 'member-600')!;
    expect(ordinary.person.photoUrl).toBeNull();
    expect(ordinary.person.photoSource).toBeNull();
  });

  test('normalizePersonName strips punctuation, suffixes, and case', () => {
    expect(normalizePersonName("O'Brien, Pat Jr.")).toBe('o brien pat');
    expect(normalizePersonName('  Alex   Example  ')).toBe('alex example');
  });
});
