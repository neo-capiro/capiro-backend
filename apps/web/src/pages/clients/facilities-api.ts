import type { AxiosInstance } from 'axios';

/**
 * Step 2.3 — web API for client facilities (CRUD).
 *
 * Mirrors apps/api/src/clients/client-facilities.controller.ts (mounted at
 * /api/clients/:clientId/facilities). The congressional district is the BARE number
 * ("12"); the state is carried separately ("TX"). Display strings combine them as "ST-NN".
 */

export interface ClientFacility {
  id: string;
  clientId: string;
  name: string;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** Bare district number, e.g. "12" or the at-large sentinel "00". */
  congressionalDistrict: string | null;
  districtSource: string | null;
  employeeCount: number | null;
  notes: string | null;
  /** District Impact Engine (Phase 1 M1.4) — Census Geocoder outputs. */
  latitude: number | null;
  longitude: number | null;
  stateHouseDistrict: string | null;
  stateSenateDistrict: string | null;
  geocodedAt: string | null;
  /** 'matched' | 'no_match' | 'ambiguous' | 'error' | null (never attempted). */
  geocodeStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Create/update payload. Bare district number; state separate. */
export interface FacilityPayload {
  name: string;
  addressLine?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  congressionalDistrict?: string | null;
  districtSource?: string | null;
  /** District Impact Engine (Phase 1 M1.4) — manual fallback, geocoder overwrites once matched. */
  stateHouseDistrict?: string | null;
  stateSenateDistrict?: string | null;
  employeeCount?: number | null;
  notes?: string | null;
}

export async function getClientFacilities(
  api: AxiosInstance,
  clientId: string,
): Promise<ClientFacility[]> {
  return (
    await api.get<ClientFacility[]>(`/api/clients/${encodeURIComponent(clientId)}/facilities`)
  ).data;
}

export async function createClientFacility(
  api: AxiosInstance,
  clientId: string,
  payload: FacilityPayload,
): Promise<ClientFacility> {
  return (
    await api.post<ClientFacility>(
      `/api/clients/${encodeURIComponent(clientId)}/facilities`,
      payload,
    )
  ).data;
}

export async function updateClientFacility(
  api: AxiosInstance,
  clientId: string,
  id: string,
  payload: Partial<FacilityPayload>,
): Promise<ClientFacility> {
  return (
    await api.patch<ClientFacility>(
      `/api/clients/${encodeURIComponent(clientId)}/facilities/${encodeURIComponent(id)}`,
      payload,
    )
  ).data;
}

export async function deleteClientFacility(
  api: AxiosInstance,
  clientId: string,
  id: string,
): Promise<{ deleted: true }> {
  return (
    await api.delete<{ deleted: true }>(
      `/api/clients/${encodeURIComponent(clientId)}/facilities/${encodeURIComponent(id)}`,
    )
  ).data;
}

/**
 * Bare district number ("12") or the at-large sentinel "00". Mirrors the API's
 * `/^[0-9]{1,2}$/` format validator; the server ALSO cross-validates the district
 * against the state's seat count (see US_HOUSE_SEATS below), so a format-only
 * check is not enough to avoid a server 400.
 */
export const DISTRICT_PATTERN = /^[0-9]{1,2}$/;

/**
 * State code -> number of U.S. House seats (1 == single at-large district).
 * Mirrors apps/api/src/common/us-congressional-districts.ts (2020 Census
 * apportionment; non-voting delegations modeled as a single at-large seat) so
 * the form can run the server's state⇄district cross-check client-side.
 */
export const US_HOUSE_SEATS: Readonly<Record<string, number>> = {
  AL: 7,
  AK: 1,
  AZ: 9,
  AR: 4,
  CA: 52,
  CO: 8,
  CT: 5,
  DE: 1,
  FL: 28,
  GA: 14,
  HI: 2,
  ID: 2,
  IL: 17,
  IN: 9,
  IA: 4,
  KS: 4,
  KY: 6,
  LA: 6,
  ME: 2,
  MD: 8,
  MA: 9,
  MI: 13,
  MN: 8,
  MS: 4,
  MO: 8,
  MT: 2,
  NE: 3,
  NV: 4,
  NH: 2,
  NJ: 12,
  NM: 3,
  NY: 26,
  NC: 14,
  ND: 1,
  OH: 15,
  OK: 5,
  OR: 6,
  PA: 17,
  RI: 2,
  SC: 7,
  SD: 1,
  TN: 9,
  TX: 38,
  UT: 4,
  VT: 1,
  VA: 11,
  WA: 10,
  WV: 2,
  WI: 8,
  WY: 1,
  // Non-voting delegations (single at-large seat each)
  DC: 1,
  PR: 1,
  GU: 1,
  VI: 1,
  AS: 1,
  MP: 1,
};

/** District Impact Engine (Phase 1 M1.4) — geocode-status display labels. */
export const GEOCODE_STATUS_LABEL: Record<string, string> = {
  matched: 'Geocoded',
  no_match: 'No match — confirm address',
  ambiguous: 'Ambiguous — confirm address',
  error: 'Geocode failed — will retry',
};

/** Combine a bare district number + state into the "ST-NN" display form. */
export function formatFacilityDistrict(
  state: string | null | undefined,
  district: string | null | undefined,
): string {
  const st = (state ?? '').trim().toUpperCase();
  const dist = (district ?? '').trim();
  if (st && dist) return `${st}-${dist}`;
  return st || dist || '';
}

/** US states + DC + territories, two-letter postal codes (for the facility state dropdown). */
export const US_STATE_CODES: string[] = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL',
  'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH',
  'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI',
  'WY', 'AS', 'GU', 'MP', 'PR', 'VI',
];
