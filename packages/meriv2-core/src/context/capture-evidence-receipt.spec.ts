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

function clockReceipt(): MeriCaptureEvidenceReceipt {
  const value = receipt();
  value.captureRunId = '11111111-1111-4111-8111-111111111111';
  const clockUse = {
    instant: '2026-09-26T16:00:00.000Z' as const,
    timeZone: 'America/New_York' as const,
    eligibilityAt: new Date(NOW - 100).toISOString(),
    scoring: 'used' as const,
  };
  const packet = (n: string) => ({
    packetId: `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`,
    persisted: true as const,
    clockUse: { ...clockUse },
  });
  value.sources = [];
  value.toolCalls = [
    {
      callId: 'memory-call',
      name: 'search_memory',
      attempt: 1,
      status: 'partial',
      readOnly: true,
      sourceIds: [],
    },
  ];
  value.semanticClock = {
    binding: {
      version: 1,
      kind: 'qualified_original_fixture_semantic_clock',
      instant: clockUse.instant,
      timeZone: clockUse.timeZone,
      caseId: '01',
      captureRunId: '11111111-1111-4111-8111-111111111111',
      currentVerifySha256: 'a'.repeat(64),
      observedAt: NOW - 1000,
    },
    prompt: observed({
      instant: clockUse.instant,
      timeZone: clockUse.timeZone,
      date: '2026-09-26',
      renderedAt: NOW - 200,
      groundingSha256: 'b'.repeat(64),
    }),
    invocations: [
      {
        callId: 'memory-call',
        tool: 'search_memory',
        outcome: 'returned',
        httpAttempts: 1,
        httpStatus: 200,
        responseSha256: 'c'.repeat(64),
        packets: [packet('2'), packet('3')],
      },
    ],
    apiJoin: 'VERIFIED',
    api: {
      initial: packet('1'),
      tools: [packet('2'), packet('3')],
      relativeToolWindows: 'NOT_APPLICABLE',
    },
  };
  return value;
}

describe('independent semantic-clock receipt join', () => {
  function case20Receipt() {
    const r = clockReceipt();
    r.caseId = '20';
    r.providerBudget!.boundary = 'case20_controlled_read_turn';
    r.semanticClock!.binding.caseId = '20';
    r.semanticClock!.api!.tools = [];
    const call = r.toolCalls[0]!;
    call.name = 'get_pe_budget_timeline';
    call.status = 'complete';
    call.sourceIds = ['2d0c016e-8dad-5f6e-80dd-e36740fff7ee'];
    const invocation = r.semanticClock!.invocations![0]!;
    invocation.tool = call.name;
    invocation.packets = [];
    r.sources = [
      {
        sourceId: call.sourceIds[0]!,
        toolCallId: call.callId,
        tenantId: observed(r.tenantId),
        clientId: observed(null),
        currentVersion: observed('v1'),
        fullRead: observed(true),
        locator: observed('page 14'),
        passageSha256: observed('d'.repeat(64)),
        byteSha256: observed('d'.repeat(64)),
      },
    ];
    r.controlledReadAttempts = [
      {
        callId: call.callId,
        tool: call.name,
        httpStatus: 200,
        logicalError: null,
        caseId: '20',
        requestId: r.requestId,
        traceId: r.traceId,
        turnId: r.turnId!,
        captureRunId: r.captureRunId!,
        responseSha256: invocation.responseSha256!,
        sourceId: call.sourceIds[0]!,
        logicalSourceId: 'R2-27',
        sourceVersion: 'v1',
        currentVerifySha256: r.semanticClock!.binding.currentVerifySha256,
        contentSha256: 'd'.repeat(64),
        sourceTenantId: r.tenantId,
        sourceClientId: null,
        fullRead: true,
        passageSha256: 'd'.repeat(64),
      },
    ];
    return r;
  }
  it('Case20 accepts the current-tenant public full source only through its matching controlled HTTP proof', () => {
    const r = case20Receipt();
    expect(completeMeriCaptureEvidenceReceipt(r).status).toBe('COMPLETE');
    expect(r.semanticClock!.invocations![0]!.packets).toEqual([]);
    expect(r.semanticClock!.api!.tools).toEqual([]);
    // Retain the exact observed public scope, never relabel it as client-owned.
    expect(r.sources[0]!.clientId).toEqual(observed(null));
  });
  it.each([
    'case',
    'tenant',
    'client',
    'source-client',
    'missing-attempt',
    'duplicate-attempt',
    'call',
    'tool',
    'request',
    'trace',
    'turn',
    'run',
    'http',
    'error',
    'version',
    'source',
    'logical-source',
    'source-read',
    'full-read',
    'passage',
    'content',
    'response',
    'verify',
    'invocation',
    'partial',
    'missing-clock',
  ])('Case20 public-source proof rejects %s drift', (fault) => {
    const r = case20Receipt();
    const a = r.controlledReadAttempts![0]!;
    const s = r.sources[0]!;
    if (fault === 'case') r.caseId = '01';
    if (fault === 'tenant') a.sourceTenantId = 'other-tenant';
    if (fault === 'client') a.sourceClientId = 'other-client';
    if (fault === 'source-client') s.clientId = observed('other-client');
    if (fault === 'missing-attempt') r.controlledReadAttempts = [];
    if (fault === 'duplicate-attempt') r.controlledReadAttempts!.push({ ...a });
    if (fault === 'call') a.callId = 'other-call';
    if (fault === 'tool') a.tool = 'search_memory';
    if (fault === 'request') a.requestId = 'other-request';
    if (fault === 'trace') a.traceId = 'other-trace';
    if (fault === 'turn') a.turnId = 'other-turn';
    if (fault === 'run') a.captureRunId = 'other-run';
    if (fault === 'http') a.httpStatus = 500;
    if (fault === 'error') a.logicalError = 'unavailable';
    if (fault === 'version') a.sourceVersion = 'v2';
    if (fault === 'source') a.sourceId = 'other-source';
    if (fault === 'logical-source') a.logicalSourceId = 'HOUSE27';
    if (fault === 'source-read') s.fullRead = observed(false);
    if (fault === 'full-read') a.fullRead = false;
    if (fault === 'passage') a.passageSha256 = 'e'.repeat(64);
    if (fault === 'content') a.contentSha256 = 'e'.repeat(64);
    if (fault === 'response') a.responseSha256 = 'e'.repeat(64);
    if (fault === 'verify') a.currentVerifySha256 = 'e'.repeat(64);
    if (fault === 'invocation') r.semanticClock!.invocations = [];
    if (fault === 'partial') r.toolCalls[0]!.status = 'partial';
    if (fault === 'missing-clock') delete r.semanticClock;
    expect(completeMeriCaptureEvidenceReceipt(r).blockers).toContain(
      `source_client_authority_unproved:${s.sourceId}`,
    );
  });
  it('Case20 preserves the prompt-time bound and the independent API join requirement', () => {
    const r = case20Receipt();
    r.startedAt = r.semanticClock!.prompt.value!.renderedAt + 296;
    r.semanticClock!.apiJoin = 'PENDING';
    delete r.semanticClock!.api;
    expect(completeMeriCaptureEvidenceReceipt(r).blockers).toEqual(
      expect.arrayContaining([
        'semantic_clock_prompt_unproved',
        'semantic_clock_api_tool_join_pending',
      ]),
    );
  });
  function proposalReceipt() {
    const r = clockReceipt();
    r.toolCalls.push({
      callId: 'proposal-call',
      name: 'list_memory_proposals',
      attempt: 1,
      status: 'complete',
      readOnly: true,
      sourceIds: [],
    });
    r.semanticClock!.invocations!.push(
      Object.assign(
        {
          callId: 'proposal-call',
          tool: 'list_memory_proposals',
          outcome: 'returned' as const,
          httpAttempts: 1,
          httpStatus: 200,
          responseSha256: 'd'.repeat(64),
          packets: [],
        },
        {
          proposalRead: {
            authority: 'own_pending_proposals' as const,
            tenantId: r.tenantId,
            actorUserId: r.actorUserId,
            clientId: r.clientId!,
            semanticTime: 'not_used' as const,
            compiler: 'not_run' as const,
            claimsAreApprovedFacts: false as const,
            coverage: 'complete' as const,
          },
        },
      ),
    );
    return r;
  }
  it.each(['01', '14'])(
    'joins actual own-proposal HTTP proof without inventing a compiler consumer for case%s',
    (caseId) => {
      const r = proposalReceipt();
      r.caseId = caseId;
      r.semanticClock!.binding.caseId = caseId as '01' | '14';
      r.providerBudget!.boundary = caseId === '01' ? 'case01_memory_turn' : 'case14_memory_turn';
      expect(completeMeriCaptureEvidenceReceipt(r).status).toBe('COMPLETE');
    },
  );
  it.each([
    'proof',
    'tenant',
    'actor',
    'client',
    'compiler',
    'time',
    'approved',
    'coverage',
    'packet',
    'source',
    'citation',
    'controlled',
    'other-tool-proof',
    'failed',
    'http',
    'response',
    'case',
  ])('keeps proposal %s unproved', (fault) => {
    const r = proposalReceipt(),
      a: any = r.semanticClock!.invocations!.at(-1)!;
    if (fault === 'proof') delete a.proposalRead;
    if (fault === 'tenant') a.proposalRead.tenantId = 'other';
    if (fault === 'actor') a.proposalRead.actorUserId = 'other';
    if (fault === 'client') a.proposalRead.clientId = null;
    if (fault === 'compiler') a.proposalRead.compiler = 'used';
    if (fault === 'time') a.proposalRead.semanticTime = 'used';
    if (fault === 'approved') a.proposalRead.claimsAreApprovedFacts = true;
    if (fault === 'coverage') {
      a.proposalRead.coverage = 'partial';
      r.toolCalls.at(-1)!.status = 'partial';
    }
    if (fault === 'packet') a.packets = r.semanticClock!.api!.tools;
    if (fault === 'source') r.toolCalls.at(-1)!.sourceIds = ['proposal'];
    if (fault === 'citation')
      r.sources = [{ ...receipt().sources[0]!, toolCallId: 'proposal-call' }];
    if (fault === 'controlled') r.controlledReadAttempts = [{ callId: 'proposal-call' } as never];
    if (fault === 'other-tool-proof') {
      Object.assign(r.semanticClock!.invocations![0]!, { proposalRead: a.proposalRead });
    }
    if (fault === 'failed') a.outcome = 'threw';
    if (fault === 'http') a.httpStatus = 500;
    if (fault === 'response') a.responseSha256 = null;
    if (fault === 'case') {
      r.caseId = '20';
      r.semanticClock!.binding.caseId = '20';
    }
    expect(
      completeMeriCaptureEvidenceReceipt(r).blockers.some((x) => x.startsWith('semantic_clock_')),
    ).toBe(true);
  });
  it('accepts both actual fallback packets and a separate initial compiler observation', () => {
    expect(completeMeriCaptureEvidenceReceipt(clockReceipt()).status).toBe('COMPLETE');
  });
  it.each([
    [
      'unobserved HTTP census',
      (r: any) => {
        delete r.semanticClock.invocations;
      },
    ],
    ['duplicate logical call', (r: any) => r.toolCalls.push(r.toolCalls[0])],
    [
      'duplicate invocation',
      (r: any) => r.semanticClock.invocations.push(r.semanticClock.invocations[0]),
    ],
    ['malformed invocation', (r: any) => r.semanticClock.invocations.push(null)],
    [
      'missing invocation',
      (r: any) => {
        r.semanticClock.invocations = [];
      },
    ],
    [
      'extra invocation',
      (r: any) => {
        r.semanticClock.invocations[0].callId = 'other';
      },
    ],
    [
      'unresolved invocation',
      (r: any) => {
        r.semanticClock.invocations[0].outcome = 'pending';
      },
    ],
    [
      'failed HTTP',
      (r: any) => {
        r.semanticClock.invocations[0].httpStatus = 503;
      },
    ],
    [
      'failed logical read',
      (r: any) => {
        r.toolCalls[0].status = 'failed';
      },
    ],
    [
      'second HTTP attempt',
      (r: any) => {
        r.semanticClock.invocations[0].httpAttempts = 2;
      },
    ],
    ['missing fallback packet', (r: any) => r.semanticClock.api.tools.pop()],
    [
      'duplicate packet',
      (r: any) => {
        r.semanticClock.invocations[0].packets[1] = r.semanticClock.invocations[0].packets[0];
      },
    ],
    [
      'initial reused as tool',
      (r: any) => {
        r.semanticClock.api.initial = r.semanticClock.api.tools[0];
      },
    ],
    [
      'stored clock mismatch',
      (r: any) => {
        r.semanticClock.api.tools[0].clockUse.eligibilityAt = new Date(NOW - 99).toISOString();
      },
    ],
    [
      'prompt clock mismatch',
      (r: any) => {
        r.semanticClock.prompt.value.instant = new Date(NOW).toISOString();
      },
    ],
    [
      'unadmitted time tool',
      (r: any) => {
        r.toolCalls[0].name = r.semanticClock.invocations[0].tool = 'query_tasks';
      },
    ],
    [
      'name-only local discovery',
      (r: any) => {
        r.toolCalls.push({
          callId: 'local',
          name: 'tool_search',
          readOnly: true,
          attempt: 1,
          status: 'complete',
        });
      },
    ],
  ])('keeps %s BLOCKED', (_name, mutate) => {
    const r = clockReceipt();
    mutate(r);
    expect(
      completeMeriCaptureEvidenceReceipt(r).blockers.some((x) => x.startsWith('semantic_clock_')),
    ).toBe(true);
  });
  it('permits N/A tool windows only after a complete empty invocation census and actual local discovery', () => {
    const r = clockReceipt();
    r.toolCalls = [
      {
        callId: 'local',
        name: 'tool_search',
        readOnly: true,
        attempt: 1,
        status: 'complete',
        sourceIds: [],
        localDiscovery: true,
      },
    ];
    r.semanticClock!.invocations = [];
    r.semanticClock!.api!.tools = [];
    expect(completeMeriCaptureEvidenceReceipt(r).status).toBe('COMPLETE');
  });
  it.each(['20', '72'])(
    'joins the actual controlled response for case %s without inventing compiler use',
    (caseId) => {
      const r = clockReceipt();
      r.caseId = caseId;
      r.semanticClock!.binding.caseId = caseId as '20' | '72';
      r.providerBudget!.boundary =
        caseId === '20' ? 'case20_controlled_read_turn' : 'case72_controlled_read_turn';
      r.toolCalls[0]!.name = caseId === '20' ? 'get_pe_budget_timeline' : 'read_client_documents';
      r.toolCalls[0]!.status = caseId === '72' ? 'failed' : 'complete';
      const attempt = r.semanticClock!.invocations![0]!;
      attempt.tool = r.toolCalls[0]!.name;
      attempt.outcome = caseId === '72' ? 'threw' : 'returned';
      attempt.packets = [];
      r.semanticClock!.api!.tools = [];
      r.controlledReadAttempts = [
        {
          callId: attempt.callId,
          tool: attempt.tool,
          httpStatus: 200,
          logicalError: caseId === '72' ? 'document unavailable' : null,
          caseId,
          requestId: r.requestId,
          traceId: r.traceId,
          turnId: r.turnId!,
          captureRunId: r.captureRunId!,
          responseSha256: attempt.responseSha256!,
          sourceId: 'source',
          logicalSourceId: 'fixture',
          sourceVersion: 'v1',
          currentVerifySha256: 'a'.repeat(64),
          contentSha256: 'd'.repeat(64),
          sourceTenantId: r.tenantId,
          sourceClientId: caseId === '20' ? null : r.clientId,
          fullRead: caseId === '20',
          passageSha256: null,
        },
      ];
      expect(completeMeriCaptureEvidenceReceipt(r).status).toBe('COMPLETE');
      if (caseId === '72') {
        r.toolCalls[0]!.status = 'invalid_not_executed';
        expect(completeMeriCaptureEvidenceReceipt(r).status).toBe('BLOCKED');
        r.toolCalls[0]!.status = 'failed';
      }
      r.controlledReadAttempts[0]!.responseSha256 = 'e'.repeat(64);
      expect(completeMeriCaptureEvidenceReceipt(r).status).toBe('BLOCKED');
    },
  );
});

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
  it('accepts the already qualified fifteen-dollar ceiling without accepting overspend or higher limits', () => {
    const base = receipt();
    const make = (maxCostMicros: number, chargedCostMicros = 2_292_602) =>
      completeMeriCaptureEvidenceReceipt({
        ...base,
        providerBudget: { ...base.providerBudget!, maxCostMicros, chargedCostMicros },
      });
    expect(make(15_000_000).blockers).not.toContain('provider_budget_malformed');
    expect(make(15_000_001).blockers).toContain('provider_budget_malformed');
    expect(make(15_000_000, 15_000_001).blockers).toContain('provider_budget_malformed');
    expect(make(3_000_000, 3_000_001).blockers).toContain('provider_budget_malformed');
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
