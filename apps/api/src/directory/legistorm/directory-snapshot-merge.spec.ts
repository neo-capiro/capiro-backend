import { describe, expect, test } from '@jest/globals';
import memberPage from './__fixtures__/member-page.json';
import officePage from './__fixtures__/office-page.json';
import staffPage from './__fixtures__/staff-page.json';
import { DirectorySnapshotMergeError, mergeDirectorySnapshot } from './directory-snapshot-merge.js';

const EMPTY_COUNTS = {
  inserted: 0,
  updated: 0,
  unchanged: 0,
  retired: 0,
  duplicate: 0,
  malformed: 0,
};

function member(id: number, marker: string) {
  return {
    ...structuredClone(memberPage[0]!),
    member: { ...structuredClone(memberPage[0]!.member), member_id: id },
    fixture_marker: marker,
  };
}

function staff(id: number, marker: string) {
  return {
    ...structuredClone(staffPage[0]!),
    staff: { ...structuredClone(staffPage[0]!.staff), id },
    fixture_marker: marker,
  };
}

function office(id: number, marker: string) {
  return {
    ...structuredClone(officePage[0]!),
    office: { ...structuredClone(officePage[0]!.office), office_id: id },
    fixture_marker: marker,
  };
}

describe('mergeDirectorySnapshot', () => {
  test('replaces members from the complete current response and emits deterministic counts', () => {
    const unchanged = member(1, 'same');
    const previous = {
      members: [member(4, 'departed'), member(2, 'old'), unchanged],
      staff: [],
      offices: [],
    };
    const incoming = {
      members: [member(3, 'inserted'), structuredClone(unchanged), member(2, 'updated')],
      staff: [],
      offices: [],
    };

    const result = mergeDirectorySnapshot({
      mode: 'incremental',
      previous,
      incoming,
      retiredIds: { office: [], staff: [] },
    });

    expect(result.active.members.map((record) => record.member.member_id)).toEqual([1, 2, 3]);
    expect(result.active.members[1]!.fixture_marker).toBe('updated');
    expect(result.counts.members).toEqual({
      ...EMPTY_COUNTS,
      inserted: 1,
      updated: 1,
      unchanged: 1,
      retired: 1,
    });
  });

  test('incrementally upserts staff and offices, preserves untouched records, and applies retirements', () => {
    const untouchedStaff = { ...staff(10, 'untouched'), future_prior_field: { retained: true } };
    const insertedStaff = { ...staff(30, 'inserted'), future_incoming_field: ['retained'] };
    const untouchedOffice = { ...office(100, 'untouched'), future_prior_field: 'retained' };
    const previous = {
      members: [],
      staff: [staff(40, 'retired'), staff(20, 'old'), untouchedStaff],
      offices: [office(300, 'retired'), office(200, 'old'), untouchedOffice],
    };
    const incoming = {
      members: [],
      staff: [insertedStaff, staff(20, 'updated')],
      offices: [office(250, 'inserted'), office(200, 'updated')],
    };

    const result = mergeDirectorySnapshot({
      mode: 'incremental',
      previous,
      incoming,
      retiredIds: { office: [999, 300], staff: [999, 40] },
    });

    expect(result.active.staff.map((record) => record.staff.id)).toEqual([10, 20, 30]);
    expect(result.active.offices.map((record) => record.office.office_id)).toEqual([100, 200, 250]);
    expect(result.active.staff[0]).toEqual(untouchedStaff);
    expect(result.active.staff[2]).toEqual(insertedStaff);
    expect(result.active.offices[0]).toEqual(untouchedOffice);
    expect(result.counts.staff).toEqual({
      ...EMPTY_COUNTS,
      inserted: 1,
      updated: 1,
      unchanged: 1,
      retired: 1,
    });
    expect(result.counts.offices).toEqual({
      ...EMPTY_COUNTS,
      inserted: 1,
      updated: 1,
      unchanged: 1,
      retired: 1,
    });
  });

  test('full mode rebuilds staff and offices instead of carrying prior rows forward', () => {
    const sameStaff = staff(2, 'same');
    const sameOffice = office(20, 'same');
    const result = mergeDirectorySnapshot({
      mode: 'full',
      previous: {
        members: [],
        staff: [staff(1, 'omitted'), sameStaff],
        offices: [office(10, 'omitted'), sameOffice],
      },
      incoming: {
        members: [],
        staff: [staff(3, 'inserted-but-retired'), structuredClone(sameStaff)],
        offices: [office(30, 'inserted-but-retired'), structuredClone(sameOffice)],
      },
      retiredIds: { office: [30], staff: [3] },
    });

    expect(result.active.staff.map((record) => record.staff.id)).toEqual([2]);
    expect(result.active.offices.map((record) => record.office.office_id)).toEqual([20]);
    expect(result.counts.staff).toEqual({
      ...EMPTY_COUNTS,
      inserted: 1,
      unchanged: 1,
      retired: 2,
    });
    expect(result.counts.offices).toEqual({
      ...EMPTY_COUNTS,
      inserted: 1,
      unchanged: 1,
      retired: 2,
    });
  });

  test('persists complete, sorted, de-duplicated retired-ID tombstones', () => {
    const result = mergeDirectorySnapshot({
      mode: 'incremental',
      previous: { members: [], staff: [], offices: [] },
      incoming: { members: [], staff: [], offices: [] },
      retiredIds: { office: [9, 7, 9], staff: [8, 6, 8] },
    });

    expect(result.tombstones).toEqual({ office: [7, 9], staff: [6, 8] });
    expect(result.counts.total).toEqual(EMPTY_COUNTS);
  });

  test('rejects duplicate stable IDs and reports the duplicate count', () => {
    let error: unknown;
    try {
      mergeDirectorySnapshot({
        mode: 'incremental',
        previous: { members: [], staff: [], offices: [] },
        incoming: { members: [member(1, 'a'), member(1, 'b')], staff: [], offices: [] },
        retiredIds: { office: [], staff: [] },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DirectorySnapshotMergeError);
    expect((error as DirectorySnapshotMergeError).counts).toMatchObject({
      duplicate: 1,
      malformed: 0,
    });
    expect((error as Error).message).toContain('duplicate member ID 1');
  });

  test('rejects malformed records and reports the malformed count', () => {
    let error: unknown;
    try {
      mergeDirectorySnapshot({
        mode: 'incremental',
        previous: { members: [], staff: [], offices: [] },
        incoming: { members: [], staff: [{ staff: { first_name: 'Missing ID' } }], offices: [] },
        retiredIds: { office: [], staff: [] },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DirectorySnapshotMergeError);
    expect((error as DirectorySnapshotMergeError).counts).toMatchObject({
      duplicate: 0,
      malformed: 1,
    });
    expect((error as Error).message).toContain('malformed staff record');
  });

  test('rejects valid IDs when required identity fields are missing in prior or incoming rows', () => {
    const cases: Array<{
      collection: 'members' | 'staff' | 'offices';
      record: unknown;
      message: string;
    }> = [
      { collection: 'members', record: { member: { member_id: 1 } }, message: 'malformed member record' },
      { collection: 'staff', record: { staff: { id: 1 } }, message: 'malformed staff record' },
      { collection: 'offices', record: { office: { office_id: 1 } }, message: 'malformed office record' },
    ];

    for (const testCase of cases) {
      for (const location of ['previous', 'incoming'] as const) {
        const input = {
          mode: 'incremental' as const,
          previous: { members: [], staff: [], offices: [] } as {
            members: unknown[];
            staff: unknown[];
            offices: unknown[];
          },
          incoming: { members: [], staff: [], offices: [] } as {
            members: unknown[];
            staff: unknown[];
            offices: unknown[];
          },
          retiredIds: { office: [], staff: [] },
        };
        input[location][testCase.collection] = [testCase.record];

        expect(() => mergeDirectorySnapshot(input)).toThrow(testCase.message);
      }
    }
  });

  test('does not mutate inputs and produces identical output for shuffled input order', () => {
    const firstInput = {
      mode: 'incremental' as const,
      previous: {
        members: [member(2, 'same'), member(1, 'same')],
        staff: [staff(2, 'same'), staff(1, 'same')],
        offices: [office(2, 'same'), office(1, 'same')],
      },
      incoming: {
        members: [member(1, 'same'), member(2, 'same')],
        staff: [staff(1, 'same'), staff(2, 'same')],
        offices: [office(1, 'same'), office(2, 'same')],
      },
      retiredIds: { office: [], staff: [] },
    };
    const before = structuredClone(firstInput);
    const secondInput = structuredClone(firstInput);
    secondInput.previous.members.reverse();
    secondInput.previous.staff.reverse();
    secondInput.previous.offices.reverse();
    secondInput.incoming.members.reverse();
    secondInput.incoming.staff.reverse();
    secondInput.incoming.offices.reverse();

    const first = mergeDirectorySnapshot(firstInput);
    const second = mergeDirectorySnapshot(secondInput);

    expect(firstInput).toEqual(before);
    expect(second).toEqual(first);
  });
});
