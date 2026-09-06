/**
 * Phase 10B-28R -- candidate cycle identity resolution in the verifier.
 *
 * `VerificationRequestV1.cycleId` (optional) names the governed cycle the
 * candidate belongs to. When present, the persisted candidate identity and
 * `result.cycleId` carry it; the proof manifest's own cycleId label stays on
 * the manifest proof snapshot (with the candidate cycle id alongside it when
 * the two differ). When absent, the manifest cycleId is used exactly as before
 * this phase. The stubbed resolver/repository here isolate the verifier's own
 * behavior; the real-database counterpart is
 * `persistence/lifecycle-bridge-candidate-cycle-identity.integration.spec.ts`.
 */
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
import { computeCandidateId, computeRunId } from '../persistence/verification-persistence-mappers.js';

const SHA = 'a'.repeat(64);
const RAW_CYCLE_ID = 'cff02efd-45e7-4ae4-8f7f-dacd12bdb84c';
const MANIFEST_CYCLE_LABEL = `fy2024:${RAW_CYCLE_ID}`;

class BridgeShapedResolver implements TrustedVerificationProofResolverV1 {
  async resolve(): Promise<TrustedProofResolutionV1> {
    return {
      manifest: {
        cycleId: MANIFEST_CYCLE_LABEL,
        fiscalYear: 2024,
        documents: [
          {
            documentKey: 'doc-1',
            family: 'rdte',
            exhibit: 'R-2',
            required: true,
            requiredDataCategories: [],
            expectedLineKinds: ['RDTE_PE'],
          },
        ],
      } as never,
      manifestDocument: {
        documentKey: 'doc-1',
        family: 'rdte',
        exhibit: 'R-2',
        authority: 'dod-comptroller',
        required: true,
        requiredDataCategories: [],
        expectedLineKinds: ['RDTE_PE'],
      } as never,
      manifestContentSha256: SHA,
      artifact: {
        schemaVersion: 'defense_budget_extraction_v1',
        artifactId: 'artifact-doc-1',
        contentSha256: SHA,
        source: {
          manifestDocumentKey: 'doc-1',
          sourceDocumentId: 'doc-1',
          sourcePdfSha256: SHA,
          sourceLocator: '/source.pdf',
          fiscalYear: 2024,
          family: 'rdte',
          exhibit: 'R-2',
          authority: 'dod-comptroller',
          component: 'ARMY',
          budgetCycle: 'pb',
          documentType: 'r2',
        },
        assertions: [],
        parserRuns: [],
        evidence: [],
        sourceFacts: [],
        warnings: [],
        omissions: [],
        summary: {
          sourceFactCount: 0,
          requiredSourceFactCount: 0,
          coveredRequiredSourceFactCount: 0,
          omittedRequiredSourceFactCount: 0,
          uncoveredRequiredSourceFactCount: 0,
          assertionCount: 0,
          warningCount: 0,
          omissionCount: 0,
          countsByAssertionKind: {},
          countsByOmissionReason: {},
          completenessStatus: 'complete',
        },
      } as never,
      extractionArtifactByteSha256: SHA,
      extractionArtifactContentSha256: SHA,
      proofBundle: {
        manifest: {
          locator: '/manifest.json',
          contentSha256: SHA,
          cycleId: MANIFEST_CYCLE_LABEL,
          fiscalYear: 2024,
          documentKey: 'doc-1',
        },
        extractionArtifact: {
          artifactId: 'artifact-doc-1',
          locator: '/artifact.json',
          contentSha256: SHA,
          byteSha256: SHA,
        },
        sourceDocument: { id: 'doc-1', sourceKey: 'doc-1', sourceSha256: SHA },
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
  async findTerminalRunByIdentity() {
    return null;
  }
  async persistCompletedVerification(input: PersistCompletedVerificationInputV1): Promise<{
    candidate: PersistedCandidateV1;
    run: PersistedRunV1;
  }> {
    this.calls.push(input);
    return {
      candidate: { id: 'candidate-1', status: input.result.status, currentRunId: 'run-1' },
      run: {
        id: 'run-1',
        candidateId: 'candidate-1',
        decision: input.result.decision,
        status: input.result.status,
        route: input.result.route,
        riskScore: input.result.riskScore,
      },
    };
  }
}

function verify(cycleId?: string) {
  const repository = new RecordingRepository();
  const service = new BudgetVerificationV1Service(
    new BridgeShapedResolver(),
    repository as unknown as BudgetVerificationRepositoryV1,
  );
  return service
    .verify({
      manifestLocator: '/manifest.json',
      manifestDocumentKey: 'doc-1',
      extractionArtifactLocator: '/artifact.json',
      sourceDocumentId: 'doc-1',
      mode: 'persist_audit',
      ...(cycleId !== undefined ? { cycleId } : {}),
    })
    .then((result) => ({ result, repository }));
}

function manifestSnapshot(input: PersistCompletedVerificationInputV1) {
  const snapshot = input.proofSnapshots.find((proof) => proof.proofKind === 'manifest');
  if (!snapshot) throw new Error('manifest proof snapshot missing');
  return snapshot.evidenceJson;
}

describe('BudgetVerificationV1Service -- candidate cycle identity (Phase 10B-28R)', () => {
  it('persists the requested governed cycle id, keeping the manifest label on the manifest proof snapshot', async () => {
    const { result, repository } = await verify(RAW_CYCLE_ID);
    expect(repository.calls).toHaveLength(1);
    const persisted = repository.calls[0]!;
    expect(persisted.candidateIdentity.cycleId).toBe(RAW_CYCLE_ID);
    expect(persisted.candidateIdentity.manifestContentSha256).toBe(SHA);
    expect(result.cycleId).toBe(RAW_CYCLE_ID);
    expect(result.manifestContentSha256).toBe(SHA);
    const evidence = manifestSnapshot(persisted);
    expect(evidence.cycleId).toBe(MANIFEST_CYCLE_LABEL);
    expect(evidence.candidateCycleId).toBe(RAW_CYCLE_ID);
  });

  it('falls back to the manifest cycleId when the request names none (pre-10B-28R behavior preserved)', async () => {
    const { result, repository } = await verify();
    const persisted = repository.calls[0]!;
    expect(persisted.candidateIdentity.cycleId).toBe(MANIFEST_CYCLE_LABEL);
    expect(result.cycleId).toBe(MANIFEST_CYCLE_LABEL);
    const evidence = manifestSnapshot(persisted);
    expect(evidence.cycleId).toBe(MANIFEST_CYCLE_LABEL);
    expect('candidateCycleId' in evidence).toBe(false);
  });

  it('treats a blank requested cycle id as absent', async () => {
    const { result, repository } = await verify('   ');
    expect(repository.calls[0]!.candidateIdentity.cycleId).toBe(MANIFEST_CYCLE_LABEL);
    expect(result.cycleId).toBe(MANIFEST_CYCLE_LABEL);
  });

  it('does not annotate the snapshot when the requested cycle id equals the manifest cycleId (curated CLI path)', async () => {
    const { result, repository } = await verify(MANIFEST_CYCLE_LABEL);
    expect(repository.calls[0]!.candidateIdentity.cycleId).toBe(MANIFEST_CYCLE_LABEL);
    expect(result.cycleId).toBe(MANIFEST_CYCLE_LABEL);
    expect('candidateCycleId' in manifestSnapshot(repository.calls[0]!)).toBe(false);
  });

  it('never lets the requested cycle id influence proof resolution or the decision; only the identity cycle id differs', async () => {
    const tagged = await verify(RAW_CYCLE_ID);
    const untagged = await verify();
    expect(tagged.result.decision).toBe(untagged.result.decision);
    expect(tagged.result.checks.map((check) => [check.code, check.outcome])).toEqual(
      untagged.result.checks.map((check) => [check.code, check.outcome]),
    );
    const taggedIdentity = tagged.repository.calls[0]!.candidateIdentity;
    const untaggedIdentity = untagged.repository.calls[0]!.candidateIdentity;
    expect(taggedIdentity).toEqual({ ...untaggedIdentity, cycleId: RAW_CYCLE_ID });
    // Distinct governed identity => distinct deterministic candidate/run ids.
    expect(computeCandidateId(taggedIdentity)).not.toBe(computeCandidateId(untaggedIdentity));
    expect(computeRunId(taggedIdentity, '0')).not.toBe(computeRunId(untaggedIdentity, '0'));
  });
});
