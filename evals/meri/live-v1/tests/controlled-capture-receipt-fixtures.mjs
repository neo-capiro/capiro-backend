import {
  completeMeriCaptureEvidenceReceipt,
  observed,
  unknown,
  signMeriCaptureEvidenceReceipt,
} from '../../../../packages/meriv2-core/dist/context/capture-evidence-receipt.js';
export const SECRET = 'controlled-receipt-signing-material-12345';
export const NOW = Date.now();
export function policy() {
  return {
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: 'policy-00000000-0000-4000-8000-000000000001',
    requestId: 'request-00000000-0000-4000-8000-000000000001',
    traceId: 'trace-00000000-0000-4000-8000-000000000001',
    turnId: 'turn-1',
    caseId: '01',
    captureRunId: 'controlled-run',
    fixtureVersion: 'fixture-v1',
    physicalMapSha256: 'a'.repeat(64),
    resetReceiptId: 'reset-1',
    seedReceiptId: 'seed-1',
    fixtureNamespace: 'meri-foundation-20260928',
    tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
    tenantSlug: 'meri-foundation-20260928-t1',
    actorUserId: '11111111-1111-4111-8111-111111111111',
    conversationId: '55555555-5555-4555-8555-555555555555',
    clientId: '22222222-2222-4222-8222-222222222222',
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    toolAuthority: 'shared_static_registry_read_only',
    toolCatalogSha256: 'b'.repeat(64),
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    expectedCaptureWrites: [
      'context_packet_and_evidence',
      'conversation_user_message',
      'conversation_assistant_message',
    ],
  };
}

export function receipt() {
  const p = policy();
  return completeMeriCaptureEvidenceReceipt({
    version: 1,
    kind: 'server_capture_evidence_receipt',
    purpose: 'server_capture_evidence',
    policyId: p.policyId,
    caseId: p.caseId,
    captureRunId: p.captureRunId,
    requestId: p.requestId,
    conversationId: p.conversationId,
    turnId: p.turnId,
    traceId: p.traceId,
    tenantId: p.tenantId,
    actorUserId: p.actorUserId,
    clientId: p.clientId,
    startedAt: NOW - 500,
    completedAt: NOW,
    expiresAt: p.expiresAt,
    sources: [
      {
        sourceId: 'document:canonical-1',
        toolCallId: 'call-1',
        tenantId: observed(p.tenantId),
        clientId: observed(p.clientId),
        currentVersion: observed('version-7'),
        fullRead: observed(true),
        locator: observed('section:termination'),
        passageSha256: observed('c'.repeat(64)),
        byteSha256: unknown('full_bytes_not_returned'),
      },
    ],
    toolCalls: [
      {
        callId: 'call-1',
        name: 'search_client_documents',
        attempt: 1,
        status: 'complete',
        readOnly: true,
        sourceIds: ['document:canonical-1'],
      },
    ],
    usage: {
      provider: observed('openai'),
      model: observed('gpt-5.2'),
      inputTokens: observed(120),
      outputTokens: observed(30),
      cacheReadTokens: unknown('not_reported'),
      cacheCreationTokens: unknown('not_reported'),
      estimatedCostUsd: observed(0.003),
      costKind: 'existing_pricing_estimate',
    },
    releases: {
      api: {
        service: 'api',
        releaseRevision: observed('d'.repeat(40)),
        identityContract: 'runtime_environment_v1',
        deploymentProof: 'PENDING_APPROVED_BUILD_RECEIPT_CROSSCHECK',
      },
      orchestrator: {
        service: 'meriv2-orchestrator',
        releaseRevision: observed('e'.repeat(40)),
        identityContract: 'runtime_environment_v1',
        deploymentProof: 'PENDING_APPROVED_BUILD_RECEIPT_CROSSCHECK',
      },
    },
    fixture: {
      namespace: p.fixtureNamespace,
      version: observed(p.fixtureVersion),
      physicalMapSha256: observed(p.physicalMapSha256),
      resetReceiptId: observed(p.resetReceiptId),
      seedReceiptId: observed(p.seedReceiptId),
    },
    effects: {
      boundary: 'bounded_capture_path_hooks',
      writes: [
        {
          logicalWriteId: 'write-user',
          kind: 'conversation_user_message',
          phase: 'during',
          status: 'observed',
          recordId: 'turn-1',
        },
      ],
      logicalEffects: [],
    },
    predecessorAttestationSha256: null,
  });
}

export const signed = (value = receipt()) => signMeriCaptureEvidenceReceipt(value, SECRET);
export const context = () => ({ trustedPolicy: policy(), serviceSecret: SECRET, now: NOW });
