import {
  applyReviewDecision,
  buildVerificationRun,
  verifyBudgetDocument,
  type ArchiveProof,
  type BudgetCell,
  type BudgetDocument,
  type BudgetEvidence,
  type BudgetRow,
  type ExtractionDiagnostics,
  type ParseProof,
} from './budget-verification.js';

const SHA = 'a'.repeat(64);

function evidence(page = 1, overrides: Partial<BudgetEvidence> = {}): BudgetEvidence {
  return {
    sourceDocumentId: 'doc-fy27-rdte',
    sourceSha256: SHA,
    page,
    granularity: 'page_only',
    extractionMethod: 'llamaparse',
    ...overrides,
  };
}

function diagnostics(overrides: Partial<ExtractionDiagnostics> = {}): ExtractionDiagnostics {
  return {
    sourceYearValueCount: 1,
    sourceMoneyAssertionCount: 1,
    acceptedMoneyAssertionCount: 1,
    droppedMoneyAssertions: [],
    parserWarnings: [],
    ...overrides,
  };
}

function archiveProof(overrides: Partial<ArchiveProof> = {}): ArchiveProof {
  return {
    bucket: 'capiro-defense-budget-raw-dev-967807252336',
    key: 'incoming/fy2027/RDTE_fixture.pdf',
    versionId: 'version-1',
    sha256: SHA,
    ...overrides,
  };
}

function parseProof(overrides: Partial<ParseProof> = {}): ParseProof {
  return {
    id: 'parse-job-1',
    provider: 'llamaparse',
    status: 'succeeded',
    inputSha256: SHA,
    outputJsonKey: 'derived/document/parsed.pages-all.json',
    ...overrides,
  };
}

function cell(overrides: Partial<BudgetCell> = {}): BudgetCell {
  return {
    id: 'cell-1',
    columnKey: 'fy2027-request',
    lineKind: 'RDTE_PE',
    code: '0602308A',
    fiscalYear: 2027,
    field: 'request',
    rawValue: 1250,
    unit: 'thousands',
    evidence: evidence(2),
    ...overrides,
  };
}

function row(overrides: Partial<BudgetRow> = {}): BudgetRow {
  return {
    id: 'row-1',
    kind: 'line',
    lineKind: 'RDTE_PE',
    code: '0602308A',
    title: 'Advanced Technology',
    groupKey: 'activity-1',
    evidence: evidence(2),
    cells: [cell()],
    ...overrides,
  };
}

function validDocument(overrides: Partial<BudgetDocument> = {}): BudgetDocument {
  return {
    sourceDocumentId: 'doc-fy27-rdte',
    sourceSha256: SHA,
    archiveProof: archiveProof(),
    parseProof: parseProof(),
    documentId: 'rdte-fixture',
    fiscalYear: 2027,
    sourceAuthority: 'presidents_budget_request',
    sourceLineKind: 'RDTE_PE',
    evidence: evidence(),
    extractionDiagnostics: diagnostics(),
    columns: [
      {
        key: 'fy2027-request',
        fiscalYear: 2027,
        field: 'request',
        label: 'FY 2027 Discretionary Request',
        unit: 'thousands',
        evidence: evidence(1),
      },
    ],
    rows: [row()],
    ...overrides,
  };
}

describe('verifyBudgetDocument', () => {
  it('structurally validates a clean candidate and normalizes money to USD millions', () => {
    const result = verifyBudgetDocument(validDocument());

    expect(result.status).toBe('STRUCTURALLY_VALIDATED');
    expect(result.route).toBe('automatic');
    expect(result.normalizedRecords).toEqual([
      expect.objectContaining({
        peCode: '0602308A',
        fy: 2027,
        field: 'request',
        valueMillions: 1.25,
        sourceSha256: SHA,
        sourcePage: 2,
        granularity: 'page_only',
      }),
    ]);
    expect(result.normalizedRecords[0]?.boundingBox).toBeUndefined();
  });

  it('exposes no promotion or canonical properties', () => {
    const result = verifyBudgetDocument(validDocument());
    expect(result).not.toHaveProperty('canonicalEligible');
    expect(result).not.toHaveProperty('promotionReady');
  });

  it('rejects an empty document with no candidate rows', () => {
    const result = verifyBudgetDocument(
      validDocument({
        rows: [],
        columns: [],
        extractionDiagnostics: diagnostics({
          sourceYearValueCount: 0,
          sourceMoneyAssertionCount: 0,
          acceptedMoneyAssertionCount: 0,
        }),
      }),
    );
    expect(result.status).toBe('REJECTED');
    expect(result.blockingFailures.map((c) => c.code)).toContain('candidate_presence');
    expect(result.normalizedRecords).toEqual([]);
  });

  it('rejects a document with line assertions but no money cells', () => {
    const emptyRow = row({ cells: [] });
    const result = verifyBudgetDocument(
      validDocument({
        rows: [emptyRow],
        extractionDiagnostics: diagnostics({
          sourceYearValueCount: 1,
          sourceMoneyAssertionCount: 0,
          acceptedMoneyAssertionCount: 0,
        }),
      }),
    );
    expect(result.status).toBe('REJECTED');
    expect(result.normalizedRecords).toEqual([]);
  });

  it('rejects when money assertions were dropped by the adapter', () => {
    const result = verifyBudgetDocument(
      validDocument({
        extractionDiagnostics: diagnostics({
          sourceMoneyAssertionCount: 2,
          acceptedMoneyAssertionCount: 1,
          droppedMoneyAssertions: [
            {
              index: 3,
              code: '0602308A',
              fiscalYear: 2027,
              fieldName: 'request',
              reason: 'non_finite_value',
            },
          ],
        }),
      }),
    );
    expect(result.status).toBe('REJECTED');
    const completeness = result.checks.find((c) => c.code === 'extraction_completeness');
    expect(completeness?.passed).toBe(false);
    expect(completeness?.blocking).toBe(true);
    expect(completeness?.details).toEqual(
      expect.objectContaining({
        countByReason: { non_finite_value: 1 },
        indices: [3],
        codes: ['0602308A'],
        fiscalYears: [2027],
        fieldNames: ['request'],
      }),
    );
    expect(result.normalizedRecords).toEqual([]);
  });

  it('returns NEEDS_REVIEW and no structural validation when the parser warned', () => {
    const result = verifyBudgetDocument(
      validDocument({
        extractionDiagnostics: diagnostics({
          parserWarnings: ['row 14 had ambiguous unit header'],
        }),
      }),
    );
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.riskScore).toBeGreaterThan(10);
    const warning = result.checks.find((c) => c.code === 'parser_warnings');
    expect(warning?.passed).toBe(false);
    expect(warning?.details?.warnings).toEqual(['row 14 had ambiguous unit header']);
  });

  it('rejects a malformed source SHA', () => {
    const result = verifyBudgetDocument(validDocument({ sourceSha256: 'not-a-sha' }));
    expect(result.status).toBe('REJECTED');
    expect(result.blockingFailures.map((c) => c.code)).toContain('source_sha256');
  });

  it('rejects mismatched archive and parse proofs', () => {
    const result = verifyBudgetDocument(
      validDocument({
        archiveProof: archiveProof({ sha256: 'b'.repeat(64) }),
        parseProof: parseProof({ inputSha256: 'b'.repeat(64) }),
      }),
    );
    expect(result.status).toBe('REJECTED');
    expect(result.blockingFailures.map((c) => c.code)).toEqual(
      expect.arrayContaining(['archive_proof', 'parse_proof']),
    );
  });

  it('rejects evidence with an invalid page instead of coercing to page 1', () => {
    const result = verifyBudgetDocument(
      validDocument({ rows: [row({ cells: [cell({ evidence: evidence(0) })] })] }),
    );
    expect(result.status).toBe('REJECTED');
    expect(result.blockingFailures.map((c) => c.code)).toContain('source_evidence');
  });

  it('rejects page_only evidence carrying a fabricated bounding box', () => {
    const result = verifyBudgetDocument(
      validDocument({
        rows: [
          row({
            cells: [
              cell({
                evidence: evidence(2, {
                  boundingBox: { left: 0, top: 0, right: 1, bottom: 1 },
                }),
              }),
            ],
          }),
        ],
      }),
    );
    expect(result.status).toBe('REJECTED');
    expect(result.blockingFailures.map((c) => c.code)).toContain('source_evidence');
  });

  it('rejects cell_bbox evidence with zero-area or inverted geometry', () => {
    const result = verifyBudgetDocument(
      validDocument({
        rows: [
          row({
            cells: [
              cell({
                evidence: evidence(2, {
                  granularity: 'cell_bbox',
                  boundingBox: { left: 10, top: 10, right: 10, bottom: 5 },
                }),
              }),
            ],
          }),
        ],
      }),
    );
    expect(result.status).toBe('REJECTED');
    expect(result.blockingFailures.map((c) => c.code)).toContain('source_evidence');
  });

  it('accepts truthful deterministic_pdfplumber provenance without relabeling', () => {
    const result = verifyBudgetDocument(
      validDocument({
        rows: [
          row({
            cells: [
              cell({ evidence: evidence(2, { extractionMethod: 'deterministic_pdfplumber' }) }),
            ],
          }),
        ],
      }),
    );
    expect(result.status).toBe('STRUCTURALLY_VALIDATED');
    expect(result.normalizedRecords[0]?.evidence.extractionMethod).toBe('deterministic_pdfplumber');
  });

  it('rejects duplicate natural-key cells', () => {
    const dupRow = row({ cells: [cell(), cell({ id: 'cell-2' })] });
    const result = verifyBudgetDocument(validDocument({ rows: [dupRow] }));
    expect(result.status).toBe('REJECTED');
    expect(result.blockingFailures.map((c) => c.code)).toContain('duplicate_cells');
  });

  it('rejects field ownership off the document authority track', () => {
    const result = verifyBudgetDocument(
      validDocument({
        rows: [row({ cells: [cell({ field: 'enacted' })] })],
        columns: [
          {
            key: 'fy2027-request',
            fiscalYear: 2027,
            field: 'request',
            label: 'Request',
            unit: 'thousands',
            evidence: evidence(1),
          },
        ],
      }),
    );
    expect(result.status).toBe('REJECTED');
    expect(result.blockingFailures.map((c) => c.code)).toContain('field_ownership');
  });

  it('marks missing cross-document and historical controls as skipped, not passed', () => {
    const result = verifyBudgetDocument(validDocument());
    for (const code of ['cross_document_reconciliation', 'historical_consistency'] as const) {
      const control = result.checks.find((c) => c.code === code);
      expect(control?.skipped).toBe(true);
      expect(control?.passed).toBe(false);
      expect(control?.message.startsWith('NOT RUN:')).toBe(true);
      expect(control?.details).toEqual(expect.objectContaining({ comparisonCount: 0 }));
    }
    // Skipped controls contribute no risk and do not block structural validation.
    expect(result.status).toBe('STRUCTURALLY_VALIDATED');
    expect(result.riskScore).toBe(0);
  });

  it('passes supplied matching comparisons and routes mismatches to review', () => {
    const matching = verifyBudgetDocument(
      validDocument({
        comparisons: [
          {
            id: 'cmp-1',
            kind: 'cross_document',
            candidate: { code: '0602308A', fiscalYear: 2027, field: 'request' },
            referenceValueMillions: 1.25,
            toleranceMillions: 0.01,
            evidence: evidence(3),
            description: 'independent R-1 total',
          },
        ],
      }),
    );
    expect(matching.checks.find((c) => c.code === 'cross_document_reconciliation')?.passed).toBe(
      true,
    );

    const mismatch = verifyBudgetDocument(
      validDocument({
        comparisons: [
          {
            id: 'cmp-2',
            kind: 'historical',
            candidate: { code: '0602308A', fiscalYear: 2027, field: 'request' },
            referenceValueMillions: 9.99,
            toleranceMillions: 0.01,
            evidence: evidence(3),
            description: 'prior-year control',
          },
        ],
      }),
    );
    expect(mismatch.checks.find((c) => c.code === 'historical_consistency')?.passed).toBe(false);
    expect(mismatch.status).toBe('NEEDS_REVIEW');
  });

  it('builds a run record from a result', () => {
    const run = buildVerificationRun(verifyBudgetDocument(validDocument()), {
      runId: 'run-1',
      candidateId: 'cand-1',
      startedAt: '2026-08-02T00:00:00.000Z',
      completedAt: '2026-08-02T00:00:01.000Z',
    });
    expect(run.status).toBe('STRUCTURALLY_VALIDATED');
    expect(run.candidateId).toBe('cand-1');
  });
});

describe('applyReviewDecision', () => {
  function needsReview(): ReturnType<typeof verifyBudgetDocument> {
    return verifyBudgetDocument(
      validDocument({
        extractionDiagnostics: diagnostics({ parserWarnings: ['review me'] }),
      }),
    );
  }

  it('requires NEEDS_REVIEW status', () => {
    expect(() =>
      applyReviewDecision(verifyBudgetDocument(validDocument()), {
        reviewerId: 'neo',
        accepted: true,
        notes: 'ok',
        evidence: [evidence()],
      }),
    ).toThrow('NEEDS_REVIEW');
  });

  it('accepted review returns REVIEW_ACCEPTED with no canonical properties', () => {
    const reviewed = applyReviewDecision(needsReview(), {
      reviewerId: 'neo',
      accepted: true,
      notes: 'structure looks right',
      evidence: [evidence()],
    });
    expect(reviewed.status).toBe('REVIEW_ACCEPTED');
    expect(reviewed).not.toHaveProperty('canonicalEligible');
    expect(reviewed).not.toHaveProperty('promotionReady');
  });

  it('rejected review returns REJECTED', () => {
    const reviewed = applyReviewDecision(needsReview(), {
      reviewerId: 'neo',
      accepted: false,
      notes: 'not trustworthy',
      evidence: [evidence()],
    });
    expect(reviewed.status).toBe('REJECTED');
  });

  it('rejects review evidence pointing at a different document', () => {
    expect(() =>
      applyReviewDecision(needsReview(), {
        reviewerId: 'neo',
        accepted: true,
        notes: 'wrong doc',
        evidence: [evidence(1, { sourceDocumentId: 'other-doc' })],
      }),
    ).toThrow('exact candidate document');
  });
});
