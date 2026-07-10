/**
 * Shared geocode-and-diff logic for a single `ClientFacility` row (District
 * Impact Engine, Phase 1 M1.2). Used by BOTH the inline best-effort geocode
 * on facility create/edit (client-facilities.service.ts) and the nightly
 * `geocode-facilities` backfill verb — one code path, two callers.
 *
 * Idempotent by design: `buildGeocodeUpdate` returns `null` when nothing
 * would change (M1-C), so a re-run only touches rows whose resolved geocode
 * actually differs from what's stored.
 */
import { geocodeAddress, type GeocodeStatus } from '../external/census-geocoder/census-geocoder.client.js';

export interface FacilityGeocodeInput {
  id: string;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  congressionalDistrict: string | null;
  districtSource: string | null;
  stateHouseDistrict: string | null;
  stateSenateDistrict: string | null;
  latitude: number | null;
  longitude: number | null;
  geocodeStatus: string | null;
}

export interface FacilityGeocodeUpdate {
  latitude: number | null;
  longitude: number | null;
  congressionalDistrict?: string;
  districtSource?: string;
  stateHouseDistrict: string | null;
  stateSenateDistrict: string | null;
  geocodedAt: Date;
  geocodeStatus: GeocodeStatus;
}

export interface FacilityGeocodeOutcome {
  update: FacilityGeocodeUpdate | null;
  status: GeocodeStatus;
  /** A hand-typed congressionalDistrict disagreed with the geocoded one (data-quality signal for M5's QA surface). */
  discrepancy: { handEntered: string; geocoded: string } | null;
}

/** A facility with no usable street/city/state has nothing to geocode. */
function hasGeocodableAddress(f: FacilityGeocodeInput): boolean {
  return Boolean(f.addressLine?.trim() && f.city?.trim() && f.state?.trim());
}

/**
 * Geocode one facility and compute the update, or `null` if nothing changed
 * (idempotency, M1-C) or the address isn't geocodable. Never throws — a
 * network/API failure resolves to `status: 'error'` with no update, so a
 * transient outage never corrupts a previously-good district.
 */
export async function computeFacilityGeocode(f: FacilityGeocodeInput): Promise<FacilityGeocodeOutcome> {
  if (!hasGeocodableAddress(f)) {
    return { update: null, status: 'no_match', discrepancy: null };
  }
  const result = await geocodeAddress(f.addressLine!, f.city!, f.state!, f.zip ?? '');
  if (result.status !== 'matched') {
    // Record the attempt (status) but never clobber a previously-good
    // district/lat-lng with nulls on a transient no_match/ambiguous/error —
    // only write status + timestamp so the UI can show "last attempt failed".
    const statusChanged = f.geocodeStatus !== result.status;
    return {
      update: statusChanged
        ? {
            latitude: f.latitude,
            longitude: f.longitude,
            stateHouseDistrict: f.stateHouseDistrict,
            stateSenateDistrict: f.stateSenateDistrict,
            geocodedAt: new Date(),
            geocodeStatus: result.status,
          }
        : null,
      status: result.status,
      discrepancy: null,
    };
  }

  const discrepancy =
    f.congressionalDistrict &&
    result.congressionalDistrict &&
    f.districtSource !== 'geocoded' &&
    f.congressionalDistrict !== result.congressionalDistrict
      ? { handEntered: f.congressionalDistrict, geocoded: result.congressionalDistrict }
      : null;

  const unchanged =
    f.latitude === result.latitude &&
    f.longitude === result.longitude &&
    f.stateHouseDistrict === result.stateHouseDistrict &&
    f.stateSenateDistrict === result.stateSenateDistrict &&
    f.geocodeStatus === 'matched' &&
    (f.congressionalDistrict === result.congressionalDistrict || f.districtSource !== 'geocoded');
  if (unchanged) {
    return { update: null, status: 'matched', discrepancy };
  }

  return {
    update: {
      latitude: result.latitude,
      longitude: result.longitude,
      // Keep the geocoded value even over a disagreeing hand-entry (PD1/M1.2:
      // "keep the geocoded value but log the discrepancy") — but never
      // overwrite it if this specific facility's district is missing from the
      // geocode result (a partial match keeps whatever federal district it had).
      ...(result.congressionalDistrict
        ? { congressionalDistrict: result.congressionalDistrict, districtSource: 'geocoded' }
        : {}),
      stateHouseDistrict: result.stateHouseDistrict,
      stateSenateDistrict: result.stateSenateDistrict,
      geocodedAt: new Date(),
      geocodeStatus: 'matched',
    },
    status: 'matched',
    discrepancy,
  };
}
