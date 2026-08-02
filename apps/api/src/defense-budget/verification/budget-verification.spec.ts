import {
  applyReviewDecision,
  assertPromotionReady,
  buildVerificationRun,
  getCanonicalPromotionRecords,
  verifyBudgetDocument,
  type ArchiveProof,
  type BudgetCell,
  type BudgetDocument,
  type BudgetEvidence,
  type BudgetRow,
  type ParseProof,
} from './budget-verification.js';

const SHA = 'a'.repeat(64);

function evidence(page = 1, overrides: Partial<BudgetEvidence> = {}): BudgetEvidence {
  return {
    sourceDocumentId: 'doc-fy27-rdte',
    sourceSha256: SHA,
    page,
    boundingBox: { left: 10, top: 20, right: 200, bottom: 40 },
    extractionMethod: 'llamaparse',
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
  it('normalizes an exact-SHA LlamaParse candidate and auto-verifies a clean PE request', () => {
    const result = verifyBudgetDocument(validDocument(), { approvedSha256: SHA });

    expect(result.status).toBe('VERIFIED_AUTOMATIC');
    expect(result.route).toBe('automatic');
    expect(result.canonicalEligible).toBe(true);
    expect(result.promotionReady).toBe(true);
    expect(result.normalizedRecords).toEqual([
      expect.objectContaining({
        peCode: '0602308A',
        fy: 2027,
        field: 'request',
        valueMillions: 1.25,
        sourceSha256: SHA,
        sourcePage: 2,
      }),
    ]);
    expect(result.checks.every((check) => check.evidence.length > 0)).toBe(true);
    expect(
      result.checks.every((check) =>
        check.evidence.every((item) => item.sourceSha256 === SHA && item.page >= 1),
      ),
    ).toBe(true);
  });

  it('never makes a clean candidate promotion-ready without the separate exact-SHA approval', () => {
    const result = verifyBudgetDocument(validDocument());

    expect(result.status).toBe('VERIFIED_AUTOMATIC');
    expect(result.canonicalEligible).toBe(true);
    expect(result.promotionReady).toBe(false);
  });

  it('rejects malformed source identity and evidence before normalization', () => {
    const result = verifyBudgetDocument(
      validDocument({
        sourceSha256: 'NOT-A-SHA',
        evidence: evidence(1, { sourceSha256: 'different' }),
      }),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.route).toBe('none');
    expect(result.canonicalEligible).toBe(false);
    expect(result.normalizedRecords).toEqual([]);
    expect(result.blockingFailures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining(['source_sha256', 'source_evidence', 'archive_proof', 'parse_proof']),
    );
  });

  it('rejects candidates without immutable archive or exact-SHA parse proof', () => {
    const result = verifyBudgetDocument(
      validDocument({
        archiveProof: archiveProof({ versionId: '' }),
        parseProof: parseProof({ inputSha256: 'b'.repeat(64) }),
      }),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.blockingFailures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining(['archive_proof', 'parse_proof']),
    );
  });

  it('rejects a field placed on the wrong budget-authority track', () => {
    const result = verifyBudgetDocument(
      validDocument({
        sourceAuthority: 'hasc_authorization',
        columns: [
          {
            key: 'fy2027-request',
            fiscalYear: 2027,
            field: 'request',
            label: 'FY 2027 Request',
            unit: 'thousands',
            evidence: evidence(),
          },
        ],
      }),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.blockingFailures.map((failure) => failure.code)).toContain('field_ownership');
  });

  it('rejects duplicate natural-key cells rather than choosing a winner', () => {
    const result = verifyBudgetDocument(
      validDocument({
        rows: [row(), row({ id: 'row-2', cells: [cell({ id: 'cell-2', rawValue: 1251 })] })],
      }),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.blockingFailures.map((failure) => failure.code)).toContain('duplicate_cells');
  });

  it('rejects an explicit total that does not reconcile to its children', () => {
    const result = verifyBudgetDocument(
      validDocument({
        rows: [
          row({ id: 'child-1', cells: [cell({ id: 'child-cell-1', rawValue: 500 })] }),
          row({
            id: 'child-2',
            code: '0602308B',
            cells: [cell({ id: 'child-cell-2', code: '0602308B', rawValue: 300 })],
          }),
          row({
            id: 'total-1',
            kind: 'total',
            code: 'TOTAL',
            totalOfRowIds: ['child-1', 'child-2'],
            cells: [cell({ id: 'total-cell', code: 'TOTAL', rawValue: 900 })],
          }),
        ],
      }),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.blockingFailures.map((failure) => failure.code)).toContain(
      'arithmetic_reconciliation',
    );
  });

  it('routes a non-blocking cross-document discrepancy to targeted re-extraction', () => {
    const result = verifyBudgetDocument(
      validDocument({
        comparisons: [
          {
            id: 'r2-request',
            kind: 'cross_document',
            candidate: { code: '0602308A', fiscalYear: 2027, field: 'request' },
            referenceValueMillions: 2,
            toleranceMillions: 0.01,
            evidence: evidence(4),
            description: 'Independent source comparison',
          },
        ],
      }),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.route).toBe('targeted_local_reextraction');
    expect(result.canonicalEligible).toBe(false);
    expect(
      result.checks.find((check) => check.code === 'cross_document_reconciliation')?.passed,
    ).toBe(false);
  });

  it('requires exact candidate evidence when applying a human review', () => {
    const result = verifyBudgetDocument(
      validDocument({
        comparisons: [
          {
            id: 'history-request',
            kind: 'historical',
            candidate: { code: '0602308A', fiscalYear: 2027, field: 'request' },
            referenceValueMillions: 2,
            toleranceMillions: 0.01,
            evidence: evidence(4),
            description: 'Historical control',
          },
        ],
      }),
    );
    const reviewed = applyReviewDecision(
      result,
      {
        reviewerId: 'neo',
        accepted: true,
        notes: 'Reviewed against the official page.',
        evidence: [evidence(2)],
      },
      SHA,
    );

    expect(reviewed.status).toBe('VERIFIED_REVIEWED');
    expect(reviewed.canonicalEligible).toBe(true);
    expect(reviewed.promotionReady).toBe(true);
  });

  it('builds an audit-shaped verification run without mutating the candidate', () => {
    const result = verifyBudgetDocument(validDocument());
    const run = buildVerificationRun(result, {
      runId: 'run-1',
      candidateId: 'candidate-1',
      startedAt: '2026-08-02T00:00:00.000Z',
      completedAt: '2026-08-02T00:00:01.000Z',
    });

    expect(run).toEqual(
      expect.objectContaining({
        runId: 'run-1',
        candidateId: 'candidate-1',
        status: 'VERIFIED_AUTOMATIC',
        route: 'automatic',
      }),
    );
    expect(run.checks).toBe(result.checks);
  });

  it('exposes no promotion records until the exact-SHA gate is satisfied', () => {
    const blocked = verifyBudgetDocument(validDocument());
    const ready = verifyBudgetDocument(validDocument(), { approvedSha256: SHA });

    expect(getCanonicalPromotionRecords(blocked)).toEqual([]);
    expect(getCanonicalPromotionRecords(ready)).toHaveLength(1);
  });

  it('fails closed when a future writer asks to promote an unapproved result', () => {
    expect(() => assertPromotionReady(verifyBudgetDocument(validDocument()))).toThrow(
      'Canonical promotion is blocked',
    );
    expect(() =>
      assertPromotionReady(verifyBudgetDocument(validDocument(), { approvedSha256: SHA })),
    ).not.toThrow();
  });
});

export {};
