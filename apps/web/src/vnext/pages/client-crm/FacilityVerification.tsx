import {
  formatFacilityDistrict,
  formatFacilityStateDistrict,
  type ClientFacility,
} from '../../../pages/clients/facilities-api.js';
import './facility-verification.css';

const GEOCODER_LABELS: Record<string, string> = {
  matched: 'Matched',
  pending: 'Pending',
  no_match: 'No match',
  ambiguous: 'Ambiguous',
  error: 'Error',
  manual_review: 'Review required',
};

export function facilityVerification(facility: ClientFacility) {
  const district = formatFacilityDistrict(facility.state, facility.congressionalDistrict);
  const manual = ['user', 'manual'].includes(facility.districtSource ?? '');
  const census = ['geocoded', 'geocoder', 'census'].includes(facility.districtSource ?? '');
  const matched = facility.geocodeStatus === 'matched';
  const completeMatch =
    matched &&
    Boolean(facility.geocodedAt) &&
    Number.isFinite(facility.latitude) &&
    Number.isFinite(facility.longitude);
  return {
    district,
    geocoder: GEOCODER_LABELS[facility.geocodeStatus ?? ''] ?? 'Not run',
    districtSource: !district
      ? 'Not resolved'
      : manual
        ? 'Manual'
        : census
          ? 'Census'
          : 'Not recorded',
    completeMatch,
    guidance:
      matched && manual && district
        ? 'The address matched Census; the U.S. House district was supplied manually.'
        : facility.geocodeStatus === 'manual_review'
          ? 'Review the saved address and districts in Manage facilities.'
          : null,
  };
}

/** Shared evidence labels: a geocoder match does not verify a manually supplied district. */
export function FacilityVerification({ facility }: { facility: ClientFacility }) {
  const state = facilityVerification(facility);
  return (
    <span className="capiro-facility-verification" aria-label="Facility location evidence">
      <span className="capiro-facility-verification__statuses">
        <span>Geocoder: {state.geocoder}</span>
        <span>U.S. House source: {state.districtSource}</span>
      </span>
      <span className="capiro-facility-verification__districts">
        <span>U.S. House: {state.district || 'Not resolved'}</span>
        <span>
          State House: {formatFacilityStateDistrict(facility.stateHouseDistrict) || 'Not resolved'}
        </span>
        <span>
          State Senate:{' '}
          {formatFacilityStateDistrict(facility.stateSenateDistrict) || 'Not resolved'}
        </span>
      </span>
      {facility.geocodeStatus === 'matched' && facility.geocodeMatchedAddress ? (
        <span>Census address: {facility.geocodeMatchedAddress}</span>
      ) : null}
      {state.guidance ? <span>{state.guidance}</span> : null}
      {facility.geocodeStatus === 'matched' && !state.completeMatch ? (
        <span>Match details incomplete: coordinates or match date are missing.</span>
      ) : null}
    </span>
  );
}
