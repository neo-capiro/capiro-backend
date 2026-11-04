import {
  boundaryVersionKey,
  physicalAddressEligibility,
  servingBoundaryVersion,
} from './geographic-boundary.js';
import { nearPolygonBoundary, selectLegislativeLayers } from './tigerweb-boundary.client.js';
import { geocodeAddress } from './census-geocoder.client.js';
import { facilityAddressHash } from '../../clients/facility-geocode.util.js';

const version = servingBoundaryVersion();
const catalog = {
  layers: [
    { id: 900, name: '120th Congressional Districts', parentLayerId: -1 },
    { id: 700, name: 'BAS 2026' },
    { id: 701, name: '119th Congressional Districts', parentLayerId: 700 },
    { id: 703, name: '2024 State Legislative Districts - Upper', parentLayerId: 700 },
    { id: 702, name: '2024 State Legislative Districts - Lower', parentLayerId: 700 },
  ],
};
const ring = [
  [
    [-85, 29],
    [-83, 29],
    [-83, 31],
    [-85, 31],
    [-85, 29],
  ],
];
const match = {
  matchedAddress: '1 MAIN ST',
  coordinates: { x: -84, y: 30 },
  geographies: { '120th Congressional Districts': [{ CD120: '09', STATE: '12' }] },
};
function mockOfficial(near = false, chamberLower = true) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    const text = String(url);
    if (text.includes('onelineaddress'))
      return new Response(JSON.stringify({ result: { addressMatches: [match] } }));
    if (text.includes('coordinates'))
      return new Response(JSON.stringify({ result: { geographies: match.geographies } }));
    if (!text.includes('/query?')) return new Response(JSON.stringify(catalog));
    const attributes = text.includes('/701/')
      ? { CD119: '02', STATE: '12', GEOID: '1202' }
      : text.includes('/702/')
        ? { SLDL: '009', BASENAME: '9', STATE: '12', GEOID: '12009' }
        : { SLDU: '003', BASENAME: '3', STATE: '12', GEOID: '12003' };
    return new Response(
      JSON.stringify({
        features:
          !chamberLower && text.includes('/702/')
            ? []
            : [
                {
                  attributes,
                  geometry: {
                    rings: near
                      ? [
                          [
                            [-84, 29],
                            [-83, 29],
                            [-83, 31],
                            [-84, 31],
                            [-84, 29],
                          ],
                        ]
                      : ring,
                  },
                },
              ],
      }),
    );
  });
}
describe('versioned facility geography', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(['PO Box 12', 'P.O. Box 40', 'Post Office Box 9', 'Austin', '78701', 'Main Street'])(
    'requires a physical address for %s without network access',
    async (street) => {
      const fetch = jest.spyOn(global, 'fetch');
      expect(physicalAddressEligibility(street, 'Austin', 'TX', '78701')).toBe('needs_address');
      expect((await geocodeAddress(street, 'Austin', 'TX', '78701')).resolution?.status).toBe(
        'needs_address',
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('keeps international facilities without assigning US districts', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    const result = await geocodeAddress('1 Main St', 'London', '', '', { country: 'GB' });
    expect(result.resolution?.status).toBe('not_applicable');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses discovered IDs for the requested 119th term even if moving Census labels return 120th', async () => {
    const fetch = mockOfficial();
    const result = await geocodeAddress('1 Main St', 'Tallahassee', 'FL', '32301');
    expect(result).toMatchObject({
      congressionalDistrict: '02',
      congressionalDistrictCongress: 119,
      resolution: {
        status: 'resolved',
        precision: 'street_interpolated',
        requiresReview: true,
        version: { congress: 119 },
      },
    });
    expect(result.resolution?.districts[0]).toMatchObject({ geoid: '1202', stateFips: '12' });
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/701/query?'))).toBe(true);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/900/query?'))).toBe(false);
  });
  it('requires review near a polygon boundary even for a verified point', async () => {
    mockOfficial(true);
    const result = await geocodeAddress('', '', '', '', {
      verifiedPoint: { latitude: 30, longitude: -84, verifiedAt: '2026-11-04T00:00:00Z' },
    });
    expect(result.resolution).toMatchObject({
      precision: 'verified_point',
      requiresReview: true,
      boundaryAdjacent: true,
    });
  });
  it('allows a reviewed point away from boundaries and leaves an absent chamber unresolved', async () => {
    mockOfficial(false, false);
    const result = await geocodeAddress('', '', '', '', {
      verifiedPoint: { latitude: 30, longitude: -84, verifiedAt: '2026-11-04T00:00:00Z' },
    });
    expect(result.resolution?.requiresReview).toBe(false);
    expect(result.stateHouseDistrict).toBeNull();
    expect(result.stateSenateDistrict).toBe('3');
  });
  it('marks a missing required boundary stale without publishing the mismatched district', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async (url) =>
          new Response(
            JSON.stringify(
              String(url).includes('onelineaddress')
                ? { result: { addressMatches: [match] } }
                : { layers: catalog.layers.filter((l) => l.id !== 701) },
            ),
          ),
      );
    const result = await geocodeAddress('1 Main St', 'Tallahassee', 'FL', '32301');
    expect(result.resolution?.status).toBe('stale_boundary');
    expect(result.congressionalDistrict).toBeNull();
  });
  it('makes country, verified point and boundary version part of the cache identity', () => {
    const address = { addressLine: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' };
    expect(facilityAddressHash(address, version)).not.toBe(
      facilityAddressHash(address, { ...version, congress: 120 }),
    );
    expect(facilityAddressHash(address)).not.toBe(
      facilityAddressHash({ ...address, country: 'CA' }),
    );
    expect(facilityAddressHash(address)).not.toBe(
      facilityAddressHash({
        ...address,
        verifiedPoint: { latitude: 30, longitude: -84, verifiedAt: '2026-11-04' },
      }),
    );
    expect(boundaryVersionKey(version)).toContain('BAS 2026');
  });
  it('discovers chamber shapes without fixed layer IDs and measures a review threshold, not geocoder confidence', () => {
    expect(selectLegislativeLayers(catalog.layers, version)?.map((l) => l.id)).toEqual([
      701, 702, 703,
    ]);
    expect(nearPolygonBoundary(30, -84, ring)).toBe(false);
    expect(nearPolygonBoundary(29, -84, ring)).toBe(true);
  });
});
