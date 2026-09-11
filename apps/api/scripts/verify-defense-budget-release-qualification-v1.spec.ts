import { describe, expect, test } from '@jest/globals';
import {
  DEFAULT_RELEASE_GATE_POLICY,
  decimalStringsEqual,
  evaluateReleaseGate,
  parseReportInput,
  type ReleaseGatePolicy,
} from './verify-defense-budget-release-qualification-v1.js';
import type { QualificationReport } from './qualify-defense-budget-drain-image-v1.js';

function reportFixture(overrides: Partial<QualificationReport> = {}): QualificationReport {
  return {
    runId: 'run1',
    decision: 'REVIEW',
    finalState: 'TERMINAL_REVIEW',
    totalAssertions: 522,
    assertionsByKind: { document_fact: 517, program_element_identity: 5 },
    identityCount: 5,
    identityPeCodes: ['0601102A', '0601103A', '0601104A', '0601121A', '0601601A'],
    omissions: 27,
    omissionsByKind: { missing_evidence: 27 },
    targetPeFiscalYearTotalMillions: '296.67',
    allTargetPeFiscalYearTotalsMillions: {
      '0601102A': '296.67',
      '0601103A': '75.672',
      '0601104A': '108.946',
      '0601121A': '5.459',
      '0601601A': '10.708',
    },
    artifactSha256: 'a'.repeat(64),
    normalizedArtifactSha256: 'b'.repeat(64),
    manifestCycleId: 'fy2024:cff02efd-45e7-4ae4-8f7f-dacd12bdb84c',
    dbCandidateId: 'candidate-1',
    dbRunDecision: 'REVIEW',
    dbverifyOk: true,
    ...overrides,
  };
}

describe('decimalStringsEqual', () => {
  test('treats different trailing-zero formatting of the same amount as equal', () => {
    expect(decimalStringsEqual('296.670', '296.67')).toBe(true);
    expect(decimalStringsEqual('10.708', '10.7080')).toBe(true);
  });

  test('treats a genuinely different amount as unequal', () => {
    expect(decimalStringsEqual('296.67', '296.68')).toBe(false);
    expect(decimalStringsEqual('5.459', '54.59')).toBe(false);
  });

  test('falls back to exact string comparison for non-numeric input rather than silently passing', () => {
    expect(decimalStringsEqual('not-a-number', 'not-a-number')).toBe(true);
    expect(decimalStringsEqual('not-a-number', 'also-not')).toBe(false);
  });
});

describe('evaluateReleaseGate', () => {
  test('passes a report that matches the reviewed profile exactly', () => {
    const verdict = evaluateReleaseGate(reportFixture());
    expect(verdict.token).toBe('RELEASE_IMAGE_QUALIFICATION_PASS');
    expect(verdict.pass).toBe(true);
    expect(verdict.findings).toEqual([]);
  });

  test('passes when a PE total differs only by trailing-zero formatting', () => {
    const verdict = evaluateReleaseGate(
      reportFixture({
        allTargetPeFiscalYearTotalsMillions: {
          '0601102A': '296.670',
          '0601103A': '75.672',
          '0601104A': '108.946',
          '0601121A': '5.459',
          '0601601A': '10.708',
        },
      }),
    );
    expect(verdict.pass).toBe(true);
  });

  test('blocks on an unexpected decision', () => {
    const verdict = evaluateReleaseGate(reportFixture({ decision: 'REJECT', dbRunDecision: 'REJECT' }));
    expect(verdict.token).toBe('RELEASE_IMAGE_QUALIFICATION_BLOCKED');
    expect(verdict.pass).toBe(false);
    expect(verdict.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'unexpected_decision' })]),
    );
  });

  test('blocks when dbverify did not persist a run', () => {
    const verdict = evaluateReleaseGate(reportFixture({ dbverifyOk: false, dbRunDecision: null }));
    expect(verdict.pass).toBe(false);
    expect(verdict.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'dbverify_not_ok' })]),
    );
  });

  test('blocks when the artifact decision and the persisted DB run decision disagree', () => {
    const verdict = evaluateReleaseGate(reportFixture({ dbRunDecision: 'REJECT' }));
    expect(verdict.pass).toBe(false);
    expect(verdict.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'artifact_db_decision_mismatch' })]),
    );
  });

  test('blocks when a required PE total is missing from the report entirely (e.g. a REJECT run that never reached that page)', () => {
    const verdict = evaluateReleaseGate(
      reportFixture({
        allTargetPeFiscalYearTotalsMillions: {
          '0601102A': '296.67',
          '0601103A': null,
          '0601104A': null,
          '0601121A': null,
          '0601601A': null,
        },
        identityPeCodes: ['0601102A'],
      }),
    );
    expect(verdict.pass).toBe(false);
    const missingCodes = verdict.findings.filter((f) => f.code === 'pe_total_missing');
    expect(missingCodes).toHaveLength(4);
  });

  test('blocks when a PE total is present but numerically wrong', () => {
    const verdict = evaluateReleaseGate(
      reportFixture({
        allTargetPeFiscalYearTotalsMillions: {
          '0601102A': '1.00',
          '0601103A': '75.672',
          '0601104A': '108.946',
          '0601121A': '5.459',
          '0601601A': '10.708',
        },
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'pe_total_mismatch', message: expect.stringContaining('0601102A') })]),
    );
  });

  test('blocks when a PE has a total but no identity assertion', () => {
    const verdict = evaluateReleaseGate(
      reportFixture({ identityPeCodes: ['0601103A', '0601104A', '0601121A', '0601601A'] }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'pe_identity_missing', message: expect.stringContaining('0601102A') })]),
    );
  });

  test('a custom policy can expect a different decision (e.g. a future fixture/policy)', () => {
    const policy: ReleaseGatePolicy = { expectedDecision: 'PASS', expectedPeTotalsMillions: {} };
    const verdict = evaluateReleaseGate(reportFixture({ decision: 'PASS', dbRunDecision: 'PASS' }), policy);
    expect(verdict.pass).toBe(true);
  });

  test('DEFAULT_RELEASE_GATE_POLICY expects REVIEW and all five known real PE totals', () => {
    expect(DEFAULT_RELEASE_GATE_POLICY.expectedDecision).toBe('REVIEW');
    expect(Object.keys(DEFAULT_RELEASE_GATE_POLICY.expectedPeTotalsMillions).sort()).toEqual([
      '0601102A',
      '0601103A',
      '0601104A',
      '0601121A',
      '0601601A',
    ]);
  });
});

describe('parseReportInput', () => {
  test('parses a bare JSON object', () => {
    const report = reportFixture();
    expect(parseReportInput(JSON.stringify(report))).toEqual(report);
  });

  test('parses a CloudWatch-style "QUALIFICATION_REPORT { ... }" log line', () => {
    const report = reportFixture();
    const line = `QUALIFICATION_REPORT ${JSON.stringify(report, null, 2)}`;
    expect(parseReportInput(line)).toEqual(report);
  });

  test('throws on unparseable input rather than silently returning something wrong', () => {
    expect(() => parseReportInput('not json at all')).toThrow();
  });
});
