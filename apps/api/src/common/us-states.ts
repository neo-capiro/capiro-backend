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

/** Source FIPS identity used by Census and GSA FRPP (including territories). */
const STATE_FIPS_BY_ABBR: Readonly<Record<string, string>> = {
  AL: '01',
  AK: '02',
  AZ: '04',
  AR: '05',
  CA: '06',
  CO: '08',
  CT: '09',
  DE: '10',
  DC: '11',
  FL: '12',
  GA: '13',
  HI: '15',
  ID: '16',
  IL: '17',
  IN: '18',
  IA: '19',
  KS: '20',
  KY: '21',
  LA: '22',
  ME: '23',
  MD: '24',
  MA: '25',
  MI: '26',
  MN: '27',
  MS: '28',
  MO: '29',
  MT: '30',
  NE: '31',
  NV: '32',
  NH: '33',
  NJ: '34',
  NM: '35',
  NY: '36',
  NC: '37',
  ND: '38',
  OH: '39',
  OK: '40',
  OR: '41',
  PA: '42',
  RI: '44',
  SC: '45',
  SD: '46',
  TN: '47',
  TX: '48',
  UT: '49',
  VT: '50',
  VA: '51',
  WA: '53',
  WV: '54',
  WI: '55',
  WY: '56',
  AS: '60',
  GU: '66',
  MP: '69',
  PR: '72',
  VI: '78',
};

/** Translate at the query boundary; never rewrite source-hashed FRPP facts. */
export function stateFipsForAbbr(abbr: string): string | undefined {
  return STATE_FIPS_BY_ABBR[abbr.trim().toUpperCase()];
}
