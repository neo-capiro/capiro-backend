import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatFacilityDistrict,
  formatFacilityStateDistrict,
  type ClientFacility,
} from '../../../pages/clients/facilities-api.js';
import { FacilityVerification, facilityVerification } from './FacilityVerification.js';

const facility = {
  state: 'FL',
  congressionalDistrict: '08',
  districtSource: 'user',
  geocodeStatus: 'matched',
  geocodedAt: '2026-09-01T00:00:00Z',
  latitude: 28.1,
  longitude: -80.6,
  stateHouseDistrict: '32',
  stateSenateDistrict: '19',
} as ClientFacility;

afterEach(cleanup);

describe('facility evidence shared by Manage facilities and Intelligence', () => {
  it('explains a matched address with a manually supplied district without claiming verification', () => {
    render(<FacilityVerification facility={facility} />);
    expect(screen.getByText('Geocoder: Matched')).toBeInTheDocument();
    expect(screen.getByText('U.S. House source: Manual')).toBeInTheDocument();
    expect(
      screen.getByText(/address matched Census; the U.S. House district was supplied manually/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Confirmed|Needs address verification/)).not.toBeInTheDocument();
  });

  it.each([
    ['matched', 'Matched'],
    ['manual_review', 'Review required'],
    ['pending', 'Pending'],
    ['error', 'Error'],
    ['ambiguous', 'Ambiguous'],
    ['no_match', 'No match'],
    [null, 'Not run'],
  ])('reports %s independently of district provenance', (geocodeStatus, expected) => {
    const state = facilityVerification({ ...facility, geocodeStatus } as ClientFacility);
    expect(state.geocoder).toBe(expected);
    expect(state.districtSource).toBe('Manual');
  });

  it.each([{ geocodedAt: null }, { latitude: null }, { longitude: null }])(
    'discloses incomplete match evidence: %j',
    (missing) => {
      render(<FacilityVerification facility={{ ...facility, ...missing }} />);
      expect(screen.getByText('Geocoder: Matched')).toBeInTheDocument();
      expect(screen.getByText(/Match details incomplete/)).toBeInTheDocument();
    },
  );

  it('does not infer district provenance from geocoding alone', () => {
    expect(facilityVerification({ ...facility, districtSource: null }).districtSource).toBe(
      'Not recorded',
    );
    expect(facilityVerification({ ...facility, congressionalDistrict: null }).districtSource).toBe(
      'Not resolved',
    );
  });
});

describe('facility district display', () => {
  it.each([
    ['FL', null, ''],
    [null, '08', ''],
    ['CA', 'CA', ''],
    ['WA', '53', ''],
    ['WA', '00', ''],
    ['WA', '7', 'WA-07'],
    ['AK', '0', 'AK-00'],
    ['AK', '1', 'AK-00'],
    ['fl', '08', 'FL-08'],
    ['CA', '08', 'CA-08'],
  ])('formats %s / %s only as a complete district', (state, district, expected) => {
    expect(formatFacilityDistrict(state, district)).toBe(expected);
  });

  it.each([null, '', 'CA', ' fl ', 'WA'])(
    'hides missing or state-only legislative districts: %s',
    (value) => {
      expect(formatFacilityStateDistrict(value)).toBe('');
    },
  );

  it.each(['32', 'A', 'First Bristol and Plymouth', 'Chittenden-6-3'])(
    'preserves legitimate numeric and named districts: %s',
    (value) => {
      expect(formatFacilityStateDistrict(value)).toBe(value);
    },
  );
});
