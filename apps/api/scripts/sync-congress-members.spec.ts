/**
 * entity_crosswalk row derivation from the CC0 legislators id block
 * (Bucket-#3 C6). fec is an ARRAY in the source; non-allowlisted namespaces
 * (ballotpedia, cspan, ...) must be excluded.
 */
import { buildCrosswalkRows } from './sync-congress-members';

describe('buildCrosswalkRows', () => {
  it('expands the allowlisted id namespaces, arrays included', () => {
    const rows = buildCrosswalkRows('V000128', {
      bioguide: 'V000128',
      lis: 'S390',
      fec: ['H2MD08126', 'S6MD03177'],
      opensecrets: 'N00013820',
      govtrack: 412478,
      wikidata: 'Q2299668',
      ballotpedia: 'Chris Van Hollen', // NOT allowlisted — must be dropped
    });
    const byType = Object.fromEntries(rows.map((r) => [`${r.idType}:${r.idValue}`, r]));
    expect(byType['lis:S390']).toMatchObject({ entityType: 'member', entityKey: 'V000128' });
    expect(byType['fec:H2MD08126']).toBeDefined();
    expect(byType['fec:S6MD03177']).toBeDefined();
    expect(byType['govtrack:412478']).toBeDefined(); // numbers stringified
    expect(rows.every((r) => r.source === 'sync-congress-members')).toBe(true);
    expect(rows.find((r) => r.idType === 'ballotpedia')).toBeUndefined();
    expect(rows.find((r) => r.idType === 'bioguide')).toBeUndefined(); // key, not crosswalk
  });

  it('returns nothing for an empty id block', () => {
    expect(buildCrosswalkRows('A000000', {})).toEqual([]);
  });
});
