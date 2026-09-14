import {
  extractDistricts,
  geocodeAddress,
  parseGeocodeMatch,
  type CensusAddressMatch,
} from './census-geocoder.client.js';
import { jest } from '@jest/globals';

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
      congressionalDistrictCongress: 119,
      stateHouseDistrict: '9',
      stateSenateDistrict: '3',
    });
  });

  it('at-large seat: CD<n>="00" is used, NOT the text BASENAME', () => {
    const r = extractDistricts(WY_AT_LARGE_MATCH);
    expect(r.congressionalDistrict).toBe('00');
    expect(r.congressionalDistrict).not.toBe('Congressional District (at Large)');
    expect(r.congressionalDistrictCongress).toBe(119);
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
      // A future Congress number bump is read dynamically, not hardcoded —
      // this is PD1's other explicit warning, and the whole reason the field
      // is matched by /^CD\d+$/ rather than a fixed "CD119".
      congressionalDistrictCongress: 122,
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
      congressionalDistrictCongress: 119,
      stateHouseDistrict: null,
      stateSenateDistrict: '25',
    });
  });

  it('no geographies at all resolves to all-null, never throws', () => {
    const r = extractDistricts({ matchedAddress: 'x', coordinates: { x: 0, y: 0 } });
    expect(r).toEqual({
      congressionalDistrict: null,
      congressionalDistrictCongress: null,
      stateHouseDistrict: null,
      stateSenateDistrict: null,
    });
  });

  it('a CD layer with no /^CD\\d+$/-shaped field key resolves the Congress to null, never a guess', () => {
    const noCdField: CensusAddressMatch = {
      matchedAddress: 'x',
      coordinates: { x: 0, y: 0 },
      geographies: {
        '119th Congressional Districts': [{ BASENAME: '2' }],
      },
    };
    const r = extractDistricts(noCdField);
    expect(r.congressionalDistrict).toBeNull();
    expect(r.congressionalDistrictCongress).toBeNull();
  });
});

describe('parseGeocodeMatch', () => {
  it('returns a standardized address recommendation with the resolved location', () => {
    expect(parseGeocodeMatch(FL_MATCH)).toEqual({
      matchedAddress: '400 S MONROE ST, TALLAHASSEE, FL, 32399',
      addressLine: null,
      city: null,
      state: null,
      zip: null,
      latitude: 30.43813199863,
      longitude: -84.280698266189,
      congressionalDistrict: '02',
      congressionalDistrictCongress: 119,
      stateHouseDistrict: '9',
      stateSenateDistrict: '3',
    });
  });
});

describe('geocodeAddress ArcGIS fallback', () => {
  afterEach(() => jest.restoreAllMocks());

  it('cancels a stalled request and records an error instead of leaving resolution pending', async () => {
    const controller = new AbortController();
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    jest.spyOn(global, 'fetch').mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('timeout')), {
            once: true,
          });
        }),
    );
    const result = geocodeAddress('1 Main St', 'Austin', 'TX', '78701');
    controller.abort();
    await expect(result).resolves.toMatchObject({ status: 'error' });
    expect(timeout).toHaveBeenCalledWith(25_000);
  });

  it('records a fallback service outage as retryable error rather than an invalid address', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { addressMatches: [] } })))
      .mockResolvedValue(new Response('', { status: 403 }));
    await expect(geocodeAddress('1 Main St', 'Austin', 'TX', '78701')).resolves.toMatchObject({
      status: 'error',
    });
  });

  it('falls back to a high-confidence ArcGIS point and Census coordinate geography when Census has no address match', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { addressMatches: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                address: '1025 W Nasa Blvd, Melbourne, Florida, 32919',
                location: { x: -80.6385795, y: 28.0907543 },
                score: 97.81,
                attributes: { Addr_type: 'PointAddress' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              geographies: FL_MATCH.geographies,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    await expect(
      geocodeAddress('1025 W NASA Boulevard', 'Palm Bay', 'FL', '32919'),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'matched',
        latitude: 28.0907543,
        longitude: -80.6385795,
        congressionalDistrict: '02',
        congressionalDistrictCongress: 119,
        stateHouseDistrict: '9',
        stateSenateDistrict: '3',
        matchedAddress: '1025 W Nasa Blvd, Melbourne, Florida, 32919',
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not accept a low-confidence postal-only fallback', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { addressMatches: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                address: '92604, Irvine, California',
                location: { x: -117.789914, y: 33.69421 },
                score: 84,
                attributes: { Addr_type: 'Postal' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    await expect(
      geocodeAddress('602 E Vermont Ave', 'Irvine', 'CA', '92604'),
    ).resolves.toMatchObject({
      status: 'no_match',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
