import { assertionIdV1, evidenceIdV1, factIdV1, omissionIdV1 } from './artifact-builders.js';
import {
  assertDefenseBudgetExtractionArtifactV1,
  computeArtifactContentSha256,
  computeArtifactSummary,
  validateDefenseBudgetExtractionArtifactV1,
} from './extraction-artifact-v1.semantic.js';
import type { DefenseBudgetExtractionArtifactV1 } from './extraction-artifact-v1.js';
import { buildMinimalArtifact } from './testing-helpers.js';

function errorCodes(artifact: DefenseBudgetExtractionArtifactV1): string[] {
  return validateDefenseBudgetExtractionArtifactV1(artifact)
    .filter((finding) => finding.severity === 'error')
    .map((finding) => finding.code);
}

describe('validateDefenseBudgetExtractionArtifactV1', () => {
  it('accepts a complete minimal artifact', () => {
    const artifact = buildMinimalArtifact();
    expect(validateDefenseBudgetExtractionArtifactV1(artifact)).toEqual([]);
    expect(() => assertDefenseBudgetExtractionArtifactV1(artifact)).not.toThrow();
    expect(() =>
      assertDefenseBudgetExtractionArtifactV1(artifact, { requireComplete: true }),
    ).not.toThrow();
  });

  it('rejects duplicate IDs', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      evidence: [...artifact.evidence, artifact.evidence[0]!],
    };
    expect(errorCodes(tampered)).toContain('duplicate_evidence_id');
  });

  it('rejects unknown parser-run references', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      evidence: [{ ...artifact.evidence[0]!, parserRunId: 'prun_missing' }],
    };
    expect(errorCodes(tampered)).toContain('unknown_parser_run_reference');
  });

  it('rejects unknown evidence references', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      sourceFacts: [{ ...artifact.sourceFacts[0]!, evidenceIds: ['ev_missing'] }],
    };
    expect(errorCodes(tampered)).toContain('unknown_evidence_reference');
  });

  it('rejects unknown source-fact references', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      assertions: [{ ...artifact.assertions[0]!, sourceFactIds: ['fact_missing'] }],
    };
    expect(errorCodes(tampered)).toContain('unknown_source_fact_reference');
  });

  it('rejects source/evidence SHA mismatch', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      evidence: [{ ...artifact.evidence[0]!, sourcePdfSha256: 'd'.repeat(64) }],
    };
    expect(errorCodes(tampered)).toContain('evidence_source_sha_mismatch');
  });

  it('rejects parser-run input SHA mismatch', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      parserRuns: [{ ...artifact.parserRuns[0]!, inputSourceSha256: 'e'.repeat(64) }],
    };
    expect(errorCodes(tampered)).toContain('parser_run_input_sha_mismatch');
  });

  it('rejects content-hash tampering', () => {
    const artifact = buildMinimalArtifact();
    const identityAssertion = artifact.assertions[0]!;
    if (identityAssertion.assertionKind !== 'program_element_identity') {
      throw new Error('expected program_element_identity assertion');
    }
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      assertions: [{ ...identityAssertion, title: 'Tampered Title' }],
    };
    expect(errorCodes(tampered)).toContain('content_sha_mismatch');
  });

  it('rejects artifact-ID tampering', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      artifactId: 'dbx1_forged',
    };
    expect(errorCodes(tampered)).toContain('artifact_id_mismatch');
  });

  it('rejects summary tampering', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      summary: { ...artifact.summary, assertionCount: 99 },
    };
    expect(errorCodes(tampered)).toContain('summary_mismatch');
  });

  it('rejects uncovered required facts', () => {
    const artifact = buildMinimalArtifact();
    const orphanFactId = factIdV1({
      sourcePath: 'rows[1].money',
      category: 'money',
      rawValue: '5',
    });
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      sourceFacts: [
        ...artifact.sourceFacts,
        {
          factId: orphanFactId,
          sourcePath: 'rows[1].money',
          category: 'money',
          requiredForCompleteness: true,
          rawValue: '5',
          evidenceIds: [artifact.evidence[0]!.evidenceId],
        },
      ],
    };
    expect(errorCodes(tampered)).toContain('uncovered_required_source_fact');
  });

  it('rejects facts that are both asserted and omitted', () => {
    const artifact = buildMinimalArtifact();
    const factId = artifact.sourceFacts[0]!.factId;
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      omissions: [
        {
          omissionId: omissionIdV1({ sourceFactId: factId, reason: 'other' }),
          sourceFactId: factId,
          reason: 'other',
          severity: 'review',
          message: 'double coverage',
        },
      ],
    };
    expect(errorCodes(tampered)).toContain('fact_asserted_and_omitted');
  });

  it('accepts a fact covered by exactly one omission (complete_with_omissions)', () => {
    const artifact = buildMinimalArtifact();
    const moneyFactId = factIdV1({ sourcePath: 'rows[1].money', category: 'money', rawValue: '5' });
    const built: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      sourceFacts: [
        ...artifact.sourceFacts,
        {
          factId: moneyFactId,
          sourcePath: 'rows[1].money',
          category: 'money',
          requiredForCompleteness: true,
          rawValue: '5',
          evidenceIds: [artifact.evidence[0]!.evidenceId],
        },
      ],
      omissions: [
        {
          omissionId: omissionIdV1({ sourceFactId: moneyFactId, reason: 'unsupported_unit' }),
          sourceFactId: moneyFactId,
          reason: 'unsupported_unit',
          severity: 'blocking',
          message: 'unit unknown',
        },
      ],
    };
    // Recompute summary + hash through the shared semantic helpers.
    const summary = computeArtifactSummary(built);
    const withSummary = { ...built, summary };
    const contentSha256 = computeArtifactContentSha256(withSummary);
    const final: DefenseBudgetExtractionArtifactV1 = {
      ...withSummary,
      contentSha256,
      artifactId: `dbx1_${contentSha256}`,
    };
    expect(validateDefenseBudgetExtractionArtifactV1(final)).toEqual([]);
    expect(final.summary.completenessStatus).toBe('complete_with_omissions');
    expect(() => assertDefenseBudgetExtractionArtifactV1(final, { requireComplete: true })).toThrow(
      /completeness_required/,
    );
  });

  it('rejects document_only evidence with a page', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      evidence: [{ ...artifact.evidence[0]!, granularity: 'document_only' }],
    };
    expect(errorCodes(tampered)).toContain('evidence_granularity_violation');
  });

  it('rejects page_only evidence without a page', () => {
    const artifact = buildMinimalArtifact();
    const { page: _page, ...noPage } = artifact.evidence[0]!;
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      evidence: [noPage],
    };
    expect(errorCodes(tampered)).toContain('evidence_granularity_violation');
  });

  it('rejects page_only evidence with a bounding box', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      evidence: [
        {
          ...artifact.evidence[0]!,
          boundingBox: { x0: 0, y0: 0, x1: 10, y1: 10, coordinateSystem: 'pdf_points' },
        },
      ],
    };
    expect(errorCodes(tampered)).toContain('evidence_granularity_violation');
  });

  it('rejects cell_bbox without a box', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      evidence: [{ ...artifact.evidence[0]!, granularity: 'cell_bbox' }],
    };
    expect(errorCodes(tampered)).toContain('evidence_granularity_violation');
  });

  it('rejects zero-area and inverted boxes', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      evidence: [
        {
          ...artifact.evidence[0]!,
          granularity: 'cell_bbox',
          boundingBox: { x0: 10, y0: 10, x1: 10, y1: 5, coordinateSystem: 'pdf_points' },
        },
      ],
    };
    expect(errorCodes(tampered)).toContain('bounding_box_non_positive_area');
  });

  it('rejects normalized boxes outside 0..1', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      evidence: [
        {
          ...artifact.evidence[0]!,
          granularity: 'cell_bbox',
          boundingBox: { x0: 0, y0: 0, x1: 1.5, y1: 0.5, coordinateSystem: 'normalized_0_1' },
        },
      ],
    };
    expect(errorCodes(tampered)).toContain('bounding_box_out_of_range');
  });

  it('rejects evidence pages outside the parser page range', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      evidence: [{ ...artifact.evidence[0]!, page: 42 }],
    };
    expect(errorCodes(tampered)).toContain('evidence_page_outside_parser_range');
  });

  it('rejects overlapping parser page ranges', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      parserRuns: [
        {
          ...artifact.parserRuns[0]!,
          pageRanges: [
            { startPage: 1, endPage: 5 },
            { startPage: 4, endPage: 9 },
          ],
        },
      ],
    };
    expect(errorCodes(tampered)).toContain('parser_page_range_overlap');
  });

  it('rejects money scaling mismatches', () => {
    const artifact = buildMinimalArtifact();
    const moneyFactId = factIdV1({
      sourcePath: 'rows[0].money',
      category: 'money',
      rawValue: '1250',
    });
    const fundingAssertion = {
      assertionId: assertionIdV1({ kind: 'funding', pe: '0602308A', fy: 2099 }),
      assertionKind: 'funding' as const,
      identity: { lineKind: 'RDTE_PE' as const, peCode: '0602308A' },
      fiscalYear: 2099,
      field: 'request' as const,
      money: { originalValue: '1250', originalUnit: 'thousands' as const, valueMillions: '9.99' },
      sourceFactIds: [moneyFactId],
      evidenceIds: [artifact.evidence[0]!.evidenceId],
      confidence: 1,
    };
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      sourceFacts: [
        ...artifact.sourceFacts,
        {
          factId: moneyFactId,
          sourcePath: 'rows[0].money',
          category: 'money',
          requiredForCompleteness: false,
          rawValue: '1250',
          evidenceIds: [artifact.evidence[0]!.evidenceId],
        },
      ],
      assertions: [...artifact.assertions, fundingAssertion],
    };
    expect(errorCodes(tampered)).toContain('money_scaling_mismatch');
  });

  it('rejects identical relationship endpoints', () => {
    const artifact = buildMinimalArtifact();
    const relFactId = factIdV1({
      sourcePath: 'rows[0].refs',
      category: 'relationship',
      rawValue: null,
    });
    const relationship = {
      assertionId: assertionIdV1({ kind: 'relationship', n: 1 }),
      assertionKind: 'relationship' as const,
      from: { lineKind: 'RDTE_PE' as const, peCode: '0602308A' },
      to: { lineKind: 'RDTE_PE' as const, peCode: '0602308A' },
      relationshipType: 'references' as const,
      explicitInSource: true,
      sourceFactIds: [relFactId],
      evidenceIds: [artifact.evidence[0]!.evidenceId],
      confidence: 1,
    };
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      sourceFacts: [
        ...artifact.sourceFacts,
        {
          factId: relFactId,
          sourcePath: 'rows[0].refs',
          category: 'relationship',
          requiredForCompleteness: false,
          evidenceIds: [artifact.evidence[0]!.evidenceId],
        },
      ],
      assertions: [...artifact.assertions, relationship],
    };
    expect(errorCodes(tampered)).toContain('relationship_endpoints_identical');
  });

  it('rejects invalid milestone dates', () => {
    const artifact = buildMinimalArtifact();
    const milestoneFactId = factIdV1({
      sourcePath: 'rows[0].milestone',
      category: 'milestone',
      rawValue: null,
    });
    const milestone = {
      assertionId: assertionIdV1({ kind: 'milestone', n: 1 }),
      assertionKind: 'milestone' as const,
      parentPeCode: '0602308A',
      milestoneType: 'IOC',
      plannedDate: 'next Tuesday',
      sourceFactIds: [milestoneFactId],
      evidenceIds: [artifact.evidence[0]!.evidenceId],
      confidence: 1,
    };
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      sourceFacts: [
        ...artifact.sourceFacts,
        {
          factId: milestoneFactId,
          sourcePath: 'rows[0].milestone',
          category: 'milestone',
          requiredForCompleteness: false,
          evidenceIds: [artifact.evidence[0]!.evidenceId],
        },
      ],
      assertions: [...artifact.assertions, milestone],
    };
    expect(errorCodes(tampered)).toContain('invalid_date_format');
  });

  it('warns when project funding lacks a project assertion', () => {
    const artifact = buildMinimalArtifact();
    const pfFactId = factIdV1({ sourcePath: 'rows[0].pf', category: 'money', rawValue: '2' });
    const projectFunding = {
      assertionId: assertionIdV1({ kind: 'project_funding', n: 1 }),
      assertionKind: 'project_funding' as const,
      parentPeCode: '0602308A',
      projectCode: 'ZN9',
      fiscalYear: 2099,
      field: 'request' as const,
      money: { originalValue: '2', originalUnit: 'millions' as const, valueMillions: '2' },
      sourceFactIds: [pfFactId],
      evidenceIds: [artifact.evidence[0]!.evidenceId],
      confidence: 1,
    };
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      sourceFacts: [
        ...artifact.sourceFacts,
        {
          factId: pfFactId,
          sourcePath: 'rows[0].pf',
          category: 'money',
          requiredForCompleteness: false,
          rawValue: '2',
          evidenceIds: [artifact.evidence[0]!.evidenceId],
        },
      ],
      assertions: [...artifact.assertions, projectFunding],
    };
    const findings = validateDefenseBudgetExtractionArtifactV1(tampered);
    expect(findings.map((f) => f.code)).toContain('project_funding_without_project_assertion');
    expect(
      findings.find((f) => f.code === 'project_funding_without_project_assertion')?.severity,
    ).toBe('warning');
  });

  it('rejects a money fact consumed by two value assertions without a duplicate warning', () => {
    const artifact = buildMinimalArtifact();
    const moneyFactId = factIdV1({
      sourcePath: 'rows[0].money',
      category: 'money',
      rawValue: '1250',
    });
    const evidenceId = artifact.evidence[0]!.evidenceId;
    const mkFunding = (n: number) => ({
      assertionId: assertionIdV1({ kind: 'funding', n }),
      assertionKind: 'funding' as const,
      identity: { lineKind: 'RDTE_PE' as const, peCode: '0602308A' },
      fiscalYear: 2099,
      field: 'request' as const,
      money: { originalValue: '1250', originalUnit: 'thousands' as const, valueMillions: '1.25' },
      sourceFactIds: [moneyFactId],
      evidenceIds: [evidenceId],
      confidence: 1,
    });
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      sourceFacts: [
        ...artifact.sourceFacts,
        {
          factId: moneyFactId,
          sourcePath: 'rows[0].money',
          category: 'money',
          requiredForCompleteness: false,
          rawValue: '1250',
          evidenceIds: [evidenceId],
        },
      ],
      assertions: [...artifact.assertions, mkFunding(1), mkFunding(2)],
    };
    expect(errorCodes(tampered)).toContain('fact_consumed_by_multiple_value_assertions');
  });
});

describe('deterministic IDs', () => {
  it('evidenceIdV1/factIdV1 are stable for identical tuples', () => {
    expect(evidenceIdV1({ a: 1 })).toBe(evidenceIdV1({ a: 1 }));
    expect(factIdV1({ a: 1 })).toBe(factIdV1({ a: 1 }));
    expect(evidenceIdV1({ a: 1 })).not.toBe(evidenceIdV1({ a: 2 }));
    expect(evidenceIdV1({ a: 1 })).toMatch(/^ev_[a-f0-9]{64}$/);
    expect(factIdV1({ a: 1 })).toMatch(/^fact_[a-f0-9]{64}$/);
    expect(assertionIdV1({ a: 1 })).toMatch(/^asrt_[a-f0-9]{64}$/);
    expect(omissionIdV1({ a: 1 })).toMatch(/^omit_[a-f0-9]{64}$/);
  });
});
