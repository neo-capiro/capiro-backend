import { randomUUID } from 'node:crypto';
import { MERI_CASE46, type MeriGovernedArtifactCapturePolicy } from '@capiro/meriv2-core';
import {
  case46BudgetHash,
  type Case46ProviderBudgetQualification,
} from './meri-case46-provider-budget.js';

export function case46BudgetTestFixture() {
  const now = Date.now();
  const captureRunId = randomUUID();
  const q: Case46ProviderBudgetQualification = {
    version: 1,
    caseId: '46',
    captureRunId,
    currentVerifySha256: 'b'.repeat(64),
    rateEvidenceSha256: 'c'.repeat(64),
    rateEvidenceExpiresAt: new Date(now + 3_600_000).toISOString(),
    priceKind: 'qualified_text_token_upper_bound',
    maxAttempts: 3,
    maxTokens: 1000,
    maxCostMicros: 1000,
    rates: [
      {
        kind: 'openai_responses',
        provider: 'openai',
        model: 'test-only-model',
        inputMicrosPerMillion: 1_000_000,
        outputMicrosPerMillion: 2_000_000,
      },
    ],
  };
  const p: MeriGovernedArtifactCapturePolicy = {
    version: 1,
    kind: 'governed_artifact_acceptance_capture',
    caseId: '46',
    fixtureNamespace: MERI_CASE46.namespace,
    tenantId: MERI_CASE46.tenantId,
    tenantSlug: MERI_CASE46.tenantSlug,
    actorUserId: MERI_CASE46.actorUserId,
    clientId: MERI_CASE46.clientId,
    conversationId: randomUUID(),
    captureRunId,
    policyId: randomUUID(),
    requestId: 'request-46',
    traceId: 'trace-46',
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
    currentVerifySha256: q.currentVerifySha256,
    qualificationSha256: case46BudgetHash(q),
    issuedAt: now,
    expiresAt: now + 600_000,
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
  const b = {
    logicalOperationId: 'operation-1',
    attemptId: 'attempt-1',
    retryOfAttemptId: null,
    kind: 'openai_responses' as const,
    phase: 'synthesis',
    provider: 'openai',
    model: 'test-only-model',
    maxInputTokens: 100,
    maxOutputTokens: 100,
  };
  return { p, q, b };
}
