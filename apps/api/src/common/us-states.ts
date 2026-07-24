/**
 * 2-letter state/territory code -> full name, in the exact casing stored on
 * `CongressMember.state` ("Connecticut", not "CT" or "connecticut"). Any
 * query filtering CongressMember by a 2-letter code (USAspending pop_state,
 * ClientFacility.state VARCHAR(2), etc.) must translate through this map
 * first or it silently matches zero rows.
 */
export const US_STATE_BY_ABBR: Readonly<Record<string, string>> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  DC: 'District of Columbia',
  PR: 'Puerto Rico',
  GU: 'Guam',
  VI: 'Virgin Islands',
  AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
};

/**
 * Normalize a caller-supplied state (a 2-letter code OR a full name, any case)
 * to the canonical full-name casing stored on CongressMember.state. Returns
 * undefined for an unrecognized value so a caller can fail closed rather than
 * run an unfiltered roster query or silently match nothing.
 */
export function resolveStateName(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 2) return US_STATE_BY_ABBR[trimmed.toUpperCase()];
  const lower = trimmed.toLowerCase();
  return Object.values(US_STATE_BY_ABBR).find((name) => name.toLowerCase() === lower);
}

const US_ABBR_BY_STATE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(US_STATE_BY_ABBR).map(([abbr, name]) => [name, abbr]),
);

/** Inverse of `resolveStateName` — a CongressMember.state full name back to its 2-letter code. */
export function abbrForStateName(fullName: string): string | undefined {
  return US_ABBR_BY_STATE[fullName];
}
