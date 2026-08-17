/** Tests for the trusted verification rule registry, including Phase 6 rules. */
import { describe, it, expect } from '@jest/globals';
import {
  passCheck,
  failCheck,
  notRunCheck,
  skippedCheck,
  makeDiscrepancy,
  CONTRACT_INTEGRITY_RULE,
  MANIFEST_BINDING_RULE,
  COMPLETENESS_RULE,
  EVIDENCE_BINDING_RULE,
  MONEY_EVIDENCE_RULE,
  WARNING_POLICY_RULE,
  IDENTITY_RULE,
  FUNDING_FIELD_OWNERSHIP_RULE,
  NUMERIC_RULE,
  DUPLICATE_RULE,
  ENACTMENT_PROOF_RULE,
  APPROPRIATIONS_CONFERENCE_VEHICLE_RULE,
  RDTE_SUMMARY_DETAIL_RULE,
  PROJECT_ROLLUP_RULE,
  PROCUREMENT_ROLLUP_RULE,
  COMMITTEE_ADJUSTMENT_RULE,
  NDAA_CONFERENCE_ARITHMETIC_RULE,
  ALL_VERIFICATION_RULES,
  ALL_EXECUTABLE_RULES,
} from './index.js';

describe('rule infrastructure', () => {
  it('exports every required core and Phase 6 verification rule by stable code', () => {
    const codes = new Set(ALL_EXECUTABLE_RULES.map((rule) => rule.code));
    for (const required of [
      'contract_integrity',
      'manifest_binding',
      'completeness',
      'evidence_binding',
      'money_evidence_policy',
      'warning_policy',
      'identity_validation',
      'funding_field_ownership',
      'numeric_validation',
      'duplicate_detection',
      'committee_adjustment',
      'ndaa_conference_arithmetic',
      'ndaa_conference_chamber_reference',
      'appropriations_conference_vehicle_proof',
      'appropriations_conference_chamber_reference',
      'enactment_proof',
    ]) {
      expect(codes.has(required)).toBe(true);
    }
  });

  it('each executable rule has a unique code', () => {
    const codes = ALL_EXECUTABLE_RULES.map((rule) => rule.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('each core rule has a non-empty version', () => {
    for (const rule of ALL_VERIFICATION_RULES) {
      expect(rule.version).toBeTruthy();
      expect(rule.code).toBeTruthy();
      expect(rule.name).toBeTruthy();
    }
  });
});

describe('check builders', () => {
  const dummyRule = {
    code: 'test_rule',
    name: 'Test Rule',
    version: 'v1',
    required: true,
    blocking: true,
    riskPoints: 10,
    execute: () => ({ check: null, discrepancies: [] }),
  } as const;

  it('passCheck produces PASS outcome', () => {
    const check = passCheck(dummyRule, 'run1', ['a1'], ['e1'], [], 'ok');
    expect(check.outcome).toBe('PASS');
    expect(check.riskPoints).toBe(0);
    expect(check.assertionIds).toEqual(['a1']);
  });

  it('failCheck produces FAIL outcome with risk points', () => {
    const check = failCheck(dummyRule, 'run1', ['a1'], [], [], 'fail');
    expect(check.outcome).toBe('FAIL');
    expect(check.riskPoints).toBe(10);
  });

  it('notRunCheck produces NOT_RUN outcome', () => {
    const check = notRunCheck(dummyRule, 'run1', [], [], [], 'cannot run');
    expect(check.outcome).toBe('NOT_RUN');
  });

  it('skippedCheck produces SKIPPED outcome', () => {
    const check = skippedCheck(dummyRule, 'run1', 'not applicable');
    expect(check.outcome).toBe('SKIPPED');
    expect(check.assertionIds).toEqual([]);
  });

  it('makeDiscrepancy produces a discrepancy with deterministic ID', () => {
    const d1 = makeDiscrepancy('test_code', 'blocking', 'desc', ['a1'], ['e1'], []);
    const d2 = makeDiscrepancy('test_code', 'blocking', 'desc', ['a1'], ['e1'], []);
    expect(d1.discrepancyId).toBe(d2.discrepancyId);
    expect(d1.severity).toBe('blocking');
  });
});

describe('rule codes match contracts', () => {
  it('keeps legacy/core codes stable', () => {
    expect(CONTRACT_INTEGRITY_RULE.code).toBe('contract_integrity');
    expect(MANIFEST_BINDING_RULE.code).toBe('manifest_binding');
    expect(COMPLETENESS_RULE.code).toBe('completeness');
    expect(EVIDENCE_BINDING_RULE.code).toBe('evidence_binding');
    expect(MONEY_EVIDENCE_RULE.code).toBe('money_evidence_policy');
    expect(WARNING_POLICY_RULE.code).toBe('warning_policy');
    expect(IDENTITY_RULE.code).toBe('identity_validation');
    expect(FUNDING_FIELD_OWNERSHIP_RULE.code).toBe('funding_field_ownership');
    expect(NUMERIC_RULE.code).toBe('numeric_validation');
    expect(DUPLICATE_RULE.code).toBe('duplicate_detection');
    expect(RDTE_SUMMARY_DETAIL_RULE.code).toBe('rdte_summary_detail');
    expect(PROJECT_ROLLUP_RULE.code).toBe('project_rollup');
    expect(PROCUREMENT_ROLLUP_RULE.code).toBe('procurement_rollup');
    expect(COMMITTEE_ADJUSTMENT_RULE.code).toBe('committee_adjustment');
    expect(NDAA_CONFERENCE_ARITHMETIC_RULE.code).toBe('ndaa_conference_arithmetic');
    expect(APPROPRIATIONS_CONFERENCE_VEHICLE_RULE.code).toBe(
      'appropriations_conference_vehicle_proof',
    );
    expect(ENACTMENT_PROOF_RULE.code).toBe('enactment_proof');
  });
});
