import { BudgetVerificationV1Service } from './budget-verification-v1.service.js';
import type {
  BudgetVerificationRepositoryV1,
  PersistCompletedVerificationInputV1,
  PersistedCandidateV1,
  PersistedRunV1,
} from '../persistence/verification-repository.js';
import type {
  TrustedProofResolutionV1,
  TrustedVerificationProofResolverV1,
} from '../trusted-proof/trusted-proof-types.js';

const SHA = 'a'.repeat(64);

class RdteResolver implements TrustedVerificationProofResolverV1 {
  async resolve(): Promise<TrustedProofResolutionV1> {
    return {
      manifest: {
        cycleId: 'fy2027-rdte',
        fiscalYear: 2027,
        documents: [
          {
            documentKey: 'r1',
            family: 'rdte',
            exhibit: 'R-1',
            required: true,
            requiredDataCategories: [],
            expectedLineKinds: ['RDTE_PE'],
          },
        ],
      } as never,
      manifestDocument: {
        documentKey: 'r1',
        family: 'rdte',
        exhibit: 'R-1',
        authority: 'dod-comptroller',
        required: true,
        requiredDataCategories: [],
        expectedLineKinds: ['RDTE_PE'],
      } as never,
      manifestContentSha256: SHA,
      artifact: {
        schemaVersion: 'defense_budget_extraction_v1', artifactId: 'artifact-r1',
        contentSha256: SHA,
        source: {
          manifestDocumentKey: 'r1', sourceDocumentId: 'source-r1',
          sourcePdfSha256: SHA, sourceLocator: '/r1.pdf', fiscalYear: 2027,
          family: 'rdte', exhibit: 'R-1', authority: 'dod-comptroller',
          component: 'ARMY', budgetCycle: 'pb_fy2027', documentType: 'pb_exhibit',
        },
        assertions: [], parserRuns: [], evidence: [], sourceFacts: [], warnings: [], omissions: [],
        summary: {
          sourceFactCount: 0, requiredSourceFactCount: 0,
          coveredRequiredSourceFactCount: 0, omittedRequiredSourceFactCount: 0,
          uncoveredRequiredSourceFactCount: 0, assertionCount: 0, warningCount: 0,
          omissionCount: 0, countsByAssertionKind: {}, countsByOmissionReason: {},
          completenessStatus: 'complete',
        },
      } as never,
      extractionArtifactByteSha256: SHA,
      extractionArtifactContentSha256: SHA,
      proofBundle: {
        manifest: {
          locator: '/manifest.json',
          contentSha256: SHA,
          cycleId: 'fy2027-rdte',
          fiscalYear: 2027,
          documentKey: 'r1',
        },
        extractionArtifact: {
          artifactId: 'artifact-r1',
          locator: '/r1.json',
          contentSha256: SHA,
          byteSha256: SHA,
        },
        sourceDocument: {
          id: 'source-r1',
          sourceKey: 'source-r1',
          sourceSha256: SHA,
        },
        archive: { status: 'not_applicable' },
        parserRuns: [],
        resolvedReferenceArtifacts: [],
      } as never,
      proofFindings: [],
      referenceArtifacts: [],
      referenceArtifactsProofBundles: [],
      referenceArtifactsFindings: [],
    };
  }
}

class RecordingRepository implements Partial<BudgetVerificationRepositoryV1> {
  calls: PersistCompletedVerificationInputV1[] = [];
  async findTerminalRunByIdentity() { return null; }
  async persistCompletedVerification(input: PersistCompletedVerificationInputV1): Promise<{
    candidate: PersistedCandidateV1;
    run: PersistedRunV1;
  }> {
    this.calls.push(input);
    return {
      candidate: { id: 'candidate-rdte', status: input.result.status, currentRunId: 'run-rdte' },
      run: {
        id: 'run-rdte',
        candidateId: 'candidate-rdte',
        decision: input.result.decision,
        status: input.result.status,
        route: input.result.route,
        riskScore: input.result.riskScore,
      },
    };
  }
}

describe('RDT&E durable verification audit', () => {
  it('persist_audit writes one candidate/run aggregate through the shared repository', async () => {
    const repository = new RecordingRepository();
    const service = new BudgetVerificationV1Service(
      new RdteResolver(),
      repository as unknown as BudgetVerificationRepositoryV1,
    );
    const result = await service.verify({
      manifestLocator: '/manifest.json',
      manifestDocumentKey: 'r1',
      extractionArtifactLocator: '/r1.json',
      sourceDocumentId: 'source-r1',
      mode: 'persist_audit',
    });
    expect(repository.calls).toHaveLength(1);
    expect(repository.calls[0]?.candidateIdentity.cycleId).toBe('fy2027-rdte');
    expect(repository.calls[0]?.candidateIdentity.manifestDocumentKey).toBe('r1');
    expect(result.candidateId).toBe('candidate-rdte');
    expect(result.verificationRunId).toBe('run-rdte');
  });
});
