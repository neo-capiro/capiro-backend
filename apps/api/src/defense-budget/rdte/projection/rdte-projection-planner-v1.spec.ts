/**
 * rdte-projection-planner-v1.spec — Workstream M (Phase 4 plan §18) test
 * matrix:
 *   - verified candidate included;
 *   - unverified candidate excluded;
 *   - outyear excluded from ProgramElementYear;
 *   - outyear included as position;
 *   - historical context excluded from canonical stages;
 *   - project position mapping;
 *   - performer role mapping (incl. unsupported role claim exclusion);
 *   - milestone quarter fidelity (no fabricated dates);
 *   - duplicate conflict (never last-wins);
 *   - deterministic diff;
 *   - read-only diff classification (insert/update/no-op);
 *   - no database mutation (planner consumes a plain snapshot, imports no
 *     writer — enforced additionally by the WS N architecture gate).
 */
import { describe, it, expect } from '@jest/globals';
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
} from '../../contracts/extraction-artifact-v1.js';
import { reconcileRdteCycle } from '../reconciliation/rdte-cycle-reconciler-v1.js';
import { certifyRdteCycle } from '../reconciliation/rdte-cycle-certifier-v1.js';
import type {
  RdteCycleSourceDocumentV1,
  RdteCycleVerificationRefV1,
} from '../rdte-cycle-bundle-v1.js';
import {
  planRdteCanonicalProjection,
  ProjectionPlanningError,
} from './rdte-projection-planner-v1.js';
import { rdteCanonicalProjectionPlanV1Schema } from './rdte-canonical-projection-plan-v1.js';

const SHA = 'a'.repeat(64);
const PE1 = '0601101A';
const CYCLE_FY = 2027;

/* ------------------------------------------------------------------ */
/* Fixture builders                                                    */
/* ------------------------------------------------------------------ */

function makeSource(exhibit: ExtractionSourceV1['exhibit'], key: string): ExtractionSourceV1 {
  return {
    manifestDocumentKey: key,
    sourcePdfSha256: SHA,
    sourceLocator: `s3://bucket/${key}.pdf`,
    sourceUrl: `https://example.com/${key}.pdf`,
    fiscalYear: CYCLE_FY,
    family: 'rdte',
    exhibit,
    authority: 'dod-comptroller',
    component: 'AF',
    budgetCycle: 'pb',
    documentType: 'rdte_exhibit',
  };
}

function newBuilder(source: ExtractionSourceV1): ArtifactBuilderV1 {
  const builder = new ArtifactBuilderV1(source);
  builder.addParserRun({
    parserRunId: parserRunIdV1({ source: source.sourcePdfSha256, key: source.manifestDocumentKey }),
    method: 'manual',
    parserVersion: 'projection-spec',
    parserConfigSha256: source.sourcePdfSha256,
    inputSourceSha256: source.sourcePdfSha256,
    outputArtifactSha256: source.sourcePdfSha256,
    pageRanges: [],
  });
  return builder;
}

function addRegisteredEvidenceFact(
  builder: ArtifactBuilderV1,
  source: ExtractionSourceV1,
  identity: Record<string, unknown>,
  category: 'identity' | 'money' | 'project' | 'performer' | 'milestone',
  rawValue: string,
  page: number,
): { evidenceId: string; factId: string } {
  const evidenceId = evidenceIdV1({ ...identity, kind: 'proj_spec_evidence' });
  builder.addEvidence({
    evidenceId,
    sourcePdfSha256: source.sourcePdfSha256,
    parserRunId: parserRunIdV1({ source: source.sourcePdfSha256, key: source.manifestDocumentKey }),
    granularity: 'page_only',
    page,
  });
  const factId = factIdV1({ ...identity, kind: 'proj_spec_fact' });
  builder.addSourceFact({
    factId,
    sourcePath: `pe:${PE1}/page:${page}/${JSON.stringify(identity)}`,
    category,
    requiredForCompleteness: true,
    rawValue,
    evidenceIds: [evidenceId],
  });
  return { evidenceId, factId };
}

function buildR1Artifact(): DefenseBudgetExtractionArtifactV1 {
  const source = makeSource('R-1', 'r1');
  const builder = newBuilder(source);

  const { evidenceId, factId } = addRegisteredEvidenceFact(
    builder, source, { peCode: PE1, row: 0 }, 'identity', PE1, 3,
  );
  builder.addAssertion({
    assertionKind: 'program_element_identity',
    assertionId: assertionIdV1({ peCode: PE1, kind: 'r1_identity_spec' }),
    sourceFactIds: [factId],
    evidenceIds: [evidenceId],
    confidence: 1,
    identity: { lineKind: 'RDTE_PE', peCode: PE1 },
    title: 'Advanced Technology Development',
    component: 'AF',
    budgetActivity: '3',
  });

  /* Budget-year request (canonical_request_candidate). */
  const request = addRegisteredEvidenceFact(
    builder, source, { peCode: PE1, fy: CYCLE_FY, role: 'budget_year_request' }, 'money', '100.0', 3,
  );
  builder.addAssertion({
    assertionKind: 'funding',
    assertionId: assertionIdV1({ peCode: PE1, fy: CYCLE_FY, kind: 'r1_request_spec' }),
    sourceFactIds: [request.factId],
    evidenceIds: [request.evidenceId],
    confidence: 1,
    identity: { lineKind: 'RDTE_PE', peCode: PE1 },
    fiscalYear: CYCLE_FY,
    field: 'request',
    money: { originalValue: '100', originalUnit: 'millions', valueMillions: '100' },
    metadata: { columnRole: 'budget_year_request', disposition: 'canonical_request_candidate' },
  });

  /* Outyear value — document fact with pe_budget_position disposition. */
  const outyear = addRegisteredEvidenceFact(
    builder, source, { peCode: PE1, fy: 2028, role: 'outyear_projection' }, 'money', '110.0', 3,
  );
  builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: assertionIdV1({ peCode: PE1, fy: 2028, kind: 'r1_outyear_spec' }),
    sourceFactIds: [outyear.factId],
    evidenceIds: [outyear.evidenceId],
    confidence: 1,
    fieldName: 'r1_outyear_projection',
    value: {
      peCode: PE1,
      fiscalYear: 2028,
      columnRole: 'outyear_projection',
      disposition: 'pe_budget_position',
      originalValue: '110',
      originalUnit: 'millions',
      valueMillions: '110',
      positionCycle: `pb_fy${CYCLE_FY}`,
      headerText: 'FY 2028',
      direct: true,
    },
  });

  /* Historical prior-year actuals — contextual only. */
  const historical = addRegisteredEvidenceFact(
    builder, source, { peCode: PE1, fy: 2026, role: 'prior_actual_context' }, 'money', '90.0', 3,
  );
  builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: assertionIdV1({ peCode: PE1, fy: 2026, kind: 'r1_historical_spec' }),
    sourceFactIds: [historical.factId],
    evidenceIds: [historical.evidenceId],
    confidence: 1,
    fieldName: 'r1_prior_actual_context',
    value: {
      peCode: PE1,
      fiscalYear: 2026,
      columnRole: 'prior_actual_context',
      disposition: 'contextual_only',
      originalValue: '90',
      originalUnit: 'millions',
      valueMillions: '90',
      positionCycle: `pb_fy${CYCLE_FY}`,
      headerText: 'FY 2026 Actual',
      direct: true,
    },
  });

  /* Cost-to-complete — non-annual cost. */
  const ctc = addRegisteredEvidenceFact(
    builder, source, { peCode: PE1, role: 'cost_to_complete' }, 'money', '50.0', 3,
  );
  builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: assertionIdV1({ peCode: PE1, kind: 'r1_ctc_spec' }),
    sourceFactIds: [ctc.factId],
    evidenceIds: [ctc.evidenceId],
    confidence: 1,
    fieldName: 'r1_cost_to_complete',
    value: {
      peCode: PE1,
      fiscalYear: null,
      columnRole: 'cost_to_complete',
      disposition: 'non_annual_cost',
      originalValue: '50',
      originalUnit: 'millions',
      valueMillions: '50',
      positionCycle: `pb_fy${CYCLE_FY}`,
      headerText: 'Cost to Complete',
      direct: true,
    },
  });

  return builder.finalize();
}

function buildR2aArtifact(): DefenseBudgetExtractionArtifactV1 {
  const source = makeSource('R-2A', 'r2a');
  const builder = newBuilder(source);

  const { evidenceId, factId } = addRegisteredEvidenceFact(
    builder, source, { peCode: PE1, project: 'A1' }, 'project', 'Advanced Radar', 5,
  );
  builder.addAssertion({
    assertionKind: 'project',
    assertionId: assertionIdV1({ peCode: PE1, project: 'A1', kind: 'r2a_project_spec' }),
    sourceFactIds: [factId],
    evidenceIds: [evidenceId],
    confidence: 1,
    parentPeCode: PE1,
    projectCode: 'A1',
    title: 'Advanced Radar',
    mission: 'Develop the advanced radar.',
    metadata: { exhibit: 'R-2A', pageStart: 5, pageEnd: 6 },
  });

  /* Project budget-year request → project position. */
  const funding = addRegisteredEvidenceFact(
    builder, source, { peCode: PE1, project: 'A1', fy: CYCLE_FY }, 'money', '60.0', 6,
  );
  builder.addAssertion({
    assertionKind: 'project_funding',
    assertionId: assertionIdV1({ peCode: PE1, project: 'A1', fy: CYCLE_FY, kind: 'r2a_pf_spec' }),
    sourceFactIds: [funding.factId],
    evidenceIds: [funding.evidenceId],
    confidence: 1,
    parentPeCode: PE1,
    projectCode: 'A1',
    fiscalYear: CYCLE_FY,
    field: 'request',
    money: { originalValue: '60', originalUnit: 'millions', valueMillions: '60' },
    metadata: {
      columnRole: 'budget_year_request',
      disposition: 'project_budget_position',
      positionCycle: `pb_fy${CYCLE_FY}`,
      direct: true,
    },
  });

  /* Project outyear → still a position of the printing cycle. */
  const outyear = addRegisteredEvidenceFact(
    builder, source, { peCode: PE1, project: 'A1', fy: 2028 }, 'money', '66.0', 6,
  );
  builder.addAssertion({
    assertionKind: 'project_funding',
    assertionId: assertionIdV1({ peCode: PE1, project: 'A1', fy: 2028, kind: 'r2a_pf_oy_spec' }),
    sourceFactIds: [outyear.factId],
    evidenceIds: [outyear.evidenceId],
    confidence: 1,
    parentPeCode: PE1,
    projectCode: 'A1',
    fiscalYear: 2028,
    field: 'request',
    money: { originalValue: '66', originalUnit: 'millions', valueMillions: '66' },
    metadata: {
      columnRole: 'outyear_projection',
      disposition: 'project_budget_position',
      positionCycle: `pb_fy${CYCLE_FY}`,
      direct: true,
    },
  });

  return builder.finalize();
}

function buildR3Artifact(options?: { primeWithoutEvidence?: boolean }): DefenseBudgetExtractionArtifactV1 {
  const source = makeSource('R-3', 'r3');
  const builder = newBuilder(source);

  const { evidenceId, factId } = addRegisteredEvidenceFact(
    builder, source, { peCode: PE1, performer: 'LOCKHEED MARTIN' }, 'performer', 'LOCKHEED MARTIN', 8,
  );
  builder.addAssertion({
    assertionKind: 'performer',
    assertionId: assertionIdV1({ peCode: PE1, performer: 'LOCKHEED MARTIN', kind: 'r3_spec' }),
    sourceFactIds: [factId],
    evidenceIds: [evidenceId],
    confidence: 1,
    parentPeCode: PE1,
    performerName: 'LOCKHEED MARTIN CORPORATION',
    performerNormalized: 'LOCKHEED MARTIN',
    performerRole: 'PERFORMING_ACTIVITY',
    location: 'AL',
    contractMethod: 'C/CPAF',
    costCategory: 'Radar Development',
    fiscalYear: CYCLE_FY,
    totalCost: { originalValue: '250', originalUnit: 'millions', valueMillions: '250' },
    metadata: { roleExplicit: false, exhibit: 'R-3' },
  });

  if (options?.primeWithoutEvidence === true) {
    const prime = addRegisteredEvidenceFact(
      builder, source, { peCode: PE1, performer: 'NORTHROP' }, 'performer', 'NORTHROP', 8,
    );
    builder.addAssertion({
      assertionKind: 'performer',
      assertionId: assertionIdV1({ peCode: PE1, performer: 'NORTHROP', kind: 'r3_prime_spec' }),
      sourceFactIds: [prime.factId],
      evidenceIds: [prime.evidenceId],
      confidence: 1,
      parentPeCode: PE1,
      performerName: 'NORTHROP GRUMMAN',
      performerNormalized: 'NORTHROP GRUMMAN',
      performerRole: 'PRIME_CONTRACTOR',
      fiscalYear: CYCLE_FY,
      metadata: { roleExplicit: false, exhibit: 'R-3' },
    });
  }

  return builder.finalize();
}

function buildR4Artifact(): DefenseBudgetExtractionArtifactV1 {
  const source = makeSource('R-4', 'r4');
  const builder = newBuilder(source);

  /* Fiscal-quarter milestone — no exact date must be fabricated. */
  const q = addRegisteredEvidenceFact(
    builder, source, { peCode: PE1, milestone: 'IOC' }, 'milestone', 'IOC', 10,
  );
  builder.addAssertion({
    assertionKind: 'milestone',
    assertionId: assertionIdV1({ peCode: PE1, milestone: 'IOC', kind: 'r4_q_spec' }),
    sourceFactIds: [q.factId],
    evidenceIds: [q.evidenceId],
    confidence: 1,
    parentPeCode: PE1,
    milestoneType: 'IOC',
    metadata: {
      plannedPeriod: {
        kind: 'fiscal_quarter',
        rawText: '3Q FY2028',
        fiscalYear: 2028,
        fiscalQuarter: 3,
        confidence: 1,
      },
      exhibit: 'R-4',
    },
  });

  /* Exact-date milestone. */
  const exact = addRegisteredEvidenceFact(
    builder, source, { peCode: PE1, milestone: 'CDR' }, 'milestone', 'CDR', 10,
  );
  builder.addAssertion({
    assertionKind: 'milestone',
    assertionId: assertionIdV1({ peCode: PE1, milestone: 'CDR', kind: 'r4_exact_spec' }),
    sourceFactIds: [exact.factId],
    evidenceIds: [exact.evidenceId],
    confidence: 1,
    parentPeCode: PE1,
    milestoneType: 'CDR',
    plannedDate: '2027-01-15',
    metadata: {
      plannedPeriod: {
        kind: 'exact_date',
        rawText: 'Jan 15, 2027',
        exactDate: '2027-01-15',
        year: 2027,
        month: 1,
        confidence: 1,
      },
      exhibit: 'R-4',
    },
  });

  return builder.finalize();
}

/* ------------------------------------------------------------------ */
/* Certified-bundle assembly                                           */
/* ------------------------------------------------------------------ */

const DOC_KEYS = ['r1', 'r2a', 'r3', 'r4'] as const;

function makeSourceDocs(): RdteCycleSourceDocumentV1[] {
  return DOC_KEYS.map((key) => ({
    manifestDocumentKey: key,
    exhibitRole:
      key === 'r1'
        ? ('r1_catalog' as const)
        : key === 'r2a'
          ? ('r2a_project_detail' as const)
          : key === 'r3'
            ? ('r3_cost_analysis' as const)
            : ('r4_schedule' as const),
    required: true,
    sourcePdfSha256: SHA,
    sourceLocator: `s3://bucket/${key}.pdf`,
  }));
}

function makeVerifications(
  decision: 'VERIFICATION_PASSED' | 'NEEDS_REVIEW' | 'REJECTED' = 'VERIFICATION_PASSED',
): RdteCycleVerificationRefV1[] {
  return DOC_KEYS.map((key) => ({
    manifestDocumentKey: key,
    artifactId: `art_${key}`,
    verificationCandidateId: `cand_${key}`,
    verificationRunId: `run_${key}`,
    decision,
    decisionId: `dec_${key}`,
  }));
}

function makeCertifiedBundle(
  artifacts: readonly DefenseBudgetExtractionArtifactV1[],
  overrides?: {
    verifications?: RdteCycleVerificationRefV1[];
  },
) {
  const reconciliation = reconcileRdteCycle({
    identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1] },
    fundingComparisons: [],
    projectSumReconciliations: [],
    projectRelationships: {
      projects: [{ peCode: PE1, projectCode: 'A1' }],
      projectFundingKeys: [{ peCode: PE1, projectCode: 'A1' }],
    },
    coverageInputs: [],
  });
  const verifications = overrides?.verifications ?? makeVerifications();
  const result = certifyRdteCycle({
    cycleIdIdentity: { fy: CYCLE_FY, cycle: 'pb' },
    fiscalYear: CYCLE_FY,
    manifestContentSha256: SHA,
    sourceDocuments: makeSourceDocs(),
    /* The certified bundle references the REAL artifact IDs/content SHAs. */
    artifacts: artifacts.map((a) => ({
      manifestDocumentKey: a.source.manifestDocumentKey,
      artifactId: a.artifactId,
      artifactContentSha256: a.contentSha256,
    })),
    verifications,
    comparisons: [],
    reconciliation,
  });
  return result;
}

function fullArtifactSet(options?: { primeWithoutEvidence?: boolean }) {
  return [
    buildR1Artifact(),
    buildR2aArtifact(),
    buildR3Artifact(options),
    buildR4Artifact(),
  ];
}

function planAll(options?: { primeWithoutEvidence?: boolean }) {
  const artifacts = fullArtifactSet(options);
  const certified = makeCertifiedBundle(artifacts);
  expect(certified.certification).toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
  return planRdteCanonicalProjection({
    bundle: certified.bundle,
    artifacts,
  });
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('rdte-projection-planner-v1', () => {
  it('includes verified candidates with full provenance', () => {
    const { plan } = planAll();
    expect(plan.schemaVersion).toBe('rdte_canonical_projection_plan_v1');
    expect(plan.cycleCertification).toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
    expect(plan.positionCycle).toBe(`pb_fy${CYCLE_FY}`);

    const pe = plan.candidates.find(
      (c) => c.target === 'ProgramElement' && c.naturalKey === PE1,
    );
    expect(pe).toBeDefined();
    expect(pe?.values.peCode).toBe(PE1);
    expect(pe?.values.title).toBe('Advanced Technology Development');
    /* artifactId is the real builder-computed artifact ID; the bundle's
     * verification reference is joined via manifestDocumentKey. */
    expect(pe?.artifactId).toMatch(/^dbx1_/);
    expect(pe?.verificationRunId).toBe('run_r1');
    expect(pe?.sourcePdfSha256).toBe(SHA);
    expect(pe?.assertionIds.length).toBeGreaterThan(0);
    expect(pe?.evidenceIds.length).toBeGreaterThan(0);

    const year = plan.candidates.find((c) => c.target === 'ProgramElementYear');
    expect(year?.values.request).toBe('100');
    expect(year?.values.fy).toBe(CYCLE_FY);
  });

  it('excludes outyear values from ProgramElementYear but includes them as positions', () => {
    const { plan } = planAll();
    const years = plan.candidates.filter((c) => c.target === 'ProgramElementYear');
    expect(years).toHaveLength(1);
    expect(years[0]?.values.fy).toBe(CYCLE_FY);

    const positions = plan.candidates.filter((c) => c.target === 'ProgramElementBudgetPosition');
    expect(positions).toHaveLength(1);
    expect(positions[0]?.values.assertedFy).toBe(2028);
    expect(positions[0]?.values.positionCycle).toBe(`pb_fy${CYCLE_FY}`);
    expect(positions[0]?.values.amount).toBe('110');

    const exclusion = plan.exclusions.find((e) => e.reason === 'outyear_not_request');
    /* No funding assertion carried an outyear here, so no exclusion entry is
     * required; the structural guarantee is the position mapping above. */
    expect(exclusion ?? null).toBeNull();
  });

  it('excludes historical context and cost-to-complete from canonical targets', () => {
    const { plan } = planAll();
    const contextual = plan.exclusions.filter((e) => e.reason === 'contextual_only_value');
    expect(contextual.length).toBeGreaterThanOrEqual(1);
    const nonAnnual = plan.exclusions.filter((e) => e.reason === 'non_annual_cost_value');
    expect(nonAnnual.length).toBe(1);

    /* No candidate may target ProgramElementYear for FY2026 or carry CTC. */
    for (const candidate of plan.candidates) {
      expect(candidate.values.originalUnit ?? null).not.toBe('cost_to_complete');
      if (candidate.target === 'ProgramElementYear') {
        expect(candidate.values.fy).toBe(CYCLE_FY);
      }
    }
  });

  it('maps project identity and project positions', () => {
    const { plan } = planAll();
    const project = plan.candidates.find((c) => c.target === 'ProgramElementProject');
    expect(project?.naturalKey).toBe(`${PE1}|A1`);
    expect(project?.values.title).toBe('Advanced Radar');

    const projectPositions = plan.candidates.filter(
      (c) => c.target === 'ProgramElementProjectBudgetPosition',
    );
    expect(projectPositions).toHaveLength(2);
    const fys = projectPositions.map((c) => c.values.assertedFy).sort();
    expect(fys).toEqual([CYCLE_FY, 2028]);
    for (const position of projectPositions) {
      expect(position.values.positionCycle).toBe(`pb_fy${CYCLE_FY}`);
      expect(position.values.projectCode).toBe('A1');
    }
  });

  it('maps role-honest performers and excludes unsupported prime claims', () => {
    const withPrime = planAll({ primeWithoutEvidence: true });
    const performerCandidates = withPrime.plan.candidates.filter(
      (c) => c.target === 'ProgramElementPerformer',
    );
    expect(performerCandidates).toHaveLength(1);
    expect(performerCandidates[0]?.values.performerRole).toBe('PERFORMING_ACTIVITY');
    expect(performerCandidates[0]?.values.totalCostM).toBe('250');

    const unsupported = withPrime.plan.exclusions.filter(
      (e) => e.reason === 'unsupported_role_claim',
    );
    expect(unsupported).toHaveLength(1);
  });

  it('preserves milestone quarter fidelity without fabricated dates', () => {
    const { plan } = planAll();
    const ioc = plan.candidates.find(
      (c) => c.target === 'ProgramElementMilestone' && c.naturalKey.includes('IOC'),
    );
    expect(ioc).toBeDefined();
    expect(ioc?.values.plannedDate).toBeUndefined();
    expect(ioc?.values.actualDate).toBeUndefined();

    const cdr = plan.candidates.find(
      (c) => c.target === 'ProgramElementMilestone' && c.naturalKey.includes('CDR'),
    );
    expect(cdr?.values.plannedDate).toBe('2027-01-15');

    const periods = plan.candidates.filter(
      (c) => c.target === 'ProgramElementMilestoneSchedulePeriod',
    );
    const iocPeriod = periods.find((c) => c.values.milestoneType === 'IOC');
    expect(iocPeriod?.values.periodKind).toBe('fiscal_quarter');
    expect(iocPeriod?.values.fiscalYear).toBe(2028);
    expect(iocPeriod?.values.fiscalQuarter).toBe(3);
    expect(iocPeriod?.values.rawText).toBe('3Q FY2028');
    expect(iocPeriod?.values.exactDate).toBeUndefined();
  });

  it('refuses uncertified cycles', () => {
    const rejected = makeCertifiedBundle(fullArtifactSet(), {
      verifications: makeVerifications('REJECTED'),
    });
    expect(rejected.certification).toBe('REJECTED');
    expect(() =>
      planRdteCanonicalProjection({ bundle: rejected.bundle, artifacts: [] }),
    ).toThrow(ProjectionPlanningError);
  });

  it('excludes NEEDS_REVIEW artifacts without allowed reviewed acceptance', () => {
    const verifications = makeVerifications();
    const r3 = verifications.find((v) => v.manifestDocumentKey === 'r3');
    expect(r3).toBeDefined();
    if (r3 != null) {
      r3.decision = 'NEEDS_REVIEW';
    }
    const certified = makeCertifiedBundle([buildR3Artifact()], { verifications });
    /* NEEDS_REVIEW without allowance blocks certification. */
    expect(certified.certification).toBe('NEEDS_REVIEW');
    expect(() =>
      planRdteCanonicalProjection({
        bundle: certified.bundle,
        artifacts: [buildR3Artifact()],
      }),
    ).toThrow(ProjectionPlanningError);
  });

  it('excludes REJECTED artifacts when the cycle is still certified via allowance', () => {
    /* A cycle cannot be certified with a REJECTED required artifact; the
     * planner's artifact-level gate is exercised directly with a bundle that
     * is certified but whose artifact list contains a document rejected in a
     * later re-verification. Simulate via a certified bundle + artifact whose
     * verification says REJECTED. */
    const r3Artifact = buildR3Artifact();
    const certified = makeCertifiedBundle([r3Artifact]);
    const verifications = certified.bundle.verifications.map((v) =>
      v.manifestDocumentKey === 'r3' ? { ...v, decision: 'REJECTED' as const } : v,
    );
    const tamperedBundle = { ...certified.bundle, verifications };
    const { plan } = planRdteCanonicalProjection({
      bundle: tamperedBundle,
      artifacts: [r3Artifact],
    });
    /* A REJECTED artifact's assertions are excluded via the ledger — the
     * planner never projects them and never silently drops them. */
    expect(plan.candidates.filter((c) => c.target === 'ProgramElementPerformer')).toHaveLength(0);
    const rejected = plan.exclusions.filter((e) => e.reason === 'artifact_rejected');
    expect(rejected.length).toBeGreaterThanOrEqual(1);
  });

  it('emits duplicate conflicts instead of last-wins replacement', () => {
    /* One artifact carrying TWO conflicting identity assertions for the same
     * PE (distinct titles on two rows): every duplicate must surface as a
     * conflict record — input order never picks a winner. */
    const source = makeSource('R-1', 'r1');
    const builder = newBuilder(source);
    for (const [row, title] of [
      [0, 'Advanced Technology Development'],
      [9, 'A Different Title'],
    ] as const) {
      const { evidenceId, factId } = addRegisteredEvidenceFact(
        builder, source, { peCode: PE1, row }, 'identity', PE1, 3,
      );
      builder.addAssertion({
        assertionKind: 'program_element_identity',
        assertionId: assertionIdV1({ peCode: PE1, row, kind: 'r1_identity_dup_spec' }),
        sourceFactIds: [factId],
        evidenceIds: [evidenceId],
        confidence: 1,
        identity: { lineKind: 'RDTE_PE', peCode: PE1 },
        title,
        component: 'AF',
      });
    }
    const conflicted = builder.finalize();

    const certified = makeCertifiedBundle([conflicted]);
    const { plan } = planRdteCanonicalProjection({
      bundle: certified.bundle,
      artifacts: [conflicted],
    });

    const peCandidates = plan.candidates.filter(
      (c) => c.target === 'ProgramElement' && c.naturalKey === PE1,
    );
    expect(peCandidates.length).toBe(2);
    for (const candidate of peCandidates) {
      expect(candidate.operation).toBe('conflict');
      expect(candidate.exclusionReason).toBe('duplicate_conflict');
    }
    const conflictExclusions = plan.exclusions.filter((e) => e.reason === 'duplicate_conflict');
    expect(conflictExclusions.length).toBe(2);
  });

  it('classifies insert/update/no-op against a read-only snapshot', () => {
    const r1Artifact = buildR1Artifact();
    const certified = makeCertifiedBundle([r1Artifact]);
    const { plan } = planRdteCanonicalProjection({
      bundle: certified.bundle,
      artifacts: [r1Artifact],
      canonicalRows: {
        programElements: [{ peCode: PE1, title: 'Advanced Technology Development' }],
        programElementYears: [{ peCode: PE1, fy: CYCLE_FY, request: '100.00' }],
      },
    });
    expect(plan.diffedAgainstCanonicalRows).toBe(true);
    const pe = plan.candidates.find((c) => c.target === 'ProgramElement');
    expect(pe?.operation).toBe('no_op');
    const year = plan.candidates.find((c) => c.target === 'ProgramElementYear');
    expect(year?.operation).toBe('no_op');

    const { plan: planUpdate } = planRdteCanonicalProjection({
      bundle: certified.bundle,
      artifacts: [r1Artifact],
      canonicalRows: {
        programElements: [{ peCode: PE1, title: 'Old Title' }],
        programElementYears: [{ peCode: PE1, fy: CYCLE_FY, request: '99' }],
      },
    });
    const peUpdate = planUpdate.candidates.find((c) => c.target === 'ProgramElement');
    expect(peUpdate?.operation).toBe('update');
    const yearUpdate = planUpdate.candidates.find((c) => c.target === 'ProgramElementYear');
    expect(yearUpdate?.operation).toBe('update');
  });

  it('is deterministic across input permutations and runs', () => {
    const a = planAll();
    const b = planAll();
    expect(a.plan.contentSha256).toBe(b.plan.contentSha256);
    expect(a.plan.candidates.map((c) => c.candidateId)).toEqual(
      b.plan.candidates.map((c) => c.candidateId),
    );

    /* Artifact order must not change the plan. */
    const artifacts = fullArtifactSet();
    const certified = makeCertifiedBundle(artifacts);
    const permuted = [...artifacts].reverse();
    const p1 = planRdteCanonicalProjection({ bundle: certified.bundle, artifacts });
    const p2 = planRdteCanonicalProjection({ bundle: certified.bundle, artifacts: permuted });
    expect(p1.plan.contentSha256).toBe(p2.plan.contentSha256);
  });

  it('validates against the strict plan schema', () => {
    const { plan } = planAll();
    const parsed = rdteCanonicalProjectionPlanV1Schema.parse(plan);
    expect(parsed.contentSha256).toBe(plan.contentSha256);
  });
});
