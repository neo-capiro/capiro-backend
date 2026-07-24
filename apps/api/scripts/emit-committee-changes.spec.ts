import { describe, expect, test } from '@jest/globals';
import {
  buildDedupeKey,
  buildTitleAndDescription,
  diffCommitteeMemberships,
  severityFor,
  type CurrentMembership,
  type DetectedChange,
  type WatchRow,
} from './emit-committee-changes.js';

const membership = (overrides: Partial<CurrentMembership> = {}): CurrentMembership => ({
  committeeId: 'committee-2053',
  personId: 'member-533',
  personName: 'Roger Wicker',
  role: null,
  ...overrides,
});

const watch = (overrides: Partial<WatchRow> = {}): WatchRow => ({
  committeeId: 'committee-2053',
  personId: 'member-533',
  personName: 'Roger Wicker',
  role: null,
  ...overrides,
});

describe('diffCommitteeMemberships', () => {
  test('isFirstRun=true always returns zero changes, regardless of input', () => {
    const changes = diffCommitteeMemberships([membership()], [], true);
    expect(changes).toEqual([]);
  });

  test('a membership present now but not in the watch table is a gain', () => {
    const changes = diffCommitteeMemberships([membership()], [], false);
    expect(changes).toEqual([
      {
        committeeId: 'committee-2053',
        personId: 'member-533',
        personName: 'Roger Wicker',
        changeType: 'committee_seat_gained',
        newRole: null,
        oldRole: null,
      },
    ]);
  });

  test('a watch row present before but not in current memberships is a loss', () => {
    const changes = diffCommitteeMemberships([], [watch({ role: 'Chair' })], false);
    expect(changes).toEqual([
      {
        committeeId: 'committee-2053',
        personId: 'member-533',
        personName: 'Roger Wicker',
        changeType: 'committee_seat_lost',
        newRole: null,
        oldRole: 'Chair',
      },
    ]);
  });

  test('a role that differs between watch and current is a role change, not a gain or loss', () => {
    const changes = diffCommitteeMemberships(
      [membership({ role: 'Chair' })],
      [watch({ role: 'Co-Chair' })],
      false,
    );
    expect(changes).toEqual([
      {
        committeeId: 'committee-2053',
        personId: 'member-533',
        personName: 'Roger Wicker',
        changeType: 'committee_role_changed',
        newRole: 'Chair',
        oldRole: 'Co-Chair',
      },
    ]);
  });

  test('an identical role between watch and current produces NO change at all', () => {
    const changes = diffCommitteeMemberships([membership({ role: 'Chair' })], [watch({ role: 'Chair' })], false);
    expect(changes).toEqual([]);
  });

  test('null and null (both plain member, never promoted) is not a change', () => {
    const changes = diffCommitteeMemberships([membership({ role: null })], [watch({ role: null })], false);
    expect(changes).toEqual([]);
  });

  test('one gain, one loss, one role change, and one unchanged row across multiple committees, all in one pass', () => {
    const current: CurrentMembership[] = [
      membership({ committeeId: 'c1', personId: 'p1', personName: 'New Member', role: null }),
      membership({ committeeId: 'c2', personId: 'p2', personName: 'Promoted Member', role: 'Chair' }),
      membership({ committeeId: 'c3', personId: 'p3', personName: 'Unchanged Member', role: 'Member' }),
    ];
    const previous: WatchRow[] = [
      watch({ committeeId: 'c2', personId: 'p2', personName: 'Promoted Member', role: 'Member' }),
      watch({ committeeId: 'c3', personId: 'p3', personName: 'Unchanged Member', role: 'Member' }),
      watch({ committeeId: 'c4', personId: 'p4', personName: 'Departed Member', role: 'Ranking Member' }),
    ];

    const changes = diffCommitteeMemberships(current, previous, false);
    const byPerson = new Map(changes.map((c) => [c.personId, c]));

    expect(changes).toHaveLength(3);
    expect(byPerson.get('p1')?.changeType).toBe('committee_seat_gained');
    expect(byPerson.get('p2')?.changeType).toBe('committee_role_changed');
    expect(byPerson.get('p4')?.changeType).toBe('committee_seat_lost');
    expect(byPerson.has('p3')).toBe(false); // unchanged — must not appear at all
  });
});

describe('severityFor', () => {
  test('gaining a Chair role is critical', () => {
    const change: DetectedChange = {
      committeeId: 'c1',
      personId: 'p1',
      personName: 'X',
      changeType: 'committee_seat_gained',
      newRole: 'Chair',
      oldRole: null,
    };
    expect(severityFor(change)).toBe('critical');
  });

  test('losing a Chair role is ALSO critical — a power shift either direction', () => {
    const change: DetectedChange = {
      committeeId: 'c1',
      personId: 'p1',
      personName: 'X',
      changeType: 'committee_seat_lost',
      newRole: null,
      oldRole: 'Chair',
    };
    expect(severityFor(change)).toBe('critical');
  });

  test('a plain gain/loss/role-change with no chair involved is notable, never info/critical', () => {
    const gained: DetectedChange = {
      committeeId: 'c1',
      personId: 'p1',
      personName: 'X',
      changeType: 'committee_seat_gained',
      newRole: null,
      oldRole: null,
    };
    expect(severityFor(gained)).toBe('notable');
  });

  test('"Ranking Member" — a genuinely senior role, but deliberately NOT in the critical heuristic — stays notable', () => {
    const change: DetectedChange = {
      committeeId: 'c1',
      personId: 'p1',
      personName: 'X',
      changeType: 'committee_role_changed',
      newRole: 'Ranking Member',
      oldRole: 'Member',
    };
    expect(severityFor(change)).toBe('notable');
  });

  test('never returns the emit-state-changes.ts vocabulary ("high"/"medium")', () => {
    const change: DetectedChange = {
      committeeId: 'c1',
      personId: 'p1',
      personName: 'X',
      changeType: 'committee_seat_gained',
      newRole: 'Chair',
      oldRole: null,
    };
    expect(['critical', 'notable', 'info']).toContain(severityFor(change));
  });
});

describe('buildDedupeKey', () => {
  test('is deterministic and distinguishes change types for the same committee/person', () => {
    const gained: DetectedChange = {
      committeeId: 'c1',
      personId: 'p1',
      personName: 'X',
      changeType: 'committee_seat_gained',
      newRole: 'Chair',
      oldRole: null,
    };
    const lost: DetectedChange = { ...gained, changeType: 'committee_seat_lost', newRole: null, oldRole: 'Chair' };
    expect(buildDedupeKey(gained)).toBe('committee_membership:c1:p1:committee_seat_gained:Chair');
    expect(buildDedupeKey(lost)).toBe('committee_membership:c1:p1:committee_seat_lost:Chair');
    expect(buildDedupeKey(gained)).not.toBe(buildDedupeKey(lost));
  });

  test('falls back to "none" when both newRole and oldRole are null, rather than crashing', () => {
    const change: DetectedChange = {
      committeeId: 'c1',
      personId: 'p1',
      personName: 'X',
      changeType: 'committee_seat_gained',
      newRole: null,
      oldRole: null,
    };
    expect(buildDedupeKey(change)).toBe('committee_membership:c1:p1:committee_seat_gained:none');
  });
});

describe('buildTitleAndDescription', () => {
  test('a gain with a role names the role in the title', () => {
    const { title } = buildTitleAndDescription({
      committeeId: 'c1',
      personId: 'p1',
      personName: 'Jane Smith',
      changeType: 'committee_seat_gained',
      newRole: 'Chair',
      oldRole: null,
    });
    expect(title).toBe('Jane Smith named Chair of a tracked committee');
  });

  test('a plain-member gain (no role) reads naturally without "named null"', () => {
    const { title } = buildTitleAndDescription({
      committeeId: 'c1',
      personId: 'p1',
      personName: 'Jane Smith',
      changeType: 'committee_seat_gained',
      newRole: null,
      oldRole: null,
    });
    expect(title).toBe('Jane Smith joined a tracked committee');
    expect(title).not.toContain('null');
  });

  test('a role change describes both the old and new role', () => {
    const { description } = buildTitleAndDescription({
      committeeId: 'c1',
      personId: 'p1',
      personName: 'Jane Smith',
      changeType: 'committee_role_changed',
      newRole: 'Chair',
      oldRole: 'Member',
    });
    expect(description).toContain('Member');
    expect(description).toContain('Chair');
  });
});
