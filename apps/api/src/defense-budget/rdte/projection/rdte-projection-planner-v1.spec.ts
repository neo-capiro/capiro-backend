import { describe, expect, it } from '@jest/globals';
import {
  ArtifactBuilderV1,
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  parserRunIdV1,
} from '../../contracts/artifact-builders.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  SourceFactCategoryV1,
} from '../../contracts/extraction-artifact-v1.js';
import { sha256Bytes } from '../../contracts/canonical-json.js';
import {
  computeRdteCycleBundleContentSha256,
  rdteCycleBundleV1Schema,
  type RdteCycleBundleV1,
  type RdteCycleVerificationRefV1,
} from '../rdte-cycle-bundle-v1.js';
import {
  planRdteCanonicalProjection,
  ProjectionPlanningError,
} from './rdte-projection-planner-v1.js';
import { planProofBoundRdteCanonicalProjection } from './rdte-proof-bound-projection-planner-v1.js';
import { proofBoundRdteCanonicalProjectionPlanV1Schema } from './rdte-canonical-projection-plan-v1.js';

const SOURCE_SHA = 'a'.repeat(64);
const MANIFEST_SHA = 'b'.repeat(64);
const POLICY_SHA = 'c'.repeat(64);
const PROJECTION_SHA = 'd'.repeat(64);
const PE = '0601101A';
const FY = 2027;

function source(exhibit: ExtractionSourceV1['exhibit'], key: string): ExtractionSourceV1 {
  return {
    manifestDocumentKey: key,
    sourceDocumentId: `source-document-${key}`,
    sourcePdfSha256: SOURCE_SHA,
    sourceLocator: `/sources/${key}.pdf`,
    sourceUrl: `https://example.test/${key}.pdf`,
    fiscalYear: FY,
    family: 'rdte',
    exhibit,
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: `pb_fy${FY}`,
    documentType: exhibit.toLowerCase(),
  };
}

function builderFor(value: ExtractionSourceV1): {
  builder: ArtifactBuilderV1;
  parserRunId: string;
} {
  const parserRunId = parserRunIdV1({ key: value.manifestDocumentKey });
  const builder = new ArtifactBuilderV1(value);
  builder.addParserRun({
    parserRunId,
    method: 'deterministic_pdfplumber',
    parserVersion: 'pdfplumber-test-v1',
    parserConfigSha256: 'e'.repeat(64),
    inputSourceSha256: SOURCE_SHA,
    outputArtifactSha256: 'f'.repeat(64),
    pageRanges: [{ startPage: 1, endPage: 20 }],
  });
  return { builder, parserRunId };
}

function addFact(input: {
  builder: ArtifactBuilderV1;
  parserRunId: string;
  source: ExtractionSourceV1;
  key: Record<string, unknown>;
  category: SourceFactCategoryV1;
  rawValue: string;
  page: number;
}) {
  const evidenceId = evidenceIdV1({ ...input.key, kind: 'projection-evidence' });
  input.builder.addEvidence({
    evidenceId,
    sourcePdfSha256: input.source.sourcePdfSha256,
    parserRunId: input.parserRunId,
    granularity: 'page_only',
    page: input.page,
  });
  const factId = factIdV1({ ...input.key, kind: 'projection-fact' });
  input.builder.addSourceFact({
    factId,
    sourcePath: `fixture/${input.source.manifestDocumentKey}/${input.page}`,
    category: input.category,
    requiredForCompleteness: true,
    rawValue: input.rawValue,
    evidenceIds: [evidenceId],
  });
  return { evidenceId, factId };
}

function buildR1(duplicateIdentity = false): DefenseBudgetExtractionArtifactV1 {
  const value = source('R-1', 'r1');
  const created = builderFor(value);
  const identity = addFact({
    ...created,
    source: value,
    key: { peCode: PE, row: 1 },
    category: 'identity',
    rawValue: PE,
    page: 1,
  });
  created.builder.addAssertion({
    assertionKind: 'program_element_identity',
    assertionId: assertionIdV1({ peCode: PE, row: 1 }),
    sourceFactIds: [identity.factId],
    evidenceIds: [identity.evidenceId],
    confidence: 1,
    identity: { lineKind: 'RDTE_PE', peCode: PE },
    title: 'Advanced Technology Development',
    component: 'ARMY',
  });
  if (duplicateIdentity) {
    const duplicate = addFact({
      ...created,
      source: value,
      key: { peCode: PE, row: 2 },
      category: 'identity',
      rawValue: PE,
      page: 2,
    });
    created.builder.addAssertion({
      assertionKind: 'program_element_identity',
      assertionId: assertionIdV1({ peCode: PE, row: 2 }),
      sourceFactIds: [duplicate.factId],
      evidenceIds: [duplicate.evidenceId],
      confidence: 1,
      identity: { lineKind: 'RDTE_PE', peCode: PE },
      title: 'Conflicting PE Title',
      component: 'ARMY',
    });
  }

  const request = addFact({
    ...created,
    source: value,
    key: { peCode: PE, fy: FY, role: 'request' },
    category: 'money',
    rawValue: '100.000',
    page: 1,
  });
  created.builder.addAssertion({
    assertionKind: 'funding',
    assertionId: assertionIdV1({ peCode: PE, fy: FY, role: 'request' }),
    sourceFactIds: [request.factId],
    evidenceIds: [request.evidenceId],
    confidence: 1,
    identity: { lineKind: 'RDTE_PE', peCode: PE },
    fiscalYear: FY,
    field: 'request',
    money: {
      originalValue: '100',
      originalUnit: 'millions',
      valueMillions: '100',
    },
    metadata: {
      columnRole: 'budget_year_request',
      disposition: 'canonical_request_candidate',
    },
  });

  const outyear = addFact({
    ...created,
    source: value,
    key: { peCode: PE, fy: 2028, role: 'outyear' },
    category: 'money',
    rawValue: '110.000',
    page: 1,
  });
  created.builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: assertionIdV1({ peCode: PE, fy: 2028, role: 'outyear' }),
    sourceFactIds: [outyear.factId],
    evidenceIds: [outyear.evidenceId],
    confidence: 1,
    fieldName: 'r1_outyear_projection',
    value: {
      peCode: PE,
      fiscalYear: 2028,
      columnRole: 'outyear_projection',
      disposition: 'pe_budget_position',
      originalValue: '110',
      originalUnit: 'millions',
      valueMillions: '110',
      positionCycle: `pb_fy${FY}`,
      direct: true,
    },
  });

  const context = addFact({
    ...created,
    source: value,
    key: { peCode: PE, role: 'ctc' },
    category: 'money',
    rawValue: '50.000',
    page: 1,
  });
  created.builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: assertionIdV1({ peCode: PE, role: 'ctc' }),
    sourceFactIds: [context.factId],
    evidenceIds: [context.evidenceId],
    confidence: 1,
    fieldName: 'r1_cost_to_complete',
    value: {
      peCode: PE,
      fiscalYear: null,
      columnRole: 'cost_to_complete',
      disposition: 'non_annual_cost',
      originalValue: '50',
      originalUnit: 'millions',
      valueMillions: '50',
      positionCycle: `pb_fy${FY}`,
      direct: true,
    },
  });
  return created.builder.finalize();
}

function buildR2a(): DefenseBudgetExtractionArtifactV1 {
  const value = source('R-2A', 'r2a');
  const created = builderFor(value);
  const project = addFact({
    ...created,
    source: value,
    key: { peCode: PE, projectCode: 'A1' },
    category: 'project',
    rawValue: 'Advanced Radar',
    page: 3,
  });
  created.builder.addAssertion({
    assertionKind: 'project',
    assertionId: assertionIdV1({ peCode: PE, projectCode: 'A1' }),
    sourceFactIds: [project.factId],
    evidenceIds: [project.evidenceId],
    confidence: 1,
    parentPeCode: PE,
    projectCode: 'A1',
    title: 'Advanced Radar',
    mission: 'Develop advanced radar.',
  });
  for (const [fiscalYear, amount, role] of [
    [FY, '60', 'budget_year_request'],
    [2028, '66', 'outyear_projection'],
  ] as const) {
    const fact = addFact({
      ...created,
      source: value,
      key: { peCode: PE, projectCode: 'A1', fiscalYear },
      category: 'money',
      rawValue: amount,
      page: 4,
    });
    created.builder.addAssertion({
      assertionKind: 'project_funding',
      assertionId: assertionIdV1({ peCode: PE, projectCode: 'A1', fiscalYear }),
      sourceFactIds: [fact.factId],
      evidenceIds: [fact.evidenceId],
      confidence: 1,
      parentPeCode: PE,
      projectCode: 'A1',
      fiscalYear,
      field: 'request',
      money: {
        originalValue: amount,
        originalUnit: 'millions',
        valueMillions: amount,
      },
      metadata: {
        columnRole: role,
        disposition: 'project_budget_position',
        positionCycle: `pb_fy${FY}`,
        direct: true,
      },
    });
  }
  return created.builder.finalize();
}

function buildR3(): DefenseBudgetExtractionArtifactV1 {
  const value = source('R-3', 'r3');
  const created = builderFor(value);
  const fact = addFact({
    ...created,
    source: value,
    key: { peCode: PE, performer: 'LOCKHEED MARTIN' },
    category: 'performer',
    rawValue: 'LOCKHEED MARTIN',
    page: 5,
  });
  created.builder.addAssertion({
    assertionKind: 'performer',
    assertionId: assertionIdV1({ peCode: PE, performer: 'LOCKHEED MARTIN' }),
    sourceFactIds: [fact.factId],
    evidenceIds: [fact.evidenceId],
    confidence: 1,
    parentPeCode: PE,
    performerName: 'LOCKHEED MARTIN CORPORATION',
    performerNormalized: 'LOCKHEED MARTIN',
    performerRole: 'PERFORMING_ACTIVITY',
    location: 'AL',
    contractMethod: 'C/CPAF',
    costCategory: 'Radar Development',
    fiscalYear: FY,
    totalCost: {
      originalValue: '250',
      originalUnit: 'millions',
      valueMillions: '250',
    },
    metadata: { roleExplicit: false },
  });
  return created.builder.finalize();
}

function buildR4(): DefenseBudgetExtractionArtifactV1 {
  const value = source('R-4', 'r4');
  const created = builderFor(value);
  const quarter = addFact({
    ...created,
    source: value,
    key: { peCode: PE, milestone: 'IOC' },
    category: 'milestone',
    rawValue: '3Q FY2028',
    page: 6,
  });
  created.builder.addAssertion({
    assertionKind: 'milestone',
    assertionId: assertionIdV1({ peCode: PE, milestone: 'IOC' }),
    sourceFactIds: [quarter.factId],
    evidenceIds: [quarter.evidenceId],
    confidence: 1,
    parentPeCode: PE,
    milestoneType: 'IOC',
    metadata: {
      plannedPeriod: {
        kind: 'fiscal_quarter',
        rawText: '3Q FY2028',
        fiscalYear: 2028,
        fiscalQuarter: 3,
      },
    },
  });
  const exact = addFact({
    ...created,
    source: value,
    key: { peCode: PE, milestone: 'CDR' },
    category: 'milestone',
    rawValue: '2027-01-15',
    page: 6,
  });
  created.builder.addAssertion({
    assertionKind: 'milestone',
    assertionId: assertionIdV1({ peCode: PE, milestone: 'CDR' }),
    sourceFactIds: [exact.factId],
    evidenceIds: [exact.evidenceId],
    confidence: 1,
    parentPeCode: PE,
    milestoneType: 'CDR',
    plannedDate: '2027-01-15',
    metadata: {
      plannedPeriod: {
        kind: 'exact_date',
        rawText: '2027-01-15',
        exactDate: '2027-01-15',
      },
    },
  });
  return created.builder.finalize();
}

function artifactByteSha(artifact: DefenseBudgetExtractionArtifactV1): string {
  return sha256Bytes(Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8'));
}

function exhibitRole(exhibit: ExtractionSourceV1['exhibit']) {
  if (exhibit === 'R-1') return 'r1_catalog' as const;
  if (exhibit === 'R-2A') return 'r2a_project_detail' as const;
  if (exhibit === 'R-3') return 'r3_cost_analysis' as const;
  return 'r4_schedule' as const;
}

function verification(
  artifact: DefenseBudgetExtractionArtifactV1,
  state: 'pass' | 'review' | 'reject' = 'pass',
): RdteCycleVerificationRefV1 {
  const decision = state === 'pass' ? 'PASS' : state === 'reject' ? 'REJECT' : 'REVIEW';
  const status =
    state === 'pass' ? 'VERIFICATION_PASSED' : state === 'reject' ? 'REJECTED' : 'NEEDS_REVIEW';
  const candidateId = `candidate-${artifact.source.manifestDocumentKey}`;
  const runId = `run-${artifact.source.manifestDocumentKey}`;
  return {
    manifestDocumentKey: artifact.source.manifestDocumentKey,
    manifestContentSha256: MANIFEST_SHA,
    artifactId: artifact.artifactId,
    artifactContentSha256: artifact.contentSha256,
    artifactByteSha256: artifactByteSha(artifact),
    candidateId,
    verificationRunId: runId,
    policySha256: POLICY_SHA,
    sourceDocumentId: artifact.source.sourceDocumentId!,
    sourcePdfSha256: artifact.source.sourcePdfSha256,
    phase2Decision: decision,
    status,
    acceptedAssertionIds:
      state === 'pass' ? artifact.assertions.map((assertion) => assertion.assertionId) : [],
    rejectedAssertionIds:
      state === 'reject' ? artifact.assertions.map((assertion) => assertion.assertionId) : [],
    verificationCandidateId: candidateId,
    decision: status,
    decisionId: runId,
  };
}

function certifiedBundle(input: {
  artifacts: readonly DefenseBudgetExtractionArtifactV1[];
  states?: Partial<Record<string, 'pass' | 'review' | 'reject'>>;
  certification?: RdteCycleBundleV1['certification'];
}): RdteCycleBundleV1 {
  const sourceDocuments = input.artifacts.map((artifact) => ({
    manifestDocumentKey: artifact.source.manifestDocumentKey,
    sourceDocumentId: artifact.source.sourceDocumentId!,
    exhibitRole: exhibitRole(artifact.source.exhibit),
    required: true,
    sourcePdfSha256: artifact.source.sourcePdfSha256,
    sourceLocator: artifact.source.sourceLocator,
    pageCount: 20,
    parserRunIds: artifact.parserRuns.map((run) => run.parserRunId),
    unresolvedPages: [],
  }));
  const artifacts = input.artifacts.map((artifact) => ({
    manifestDocumentKey: artifact.source.manifestDocumentKey,
    artifactId: artifact.artifactId,
    artifactContentSha256: artifact.contentSha256,
    artifactByteSha256: artifactByteSha(artifact),
  }));
  const verifications = input.artifacts.map((artifact) =>
    verification(artifact, input.states?.[artifact.source.manifestDocumentKey] ?? 'pass'),
  );
  const withoutHash = {
    schemaVersion: 'rdte_cycle_bundle_v1' as const,
    cycleId: 'rdte-cycle-projection-spec',
    fiscalYear: FY,
    manifestContentSha256: MANIFEST_SHA,
    sourceDocuments,
    artifacts,
    verifications,
    comparisons: [],
    coverage: [],
    projectionPlanContentSha256: PROJECTION_SHA,
    certification: input.certification ?? 'CERTIFIED_RDTE_READY_FOR_PROJECTION',
    blockingFindings: [],
    nonBlockingFindings: [],
  };
  return rdteCycleBundleV1Schema.parse({
    ...withoutHash,
    contentSha256: computeRdteCycleBundleContentSha256(withoutHash),
  });
}

function artifactSet(duplicateIdentity = false) {
  return [buildR1(duplicateIdentity), buildR2a(), buildR3(), buildR4()];
}

describe('proof-bound RDT&E projection planner', () => {
  it('projects all supported RDT&E target families with exact Phase 2 provenance', () => {
    const artifacts = artifactSet();
    const bundle = certifiedBundle({ artifacts });
    const { plan } = planProofBoundRdteCanonicalProjection({ bundle, artifacts });
    expect(proofBoundRdteCanonicalProjectionPlanV1Schema.parse(plan)).toEqual(plan);
    const targets = new Set(plan.candidates.map((candidate) => candidate.target));
    expect(targets).toEqual(
      expect.objectContaining({
        has: expect.any(Function),
      }),
    );
    for (const target of [
      'ProgramElement',
      'ProgramElementYear',
      'ProgramElementBudgetPosition',
      'ProgramElementProject',
      'ProgramElementProjectBudgetPosition',
      'ProgramElementPerformer',
      'ProgramElementMilestone',
      'ProgramElementMilestoneSchedulePeriod',
      'ProgramElementSource',
    ] as const) {
      expect(targets.has(target)).toBe(true);
    }
    for (const candidate of plan.candidates) {
      expect(candidate.verificationDecision).toBe('PASS');
      expect(candidate.verificationStatus).toBe('VERIFICATION_PASSED');
      expect(candidate.verificationPolicySha256).toBe(POLICY_SHA);
      expect(candidate.sourceDocumentId).toMatch(/^source-document-/);
      expect(candidate.verificationDecisionId).toBe(candidate.verificationRunId);
    }
  });

  it('keeps outyears as cycle positions and excludes non-annual costs', () => {
    const artifacts = artifactSet();
    const { plan } = planProofBoundRdteCanonicalProjection({
      bundle: certifiedBundle({ artifacts }),
      artifacts,
    });
    expect(
      plan.candidates.some(
        (candidate) =>
          candidate.target === 'ProgramElementBudgetPosition' &&
          candidate.values.assertedFy === 2028,
      ),
    ).toBe(true);
    expect(
      plan.candidates.some(
        (candidate) => candidate.target === 'ProgramElementYear' && candidate.values.fy === 2028,
      ),
    ).toBe(false);
    expect(plan.exclusions.some((entry) => entry.reason === 'non_annual_cost_value')).toBe(true);
  });

  it('reads isNamedCompany from metadata as a null-safe selection-filter value, not a guessed boolean', () => {
    // Gap 2: `getContractors`'s namedPrimes panel filters on this. `buildR3()`'s
    // fixture sets no `isNamedCompany` in metadata, so an unclassified row must
    // come through as `null` ("unknown"), never a guessed `true`/`false`.
    const artifacts = artifactSet();
    const { plan } = planProofBoundRdteCanonicalProjection({
      bundle: certifiedBundle({ artifacts }),
      artifacts,
    });
    const performer = plan.candidates.find(
      (candidate) => candidate.target === 'ProgramElementPerformer',
    );
    expect(performer?.values.isNamedCompany).toBeNull();
  });

  it('threads a real isNamedCompany classification through to the projected values', () => {
    const value = source('R-3', 'r3-named');
    const created = builderFor(value);
    const fact = addFact({
      ...created,
      source: value,
      key: { peCode: PE, performer: 'BOEING' },
      category: 'performer',
      rawValue: 'BOEING',
      page: 5,
    });
    created.builder.addAssertion({
      assertionKind: 'performer',
      assertionId: assertionIdV1({ peCode: PE, performer: 'BOEING' }),
      sourceFactIds: [fact.factId],
      evidenceIds: [fact.evidenceId],
      confidence: 1,
      parentPeCode: PE,
      performerName: 'BOEING COMPANY',
      performerNormalized: 'BOEING',
      performerRole: 'PERFORMING_ACTIVITY',
      location: 'MO',
      contractMethod: 'C/CPFF',
      costCategory: 'Airframe',
      fiscalYear: FY,
      metadata: { roleExplicit: false, isNamedCompany: true },
    });
    const artifacts = [buildR1(), buildR2a(), created.builder.finalize(), buildR4()];
    const { plan } = planProofBoundRdteCanonicalProjection({
      bundle: certifiedBundle({ artifacts }),
      artifacts,
    });
    const performer = plan.candidates.find(
      (candidate) =>
        candidate.target === 'ProgramElementPerformer' &&
        candidate.values.performerNormalized === 'BOEING',
    );
    expect(performer?.values.isNamedCompany).toBe(true);
  });

  it('preserves fiscal-quarter schedule fidelity without fabricating a date', () => {
    const artifacts = artifactSet();
    const { plan } = planProofBoundRdteCanonicalProjection({
      bundle: certifiedBundle({ artifacts }),
      artifacts,
    });
    const period = plan.candidates.find(
      (candidate) =>
        candidate.target === 'ProgramElementMilestoneSchedulePeriod' &&
        candidate.values.milestoneType === 'IOC',
    );
    expect(period?.values.periodKind).toBe('fiscal_quarter');
    expect(period?.values.fiscalYear).toBe(2028);
    expect(period?.values.fiscalQuarter).toBe(3);
    expect(period?.values.exactDate).toBeUndefined();
  });

  it('excludes a review-pending artifact even when a bundle is tampered as certified', () => {
    const artifacts = artifactSet();
    const bundle = certifiedBundle({ artifacts, states: { r3: 'review' } });
    const { plan } = planProofBoundRdteCanonicalProjection({ bundle, artifacts });
    expect(
      plan.candidates.some((candidate) => candidate.target === 'ProgramElementPerformer'),
    ).toBe(false);
    expect(plan.exclusions.some((entry) => entry.reason === 'artifact_needs_review')).toBe(true);
  });

  it('refuses an uncertified cycle', () => {
    const artifacts = artifactSet();
    const bundle = certifiedBundle({ artifacts, certification: 'NEEDS_REVIEW' });
    expect(() => planRdteCanonicalProjection({ bundle, artifacts })).toThrow(
      ProjectionPlanningError,
    );
  });

  it('emits conflicts rather than selecting a duplicate identity winner', () => {
    const artifacts = artifactSet(true);
    const { plan } = planProofBoundRdteCanonicalProjection({
      bundle: certifiedBundle({ artifacts }),
      artifacts,
    });
    const conflicting = plan.candidates.filter(
      (candidate) =>
        candidate.target === 'ProgramElement' &&
        candidate.naturalKey === PE &&
        candidate.operation === 'conflict',
    );
    expect(conflicting).toHaveLength(2);
    expect(plan.exclusions.filter((entry) => entry.reason === 'duplicate_conflict')).toHaveLength(
      2,
    );
  });

  it('classifies a read-only canonical snapshot and remains deterministic', () => {
    const artifacts = artifactSet();
    const bundle = certifiedBundle({ artifacts });
    const first = planProofBoundRdteCanonicalProjection({
      bundle,
      artifacts,
      canonicalRows: {
        programElements: [{ peCode: PE, title: 'Advanced Technology Development' }],
        programElementYears: [{ peCode: PE, fy: FY, request: '100.00' }],
      },
    });
    const second = planProofBoundRdteCanonicalProjection({
      bundle,
      artifacts: [...artifacts].reverse(),
      canonicalRows: {
        programElements: [{ peCode: PE, title: 'Advanced Technology Development' }],
        programElementYears: [{ peCode: PE, fy: FY, request: '100.00' }],
      },
    });
    expect(first.plan.contentSha256).toBe(second.plan.contentSha256);
    expect(
      first.plan.candidates.find((candidate) => candidate.target === 'ProgramElementYear')
        ?.operation,
    ).toBe('no_op');
  });
});
