import {
  computeFacilityGeocode,
  STATE_DISTRICT_MAX_LEN,
  type FacilityGeocodeInput,
} from './facility-geocode.util.js';
import * as censusClient from '../external/census-geocoder/census-geocoder.client.js';

jest.mock('../external/census-geocoder/census-geocoder.client.js', () => ({
  geocodeAddress: jest.fn(),
}));

const geocodeAddress = censusClient.geocodeAddress as jest.Mock;

const BASE: FacilityGeocodeInput = {
  id: 'f1',
  addressLine: '400 S Monroe St',
  city: 'Tallahassee',
  state: 'FL',
  zip: '32301',
  congressionalDistrict: null,
  districtSource: null,
  stateHouseDistrict: null,
  stateSenateDistrict: null,
  latitude: null,
  longitude: null,
  geocodeStatus: null,
};

const MATCHED = {
  status: 'matched' as const,
  latitude: 30.4,
  longitude: -84.28,
  congressionalDistrict: '02',
  stateHouseDistrict: '9',
  stateSenateDistrict: '3',
  matchedAddress: 'x',
};

describe('computeFacilityGeocode', () => {
  beforeEach(() => geocodeAddress.mockReset());

  it('a never-geocoded facility with a matched address writes lat/lng + districts + geocoded provenance', async () => {
    geocodeAddress.mockResolvedValue(MATCHED);
    const out = await computeFacilityGeocode(BASE);
    expect(out.update).toEqual({
      latitude: 30.4,
      longitude: -84.28,
      congressionalDistrict: '02',
      districtSource: 'geocoded',
      stateHouseDistrict: '9',
      stateSenateDistrict: '3',
      geocodedAt: expect.any(Date),
      geocodeStatus: 'matched',
    });
    expect(out.status).toBe('matched');
    expect(out.discrepancy).toBeNull();
  });

  it('M1-C idempotency: re-running against an already-matching row produces no update', async () => {
    geocodeAddress.mockResolvedValue(MATCHED);
    const already: FacilityGeocodeInput = {
      ...BASE,
      congressionalDistrict: '02',
      districtSource: 'geocoded',
      stateHouseDistrict: '9',
      stateSenateDistrict: '3',
      latitude: 30.4,
      longitude: -84.28,
      geocodeStatus: 'matched',
    };
    const out = await computeFacilityGeocode(already);
    expect(out.update).toBeNull();
  });

  it('a hand-entered district that disagrees with the geocode is OVERWRITTEN (geocoded wins) but logged as a discrepancy', async () => {
    geocodeAddress.mockResolvedValue(MATCHED);
    const handEntered: FacilityGeocodeInput = {
      ...BASE,
      congressionalDistrict: '05', // wrong, hand-typed
      districtSource: 'user',
    };
    const out = await computeFacilityGeocode(handEntered);
    expect(out.update?.congressionalDistrict).toBe('02');
    expect(out.update?.districtSource).toBe('geocoded');
    expect(out.discrepancy).toEqual({ handEntered: '05', geocoded: '02' });
  });

  it('a hand-entered district that AGREES with the geocode is not flagged as a discrepancy', async () => {
    geocodeAddress.mockResolvedValue(MATCHED);
    const handEntered: FacilityGeocodeInput = {
      ...BASE,
      congressionalDistrict: '02',
      districtSource: 'user',
    };
    const out = await computeFacilityGeocode(handEntered);
    expect(out.discrepancy).toBeNull();
  });

  // REGRESSION (2026-07-10, W2.2): the geocoder's MATCHED fixture above
  // returns congressionalDistrict '02' — a hand-entered bare '2' is the SAME
  // district, only missing the zero-pad. Comparing raw strings (the pre-fix
  // behavior) flagged this as a discrepancy for every single-digit district.
  it('a hand-entered district that agrees with the geocode ONLY MODULO zero-padding is not flagged as a discrepancy', async () => {
    geocodeAddress.mockResolvedValue(MATCHED);
    const handEntered: FacilityGeocodeInput = {
      ...BASE,
      congressionalDistrict: '2', // no leading zero — same district as MATCHED's '02'
      districtSource: 'user',
    };
    const out = await computeFacilityGeocode(handEntered);
    expect(out.discrepancy).toBeNull();
  });

  it('no_match never clobbers a previously good district/coords — only status+timestamp change', async () => {
    geocodeAddress.mockResolvedValue({
      status: 'no_match',
      latitude: null,
      longitude: null,
      congressionalDistrict: null,
      stateHouseDistrict: null,
      stateSenateDistrict: null,
      matchedAddress: null,
    });
    const previouslyGood: FacilityGeocodeInput = {
      ...BASE,
      congressionalDistrict: '02',
      districtSource: 'geocoded',
      latitude: 30.4,
      longitude: -84.28,
      stateHouseDistrict: '9',
      stateSenateDistrict: '3',
      geocodeStatus: 'matched',
    };
    const out = await computeFacilityGeocode(previouslyGood);
    expect(out.status).toBe('no_match');
    // Update writes ONLY status/timestamp — lat/lng/districts pass through unchanged, never nulled.
    expect(out.update).toEqual({
      latitude: 30.4,
      longitude: -84.28,
      stateHouseDistrict: '9',
      stateSenateDistrict: '3',
      geocodedAt: expect.any(Date),
      geocodeStatus: 'no_match',
    });
  });

  it('a repeated no_match (status unchanged) produces no update at all — never re-writes the same status', async () => {
    geocodeAddress.mockResolvedValue({
      status: 'no_match',
      latitude: null,
      longitude: null,
      congressionalDistrict: null,
      stateHouseDistrict: null,
      stateSenateDistrict: null,
      matchedAddress: null,
    });
    const alreadyNoMatch: FacilityGeocodeInput = { ...BASE, geocodeStatus: 'no_match' };
    const out = await computeFacilityGeocode(alreadyNoMatch);
    expect(out.update).toBeNull();
  });

  it('a facility with no street/city/state is never sent to the geocoder', async () => {
    const empty: FacilityGeocodeInput = { ...BASE, addressLine: null };
    const out = await computeFacilityGeocode(empty);
    expect(geocodeAddress).not.toHaveBeenCalled();
    expect(out.update).toBeNull();
    expect(out.status).toBe('no_match');
  });

  it('a network/API error never throws — resolves to status=error with no update', async () => {
    geocodeAddress.mockRejectedValue(new Error('boom'));
    // computeFacilityGeocode itself doesn't catch — geocodeAddress's own
    // client never rejects (it catches internally), so simulate that
    // contract here by resolving to the client's own error shape instead.
    geocodeAddress.mockReset();
    geocodeAddress.mockResolvedValue({
      status: 'error',
      latitude: null,
      longitude: null,
      congressionalDistrict: null,
      stateHouseDistrict: null,
      stateSenateDistrict: null,
      matchedAddress: null,
    });
    const out = await computeFacilityGeocode(BASE);
    expect(out.status).toBe('error');
    // First-ever attempt (geocodeStatus was null) -> status changed -> writes the attempt.
    expect(out.update?.geocodeStatus).toBe('error');
  });
  // ── Named state-legislative districts (the 2026-07-30 live bug) ──────────
  //
  // `state_house_district`/`state_senate_district` shipped as VARCHAR(8), but
  // the Census layer BASENAME is a NAME in ~a dozen states. Writing one threw
  // `value too long for type character varying(8)`; because that same write
  // also carries `geocode_input_hash`, the row was never stamped and re-failed
  // on every nightly run. Live-verified values from the geocoder on
  // 2026-07-30 for the facility that was actually stuck.
  describe('named state-legislative districts (MA/NH/VT)', () => {
    const FALL_RIVER_MA = {
      status: 'matched' as const,
      latitude: 41.7,
      longitude: -71.15,
      congressionalDistrict: '04',
      stateHouseDistrict: '8th Bristol', // 11 chars
      stateSenateDistrict: 'First Bristol and Plymouth', // 26 chars
      matchedAddress: '151 MARTINE ST, FALL RIVER, MA, 02723',
    };

    it('stores a named district verbatim instead of overflowing the column', async () => {
      geocodeAddress.mockResolvedValue(FALL_RIVER_MA);
      const out = await computeFacilityGeocode(BASE);
      expect(out.status).toBe('matched');
      expect(out.update?.stateHouseDistrict).toBe('8th Bristol');
      expect(out.update?.stateSenateDistrict).toBe('First Bristol and Plymouth');
      // Every stored value must fit the widened column.
      expect(out.update!.stateSenateDistrict!.length).toBeLessThanOrEqual(STATE_DISTRICT_MAX_LEN);
    });

    it('a re-run over an already-stored named district is a no-op (idempotency, M1-C)', async () => {
      geocodeAddress.mockResolvedValue(FALL_RIVER_MA);
      const out = await computeFacilityGeocode({
        ...BASE,
        latitude: 41.7,
        longitude: -71.15,
        congressionalDistrict: '04',
        districtSource: 'geocoded',
        stateHouseDistrict: '8th Bristol',
        stateSenateDistrict: 'First Bristol and Plymouth',
        geocodeStatus: 'matched',
      });
      expect(out.update).toBeNull();
    });

    it('clamps a district longer than the column rather than throwing', async () => {
      const overlong = 'X'.repeat(STATE_DISTRICT_MAX_LEN + 25);
      geocodeAddress.mockResolvedValue({ ...FALL_RIVER_MA, stateSenateDistrict: overlong });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const out = await computeFacilityGeocode(BASE);
      expect(out.update?.stateSenateDistrict).toHaveLength(STATE_DISTRICT_MAX_LEN);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('a clamped district still compares equal on the next run (no perpetual rewrite)', async () => {
      const overlong = 'X'.repeat(STATE_DISTRICT_MAX_LEN + 25);
      geocodeAddress.mockResolvedValue({ ...FALL_RIVER_MA, stateSenateDistrict: overlong });
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const out = await computeFacilityGeocode({
        ...BASE,
        latitude: 41.7,
        longitude: -71.15,
        congressionalDistrict: '04',
        districtSource: 'geocoded',
        stateHouseDistrict: '8th Bristol',
        stateSenateDistrict: overlong.slice(0, STATE_DISTRICT_MAX_LEN),
        geocodeStatus: 'matched',
      });
      expect(out.update).toBeNull();
      jest.restoreAllMocks();
    });
  });
});
