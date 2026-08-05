import { describe, expect, it } from '@jest/globals';
import {
  ArtifactBuilderV1,
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  parserRunIdV1,
} from '../../contracts/artifact-builders.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import { sha256Bytes } from '../../contracts/canonical-json.js';
import { buildR4MilestoneArtifact } from '../r4/r4-artifact-builder-v1.js';
import type { R4ExtractionResult } from '../r4/r4-extractor-v1.js';
import {
  computeRdteCycleBundleContentSha256,
  rdteCycleBundleV1Schema,
  type RdteCycleBundleV1,
} from '../rdte-cycle-bundle-v1.js';
import { planProofBoundRdteCanonicalProjection } from './rdte-proof-bound-projection-planner-v1.js';

const SOURCE_SHA = 'a'.repeat(64);
const MANIFEST_SHA = 'b'.repeat(64);
const POLICY_SHA = 'c'.repeat(64);
const PE = '0601101A';

function artifact(): DefenseBudgetExtractionArtifactV1 {
  const builder = new ArtifactBuilderV1({
    manifestDocumentKey: 'r1',
    sourceDocumentId: 'source-r1',
    sourcePdfSha256: SOURCE_SHA,
    sourceLocator: '/sources/r1.pdf',
    fiscalYear: 2027,
    family: 'rdte',
    exhibit: 'R-1',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb_fy2027',
    documentType: 'r1',
  });
  const runId = parserRunIdV1({ key: 'r1' });
  builder.addParserRun({
    parserRunId: runId,
    method: 'deterministic_pdfplumber',
    parserVersion: 'test-v1',
    parserConfigSha256: 'd'.repeat(64),
    inputSourceSha256: SOURCE_SHA,
    outputArtifactSha256: 'e'.repeat(64),
    pageRanges: [{ startPage: 1, endPage: 1 }],
  });
  const evidenceId = evidenceIdV1({ key: 'identity' });
  const factId = factIdV1({ key: 'identity' });
  builder.addEvidence({
    evidenceId,
    sourcePdfSha256: SOURCE_SHA,
    parserRunId: runId,
    granularity: 'page_only',
    page: 1,
  });
  builder.addSourceFact({
    factId,
    sourcePath: 'r1/identity/1',
    category: 'identity',
    requiredForCompleteness: true,
    rawValue: PE,
    evidenceIds: [evidenceId],
  });
  builder.addAssertion({
    assertionKind: 'program_element_identity',
    assertionId: assertionIdV1({ key: 'identity' }),
    sourceFactIds: [factId],
    evidenceIds: [evidenceId],
    confidence: 1,
    identity: { lineKind: 'RDTE_PE', peCode: PE },
    title: 'Advanced Technology Development',
    component: 'ARMY',
  });
  return builder.finalize();
}

function projectMilestoneArtifact(): DefenseBudgetExtractionArtifactV1 {
  const extraction: R4ExtractionResult = {
    peCode: PE,
    milestones: [
      {
        parentPeCode: PE,
        projectCode: 'AA1',
        milestoneType: 'Flight Test',
        plannedPeriod: {
          kind: 'fiscal_year',
          rawText: 'FY2028',
          fiscalYear: 2028,
          confidence: 0.95,
        },
        page: 1,
        tableIndex: 0,
        rowIndex: 1,
        rawCells: [
          { columnIndex: 0, text: 'Flight Test' },
          { columnIndex: 1, text: 'FY2028' },
        ],
      },
      {
        parentPeCode: PE,
        projectCode: 'BB2',
        milestoneType: 'Flight Test',
        plannedPeriod: {
          kind: 'fiscal_year',
          rawText: 'FY2029',
          fiscalYear: 2029,
          confidence: 0.95,
        },
        page: 2,
        tableIndex: 0,
        rowIndex: 1,
        rawCells: [
          { columnIndex: 0, text: 'Flight Test' },
          { columnIndex: 1, text: 'FY2029' },
        ],
      },
    ],
    omissions: [],
    tableDetected: true,
  };
  return buildR4MilestoneArtifact({
    source: {
      manifestDocumentKey: 'r4',
      sourceDocumentId: 'source-r4',
      sourcePdfSha256: SOURCE_SHA,
      sourceLocator: '/sources/r4.pdf',
      fiscalYear: 2027,
      family: 'rdte',
      exhibit: 'R-4',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb_fy2027',
      documentType: 'r4',
    },
    parserRuns: [
      {
        parserRunId: parserRunIdV1({ key: 'r4' }),
        method: 'deterministic_pdfplumber',
        parserVersion: 'test-v1',
        parserConfigSha256: 'd'.repeat(64),
        inputSourceSha256: SOURCE_SHA,
        outputArtifactSha256: 'e'.repeat(64),
        pageRanges: [{ startPage: 1, endPage: 2 }],
      },
    ],
    extractions: [extraction],
  });
}

function bundle(input: {
  artifact: DefenseBudgetExtractionArtifactV1;
  acceptedAssertionIds: string[];
}): RdteCycleBundleV1 {
  const byteSha = sha256Bytes(
    Buffer.from(`${JSON.stringify(input.artifact, null, 2)}\n`, 'utf8'),
  );
  const documentKey = input.artifact.source.manifestDocumentKey;
  const sourceDocumentId = input.artifact.source.sourceDocumentId;
  if (!sourceDocumentId) throw new Error('test artifact requires sourceDocumentId');
  const candidateId = `candidate-${documentKey}`;
  const runId = `verification-run-${documentKey}`;
  const exhibitRole = input.artifact.source.exhibit === 'R-4' ? 'r4_schedule' : 'r1_catalog';
  const withoutHash = {
    schemaVersion: 'rdte_cycle_bundle_v1' as const,
    cycleId: `rdte-cycle-${documentKey}-test`,
    fiscalYear: 2027,
    manifestContentSha256: MANIFEST_SHA,
    sourceDocuments: [
      {
        manifestDocumentKey: documentKey,
        sourceDocumentId,
        exhibitRole,
        required: true,
        sourcePdfSha256: SOURCE_SHA,
        sourceLocator: input.artifact.source.sourceLocator,
        pageCount: 2,
        parserRunIds: input.artifact.parserRuns.map((value) => value.parserRunId),
        unresolvedPages: [],
      },
    ],
    artifacts: [
      {
        manifestDocumentKey: documentKey,
        artifactId: input.artifact.artifactId,
        artifactContentSha256: input.artifact.contentSha256,
        artifactByteSha256: byteSha,
      },
    ],
    verifications: [
      {
        manifestDocumentKey: documentKey,
        manifestContentSha256: MANIFEST_SHA,
        artifactId: input.artifact.artifactId,
        artifactContentSha256: input.artifact.contentSha256,
        artifactByteSha256: byteSha,
        candidateId,
        verificationRunId: runId,
        policySha256: POLICY_SHA,
        sourceDocumentId,
        sourcePdfSha256: SOURCE_SHA,
        phase2Decision: 'PASS' as const,
        status: 'VERIFICATION_PASSED' as const,
        acceptedAssertionIds: input.acceptedAssertionIds,
        rejectedAssertionIds: [],
        verificationCandidateId: candidateId,
        decision: 'VERIFICATION_PASSED' as const,
        decisionId: runId,
      },
    ],
    comparisons: [],
    coverage: [],
    projectionPlanContentSha256: 'f'.repeat(64),
    certification: 'CERTIFIED_RDTE_READY_FOR_PROJECTION' as const,
    blockingFindings: [],
    nonBlockingFindings: [],
  };
  return rdteCycleBundleV1Schema.parse({
    ...withoutHash,
    contentSha256: computeRdteCycleBundleContentSha256(withoutHash),
  });
}

describe('proof-bound projection assertion ledger', () => {
  it('projects only assertions explicitly accepted by Phase 2', () => {
    const value = artifact();
    const accepted = value.assertions.map((assertion) => assertion.assertionId);
    const result = planProofBoundRdteCanonicalProjection({
      bundle: bundle({ artifact: value, acceptedAssertionIds: accepted }),
      artifacts: [value],
    });
    expect(result.plan.candidates.length).toBeGreaterThan(0);
  });

  it('rejects an artifact whose candidate assertion was not accepted', () => {
    const value = artifact();
    expect(() =>
      planProofBoundRdteCanonicalProjection({
        bundle: bundle({ artifact: value, acceptedAssertionIds: [] }),
        artifacts: [value],
      }),
    ).toThrow(
      /no accepted Phase 2 assertion basis|not accepted by Phase 2|did not pass the required Phase 2 checks/,
    );
  });

  it('keeps same-label milestones distinct across projects and classifies both as inserts', () => {
    const value = projectMilestoneArtifact();
    const accepted = value.assertions.map((assertion) => assertion.assertionId);
    const result = planProofBoundRdteCanonicalProjection({
      bundle: bundle({ artifact: value, acceptedAssertionIds: accepted }),
      artifacts: [value],
      canonicalRows: {
        milestones: [
          {
            peCode: PE,
            milestoneType: 'Flight Test',
            plannedDate: null,
            actualDate: null,
          },
        ],
      },
    });

    const milestones = result.plan.candidates.filter(
      (candidate) => candidate.target === 'ProgramElementProjectMilestone',
    );
    expect(milestones).toHaveLength(2);
    expect(milestones.map((candidate) => candidate.operation)).toEqual(['insert', 'insert']);
    expect(milestones.map((candidate) => candidate.naturalKey).sort()).toEqual([
      `${PE}|AA1|Flight Test`,
      `${PE}|BB2|Flight Test`,
    ]);

    const periods = result.plan.candidates.filter(
      (candidate) =>
        candidate.target === 'ProgramElementProjectMilestoneSchedulePeriod',
    );
    expect(periods).toHaveLength(2);
    expect(periods.map((candidate) => candidate.operation)).toEqual(['insert', 'insert']);
    expect(
      result.plan.exclusions.filter((exclusion) => exclusion.reason === 'duplicate_conflict'),
    ).toHaveLength(0);
  });
});
