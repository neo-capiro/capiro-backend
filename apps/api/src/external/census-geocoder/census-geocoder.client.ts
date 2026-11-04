import { normalizeFacilityDistrictCode } from '../../common/district-code.util.js';
import { US_STATE_FIPS_TO_USPS } from '../../common/us-congressional-districts.js';
import { physicalAddressEligibility, servingBoundaryVersion, type GeographicBoundaryVersion, type GeographicResolution, type VerifiedFacilityPoint } from './geographic-boundary.js';
import { resolveOfficialBoundaries } from './tigerweb-boundary.client.js';

const GEOCODER_BASE = 'https://geocoding.geo.census.gov/geocoder';
const ARCGIS_GEOCODER_BASE = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer';
const ARCGIS_MIN_SCORE = 90;
// One budget for matching, fallback, geography lookup, retries AND body reads.
// Explicit resolution must finish before the browser's 30-second deadline.
export const GEOCODE_TIMEOUT_MS = 25_000;

interface ArcGisCandidate {
  address?: string;
  location?: { x?: number; y?: number };
  score?: number;
  attributes?: { Addr_type?: string };
}

interface ArcGisResponse {
  candidates?: ArcGisCandidate[];
}

export type GeocodeStatus = 'matched' | 'no_match' | 'ambiguous' | 'error';

/** A complete Census hit that can be shown as a safe address recommendation. */
export interface CensusGeocodeCandidate {
  resolution?: GeographicResolution;
  matchedAddress: string | null;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  latitude: number | null;
  longitude: number | null;
  congressionalDistrict: string | null;
  congressionalDistrictCongress: number | null;
  stateHouseDistrict: string | null;
  stateSenateDistrict: string | null;
}

export interface CensusGeocodeResult {
  resolution?: GeographicResolution;
  status: GeocodeStatus;
  latitude: number | null;
  longitude: number | null;
  /** Bare 2-digit, e.g. "02"; "00" for an at-large seat. */
  congressionalDistrict: string | null;
  /**
   * Which Congress the `CD<congress>` field key names (Release 1, §11) — e.g.
   * `119` from a `CD119` key. Parsed from the SAME field the district code
   * itself comes from, so it can never disagree with `congressionalDistrict`
   * about which vintage it describes. Null only when no CD layer matched at
   * all (mirrors `congressionalDistrict` being null).
   */
  congressionalDistrictCongress: number | null;
  /** Bare number (BASENAME), e.g. "11". Null for a unicameral/no-match chamber (e.g. NE). */
  stateHouseDistrict: string | null;
  /** Bare number (BASENAME), e.g. "8". */
  stateSenateDistrict: string | null;
  matchedAddress: string | null;
  /** Other complete hits returned by Census when the input is ambiguous. */
  candidates?: CensusGeocodeCandidate[];
}

export interface CensusGeographyRow {
  BASENAME?: string;
  [field: string]: string | number | undefined;
}
export interface CensusAddressMatch {
  matchedAddress?: string;
  addressComponents?: {
    fromAddress?: string;
    preQualifier?: string;
    preDirection?: string;
    preType?: string;
    streetName?: string;
    suffixType?: string;
    suffixDirection?: string;
    city?: string;
    state?: string;
    zip?: string;
  };
  coordinates?: { x: number; y: number };
  geographies?: Record<string, CensusGeographyRow[]>;
}
export interface CensusGeographiesResponse {
  result?: { addressMatches?: CensusAddressMatch[]; input?: { benchmark?: unknown; vintage?: unknown } };
}

const NO_MATCH_RESULT: CensusGeocodeResult = {
  status: 'no_match',
  latitude: null,
  longitude: null,
  congressionalDistrict: null,
  congressionalDistrictCongress: null,
  stateHouseDistrict: null,
  stateSenateDistrict: null,
  matchedAddress: null,
};

async function fetchJson<T>(url: string, signal: AbortSignal, attempt = 1): Promise<T> {
  let res: Response;
  try {
    signal.throwIfAborted();
    res = await fetch(url, { headers: { accept: 'application/json' }, signal });
  } catch (err) {
    if (!signal.aborted && attempt < 2) {
      await new Promise((r) => setTimeout(r, 250));
      return fetchJson<T>(url, signal, attempt + 1);
    }
    throw err;
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 2 && !signal.aborted) {
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 500));
    return fetchJson<T>(url, signal, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/**
 * Pure parse of one address-match's `geographies` object into the three
 * district codes. Exported for fixture-based unit testing (no network) —
 * layer-key matching by suffix (survives a vintage-year bump) and the CD<n>
 * field-name matching (survives a Congress number bump) are the two
 * behaviors most worth pinning.
 */
export function extractDistricts(match: CensusAddressMatch): {
  congressionalDistrict: string | null;
  congressionalDistrictCongress: number | null;
  stateHouseDistrict: string | null;
  stateSenateDistrict: string | null;
} {
  const geos = match.geographies ?? {};
  const keys = Object.keys(geos);
  const cdKey = keys.find((k) => /Congressional Districts$/.test(k));
  const upperKey = keys.find((k) => / - Upper$/.test(k));
  const lowerKey = keys.find((k) => / - Lower$/.test(k));
  const cdRow = cdKey ? geos[cdKey]?.[0] : undefined;
  const upperRow = upperKey ? geos[upperKey]?.[0] : undefined;
  const lowerRow = lowerKey ? geos[lowerKey]?.[0] : undefined;
  const cdFieldKey = cdRow ? Object.keys(cdRow).find((k) => /^CD\d+$/.test(k)) : undefined;
  const state = match.addressComponents?.state
    ?? US_STATE_FIPS_TO_USPS[String(cdRow?.STATE ?? '')];
  const congressionalDistrict = normalizeFacilityDistrictCode(state,
    cdRow && cdFieldKey ? String(cdRow[cdFieldKey] ?? '').trim() || null : null);
  // Parsed from the SAME field key the district code itself comes from, so
  // "which district" and "which Congress" can never disagree about vintage.
  const congressMatch = cdFieldKey ? /^CD(\d+)$/.exec(cdFieldKey) : null;
  const congressionalDistrictCongress = congressMatch ? Number(congressMatch[1]) : null;
  const stateHouseDistrict = lowerRow?.BASENAME ? String(lowerRow.BASENAME).trim() || null : null;
  const stateSenateDistrict = upperRow?.BASENAME ? String(upperRow.BASENAME).trim() || null : null;
  return {
    congressionalDistrict,
    congressionalDistrictCongress,
    stateHouseDistrict,
    stateSenateDistrict,
  };
}

/** Convert one raw Census hit into the safe candidate shape exposed to callers. */
export function parseGeocodeMatch(match: CensusAddressMatch): CensusGeocodeCandidate {
  const districts = extractDistricts(match);
  const components = match.addressComponents;
  const addressLine = components
    ? [
        components.fromAddress,
        components.preQualifier,
        components.preDirection,
        components.preType,
        components.streetName,
        components.suffixType,
        components.suffixDirection,
      ]
        .filter(Boolean)
        .join(' ')
    : null;
  return {
    matchedAddress: match.matchedAddress ?? null,
    addressLine: addressLine || null,
    city: components?.city ?? null,
    state: components?.state ?? null,
    zip: components?.zip ?? null,
    latitude: match.coordinates?.y ?? null,
    longitude: match.coordinates?.x ?? null,
    ...districts,
  };
}

/**
 * Fall back to ArcGIS only when Census cannot match the address. ArcGIS must
 * return one high-confidence physical point; postal/street-name candidates are
 * rejected because they cannot safely determine a district.
 */
async function geocodeWithArcGis(
  oneLine: string,
  signal: AbortSignal,
): Promise<{
  latitude: number;
  longitude: number;
  matchedAddress: string;
  precision: 'address_point' | 'street_interpolated';
  score: number;
} | null> {
  const url =
    `${ARCGIS_GEOCODER_BASE}/findAddressCandidates?SingleLine=${encodeURIComponent(oneLine)}` +
    '&f=json&outFields=Addr_type&maxLocations=3';
  const json = await fetchJson<ArcGisResponse>(url, signal);
  const candidates = (json.candidates ?? []).filter(
    (candidate) =>
      Number(candidate.score ?? 0) >= ARCGIS_MIN_SCORE &&
      ['PointAddress', 'StreetAddress'].includes(candidate.attributes?.Addr_type ?? '') &&
      Number.isFinite(candidate.location?.x) &&
      Number.isFinite(candidate.location?.y),
  );
  if (candidates.length !== 1) return null;
  const candidate = candidates[0]!;
  return {
    latitude: Number(candidate.location!.y),
    longitude: Number(candidate.location!.x),
    matchedAddress: candidate.address ?? oneLine,
    precision: candidate.attributes?.Addr_type === 'PointAddress' ? 'address_point' : 'street_interpolated',
    score: Number(candidate.score),
  };
}

export interface GeocodeRequestOptions {
  boundary?: GeographicBoundaryVersion;
  country?: string | null;
  verifiedPoint?: VerifiedFacilityPoint;
}

/** Validate moving geocoder labels against the requested term, then resolve official polygons. */
async function resolvePoint(
  result: CensusGeocodeResult, version: GeographicBoundaryVersion, precision: GeographicResolution['precision'],
  source: GeographicResolution['source'], signal: AbortSignal, providerEvidence: Record<string, unknown>,
): Promise<CensusGeocodeResult> {
  const base: GeographicResolution = { status: 'resolved', precision, source, version,
    requiresReview: precision === 'street_interpolated', stateFips: null, districts: [],
    resolvedAt: new Date().toISOString(), providerEvidence };
  if (!Number.isFinite(result.latitude) || !Number.isFinite(result.longitude) || result.latitude == null || result.longitude == null) {
    return { ...result, status: 'no_match', resolution: { ...base, status: 'needs_address', requiresReview: true } };
  }
  try {
    const official = await resolveOfficialBoundaries(result.latitude, result.longitude, version, signal, fetchJson);
    if (!official) return { ...result, congressionalDistrict: null, congressionalDistrictCongress: null,
      stateHouseDistrict: null, stateSenateDistrict: null,
      resolution: { ...base, status: 'stale_boundary', requiresReview: true, reason: 'Requested official boundary version is unavailable' } };
    const house = official.districts.find((d) => d.chamber === 'house');
    const lower = official.districts.find((d) => d.chamber === 'state_lower');
    const upper = official.districts.find((d) => d.chamber === 'state_upper');
    return { ...result, status: official.ambiguous ? 'ambiguous' : 'matched',
      congressionalDistrict: official.ambiguous ? null : house?.code ?? null,
      congressionalDistrictCongress: official.ambiguous ? null : version.congress,
      stateHouseDistrict: official.ambiguous ? null : lower?.code ?? null,
      stateSenateDistrict: official.ambiguous ? null : upper?.code ?? null,
      resolution: { ...base, source: source === 'arcgis_census' ? source : 'census_tigerweb',
        status: official.ambiguous ? 'ambiguous' : 'resolved',
        stateFips: house?.stateFips ?? null, districts: official.districts,
        boundaryAdjacent: official.adjacent, requiresReview: base.requiresReview || official.adjacent || official.ambiguous } };
  } catch {
    return { ...result, congressionalDistrict: null, congressionalDistrictCongress: null,
      stateHouseDistrict: null, stateSenateDistrict: null,
      resolution: { ...base, status: 'source_unavailable', requiresReview: true, reason: 'Official boundary source unavailable' } };
  }
}

/** Census owns geographies; ArcGIS supplies only a sufficiently precise address point. */
export async function geocodeAddress(
  street: string, city: string, state: string, zip: string, options: GeocodeRequestOptions = {},
): Promise<CensusGeocodeResult> {
  const version = options.boundary ?? servingBoundaryVersion();
  const signal = AbortSignal.timeout(GEOCODE_TIMEOUT_MS);
  const eligibility = physicalAddressEligibility(street, city, state, zip, options.country);
  const emptyResolution = (status: GeographicResolution['status']): GeographicResolution => ({
    status, precision: 'unknown', requiresReview: status !== 'not_applicable', source: null, version,
    stateFips: null, districts: [], resolvedAt: new Date().toISOString(),
  });
  if (eligibility === 'not_applicable' || (!options.verifiedPoint && eligibility === 'needs_address')) {
    return { ...NO_MATCH_RESULT, resolution: emptyResolution(eligibility === 'not_applicable' ? eligibility : 'needs_address') };
  }
  const query = `benchmark=${encodeURIComponent(version.benchmark)}&vintage=${encodeURIComponent(version.vintage)}&format=json`;
  if (options.verifiedPoint) {
    const point = options.verifiedPoint;
    try {
      const response = await fetchJson<{ result?: { geographies?: Record<string, CensusGeographyRow[]>; input?: unknown } }>(
        `${GEOCODER_BASE}/geographies/coordinates?x=${point.longitude}&y=${point.latitude}&${query}`, signal);
      return resolvePoint({ ...NO_MATCH_RESULT, status: 'matched', latitude: point.latitude, longitude: point.longitude,
        ...extractDistricts({ geographies: response.result?.geographies }) }, version, 'verified_point', 'census', signal,
        { input: response.result?.input ?? null, verifiedAt: point.verifiedAt });
    } catch { return { ...NO_MATCH_RESULT, status: 'error', resolution: emptyResolution('source_unavailable') }; }
  }
  const oneLine = [street, city, `${state} ${zip}`.trim()].filter(Boolean).join(', ');
  try {
    const json = await fetchJson<CensusGeographiesResponse>(
      `${GEOCODER_BASE}/geographies/onelineaddress?address=${encodeURIComponent(oneLine)}&${query}`, signal);
    const matches = json.result?.addressMatches ?? [];
    if (matches.length > 1) {
      const candidates = await Promise.all(matches.slice(0, 5).map(async (match) => {
        const candidate = parseGeocodeMatch(match);
        const resolved = await resolvePoint({ status: 'matched', ...candidate }, version, 'street_interpolated', 'census', signal,
          { input: json.result?.input ?? null, matchedAddress: match.matchedAddress ?? null, geographies: match.geographies ?? {} });
        return { ...candidate, ...resolved };
      }));
      return { ...NO_MATCH_RESULT, status: 'ambiguous', candidates, resolution: emptyResolution('ambiguous') };
    }
    if (matches.length === 1) {
      const matched = await resolvePoint({ status: 'matched', ...parseGeocodeMatch(matches[0]!) }, version,
        'street_interpolated', 'census', signal, { input: json.result?.input ?? null,
          matchedAddress: matches[0]!.matchedAddress ?? null, geographies: matches[0]!.geographies ?? {} });
      // Address-range coordinates are interpolated, never a verified rooftop point.
      return { ...matched, candidates: matched.resolution?.requiresReview ? [{ ...parseGeocodeMatch(matches[0]!), ...matched }] : undefined };
    }
    const fallback = await geocodeWithArcGis(oneLine, signal);
    if (!fallback) return { ...NO_MATCH_RESULT, resolution: emptyResolution('needs_address') };
    const geo = await fetchJson<{ result?: { geographies?: Record<string, CensusGeographyRow[]>; input?: unknown } }>(
      `${GEOCODER_BASE}/geographies/coordinates?x=${fallback.longitude}&y=${fallback.latitude}&${query}`, signal);
    const resolved = await resolvePoint({ status: 'matched', latitude: fallback.latitude, longitude: fallback.longitude,
      matchedAddress: fallback.matchedAddress, ...extractDistricts({ geographies: geo.result?.geographies }) },
      version, fallback.precision, 'arcgis_census', signal,
      { vendorScore: fallback.score, vendorScoreIsProbability: false, input: geo.result?.input ?? null,
        matchedAddress: fallback.matchedAddress, geographies: geo.result?.geographies ?? {} });
    return { ...resolved, candidates: resolved.resolution?.requiresReview ? [{ ...resolved, addressLine: street, city, state, zip }] : undefined };
  } catch {
    return { ...NO_MATCH_RESULT, status: 'error', resolution: emptyResolution('source_unavailable') };
  }
}
