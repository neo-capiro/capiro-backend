/** Serving-term request and provenance. This is deterministic policy, never model output. */
export interface GeographicBoundaryVersion {
  congress: number;
  stateLegislativeYear: number;
  benchmark: string;
  vintage: string;
  geometryVersion: string;
  effectiveFrom: string;
  effectiveTo: string;
}
export type GeographicResolutionStatus =
  | 'resolved'
  | 'needs_address'
  | 'ambiguous'
  | 'source_unavailable'
  | 'not_applicable'
  | 'stale_boundary';
export interface GeographicDistrict {
  chamber: 'house' | 'state_lower' | 'state_upper';
  code: string;
  geoid: string | null;
  stateFips: string | null;
  congress: number | null;
  layer: string;
  providerCode?: string;
}
export interface GeographicResolution {
  status: GeographicResolutionStatus;
  precision: 'verified_point' | 'address_point' | 'street_interpolated' | 'unknown';
  requiresReview: boolean;
  source: 'census' | 'arcgis_census' | 'census_tigerweb' | null;
  version: GeographicBoundaryVersion;
  stateFips: string | null;
  districts: GeographicDistrict[];
  resolvedAt: string;
  providerEvidence?: Record<string, unknown>;
  reason?: string;
  boundaryAdjacent?: boolean;
  overrideConflict?: { handEntered: string; geocoded: string };
}
export interface VerifiedFacilityPoint {
  latitude: number;
  longitude: number;
  verifiedAt: string;
}
export function servingBoundaryVersion(): GeographicBoundaryVersion {
  const congress = Number(process.env.CENSUS_SERVING_CONGRESS ?? '119');
  const stateLegislativeYear = Number(process.env.CENSUS_STATE_LEGISLATIVE_YEAR ?? '2024');
  if (
    !Number.isInteger(congress) ||
    congress < 1 ||
    !Number.isInteger(stateLegislativeYear) ||
    stateLegislativeYear < 2000
  ) {
    throw new Error('Invalid serving boundary configuration');
  }
  const firstYear = 1789 + (congress - 1) * 2;
  return {
    congress,
    stateLegislativeYear,
    benchmark: 'Public_AR_Current',
    vintage: 'Current_Current',
    geometryVersion: process.env.CENSUS_GEOMETRY_VERSION ?? 'BAS 2026',
    effectiveFrom: `${firstYear}-01-03`,
    effectiveTo: `${firstYear + 2}-01-03`,
  };
}
export function boundaryVersionKey(version: GeographicBoundaryVersion): string {
  return [
    version.congress,
    version.stateLegislativeYear,
    version.benchmark,
    version.vintage,
    version.geometryVersion,
  ].join(':');
}
export function isVerifiedFacilityPoint(value: unknown): value is VerifiedFacilityPoint {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<VerifiedFacilityPoint>;
  return (
    typeof p.latitude === 'number' &&
    Number.isFinite(p.latitude) &&
    Math.abs(p.latitude) <= 90 &&
    typeof p.longitude === 'number' &&
    Number.isFinite(p.longitude) &&
    Math.abs(p.longitude) <= 180 &&
    typeof p.verifiedAt === 'string' &&
    Number.isFinite(Date.parse(p.verifiedAt))
  );
}
export function physicalAddressEligibility(
  street: string | null | undefined,
  city: string | null | undefined,
  state: string | null | undefined,
  zip?: string | null,
  country?: string | null,
): 'eligible' | 'needs_address' | 'not_applicable' {
  if (country && !['US', 'PR', 'GU', 'VI', 'AS', 'MP'].includes(country.trim().toUpperCase()))
    return 'not_applicable';
  const address = street?.trim() ?? '';
  if (
    !address ||
    /\b(?:p\.?\s*o\.?\s*box|post\s+office\s+box|postal\s+box|pmb)\b/i.test(address) ||
    !/\d/.test(address) ||
    !/[a-z]/i.test(address) ||
    !((city?.trim() && state?.trim()) || /^\d{5}(?:-\d{4})?$/.test(zip ?? ''))
  )
    return 'needs_address';
  return 'eligible';
}
