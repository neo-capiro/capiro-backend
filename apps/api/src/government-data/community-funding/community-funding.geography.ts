import type { Chamber } from './community-funding.types.js';

const US_STATE_CODES = new Set(
  'AL AK AS AZ AR CA CO CT DE DC FL GA GU HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND MP OH OK OR PA PR RI SC SD TN TX UT VT VA VI WA WV WI WY'.split(
    ' ',
  ),
);

export interface CommunityFundingGeographyInput {
  chamber: Chamber;
  requesterState: string | null;
  requesterDistrict: string | null;
  projectState: string | null;
}

export interface NormalizedCommunityFundingGeography {
  state: string | null;
  district: string | null;
  conflictReason: string | null;
}

function stateCode(value: string | null): string | null {
  const normalized = value?.trim().toUpperCase() ?? '';
  return US_STATE_CODES.has(normalized) ? normalized : null;
}

/**
 * Parse the source's strict state-plus-district convention (for example FL08).
 * This deliberately does not accept FL8, sentinel districts, or territories
 * without voting House districts. The original source value remains on the
 * canonical/provenance rows; this function only derives the read/ingest key.
 */
export function parseCommunityFundingStdd(
  value: string | null,
): { state: string; district: string } | null {
  const text = value?.trim().toUpperCase() ?? '';
  const match = /^([A-Z]{2})(\d{2}|AL)$/.exec(text);
  if (!match) return null;
  const state = match[1]!;
  const districtToken = match[2]!;
  if (!US_STATE_CODES.has(state) || ['AS', 'DC', 'GU', 'MP', 'PR', 'VI'].includes(state)) {
    return null;
  }
  const district = districtToken === 'AL' ? '00' : districtToken;
  const numeric = Number(district);
  if (!Number.isInteger(numeric) || numeric >= 90) return null;
  return { state, district };
}

/**
 * Derive conservative canonical geography. Senate rows remain statewide even
 * when a district-like source token is present. Conflicting explicit and STDD
 * state values stay unresolved rather than selecting one silently.
 */
export function normalizeCommunityFundingGeography(
  input: CommunityFundingGeographyInput,
): NormalizedCommunityFundingGeography {
  const explicitState = stateCode(input.requesterState) ?? stateCode(input.projectState);
  if (input.chamber === 'senate') {
    return { state: explicitState, district: null, conflictReason: null };
  }

  const parsed = parseCommunityFundingStdd(input.requesterDistrict);
  if (parsed && explicitState && parsed.state !== explicitState) {
    return {
      state: null,
      district: null,
      conflictReason: `requester state ${explicitState} conflicts with source district ${input.requesterDistrict?.trim().toUpperCase()}`,
    };
  }
  if (parsed) return { ...parsed, conflictReason: null };

  const rawDistrict = input.requesterDistrict?.trim().toUpperCase() ?? '';
  const numericDistrict = /^(?:\d{1,2}|AL|AT LARGE)$/.test(rawDistrict)
    ? rawDistrict === 'AL' || rawDistrict === 'AT LARGE'
      ? '00'
      : String(Number(rawDistrict)).padStart(2, '0')
    : null;
  if (numericDistrict && Number(numericDistrict) < 90) {
    return { state: explicitState, district: numericDistrict, conflictReason: null };
  }
  return { state: explicitState, district: null, conflictReason: null };
}
