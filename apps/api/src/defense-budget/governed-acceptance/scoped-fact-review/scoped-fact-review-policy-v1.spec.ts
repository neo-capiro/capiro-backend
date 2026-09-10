/**
 * scoped-fact-review-policy-v1.spec -- Phase 10B-35.
 *
 * Builds a minimal synthetic extraction artifact (not the real production
 * artifact -- see scoped-fact-review-real-artifact.spec.ts for that) so each
 * rule can be tested in isolation: identity/hash gates, scope resolution,
 * independence analysis (direct finding, same-row finding, different-row
 * finding), and the wrong-identity-binding defence.
 */
import { describe, expect, it } from '@jest/globals';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import { computeArtifactContentSha256 } from '../../contracts/extraction-artifact-v1.semantic.js';
import type {
  ReadCandidateV1,
  ReadCheckV1,
  ReadDiscrepancyV1,
  ReadProofSnapshotV1,
  ReadRunV1,
} from '../../verification/persistence/verification-repository.js';
import {
  SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
  evaluateScopedFactReviewEligibilityV1,
  scopedFactReviewScopeKeyV1,
  type ScopedFactReviewScopeV1,
} from './scoped-fact-review-policy-v1.js';

const SOURCE_SHA = '1'.repeat(64);
const RUN_ID = 'run-1';
const CANDIDATE_ID = 'cand-1';
const ARTIFACT_ID = 'dbx1_placeholder';

function baseArtifact(overrides: Partial<DefenseBudgetExtractionArtifactV1> = {}): DefenseBudgetExtractionArtifactV1 {
  const draft: DefenseBudgetExtractionArtifactV1 = {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: ARTIFACT_ID,
    contentSha256: '',
    source: {
      manifestDocumentKey: CANDIDATE_ID,
      sourceDocumentId: 'sd-1',
      sourcePdfSha256: SOURCE_SHA,
      sourceLocator: 'https://example.mil/r2.pdf',
      sourceUrl: 'https://example.mil/r2.pdf',
      fiscalYear: 2024,
      family: 'rdte',
      exhibit: 'R-2',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb',
      documentType: 'r2',
      title: 'r2',
    } as unknown as DefenseBudgetExtractionArtifactV1['source'],
    parserRuns: [],
    evidence: [
      { evidenceId: 'ev-identity', sourcePdfSha256: SOURCE_SHA, parserRunId: 'pr1', granularity: 'page_only', page: 43, tableLabel: 'table_0', rowLabel: 'row_0' } as never,
      { evidenceId: 'ev-total', sourcePdfSha256: SOURCE_SHA, parserRunId: 'pr1', granularity: 'page_only', page: 43, tableLabel: 'table_0', rowLabel: 'row_3' } as never,
    ],
    sourceFacts: [],
    assertions: [
      {
        assertionId: 'asrt-identity',
        sourceFactIds: [],
        evidenceIds: ['ev-identity'],
        confidence: 1,
        metadata: { exhibit: 'R-2', contextSource: 'explicit_header', segmentId: 'seg_0001', physicalPage: 43 },
        assertionKind: 'program_element_identity',
        identity: { lineKind: 'RDTE_PE', peCode: '0601102A' },
        title: 'Defense Research Sciences',
        component: 'ARMY',
      } as never,
      {
        assertionId: 'asrt-total',
        sourceFactIds: [],
        evidenceIds: ['ev-total'],
        confidence: 1,
        assertionKind: 'document_fact',
        fieldName: 'r2_total_component',
        value: {
          peCode: '0601102A',
          projectCode: null,
          rowKind: 'pe_total',
          fiscalYear: 2024,
          columnRole: 'total_component',
          disposition: 'contextual_only',
          originalValue: '296.670',
          originalUnit: 'millions',
          valueMillions: '296.67',
          positionCycle: 'pb_fy2024',
          headerText: 'FY 2024 Total',
          direct: true,
        },
      } as never,
    ],
    warnings: [],
    omissions: [],
    summary: {} as never,
  };
  const merged = { ...draft, ...overrides };
  merged.contentSha256 = computeArtifactContentSha256(merged);
  return merged;
}

function candidateFor(artifact: DefenseBudgetExtractionArtifactV1, overrides: Partial<ReadCandidateV1> = {}): ReadCandidateV1 {
  return {
    id: CANDIDATE_ID,
    cycleId: 'fy2024:cycle-1',
    manifestContentSha256: 'm'.repeat(64),
    manifestDocumentKey: CANDIDATE_ID,
    extractionArtifactId: artifact.artifactId,
    extractionArtifactSha256: artifact.contentSha256,
    sourceDocumentId: 'sd-1',
    sourceSha256: SOURCE_SHA,
    verifierVersion: 'v1',
    policyVersion: 'v1',
    policySha256: 'p'.repeat(64),
    status: 'NEEDS_REVIEW',
    currentRunId: RUN_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function runFor(overrides: Partial<ReadRunV1> = {}): ReadRunV1 {
  return {
    id: RUN_ID,
    candidateId: CANDIDATE_ID,
    verifierVersion: 'v1',
    policyVersion: 'v1',
    policySha256: 'p'.repeat(64),
    decision: 'REVIEW',
    status: 'NEEDS_REVIEW',
    route: 'human_review',
    riskScore: 40,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    manifestContentSha256: 'm'.repeat(64),
    extractionArtifactSha256: '',
    sourceSha256: SOURCE_SHA,
    resultSnapshot: {},
    createdAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

const SCOPE: ScopedFactReviewScopeV1 = {
  scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
  peCode: '0601102A',
  fiscalYear: 2024,
  fundingField: 'request',
  component: 'ARMY',
};

function baseInput(overrides: {
  artifact?: DefenseBudgetExtractionArtifactV1;
  checks?: ReadCheckV1[];
  discrepancies?: ReadDiscrepancyV1[];
  proofSnapshots?: ReadProofSnapshotV1[];
  candidateOverrides?: Partial<ReadCandidateV1>;
  runOverrides?: Partial<ReadRunV1>;
} = {}) {
  const artifact = overrides.artifact ?? baseArtifact();
  const candidate = candidateFor(artifact, overrides.candidateOverrides);
  const run = runFor({ extractionArtifactSha256: artifact.contentSha256, ...overrides.runOverrides });
  return {
    candidate,
    run,
    checks: overrides.checks ?? [],
    discrepancies: overrides.discrepancies ?? [],
    proofSnapshots: overrides.proofSnapshots ?? [],
    artifact,
    scope: SCOPE,
  };
}

describe('evaluateScopedFactReviewEligibilityV1', () => {
  it('is eligible for a clean single PE total with no findings anywhere', () => {
    const result = evaluateScopedFactReviewEligibilityV1(baseInput());
    expect(result.eligible).toBe(true);
    expect(result.refusalReasons).toEqual([]);
    expect(result.assertionIds.sort()).toEqual(['asrt-identity', 'asrt-total']);
    expect(result.projection?.totalMillions).toBe('296.67');
    expect(result.projection?.source.physicalPage).toBe(43);
    expect(result.scopeKey).toBe(scopedFactReviewScopeKeyV1(SCOPE));
  });

  it('refuses when the run decision is REJECT', () => {
    const result = evaluateScopedFactReviewEligibilityV1(baseInput({ runOverrides: { decision: 'REJECT' } }));
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toContain('run_not_pass_or_review');
  });

  it('refuses when the candidate status is REJECTED', () => {
    const result = evaluateScopedFactReviewEligibilityV1(baseInput({ candidateOverrides: { status: 'REJECTED' } }));
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toContain('candidate_not_reviewable');
  });

  it('refuses on any blocking-severity discrepancy, even if it never names the approved assertion', () => {
    const result = evaluateScopedFactReviewEligibilityV1(
      baseInput({
        discrepancies: [
          { discrepancyId: 'd1', code: 'unrelated_blocker', severity: 'blocking', description: 'x', assertionIds: [], evidenceIds: [], referenceArtifactIds: [] },
        ],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toContain('blocking_discrepancy_present');
  });

  it('refuses when a proof snapshot is missing or mismatched', () => {
    const result = evaluateScopedFactReviewEligibilityV1(
      baseInput({ proofSnapshots: [{ proofKind: 'source_document', status: 'mismatch', sourceDocumentId: 'sd-1', artifactId: null, referenceArtifactId: null, evidenceJson: {} }] }),
    );
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toContain('proof_snapshot_not_verified');
  });

  it('refuses when the recomputed artifact content hash does not match the candidate', () => {
    const input = baseInput();
    const tampered = { ...input.candidate, extractionArtifactSha256: 'f'.repeat(64) };
    const result = evaluateScopedFactReviewEligibilityV1({ ...input, candidate: tampered });
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toContain('artifact_hash_mismatch');
  });

  it('refuses when the artifact source does not match the requested scope component/FY', () => {
    const result = evaluateScopedFactReviewEligibilityV1(
      baseInput({ artifact: baseArtifact({ source: { ...baseArtifact().source, component: 'NAVY' } }) }),
    );
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toContain('artifact_source_out_of_scope');
  });

  it('refuses when no pe_total assertion exists for the requested PE/FY', () => {
    const artifact = baseArtifact();
    artifact.assertions = artifact.assertions.filter((a) => (a as { fieldName?: string }).fieldName !== 'r2_total_component');
    const result = evaluateScopedFactReviewEligibilityV1(baseInput({ artifact }));
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toContain('pe_total_not_found');
  });

  it('refuses on a duplicate pe_total for the same PE/FY (ambiguous)', () => {
    const artifact = baseArtifact();
    const dup = { ...(artifact.assertions[1] as object), assertionId: 'asrt-total-2' };
    artifact.assertions = [...artifact.assertions, dup as never];
    artifact.contentSha256 = computeArtifactContentSha256(artifact);
    const result = evaluateScopedFactReviewEligibilityV1(baseInput({ artifact }));
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toContain('ambiguous_duplicate_pe_total');
  });

  it('refuses when the identity assertion is missing on the pe_total\'s own physical page', () => {
    const artifact = baseArtifact();
    artifact.assertions = artifact.assertions.map((a) =>
      (a as { assertionId: string }).assertionId === 'asrt-identity'
        ? ({ ...(a as object), metadata: { ...(a as { metadata: object }).metadata, physicalPage: 999 } } as never)
        : a,
    );
    artifact.contentSha256 = computeArtifactContentSha256(artifact);
    const result = evaluateScopedFactReviewEligibilityV1(baseInput({ artifact }));
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toContain('identity_not_anchored_on_page');
  });

  it('refuses when a discrepancy directly names the approved total assertion (direct finding)', () => {
    const result = evaluateScopedFactReviewEligibilityV1(
      baseInput({
        discrepancies: [
          { discrepancyId: 'd1', code: 'review_omission', severity: 'review', description: 'x', assertionIds: ['asrt-total'], evidenceIds: [], referenceArtifactIds: [] },
        ],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toContain('scoped_assertion_named_in_unresolved_finding');
    expect(result.independence?.directFindings).toEqual([{ kind: 'discrepancy', id: 'd1', code: 'review_omission' }]);
  });

  it('refuses when an omission lands on the SAME physical page and SAME row as the approved total (row_index resolves from the source fact path)', () => {
    const artifact = baseArtifact();
    artifact.sourceFacts = [{ factId: 'fact-1', sourcePath: 'omitted:x/page:43/row:3/col:5', category: 'money', requiredForCompleteness: false, rawValue: '1.0', evidenceIds: [] } as never];
    artifact.omissions = [{ omissionId: 'om-1', sourceFactId: 'fact-1', reason: 'ambiguous_layout', severity: 'review', message: 'R-2 omission: repeated_header at page 43 row 3' } as never];
    artifact.contentSha256 = computeArtifactContentSha256(artifact);
    const result = evaluateScopedFactReviewEligibilityV1(baseInput({ artifact }));
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toContain('same_row_finding_on_approved_page');
    expect(result.independence?.samePageFindings).toEqual([
      expect.objectContaining({ kind: 'omission', relation: 'same_row', rowIndex: 3 }),
    ]);
  });

  it('records (but does not block on) a finding on the same page but a DIFFERENT row, and surfaces it as a limitation', () => {
    const artifact = baseArtifact();
    artifact.sourceFacts = [{ factId: 'fact-1', sourcePath: 'omitted:x/page:43/row:9/col:5', category: 'money', requiredForCompleteness: false, rawValue: '1.0', evidenceIds: [] } as never];
    artifact.omissions = [{ omissionId: 'om-1', sourceFactId: 'fact-1', reason: 'ambiguous_layout', severity: 'review', message: 'R-2A funding omission: continuation_row at page 43' } as never];
    artifact.contentSha256 = computeArtifactContentSha256(artifact);
    const result = evaluateScopedFactReviewEligibilityV1(baseInput({ artifact }));
    expect(result.eligible).toBe(true);
    expect(result.independence?.samePageFindings).toEqual([
      expect.objectContaining({ kind: 'omission', relation: 'different_row', rowIndex: 9 }),
    ]);
    expect(result.limitations.some((l) => l.startsWith('same_page_findings:1'))).toBe(true);
  });

  it('refuses when any assertion on the approved page is bound to a DIFFERENT PE -- the Phase 10B-34 wrong-identity-binding defect class', () => {
    const artifact = baseArtifact();
    artifact.assertions = [
      ...artifact.assertions,
      {
        assertionId: 'asrt-leaked',
        sourceFactIds: [],
        evidenceIds: ['ev-total'],
        confidence: 1,
        metadata: { exhibit: 'R-2A', rowKind: 'project', physicalPage: 43, tableIndex: 0, rowIndex: 5, columnIndex: 7 },
        assertionKind: 'project_funding',
        parentPeCode: '0601103A',
        projectCode: 'AB3',
        fiscalYear: 2025,
        field: 'request',
        money: { originalValue: '78.009', originalUnit: 'millions', valueMillions: '78.009' },
      } as never,
    ];
    artifact.contentSha256 = computeArtifactContentSha256(artifact);
    const result = evaluateScopedFactReviewEligibilityV1(baseInput({ artifact }));
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toContain('wrong_identity_binding_on_approved_page');
    expect(result.independence?.wrongIdentityAssertionsOnPage).toEqual([
      { assertionId: 'asrt-leaked', assertionKind: 'project_funding', identity: '0601103A/AB3' },
    ]);
  });

  it('an absent-from-the-discrepancy-list assertion is not automatically independent: a NOT_RUN required check naming it still blocks', () => {
    const result = evaluateScopedFactReviewEligibilityV1(
      baseInput({
        checks: [
          { checkId: 'c1', code: 'money_evidence_policy', ruleVersion: 'v1', outcome: 'NOT_RUN', required: true, blocking: false, riskPoints: 10, message: 'x', assertionIds: ['asrt-total'], evidenceIds: [], referenceArtifactIds: [] },
        ],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toContain('scoped_assertion_named_in_unresolved_finding');
  });

  it('rejects an unsupported scope kind before evaluating anything else', () => {
    const result = evaluateScopedFactReviewEligibilityV1(
      baseInput({}) as never,
    );
    const mutated = { ...baseInput(), scope: { ...SCOPE, scopeKind: 'something_else' as never } };
    const r2 = evaluateScopedFactReviewEligibilityV1(mutated);
    expect(r2.eligible).toBe(false);
    expect(r2.refusalReasons).toEqual([expect.objectContaining({ code: 'unsupported_scope_kind' })]);
    expect(result.eligible).toBe(true);
  });

  it('always includes a partial-coverage limitation, even when eligible', () => {
    const result = evaluateScopedFactReviewEligibilityV1(baseInput());
    expect(result.limitations.some((l) => l.startsWith('coverage:partial'))).toBe(true);
    expect(result.limitations.some((l) => l.startsWith('scope:pe_total_only'))).toBe(true);
  });
});
