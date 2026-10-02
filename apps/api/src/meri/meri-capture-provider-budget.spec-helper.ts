import type { MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';
import type { TenantContext } from '@capiro/shared';
import type { CaptureProviderBudgetQualification } from './meri-capture-provider-budget.js';
import { meriReadonlyCaptureCatalogSha256 } from './meri-server-readonly-capture.js';
export const captureBudgetTestContext: TenantContext = {
  tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
  tenantSlug: 'meri-foundation-20260928-t1',
  userId: '11111111-1111-4111-8111-111111111111',
  clerkUserId: 'clerk-test-synthetic',
  role: 'standard_user',
};
export function captureBudgetTestPolicy(): MeriServerReadonlyCapturePolicy {
  const ctx = captureBudgetTestContext;
  return {
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    traceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    turnId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    caseId: '01',
    captureRunId: 'local-budget-test',
    fixtureVersion: 'v1',
    physicalMapSha256: 'e'.repeat(64),
    resetReceiptId: 'reset',
    seedReceiptId: 'seed',
    fixtureNamespace: 'meri-foundation-20260928',
    tenantId: ctx.tenantId,
    tenantSlug: 'meri-foundation-20260928-t1',
    actorUserId: ctx.userId,
    conversationId: '22222222-2222-4222-8222-222222222222',
    clientId: null,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    toolAuthority: 'shared_static_registry_read_only',
    toolCatalogSha256: meriReadonlyCaptureCatalogSha256(),
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    expectedCaptureWrites: [
      'context_packet_and_evidence',
      'conversation_user_message',
      'conversation_assistant_message',
      'provider_budget_ledger',
    ],
  };
}
export function captureBudgetTestQualification(
  policy = captureBudgetTestPolicy(),
): CaptureProviderBudgetQualification {
  return {
    version: 1,
    caseId: policy.caseId!,
    captureRunId: policy.captureRunId!,
    currentVerifySha256: '1'.repeat(64),
    rateEvidenceSha256: '2'.repeat(64),
    rateEvidenceExpiresAt: new Date(policy.expiresAt + 3_600_000).toISOString(),
    priceKind: 'qualified_text_token_upper_bound',
    maxAttempts: 3,
    maxTokens: 1000,
    maxCostMicros: 1000,
    rates: [
      {
        kind: 'openai_responses',
        provider: 'openai',
        model: 'test-model',
        inputMicrosPerMillion: 1_000_000,
        outputMicrosPerMillion: 2_000_000,
      },
    ],
  };
}
export function captureBudgetTestBinding(attemptId = 'attempt-1') {
  return {
    logicalOperationId: 'operation-1',
    attemptId,
    retryOfAttemptId: null,
    kind: 'openai_responses' as const,
    phase: 'synthesis',
    provider: 'openai',
    model: 'test-model',
    maxInputTokens: 100,
    maxOutputTokens: 100,
  };
}
