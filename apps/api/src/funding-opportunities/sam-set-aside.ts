/**
 * SAM.gov `typeOfSetAside` codes and their published meanings. Notices store
 * only the code (for example `SBA`), which Meri could not interpret as an
 * eligibility restriction. Unknown codes stay null rather than being guessed.
 */
const SAM_SET_ASIDES: Readonly<Record<string, string>> = {
  SBA: 'Total Small Business Set-Aside (FAR 19.5)',
  SBP: 'Partial Small Business Set-Aside (FAR 19.5)',
  '8A': '8(a) Set-Aside (FAR 19.8)',
  '8AN': '8(a) Sole Source (FAR 19.8)',
  HZC: 'HUBZone Set-Aside (FAR 19.13)',
  HZS: 'HUBZone Sole Source (FAR 19.13)',
  SDVOSBC: 'Service-Disabled Veteran-Owned Small Business (SDVOSB) Set-Aside (FAR 19.14)',
  SDVOSBS: 'SDVOSB Sole Source (FAR 19.14)',
  WOSB: 'Women-Owned Small Business (WOSB) Program Set-Aside (FAR 19.15)',
  WOSBSS: 'WOSB Program Sole Source (FAR 19.15)',
  EDWOSB: 'Economically Disadvantaged WOSB (EDWOSB) Program Set-Aside (FAR 19.15)',
  EDWOSBSS: 'EDWOSB Program Sole Source (FAR 19.15)',
  LAS: 'Local Area Set-Aside (FAR 26.2)',
  IEE: 'Indian Economic Enterprise (IEE) Set-Aside',
  ISBEE: 'Indian Small Business Economic Enterprise (ISBEE) Set-Aside',
  BICIV: 'Buy Indian Set-Aside',
  VSA: 'Veteran-Owned Small Business Set-Aside (VA)',
  VSS: 'Veteran-Owned Small Business Sole Source (VA)',
};

export function samSetAsideDescription(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  return SAM_SET_ASIDES[code.trim().toUpperCase()] ?? null;
}

/** Set-asides restricted to small or socioeconomic businesses; a large business
 * cannot be the prime offeror on these. */
export function samSetAsideRestrictsToSmallBusiness(code: string | null | undefined): boolean {
  const key = typeof code === 'string' ? code.trim().toUpperCase() : '';
  return Boolean(SAM_SET_ASIDES[key]) && key !== 'LAS';
}
