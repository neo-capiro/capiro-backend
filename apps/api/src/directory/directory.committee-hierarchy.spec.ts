import { expect, test } from '@jest/globals';
import { buildCommitteeIndex } from './directory-committee-index.js';

// Synthetic IDs deliberately differ from retained snapshot1882/1935. The raw
// type/name/null-parent combination is the evidenced chamber-boundary contract.
const house = {
  office_id: 9001,
  name: 'U.S. House of Representatives',
  office_type: 'Congressional Agency',
  parent_office: null,
};
const senate = {
  office_id: 9002,
  name: 'U.S. Senate',
  office_type: 'Congressional Agency',
  parent_office: null,
};
const committee = (office_id: number, office_type: string, parent: number | null) => ({
  office_id,
  name: `Synthetic ${office_type} ${office_id}`,
  office_type,
  congress_committee_code: `synthetic-${office_id}`,
  parent_office: parent === null ? null : { office_id: parent },
});
const offices = [
  house,
  senate,
  committee(10, 'House Committee', house.office_id),
  committee(11, 'House Subcommittee', 10),
  committee(20, 'Senate Committee', senate.office_id),
  committee(21, 'Senate Subcommittee', 20),
  committee(30, 'Joint Committee', null),
  committee(40, 'State House Committee', house.office_id),
];
const staff = [
  {
    staff: { id: 100, first_name: 'Synthetic', last_name: 'Staff' },
    positions: [
      { office: { office_id: 10 }, is_current: false, position_title: 'Former fellow' },
      { office: { office_id: 10 }, is_current: true, position_title: 'Director' },
    ],
  },
];
const members = [
  {
    member: { member_id: 200, profile: { first_name: 'Synthetic', last_name: 'Chair' } },
    committees: [{ committee_office: { office_id: 10 }, position: 'Chair' }],
  },
];

test.each(['array', 'legacy'])(
  'projects chamber boundaries with preserved committee data (%s)',
  (shape) => {
    const raw = shape === 'array' ? offices.map((office) => ({ office })) : { office: offices };
    const result = buildCommitteeIndex(raw, staff, members);
    const preProjected = offices.map((office) =>
      [10, 20].includes(office.office_id) ? { ...office, parent_office: null } : office,
    );
    const expected = buildCommitteeIndex({ office: preProjected }, staff, members);
    expect(result).toEqual(expected);
    expect(result.committees.map((row) => row.officeId)).toEqual([10, 11, 30, 20, 21]);
    expect(result.committees.map((row) => [row.officeId, row.parentOfficeId])).toEqual([
      [10, null],
      [11, 10],
      [30, null],
      [20, null],
      [21, 20],
    ]);
    expect(result.committees.find((row) => row.officeId === 10)).toMatchObject({
      staffCount: 1,
      chair: { id: 'member-200', name: 'Synthetic Chair' },
      committeeCode: 'synthetic-10',
    });
    expect(result.committeeStaff.get('committee-10')).toHaveLength(1);
    expect(result.committeeStaff.get('committee-10')?.[0]).toMatchObject({
      title: 'Director',
      isCurrent: true,
    });
    expect(result.committees.some((row) => [9001, 9002, 40].includes(row.officeId))).toBe(false);
  },
);

test.each([
  { name: 'Other Congressional Agency' },
  { office_type: 'Unknown' },
  { parent_office: { office_id: 9999 } },
  { parent_office: undefined },
  { name: 'U.S. Senate' },
])('does not flatten an unproven or mismatched chamber parent: %j', (patch) => {
  const result = buildCommitteeIndex(
    { office: [{ ...house, ...patch }, committee(10, 'House Committee', house.office_id)] },
    [],
    [],
  );
  expect(result.committees[0]?.parentOfficeId).toBe(house.office_id);
});

test.each(['missing', 'duplicate', 'conflicting-before', 'conflicting-after'])(
  'preserves %s ancestor references for hierarchy rejection',
  (mode) => {
    const conflicting = { ...house, name: 'Other agency' };
    const roots =
      mode === 'missing'
        ? []
        : mode === 'duplicate'
          ? [house, house]
          : mode === 'conflicting-before'
            ? [conflicting, house]
            : [house, conflicting];
    const wrapped = buildCommitteeIndex(
      [...roots, committee(10, 'House Committee', house.office_id)].map((office) => ({ office })),
      [],
      [],
    );
    expect(wrapped.committees[0]?.parentOfficeId).toBe(house.office_id);
  },
);

test('does not flatten subcommittee-to-chamber, Joint, cross-chamber, cycles, or absent committee links', () => {
  const rows = [
    house,
    senate,
    committee(11, 'House Subcommittee', house.office_id),
    committee(30, 'Joint Committee', senate.office_id),
    committee(10, 'House Committee', senate.office_id),
    committee(21, 'Senate Subcommittee', 10),
    committee(40, 'House Committee', 41),
    committee(41, 'House Subcommittee', 40),
    committee(50, 'Senate Subcommittee', 9999),
  ];
  const result = buildCommitteeIndex({ office: rows }, [], []);
  const parents = new Map(result.committees.map((row) => [row.officeId, row.parentOfficeId]));
  for (const row of rows.slice(2))
    expect(parents.get(row.office_id)).toBe(row.parent_office?.office_id);
});
