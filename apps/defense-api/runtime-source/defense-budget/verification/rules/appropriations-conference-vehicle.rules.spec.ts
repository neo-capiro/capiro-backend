import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import { APPROPRIATIONS_CONFERENCE_VEHICLE_PROOF_FIELD } from '../../stages/appropriations/conference/appropriations-conference-facts-v1.js';
import type { VerificationContextV1 } from '../verification-input-v1.js';
import { APPROPRIATIONS_CONFERENCE_VEHICLE_RULE } from './appropriations-conference-vehicle.rules.js';

const SHA = 'a'.repeat(64);
function artifact(proofSourceSha = SHA): DefenseBudgetExtractionArtifactV1 {
  return {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: 'a1',
    contentSha256: 'b'.repeat(64),
    source: {
      manifestDocumentKey: 'conf',
      sourceDocumentId: 'conf-source',
      sourcePdfSha256: SHA,
      sourceLocator: 'fixture://conf',
      fiscalYear: 2027,
      family: 'committee',
      exhibit: 'conference_report',
      authority: 'appropriations_conference',
      component: 'DW',
      budgetCycle: 'fy2027',
      documentType: 'conference_report',
    },
    parserRuns: [],
    evidence: [],
    sourceFacts: [],
    assertions: [
      {
        assertionKind: 'document_fact',
        assertionId: 'proof-assertion',
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        fieldName: APPROPRIATIONS_CONFERENCE_VEHICLE_PROOF_FIELD,
        value: {
          schemaVersion: 'appropriations_conference_vehicle_proof_v1',
          track: 'appropriations',
          stage: 'appropriations_conference',
          authority: 'appropriations_conference',
          fiscalYear: 2027,
          billId: 'H.R. 5001',
          reportNumber: 'H. Rept. 119-800',
          vehicleStructure: 'standalone',
          primary: {
            manifestDocumentKey: 'conf',
            sourceDocumentId: 'conf-source',
            sourceSha256: proofSourceSha,
            vehicleClass: 'conference_report',
            current: true,
          },
        },
      },
    ],
    warnings: [],
    omissions: [],
    summary: {
      sourceFactCount: 0,
      requiredSourceFactCount: 0,
      coveredRequiredSourceFactCount: 0,
      omittedRequiredSourceFactCount: 0,
      uncoveredRequiredSourceFactCount: 0,
      assertionCount: 1,
      warningCount: 0,
      omissionCount: 0,
      countsByAssertionKind: { document_fact: 1 },
      countsByOmissionReason: {},
      completenessStatus: 'complete',
    },
  };
}
function context(candidate: DefenseBudgetExtractionArtifactV1): VerificationContextV1 {
  return {
    verificationRunId: 'vr-conf',
    candidateId: 'candidate-conf',
    policy: {} as never,
    policySha256: 'c'.repeat(64),
    input: { artifact: candidate, referenceArtifacts: [], referenceArtifactsFindings: [] },
  } as unknown as VerificationContextV1;
}

describe('Phase 6 Workstream K conference vehicle rule', () => {
  it('passes exact conference-report proof', () => {
    expect(
      APPROPRIATIONS_CONFERENCE_VEHICLE_RULE.execute(context(artifact())).check?.outcome,
    ).toBe('PASS');
  });

  it('fails a source-SHA mismatch', () => {
    expect(
      APPROPRIATIONS_CONFERENCE_VEHICLE_RULE.execute(
        context(artifact('d'.repeat(64))),
      ).check?.outcome,
    ).toBe('FAIL');
  });

  it('fails when vehicle proof is absent', () => {
    const candidate = artifact();
    candidate.assertions = [];
    expect(
      APPROPRIATIONS_CONFERENCE_VEHICLE_RULE.execute(context(candidate)).check?.outcome,
    ).toBe('FAIL');
  });
});
