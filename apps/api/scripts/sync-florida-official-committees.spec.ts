import {
  deterministicId,
  assertAppliedInventory,
  expectedInventoryRecord,
  FLORIDA_SYNC_LOCAL_CONFIRM,
  FLORIDA_SYNC_NONLOCAL_CONFIRM,
  isActiveDirectoryRow,
  officialKey,
  retiredDirectorySourceEvidence,
  validateDatabaseUrl,
  validateSnapshot,
  verifiedAliasIds,
  type InventoryRow,
} from './sync-florida-official-committees';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Florida official committee inventory sync', () => {
  const row = (overrides: Partial<InventoryRow> = {}): InventoryRow => ({
    chamber: 'house',
    officialCode: '3277',
    name: 'Budget Subcommittee',
    officialUrl: 'https://flhouse.gov/Sections/Committees/committeesdetail.aspx?CommitteeId=3277',
    listingOnly: false,
    existing: [],
    ...overrides,
  });

  it('uses calendar-compatible keys for house and senate, but a directory-only joint namespace', () => {
    expect(officialKey(row())).toBe('FL:2026:fl:house:committee:3277');
    expect(officialKey(row({ chamber: 'senate', officialCode: 'AP' }))).toBe(
      'FL:2026:fl:senate:AP',
    );
    expect(officialKey(row({ chamber: 'joint', officialCode: 'JLBC' }))).toBe(
      'FL:directory:fl:joint:JLBC',
    );
  });

  it('records only verified legacy duplicate IDs, excluding the chosen official row', () => {
    const rowWithDuplicates = row({
      existing: [
        { id: 'official-existing', chamber: 'senate', officialSourceKey: 'FL:2026:fl:senate:AP' },
        { id: 'FL-upper-appropriations', chamber: 'upper', officialSourceKey: null },
        { id: 'FL-old-other', chamber: 'upper', officialSourceKey: null },
      ],
    });
    expect(verifiedAliasIds(rowWithDuplicates, 'official-existing')).toEqual([
      'FL-upper-appropriations',
      'FL-old-other',
    ]);
    expect(verifiedAliasIds(rowWithDuplicates, 'FL-upper-appropriations')).toEqual([
      'FL-old-other',
    ]);
  });

  it('is deterministic and does not use a committee name for identity', () => {
    expect(deterministicId('FL:2026:fl:house:committee:3277')).toBe(
      deterministicId('FL:2026:fl:house:committee:3277'),
    );
    expect(deterministicId('FL:2026:fl:house:committee:3277')).not.toBe(
      deterministicId('FL:2026:fl:house:committee:3278'),
    );
  });

  it('rejects incorrect counts and duplicate keys', () => {
    const base = {
      checkedAt: '2026-09-18T13:32:56.788Z',
      provenance: { comparisonArtifact: 'artifact', sources: {} },
      counts: { house: 1, senate: 0, joint: 0, total: 1 },
      rows: [row()],
    };
    expect(() => validateSnapshot(base as never)).toThrow('exactly 66');
    const duplicate = {
      ...base,
      counts: { house: 34, senate: 27, joint: 5, total: 66 },
      rows: [
        ...Array.from({ length: 34 }, (_, i) => row({ officialCode: String(i === 33 ? 0 : i) })),
        ...Array.from({ length: 27 }, (_, i) => row({ chamber: 'senate', officialCode: `S${i}` })),
        ...Array.from({ length: 5 }, (_, i) => row({ chamber: 'joint', officialCode: `J${i}` })),
      ],
    };
    expect(() => validateSnapshot(duplicate as never)).toThrow('duplicate official keys');
  });

  it('keeps local and non-local apply confirmations separate', () => {
    expect(() =>
      validateDatabaseUrl(true, {
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/capiro',
      }),
    ).toThrow(`FLORIDA_SYNC_CONFIRM=${FLORIDA_SYNC_LOCAL_CONFIRM}`);
    expect(
      validateDatabaseUrl(true, {
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/capiro',
        FLORIDA_SYNC_CONFIRM: FLORIDA_SYNC_LOCAL_CONFIRM,
      }).hostname,
    ).toBe('localhost');

    const nonlocal = 'postgresql://user:pass@db.internal:5432/capiro';
    expect(() => validateDatabaseUrl(false, { DATABASE_URL: nonlocal })).toThrow(
      'ALLOW_NONLOCAL_FLORIDA_SYNC=1',
    );
    expect(() =>
      validateDatabaseUrl(true, {
        DATABASE_URL: nonlocal,
        ALLOW_NONLOCAL_FLORIDA_SYNC: '1',
        FLORIDA_SYNC_CONFIRM: FLORIDA_SYNC_LOCAL_CONFIRM,
      }),
    ).toThrow(`FLORIDA_SYNC_CONFIRM=${FLORIDA_SYNC_NONLOCAL_CONFIRM}`);
    expect(
      validateDatabaseUrl(true, {
        DATABASE_URL: nonlocal,
        ALLOW_NONLOCAL_FLORIDA_SYNC: '1',
        FLORIDA_SYNC_CONFIRM: FLORIDA_SYNC_NONLOCAL_CONFIRM,
      }).hostname,
    ).toBe('db.internal');
  });

  it('ships the reviewed 66-row inventory and a guarded container command', () => {
    const apiRoot = join(__dirname, '..');
    const snapshot = JSON.parse(
      readFileSync(join(apiRoot, 'data/florida-official-committee-inventory.json'), 'utf8'),
    );
    expect(() => validateSnapshot(snapshot)).not.toThrow();
    expect(snapshot.counts).toEqual({ house: 34, senate: 27, joint: 5, total: 66 });
    const expectedRows = snapshot.rows.map(expectedInventoryRecord);
    expect(assertAppliedInventory(snapshot, expectedRows)).toBe(66);
    expect(() => assertAppliedInventory(snapshot, expectedRows.slice(1))).toThrow(
      'postcondition failed for 1 of 66 keys',
    );
    expect(() =>
      assertAppliedInventory(snapshot, [
        ...expectedRows,
        {
          state: 'FL',
          chamber: 'upper',
          name: 'Special Order Calendar Group',
          officialSourceKey: 'FL:2026:fl:senate:SOCG',
          legislativeSession: '2026',
        },
      ]),
    ).toThrow('unexpected active keys');

    const dockerfile = readFileSync(join(apiRoot, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY apps/api/data apps/api/data');
    expect(dockerfile).toContain('/workspace/apps/api/data /app/apps/api/data');

    const entrypoint = readFileSync(join(__dirname, 'entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('sync-florida-official-committees)');
    expect(entrypoint).toContain('scripts/sync-florida-official-committees.ts "$@"');
  });

  it('soft-retires stale directory rows without erasing their evidence', () => {
    const sourceEvidence = {
      priorSource: { observedAt: '2026-08-01T00:00:00Z' },
      directory: { sourceUrl: 'https://www.flsenate.gov/Committees/SOCG', aliasIds: [] },
    };
    const retired = retiredDirectorySourceEvidence(
      sourceEvidence,
      '2026-09-18T13:32:56.788Z',
    );

    expect(retired).toMatchObject({
      priorSource: sourceEvidence.priorSource,
      directory: {
        sourceUrl: 'https://www.flsenate.gov/Committees/SOCG',
        aliasIds: [],
        active: false,
        retiredAt: '2026-09-18T13:32:56.788Z',
        retirementReason: 'not-in-reviewed-inventory',
      },
    });
    expect(
      isActiveDirectoryRow({
        sourceEvidence: retired,
      }),
    ).toBe(false);
    expect(
      retiredDirectorySourceEvidence(retired, '2026-09-18T13:32:56.788Z'),
    ).toEqual(retired);
  });
});

export {};
