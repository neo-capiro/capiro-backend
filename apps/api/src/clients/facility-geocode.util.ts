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
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { boundaryVersionKey, servingBoundaryVersion, physicalAddressEligibility, isVerifiedFacilityPoint, type GeographicBoundaryVersion, type GeographicResolution } from '../external/census-geocoder/geographic-boundary.js';
import {
  geocodeAddress,
  type CensusGeocodeCandidate,
  type CensusGeocodeResult,
  type GeocodeStatus,
} from '../external/census-geocoder/census-geocoder.client.js';
import { normalizeDistrictCode } from './district-code.util.js';
import { normalizeFacilityDistrictCode } from '../common/district-code.util.js';

/**
 * Width of `client_facilities.state_house_district` / `.state_senate_district`
 * (migration 20260810050000). Kept here because this module is the only writer
 * of a value whose length we do not control — the Census layer BASENAME.
 */
export const STATE_DISTRICT_MAX_LEN = 64;

/** The canonical address identity shared by inline resolution and the backfill job. */
export function normalizedFacilityAddress(
  f: Pick<FacilityGeocodeInput, 'addressLine' | 'city' | 'state' | 'zip'>,
): string {
  return [f.addressLine, f.city, f.state, f.zip]
    .map((value) => (value ?? '').trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|');
}

export function facilityAddressHash(
  f: Pick<FacilityGeocodeInput, 'addressLine' | 'city' | 'state' | 'zip' | 'country' | 'verifiedPoint'>,
  boundary: GeographicBoundaryVersion = servingBoundaryVersion(),
): string {
  const point = isVerifiedFacilityPoint(f.verifiedPoint) ? f.verifiedPoint : null;
  const identity = [normalizedFacilityAddress(f), (f.country ?? 'US').trim().toLowerCase(), point?.latitude ?? '',
    point?.longitude ?? '', point?.verifiedAt ?? '', boundaryVersionKey(boundary)].join('|');
  return createHash('md5').update(identity).digest('hex');
}

/**
 * Clamp a Census state-legislative BASENAME to the column width.
 *
 * These columns shipped as VARCHAR(8) against a source that returns district
 * NAMES in ~a dozen states ('First Bristol and Plymouth' is 26 chars). Every
 * such write threw, and because the same write carries `geocode_input_hash`,
 * the row was never stamped and re-failed on every nightly run from 2026-07-21
 * until the column was widened. 64 covers every real value today, but the
 * source is a federal dataset we don't version — so clamp rather than throw,
 * because a truncated district name is a visible data-quality problem while a
 * throw silently wedges the whole job again.
 */
function clampStateDistrict(raw: string | null): string | null {
  if (raw == null) return null;
  if (raw.length <= STATE_DISTRICT_MAX_LEN) return raw;
  console.warn(
    `[facility-geocode] state district "${raw}" exceeds ` +
      `${STATE_DISTRICT_MAX_LEN} chars — truncating`,
  );
  return raw.slice(0, STATE_DISTRICT_MAX_LEN);
}

export interface FacilityGeocodeInput {
  id: string;
  country?: string | null;
  verifiedPoint?: unknown;
  geographicResolution?: unknown;
  geographicHistory?: unknown;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  congressionalDistrict: string | null;
  /** Which Congress's boundary produced `congressionalDistrict` (Release 1, §11). */
  congressionalDistrictCongress?: number | null;
  districtSource: string | null;
  stateHouseDistrict: string | null;
  stateSenateDistrict: string | null;
  latitude: number | null;
  longitude: number | null;
  geocodeStatus: string | null;
  geocodeInputHash?: string | null;
}

export interface FacilityGeocodeUpdate {
  geographicResolution?: Prisma.InputJsonValue;
  geographicHistory?: Prisma.InputJsonValue;
  latitude: number | null;
  longitude: number | null;
  congressionalDistrict?: string;
  /** Written only alongside a geocoded `congressionalDistrict` — never for a preserved manual one. */
  congressionalDistrictCongress?: number;
  districtSource?: string;
  stateHouseDistrict: string | null;
  stateSenateDistrict: string | null;
  geocodedAt: Date;
  geocodeStatus: GeocodeStatus;
  geocodeInputHash: string;
}

export interface FacilityGeocodeOutcome {
  resolution?: GeographicResolution;
  update: FacilityGeocodeUpdate | null;
  status: GeocodeStatus;
  /** Census' canonical address, retained even when the row is otherwise unchanged. */
  matchedAddress: string | null;
  /** All selectable Census hits when the input was ambiguous. */
  candidates: CensusGeocodeCandidate[] | null;
  /** A hand-typed congressionalDistrict disagreed with the geocoded one (data-quality signal for M5's QA surface). */
  discrepancy: { handEntered: string; geocoded: string } | null;
}

/**
 * Geocode one facility and compute the update, or `null` if nothing changed
 * (idempotency, M1-C) or the address isn't geocodable. Never throws — a
 * network/API failure resolves to `status: 'error'` with no update, so a
 * transient outage never corrupts a previously-good district.
 */
export async function computeFacilityGeocode(
  f: FacilityGeocodeInput,
): Promise<FacilityGeocodeOutcome> {
  const boundary = servingBoundaryVersion();
  const geocodeInputHash = facilityAddressHash(f, boundary);
  const eligibility = physicalAddressEligibility(f.addressLine, f.city, f.state, f.zip, f.country);
  const verifiedPoint = isVerifiedFacilityPoint(f.verifiedPoint) ? f.verifiedPoint : undefined;
  const geocoded: CensusGeocodeResult = eligibility !== 'eligible' && !verifiedPoint || eligibility === 'not_applicable'
    ? { status: 'no_match' as const, latitude: null, longitude: null, congressionalDistrict: null,
        congressionalDistrictCongress: null, stateHouseDistrict: null, stateSenateDistrict: null, matchedAddress: null,
        resolution: { status: eligibility === 'not_applicable' ? 'not_applicable' as const : 'needs_address' as const,
          requiresReview: eligibility !== 'not_applicable', precision: 'unknown' as const, source: null,
          version: boundary, stateFips: null, districts: [], resolvedAt: new Date().toISOString() } }
    : await geocodeAddress(f.addressLine ?? '', f.city ?? '', f.state ?? '', f.zip ?? '', { boundary, country: f.country, verifiedPoint });
  const discrepancy =
    f.congressionalDistrict &&
    geocoded.congressionalDistrict &&
    f.districtSource !== 'geocoded' &&
    normalizeDistrictCode(normalizeFacilityDistrictCode(f.state, f.congressionalDistrict)) !==
      normalizeDistrictCode(normalizeFacilityDistrictCode(f.state, geocoded.congressionalDistrict))
      ? { handEntered: f.congressionalDistrict, geocoded: geocoded.congressionalDistrict }
      : null;
  if (discrepancy && geocoded.resolution) geocoded.resolution.overrideConflict = discrepancy;
  const metadata = geocoded.resolution ? {
    geographicResolution: geocoded.resolution as unknown as Prisma.InputJsonValue,
    geographicHistory: [
      ...(Array.isArray(f.geographicHistory) ? f.geographicHistory : []),
      ...(f.geographicResolution ? [f.geographicResolution] : []),
    ] as Prisma.InputJsonValue,
  } : {};
  const result = { ...geocoded,
    status: (geocoded.resolution?.status === 'source_unavailable' ? 'error' : geocoded.resolution?.status === 'stale_boundary' ? 'no_match' : geocoded.status) as GeocodeStatus,
    congressionalDistrict: normalizeFacilityDistrictCode(f.state, geocoded.congressionalDistrict),
  };
  if (result.status !== 'matched' || result.resolution?.requiresReview ||
      (result.resolution && result.resolution.status !== 'resolved')) {
    // Record the attempt (status) but never clobber a previously-good
    // district/lat-lng with nulls on a transient no_match/ambiguous/error —
    // only write status + timestamp so the UI can show "last attempt failed".
    const statusChanged =
      f.geocodeStatus !== result.status || f.geocodeInputHash !== geocodeInputHash || Boolean(result.resolution);
    return {
      resolution: result.resolution,
      update: statusChanged
        ? {
            ...metadata,
            latitude: f.latitude,
            longitude: f.longitude,
            stateHouseDistrict: f.stateHouseDistrict,
            stateSenateDistrict: f.stateSenateDistrict,
            geocodedAt: new Date(),
            geocodeStatus: result.status,
            geocodeInputHash,
          }
        : null,
      status: result.status,
      matchedAddress: result.matchedAddress,
      candidates: result.candidates ?? null,
      discrepancy,
    };
  }

  // W2.2: compare NORMALIZED codes — a hand-typed "2" vs a geocoded "02" is
  // the SAME district (just zero-padding), not a real discrepancy. Comparing
  // the raw strings (the pre-fix behavior) false-flagged every single-digit
  // district that happened to agree, which is the common case for any state
  // whose districts run 1-9.


  // Clamp BEFORE the idempotency comparison, not just before the write — the
  // stored value is the clamped one, so comparing against the raw BASENAME
  // would report "changed" on every run and re-write the row forever.
  const stateHouseDistrict = clampStateDistrict(result.stateHouseDistrict);
  const stateSenateDistrict = clampStateDistrict(result.stateSenateDistrict);

  const unchanged =
    f.latitude === result.latitude &&
    f.longitude === result.longitude &&
    f.stateHouseDistrict === stateHouseDistrict &&
    f.stateSenateDistrict === stateSenateDistrict &&
    f.geocodeStatus === 'matched' &&
    (!result.resolution || JSON.stringify(f.geographicResolution) === JSON.stringify(result.resolution)) &&
    f.geocodeInputHash === geocodeInputHash &&
    (f.congressionalDistrict === result.congressionalDistrict || f.districtSource !== 'geocoded') &&
    // A row backfilled for §11 (geocoded district, Congress still null) must
    // NOT read as unchanged just because its district/coords already match —
    // that is exactly the case this comparison exists to catch.
    ((f.congressionalDistrictCongress ?? null) === (result.congressionalDistrictCongress ?? null) ||
      f.districtSource !== 'geocoded');
  if (unchanged) {
    return {
      update: null,
      resolution: result.resolution,
      status: 'matched',
      matchedAddress: result.matchedAddress,
      candidates: null,
      discrepancy,
    };
  }

  return {
    resolution: result.resolution,
    update: {
      ...metadata,
      latitude: result.latitude,
      longitude: result.longitude,
      // Preserve an explicit manual congressional-district correction. The
      // geocoder still refreshes coordinates/state districts, but it must not
      // silently replace a user decision made in the profile editor. The
      // Congress number rides along with the district it describes — never
      // written without it, never written FOR a preserved manual district.
      ...(result.congressionalDistrict && !(f.districtSource === 'user' && f.congressionalDistrict)
        ? {
            congressionalDistrict: result.congressionalDistrict,
            districtSource: 'geocoded',
            ...(result.congressionalDistrictCongress != null
              ? { congressionalDistrictCongress: result.congressionalDistrictCongress }
              : {}),
          }
        : {}),
      stateHouseDistrict,
      stateSenateDistrict,
      geocodedAt: new Date(),
      geocodeStatus: 'matched',
      geocodeInputHash,
    },
    status: 'matched',
    matchedAddress: result.matchedAddress,
    candidates: result.candidates ?? null,
    discrepancy,
  };
}
