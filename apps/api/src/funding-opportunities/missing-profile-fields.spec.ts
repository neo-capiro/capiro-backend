import { describe, expect, test } from '@jest/globals';
import { missingProfileFields, profileIsTooThin, type ProfileCompleteness } from './missing-profile-fields.js';

function complete(partial: Partial<ProfileCompleteness> = {}): ProfileCompleteness {
  return {
    clientId: 'client-1',
    hasUei: false,
    hasCageCode: false,
    naicsCount: 0,
    pscCount: 0,
    applicantTypeCount: 0,
    capabilityCount: 0,
    facilityCount: 0,
    hasSector: false,
    confirmedContractorMappings: 0,
    priorAssistanceListingCount: 0,
    priorAgencyCount: 0,
    programElementCount: 0,
    ...partial,
  };
}

describe('missingProfileFields', () => {
  test('SAM gaps lead with contractor identity when UEI is already on file', () => {
    const fields = missingProfileFields(complete({ hasUei: true }), 'sam_gov');
    expect(fields[0]?.field).toBe('contractorIdentity');
    expect(fields[0]?.label).toMatch(/UEI on file/i);
    expect(fields[0]?.impact).toMatch(/mapping/i);
    expect(fields.map((f) => f.field)).toContain('naicsCodes');
    expect(fields.map((f) => f.field)).toContain('pscCodes');
    // Grants-only applicantTypes must not pollute a SAM-scoped gap list.
    expect(fields.map((f) => f.field)).not.toContain('applicantTypes');
  });

  test('grants gaps require applicant types and never mention PSC', () => {
    const fields = missingProfileFields(complete(), 'grants_gov');
    expect(fields.map((f) => f.field)).toContain('applicantTypes');
    expect(fields.map((f) => f.field)).not.toContain('pscCodes');
    expect(fields.map((f) => f.field)).not.toContain('naicsCodes');
  });

  test('applicant-type impact tells operators not to dump the full enum', () => {
    const field = missingProfileFields(complete(), 'grants_gov').find((f) => f.field === 'applicantTypes');
    expect(field?.impact).toMatch(/not the full Grants\.gov enum/i);
  });
});

describe('profileIsTooThin', () => {
  test('codes alone are enough', () => {
    expect(profileIsTooThin(complete({ naicsCount: 1 }))).toBe(false);
  });

  test('empty everything is thin', () => {
    expect(profileIsTooThin(complete())).toBe(true);
  });
});
