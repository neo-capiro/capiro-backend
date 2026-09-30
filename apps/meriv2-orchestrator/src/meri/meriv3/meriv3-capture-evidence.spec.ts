import {
  verifyMeriCaptureEvidenceReceipt,
  meriTelemetryUsage,
  type MeriServerReadonlyCapturePolicy,
} from '@capiro/meriv2-core';
import type { MeriCitation } from '@capiro/shared';
import {
  buildSignedOrchestratorCaptureEvidence,
  observeMeriV3CaptureExecution,
} from './meriv3-capture-evidence.js';

const SECRET = 'orchestrator-capture-test-secret';
const NOW = 1_800_000_000_000;

function policy(): MeriServerReadonlyCapturePolicy {
  return {
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: 'policy-1',
    requestId: 'request-1',
    traceId: 'trace-1',
    turnId: 'message-user',
    caseId: '01',
    captureRunId: 'run-1',
    fixtureVersion: 'fixture-v1',
    physicalMapSha256: 'a'.repeat(64),
    resetReceiptId: 'reset-1',
    seedReceiptId: 'seed-1',
    fixtureNamespace: 'meri-foundation-20260928',
    tenantId: 'tenant-1',
    tenantSlug: 'meri-foundation-20260928-t1',
    actorUserId: 'actor-1',
    conversationId: 'conversation-1',
    clientId: 'client-1',
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

describe('Meri V3 capture evidence adapters', () => {
  it('binds actual tool-call/source/usage observations without inventing missing owner fields', () => {
    const execution = observeMeriV3CaptureExecution({
      callId: 'call-actual-1',
      tool: 'search_client_documents',
      readOnly: true,
      result: { records: [{ id: 'document-1' }] },
      citations: [
        {
          n: 1,
          id: 'document-1',
          title: 'Canonical document',
          type: 'document',
          url: null,
          tool: 'search_client_documents',
          snippet: 'Observed bytes from the document.',
          source: {
            kind: 'document',
            recordId: 'document-1',
            version: 'version-3',
            section: 'termination',
            clientId: 'client-1',
          },
          documentEvidence: {
            documentId: 'document-1',
            clientId: 'client-1',
            contentHash: 'c'.repeat(64),
            record: {},
            coverage: {},
            observedAt: null,
          },
        } satisfies MeriCitation,
      ],
      coverage: [
        {
          tool: 'search_client_documents',
          status: 'complete',
          paginationComplete: true,
          truncated: false,
        } as never,
      ],
    });

    expect(execution.toolCalls).toEqual([
      expect.objectContaining({
        callId: 'call-actual-1',
        status: 'complete',
        sourceIds: ['document-1'],
      }),
    ]);
    expect(execution.sources[0]).toMatchObject({
      sourceId: 'document-1',
      toolCallId: 'call-actual-1',
      currentVersion: { status: 'OBSERVED', value: 'version-3' },
      fullRead: { status: 'OBSERVED', value: true },
      locator: { status: 'OBSERVED', value: 'termination' },
      byteSha256: { status: 'OBSERVED', value: 'c'.repeat(64) },
      tenantId: { status: 'UNKNOWN', value: null },
    });

    const signed = buildSignedOrchestratorCaptureEvidence({
      policy: policy(),
      startedAt: NOW - 500,
      completedAt: NOW,
      providerCallObserved: true,
      provider: 'openai',
      model: 'gpt-5.2',
      usage: meriTelemetryUsage({ inputTokens: 12, outputTokens: 4, knownEstimatedCostUsd: 0.001 }),
      execution: {
        ...execution,
        estimatedCostUsd: { status: 'OBSERVED', value: 0.001, reason: null },
      },
      secret: SECRET,
    });
    const verified = verifyMeriCaptureEvidenceReceipt(signed, policy(), SECRET, NOW);

    expect(verified.status).toBe('BLOCKED');
    expect(verified.usage).toMatchObject({
      provider: { status: 'OBSERVED', value: 'openai' },
      model: { status: 'OBSERVED', value: 'gpt-5.2' },
      inputTokens: { status: 'OBSERVED', value: 12 },
      outputTokens: { status: 'OBSERVED', value: 4 },
    });
    expect(verified.blockers).toContain('source_tenant_authority_unproved:document-1');
  });
});

describe('capture usage observation boundary', () => {
  it.each([
    ['missing', meriTelemetryUsage()],
    [
      'incomplete attempt',
      meriTelemetryUsage({
        inputTokens: 12,
        outputTokens: 4,
        knownEstimatedCostUsd: 0.001,
        unknownAttempts: 1,
      }),
    ],
  ])('keeps %s usage unknown even when legacy counters and subtotal exist', (_name, usage) => {
    const signed = buildSignedOrchestratorCaptureEvidence({
      policy: policy(),
      startedAt: NOW - 500,
      completedAt: NOW,
      providerCallObserved: true,
      provider: 'openai',
      model: 'gpt-5.2',
      usage,
      execution: {
        toolCalls: [],
        sources: [],
        estimatedCostUsd: { status: 'OBSERVED', value: 0, reason: null },
      },
      secret: SECRET,
    });
    const receipt = verifyMeriCaptureEvidenceReceipt(signed, policy(), SECRET, NOW);
    expect(receipt.usage.inputTokens.status).toBe('UNKNOWN');
    expect(receipt.usage.outputTokens.status).toBe('UNKNOWN');
    expect(receipt.usage.estimatedCostUsd.status).toBe('UNKNOWN');
    expect(receipt.usage.cacheReadTokens.status).toBe('UNKNOWN');
    expect(receipt.usage.costKind).toBe('unknown');
  });
});
