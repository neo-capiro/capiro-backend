/**
 * Tests for verification-policy-v1 and verification-policy-registry (Workstream D).
 *
 * Tests:
 * - manifest may strengthen but not weaken defaults
 * - policy SHA deterministic
 * - unsupported family policy honest
 * - R-1/R-2/R-2A/R-3/congressional/P-doc policy selection
 * - high-materiality threshold exact decimal
 */
import { describe, it, expect } from '@jest/globals';
import {
  verificationPolicyV1Schema,
  computePolicySha256,
  mergeManifestWithPolicy,
  checkManifestDoesNotWeakenPolicy,
  type VerificationPolicyV1,
} from './verification-policy-v1.js';
import {
  lookupPolicyByExhibit,
  lookupPolicy,
  isPolicySupported,
  getAllPolicies,
  getSupportedPolicies,
} from './verification-policy-registry.js';
import { DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION } from './verification-contract-v1.js';

const R1_POLICY = lookupPolicyByExhibit('R-1')!;

describe('verification-policy-registry — policy selection', () => {
  it('returns R-1 policy for R-1 exhibit', () => {
    expect(R1_POLICY).toBeDefined();
    expect(R1_POLICY.exhibit).toBe('R-1');
    expect(R1_POLICY.family).toBe('rdte');
  });

  it('returns R-2 policy', () => {
    expect(lookupPolicyByExhibit('R-2')?.exhibit).toBe('R-2');
  });

  it('returns R-2A policy', () => {
    expect(lookupPolicyByExhibit('R-2A')?.exhibit).toBe('R-2A');
  });

  it('returns R-3 policy', () => {
    expect(lookupPolicyByExhibit('R-3')?.exhibit).toBe('R-3');
  });

  it('returns P-1 (P-doc) policy', () => {
    expect(lookupPolicyByExhibit('P-1')?.family).toBe('procurement');
  });

  it('returns committee report policies', () => {
    expect(lookupPolicy('committee', 'committee_report')?.family).toBe('committee');
  });

  it('returns public_law policy', () => {
    expect(lookupPolicy('public_law', 'public_law')?.family).toBe('public_law');
  });

  it('returns null for unknown exhibit', () => {
    expect(lookupPolicyByExhibit('unknown')).toBeNull();
  });
});

describe('verification-policy-registry — support honesty', () => {
  it('R-1, R-2, R-2A, R-3 are supported', () => {
    expect(isPolicySupported('rdte', 'R-1')).toBe(true);
    expect(isPolicySupported('rdte', 'R-2')).toBe(true);
    expect(isPolicySupported('rdte', 'R-2A')).toBe(true);
    expect(isPolicySupported('rdte', 'R-3')).toBe(true);
  });

  it('O-1 (O&M) is NOT supported', () => {
    expect(isPolicySupported('om', 'O-1')).toBe(false);
    const policy = lookupPolicyByExhibit('O-1');
    expect(policy).toBeDefined();
    expect(policy!.requiredDataCategories).toEqual([]);
    expect(policy!.requiredFundingFields).toEqual([]);
    expect(policy!.allowedParserMethods).toEqual([]);
    expect(policy!.minimumMoneyEvidenceGranularity).toBe('cell_bbox');
    expect(policy!.pageOnlyMayPassWithIndependentReconciliation).toBe(false);
  });

  it('C-1 (MILCON) is NOT supported', () => {
    expect(isPolicySupported('milcon', 'C-1')).toBe(false);
    const policy = lookupPolicyByExhibit('C-1');
    expect(policy).toBeDefined();
    expect(policy!.requiredDataCategories).toEqual([]);
  });

  it('getSupportedPolicies excludes O&M and MILCON', () => {
    const supported = getSupportedPolicies();
    expect(supported.every((e) => e.supported)).toBe(true);
    expect(supported.some((e) => e.policy.family === 'om')).toBe(false);
    expect(supported.some((e) => e.policy.family === 'milcon')).toBe(false);
  });

  it('getAllPolicies includes unsupported', () => {
    const all = getAllPolicies();
    expect(all.length).toBeGreaterThan(supportedCount());
  });

  function supportedCount(): number {
    return getSupportedPolicies().length;
  }
});

describe('verificationPolicyV1Schema — validation', () => {
  it('accepts a valid R-1 policy', () => {
    expect(verificationPolicyV1Schema.parse(R1_POLICY)).toEqual(R1_POLICY);
  });

  it('rejects unknown fields', () => {
    const bad = { ...R1_POLICY, extraField: true };
    expect(() => verificationPolicyV1Schema.parse(bad)).toThrow();
  });

  it('rejects invalid highMaterialityThresholdMillions', () => {
    const bad = { ...R1_POLICY, highMaterialityThresholdMillions: '1,000' };
    expect(() => verificationPolicyV1Schema.parse(bad)).toThrow();
  });

  it('rejects out-of-order risk thresholds', () => {
    const bad = {
      ...R1_POLICY,
      riskThresholds: { automaticPassMax: 50, targetedReextractionMax: 30, paidVerifierMax: 60 },
    };
    expect(() => verificationPolicyV1Schema.parse(bad)).toThrow();
  });

  it('highMaterialityThresholdMillions is exact decimal string', () => {
    expect(R1_POLICY.highMaterialityThresholdMillions).toBe('1000');
    // Verify it's a canonical decimal string (no commas, no exponential)
    expect(/^\d+$/.test(R1_POLICY.highMaterialityThresholdMillions)).toBe(true);
  });

  it('policy version is exact', () => {
    expect(R1_POLICY.policyVersion).toBe(DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION);
  });
});

describe('computePolicySha256 — deterministic', () => {
  it('produces the same SHA for the same policy', () => {
    const sha1 = computePolicySha256(R1_POLICY);
    const sha2 = computePolicySha256(R1_POLICY);
    expect(sha1).toBe(sha2);
    expect(sha1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces different SHAs for different policies', () => {
    const r1Sha = computePolicySha256(lookupPolicyByExhibit('R-1')!);
    const r2Sha = computePolicySha256(lookupPolicyByExhibit('R-2')!);
    expect(r1Sha).not.toBe(r2Sha);
  });
});

describe('mergeManifestWithPolicy — manifest strengthens not weakens', () => {
  it('manifest can add categories', () => {
    const merged = mergeManifestWithPolicy(R1_POLICY, {
      requiredDataCategories: ['milestones'],
    });
    expect(merged.requiredDataCategories).toContain('milestones');
    // Original categories preserved
    expect(merged.requiredDataCategories).toContain('identity');
    expect(merged.requiredDataCategories).toContain('funding');
  });

  it('manifest can add funding fields', () => {
    const merged = mergeManifestWithPolicy(R1_POLICY, {
      requiredFundingFields: ['enacted'],
    });
    expect(merged.requiredFundingFields).toContain('request');
    expect(merged.requiredFundingFields).toContain('enacted');
  });

  it('manifest additions are union (not replacement)', () => {
    const merged = mergeManifestWithPolicy(R1_POLICY, {
      requiredDataCategories: ['identity'],
    });
    // 'identity' was already in policy, should not duplicate
    const identityCount = merged.requiredDataCategories.filter((c) => c === 'identity').length;
    expect(identityCount).toBe(1);
  });
});

describe('checkManifestDoesNotWeakenPolicy', () => {
  it('returns no findings when manifest includes all policy requirements', () => {
    const findings = checkManifestDoesNotWeakenPolicy(R1_POLICY, {
      requiredDataCategories: R1_POLICY.requiredDataCategories,
      requiredFundingFields: R1_POLICY.requiredFundingFields,
      requiredLineKinds: R1_POLICY.requiredLineKinds,
    });
    expect(findings).toEqual([]);
  });

  it('returns findings when manifest removes a required category', () => {
    const findings = checkManifestDoesNotWeakenPolicy(R1_POLICY, {
      requiredDataCategories: ['identity'], // missing 'funding', etc.
    });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.code === 'manifest_weakened_category')).toBe(true);
  });

  it('returns findings when manifest removes a required funding field', () => {
    const findings = checkManifestDoesNotWeakenPolicy(R1_POLICY, {
      requiredFundingFields: [], // missing 'request'
    });
    expect(findings.some((f) => f.code === 'manifest_weakened_field')).toBe(true);
  });

  it('returns findings when manifest removes required line kinds', () => {
    const findings = checkManifestDoesNotWeakenPolicy(R1_POLICY, {
      requiredLineKinds: [],
    });
    expect(findings.some((f) => f.code === 'manifest_weakened_kind')).toBe(true);
  });

  it('returns no findings when manifest requirements are absent (undefined)', () => {
    const findings = checkManifestDoesNotWeakenPolicy(R1_POLICY, {});
    expect(findings).toEqual([]);
  });
});
