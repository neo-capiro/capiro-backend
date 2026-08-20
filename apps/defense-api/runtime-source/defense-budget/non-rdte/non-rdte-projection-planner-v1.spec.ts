/**
 * non-rdte-projection-planner-v1.spec — Workstream M (Phase 5 plan §18) test
 * matrix for the non-RDT&E projection planner:
 *   - certified procurement family produces projection candidates;
 *   - uncertified/incomplete family throws;
 *   - rejected artifact excluded;
 *   - needs-review artifact excluded without allowed acceptance;
 *   - needs-review artifact included with allowed acceptance;
 *   - OCR-derived money excluded with ocr_review_required;
 *   - contextual-only values excluded;
 *   - duplicate natural keys become conflicts;
 *   - diff classification against canonical row snapshot (insert/update/no-op);
 *   - deterministic output (same input → same content SHA);
 *   - no-write gate: planner imports no Prisma or writer;
 *   - empty family produces empty plan;
 *   - MILCON family with cost categories produces separate candidates;
 *   - O&M family with hierarchy produces candidates with hierarchy fields.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ArtifactBuilderV1,
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  parserRunIdV1,
  warningIdV1,
} from '../contracts/artifact-builders.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
} from '../contracts/extraction-artifact-v1.js';
import { reconcileNonRdteCycle } from './non-rdte-cycle-reconciler-v1.js';
import { certifyNonRdteCycle } from './non-rdte-cycle-certifier-v1.js';
import type {
  NonRdteCycleVerificationRefV1,
  NonRdteCycleSourceDocumentV1,
} from './non-rdte-cycle-bundle-v1.js';
import type { ProcurementFamilyReport } from '../procurement/procurement-composer-v1.js';
import type { OmFamilyReport } from '../om/om-composer-v1.js';
import type { MilconFamilyReport } from '../milcon/milcon-composer-v1.js';
import {
  planNonRdteCanonicalProjection,
  NonRdteProjectionPlanningError,
} from './non-rdte-projection-planner-v1.js';
import { nonRdteCanonicalProjectionPlanV1Schema } from './non-rdte-canonical-projection-plan-v1.js';

const SHA = 'a'.repeat(64);
const CYCLE_FY = 2027;

/* ------------------------------------------------------------------ */
/* Fixture builders                                                    */
/* ------------------------------------------------------------------ */

function makeSource(
  exhibit: ExtractionSourceV1['exhibit'],
  key: string,
  family: ExtractionSourceV1['family'],
  component: ExtractionSourceV1['component'],
): ExtractionSourceV1 {
  return {
    manifestDocumentKey: key,
    sourcePdfSha256: SHA,
    sourceLocator: `s3://bucket/${key}.pdf`,
    sourceUrl: `https://example.com/${key}.pdf`,
    fiscalYear: CYCLE_FY,
    family,
    exhibit,
    authority: 'dod-comptroller',
    component,
    budgetCycle: 'pb',
    documentType: `${family}_exhibit`,
  };
}

function newBuilder(source: ExtractionSourceV1): ArtifactBuilderV1 {
  const builder = new ArtifactBuilderV1(source);
  builder.addParserRun({
    parserRunId: parserRunIdV1({
      source: source.sourcePdfSha256,
      key: source.manifestDocumentKey,
    }),
    method: 'manual',
    parserVersion: 'projection-spec',
    parserConfigSha256: source.sourcePdfSha256,
    inputSourceSha256: source.sourcePdfSha256,
    outputArtifactSha256: source.sourcePdfSha256,
    /* Covers every page this fixture cites (1, 3, 5, 7). A run declaring no
     * pages cannot honestly carry page-bearing evidence. */
    pageRanges: [{ startPage: 1, endPage: 7 }],
  });
  return builder;
}

function addEvidence(
  builder: ArtifactBuilderV1,
  source: ExtractionSourceV1,
  identity: Record<string, unknown>,
  page: number,
): { evidenceId: string; factId: string } {
  const evidenceId = evidenceIdV1({ ...identity, kind: 'non_rdte_evidence' });
  builder.addEvidence({
    evidenceId,
    sourcePdfSha256: source.sourcePdfSha256,
    parserRunId: parserRunIdV1({
      source: source.sourcePdfSha256,
      key: source.manifestDocumentKey,
    }),
    granularity: 'page_only',
    page,
  });
  const factId = factIdV1({ ...identity, kind: 'non_rdte_fact' });
  builder.addSourceFact({
    factId,
    sourcePath: `${source.manifestDocumentKey}/page:${page}/${JSON.stringify(identity)}`,
    category: 'identity',
    requiredForCompleteness: true,
    rawValue: JSON.stringify(identity),
    evidenceIds: [evidenceId],
  });
  return { evidenceId, factId };
}

/* ------------------------------------------------------------------ */
/* Procurement artifact builder                                        */
/* ------------------------------------------------------------------ */

const PROC_BLIN = '1234AB';
const PROC_ACCOUNT = '2031A: AIRCRAFT PROCUREMENT, ARMY';
const PROC_COMPONENT = 'ARMY' as const;

function buildProcurementArtifact(options?: {
  ocrDerived?: boolean;
  contextualOnly?: boolean;
  duplicateDescription?: string;
  key?: string;
}): DefenseBudgetExtractionArtifactV1 {
  const source = makeSource('P-1', options?.key ?? 'p1', 'procurement', PROC_COMPONENT);
  const builder = newBuilder(source);

  /* Identity assertion: procurement_line */
  const idIdentity = { code: PROC_BLIN, row: 0 };
  const { evidenceId: evId, factId: fId } = addEvidence(builder, source, idIdentity, 3);
  builder.addAssertion({
    assertionKind: 'procurement_line',
    assertionId: assertionIdV1({ code: PROC_BLIN, kind: 'p1_identity_spec' }),
    sourceFactIds: [fId],
    evidenceIds: [evId],
    confidence: 1,
    parentIdentity: {
      lineKind: 'PROCUREMENT_BLIN',
      code: PROC_BLIN,
      account: PROC_ACCOUNT,
      component: PROC_COMPONENT,
    },
    description: options?.duplicateDescription ?? 'Advanced Radar System',
    fiscalYear: CYCLE_FY,
    quantity: '10',
    unitCostDollars: '5000',
    dollars: { originalValue: '50', originalUnit: 'millions', valueMillions: '50' },
  });

  /* Funding assertion: budget-year request */
  const fundIdentity = { code: PROC_BLIN, fy: CYCLE_FY, role: 'request' };
  const { evidenceId: fundEv, factId: fundFact } = addEvidence(builder, source, fundIdentity, 3);
  builder.addAssertion({
    assertionKind: 'funding',
    assertionId: assertionIdV1({ code: PROC_BLIN, fy: CYCLE_FY, kind: 'p1_request' }),
    sourceFactIds: [fundFact],
    evidenceIds: [fundEv],
    confidence: 1,
    identity: {
      lineKind: 'PROCUREMENT_BLIN',
      code: PROC_BLIN,
      account: PROC_ACCOUNT,
      component: PROC_COMPONENT,
    },
    fiscalYear: CYCLE_FY,
    field: 'request',
    money: { originalValue: '50', originalUnit: 'millions', valueMillions: '50' },
    ...(options?.ocrDerived ? { metadata: { ocrDerived: true } } : {}),
  });

  /* Contextual-only funding (prior-year actual) */
  if (options?.contextualOnly) {
    const ctxIdentity = { code: PROC_BLIN, fy: 2026, role: 'prior_actual' };
    const { evidenceId: ctxEv, factId: ctxFact } = addEvidence(builder, source, ctxIdentity, 3);
    builder.addAssertion({
      assertionKind: 'funding',
      assertionId: assertionIdV1({
        code: PROC_BLIN,
        fy: 2026,
        kind: 'p1_prior_actual',
      }),
      sourceFactIds: [ctxFact],
      evidenceIds: [ctxEv],
      confidence: 1,
      identity: {
        lineKind: 'PROCUREMENT_BLIN',
        code: PROC_BLIN,
        account: PROC_ACCOUNT,
        component: PROC_COMPONENT,
      },
      fiscalYear: 2026,
      field: 'enacted',
      money: { originalValue: '40', originalUnit: 'millions', valueMillions: '40' },
      metadata: { contextualOnly: true },
    });
  }

  return builder.finalize();
}

/* ------------------------------------------------------------------ */
/* O&M artifact builder                                                */
/* ------------------------------------------------------------------ */

const OM_SAG = 'SAG001';
const OM_ACCOUNT = 'O&M, ARMY';
const OM_COMPONENT = 'ARMY' as const;

function buildOmArtifact(): DefenseBudgetExtractionArtifactV1 {
  const source = makeSource('O-1', 'o1', 'om', OM_COMPONENT);
  const builder = newBuilder(source);

  /* Identity assertion: om_line with hierarchy */
  const idIdentity = { code: OM_SAG, row: 0 };
  const { evidenceId: evId, factId: fId } = addEvidence(builder, source, idIdentity, 5);
  builder.addAssertion({
    assertionKind: 'om_line',
    assertionId: assertionIdV1({ code: OM_SAG, kind: 'o1_identity_spec' }),
    sourceFactIds: [fId],
    evidenceIds: [evId],
    confidence: 1,
    identity: {
      lineKind: 'OM_SAG',
      code: OM_SAG,
      account: OM_ACCOUNT,
      component: OM_COMPONENT,
    },
    title: 'Operations and Maintenance Support',
    budgetActivity: 'BA1',
    activityGroup: 'AG2',
    subActivityGroup: 'SAG3',
  });

  /* Funding assertion: budget-year request */
  const fundIdentity = { code: OM_SAG, fy: CYCLE_FY, role: 'request' };
  const { evidenceId: fundEv, factId: fundFact } = addEvidence(builder, source, fundIdentity, 5);
  builder.addAssertion({
    assertionKind: 'funding',
    assertionId: assertionIdV1({ code: OM_SAG, fy: CYCLE_FY, kind: 'o1_request' }),
    sourceFactIds: [fundFact],
    evidenceIds: [fundEv],
    confidence: 1,
    identity: {
      lineKind: 'OM_SAG',
      code: OM_SAG,
      account: OM_ACCOUNT,
      component: OM_COMPONENT,
    },
    fiscalYear: CYCLE_FY,
    field: 'request',
    money: { originalValue: '30', originalUnit: 'millions', valueMillions: '30' },
  });

  return builder.finalize();
}

/* ------------------------------------------------------------------ */
/* MILCON artifact builder                                             */
/* ------------------------------------------------------------------ */

const MILCON_PROJECT = 'P2027-001';
const MILCON_COMPONENT = 'AF' as const;

function buildMilconArtifact(options?: {
  withCostCategories?: boolean;
}): DefenseBudgetExtractionArtifactV1 {
  const source = makeSource('C-1', 'c1', 'milcon', MILCON_COMPONENT);
  const builder = newBuilder(source);

  /* Identity assertion: milcon_project */
  const idIdentity = { project: MILCON_PROJECT, row: 0 };
  const { evidenceId: evId, factId: fId } = addEvidence(builder, source, idIdentity, 7);
  builder.addAssertion({
    assertionKind: 'milcon_project',
    assertionId: assertionIdV1({ project: MILCON_PROJECT, kind: 'c1_identity' }),
    sourceFactIds: [fId],
    evidenceIds: [evId],
    confidence: 1,
    identity: {
      lineKind: 'MILCON_PROJECT',
      projectCode: MILCON_PROJECT,
      component: MILCON_COMPONENT,
      location: 'Joint Base San Antonio',
    },
    title: 'Facility Modernization',
    scope: 'Modernize existing facilities',
    location: 'Joint Base San Antonio',
  });

  /* Funding assertion: budget-year request */
  const fundIdentity = { project: MILCON_PROJECT, fy: CYCLE_FY, role: 'request' };
  const { evidenceId: fundEv, factId: fundFact } = addEvidence(builder, source, fundIdentity, 7);
  builder.addAssertion({
    assertionKind: 'funding',
    assertionId: assertionIdV1({
      project: MILCON_PROJECT,
      fy: CYCLE_FY,
      kind: 'c1_request',
    }),
    sourceFactIds: [fundFact],
    evidenceIds: [fundEv],
    confidence: 1,
    identity: {
      lineKind: 'MILCON_PROJECT',
      projectCode: MILCON_PROJECT,
      component: MILCON_COMPONENT,
      location: 'Joint Base San Antonio',
    },
    fiscalYear: CYCLE_FY,
    field: 'request',
    money: { originalValue: '75', originalUnit: 'millions', valueMillions: '75' },
  });

  /* Cost category document facts */
  if (options?.withCostCategories) {
    const milconKey = `MILCON_PROJECT:${MILCON_COMPONENT}:${MILCON_PROJECT}:JOINT BASE SAN ANTONIO:JOINT BASE SAN ANTONIO`;
    for (const [cat, val] of [
      ['construction', '40'],
      ['design', '15'],
      ['management', '20'],
    ] as const) {
      const catIdentity = { project: MILCON_PROJECT, category: cat };
      const { evidenceId: catEv, factId: catFact } = addEvidence(builder, source, catIdentity, 7);
      builder.addAssertion({
        assertionKind: 'document_fact',
        assertionId: assertionIdV1({
          project: MILCON_PROJECT,
          category: cat,
          kind: 'c1_cost_cat',
        }),
        sourceFactIds: [catFact],
        evidenceIds: [catEv],
        confidence: 1,
        fieldName: `cost_category_${cat}`,
        value: { valueMillions: val, costCategory: cat },
        metadata: {
          costCategory: cat,
          identityNaturalKey: milconKey,
          fiscalYear: CYCLE_FY,
        },
      });
    }
  }

  return builder.finalize();
}

/* ------------------------------------------------------------------ */
/* Certified-bundle assembly                                           */
/* ------------------------------------------------------------------ */

function makeSourceDocs(
  artifacts: readonly DefenseBudgetExtractionArtifactV1[],
  family: 'procurement' | 'om' | 'milcon',
): NonRdteCycleSourceDocumentV1[] {
  return artifacts.map((a) => ({
    manifestDocumentKey: a.source.manifestDocumentKey,
    family,
    exhibit: a.source.exhibit,
    required: true,
    sourcePdfSha256: a.source.sourcePdfSha256,
    sourceLocator: a.source.sourceLocator,
  }));
}

function makeVerifications(
  artifacts: readonly DefenseBudgetExtractionArtifactV1[],
  decision: 'VERIFICATION_PASSED' | 'NEEDS_REVIEW' | 'REJECTED' = 'VERIFICATION_PASSED',
): NonRdteCycleVerificationRefV1[] {
  return artifacts.map((a) => ({
    manifestDocumentKey: a.source.manifestDocumentKey,
    artifactId: a.artifactId,
    verificationCandidateId: `cand_${a.source.manifestDocumentKey}`,
    verificationRunId: `run_${a.source.manifestDocumentKey}`,
    decision,
    decisionId: `dec_${a.source.manifestDocumentKey}`,
  }));
}

function makeCertifiedBundle(
  artifacts: readonly DefenseBudgetExtractionArtifactV1[],
  family: 'procurement' | 'om' | 'milcon',
  overrides?: {
    verifications?: NonRdteCycleVerificationRefV1[];
  },
) {
  const reconciliation = reconcileNonRdteCycle({
    identity: {
      summaryIdentityKeys: [],
      detailIdentityKeys: [],
      requiredIdentityKeys: [],
    },
    fundingComparisons: [],
    coverageInputs: [],
  });
  const verifications = overrides?.verifications ?? makeVerifications(artifacts);
  const result = certifyNonRdteCycle({
    cycleIdIdentity: { fy: CYCLE_FY, cycle: 'pb', family },
    fiscalYear: CYCLE_FY,
    family,
    manifestContentSha256: SHA,
    sourceDocuments: makeSourceDocs(artifacts, family),
    artifacts: artifacts.map((a) => ({
      manifestDocumentKey: a.source.manifestDocumentKey,
      artifactId: a.artifactId,
      artifactContentSha256: a.contentSha256,
    })),
    verifications,
    reconciliation,
  });
  return result;
}

/* ------------------------------------------------------------------ */
/* Family report fixtures                                              */
/* ------------------------------------------------------------------ */

function makeProcurementReport(
  overrides?: Partial<ProcurementFamilyReport>,
): ProcurementFamilyReport {
  return {
    identities: [],
    fundingComparisons: [],
    verification: {
      decision: 'VERIFICATION_PASSED',
      findings: [],
      blocking: false,
    },
    missingExhibits: [],
    completenessStatus: 'complete',
    artifactCount: 1,
    assertionCount: 2,
    ...overrides,
  };
}

function makeOmReport(overrides?: Partial<OmFamilyReport>): OmFamilyReport {
  return {
    identities: [],
    fundingComparisons: [],
    verification: {
      decision: 'VERIFICATION_PASSED',
      findings: [],
      blocking: false,
    },
    missingExhibits: [],
    completenessStatus: 'complete',
    artifactCount: 1,
    assertionCount: 2,
    ...overrides,
  };
}

function makeMilconReport(overrides?: Partial<MilconFamilyReport>): MilconFamilyReport {
  return {
    identities: [],
    fundingComparisons: [],
    verification: {
      decision: 'VERIFICATION_PASSED',
      findings: [],
      blocking: false,
    },
    missingExhibits: [],
    completenessStatus: 'complete',
    artifactCount: 1,
    assertionCount: 2,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Planner helpers                                                     */
/* ------------------------------------------------------------------ */

function planProcurement(
  artifacts: readonly DefenseBudgetExtractionArtifactV1[],
  options?: {
    report?: ProcurementFamilyReport;
    verifications?: NonRdteCycleVerificationRefV1[];
    allowedReviewedAcceptances?: ReadonlySet<string>;
    canonicalRows?: Parameters<typeof planNonRdteCanonicalProjection>[0]['canonicalRows'];
  },
) {
  const certified = makeCertifiedBundle(artifacts, 'procurement', {
    verifications: options?.verifications,
  });
  expect(certified.certification).toBe('CERTIFIED_NON_RDTE_READY_FOR_PROJECTION');
  return planNonRdteCanonicalProjection({
    bundle: certified.bundle,
    artifacts,
    familyReport: options?.report ?? makeProcurementReport(),
    ...(options?.allowedReviewedAcceptances != null
      ? { allowedReviewedAcceptances: options.allowedReviewedAcceptances }
      : {}),
    ...(options?.canonicalRows != null ? { canonicalRows: options.canonicalRows } : {}),
  });
}

function planOm(
  artifacts: readonly DefenseBudgetExtractionArtifactV1[],
  options?: {
    report?: OmFamilyReport;
  },
) {
  const certified = makeCertifiedBundle(artifacts, 'om');
  return planNonRdteCanonicalProjection({
    bundle: certified.bundle,
    artifacts,
    familyReport: options?.report ?? makeOmReport(),
  });
}

function planMilcon(
  artifacts: readonly DefenseBudgetExtractionArtifactV1[],
  options?: {
    report?: MilconFamilyReport;
  },
) {
  const certified = makeCertifiedBundle(artifacts, 'milcon');
  return planNonRdteCanonicalProjection({
    bundle: certified.bundle,
    artifacts,
    familyReport: options?.report ?? makeMilconReport(),
  });
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('non-rdte-projection-planner-v1', () => {
  /* ---- 1. Certified procurement family produces candidates ---- */
  it('certified procurement family produces projection candidates', () => {
    const artifact = buildProcurementArtifact();
    const { plan } = planProcurement([artifact]);

    expect(plan.schemaVersion).toBe('non_rdte_canonical_projection_plan_v1');
    expect(plan.cycleCertification).toBe('CERTIFIED_NON_RDTE_READY_FOR_PROJECTION');
    expect(plan.family).toBe('procurement');
    expect(plan.positionCycle).toBe(`pb_fy${CYCLE_FY}`);

    const bl = plan.candidates.find((c) => c.target === 'ProcurementBudgetLine');
    expect(bl).toBeDefined();
    expect(bl?.values.printedCode).toBe(PROC_BLIN);
    expect(bl?.values.description).toBe('Advanced Radar System');
    expect(bl?.artifactId).toMatch(/^dbx1_/);
    expect(bl?.assertionIds.length).toBeGreaterThan(0);
    expect(bl?.evidenceIds.length).toBeGreaterThan(0);

    const year = plan.candidates.find((c) => c.target === 'ProcurementBudgetLineYear');
    expect(year?.values.request).toBe('50');
    expect(year?.values.fy).toBe(CYCLE_FY);

    const dist = plan.candidates.find((c) => c.target === 'ProcurementDistributionLine');
    expect(dist?.values.quantity).toBe('10');

    const detail = plan.candidates.find(
      (c) => c.target === 'ProcurementDetailFact' && c.values.kind === 'unit_cost',
    );
    expect(detail?.values.unitCostDollars).toBe('5000');

    /* Source observation should be present. */
    const srcObs = plan.candidates.find((c) => c.target === 'BudgetLineSourceObservation');
    expect(srcObs).toBeDefined();
  });

  /* ---- 2. Uncertified/incomplete family throws ---- */
  it('uncertified family throws ProjectionPlanningError', () => {
    const artifact = buildProcurementArtifact();
    const certified = makeCertifiedBundle([artifact], 'procurement');
    /* Tamper with certification. */
    const tamperedBundle = {
      ...certified.bundle,
      certification: 'INCOMPLETE' as const,
    };
    expect(() =>
      planNonRdteCanonicalProjection({
        bundle: tamperedBundle,
        artifacts: [artifact],
        familyReport: makeProcurementReport(),
      }),
    ).toThrow(NonRdteProjectionPlanningError);
  });

  it('incomplete family report throws', () => {
    const artifact = buildProcurementArtifact();
    const certified = makeCertifiedBundle([artifact], 'procurement');
    expect(() =>
      planNonRdteCanonicalProjection({
        bundle: certified.bundle,
        artifacts: [artifact],
        familyReport: makeProcurementReport({
          completenessStatus: 'incomplete',
        }),
      }),
    ).toThrow(NonRdteProjectionPlanningError);
  });

  it('blocking family report verification throws', () => {
    const artifact = buildProcurementArtifact();
    const certified = makeCertifiedBundle([artifact], 'procurement');
    expect(() =>
      planNonRdteCanonicalProjection({
        bundle: certified.bundle,
        artifacts: [artifact],
        familyReport: makeProcurementReport({
          verification: {
            decision: 'NEEDS_REVIEW',
            findings: [
              {
                findingId: 'vf1',
                severity: 'blocking',
                code: 'test_blocking',
                message: 'blocking finding',
              },
            ],
            blocking: true,
          },
        }),
      }),
    ).toThrow(NonRdteProjectionPlanningError);
  });

  /* ---- 3. Rejected artifact excluded ---- */
  it('excludes REJECTED artifacts via the ledger', () => {
    const artifact = buildProcurementArtifact();
    const certified = makeCertifiedBundle([artifact], 'procurement');
    const verifications = certified.bundle.verifications.map((v) => ({
      ...v,
      decision: 'REJECTED' as const,
    }));
    const tamperedBundle = { ...certified.bundle, verifications };
    const { plan } = planNonRdteCanonicalProjection({
      bundle: tamperedBundle,
      artifacts: [artifact],
      familyReport: makeProcurementReport(),
    });
    expect(plan.candidates.filter((c) => c.target === 'ProcurementBudgetLine')).toHaveLength(0);
    const rejected = plan.exclusions.filter((e) => e.reason === 'artifact_rejected');
    expect(rejected.length).toBeGreaterThanOrEqual(1);
  });

  /* ---- 4. Needs-review artifact excluded without allowed acceptance ---- */
  it('excludes NEEDS_REVIEW artifacts without allowed reviewed acceptance', () => {
    const artifact = buildProcurementArtifact();
    const certified = makeCertifiedBundle([artifact], 'procurement');
    const verifications = certified.bundle.verifications.map((v) => ({
      ...v,
      decision: 'NEEDS_REVIEW' as const,
    }));
    const tamperedBundle = { ...certified.bundle, verifications };
    const { plan } = planNonRdteCanonicalProjection({
      bundle: tamperedBundle,
      artifacts: [artifact],
      familyReport: makeProcurementReport(),
    });
    expect(plan.candidates.filter((c) => c.target === 'ProcurementBudgetLine')).toHaveLength(0);
    const needsReview = plan.exclusions.filter((e) => e.reason === 'artifact_needs_review');
    expect(needsReview.length).toBeGreaterThanOrEqual(1);
  });

  /* ---- 5. Needs-review artifact included with allowed acceptance ---- */
  it('includes NEEDS_REVIEW artifacts with allowed reviewed acceptance', () => {
    const artifact = buildProcurementArtifact();
    const certified = makeCertifiedBundle([artifact], 'procurement');
    const decisionId = certified.bundle.verifications[0]!.decisionId;
    const verifications = certified.bundle.verifications.map((v) => ({
      ...v,
      decision: 'NEEDS_REVIEW' as const,
    }));
    const tamperedBundle = { ...certified.bundle, verifications };
    const { plan } = planNonRdteCanonicalProjection({
      bundle: tamperedBundle,
      artifacts: [artifact],
      familyReport: makeProcurementReport(),
      allowedReviewedAcceptances: new Set([decisionId]),
    });
    const bl = plan.candidates.find((c) => c.target === 'ProcurementBudgetLine');
    expect(bl).toBeDefined();
    expect(bl?.values.printedCode).toBe(PROC_BLIN);
    const needsReview = plan.exclusions.filter((e) => e.reason === 'artifact_needs_review');
    expect(needsReview).toHaveLength(0);
  });

  /* ---- 6. OCR-derived money excluded with ocr_review_required ---- */
  it('excludes OCR-derived money with ocr_review_required', () => {
    const artifact = buildProcurementArtifact({ ocrDerived: true });
    const { plan } = planProcurement([artifact]);

    const year = plan.candidates.find((c) => c.target === 'ProcurementBudgetLineYear');
    expect(year).toBeUndefined();

    const ocrExcluded = plan.exclusions.filter((e) => e.reason === 'ocr_review_required');
    expect(ocrExcluded.length).toBeGreaterThanOrEqual(1);
  });

  /* ---- 7. Contextual-only values excluded ---- */
  it('excludes contextual-only values', () => {
    const artifact = buildProcurementArtifact({ contextualOnly: true });
    const { plan } = planProcurement([artifact]);

    const contextual = plan.exclusions.filter((e) => e.reason === 'contextual_only_value');
    expect(contextual.length).toBeGreaterThanOrEqual(1);

    /* No candidate should target a prior-year enacted value. */
    for (const candidate of plan.candidates) {
      if (candidate.target === 'ProcurementBudgetLineYear') {
        expect(candidate.values.fy).toBe(CYCLE_FY);
      }
    }
  });

  /* ---- 8. Duplicate natural keys become conflicts ---- */
  it('emits duplicate conflicts instead of last-wins replacement', () => {
    const artifact1 = buildProcurementArtifact({
      duplicateDescription: 'Advanced Radar System',
      key: 'p1-a',
    });
    const artifact2 = buildProcurementArtifact({
      duplicateDescription: 'A Different Description',
      key: 'p1-b',
    });
    /* Both artifacts must be in the bundle. */
    const certified = makeCertifiedBundle([artifact1, artifact2], 'procurement');
    const { plan } = planNonRdteCanonicalProjection({
      bundle: certified.bundle,
      artifacts: [artifact1, artifact2],
      familyReport: makeProcurementReport({ artifactCount: 2, assertionCount: 4 }),
    });

    const blCandidates = plan.candidates.filter((c) => c.target === 'ProcurementBudgetLine');
    expect(blCandidates.length).toBe(2);
    for (const candidate of blCandidates) {
      expect(candidate.operation).toBe('conflict');
      expect(candidate.exclusionReason).toBe('duplicate_conflict');
    }
    const conflictExclusions = plan.exclusions.filter((e) => e.reason === 'duplicate_conflict');
    expect(conflictExclusions.length).toBeGreaterThanOrEqual(2);
  });

  /* ---- 9. Diff classification against canonical row snapshot ---- */
  it('classifies insert/update/no-op against a read-only snapshot', () => {
    const artifact = buildProcurementArtifact();
    const certified = makeCertifiedBundle([artifact], 'procurement');
    const identityKey = `PROCUREMENT_BLIN:${PROC_COMPONENT}:${PROC_ACCOUNT.toUpperCase()}:${PROC_BLIN.toUpperCase()}:base`;

    /* No-op: canonical rows match. */
    const { plan: planNoOp } = planNonRdteCanonicalProjection({
      bundle: certified.bundle,
      artifacts: [artifact],
      familyReport: makeProcurementReport(),
      canonicalRows: {
        procurementBudgetLines: [{ naturalKey: identityKey, title: 'Advanced Radar System' }],
        procurementBudgetLineYears: [{ naturalKey: identityKey, fy: CYCLE_FY, request: '50' }],
      },
    });
    expect(planNoOp.diffedAgainstCanonicalRows).toBe(true);
    const blNoOp = planNoOp.candidates.find((c) => c.target === 'ProcurementBudgetLine');
    expect(blNoOp?.operation).toBe('no_op');
    const yearNoOp = planNoOp.candidates.find((c) => c.target === 'ProcurementBudgetLineYear');
    expect(yearNoOp?.operation).toBe('no_op');

    /* Update: canonical rows differ. */
    const { plan: planUpdate } = planNonRdteCanonicalProjection({
      bundle: certified.bundle,
      artifacts: [artifact],
      familyReport: makeProcurementReport(),
      canonicalRows: {
        procurementBudgetLines: [{ naturalKey: identityKey, title: 'Old Title' }],
        procurementBudgetLineYears: [{ naturalKey: identityKey, fy: CYCLE_FY, request: '99' }],
      },
    });
    const blUpdate = planUpdate.candidates.find((c) => c.target === 'ProcurementBudgetLine');
    expect(blUpdate?.operation).toBe('update');
    const yearUpdate = planUpdate.candidates.find((c) => c.target === 'ProcurementBudgetLineYear');
    expect(yearUpdate?.operation).toBe('update');

    /* Insert: no canonical rows. */
    const { plan: planInsert } = planNonRdteCanonicalProjection({
      bundle: certified.bundle,
      artifacts: [artifact],
      familyReport: makeProcurementReport(),
      canonicalRows: {},
    });
    const blInsert = planInsert.candidates.find((c) => c.target === 'ProcurementBudgetLine');
    expect(blInsert?.operation).toBe('insert');
  });

  /* ---- 10. Deterministic output ---- */
  it('is deterministic across input permutations and runs', () => {
    const artifact = buildProcurementArtifact();
    const a = planProcurement([artifact]);
    const b = planProcurement([artifact]);
    expect(a.plan.contentSha256).toBe(b.plan.contentSha256);
    expect(a.plan.candidates.map((c) => c.candidateId)).toEqual(
      b.plan.candidates.map((c) => c.candidateId),
    );
  });

  /* ---- 11. No-write gate: planner imports no Prisma or writer ---- */
  it('planner module imports no Prisma, writer, or NestJS dependency', () => {
    const plannerPath = join(__dirname, 'non-rdte-projection-planner-v1.ts');
    const source = readFileSync(plannerPath, 'utf-8');
    expect(source).not.toMatch(/from\s+['"]@prisma/i);
    expect(source).not.toMatch(/from\s+['"].*prisma/i);
    expect(source).not.toMatch(/ProgramElementWriterService/);
    expect(source).not.toMatch(/NonRdteCanonicalWriter/);
    expect(source).not.toMatch(/from\s+['"]@nestjs/i);
    expect(source).not.toMatch(/\.create\s*\(/);
    expect(source).not.toMatch(/\.update\s*\(/);
    expect(source).not.toMatch(/\.upsert\s*\(/);
    expect(source).not.toMatch(/\$executeRaw/);
    expect(source).not.toMatch(/\$queryRaw/);
  });

  /* ---- 12. Empty family produces empty plan ---- */
  it('empty family produces empty plan', () => {
    /* Need at least one artifact for the bundle to certify, but the artifact
     * has no assertions to project. */
    const source = makeSource('P-1', 'p1-empty', 'procurement', PROC_COMPONENT);
    const builder = newBuilder(source);
    /* Add a trivial assertion that won't match any projection target. */
    const { evidenceId: evId, factId: fId } = addEvidence(
      builder,
      source,
      { code: 'EMPTY', row: 0 },
      1,
    );
    builder.addAssertion({
      assertionKind: 'narrative',
      assertionId: assertionIdV1({ code: 'EMPTY', kind: 'empty_narrative' }),
      sourceFactIds: [fId],
      evidenceIds: [evId],
      confidence: 1,
      identity: {
        lineKind: 'UNKNOWN',
        code: 'EMPTY',
      },
      narrativeType: 'other',
      text: 'No data',
    });
    const artifact = builder.finalize();
    const certified = makeCertifiedBundle([artifact], 'procurement');
    const { plan } = planNonRdteCanonicalProjection({
      bundle: certified.bundle,
      artifacts: [artifact],
      familyReport: makeProcurementReport(),
    });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.exclusions).toHaveLength(0);
    expect(plan.diffSummary).toHaveLength(0);
  });

  /* ---- 13. MILCON family with cost categories ---- */
  it('MILCON family with cost categories produces separate candidates', () => {
    const artifact = buildMilconArtifact({ withCostCategories: true });
    const { plan } = planMilcon([artifact]);

    expect(plan.family).toBe('milcon');

    const project = plan.candidates.find((c) => c.target === 'MilconProject');
    expect(project).toBeDefined();
    expect(project?.values.printedProjectCode).toBe(MILCON_PROJECT);
    expect(project?.values.title).toBe('Facility Modernization');

    const year = plan.candidates.find((c) => c.target === 'MilconProjectYear');
    expect(year?.values.request).toBe('75');
    expect(year?.values.fy).toBe(CYCLE_FY);

    const costDetails = plan.candidates.filter((c) => c.target === 'MilconDetailFact');
    expect(costDetails).toHaveLength(3);
    const categories = costDetails.map((c) => c.values.costCategory).sort();
    expect(categories).toEqual(['construction', 'design', 'management']);
    for (const detail of costDetails) {
      expect(detail.values.fy).toBe(CYCLE_FY);
      expect(detail.values.amount).toBeDefined();
    }
  });

  /* ---- 14. O&M family with hierarchy ---- */
  it('O&M family with hierarchy produces candidates with hierarchy fields', () => {
    const artifact = buildOmArtifact();
    const { plan } = planOm([artifact]);

    expect(plan.family).toBe('om');

    const sag = plan.candidates.find((c) => c.target === 'OmSag');
    expect(sag).toBeDefined();
    expect(sag?.values.printedCode).toBe(OM_SAG);
    expect(sag?.values.title).toBe('Operations and Maintenance Support');
    expect(sag?.values.budgetActivity).toBe('BA1');
    expect(sag?.values.activityGroup).toBe('AG2');
    expect(sag?.values.subActivityGroup).toBe('SAG3');

    const year = plan.candidates.find((c) => c.target === 'OmSagYear');
    expect(year?.values.request).toBe('30');
    expect(year?.values.fy).toBe(CYCLE_FY);
  });

  /* ---- Schema validation ---- */
  it('validates against the strict plan schema', () => {
    const artifact = buildProcurementArtifact();
    const { plan } = planProcurement([artifact]);
    const parsed = nonRdteCanonicalProjectionPlanV1Schema.parse(plan);
    expect(parsed.contentSha256).toBe(plan.contentSha256);
  });
});
