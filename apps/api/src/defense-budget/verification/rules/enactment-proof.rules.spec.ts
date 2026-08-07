import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  SourceEvidenceV1,
} from '../../contracts/extraction-artifact-v1.js';
import { stageSourceProfileHashV1 } from '../../stages/stage-source-profile-v1.js';
import { createEnactedPublicLawSourceProfileV1 } from '../../stages/enacted/enacted-source-profile-v1.js';
import { composeEnactedStageV1 } from '../../stages/enacted/enacted-composer-v1.js';
import { defenseBudgetEnactmentProofV1Schema } from '../../stages/enacted/enactment-proof-v1.js';
import type { VerificationContextV1 } from '../verification-input-v1.js';
import type { TrustedVerificationProofBundleV1 } from '../trusted-proof/trusted-proof-types.js';
import { ENACTMENT_PROOF_RULE } from './enactment-proof.rules.js';

const FY = 2027;
const PL_SHA = 'a'.repeat(64);
const LINE_SHA = 'b'.repeat(64);
const INCORPORATED_PROFILE = createEnactedPublicLawSourceProfileV1({
  fiscalYear: FY,
  publicLawNumber: 'P.L. 119-99',
  billId: 'H.R. 5001',
  publicLawDocumentKey: 'pl',
  lineDetailDocumentKey: 'jes',
});
const DIRECT_PROFILE = createEnactedPublicLawSourceProfileV1({
  fiscalYear: FY,
  publicLawNumber: 'P.L. 119-99',
  billId: 'H.R. 5001',
  publicLawDocumentKey: 'pl',
});

function source(key: string, id: string, sha: string, type: string): ExtractionSourceV1 {
  return {
    manifestDocumentKey: key,
    sourceDocumentId: id,
    sourcePdfSha256: sha,
    sourceLocator: `fixture://${key}`,
    fiscalYear: FY,
    family: 'public_law',
    exhibit: 'public_law',
    authority: 'public_law',
    component: 'DW',
    budgetCycle: 'fy2027',
    documentType: type,
  };
}
const PL = source('pl', 'pl-source', PL_SHA, 'public_law');
const JES = source('jes', 'jes-source', LINE_SHA, 'incorporated_explanatory_statement');

function evidence(sha: string): SourceEvidenceV1[] {
  return [
    {
      evidenceId: 'line-e1',
      sourcePdfSha256: sha,
      parserRunId: 'manual-will-rebind',
      granularity: 'page_only',
      page: 1,
    },
  ];
}

function proof(direct = false) {
  const profile = direct ? DIRECT_PROFILE : INCORPORATED_PROFILE;
  return defenseBudgetEnactmentProofV1Schema.parse({
    schemaVersion: 'defense_budget_enactment_proof_v1',
    proofId: direct ? 'direct-proof' : 'inc-proof',
    fiscalYear: FY,
    publicLawNumber: 'P.L. 119-99',
    enactmentDate: '2027-09-30',
    billId: 'H.R. 5001',
    vehicleKind: 'full_year',
    publicLawSource: {
      manifestDocumentKey: 'pl',
      sourceDocumentId: 'pl-source',
      sourceSha256: PL_SHA,
      status: 'current',
    },
    lineDetailSource: direct
      ? {
          manifestDocumentKey: 'pl',
          sourceDocumentId: 'pl-source',
          sourceSha256: PL_SHA,
          status: 'current',
        }
      : {
          manifestDocumentKey: 'jes',
          sourceDocumentId: 'jes-source',
          sourceSha256: LINE_SHA,
          status: 'current',
        },
    proofType: direct ? 'statutory_line_item' : 'incorporated_explanatory_statement',
    ...(direct
      ? {}
      : {
          incorporationEvidence: {
            citation: 'incorporated by section 4',
            sourceDocumentId: 'pl-source',
            sourceSha256: PL_SHA,
            evidenceIds: ['pl-e1'],
          },
        }),
    vehicleProfileHash: stageSourceProfileHashV1(profile),
    reviewerStatus: 'verified',
    explicitLineAuthority: false,
  });
}

function artifact(direct = false) {
  const profile = direct ? DIRECT_PROFILE : INCORPORATED_PROFILE;
  const lineSource = direct ? PL : JES;
  const p = proof(direct);
  return composeEnactedStageV1({
    profile,
    publicLawSource: PL,
    lineDetailSource: lineSource,
    parserRuns: [],
    lineDetailEvidence: evidence(lineSource.sourcePdfSha256),
    proof: p,
    candidates: [
      {
        candidateId: direct ? 'direct-c' : 'inc-c',
        identity: { lineKind: 'RDTE_PE', peCode: '0605053A' },
        bindingStatus: 'accepted',
        fiscalYear: FY,
        money: { originalValue: '10', originalUnit: 'millions', valueMillions: '10' },
        sourceDocumentId: lineSource.sourceDocumentId!,
        sourceSha256: lineSource.sourcePdfSha256,
        evidenceIds: ['line-e1'],
      },
    ],
  }).artifact;
}

function publicLawReference(candidate: DefenseBudgetExtractionArtifactV1) {
  return {
    ...candidate,
    artifactId: 'trusted-public-law-reference',
    contentSha256: 'c'.repeat(64),
    source: PL,
    assertions: [],
    sourceFacts: [],
    evidence: [],
    parserRuns: [],
    warnings: [],
    omissions: [],
  } as DefenseBudgetExtractionArtifactV1;
}

function referenceProof(reference: DefenseBudgetExtractionArtifactV1): TrustedVerificationProofBundleV1 {
  return {
    manifest: {
      locator: 'fixture://manifest',
      contentSha256: 'd'.repeat(64),
      cycleId: 'fy2027-defense',
      fiscalYear: FY,
      documentKey: reference.source.manifestDocumentKey,
    },
    extractionArtifact: {
      locator: 'fixture://public-law-reference.json',
      artifactId: reference.artifactId,
      contentSha256: reference.contentSha256,
      byteSha256: 'e'.repeat(64),
      schemaVersion: 'defense_budget_extraction_v1',
    },
    sourceDocument: {
      id: reference.source.sourceDocumentId ?? reference.source.manifestDocumentKey,
      sourceKey: reference.source.manifestDocumentKey,
      sourceSha256: reference.source.sourcePdfSha256,
      fiscalYear: FY,
      documentType: reference.source.documentType,
    },
    archive: { status: 'not_applicable' },
    parserRuns: [],
    resolvedReferenceArtifacts: [],
  };
}

function context(
  candidate: DefenseBudgetExtractionArtifactV1,
  refs: DefenseBudgetExtractionArtifactV1[] = [],
): VerificationContextV1 {
  return {
    verificationRunId: 'vr-enactment',
    candidateId: 'candidate-enactment',
    policy: {
      policyVersion: 'defense_budget_verification_policy_v1',
      family: 'public_law',
      exhibit: 'public_law',
      requiredDataCategories: ['funding'],
      requiredFundingFields: ['enacted'],
      requiredLineKinds: ['RDTE_PE'],
      allowedParserMethods: ['manual'],
      minimumMoneyEvidenceGranularity: 'page_only',
      pageOnlyMayPassWithIndependentReconciliation: true,
      requireImmutableArchive: true,
      requireParserRunProof: true,
      requiredComparisonRules: [],
      reviewComparisonRules: [],
      arithmeticRules: [],
      manualAlwaysReview: true,
      ocrMoneyAlwaysReview: true,
      congressionalMoneyAlwaysReviewWhenUncorroborated: true,
      enactedAlwaysReviewWhenUncorroborated: true,
      highMaterialityThresholdMillions: '1000',
      riskThresholds: {
        automaticPassMax: 10,
        targetedReextractionMax: 30,
        paidVerifierMax: 60,
      },
    },
    policySha256: 'f'.repeat(64),
    input: {
      artifact: candidate,
      referenceArtifacts: refs,
      referenceArtifactsProofBundles: refs.map(referenceProof),
      referenceArtifactsFindings: [],
    },
  } as unknown as VerificationContextV1;
}

describe('Phase 6 Workstream L enactment proof verification rule', () => {
  it('passes direct statutory proof without a separate public-law reference', () => {
    const candidate = artifact(true);
    expect(ENACTMENT_PROOF_RULE.execute(context(candidate)).check?.outcome).toBe('PASS');
  });

  it('blocks incorporated proof when the independently trusted public-law reference is missing', () => {
    const candidate = artifact(false);
    expect(ENACTMENT_PROOF_RULE.execute(context(candidate)).check?.outcome).toBe('FAIL');
  });

  it('passes incorporated proof with the exact independently trusted public-law reference', () => {
    const candidate = artifact(false);
    expect(
      ENACTMENT_PROOF_RULE.execute(context(candidate, [publicLawReference(candidate)])).check?.outcome,
    ).toBe('PASS');
  });

  it('blocks when the line-detail source no longer matches the artifact bytes', () => {
    const candidate = artifact(false);
    const mutated = {
      ...candidate,
      source: { ...candidate.source, sourcePdfSha256: '1'.repeat(64) },
    } as DefenseBudgetExtractionArtifactV1;
    expect(
      ENACTMENT_PROOF_RULE.execute(context(mutated, [publicLawReference(candidate)])).check?.outcome,
    ).toBe('FAIL');
  });
});
