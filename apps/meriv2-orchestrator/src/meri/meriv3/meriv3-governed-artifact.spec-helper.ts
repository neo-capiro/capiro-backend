import { randomUUID } from 'node:crypto';
import { MERI_CASE46, type MeriGovernedArtifactCapturePolicy } from '@capiro/meriv2-core';

export function governedArtifactTestPolicy(): MeriGovernedArtifactCapturePolicy {
  return {
    version: 1,
    kind: 'governed_artifact_acceptance_capture',
    caseId: '46',
    fixtureNamespace: MERI_CASE46.namespace,
    tenantId: MERI_CASE46.tenantId,
    tenantSlug: MERI_CASE46.tenantSlug,
    actorUserId: MERI_CASE46.actorUserId,
    clientId: MERI_CASE46.clientId,
    conversationId: randomUUID(),
    captureRunId: randomUUID(),
    policyId: randomUUID(),
    requestId: 'case46-test-request',
    traceId: 'case46-test-trace',
    turnId: randomUUID(),
    source: {
      owner: 'engagement_attachment',
      logicalId: 'ARTIFACT-BRIEF-1',
      physicalId: randomUUID(),
      rowVersion: '42',
      ownershipSha256: 'a'.repeat(64),
      contentSha256: MERI_CASE46.sha256,
      byteLength: 28,
    },
    currentVerifySha256: 'b'.repeat(64),
    qualificationSha256: 'c'.repeat(64),
    issuedAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    allowedTool: 'create_word',
    approval: 'canonical_current_user_required',
    maximumProposals: 1,
    maximumArtifactEffects: 1,
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    expectedWrites: [
      'context_packet_and_evidence',
      'conversation_user_message',
      'conversation_assistant_message',
      'provider_budget_ledger',
      'canonical_action_proposal',
      'approved_text_artifact',
    ],
  };
}
