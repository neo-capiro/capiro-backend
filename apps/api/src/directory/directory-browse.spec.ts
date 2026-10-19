import { describe, expect, test } from '@jest/globals';
import { DirectoryBrowse } from './directory-browse.js';
import type {
  DirectoryCommittee,
  DirectoryCommitteeStaffer,
  DirectoryContact,
  DirectoryStaffer,
} from './directory.types.js';

function contact(id: string, memberName: string, staff: DirectoryContact['staff'] = []): DirectoryContact {
  return {
    id,
    memberName,
    fullName: `Rep. ${memberName}`,
    title: 'Member of Congress',
    office: `${memberName} office`,
    state: 'VA',
    district: 'VA-1',
    party: 'D',
    partyName: 'Democrat',
    phone: '',
    email: '',
    contactFormUrl: '',
    focusAreas: [],
    committees: [],
    leadershipPositions: [],
    caucuses: [],
    educationInstitutions: [],
    staff,
    isFreshman: false,
    chamber: 'House',
    region: 'South',
    gender: 'Unknown',
    lastTouchpoint: '2026-01-01',
  } as unknown as DirectoryContact;
}

describe('DirectoryBrowse', () => {
  describe('toPositiveInt', () => {
    const browse = new DirectoryBrowse();

    test.each([0.5, '0.5', '0.999', Number.MIN_VALUE])(
      'uses the fallback when %p rounds down to zero',
      (raw) => {
        expect(browse.toPositiveInt(raw, 1)).toBe(1);
        expect(browse.toPositiveInt(raw, 24, 20_000)).toBe(24);
      },
    );

    test.each([
      undefined,
      null,
      '',
      ' ',
      0,
      '0',
      -1,
      '-0.5',
      'invalid',
      NaN,
      Infinity,
      'Infinity',
      -Infinity,
      '-Infinity',
    ])('preserves the fallback for %p', (raw) => {
      expect(browse.toPositiveInt(raw, 24, 20_000)).toBe(24);
    });

    test.each([
      [1, 1],
      ['1', 1],
      [24, 24],
      ['24', 24],
      [2.9, 2],
      ['2.9', 2],
    ])('normalizes %p to the positive integer %p', (raw, expected) => {
      expect(browse.toPositiveInt(raw, 24)).toBe(expected);
    });

    test.each([20_000, '20000.9', 20_001, '20001'])('caps %p at the maximum', (raw) => {
      expect(browse.toPositiveInt(raw, 24, 20_000)).toBe(20_000);
    });

    test('does not apply the maximum to the fallback', () => {
      expect(browse.toPositiveInt('invalid', 24, 10)).toBe(24);
      expect(browse.toPositiveInt('0.5', 24, 10)).toBe(24);
    });
  });

  test('returns the first page with the default size for fractional pagination below one', () => {
    const browse = new DirectoryBrowse();
    const base = {
      sourceId: 'snapshot',
      contacts: [contact('member-a', 'Ada Aaron'), contact('member-b', 'Casey South')],
      totals: {} as never,
      availableStates: ['VA'],
      availableFilters: {} as never,
    };
    const page = browse.toPositiveInt('0.5', 1);
    const pageSize = browse.toPositiveInt('0.5', 24, 20_000);

    const result = browse.toPagedPayload(base, { sort: 'name-asc' }, page, pageSize);

    expect(result).toMatchObject({ total: 2, page: 1, pageSize: 24 });
    expect(result.contacts.map((entry) => entry.id)).toEqual(['member-a', 'member-b']);
  });

  test('returns staffers with default pagination for fractions below one', () => {
    const browse = new DirectoryBrowse();
    const staffers = [
      {
        id: 'staff-a',
        fullName: 'Morgan Lane',
        title: 'Scheduler',
        email: '',
        phone: '',
        roles: [],
        issueAreas: [],
        member: { memberName: 'Ada Aaron', fullName: 'Rep. Ada Aaron', state: 'VA', chamber: 'House' },
      },
    ] as unknown as DirectoryStaffer[];
    const page = browse.toPositiveInt('0.5', 1);
    const pageSize = browse.toPositiveInt('0.5', 24, 20_000);

    const result = browse.toStaffersPayload(staffers, {}, page, pageSize);

    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 24 });
    expect(result.staffers.map((entry) => entry.id)).toEqual(['staff-a']);
  });

  test('returns committees with default pagination for fractions below one', () => {
    const browse = new DirectoryBrowse();
    const committees = [
      {
        id: 'committee-h',
        name: 'House Armed Services',
        committeeCode: 'HSAS',
        chamber: 'House',
        kind: 'committee',
      },
    ] as unknown as DirectoryCommittee[];
    const page = browse.toPositiveInt('0.5', 1);
    const pageSize = browse.toPositiveInt('0.5', 24, 20_000);

    const result = browse.toCommitteesPayload(committees, {}, page, pageSize);

    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 24 });
    expect(result.committees.map((entry) => entry.id)).toEqual(['committee-h']);
  });

  test('returns committee staff with default pagination for fractions below one', () => {
    const browse = new DirectoryBrowse();
    const committees = [
      {
        id: 'committee-h',
        name: 'House Armed Services',
        committeeCode: 'HSAS',
        chamber: 'House',
        kind: 'committee',
      },
    ] as unknown as DirectoryCommittee[];
    const roster = new Map([
      ['committee-h', [{ id: 'staff-h', fullName: 'Sam Counsel', title: 'Counsel' }]],
    ]) as unknown as Map<string, DirectoryCommitteeStaffer[]>;
    const page = browse.toPositiveInt('0.5', 1);
    const pageSize = browse.toPositiveInt('0.5', 24, 20_000);

    const result = browse.toCommitteeStaffPayload(
      'committee-h',
      committees,
      roster,
      {},
      page,
      pageSize,
    );

    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 24 });
    expect(result.staff.map((entry) => entry.id)).toEqual(['staff-h']);
  });

  test('ranks own-name matches before staff-only matches and leaves cached contacts untouched', () => {
    const browse = new DirectoryBrowse();
    const staffOnly = contact('member-a', 'Ada Aaron', [
      {
        id: 'staff-a',
        fullName: 'Casey South',
        title: 'Scheduler',
        email: '',
        phone: '',
        roles: [],
        issueAreas: [],
      } as unknown as DirectoryContact['staff'][number],
    ]);
    const ownName = contact('member-b', 'Casey South');
    const base = {
      sourceId: 'snapshot',
      contacts: [staffOnly, ownName],
      totals: {} as never,
      availableStates: ['VA'],
      availableFilters: {} as never,
    };
    const query = { q: 'south casey', sort: 'name-asc' } as const;

    const first = browse.toPagedPayload(base, query, 1, 1);
    const second = browse.toPagedPayload(base, query, 99, 1);

    expect(first.contacts.map((entry) => entry.id)).toEqual(['member-b']);
    expect(second).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(second.contacts[0]).toMatchObject({
      id: 'member-a',
      matchedStaff: [{ fullName: 'Casey South', title: 'Scheduler' }],
    });
    expect('matchedStaff' in staffOnly).toBe(false);
  });

  test('applies staffer search and structured filters before clamping the page', () => {
    const browse = new DirectoryBrowse();
    const staffers = [
      {
        id: 'staff-a',
        fullName: 'Morgan Lane',
        title: 'Scheduler',
        email: '',
        phone: '',
        roles: ['Scheduler'],
        issueAreas: ['Health'],
        member: { memberName: 'Ada Aaron', fullName: 'Rep. Ada Aaron', state: 'VA', chamber: 'House' },
      },
      {
        id: 'staff-b',
        fullName: 'Taylor Lane',
        title: 'Scheduler',
        email: '',
        phone: '',
        roles: ['Scheduler'],
        issueAreas: ['Defense'],
        member: { memberName: 'Casey South', fullName: 'Rep. Casey South', state: 'MD', chamber: 'House' },
      },
    ] as unknown as DirectoryStaffer[];

    const result = browse.toStaffersPayload(
      staffers,
      { q: 'scheduler', chamber: 'House', state: ['VA'], issue: 'Health' },
      9,
      1,
    );
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect(result.staffers.map((entry) => entry.id)).toEqual(['staff-a']);
  });

  test('keeps committee code lookup and missing-roster behavior', () => {
    const browse = new DirectoryBrowse();
    const committees = [
      { id: 'committee-h', name: 'House Armed Services', committeeCode: 'HSAS', chamber: 'House', kind: 'committee' },
      { id: 'committee-s', name: 'Senate Armed Services', committeeCode: 'SSAS', chamber: 'Senate', kind: 'committee' },
    ] as unknown as DirectoryCommittee[];
    const list = browse.toCommitteesPayload(
      committees,
      { q: 'hsas', chamber: 'House', kind: 'committee' },
      1,
      10,
    );
    expect(list.committees.map((entry) => entry.id)).toEqual(['committee-h']);

    const roster = new Map([
      ['committee-h', [{ id: 'staff-h', fullName: 'Sam Counsel', title: 'Counsel' }]],
    ]) as unknown as Map<string, DirectoryCommitteeStaffer[]>;
    const found = browse.toCommitteeStaffPayload('committee-h', committees, roster, { q: 'counsel' }, 3, 1);
    expect(found).toMatchObject({ total: 1, page: 1, staff: [{ id: 'staff-h' }] });
    const missing = browse.toCommitteeStaffPayload('committee-x', committees, roster, {}, 3, 1);
    expect(missing).toMatchObject({ committee: null, staff: [], total: 0, page: 1 });
  });
});
