/**
 * The supported outreach audience vocabulary (the wizard's manual-add audience
 * picker, StepRecipientsSelect.tsx MANUAL_AUDIENCE_OPTIONS). Single backend
 * definition, reused by the DTO whitelist (@IsIn) and the recipient
 * normalizer. No pre-existing shared package defines this list.
 */

export const OUTREACH_AUDIENCE_TYPES = [
  'congressional_office',
  'federal_agency',
  'defense_acquisition_office',
  'state_legislator',
  'state_agency',
  'local_official',
  'coalition',
  'client_executive',
  'internal_colleague',
] as const;

export type OutreachAudienceType = (typeof OUTREACH_AUDIENCE_TYPES)[number];

const OUTREACH_AUDIENCE_TYPE_SET: ReadonlySet<string> = new Set(
  OUTREACH_AUDIENCE_TYPES,
);

/** Tuple-checked read: a value outside the vocabulary yields undefined. */
export function readOutreachAudienceType(
  value: unknown,
): OutreachAudienceType | undefined {
  return typeof value === 'string' &&
    OUTREACH_AUDIENCE_TYPE_SET.has(value)
    ? (value as OutreachAudienceType)
    : undefined;
}