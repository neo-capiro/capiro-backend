import type { BudgetCycleManifestDocumentV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type {
  BudgetAuthorityV1,
  BudgetFamilyV1,
  ExhibitV1,
  FundingFieldV1,
} from '../contracts/extraction-artifact-v1.js';
import { computePolicySha256 } from './verification-policy-v1.js';
import {
  AmbiguousVerificationPolicyError,
  lookupPolicyForManifestDocument,
} from './authority-policy-resolution.js';

type PolicyDocument = Pick<
  BudgetCycleManifestDocumentV1,
  'family' | 'exhibit' | 'authority' | 'documentType' | 'documentKey'
>;

function document(
  authority: BudgetAuthorityV1,
  overrides: Partial<PolicyDocument> = {},
): PolicyDocument {
  return {
    documentKey: `${authority}_fy2027`,
    family: 'committee',
    exhibit: 'committee_report',
    authority,
    documentType: 'committee_report',
    ...overrides,
  };
}

const COMMITTEE_CASES = [
  ['hasc', 'hascMark'],
  ['sasc', 'sascMark'],
  ['hac_d', 'hacDMark'],
  ['sac_d', 'sacDMark'],
] as const satisfies readonly (readonly [BudgetAuthorityV1, FundingFieldV1])[];

const UNSUPPORTED_CASES = [
  ['om', 'O-1'],
  ['milcon', 'C-1'],
] as const satisfies readonly (readonly [BudgetFamilyV1, ExhibitV1])[];

describe('R8.3 authority-aware verification policy resolution', () => {
  it.each(COMMITTEE_CASES)(
    'selects %s policy without another chamber field',
    (authority, expectedField) => {
      const policy = lookupPolicyForManifestDocument(document(authority));
      expect(policy).not.toBeNull();
      expect(policy!.requiredFundingFields).toContain('request');
      expect(policy!.requiredFundingFields).toContain(expectedField);
      const otherFields: FundingFieldV1[] = ['hascMark', 'sascMark', 'hacDMark', 'sacDMark'].filter(
        (field): field is FundingFieldV1 => field !== expectedField,
      );
      for (const field of otherFields) {
        expect(policy!.requiredFundingFields).not.toContain(field);
      }
    },
  );

  it('produces different policy SHAs for HASC and SASC', () => {
    const hasc = lookupPolicyForManifestDocument(document('hasc'))!;
    const sasc = lookupPolicyForManifestDocument(document('sasc'))!;
    expect(computePolicySha256(hasc)).not.toBe(computePolicySha256(sasc));
  });

  it('selects the two conference policies by authority', () => {
    const ndaa = lookupPolicyForManifestDocument(
      document('ndaa_conference', { exhibit: 'conference_report' }),
    )!;
    const appropriations = lookupPolicyForManifestDocument(
      document('appropriations_conference', { exhibit: 'conference_report' }),
    )!;
    expect(ndaa.requiredFundingFields).toContain('ndaaConference');
    expect(ndaa.requiredFundingFields).not.toContain('conference');
    expect(appropriations.requiredFundingFields).toContain('conference');
    expect(appropriations.requiredFundingFields).not.toContain('ndaaConference');
  });

  it('fails closed when an ambiguous committee authority has no explicit key', () => {
    expect(() => lookupPolicyForManifestDocument(document('dod-comptroller'))).toThrow(
      AmbiguousVerificationPolicyError,
    );
  });

  it.each(UNSUPPORTED_CASES)(
    'routes unsupported %s/%s to the explicit unsupported result',
    (family, exhibit) => {
      const policy = lookupPolicyForManifestDocument({
        documentKey: `${family}_fy2027`,
        family,
        exhibit,
        authority: 'dod-comptroller',
        documentType: exhibit.toLowerCase(),
      });
      expect(policy).toBeNull();
    },
  );
});
