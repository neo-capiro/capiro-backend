/**
 * Tests for Workstream E-H rules.
 *
 * These tests verify the core rule infrastructure, check builders, and
 * the behavior of representative rules from each workstream.
 */
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
  RDTE_SUMMARY_DETAIL_RULE,
  PROJECT_ROLLUP_RULE,
  PROCUREMENT_ROLLUP_RULE,
  COMMITTEE_ADJUSTMENT_RULE,
  ALL_VERIFICATION_RULES,
} from './index.js';

describe('rule infrastructure', () => {
  it('exports all 16 verification rules', () => {
    expect(ALL_VERIFICATION_RULES).toHaveLength(16);
  });

  it('each rule has a unique code', () => {
    const codes = ALL_VERIFICATION_RULES.map((r) => r.code);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });

  it('each rule has a non-empty version', () => {
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

describe('rule codes match plan', () => {
  it('Workstream E: contract_integrity', () => {
    expect(CONTRACT_INTEGRITY_RULE.code).toBe('contract_integrity');
  });

  it('Workstream E: manifest_binding', () => {
    expect(MANIFEST_BINDING_RULE.code).toBe('manifest_binding');
  });

  it('Workstream E: completeness', () => {
    expect(COMPLETENESS_RULE.code).toBe('completeness');
  });

  it('Workstream F: evidence_binding', () => {
    expect(EVIDENCE_BINDING_RULE.code).toBe('evidence_binding');
  });

  it('Workstream F: money_evidence_policy', () => {
    expect(MONEY_EVIDENCE_RULE.code).toBe('money_evidence_policy');
  });

  it('Workstream F: warning_policy', () => {
    expect(WARNING_POLICY_RULE.code).toBe('warning_policy');
  });

  it('Workstream G: identity_validation', () => {
    expect(IDENTITY_RULE.code).toBe('identity_validation');
  });

  it('Workstream G: funding_field_ownership', () => {
    expect(FUNDING_FIELD_OWNERSHIP_RULE.code).toBe('funding_field_ownership');
  });

  it('Workstream G: numeric_validation', () => {
    expect(NUMERIC_RULE.code).toBe('numeric_validation');
  });

  it('Workstream G: duplicate_detection', () => {
    expect(DUPLICATE_RULE.code).toBe('duplicate_detection');
  });

  it('Workstream H: rdte_summary_detail', () => {
    expect(RDTE_SUMMARY_DETAIL_RULE.code).toBe('rdte_summary_detail');
  });

  it('Workstream H: project_rollup', () => {
    expect(PROJECT_ROLLUP_RULE.code).toBe('project_rollup');
  });

  it('Workstream H: procurement_rollup', () => {
    expect(PROCUREMENT_ROLLUP_RULE.code).toBe('procurement_rollup');
  });

  it('Workstream H: committee_adjustment', () => {
    expect(COMMITTEE_ADJUSTMENT_RULE.code).toBe('committee_adjustment');
  });
});
