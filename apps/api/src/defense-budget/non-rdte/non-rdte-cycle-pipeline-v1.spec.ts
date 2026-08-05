/**
 * non-rdte-cycle-pipeline-v1.spec — Workstream N test suite.
 *
 * Tests:
 *   - procurement family certifies when all required documents present
 *   - missing required document blocks certification
 *   - rejected artifact blocks certification
 *   - needs-review artifact without allowed acceptance blocks
 *   - needs-review artifact with allowed acceptance passes
 *   - funding mismatch blocks certification
 *   - OM family certifies
 *   - MILCON family certifies
 *   - empty cycle (no documents) produces INCOMPLETE
 *   - deterministic: same input → same bundle content SHA
 *   - no canonical writer imports in pipeline module
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runNonRdteCyclePipeline } from './non-rdte-cycle-pipeline-v1.js';
import type { NonRdteCycleVerificationRefV1 } from './non-rdte-cycle-bundle-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../contracts/extraction-artifact-v1.js';
import type { BudgetCycleManifestDocumentV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type { ProcurementFamilyReport } from '../procurement/procurement-composer-v1.js';
import type { OmFamilyReport } from '../om/om-composer-v1.js';
import type { MilconFamilyReport } from '../milcon/milcon-composer-v1.js';

const SHA = 'a'.repeat(64);

function makeArtifact(key: string, exhibit: string): DefenseBudgetExtractionArtifactV1 {
  return {
    artifactId: `art_${key}`,
    schemaVersion: 'defense_budget_extraction_v1',
    source: {
      manifestDocumentKey: key,
      sourcePdfSha256: SHA,
      sourceLocator: `fixture://${key}.pdf`,
      fiscalYear: 2027,
      family: 'procurement',
      exhibit,
      budgetCycle: 'pb_fy2027',
      component: 'ARMY',
      sourceUrl: `fixture://${key}.pdf`,
    },
    contentSha256: SHA,
    assertions: [],
    evidence: [],
    omissions: [],
    warnings: [],
    parserRuns: [],
    extractedAt: '2026-01-01T00:00:00Z',
  } as unknown as DefenseBudgetExtractionArtifactV1;
}

function makeManifestDoc(
  key: string,
  exhibit: string,
  family: 'procurement' | 'om' | 'milcon',
  required: boolean,
): BudgetCycleManifestDocumentV1 {
  return {
    documentKey: key,
    required,
    title: `Fixture ${exhibit}`,
    sourceLocator: `fixture://${key}.pdf`,
    family,
    exhibit,
    authority: 'procurement',
    component: 'ARMY',
    budgetCycle: 'pb_fy2027',
    documentType: 'pdf',
    parserPolicy: 'native_structured',
    requiredDataCategories: ['identity', 'funding'],
    expectedLineKinds: ['PROCUREMENT_BLIN'],
  } as unknown as BudgetCycleManifestDocumentV1;
}

function makeVerification(
  key: string,
  decision: 'VERIFICATION_PASSED' | 'NEEDS_REVIEW' | 'REJECTED',
  decisionId?: string,
): NonRdteCycleVerificationRefV1 {
  return {
    manifestDocumentKey: key,
    artifactId: `art_${key}`,
    verificationCandidateId: `vc_${key}`,
    verificationRunId: `vr_${key}`,
    decision,
    decisionId: decisionId ?? `vd_${key}`,
  };
}

function makeProcurementReport(complete: boolean): ProcurementFamilyReport {
  return {
    identities: [
      {
        naturalKey: 'PROCUREMENT_BLIN:ARMY:2031A:LINE1:base',
        printedCode: 'LINE1',
        account: '2031A',
        component: 'ARMY',
        advanceProcurement: false,
        exhibits: ['P-1', 'P-40'],
      },
    ],
    fundingComparisons: [
      {
        identityNaturalKey: 'PROCUREMENT_BLIN:ARMY:2031A:LINE1:base',
        printedCode: 'LINE1',
        fiscalYear: 2027,
        columnRole: 'budget_year_request',
        result: complete ? 'pass' : 'fail',
      },
    ],
    verification: {
      decision: complete ? 'VERIFICATION_PASSED' : 'NEEDS_REVIEW',
      blocking: !complete,
      findings: complete
        ? []
        : [
            {
              findingId: 'f1',
              severity: 'blocking',
              code: 'funding_mismatch',
              message: 'P-1 != P-40',
            },
          ],
    },
    missingExhibits: [],
    completenessStatus: complete ? 'complete' : 'incomplete',
    artifactCount: 2,
    assertionCount: 10,
  };
}

function makeOmReport(): OmFamilyReport {
  return {
    identities: [
      {
        naturalKey: 'OM_SAG:ARMY:O&M, ARMY:SAG1',
        printedCode: 'SAG1',
        account: 'O&M, ARMY',
        component: 'ARMY',
        exhibits: ['O-1', 'OP-5'],
      },
    ],
    fundingComparisons: [
      {
        identityNaturalKey: 'OM_SAG:ARMY:O&M, ARMY:SAG1',
        printedCode: 'SAG1',
        fiscalYear: 2027,
        columnRole: 'budget_year_request',
        result: 'pass',
      },
    ],
    verification: {
      decision: 'VERIFICATION_PASSED',
      blocking: false,
      findings: [],
    },
    missingExhibits: [],
    completenessStatus: 'complete',
    artifactCount: 2,
    assertionCount: 8,
  };
}

function makeMilconReport(): MilconFamilyReport {
  return {
    identities: [
      {
        naturalKey: 'MILCON_PROJECT:ARMY:PROJ1:NO_LOC:NO_ACCT',
        printedProjectCode: 'PROJ1',
        component: 'ARMY',
        exhibits: ['C-1', 'DD1391'],
      },
    ],
    fundingComparisons: [
      {
        identityNaturalKey: 'MILCON_PROJECT:ARMY:PROJ1:NO_LOC:NO_ACCT',
        printedProjectCode: 'PROJ1',
        fiscalYear: 2027,
        fundingType: 'request',
        result: 'pass',
      },
    ],
    verification: {
      decision: 'VERIFICATION_PASSED',
      blocking: false,
      findings: [],
    },
    missingExhibits: [],
    completenessStatus: 'complete',
    artifactCount: 2,
    assertionCount: 15,
  };
}

describe('non-rdte-cycle-pipeline-v1', () => {
  it('procurement family certifies when complete', () => {
    const report = makeProcurementReport(true);
    const result = runNonRdteCyclePipeline({
      cycleIdIdentity: { fy: 2027, family: 'procurement' },
      fiscalYear: 2027,
      family: 'procurement',
      manifestContentSha256: SHA,
      documents: [
        {
          document: makeManifestDoc('p1', 'P-1', 'procurement', true),
          artifact: makeArtifact('p1', 'P-1'),
        },
        {
          document: makeManifestDoc('p40', 'P-40', 'procurement', true),
          artifact: makeArtifact('p40', 'P-40'),
        },
      ],
      verifications: [
        makeVerification('p1', 'VERIFICATION_PASSED'),
        makeVerification('p40', 'VERIFICATION_PASSED'),
      ],
      familyReport: report,
      requiredIdentityKeys: ['PROCUREMENT_BLIN:ARMY:2031A:LINE1:base'],
    });
    expect(result.certification).toBe('CERTIFIED_NON_RDTE_READY_FOR_PROJECTION');
    expect(result.counts.blockingFindingCount).toBe(0);
  });

  it('missing required document blocks certification', () => {
    /* The report claims incomplete since P-40 is missing. */
    const report = makeProcurementReport(false);
    report.missingExhibits = ['P-40'];
    const result = runNonRdteCyclePipeline({
      cycleIdIdentity: { fy: 2027, family: 'procurement' },
      fiscalYear: 2027,
      family: 'procurement',
      manifestContentSha256: SHA,
      documents: [
        {
          document: makeManifestDoc('p1', 'P-1', 'procurement', true),
          artifact: makeArtifact('p1', 'P-1'),
        },
      ],
      verifications: [makeVerification('p1', 'VERIFICATION_PASSED')],
      familyReport: report,
      requiredIdentityKeys: ['PROCUREMENT_BLIN:ARMY:2031A:LINE1:base'],
    });
    expect(result.certification).not.toBe('CERTIFIED_NON_RDTE_READY_FOR_PROJECTION');
  });

  it('rejected artifact blocks certification', () => {
    const report = makeProcurementReport(true);
    const result = runNonRdteCyclePipeline({
      cycleIdIdentity: { fy: 2027, family: 'procurement' },
      fiscalYear: 2027,
      family: 'procurement',
      manifestContentSha256: SHA,
      documents: [
        {
          document: makeManifestDoc('p1', 'P-1', 'procurement', true),
          artifact: makeArtifact('p1', 'P-1'),
        },
        {
          document: makeManifestDoc('p40', 'P-40', 'procurement', true),
          artifact: makeArtifact('p40', 'P-40'),
        },
      ],
      verifications: [
        makeVerification('p1', 'VERIFICATION_PASSED'),
        makeVerification('p40', 'REJECTED'),
      ],
      familyReport: report,
      requiredIdentityKeys: ['PROCUREMENT_BLIN:ARMY:2031A:LINE1:base'],
    });
    expect(result.certification).toBe('REJECTED');
  });

  it('needs-review without allowed acceptance blocks', () => {
    const report = makeProcurementReport(true);
    const result = runNonRdteCyclePipeline({
      cycleIdIdentity: { fy: 2027, family: 'procurement' },
      fiscalYear: 2027,
      family: 'procurement',
      manifestContentSha256: SHA,
      documents: [
        {
          document: makeManifestDoc('p1', 'P-1', 'procurement', true),
          artifact: makeArtifact('p1', 'P-1'),
        },
        {
          document: makeManifestDoc('p40', 'P-40', 'procurement', true),
          artifact: makeArtifact('p40', 'P-40'),
        },
      ],
      verifications: [
        makeVerification('p1', 'VERIFICATION_PASSED'),
        makeVerification('p40', 'NEEDS_REVIEW'),
      ],
      familyReport: report,
      requiredIdentityKeys: ['PROCUREMENT_BLIN:ARMY:2031A:LINE1:base'],
    });
    expect(result.certification).not.toBe('CERTIFIED_NON_RDTE_READY_FOR_PROJECTION');
  });

  it('needs-review with allowed acceptance passes', () => {
    const report = makeProcurementReport(true);
    const decisionId = 'vd_p40';
    const result = runNonRdteCyclePipeline({
      cycleIdIdentity: { fy: 2027, family: 'procurement' },
      fiscalYear: 2027,
      family: 'procurement',
      manifestContentSha256: SHA,
      documents: [
        {
          document: makeManifestDoc('p1', 'P-1', 'procurement', true),
          artifact: makeArtifact('p1', 'P-1'),
        },
        {
          document: makeManifestDoc('p40', 'P-40', 'procurement', true),
          artifact: makeArtifact('p40', 'P-40'),
        },
      ],
      verifications: [
        makeVerification('p1', 'VERIFICATION_PASSED'),
        makeVerification('p40', 'NEEDS_REVIEW', decisionId),
      ],
      allowedReviewedAcceptances: new Set([decisionId]),
      familyReport: report,
      requiredIdentityKeys: ['PROCUREMENT_BLIN:ARMY:2031A:LINE1:base'],
    });
    expect(result.certification).toBe('CERTIFIED_NON_RDTE_READY_FOR_PROJECTION');
  });

  it('funding mismatch blocks certification', () => {
    const report = makeProcurementReport(false);
    const result = runNonRdteCyclePipeline({
      cycleIdIdentity: { fy: 2027, family: 'procurement' },
      fiscalYear: 2027,
      family: 'procurement',
      manifestContentSha256: SHA,
      documents: [
        {
          document: makeManifestDoc('p1', 'P-1', 'procurement', true),
          artifact: makeArtifact('p1', 'P-1'),
        },
        {
          document: makeManifestDoc('p40', 'P-40', 'procurement', true),
          artifact: makeArtifact('p40', 'P-40'),
        },
      ],
      verifications: [
        makeVerification('p1', 'VERIFICATION_PASSED'),
        makeVerification('p40', 'VERIFICATION_PASSED'),
      ],
      familyReport: report,
      requiredIdentityKeys: ['PROCUREMENT_BLIN:ARMY:2031A:LINE1:base'],
    });
    expect(result.certification).not.toBe('CERTIFIED_NON_RDTE_READY_FOR_PROJECTION');
    expect(result.counts.blockingFindingCount).toBeGreaterThan(0);
  });

  it('OM family certifies when complete', () => {
    const report = makeOmReport();
    const result = runNonRdteCyclePipeline({
      cycleIdIdentity: { fy: 2027, family: 'om' },
      fiscalYear: 2027,
      family: 'om',
      manifestContentSha256: SHA,
      documents: [
        {
          document: makeManifestDoc('o1', 'O-1', 'om', true),
          artifact: makeArtifact('o1', 'O-1'),
        },
        {
          document: makeManifestDoc('op5', 'OP-5', 'om', true),
          artifact: makeArtifact('op5', 'OP-5'),
        },
      ],
      verifications: [
        makeVerification('o1', 'VERIFICATION_PASSED'),
        makeVerification('op5', 'VERIFICATION_PASSED'),
      ],
      familyReport: report,
      requiredIdentityKeys: ['OM_SAG:ARMY:O&M, ARMY:SAG1'],
    });
    expect(result.certification).toBe('CERTIFIED_NON_RDTE_READY_FOR_PROJECTION');
  });

  it('MILCON family certifies when complete', () => {
    const report = makeMilconReport();
    const result = runNonRdteCyclePipeline({
      cycleIdIdentity: { fy: 2027, family: 'milcon' },
      fiscalYear: 2027,
      family: 'milcon',
      manifestContentSha256: SHA,
      documents: [
        {
          document: makeManifestDoc('c1', 'C-1', 'milcon', true),
          artifact: makeArtifact('c1', 'C-1'),
        },
        {
          document: makeManifestDoc('dd1391', 'DD1391', 'milcon', true),
          artifact: makeArtifact('dd1391', 'DD1391'),
        },
      ],
      verifications: [
        makeVerification('c1', 'VERIFICATION_PASSED'),
        makeVerification('dd1391', 'VERIFICATION_PASSED'),
      ],
      familyReport: report,
      requiredIdentityKeys: ['MILCON_PROJECT:ARMY:PROJ1:NO_LOC:NO_ACCT'],
    });
    expect(result.certification).toBe('CERTIFIED_NON_RDTE_READY_FOR_PROJECTION');
  });

  it('empty cycle produces INCOMPLETE', () => {
    const report: ProcurementFamilyReport = {
      identities: [],
      fundingComparisons: [],
      verification: {
        decision: 'VERIFICATION_PASSED',
        blocking: false,
        findings: [],
      },
      missingExhibits: [],
      completenessStatus: 'complete',
      artifactCount: 0,
      assertionCount: 0,
    };
    const result = runNonRdteCyclePipeline({
      cycleIdIdentity: { fy: 2027, family: 'procurement' },
      fiscalYear: 2027,
      family: 'procurement',
      manifestContentSha256: SHA,
      documents: [],
      verifications: [],
      familyReport: report,
      requiredIdentityKeys: ['SOME_REQUIRED_KEY'],
    });
    /* With no documents supplied but a required identity key, the cycle
     * should be INCOMPLETE — the required identity is missing. */
    expect(result.certification).toBe('INCOMPLETE');
  });

  it('deterministic: same input produces same content SHA', () => {
    const report = makeProcurementReport(true);
    const identity = { fy: 2027, family: 'procurement' };
    const commonInput = {
      cycleIdIdentity: identity,
      fiscalYear: 2027,
      family: 'procurement' as const,
      manifestContentSha256: SHA,
      documents: [
        {
          document: makeManifestDoc('p1', 'P-1', 'procurement', true),
          artifact: makeArtifact('p1', 'P-1'),
        },
        {
          document: makeManifestDoc('p40', 'P-40', 'procurement', true),
          artifact: makeArtifact('p40', 'P-40'),
        },
      ],
      verifications: [
        makeVerification('p1', 'VERIFICATION_PASSED'),
        makeVerification('p40', 'VERIFICATION_PASSED'),
      ],
      familyReport: report,
      requiredIdentityKeys: ['PROCUREMENT_BLIN:ARMY:2031A:LINE1:base'],
    };
    const r1 = runNonRdteCyclePipeline(commonInput);
    const r2 = runNonRdteCyclePipeline(commonInput);
    expect(r1.bundle.contentSha256).toBe(r2.bundle.contentSha256);
  });

  it('no canonical writer imports in pipeline module', () => {
    const filePath = path.resolve(__dirname, 'non-rdte-cycle-pipeline-v1.ts');
    const source = fs.readFileSync(filePath, 'utf-8');
    expect(source).not.toContain('ProgramElementWriterService');
    expect(source).not.toContain('program-element-writer');
    expect(source).not.toContain('.create(');
    expect(source).not.toContain('.upsert(');
    expect(source).not.toContain('.update(');
  });
});
