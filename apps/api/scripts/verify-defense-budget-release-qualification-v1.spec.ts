import { describe, expect, test } from '@jest/globals';
import {
  BA4A_R3_REPAIR_RELEASE_GATE_POLICY,
  DEFAULT_RELEASE_GATE_POLICY,
  decimalStringsEqual,
  evaluateReleaseGate,
  parseReportInput,
  releaseGatePolicyForProfile,
  type ReleaseGatePolicy,
} from './verify-defense-budget-release-qualification-v1.js';
import type { QualificationReport } from './qualify-defense-budget-drain-image-v1.js';

function reportFixture(overrides: Partial<QualificationReport> = {}): QualificationReport {
  return {
    runId: 'run1',
    decision: 'REVIEW',
    finalState: 'TERMINAL_REVIEW',
    targetPeCode: '0601102A',
    fiscalYear: 2024,
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
    targetR3PeCode: null,
    targetR3Performers: [],
    r3DuplicateNaturalKeyConflictCount: 0,
    ...overrides,
  };
}

function ba4aReport(overrides: Partial<QualificationReport> = {}): QualificationReport {
  const identityPeCodes = [
    '0603305A',
    '0603308A',
    '0603327A',
    '0603619A',
    '0603639A',
    '0603645A',
    '0603747A',
    '0603766A',
    '0603774A',
    '0603779A',
    '0603790A',
    '0603801A',
    '0603804A',
    '0603807A',
    '0603827A',
    '0604017A',
    '0604019A',
    '0604020A',
    '0604035A',
  ];
  return reportFixture({
    targetPeCode: '0604017A',
    fiscalYear: 2024,
    targetPeFiscalYearTotalMillions: '3.024',
    identityCount: identityPeCodes.length,
    identityPeCodes,
    targetR3PeCode: '0604020A',
    targetR3Performers: [
      {
        performerName: 'Various : Various',
        performerNormalized: 'VARIOUS : VARIOUS',
        costCategory: 'Olympus: Program Management and Capability Transition',
        contractMethod: 'TBD',
        fiscalYear: 2024,
        totalCostMillions: '6.178',
        naturalKey: '0604020A|olympus|VARIOUS : VARIOUS|TBD|2024',
        physicalPage: 399,
      },
      {
        performerName: 'Various : Various.',
        performerNormalized: 'VARIOUS : VARIOUS',
        costCategory: 'SBIR & STTR Adjustment',
        contractMethod: 'TBD',
        fiscalYear: 2024,
        totalCostMillions: '2.811',
        naturalKey: '0604020A|sbir|VARIOUS : VARIOUS|TBD|2024',
        physicalPage: 399,
      },
    ],
    r3DuplicateNaturalKeyConflictCount: 0,
    ...overrides,
  });
}

describe('decimalStringsEqual', () => {
  test('treats different trailing-zero formatting of the same amount as equal', () => {
    expect(decimalStringsEqual('296.670', '296.67')).toBe(true);
    expect(decimalStringsEqual('10.708', '10.7080')).toBe(true);
  });

  test('treats a genuinely different amount as unequal', () => {
    expect(decimalStringsEqual('296.67', '296.68')).toBe(false);
    expect(decimalStringsEqual('5.459', '54.59')).toBe(false);
    expect(decimalStringsEqual('3.024', '3.0244')).toBe(false);
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

  test('passes the exact reviewed BA4A R-3 repair profile', () => {
    const verdict = evaluateReleaseGate(ba4aReport(), BA4A_R3_REPAIR_RELEASE_GATE_POLICY);
    expect(verdict.pass).toBe(true);
    expect(verdict.findings).toEqual([]);
  });

  test('BA4A blocks when any duplicate natural-key conflict remains', () => {
    const verdict = evaluateReleaseGate(
      ba4aReport({ r3DuplicateNaturalKeyConflictCount: 1 }),
      BA4A_R3_REPAIR_RELEASE_GATE_POLICY,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'r3_duplicate_natural_key_conflict_count_mismatch' }),
      ]),
    );
  });

  test('BA4A blocks when a reviewed page-399 row changes or disappears', () => {
    const rows = ba4aReport().targetR3Performers;
    const verdict = evaluateReleaseGate(
      ba4aReport({
        targetR3Performers: [
          rows[0]!,
          { ...rows[1]!, totalCostMillions: '2.8114' },
        ],
      }),
      BA4A_R3_REPAIR_RELEASE_GATE_POLICY,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'r3_performer_missing' })]),
    );
  });

  test('BA4A blocks when the reviewed rows collapse to one natural key', () => {
    const rows = ba4aReport().targetR3Performers;
    const verdict = evaluateReleaseGate(
      ba4aReport({
        targetR3Performers: [rows[0]!, { ...rows[1]!, naturalKey: rows[0]!.naturalKey }],
      }),
      BA4A_R3_REPAIR_RELEASE_GATE_POLICY,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'r3_natural_keys_not_distinct' })]),
    );
  });

  test('BA4A blocks on an incomplete identity set', () => {
    const verdict = evaluateReleaseGate(
      ba4aReport({ identityCount: 18, identityPeCodes: ba4aReport().identityPeCodes.slice(1) }),
      BA4A_R3_REPAIR_RELEASE_GATE_POLICY,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'identity_set_mismatch' })]),
    );
  });

  test('selects the BA4A profile explicitly and rejects unknown names', () => {
    expect(releaseGatePolicyForProfile('ba4a-r3-repair')).toBe(
      BA4A_R3_REPAIR_RELEASE_GATE_POLICY,
    );
    expect(() => releaseGatePolicyForProfile('unknown')).toThrow(/unknown release-gate profile/);
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
