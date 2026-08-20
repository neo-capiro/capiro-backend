/**
 * Allowed `fieldName` values on a PE data-issue report, and the canonical
 * ProgramElementYear field list it builds on.
 *
 * Hoisted from `CANONICAL_PE_YEAR_FIELDS` in
 * `apps/api/src/program-element/program-element-field-ownership.ts` and the
 * `ALLOWED_FIELD_NAMES` set in `program-element-data-issue.service.ts`.
 *
 * This matters beyond validation tidiness: `fieldName` is what tells a reviewer
 * WHICH governed value a user is disputing, and the field-ownership model keys off
 * these exact names. An unvalidated free-text fieldName produces issue rows that
 * cannot be routed to the source that owns the stage.
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

/** Canonical PE/year fields plus the UI claim labels a reporter may cite. */
export const ALLOWED_DATA_ISSUE_FIELD_NAMES: ReadonlySet<string> = new Set<string>([
  ...CANONICAL_PE_YEAR_FIELDS,
  'title',
  'description',
  'service',
  'budgetActivity',
  'appropriationType',
  'fundingSummary',
  'timeline',
  'personnel',
  'contractors',
  'other',
]);

export const PE_DATA_ISSUE_TYPES = [
  'value_incorrect',
  'missing_value',
  'wrong_source',
  'wrong_stage_or_vehicle',
  'wrong_pe_attribution',
  'other',
] as const;

export type PeDataIssueType = (typeof PE_DATA_ISSUE_TYPES)[number];

export const PE_DATA_ISSUE_STATUSES = ['open', 'resolved', 'dismissed'] as const;

export type PeDataIssueStatus = (typeof PE_DATA_ISSUE_STATUSES)[number];

export const PE_DATA_ISSUE_MAX_DESCRIPTION = 4000;
export const PE_DATA_ISSUE_MAX_RESOLUTION_NOTES = 4000;
export const PE_DATA_ISSUE_MAX_URL = 2000;
