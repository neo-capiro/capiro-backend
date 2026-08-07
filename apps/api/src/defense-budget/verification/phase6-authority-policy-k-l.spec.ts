import { lookupPolicyForManifestDocument } from './authority-policy-resolution.js';

describe('Phase 6 K/L authority policy overrides', () => {
  it('requires conference only for appropriations conference', () => {
    const policy = lookupPolicyForManifestDocument({
      family: 'committee', exhibit: 'conference_report', authority: 'appropriations_conference', documentType: 'conference_report', documentKey: 'conf',
    });
    expect(policy?.requiredFundingFields).toEqual(['conference']);
    expect(policy?.requiredComparisonRules).toEqual(['appropriations_conference_chamber_reference']);
    expect(policy?.arithmeticRules).toEqual([]);
  });

  it('requires enacted only for public law and no request ownership', () => {
    const policy = lookupPolicyForManifestDocument({
      family: 'public_law', exhibit: 'public_law', authority: 'public_law', documentType: 'public_law', documentKey: 'pl',
    });
    expect(policy?.requiredFundingFields).toEqual(['enacted']);
    expect(policy?.requiredFundingFields).not.toContain('request');
    expect(policy?.requiredComparisonRules).toEqual([]);
    expect(policy?.arithmeticRules).toEqual([]);
  });
});
