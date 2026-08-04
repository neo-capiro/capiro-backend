import { computePolicySha256 } from './verification-policy-v1.js';
import {
  AmbiguousVerificationPolicyError,
  lookupPolicyForManifestDocument,
} from './authority-policy-resolution.js';

function document(authority: string) {
  return {
    documentKey: `${authority}_fy2027`,
    family: 'committee',
    exhibit: 'committee_report',
    authority,
    documentType: 'committee_report',
  } as never;
}

describe('R8.3 authority-aware verification policy resolution', () => {
  it.each([
    ['hasc', 'hascMark'],
    ['sasc', 'sascMark'],
    ['hac_d', 'hacDMark'],
    ['sac_d', 'sacDMark'],
  ])('selects %s policy without another chamber field', (authority, expectedField) => {
    const policy = lookupPolicyForManifestDocument(document(authority));
    expect(policy).not.toBeNull();
    expect(policy!.requiredFundingFields).toContain('request');
    expect(policy!.requiredFundingFields).toContain(expectedField);
    const otherFields = ['hascMark', 'sascMark', 'hacDMark', 'sacDMark'].filter(
      (field) => field !== expectedField,
    );
    for (const field of otherFields) {
      expect(policy!.requiredFundingFields).not.toContain(field);
    }
  });

  it('produces different policy SHAs for HASC and SASC', () => {
    const hasc = lookupPolicyForManifestDocument(document('hasc'))!;
    const sasc = lookupPolicyForManifestDocument(document('sasc'))!;
    expect(computePolicySha256(hasc)).not.toBe(computePolicySha256(sasc));
  });

  it('selects the two conference policies by authority', () => {
    const ndaa = lookupPolicyForManifestDocument({
      ...document('ndaa_conference'),
      exhibit: 'conference_report',
    } as never)!;
    const appropriations = lookupPolicyForManifestDocument({
      ...document('appropriations_conference'),
      exhibit: 'conference_report',
    } as never)!;
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

  it.each([
    ['om', 'O-1'],
    ['milcon', 'C-1'],
  ])('routes unsupported %s/%s to the explicit unsupported result', (family, exhibit) => {
    const policy = lookupPolicyForManifestDocument({
      documentKey: `${family}_fy2027`,
      family,
      exhibit,
      authority: 'dod-comptroller',
      documentType: exhibit.toLowerCase(),
    } as never);
    expect(policy).toBeNull();
  });
});
