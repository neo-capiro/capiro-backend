import {
  completeMeriCaptureEvidenceReceipt,
  meriCaptureEvidenceEnvelopeSha256,
  observed,
  signMeriCaptureEvidenceReceipt,
  unknown,
  verifyMeriCaptureEvidenceReceipt,
  type MeriCaptureEvidenceReceipt,
} from './capture-evidence-receipt';
import type { MeriServerReadonlyCapturePolicy } from './server-readonly-capture';

const SECRET = 'capture-evidence-test-secret-that-is-long-enough';
const NOW = 1_800_000_000_000;

function policy(): MeriServerReadonlyCapturePolicy {
  return {
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: 'policy-00000000-0000-4000-8000-000000000001',
    requestId: 'request-00000000-0000-4000-8000-000000000001',
    traceId: 'trace-00000000-0000-4000-8000-000000000001',
    turnId: 'turn-1',
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

function receipt(): MeriCaptureEvidenceReceipt {
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
    providerBudget: {
      version: 1,
      boundary: 'case01_memory_turn',
      status: 'SETTLED',
      admissionId: 'unit-admission',
      turnId: p.turnId!,
      ledgerSha256: 'f'.repeat(64),
      qualificationSha256: '1'.repeat(64),
      attempts: 1,
      chargedTokens: 150,
      chargedCostMicros: 3000,
      maxCostMicros: 1_000_000,
      unaccountedBoundaries: [],
    },
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
      version: observed(p.fixtureVersion!),
      physicalMapSha256: observed(p.physicalMapSha256!),
      resetReceiptId: observed(p.resetReceiptId!),
      seedReceiptId: observed(p.seedReceiptId!),
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

describe('trusted server capture evidence receipt', () => {
  it('signs and verifies the exact capture tuple without treating the signature as deployment proof', () => {
    const signed = signMeriCaptureEvidenceReceipt(receipt(), SECRET);
    const verified = verifyMeriCaptureEvidenceReceipt(signed, policy(), SECRET, NOW);

    expect(verified.status).toBe('COMPLETE');
    expect(verified.toolCalls[0]).toMatchObject({
      callId: 'call-1',
      sourceIds: ['document:canonical-1'],
    });
    expect(verified.releases.api.deploymentProof).toBe('PENDING_APPROVED_BUILD_RECEIPT_CROSSCHECK');
  });

  it.each([
    [
      'purpose',
      (signed: ReturnType<typeof signMeriCaptureEvidenceReceipt>) => ({
        ...signed,
        purpose: 'wrong',
      }),
    ],
    [
      'payload',
      (signed: ReturnType<typeof signMeriCaptureEvidenceReceipt>) => ({
        ...signed,
        receipt: { ...signed.receipt, traceId: 'tampered' },
      }),
    ],
  ])('rejects %s tampering', (_name, mutate) => {
    const signed = signMeriCaptureEvidenceReceipt(receipt(), SECRET);
    expect(() =>
      verifyMeriCaptureEvidenceReceipt(mutate(signed) as never, policy(), SECRET, NOW),
    ).toThrow();
  });

  it('rejects expired evidence', () => {
    const signed = signMeriCaptureEvidenceReceipt(receipt(), SECRET);
    expect(() =>
      verifyMeriCaptureEvidenceReceipt(signed, policy(), SECRET, policy().expiresAt + 1),
    ).toThrow('meri_capture_evidence_authentication_failed');
  });

  it('cannot complete missing, uncertain, over-budget or unaccounted provider evidence', () => {
    const base = receipt();
    expect(
      completeMeriCaptureEvidenceReceipt({ ...base, providerBudget: undefined }).blockers,
    ).toContain('provider_budget_not_run');
    expect(
      completeMeriCaptureEvidenceReceipt({
        ...base,
        providerBudget: { ...base.providerBudget!, status: 'UNSETTLED' },
      }).blockers,
    ).toContain('provider_budget_usage_unsettled');
    expect(
      completeMeriCaptureEvidenceReceipt({
        ...base,
        providerBudget: { ...base.providerBudget!, chargedCostMicros: 1_000_001 },
      }).blockers,
    ).toContain('provider_budget_malformed');
    expect(
      completeMeriCaptureEvidenceReceipt({
        ...base,
        providerBudget: {
          ...base.providerBudget!,
          unaccountedBoundaries: ['unknown_api_provider'],
        },
      }).blockers,
    ).toContain('provider_budget_api_ingress_unaccounted');
  });

  it('rejects a current-authority tuple mismatch', () => {
    const signed = signMeriCaptureEvidenceReceipt(receipt(), SECRET);
    expect(() =>
      verifyMeriCaptureEvidenceReceipt(
        signed,
        { ...policy(), clientId: 'other-client' },
        SECRET,
        NOW,
      ),
    ).toThrow('meri_capture_evidence_authentication_failed');
  });

  it('blocks, rather than passing, an extra unobserved write', () => {
    const base = receipt();
    const blocked = completeMeriCaptureEvidenceReceipt({
      ...base,
      effects: {
        ...base.effects,
        writes: [
          ...base.effects.writes,
          {
            logicalWriteId: 'write-extra',
            kind: 'unexpected_write',
            phase: 'during',
            status: 'unexpected',
            recordId: 'extra-1',
          },
        ],
      },
    });

    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.blockers).toContain('unexpected_write_observed');
  });

  it('keeps unavailable source authority explicit instead of inventing a locator or version', () => {
    const base = receipt();
    const source = base.sources[0]!;
    const blocked = completeMeriCaptureEvidenceReceipt({
      ...base,
      sources: [
        {
          ...source,
          currentVersion: unknown('owner_binding_pending'),
          locator: unknown('owner_binding_pending'),
          passageSha256: unknown('passage_bytes_not_observed'),
          byteSha256: unknown('source_bytes_not_observed'),
        },
      ],
    });

    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.sources[0]!.locator.value).toBeNull();
    expect(blocked.blockers).toEqual(
      expect.arrayContaining([
        'source_version_unproved:document:canonical-1',
        'source_location_or_hash_unproved:document:canonical-1',
      ]),
    );
  });
});

describe('JSONB-compatible capture authentication', () => {
  function reorder(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reorder);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, item]) => [key, reorder(item)]),
      );
    return value;
  }
  it('preserves signature and predecessor identity when persisted JSON object keys reorder', () => {
    const signed = signMeriCaptureEvidenceReceipt(receipt(), SECRET);
    const restored = reorder(signed) as typeof signed;
    expect(JSON.stringify(restored)).not.toBe(JSON.stringify(signed));
    expect(verifyMeriCaptureEvidenceReceipt(restored, policy(), SECRET, NOW)).toEqual(
      signed.receipt,
    );
    expect(meriCaptureEvidenceEnvelopeSha256(restored)).toBe(
      meriCaptureEvidenceEnvelopeSha256(signed),
    );
    restored.receipt.usage.inputTokens.value = 121;
    expect(() => verifyMeriCaptureEvidenceReceipt(restored, policy(), SECRET, NOW)).toThrow(
      'meri_capture_evidence_authentication_failed',
    );
  });
});
