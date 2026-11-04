import snapshot from './reference-data/naics-psc.generated.json';
import {
  lookupProfileBuildReferenceCode,
  searchProfileBuildReferenceCatalog,
} from './profile-build-reference-catalog';

describe('official profile-build classification reference catalog', () => {
  it('contains complete pinned editions with unique assignable codes and source provenance', () => {
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.naics.entries).toHaveLength(1012);
    expect(snapshot.psc.entries).toHaveLength(2344);
    expect(snapshot.psc.inactiveCodes).toHaveLength(1310);
    for (const kind of ['naics', 'psc'] as const) {
      const source = snapshot[kind];
      expect(new Set(source.entries.map((row) => row.code)).size).toBe(source.entries.length);
      expect(source.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(source.sourceRetrievedAt).toBe('2026-11-04');
      expect(source.status).toBe('authoritative_snapshot');
      for (const row of source.entries) {
        expect(row.code).toMatch(kind === 'naics' ? /^\d{6}$/ : /^[A-Z0-9]{4}$/);
        expect(row.label.trim()).toBe(row.label);
        expect(row.label.length).toBeGreaterThan(0);
        expect(row.validTo).toBeNull();
        expect(lookupProfileBuildReferenceCode(kind, row.code).status).toBe('valid');
      }
    }
    expect(snapshot.naics.sourceUrl).toBe(
      'https://www.census.gov/naics/2022NAICS/2022_NAICS_Structure.xlsx',
    );
    expect(snapshot.naics.sourcePublishedAt).toBeNull();
    expect(snapshot.psc.sourcePublishedAt).toBe('2025-04-08');
    expect(
      snapshot.psc.entries.every((row) => !snapshot.psc.inactiveCodes.includes(row.code)),
    ).toBe(true);
  });

  it('returns exact sourced titles and edition metadata across industries and product/service codes', () => {
    expect(lookupProfileBuildReferenceCode('naics', '541330')).toEqual({
      status: 'valid',
      entry: expect.objectContaining({
        label: 'Engineering Services',
        version: '2022',
        status: 'active',
      }),
    });
    expect(lookupProfileBuildReferenceCode('naics', '621111')).toEqual({
      status: 'valid',
      entry: expect.objectContaining({
        label: 'Offices of Physicians (except Mental Health Specialists)',
      }),
    });
    expect(lookupProfileBuildReferenceCode('naics', '111110')).toEqual({
      status: 'valid',
      entry: expect.objectContaining({ label: 'Soybean Farming' }),
    });
    expect(lookupProfileBuildReferenceCode('psc', ' r425 ')).toEqual({
      status: 'valid',
      entry: expect.objectContaining({
        code: 'R425',
        label: 'SUPPORT- PROFESSIONAL: ENGINEERING/TECHNICAL',
        version: '2025-04',
        validFrom: '2011-10-01',
      }),
    });
    expect(lookupProfileBuildReferenceCode('psc', '1005')).toEqual({
      status: 'valid',
      entry: expect.objectContaining({ label: 'GUNS, THROUGH 30MM' }),
    });
  });

  it('distinguishes malformed, unlisted and retired codes instead of accepting format alone', () => {
    expect(lookupProfileBuildReferenceCode('naics', '54')).toEqual({ status: 'invalid_format' });
    expect(lookupProfileBuildReferenceCode('naics', '54133A')).toEqual({
      status: 'invalid_format',
    });
    expect(lookupProfileBuildReferenceCode('naics', '000000')).toEqual({ status: 'unknown_code' });
    expect(lookupProfileBuildReferenceCode('psc', 'ZZZZ')).toEqual({ status: 'unknown_code' });
    expect(lookupProfileBuildReferenceCode('psc', 'R4')).toEqual({ status: 'invalid_format' });
    expect(lookupProfileBuildReferenceCode('psc', 'D302')).toEqual({ status: 'inactive_code' });
    expect(searchProfileBuildReferenceCatalog('psc', 'D302')).toEqual([]);
    expect(searchProfileBuildReferenceCatalog('psc', 'DA01')[0]?.code).toBe('DA01');
  });

  it('searches literal words in any order, prioritizes codes and gives stable bounded results', () => {
    expect(
      searchProfileBuildReferenceCatalog('naics', ' design systems ').map((row) => row.code),
    ).toContain('541512');
    expect(searchProfileBuildReferenceCatalog('naics', '5413')[0]?.code).toBe('541310');
    expect(searchProfileBuildReferenceCatalog('psc', 'r425')[0]?.code).toBe('R425');
    const all = searchProfileBuildReferenceCatalog('naics', 'a', 5000);
    expect(all).toHaveLength(50);
    expect(searchProfileBuildReferenceCatalog('naics', 'a', 2)).toEqual(all.slice(0, 2));
    expect(searchProfileBuildReferenceCatalog('psc', 'support', 0)).toHaveLength(1);
    expect(searchProfileBuildReferenceCatalog('psc', 'support', Number.NaN)).toHaveLength(30);
    expect(searchProfileBuildReferenceCatalog('naics', '   ')).toEqual([]);
    expect(searchProfileBuildReferenceCatalog('naics', 'a'.repeat(161))).toEqual([]);
    expect(searchProfileBuildReferenceCatalog('psc', '.*')).toEqual([]);
    expect(searchProfileBuildReferenceCatalog('psc', "' OR 1=1 --")).toEqual([]);
  });

  it('does not let callers mutate the shared reference data', () => {
    const result = lookupProfileBuildReferenceCode('naics', '541330');
    expect(result.status).toBe('valid');
    if (result.status !== 'valid') throw new Error('Sourced code missing');
    expect(Object.isFrozen(result.entry)).toBe(true);
    expect(() => {
      (result.entry as { label: string }).label = 'Altered';
    }).toThrow();
    expect(searchProfileBuildReferenceCatalog('naics', '541330')[0]?.label).toBe(
      'Engineering Services',
    );
  });
});
