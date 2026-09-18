import { deterministicId, officialKey, validateSnapshot, verifiedAliasIds, type InventoryRow } from './sync-florida-official-committees';

describe('Florida official committee inventory sync', () => {
  const row = (overrides: Partial<InventoryRow> = {}): InventoryRow => ({
    chamber: 'house', officialCode: '3277', name: 'Budget Subcommittee',
    officialUrl: 'https://flhouse.gov/Sections/Committees/committeesdetail.aspx?CommitteeId=3277',
    listingOnly: false, existing: [], ...overrides,
  });

  it('uses calendar-compatible keys for house and senate, but a directory-only joint namespace', () => {
    expect(officialKey(row())).toBe('FL:2026:fl:house:committee:3277');
    expect(officialKey(row({ chamber: 'senate', officialCode: 'AP' }))).toBe('FL:2026:fl:senate:AP');
    expect(officialKey(row({ chamber: 'joint', officialCode: 'JLBC' }))).toBe('FL:directory:fl:joint:JLBC');
  });

  it('records only verified legacy duplicate IDs, excluding the chosen official row', () => {
    const rowWithDuplicates = row({ existing: [
      { id: 'official-existing', chamber: 'senate', officialSourceKey: 'FL:2026:fl:senate:AP' },
      { id: 'FL-upper-appropriations', chamber: 'upper', officialSourceKey: null },
      { id: 'FL-old-other', chamber: 'upper', officialSourceKey: null },
    ] });
    expect(verifiedAliasIds(rowWithDuplicates, 'official-existing')).toEqual([
      'FL-upper-appropriations', 'FL-old-other',
    ]);
    expect(verifiedAliasIds(rowWithDuplicates, 'FL-upper-appropriations')).toEqual([
      'FL-old-other',
    ]);
  });

  it('is deterministic and does not use a committee name for identity', () => {
    expect(deterministicId('FL:2026:fl:house:committee:3277')).toBe(deterministicId('FL:2026:fl:house:committee:3277'));
    expect(deterministicId('FL:2026:fl:house:committee:3277')).not.toBe(deterministicId('FL:2026:fl:house:committee:3278'));
  });

  it('rejects incorrect counts and duplicate keys', () => {
    const base = { checkedAt: '2026-09-18T13:32:56.788Z', provenance: { comparisonArtifact: 'artifact', sources: {} }, counts: { house: 1, senate: 0, joint: 0, total: 1 }, rows: [row()] };
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
});

export {};
