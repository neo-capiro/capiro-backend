/**
 * Census Bureau Geocoder client (District Impact Engine, Phase 1 M1.2).
 *
 * `benchmark=Public_AR_Current&vintage=Current_Current`, no key required.
 *
 * CORRECTED DISCOVERY vs the plan's original assumption (live-verified
 * 2026-07-10): the plan expected the batch endpoint
 * (`/geographies/addressbatch`, multipart CSV upload) to return district
 * geography columns in one call for up to 10k addresses. Live testing showed
 * `/geographies/addressbatch` ALWAYS returns only the 12 base match/TIGER
 * columns (id, input address, match indicator/type, matched address,
 * lon/lat, tigerLineId, side, state/county/tract/block FIPS) — it never
 * appends geography-layer data, with or without an explicit `layers` param.
 * The single-address `/geographies/onelineaddress` JSON endpoint, by
 * contrast, returns EVERY geography layer by default (no `layers` param
 * needed) including the Congressional District and both State Legislative
 * District chambers. So "one geocode call yields both rails" (the plan's
 * PD1) is still exactly true — it's one call PER FACILITY, not one call for
 * an entire batch file. Facility counts are small (tens–low-thousands
 * platform-wide), so sequential single-address calls with a short
 * courtesy delay is the correct, honest implementation — not a paid
 * geocoder, not a batch file that silently can't deliver the district data.
 *
 * Verified field shapes (live, 2026-07-10):
 *   - Layer keys end in " - Upper" / " - Lower" (state chambers) or
 *     "Congressional Districts" — match by SUFFIX, never the leading year
 *     (e.g. "2024 State Legislative Districts - Upper"), since the year
 *     prefix drifts with each vintage refresh.
 *   - The congressional-district row carries a field named `CD<congress>`
 *     (e.g. `CD119`) — matched dynamically by `/^CD\d+$/` so a future
 *     Congress doesn't require a code change. Value is always 2-digit
 *     zero-padded, "00" for an at-large seat (verified live: Wyoming ->
 *     `CD119: "00"`, `BASENAME: "Congressional District (at Large)"` — so
 *     BASENAME is NOT usable for the federal district; CD<n> is).
 *   - The state-chamber rows carry `SLDU`/`SLDL` (zero-padded) and
 *     `BASENAME` (bare number, e.g. "3", "11"). We store BASENAME — it
 *     matches the bare-number convention `ClientFacility.congressionalDistrict`
 *     already uses ("12"/"00", not "012").
 */

const GEOCODER_BASE = 'https://geocoding.geo.census.gov/geocoder';
const BENCHMARK = 'Public_AR_Current';
const VINTAGE = 'Current_Current';

export type GeocodeStatus = 'matched' | 'no_match' | 'ambiguous' | 'error';

export interface CensusGeocodeResult {
  status: GeocodeStatus;
  latitude: number | null;
  longitude: number | null;
  /** Bare 2-digit, e.g. "02"; "00" for an at-large seat. */
  congressionalDistrict: string | null;
  /** Bare number (BASENAME), e.g. "11". Null for a unicameral/no-match chamber (e.g. NE). */
  stateHouseDistrict: string | null;
  /** Bare number (BASENAME), e.g. "8". */
  stateSenateDistrict: string | null;
  matchedAddress: string | null;
}

export interface CensusGeographyRow {
  BASENAME?: string;
  [field: string]: string | number | undefined;
}
export interface CensusAddressMatch {
  matchedAddress?: string;
  coordinates?: { x: number; y: number };
  geographies?: Record<string, CensusGeographyRow[]>;
}
export interface CensusGeographiesResponse {
  result?: { addressMatches?: CensusAddressMatch[] };
}

const NO_MATCH_RESULT: CensusGeocodeResult = {
  status: 'no_match',
  latitude: null,
  longitude: null,
  congressionalDistrict: null,
  stateHouseDistrict: null,
  stateSenateDistrict: null,
  matchedAddress: null,
};

async function fetchJson<T>(url: string, attempt = 1): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    if (attempt <= 3) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
      return fetchJson<T>(url, attempt + 1);
    }
    throw err;
  }
  if ((res.status === 429 || res.status >= 500) && attempt <= 3) {
    await new Promise((r) => setTimeout(r, attempt * 3000));
    return fetchJson<T>(url, attempt + 1);
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
  const congressionalDistrict =
    cdRow && cdFieldKey ? String(cdRow[cdFieldKey] ?? '').trim() || null : null;
  const stateHouseDistrict = lowerRow?.BASENAME ? String(lowerRow.BASENAME).trim() || null : null;
  const stateSenateDistrict = upperRow?.BASENAME ? String(upperRow.BASENAME).trim() || null : null;
  return { congressionalDistrict, stateHouseDistrict, stateSenateDistrict };
}

/**
 * Single-address geocode -> federal CD + both state legislative chambers, in
 * one free/keyless call. `ambiguous` (>1 match) never guesses a district —
 * caller should surface it for manual district entry (M1.4), same posture as
 * `no_match`.
 */
export async function geocodeAddress(
  street: string,
  city: string,
  state: string,
  zip: string,
): Promise<CensusGeocodeResult> {
  const oneLine = [street, city, `${state} ${zip}`.trim()].filter(Boolean).join(', ');
  const url =
    `${GEOCODER_BASE}/geographies/onelineaddress?address=${encodeURIComponent(oneLine)}` +
    `&benchmark=${BENCHMARK}&vintage=${VINTAGE}&format=json`;
  let json: CensusGeographiesResponse;
  try {
    json = await fetchJson<CensusGeographiesResponse>(url);
  } catch (err) {
    console.error(`[census-geocoder] geocode failed for "${oneLine}":`, (err as Error).message);
    return { ...NO_MATCH_RESULT, status: 'error' };
  }
  const matches = json.result?.addressMatches ?? [];
  if (matches.length === 0) return NO_MATCH_RESULT;
  if (matches.length > 1) return { ...NO_MATCH_RESULT, status: 'ambiguous' };
  const m = matches[0]!;
  const districts = extractDistricts(m);
  return {
    status: 'matched',
    latitude: m.coordinates ? m.coordinates.y : null,
    longitude: m.coordinates ? m.coordinates.x : null,
    ...districts,
    matchedAddress: m.matchedAddress ?? null,
  };
}
