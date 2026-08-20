import {
  ArtifactBuilderV1,
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
} from '../contracts/artifact-builders.js';
import type {
  BudgetLineIdentityV1,
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
} from '../contracts/extraction-artifact-v1.js';
import {
  computeParserRunId,
  sealParserRuntimeResult,
} from '../parser-router/parser-runtime-contract-v1.js';
import {
  DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION,
  DEFENSE_BUDGET_VERIFIER_VERSION,
  type DefenseBudgetVerificationResultV1,
} from '../verification/verification-contract-v1.js';
import type { ProcurementFamilyReport } from '../procurement/procurement-composer-v1.js';
import { reconcileNonRdteCycle } from './non-rdte-cycle-reconciler-v1.js';
import { certifyNonRdteCycle } from './non-rdte-cycle-certifier-v1.js';
import { planProofBoundNonRdteCanonicalProjection } from './non-rdte-proof-bound-projection-planner-v1.js';

const SOURCE_SHA = 'a'.repeat(64);
const CONFIG_SHA = 'b'.repeat(64);
const POLICY_SHA = 'c'.repeat(64);
const MANIFEST_SHA = 'd'.repeat(64);
const CYCLE_FY = 2027;

type ProcurementIdentity = Extract<BudgetLineIdentityV1, { lineKind: 'PROCUREMENT_BLIN' }>;

function procurementIdentity(): ProcurementIdentity {
  return {
    lineKind: 'PROCUREMENT_BLIN',
    component: 'ARMY',
    account: '2031A',
    code: '001',
    advanceProcurement: false,
  };
}

function fixture() {
  const result = sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: 'phase5-projection-proof',
    engine: 'deterministic_pdfplumber',
    parserVersion: 'proof-spec',
    parserConfigSha256: CONFIG_SHA,
    inputSourceSha256: SOURCE_SHA,
    requestedPages: [1],
    succeededPages: [1],
    failedPages: [],
    pages: [
      {
        page: 1,
        text: 'P-1 proof fixture',
        blocks: [],
        tables: [],
        images: [],
        evidencePrecision: 'page_only',
        warnings: [],
      },
    ],
    warnings: [],
    metrics: {
      durationMillis: 1,
      pagesProcessed: 1,
      pagesSucceeded: 1,
      pagesFailed: 0,
      engineVersion: 'proof-spec',
    },
  });
  const parserRunId = computeParserRunId({
    sourceSha256: result.inputSourceSha256,
    method: result.engine,
    parserVersion: result.parserVersion,
    parserConfigSha256: result.parserConfigSha256,
    pages: result.succeededPages,
    runtimeContractVersion: result.schemaVersion,
  });
  const source: ExtractionSourceV1 = {
    manifestDocumentKey: 'p1-proof',
    sourceDocumentId: '00000000-0000-0000-0000-000000000001',
    sourcePdfSha256: SOURCE_SHA,
    sourceLocator: 'fixture://p1-proof.pdf',
    sourceUrl: 'https://example.com/p1-proof.pdf',
    fiscalYear: CYCLE_FY,
    family: 'procurement',
    exhibit: 'P-1',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb_fy2027',
    documentType: 'pb_exhibit',
  };
  const builder = new ArtifactBuilderV1(source);
  builder.addParserRun({
    parserRunId,
    method: result.engine,
    parserVersion: result.parserVersion,
    parserConfigSha256: result.parserConfigSha256,
    inputSourceSha256: result.inputSourceSha256,
    outputArtifactSha256: result.contentSha256,
    pageRanges: [{ startPage: 1, endPage: 1 }],
  });
  const identityEvidence = evidenceIdV1({ kind: 'identity', page: 1 });
  const identityFact = factIdV1({ kind: 'identity', page: 1 });
  builder.addEvidence({
    evidenceId: identityEvidence,
    sourcePdfSha256: SOURCE_SHA,
    parserRunId,
    granularity: 'page_only',
    page: 1,
  });
  builder.addSourceFact({
    factId: identityFact,
    sourcePath: 'page:1/row:1',
    category: 'identity',
    requiredForCompleteness: true,
    rawValue: '001',
    evidenceIds: [identityEvidence],
  });
  const identityAssertionId = assertionIdV1({ kind: 'identity', code: '001' });
  builder.addAssertion({
    assertionKind: 'procurement_line',
    assertionId: identityAssertionId,
    sourceFactIds: [identityFact],
    evidenceIds: [identityEvidence],
    confidence: 1,
    parentIdentity: procurementIdentity(),
    description: 'Proof-bound line',
    fiscalYear: CYCLE_FY,
  });

  const fundingEvidence = evidenceIdV1({ kind: 'funding', page: 1 });
  const fundingFact = factIdV1({ kind: 'funding', page: 1 });
  builder.addEvidence({
    evidenceId: fundingEvidence,
    sourcePdfSha256: SOURCE_SHA,
    parserRunId,
    granularity: 'page_only',
    page: 1,
  });
  builder.addSourceFact({
    factId: fundingFact,
    sourcePath: 'page:1/row:1/column:request',
    category: 'money',
    requiredForCompleteness: true,
    rawValue: '12.5',
    evidenceIds: [fundingEvidence],
  });
  const fundingAssertionId = assertionIdV1({ kind: 'funding', code: '001' });
  builder.addAssertion({
    assertionKind: 'funding',
    assertionId: fundingAssertionId,
    sourceFactIds: [fundingFact],
    evidenceIds: [fundingEvidence],
    confidence: 1,
    identity: procurementIdentity(),
    fiscalYear: CYCLE_FY,
    field: 'request',
    money: {
      originalValue: '12.5',
      originalUnit: 'millions',
      valueMillions: '12.5',
    },
  });
  return {
    artifact: builder.finalize(),
    result,
    parserRunId,
    identityAssertionId,
    fundingAssertionId,
  };
}

function certifiedBundle(artifact: DefenseBudgetExtractionArtifactV1) {
  const reconciliation = reconcileNonRdteCycle({
    identity: {
      summaryIdentityKeys: [],
      detailIdentityKeys: [],
      requiredIdentityKeys: [],
    },
    fundingComparisons: [],
    coverageInputs: [],
  });
  return certifyNonRdteCycle({
    cycleIdIdentity: { cycle: 'pb_fy2027', family: 'procurement' },
    fiscalYear: CYCLE_FY,
    family: 'procurement',
    manifestContentSha256: MANIFEST_SHA,
    sourceDocuments: [
      {
        manifestDocumentKey: artifact.source.manifestDocumentKey,
        family: 'procurement',
        exhibit: 'P-1',
        required: true,
        sourcePdfSha256: SOURCE_SHA,
        sourceLocator: artifact.source.sourceLocator,
      },
    ],
    artifacts: [
      {
        manifestDocumentKey: artifact.source.manifestDocumentKey,
        artifactId: artifact.artifactId,
        artifactContentSha256: artifact.contentSha256,
      },
    ],
    verifications: [
      {
        manifestDocumentKey: artifact.source.manifestDocumentKey,
        artifactId: artifact.artifactId,
        verificationCandidateId: 'candidate-proof',
        verificationRunId: 'run-proof',
        decision: 'VERIFICATION_PASSED',
        decisionId: 'decision-proof',
      },
    ],
    reconciliation,
  });
}

function verificationResult(input: {
  artifact: DefenseBudgetExtractionArtifactV1;
  acceptedAssertionIds: string[];
  rejectedAssertionIds?: string[];
}): DefenseBudgetVerificationResultV1 {
  return {
    verifierVersion: DEFENSE_BUDGET_VERIFIER_VERSION,
    policyVersion: DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION,
    policySha256: POLICY_SHA,
    verificationRunId: 'run-proof',
    candidateId: 'candidate-proof',
    cycleId: 'phase5-proof-cycle',
    manifestContentSha256: MANIFEST_SHA,
    manifestDocumentKey: input.artifact.source.manifestDocumentKey,
    extractionArtifactId: input.artifact.artifactId,
    extractionArtifactSha256: input.artifact.contentSha256,
    sourceDocumentId: input.artifact.source.sourceDocumentId!,
    sourcePdfSha256: SOURCE_SHA,
    decision: 'PASS',
    status: 'VERIFICATION_PASSED',
    route: 'none',
    riskScore: 0,
    checks: [],
    discrepancies: [],
    acceptedAssertionIds: input.acceptedAssertionIds,
    rejectedAssertionIds: input.rejectedAssertionIds ?? [],
    referenceArtifactIds: [],
    startedAt: '2026-08-05T00:00:00Z',
    completedAt: '2026-08-05T00:00:01Z',
  };
}

const report: ProcurementFamilyReport = {
  identities: [],
  fundingComparisons: [],
  verification: { decision: 'VERIFICATION_PASSED', findings: [], blocking: false },
  missingExhibits: [],
  completenessStatus: 'complete',
  artifactCount: 1,
  assertionCount: 2,
};

describe('proof-bound Phase 5 projection planner', () => {
  it('projects only Phase 2 accepted assertions and binds source-observation proof', () => {
    const fixtureData = fixture();
    const certified = certifiedBundle(fixtureData.artifact);
    expect(certified.certification).toBe('CERTIFIED_NON_RDTE_READY_FOR_PROJECTION');
    const verification = verificationResult({
      artifact: fixtureData.artifact,
      acceptedAssertionIds: [fixtureData.identityAssertionId],
      rejectedAssertionIds: [fixtureData.fundingAssertionId],
    });
    const { plan } = planProofBoundNonRdteCanonicalProjection({
      bundle: certified.bundle,
      artifacts: [fixtureData.artifact],
      familyReport: report,
      parserResultProofsByArtifactId: new Map([
        [
          fixtureData.artifact.artifactId,
          [
            {
              parserRunId: fixtureData.parserRunId,
              result: fixtureData.result,
              resultByteSha256: 'e'.repeat(64),
            },
          ],
        ],
      ]),
      verificationResultsByRunId: new Map([['run-proof', verification]]),
      milconAccountByDocumentKey: new Map(),
    });
    expect(
      plan.candidates.some((candidate) => candidate.target === 'ProcurementBudgetLineYear'),
    ).toBe(false);
    expect(
      plan.candidates.some((candidate) =>
        candidate.assertionIds.includes(fixtureData.fundingAssertionId),
      ),
    ).toBe(false);
    const observation = plan.candidates.find(
      (candidate) => candidate.target === 'BudgetLineSourceObservation',
    );
    expect(observation?.assertionIds).toEqual([fixtureData.identityAssertionId]);
    expect(observation?.evidenceIds.length).toBeGreaterThan(0);
  });

  it('rejects an accepted assertion ID not present in the artifact', () => {
    const fixtureData = fixture();
    const certified = certifiedBundle(fixtureData.artifact);
    const verification = verificationResult({
      artifact: fixtureData.artifact,
      acceptedAssertionIds: ['assertion-does-not-exist'],
    });
    expect(() =>
      planProofBoundNonRdteCanonicalProjection({
        bundle: certified.bundle,
        artifacts: [fixtureData.artifact],
        familyReport: report,
        parserResultProofsByArtifactId: new Map([
          [
            fixtureData.artifact.artifactId,
            [
              {
                parserRunId: fixtureData.parserRunId,
                result: fixtureData.result,
              },
            ],
          ],
        ]),
        verificationResultsByRunId: new Map([['run-proof', verification]]),
        milconAccountByDocumentKey: new Map(),
      }),
    ).toThrow(/accepted unknown assertion/);
  });
});
