/**
 * Canonical ProgramElementYear fields are owned by the government source that
 * actually controls that legislative/budget stage. A source may still be
 * retained as an observation when it does not own a field, but it must never
 * become canonical by virtue of a global source rank.
 */
export const CANONICAL_PE_YEAR_FIELDS = [
  'request',
  'hascMark',
  'sascMark',
  'hacDMark',
  'sacDMark',
  'conference',
  'ndaaConference',
  'enacted',
  'reprogrammed',
  'executed',
] as const;

export type CanonicalPeYearField = (typeof CANONICAL_PE_YEAR_FIELDS)[number];

export type PeSourceAuthority =
  | 'manual_override'
  | 'presidents_budget_request'
  | 'hasc_authorization'
  | 'sasc_authorization'
  | 'hacd_appropriations'
  | 'sacd_appropriations'
  | 'ndaa_conference'
  | 'appropriations_conference'
  | 'enacted_public_law'
  | 'reprogramming'
  | 'execution'
  | 'fixture'
  | 'unknown';

const AUTHORITY_FIELDS: Record<Exclude<PeSourceAuthority, 'fixture' | 'unknown'>, readonly CanonicalPeYearField[]> = {
  manual_override: CANONICAL_PE_YEAR_FIELDS,
  presidents_budget_request: ['request'],
  hasc_authorization: ['hascMark'],
  sasc_authorization: ['sascMark'],
  hacd_appropriations: ['hacDMark'],
  sacd_appropriations: ['sacDMark'],
  ndaa_conference: ['ndaaConference'],
  appropriations_conference: ['conference'],
  enacted_public_law: ['enacted'],
  reprogramming: ['reprogrammed'],
  execution: ['executed'],
};

function normalizedSource(source: string): string {
  return source.trim().toLowerCase().replace(/[-\s]+/g, '_');
}

/** Derive the best-known authority for legacy callers that do not yet pass context. */
export function authorityForSource(source: string): PeSourceAuthority {
  const value = normalizedSource(source);

  if (value === 'manual_override' || value.startsWith('manual_override_')) return 'manual_override';
  if (value === 'fixture' || value.startsWith('fixture_')) return 'fixture';

  if (
    value.startsWith('r_doc') ||
    value.startsWith('p_doc') ||
    value.startsWith('pdoc') ||
    value.startsWith('o1') ||
    value.startsWith('dod_comptroller') ||
    value.startsWith('presidents_budget') ||
    value.startsWith('president_budget')
  ) {
    return 'presidents_budget_request';
  }

  if (value.startsWith('hasc_report') || value.startsWith('hasc_authorization')) {
    return 'hasc_authorization';
  }
  if (value.startsWith('sasc_report') || value.startsWith('sasc_authorization')) {
    return 'sasc_authorization';
  }
  if (value.startsWith('hac_d_report') || value.startsWith('hacd_report')) {
    return 'hacd_appropriations';
  }
  if (value.startsWith('sac_d_report') || value.startsWith('sacd_report')) {
    return 'sacd_appropriations';
  }
  if (value.startsWith('approps_conference_report') || value.startsWith('appropriations_conference')) {
    return 'appropriations_conference';
  }
  if (value.startsWith('conference_report') || value.startsWith('ndaa_conference')) {
    return 'ndaa_conference';
  }
  if (value.startsWith('public_law') || value.startsWith('enacted_public_law')) {
    return 'enacted_public_law';
  }
  if (value.startsWith('reprogramming')) return 'reprogramming';
  if (value.startsWith('execution') || value.startsWith('executed')) return 'execution';

  return 'unknown';
}

export function mayOwnCanonicalField(
  authority: PeSourceAuthority,
  field: CanonicalPeYearField,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  if (authority === 'unknown') return false;
  if (authority === 'fixture') return nodeEnv === 'test';
  return AUTHORITY_FIELDS[authority].includes(field);
}
