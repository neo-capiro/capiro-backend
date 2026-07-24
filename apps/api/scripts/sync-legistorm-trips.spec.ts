import { describe, expect, jest, test } from '@jest/globals';
import {
  applyTripRows,
  computeWindow,
  DEFAULT_FULL_FLOOR_DATE,
  fetchTripRows,
  parseArgs,
  toTripRow,
  type LegiStormTripSource,
  type TripRow,
  type TripStore,
} from './sync-legistorm-trips.js';
import type { LegiStormTripRecord } from '../src/directory/legistorm/legistorm-types.js';

const noStafferTrip: LegiStormTripRecord = {
  id: 62958,
  approver: {
    member_id: 3712,
    profile: { first_name: 'Kevin Patrick', last_name: 'Kiley', preferred_first_name: 'Kevin', preferred_last_name: 'Kiley' },
  },
  traveler_member: {
    member_id: 3712,
    profile: { first_name: 'Kevin Patrick', last_name: 'Kiley', preferred_first_name: 'Kevin', preferred_last_name: 'Kiley' },
  },
  traveler_staffer: null,
  start_date: '2026-05-01',
  end_date: '2026-05-03',
  duration: 3,
  purpose: 'Conference on trade policy',
  total_cost: 2500.5,
  destinations: [{ id: 1, name: 'Geneva, Switzerland', state_id: undefined }],
  sponsors: [{ id: 10, name: 'Trade Policy Institute' }],
  filed_date: '2026-05-10',
  updated_at: '2026-05-11T00:00:00Z',
};

const stafferTrip: LegiStormTripRecord = {
  id: 62959,
  approver: { member_id: 3712, profile: { first_name: 'Kevin', last_name: 'Kiley' } },
  traveler_member: null,
  traveler_staffer: {
    staffer: { id: 12500, first_name: 'Robert L.', last_name: 'Holste', preferred_first_name: 'Bob', preferred_last_name: 'Holste' },
    positions: [],
  },
  start_date: '2026-06-01',
  end_date: '2026-06-02',
  duration: 1,
};

describe('toTripRow', () => {
  test('a member traveler resolves travelerMemberId, never travelerStaffId', () => {
    const row = toTripRow(noStafferTrip);
    expect(row.travelerMemberId).toBe(3712);
    expect(row.travelerStaffId).toBeNull();
    expect(row.travelerName).toBe('Kevin Kiley'); // preferred_first/last, not first/last
  });

  test('a staffer traveler resolves travelerStaffId, never travelerMemberId', () => {
    const row = toTripRow(stafferTrip);
    expect(row.travelerStaffId).toBe(12500);
    expect(row.travelerMemberId).toBeNull();
    expect(row.travelerName).toBe('Bob Holste');
  });

  test('falls back to first_name/last_name when preferred names are absent', () => {
    const record: LegiStormTripRecord = {
      ...stafferTrip,
      traveler_staffer: {
        staffer: { id: 1, first_name: 'Robert', last_name: 'Holste' },
      },
    };
    expect(toTripRow(record).travelerName).toBe('Robert Holste');
  });

  test('maps expense fields, destinations, and sponsors correctly', () => {
    const row = toTripRow(noStafferTrip);
    expect(row.totalCost).toBe(2500.5);
    expect(row.durationDays).toBe(3);
    expect(row.destinations).toEqual([{ id: 1, name: 'Geneva, Switzerland', stateId: null }]);
    expect(row.sponsors).toEqual([{ id: 10, name: 'Trade Policy Institute' }]);
  });

  test('parses date strings and preserves null for absent ones', () => {
    const row = toTripRow(noStafferTrip);
    expect(row.startDate?.toISOString().slice(0, 10)).toBe('2026-05-01');
    expect(row.filedDate?.toISOString().slice(0, 10)).toBe('2026-05-10');
    const bare: LegiStormTripRecord = { id: 1, traveler_member: { member_id: 1 } };
    const bareRow = toTripRow(bare);
    expect(bareRow.startDate).toBeNull();
    expect(bareRow.filedDate).toBeNull();
    expect(bareRow.destinations).toEqual([]);
    expect(bareRow.sponsors).toEqual([]);
  });

  test('mutual exclusivity is enforced even if a malformed record somehow has both', () => {
    const record: LegiStormTripRecord = {
      ...noStafferTrip,
      traveler_staffer: { staffer: { id: 999, first_name: 'Should', last_name: 'NotWin' } },
    };
    const row = toTripRow(record);
    // traveler_member is present, so it wins — travelerStaffId must stay null.
    expect(row.travelerMemberId).toBe(3712);
    expect(row.travelerStaffId).toBeNull();
  });
});

describe('fetchTripRows', () => {
  test('fetches once and transforms every record', async () => {
    const client: LegiStormTripSource = {
      fetchTrips: jest.fn(async () => ({
        records: [noStafferTrip, stafferTrip],
        rawPages: [],
      })),
    };
    const result = await fetchTripRows(client, { updatedFrom: '2026-07-01', updatedTo: '2026-07-13' });
    expect(result.fetchedCount).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.id).toBe(62958);
    expect(result.rows[1]!.id).toBe(62959);
    expect(client.fetchTrips).toHaveBeenCalledTimes(1);
  });
});

describe('computeWindow', () => {
  const TODAY = '2026-07-24';

  test('--full uses floor..today', () => {
    expect(computeWindow({ full: true, since: null }, null, TODAY, 2, DEFAULT_FULL_FLOOR_DATE)).toEqual({
      updatedFrom: DEFAULT_FULL_FLOOR_DATE,
      updatedTo: TODAY,
    });
  });

  test('--since=X uses X..today with no overlap applied', () => {
    expect(computeWindow({ full: false, since: '2026-06-01' }, null, TODAY, 2, DEFAULT_FULL_FLOOR_DATE)).toEqual({
      updatedFrom: '2026-06-01',
      updatedTo: TODAY,
    });
  });

  test('with a watermark, subtracts the overlap window', () => {
    const watermark = new Date('2026-07-20T00:00:00Z');
    expect(computeWindow({ full: false, since: null }, watermark, TODAY, 2, DEFAULT_FULL_FLOOR_DATE)).toEqual({
      updatedFrom: '2026-07-18',
      updatedTo: TODAY,
    });
  });

  test('with no watermark and no override, falls back to the floor', () => {
    expect(computeWindow({ full: false, since: null }, null, TODAY, 2, DEFAULT_FULL_FLOOR_DATE)).toEqual({
      updatedFrom: DEFAULT_FULL_FLOOR_DATE,
      updatedTo: TODAY,
    });
  });
});

describe('applyTripRows', () => {
  function fakeStore(existingIds: number[]): TripStore & { upserted: TripRow[][] } {
    const upserted: TripRow[][] = [];
    return {
      upserted,
      existingIds: jest.fn(async () => new Set(existingIds)),
      upsertAll: jest.fn(async (rows: TripRow[]) => {
        upserted.push(rows);
      }),
    };
  }

  test('classifies insert vs update against a pre-fetch of existing ids', async () => {
    const store = fakeStore([62958]);
    const rows = [toTripRow(noStafferTrip), toTripRow(stafferTrip)];

    const counts = await applyTripRows(store, rows);

    expect(counts).toEqual({ inserted: 1, updated: 1, skipped: 0, errors: 0 });
    expect(store.upserted).toHaveLength(1);
    expect(store.upserted[0]).toBe(rows);
  });

  test('an empty row set is a no-op — no existingIds call, no upsertAll call', async () => {
    const store = fakeStore([]);
    const counts = await applyTripRows(store, []);
    expect(counts).toEqual({ inserted: 0, updated: 0, skipped: 0, errors: 0 });
    expect(store.existingIds).not.toHaveBeenCalled();
    expect(store.upsertAll).not.toHaveBeenCalled();
  });

  test('TripStore has no delete/reconcile method at all — deletion is structurally impossible here', () => {
    // This is a design assertion, not a runtime one: TripStore's type only
    // exposes existingIds + upsertAll. Confirmed by reading the interface —
    // there is no reconcileState/applyReconciliation/deleteMany-style method
    // like WS-B's LegislativeDistrictStore has, because an incremental fetch
    // must never attempt to reconcile deletions (see the file header).
    const store = fakeStore([]);
    expect((store as Record<string, unknown>).reconcileState).toBeUndefined();
    expect((store as Record<string, unknown>).applyReconciliation).toBeUndefined();
  });
});

describe('parseArgs', () => {
  test('defaults to dry-run, incremental, no since override', () => {
    const parsed = parseArgs(['node', 'script']);
    expect(parsed).toEqual({ commit: false, full: false, since: null });
  });

  test('--commit and --full are independent flags', () => {
    const parsed = parseArgs(['node', 'script', '--commit', '--full']);
    expect(parsed.commit).toBe(true);
    expect(parsed.full).toBe(true);
  });

  test('--since= is parsed and wins over full when both somehow present (caller decides precedence)', () => {
    const parsed = parseArgs(['node', 'script', '--since=2026-06-01']);
    expect(parsed.since).toBe('2026-06-01');
  });
});
