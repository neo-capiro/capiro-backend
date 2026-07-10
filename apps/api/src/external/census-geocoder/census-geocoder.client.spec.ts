import { extractDistricts, type CensusAddressMatch } from './census-geocoder.client.js';

/**
 * Fixtures are transcribed verbatim from live Census Geocoder responses
 * captured 2026-07-10 (District Impact Engine, Phase 1 M1.2) — see the
 * client's header comment for the live-verification notes. FL and WY are
 * real `/geographies/onelineaddress` responses; the vintage-drift and
 * unicameral fixtures are synthetic, constructed to prove the suffix/regex
 * matching survives exactly the drift PD1 warned about.
 */
const FL_MATCH: CensusAddressMatch = {
  matchedAddress: '400 S MONROE ST, TALLAHASSEE, FL, 32399',
  coordinates: { x: -84.280698266189, y: 30.43813199863 },
  geographies: {
    '2024 State Legislative Districts - Upper': [
      { GEOID: '12003', BASENAME: '3', SLDU: '003', NAME: 'State Senate District 3' },
    ],
    '2024 State Legislative Districts - Lower': [
      { GEOID: '12009', BASENAME: '9', SLDL: '009', NAME: 'State House District 9' },
    ],
    '119th Congressional Districts': [
      { GEOID: '1202', BASENAME: '2', CD119: '02', NAME: 'Congressional District 2' },
    ],
  },
};

/** Wyoming — at-large congressional seat. CD119="00" is the sentinel; BASENAME is a text label, not usable for the federal district. */
const WY_AT_LARGE_MATCH: CensusAddressMatch = {
  matchedAddress: '200 W 24TH ST, CHEYENNE, WY, 82002',
  coordinates: { x: -107.5514568, y: 42.9960999 },
  geographies: {
    '2024 State Legislative Districts - Upper': [
      { GEOID: '56008', BASENAME: '8', SLDU: '008', NAME: 'State Senate District 8' },
    ],
    '2024 State Legislative Districts - Lower': [
      { GEOID: '56011', BASENAME: '11', SLDL: '011', NAME: 'State House District 11' },
    ],
    '119th Congressional Districts': [
      {
        GEOID: '5600',
        BASENAME: 'Congressional District (at Large)',
        CD119: '00',
        NAME: 'Congressional District (at Large)',
      },
    ],
  },
};

describe('extractDistricts', () => {
  it('parses a normal bicameral-state match (FL)', () => {
    const r = extractDistricts(FL_MATCH);
    expect(r).toEqual({
      congressionalDistrict: '02',
      stateHouseDistrict: '9',
      stateSenateDistrict: '3',
    });
  });

  it('at-large seat: CD<n>="00" is used, NOT the text BASENAME', () => {
    const r = extractDistricts(WY_AT_LARGE_MATCH);
    expect(r.congressionalDistrict).toBe('00');
    expect(r.congressionalDistrict).not.toBe('Congressional District (at Large)');
    expect(r.stateHouseDistrict).toBe('11');
    expect(r.stateSenateDistrict).toBe('8');
  });

  it('vintage-year drift: a future year prefix still matches by suffix, not the year', () => {
    // PD1's explicit warning: match on "- Upper"/"- Lower" suffix, never the
    // leading year (which the Census Bureau bumps on its own redistricting
    // cycle, independent of any code change here).
    const drifted: CensusAddressMatch = {
      ...FL_MATCH,
      geographies: {
        '2031 State Legislative Districts - Upper': [{ BASENAME: '3' }],
        '2031 State Legislative Districts - Lower': [{ BASENAME: '9' }],
        '122nd Congressional Districts': [{ BASENAME: '2', CD122: '02' }],
      },
    };
    const r = extractDistricts(drifted);
    expect(r).toEqual({
      congressionalDistrict: '02',
      stateHouseDistrict: '9',
      stateSenateDistrict: '3',
    });
  });

  it('unicameral / no state-chamber match: absent layers resolve to null, never a guess', () => {
    // e.g. Nebraska's single-chamber Legislature may not populate a "- Lower"
    // layer at all. A missing layer must resolve to null, not throw or
    // silently reuse the other chamber's value.
    const unicameral: CensusAddressMatch = {
      matchedAddress: 'NE address',
      coordinates: { x: -96.7, y: 40.8 },
      geographies: {
        '2024 State Legislative Districts - Upper': [{ BASENAME: '25' }],
        '119th Congressional Districts': [{ BASENAME: '1', CD119: '01' }],
      },
    };
    const r = extractDistricts(unicameral);
    expect(r).toEqual({
      congressionalDistrict: '01',
      stateHouseDistrict: null,
      stateSenateDistrict: '25',
    });
  });

  it('no geographies at all resolves to all-null, never throws', () => {
    const r = extractDistricts({ matchedAddress: 'x', coordinates: { x: 0, y: 0 } });
    expect(r).toEqual({
      congressionalDistrict: null,
      stateHouseDistrict: null,
      stateSenateDistrict: null,
    });
  });
});
