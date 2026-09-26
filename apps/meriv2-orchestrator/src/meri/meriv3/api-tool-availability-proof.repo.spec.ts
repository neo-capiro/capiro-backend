import { fingerprintMeriFinalToolSchemas } from '@capiro/meriv2-core';
import type { ConfigService } from '@nestjs/config';
import {
  ApiToolAvailabilityProofRepo,
  assertToolAvailabilityProofMatches,
  isToolAvailabilityProofShadowEnabled,
  type ToolAvailabilityProofRequest,
  type ToolAvailabilityProofResponse,
} from './api-tool-availability-proof.repo.js';

const request: ToolAvailabilityProofRequest = {
  conversationId: '30000000-0000-4000-8000-000000000003',
  turnNonce: '60000000-0000-4000-8000-000000000006',
  surface: 'research',
  finalSchemaVersion: 'meriv3.final-offered-schema.v1',
  finalOfferedTools: [{ type: 'function', name: 'get_client_context', description: 'context', parameters: { type: 'object' }, strict: false }],
};
const response: ToolAvailabilityProofResponse = {
  version: 'meri.tool-availability-proof.v3',
  catalogSha256: 'a4e1eeb283348dc9f430424695f86d36fcd642283f6a2af2bccdf8aa1d49b2dd',
  semantics: 'permission_only',
  eligibility: 'unresolved',
  runtimeAvailability: 'unresolved',
  unresolvedChecks: ['runtime-availability'],
  conversationId: request.conversationId,
  scope: {
    tenantId: '10000000-0000-4000-8000-000000000001',
    userId: '20000000-0000-4000-8000-000000000002',
    conversationId: request.conversationId,
    clientId: '40000000-0000-4000-8000-000000000004',
    surface: request.surface,
    source: 'authenticated_context_and_persisted_conversation',
  },
  turnBinding: {
    nonce: request.turnNonce,
    nonceProvenance: 'authenticated_internal_service_assertion',
    surface: request.surface,
    surfaceProvenance: 'authenticated_internal_service_assertion',
    finalSchemaVersion: request.finalSchemaVersion,
    finalSchemaFingerprint: fingerprintMeriFinalToolSchemas(request.finalOfferedTools, request.finalSchemaVersion),
    schemaFingerprintProvenance: 'api_recomputed_from_exact_provider_schemas',
    checkTime: new Date().toISOString(),
    integrity: 'api_recomputed_schema_fingerprint',
  },
  clientScope: 'present',
  offeredDiagnostic: {
    version: 'meri.offered-tool-diagnostic.v2',
    catalogSha256: 'f47b85b2cf1386eb430fc42b544bfe8e932655542dfdd54940fbb3b58863fcbf',
    tools: [{ tool: 'get_client_context', permissionStatus: 'eligible', permissionReason: 'authorized', runtimeAvailability: 'unresolved', eligibility: 'unresolved', executable: false }],
  },
  tools: [
    { tool: 'get_client_context', status: 'eligible', reason: 'authorized', executable: false },
    { tool: 'search_client_knowledge', status: 'unknown', reason: 'not_offered', executable: false },
    { tool: 'get_representation', status: 'unknown', reason: 'not_offered', executable: false },
  ],
};

const analysisRequest: ToolAvailabilityProofRequest = {
  ...request,
  surface: 'chat',
  finalOfferedTools: [
    ...request.finalOfferedTools,
    { type: 'function', name: 'run_analysis', description: 'analysis', parameters: { type: 'object' }, strict: false },
  ],
};

function proofWithAnalysis(
  permissionStatus: 'eligible' | 'denied' | 'unknown',
  permissionReason: string,
  surface: 'chat' | 'research' = 'chat',
): ToolAvailabilityProofResponse {
  const boundRequest = { ...analysisRequest, surface };
  return {
    ...response,
    scope: { ...response.scope, surface },
    turnBinding: {
      ...response.turnBinding,
      surface,
      finalSchemaFingerprint: fingerprintMeriFinalToolSchemas(boundRequest.finalOfferedTools, boundRequest.finalSchemaVersion),
    },
    offeredDiagnostic: {
      ...response.offeredDiagnostic,
      tools: [
        ...response.offeredDiagnostic.tools,
        { tool: 'run_analysis', permissionStatus, permissionReason, runtimeAvailability: 'unresolved', eligibility: 'unresolved', executable: false },
      ],
    },
  };
}

function assertAnalysisProof(proof: ToolAvailabilityProofResponse, surface: 'chat' | 'research' = 'chat') {
  return assertToolAvailabilityProofMatches({
    proof,
    request: { ...analysisRequest, surface },
    tenantId: response.scope.tenantId,
    userId: response.scope.userId,
    expectedClientId: response.scope.clientId,
  });
}

describe('assertToolAvailabilityProofMatches', () => {
  it('refuses redirects on the private proof request carrying service credentials', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => response,
    } as Response);
    try {
      const config = {
        get: (key: string) => key === 'INTERNAL_SERVICE_SECRET' ? 'test-secret' : 'http://api.invalid',
      } as unknown as ConfigService;
      await new ApiToolAvailabilityProofRepo(config).prove({ bearerToken: 'test-bearer', request });
      expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'error' });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([undefined, '', 'false', '1', 'TRUE'])('keeps shadow proof off for %s', (value) => {
    expect(isToolAvailabilityProofShadowEnabled(value)).toBe(false);
  });

  it('requires the literal opt-in value', () => {
    expect(isToolAvailabilityProofShadowEnabled('true')).toBe(true);
  });

  it('accepts only the service-authenticated response bound to the exact turn and schemas', () => {
    expect(() => assertToolAvailabilityProofMatches({ proof: response, request, tenantId: response.scope.tenantId, userId: response.scope.userId, expectedClientId: response.scope.clientId })).not.toThrow();
  });

  it.each([
    ['eligible', 'authorized'],
    ['denied', 'v3_disabled'],
    ['denied', 'tenant_feature_disabled'],
    ['denied', 'analysis_scope_unavailable'],
    ['unknown', 'check_failed'],
  ] as const)('accepts the permission-only run_analysis diagnostic %s/%s on chat', (status, reason) => {
    expect(() => assertAnalysisProof(proofWithAnalysis(status, reason))).not.toThrow();
  });

  it('accepts an eligible run_analysis diagnostic on research', () => {
    expect(() => assertAnalysisProof(proofWithAnalysis('eligible', 'authorized', 'research'), 'research')).not.toThrow();
  });

  it('accepts persisted clientless run_analysis eligibility without client-tool eligibility', () => {
    const clientlessRequest: ToolAvailabilityProofRequest = {
      ...analysisRequest,
      finalOfferedTools: analysisRequest.finalOfferedTools.filter(({ name }) => name === 'run_analysis'),
    };
    const clientlessProof: ToolAvailabilityProofResponse = {
      ...response,
      scope: { ...response.scope, clientId: null, surface: 'chat' },
      turnBinding: {
        ...response.turnBinding,
        surface: 'chat',
        finalSchemaFingerprint: fingerprintMeriFinalToolSchemas(clientlessRequest.finalOfferedTools, clientlessRequest.finalSchemaVersion),
      },
      clientScope: 'needs_input',
      tools: response.tools.map((tool) => ({ ...tool, status: 'unknown' as const, reason: 'not_offered' })),
      offeredDiagnostic: {
        ...response.offeredDiagnostic,
        tools: [{ tool: 'run_analysis', permissionStatus: 'eligible', permissionReason: 'authorized', runtimeAvailability: 'unresolved', eligibility: 'unresolved', executable: false }],
      },
    };
    expect(() => assertToolAvailabilityProofMatches({
      proof: clientlessProof,
      request: clientlessRequest,
      tenantId: response.scope.tenantId,
      userId: response.scope.userId,
      expectedClientId: null,
    })).not.toThrow();
  });

  it.each([
    ['eligible', 'check_failed'],
    ['denied', 'authorized'],
    ['unknown', 'permission_semantics_unresolved'],
    ['denied', 'client_not_visible'],
    ['denied', 'caller_role_insufficient'],
    ['denied', 'conversation_unavailable'],
  ] as const)('rejects the inconsistent run_analysis diagnostic %s/%s', (status, reason) => {
    expect(() => assertAnalysisProof(proofWithAnalysis(status, reason))).toThrow();
  });

  it('rejects a run_analysis diagnostic with a forged policy digest', () => {
    const proof = proofWithAnalysis('eligible', 'authorized');
    proof.offeredDiagnostic.catalogSha256 = response.catalogSha256;
    expect(() => assertAnalysisProof(proof)).toThrow();
  });

  it('keeps nonpersisted unavailable proofs outside the validated contract', () => {
    const proof = proofWithAnalysis('unknown', 'check_failed');
    expect(() => assertAnalysisProof({
      ...proof,
      clientScope: 'unavailable',
      scope: { ...proof.scope, source: 'authenticated_context_only' },
    } as unknown as ToolAvailabilityProofResponse)).toThrow();
  });

  it('requires run_analysis only when present in the exact final offered schemas and order', () => {
    const proof = proofWithAnalysis('eligible', 'authorized');
    const unofferedRequest: ToolAvailabilityProofRequest = {
      ...analysisRequest,
      finalOfferedTools: request.finalOfferedTools,
    };
    const unofferedProof: ToolAvailabilityProofResponse = {
      ...proof,
      turnBinding: {
        ...proof.turnBinding,
        finalSchemaFingerprint: fingerprintMeriFinalToolSchemas(unofferedRequest.finalOfferedTools, unofferedRequest.finalSchemaVersion),
      },
    };
    expect(() => assertToolAvailabilityProofMatches({
      proof: unofferedProof,
      request: unofferedRequest,
      tenantId: response.scope.tenantId,
      userId: response.scope.userId,
      expectedClientId: response.scope.clientId,
    })).toThrow();
    proof.offeredDiagnostic.tools.reverse();
    expect(() => assertAnalysisProof(proof)).toThrow();
  });

  it('retains unknown-only semantics for other noncatalog tools', () => {
    const otherRequest: ToolAvailabilityProofRequest = {
      ...request,
      finalOfferedTools: [
        ...request.finalOfferedTools,
        { type: 'function', name: 'send_email', description: 'unknown', parameters: { type: 'object' }, strict: false },
      ],
    };
    const otherProof: ToolAvailabilityProofResponse = {
      ...response,
      turnBinding: {
        ...response.turnBinding,
        finalSchemaFingerprint: fingerprintMeriFinalToolSchemas(otherRequest.finalOfferedTools, otherRequest.finalSchemaVersion),
      },
      offeredDiagnostic: {
        ...response.offeredDiagnostic,
        tools: [
          ...response.offeredDiagnostic.tools,
          { tool: 'send_email', permissionStatus: 'unknown', permissionReason: 'permission_semantics_unresolved', runtimeAvailability: 'unresolved', eligibility: 'unresolved', executable: false },
        ],
      },
    };
    const input = { proof: otherProof, request: otherRequest, tenantId: response.scope.tenantId, userId: response.scope.userId, expectedClientId: response.scope.clientId };
    expect(() => assertToolAvailabilityProofMatches(input)).not.toThrow();
    const unknownTool = otherProof.offeredDiagnostic.tools[1];
    if (!unknownTool) throw new Error('test_setup_missing_unknown_tool');
    otherProof.offeredDiagnostic.tools[1] = { ...unknownTool, permissionStatus: 'eligible', permissionReason: 'authorized' };
    expect(() => assertToolAvailabilityProofMatches(input)).toThrow();
  });

  it.each([
    ['nonce mismatch', { turnBinding: { ...response.turnBinding, nonce: '70000000-0000-4000-8000-000000000007' } }],
    ['schema substitution', { turnBinding: { ...response.turnBinding, finalSchemaFingerprint: 'b'.repeat(64) } }],
    ['scope substitution', { scope: { ...response.scope, clientId: 'foreign-client' } }],
    ['stale check time', { turnBinding: { ...response.turnBinding, checkTime: new Date(0).toISOString() } }],
    ['executable escalation', { tools: response.tools.map((tool) => ({ ...tool, executable: true as false })) }],
    ['eligibility escalation', { eligibility: 'eligible' }],
    ['missing persisted binding', { scope: { ...response.scope, source: 'authenticated_context_only' } }],
    ['diagnostic omitted', { offeredDiagnostic: undefined }],
    ['base catalog hash substitution', { catalogSha256: 'b'.repeat(64) }],
    ['diagnostic policy hash substitution', { offeredDiagnostic: { ...response.offeredDiagnostic, catalogSha256: 'b'.repeat(64) } }],
    ['diagnostic version downgrade', { offeredDiagnostic: { ...response.offeredDiagnostic, version: 'meri.offered-tool-diagnostic.v1' } }],
    ['diagnostic name substitution', { offeredDiagnostic: { ...response.offeredDiagnostic, tools: [{ ...response.offeredDiagnostic.tools[0], tool: 'send_email' }] } }],
    ['diagnostic permission escalation', { offeredDiagnostic: { ...response.offeredDiagnostic, tools: [{ ...response.offeredDiagnostic.tools[0], executable: true }] } }],
    ['diagnostic runtime claim', { offeredDiagnostic: { ...response.offeredDiagnostic, tools: [{ ...response.offeredDiagnostic.tools[0], runtimeAvailability: 'available' }] } }],
    ['unoffered catalog claim', { tools: response.tools.map((tool) => tool.tool === 'get_representation' ? { ...tool, status: 'eligible' } : tool) }],
  ])('rejects %s', (_name, patch) => {
    expect(() => assertToolAvailabilityProofMatches({ proof: { ...response, ...patch }, request, tenantId: response.scope.tenantId, userId: response.scope.userId, expectedClientId: response.scope.clientId })).toThrow();
  });
});
