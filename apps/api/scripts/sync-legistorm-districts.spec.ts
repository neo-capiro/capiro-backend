import { describe, expect, jest, test } from '@jest/globals';
import {
  ALL_DISTRICT_JURISDICTIONS,
  applyDistrictRows,
  fetchAllDistricts,
  fetchAndStoreKml,
  parseArgs,
  toLegislativeDistrictRow,
  type KmlStore,
  type LegislativeDistrictRow,
  type LegislativeDistrictStore,
  type LegiStormDistrictSource,
} from './sync-legistorm-districts.js';
import type { LegiStormCongressDistrictRecord } from '../src/directory/legistorm/legistorm-types.js';

const noSleep = async (_ms: number) => {};

const HOUSE_DC: LegiStormCongressDistrictRecord = {
  id: 271,
  office_type: 'House',
  state: 'DC',
  name: 'At-Large Congressional District of District of Columbia',
  district_no: 1, // live-verified as a JSON number, not the spec-documented string
  senate_class: null,
  members: [{ id: 564, bioguide_id: 'N000147' }],
  kml: 'https://www.legistorm.com/.../hash/SECRET/state_id/DC/.../1.html',
};

const HOUSE_TX_FUTURE: LegiStormCongressDistrictRecord = {
  id: 603,
  office_type: 'House',
  name: '25th Congressional District of Texas',
  state: 'TX',
  district_no: 25,
  senate_class: null,
  status: 'F',
  effective_date: '2027-01-03',
  enacted_date: '2025-08-28',
  members: [{ id: 2894, bioguide_id: 'W000816' }],
  // No `kml` field at all — represents the vendor genuinely omitting it, not
  // sending an explicit null/empty value.
};

const SENATE_TX: LegiStormCongressDistrictRecord = {
  id: 900,
  office_type: 'Senate',
  name: 'U.S. Senate Seat for Texas (Class 1)',
  state: 'TX',
  district_no: null,
  senate_class: 1,
  members: [],
};

describe('toLegislativeDistrictRow', () => {
  test('falls back to the requested status when the vendor response omits its own status field', () => {
    // Live-verified: /congress/zipcode can omit status/effective_date/enacted_date
    // entirely, while /congress/list?status=F always includes them.
    const row = toLegislativeDistrictRow(HOUSE_DC, 'C');
    expect(row.status).toBe('C');
    expect(row.id).toBe('271-C');
  });

  test('uses the vendor-reported status when present, even if it differs from what was requested', () => {
    const row = toLegislativeDistrictRow(HOUSE_TX_FUTURE, 'F');
    expect(row.status).toBe('F');
    expect(row.id).toBe('603-F');
    expect(row.effectiveDate?.toISOString().slice(0, 10)).toBe('2027-01-03');
    expect(row.enactedDate?.toISOString().slice(0, 10)).toBe('2025-08-28');
  });

  test('coerces a NUMBER district_no to a string (the live-verified wire shape, not the spec-documented one)', () => {
    const row = toLegislativeDistrictRow(HOUSE_DC, 'C');
    expect(row.districtNo).toBe('1');
    expect(typeof row.districtNo).toBe('string');
  });

  test('detects chamber from office_type, case-insensitively', () => {
    expect(toLegislativeDistrictRow(HOUSE_DC, 'C').chamber).toBe('house');
    expect(toLegislativeDistrictRow(SENATE_TX, 'C').chamber).toBe('senate');
    expect(toLegislativeDistrictRow({ ...HOUSE_DC, office_type: 'senate' }, 'C').chamber).toBe(
      'senate',
    );
  });

  test('a Senate seat has a null districtNo and a coerced senateClass', () => {
    const row = toLegislativeDistrictRow(SENATE_TX, 'C');
    expect(row.districtNo).toBeNull();
    expect(row.senateClass).toBe(1);
  });

  test('extracts bioguide ids, dropping any member without one', () => {
    const record: LegiStormCongressDistrictRecord = {
      ...HOUSE_DC,
      members: [
        { id: 1, bioguide_id: 'A000001' },
        { id: 2, bioguide_id: '' },
        { id: 3 } as unknown as LegiStormCongressDistrictRecord['members'][number],
      ],
    };
    expect(toLegislativeDistrictRow(record, 'C').currentMemberBioguides).toEqual(['A000001']);
  });

  test('kmlUrl is null when the vendor omits it, never a fabricated URL', () => {
    expect(toLegislativeDistrictRow(HOUSE_TX_FUTURE, 'F').kmlUrl).toBeNull();
    expect(toLegislativeDistrictRow(HOUSE_DC, 'C').kmlUrl).toBe(HOUSE_DC.kml);
  });

  test('kmlS3Key always starts null — only fetchAndStoreKml populates it', () => {
    expect(toLegislativeDistrictRow(HOUSE_DC, 'C').kmlS3Key).toBeNull();
  });
});

describe('fetchAllDistricts', () => {
  function fakeClient(byState: Record<string, LegiStormCongressDistrictRecord[]>): LegiStormDistrictSource {
    return {
      fetchCongressDistrictList: jest.fn(async (state: string, status?: 'C' | 'F') => ({
        records: (byState[state] ?? []).filter((r) =>
          status ? (r.status ?? 'C') === status : true,
        ),
        rawBody: [],
      })),
      fetchDistrictKml: jest.fn(async () => ''),
    };
  }

  test('fetches BOTH current and future for every jurisdiction and aggregates rows', async () => {
    const client = fakeClient({ DC: [HOUSE_DC], TX: [HOUSE_TX_FUTURE, SENATE_TX] });
    const result = await fetchAllDistricts(client, ['DC', 'TX'], noSleep, 0);

    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r) => r.id).sort()).toEqual(['271-C', '603-F', '900-C']);
    expect(result.fetchedByState.DC).toEqual({ current: 1, future: 0 });
    expect(result.fetchedByState.TX).toEqual({ current: 1, future: 1 });
    expect(client.fetchCongressDistrictList).toHaveBeenCalledTimes(4); // 2 jurisdictions x (C, F)
  });

  test('sleeps between jurisdictions when delayMs > 0, not within a single jurisdiction', async () => {
    const client = fakeClient({ DC: [HOUSE_DC], TX: [SENATE_TX] });
    const sleep = jest.fn(async () => {});
    await fetchAllDistricts(client, ['DC', 'TX'], sleep, 400);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(400);
  });

  test('an empty result for a jurisdiction is recorded as zero, not skipped', async () => {
    const client = fakeClient({});
    const result = await fetchAllDistricts(client, ['WY'], noSleep, 0);
    expect(result.rows).toHaveLength(0);
    expect(result.fetchedByState.WY).toEqual({ current: 0, future: 0 });
  });
});

describe('applyDistrictRows', () => {
  function fakeStore(existingIds: string[]): LegislativeDistrictStore & {
    reconciled: Array<{ rows: LegislativeDistrictRow[]; jurisdictions: readonly string[] }>;
  } {
    const reconciled: Array<{ rows: LegislativeDistrictRow[]; jurisdictions: readonly string[] }> = [];
    return {
      reconciled,
      existingIdsForStates: jest.fn(async () => new Set(existingIds)),
      applyReconciliation: jest.fn(async (rows, jurisdictions) => {
        reconciled.push({ rows, jurisdictions });
        return { removed: 2 };
      }),
    };
  }

  test('classifies insert vs update against a pre-fetch of existing ids, then delegates the write', async () => {
    const store = fakeStore(['271-C']);
    const rows = [toLegislativeDistrictRow(HOUSE_DC, 'C'), toLegislativeDistrictRow(HOUSE_TX_FUTURE, 'F')];

    const counts = await applyDistrictRows(store, rows, ['DC', 'TX']);

    expect(counts).toEqual({ inserted: 1, updated: 1, skipped: 0, errors: 0, removed: 2 });
    expect(store.existingIdsForStates).toHaveBeenCalledWith(['DC', 'TX']);
    expect(store.reconciled).toHaveLength(1);
    expect(store.reconciled[0]!.rows).toBe(rows);
  });

  test('every row is an insert when nothing pre-existed', async () => {
    const store = fakeStore([]);
    const rows = [toLegislativeDistrictRow(HOUSE_DC, 'C')];
    const counts = await applyDistrictRows(store, rows, ['DC']);
    expect(counts.inserted).toBe(1);
    expect(counts.updated).toBe(0);
  });
});

describe('fetchAndStoreKml', () => {
  test('fetches and stores only rows that have a kmlUrl, skipping null ones', async () => {
    const rows = [toLegislativeDistrictRow(HOUSE_DC, 'C'), toLegislativeDistrictRow(HOUSE_TX_FUTURE, 'F')];
    expect(rows[1]!.kmlUrl).toBeNull(); // sanity: this fixture genuinely has no KML

    const client = { fetchDistrictKml: jest.fn(async () => '<kml/>') };
    const stored: Array<{ id: string; text: string }> = [];
    const kmlStore: KmlStore = {
      store: jest.fn(async (row, text) => {
        stored.push({ id: row.id, text });
        return `s3://bucket/${row.id}.kml`;
      }),
    };

    const keys = await fetchAndStoreKml(client, kmlStore, rows, noSleep, 0);

    expect(client.fetchDistrictKml).toHaveBeenCalledTimes(1);
    expect(client.fetchDistrictKml).toHaveBeenCalledWith(rows[0]!.kmlUrl);
    expect(keys.get('271-C')).toBe('s3://bucket/271-C.kml');
    expect(keys.has('603-F')).toBe(false);
    expect(stored).toEqual([{ id: '271-C', text: '<kml/>' }]);
  });
});

describe('parseArgs', () => {
  test('defaults to dry-run, no KML, all jurisdictions', () => {
    const parsed = parseArgs(['node', 'script']);
    expect(parsed.commit).toBe(false);
    expect(parsed.withKml).toBe(false);
    expect(parsed.jurisdictions).toBe(ALL_DISTRICT_JURISDICTIONS);
  });

  test('--commit and --with-kml are independent flags', () => {
    const parsed = parseArgs(['node', 'script', '--commit', '--with-kml']);
    expect(parsed.commit).toBe(true);
    expect(parsed.withKml).toBe(true);
  });

  test('--states= scopes the run to an explicit, normalized jurisdiction list', () => {
    const parsed = parseArgs(['node', 'script', '--states=wy, dc ,tx']);
    expect(parsed.jurisdictions).toEqual(['WY', 'DC', 'TX']);
  });

  test('ALL_DISTRICT_JURISDICTIONS includes DC and the 5 non-voting-delegate territories', () => {
    for (const j of ['DC', 'PR', 'GU', 'AS', 'VI', 'MP']) {
      expect(ALL_DISTRICT_JURISDICTIONS).toContain(j);
    }
    expect(ALL_DISTRICT_JURISDICTIONS).toHaveLength(56); // 50 states + DC + 5 territories
  });
});
