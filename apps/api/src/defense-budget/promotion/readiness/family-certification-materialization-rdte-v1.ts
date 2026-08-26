import { buildProjectionPlanRecordV1 } from '../../projection-plan/projection-plan-record-v1.js';
import type { ProjectionPlanRepositoryV1 } from '../../projection-plan/projection-plan-repository-prisma-v1.js';
import {
  buildRdteCycleArtifactsFromPersistedArtifacts,
  finalizeRdteCycle,
} from '../../rdte/cycle/rdte-cycle-pipeline-v1.js';
import { rdteCycleVerificationRefV1Schema } from '../../rdte/rdte-cycle-bundle-v1.js';
import type {
  MaterializationArtifactSourcePortV1,
  MaterializationRequestV1,
  MaterializationResultV1,
} from './family-certification-materialization-v1.js';

export async function materializeRdteFamilyCertificationV1(
  request: MaterializationRequestV1,
  ports: {
    artifactSource: MaterializationArtifactSourcePortV1;
    projectionPlans: ProjectionPlanRepositoryV1;
    producerVersion: string;
  },
): Promise<MaterializationResultV1> {
  if (request.identity.familyGroup !== 'rdte') {
    return { outcome: 'missing_durable_input', detail: 'RDT&E materializer requires family group rdte', record: null, replay: false };
  }
  const refs = await ports.artifactSource.loadCandidateRefs({
    cycleId: request.cycleId,
    manifestDocumentKeys: request.manifest.documents.map((document) => document.documentKey),
  });
  for (const document of request.manifest.documents.filter((value) => value.required)) {
    const ref = refs.get(document.documentKey);
    if (ref == null) return { outcome: 'no_candidates_yet', detail: `required document ${document.documentKey} has no terminal verification candidate yet`, record: null, replay: false };
    if (ref.manifestContentSha256 !== request.manifest.manifestContentSha256) {
      return { outcome: 'candidate_incomplete', detail: `required document ${document.documentKey} candidate ${ref.candidateId} belongs to a different manifest`, record: null, replay: false };
    }
    if (ref.decision === 'REJECT' || ref.status === 'REJECTED') return { outcome: 'candidate_rejected', detail: `required document ${document.documentKey} candidate ${ref.candidateId} was REJECTED; refusing to materialize`, record: null, replay: false };
    if (ref.status !== 'VERIFICATION_PASSED' && ref.status !== 'REVIEW_ACCEPTED') return { outcome: 'candidate_incomplete', detail: `required document ${document.documentKey} candidate ${ref.candidateId} status is ${ref.status}, not yet a usable terminal decision`, record: null, replay: false };
  }
  const documents: Array<{ document: (typeof request.manifest.documents)[number]; artifact: Awaited<ReturnType<MaterializationArtifactSourcePortV1['loadVerifiedArtifact']>> }> = [];
  const verifications = [];
  for (const document of request.manifest.documents) {
    const ref = refs.get(document.documentKey);
    if (ref == null || (ref.status !== 'VERIFICATION_PASSED' && ref.status !== 'REVIEW_ACCEPTED')) continue;
    if (ref.policySha256 == null) throw new Error(`candidate ${ref.candidateId} is missing its persisted policy SHA`);
    const artifact = await ports.artifactSource.loadVerifiedArtifact(ref);
    documents.push({ document, artifact });
    verifications.push(rdteCycleVerificationRefV1Schema.parse({
      manifestDocumentKey: ref.manifestDocumentKey,
      manifestContentSha256: ref.manifestContentSha256,
      artifactId: artifact.artifactId,
      artifactContentSha256: artifact.contentSha256,
      artifactByteSha256: ref.extractionArtifactSha256,
      candidateId: ref.candidateId,
      verificationRunId: ref.verificationRunId,
      policySha256: ref.policySha256,
      sourceDocumentId: ref.sourceDocumentId,
      sourcePdfSha256: ref.sourceSha256,
      phase2Decision: ref.decision,
      status: ref.status,
      acceptedAssertionIds: ref.acceptedAssertionIds,
      rejectedAssertionIds: ref.rejectedAssertionIds ?? [],
      verificationCandidateId: ref.candidateId,
      decision: ref.status,
      decisionId: ref.verificationRunId,
    }));
  }
  const result = finalizeRdteCycle({
    governedCycleId: request.cycleId,
    cycleIdIdentity: {
      family: 'rdte',
      fiscalYear: request.identity.fiscalYear,
      manifestContentSha256: request.manifest.manifestContentSha256,
    },
    build: buildRdteCycleArtifactsFromPersistedArtifacts({
      fiscalYear: request.identity.fiscalYear,
      manifestContentSha256: request.manifest.manifestContentSha256,
      manifestDocuments: request.manifest.documents,
      documents,
    }),
    verifications,
  });
  if (result.certification !== 'CERTIFIED_RDTE_READY_FOR_PROJECTION' || result.projectionPlan == null) {
    return { outcome: 'certification_failed', detail: `rdte cycle certification reports ${result.certification}: ${result.reason}`, record: null, replay: false };
  }
  const record = buildProjectionPlanRecordV1({
    family: 'rdte', producerVersion: ports.producerVersion, certificationId: null,
    certificationSha256: result.bundle.contentSha256, planDocument: result.projectionPlan,
  });
  await ports.projectionPlans.insert(record);
  const reloaded = await ports.projectionPlans.loadVerified(record.projectionPlanId);
  if (reloaded == null) throw new Error(`materialized projection plan ${record.projectionPlanId} could not be reloaded immediately after insert`);
  if (reloaded.contentSha256 !== record.contentSha256) throw new Error(`reloaded projection plan ${record.projectionPlanId} content SHA does not match the freshly built record`);
  return { outcome: 'materialized', detail: 'rdte cycle materialized and certified from durable corpus', record: reloaded, replay: false };
}
