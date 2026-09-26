import { ConfigService } from '@nestjs/config';
import { fingerprintMeriFinalToolSchemas } from '@capiro/meriv2-core';
import type { OpenAiResponsesFunctionTool } from './meriv3.types.js';

const MAX_CHECK_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const PROOF_REQUEST_TIMEOUT_MS = 1_000;
// Pin both server-owned policies independently. The v3 top-level proof remains the original three tools.
const PROOF_CATALOG_SHA256 = 'a4e1eeb283348dc9f430424695f86d36fcd642283f6a2af2bccdf8aa1d49b2dd';
const OFFERED_DIAGNOSTIC_CATALOG_SHA256 = 'f47b85b2cf1386eb430fc42b544bfe8e932655542dfdd54940fbb3b58863fcbf';

const RUN_ANALYSIS_PERMISSION_RESULTS: Readonly<Record<string, readonly string[]>> = {
  eligible: ['authorized'],
  denied: [
    'v3_disabled',
    'tenant_feature_disabled',
    'analysis_scope_unavailable',
  ],
  unknown: ['check_failed'],
};

export function isToolAvailabilityProofShadowEnabled(value: string | undefined): boolean {
  return value === 'true';
}

export interface ToolAvailabilityProofRequest {
  conversationId: string;
  turnNonce: string;
  surface: 'chat' | 'research';
  finalSchemaVersion: 'meriv3.final-offered-schema.v1';
  finalOfferedTools: readonly OpenAiResponsesFunctionTool[];
}

export interface ToolAvailabilityProofResponse {
  version: 'meri.tool-availability-proof.v3';
  catalogSha256: string;
  semantics: 'permission_only';
  eligibility: 'unresolved';
  runtimeAvailability: 'unresolved';
  unresolvedChecks: readonly ['runtime-availability'];
  conversationId: string;
  scope: {
    tenantId: string;
    userId: string;
    conversationId: string;
    clientId: string | null;
    surface: 'chat' | 'research';
    source: 'authenticated_context_and_persisted_conversation';
  };
  turnBinding: {
    nonce: string;
    nonceProvenance: 'authenticated_internal_service_assertion';
    surface: 'chat' | 'research';
    surfaceProvenance: 'authenticated_internal_service_assertion';
    finalSchemaVersion: 'meriv3.final-offered-schema.v1';
    finalSchemaFingerprint: string;
    schemaFingerprintProvenance: 'api_recomputed_from_exact_provider_schemas';
    checkTime: string;
    integrity: 'api_recomputed_schema_fingerprint';
  };
  clientScope: 'present' | 'needs_input';
  offeredDiagnostic: {
    version: 'meri.offered-tool-diagnostic.v2';
    catalogSha256: string;
    tools: Array<{
      tool: string;
      permissionStatus: 'eligible' | 'denied' | 'unknown';
      permissionReason: string;
      runtimeAvailability: 'unresolved';
      eligibility: 'unresolved';
      executable: false;
    }>;
  };
  tools: Array<{
    tool: 'get_client_context' | 'search_client_knowledge' | 'get_representation';
    status: 'eligible' | 'denied' | 'unknown';
    reason: string;
    executable: false;
  }>;
}

export function assertToolAvailabilityProofMatches(input: {
  proof: unknown;
  request: ToolAvailabilityProofRequest;
  tenantId: string;
  userId: string;
  expectedClientId: string | null;
}): ToolAvailabilityProofResponse {
  const proof = input.proof as ToolAvailabilityProofResponse | null;
  if (!proof || typeof proof !== 'object') throw new Error('tool_availability_proof_invalid');
  const scope = proof.scope;
  const binding = proof.turnBinding;
  const checkTime = Date.parse(binding?.checkTime ?? '');
  const fingerprint = fingerprintMeriFinalToolSchemas(
    input.request.finalOfferedTools,
    input.request.finalSchemaVersion,
  );
  if (
    proof.version !== 'meri.tool-availability-proof.v3' ||
    proof.semantics !== 'permission_only' ||
    proof.eligibility !== 'unresolved' ||
    proof.runtimeAvailability !== 'unresolved' ||
    !Array.isArray(proof.unresolvedChecks) ||
    proof.unresolvedChecks.length !== 1 ||
    proof.unresolvedChecks[0] !== 'runtime-availability' ||
    proof.conversationId !== input.request.conversationId ||
    !scope ||
    scope.tenantId !== input.tenantId ||
    scope.userId !== input.userId ||
    scope.conversationId !== input.request.conversationId ||
    scope.surface !== input.request.surface ||
    scope.source !== 'authenticated_context_and_persisted_conversation' ||
    scope.clientId !== input.expectedClientId ||
    !binding ||
    binding.nonce !== input.request.turnNonce ||
    binding.nonceProvenance !== 'authenticated_internal_service_assertion' ||
    binding.surface !== input.request.surface ||
    binding.surfaceProvenance !== 'authenticated_internal_service_assertion' ||
    binding.finalSchemaVersion !== input.request.finalSchemaVersion ||
    binding.finalSchemaFingerprint !== fingerprint ||
    binding.schemaFingerprintProvenance !== 'api_recomputed_from_exact_provider_schemas' ||
    binding.integrity !== 'api_recomputed_schema_fingerprint' ||
    !Number.isFinite(checkTime) ||
    Date.now() - checkTime > MAX_CHECK_AGE_MS ||
    checkTime - Date.now() > MAX_FUTURE_SKEW_MS ||
    !Array.isArray(proof.tools) ||
    proof.tools.length !== 3 ||
    !['present', 'needs_input'].includes(proof.clientScope ?? '') ||
    proof.catalogSha256 !== PROOF_CATALOG_SHA256 ||
    proof.tools.some((entry) => !entry || entry.executable !== false || !['eligible', 'denied', 'unknown'].includes(entry.status))
  ) {
    throw new Error('tool_availability_proof_mismatch');
  }
  const expected = ['get_client_context', 'search_client_knowledge', 'get_representation'];
  const actualTools = proof.tools;
  if (new Set(actualTools.map((entry) => entry.tool)).size !== expected.length ||
      expected.some((name) => !actualTools.some((entry) => entry.tool === name))) {
    throw new Error('tool_availability_proof_catalog_mismatch');
  }
  if (actualTools.some((entry) => !input.request.finalOfferedTools.some(({ name }) => name === entry.tool) &&
    (entry.status !== 'unknown' || entry.reason !== 'not_offered'))) {
    throw new Error('tool_availability_proof_unoffered_check');
  }
  const diagnostic = proof.offeredDiagnostic;
  if (
    !diagnostic ||
    diagnostic.version !== 'meri.offered-tool-diagnostic.v2' ||
    diagnostic.catalogSha256 !== OFFERED_DIAGNOSTIC_CATALOG_SHA256 ||
    !Array.isArray(diagnostic.tools) ||
    diagnostic.tools.length !== input.request.finalOfferedTools.length ||
    diagnostic.tools.some((entry, index) => {
      const expectedName = input.request.finalOfferedTools[index]?.name;
      const catalogCheck = actualTools.find((check) => check.tool === expectedName);
      return !entry || entry.tool !== expectedName ||
        entry.executable !== false ||
        entry.runtimeAvailability !== 'unresolved' ||
        entry.eligibility !== 'unresolved' ||
        !['eligible', 'denied', 'unknown'].includes(entry.permissionStatus) ||
        (catalogCheck
          ? entry.permissionStatus !== catalogCheck.status ||
            entry.permissionReason !== catalogCheck.reason
          : expectedName === 'run_analysis'
            ? !RUN_ANALYSIS_PERMISSION_RESULTS[entry.permissionStatus]?.includes(entry.permissionReason)
            : entry.permissionStatus !== 'unknown' ||
              entry.permissionReason !== 'permission_semantics_unresolved');
    })
  ) {
    throw new Error('tool_availability_offered_diagnostic_mismatch');
  }
  return proof as ToolAvailabilityProofResponse;
}

/** Private, read-only call. The browser/user receives neither the service secret nor this endpoint. */
export class ApiToolAvailabilityProofRepo {
  private readonly apiBaseUrl: string;
  private readonly serviceSecret: string | undefined;

  constructor(config: ConfigService) {
    this.apiBaseUrl = (config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000').replace(/\/+$/, '');
    this.serviceSecret = config.get<string>('INTERNAL_SERVICE_SECRET') || process.env.INTERNAL_SERVICE_SECRET;
  }

  async prove(input: {
    bearerToken: string;
    impersonateTenantId?: string;
    request: ToolAvailabilityProofRequest;
    signal?: AbortSignal;
  }): Promise<unknown> {
    if (!input.bearerToken) throw new Error('tool_availability_bearer_missing');
    if (!this.serviceSecret?.trim()) throw new Error('tool_availability_service_identity_missing');
    if (input.request.finalOfferedTools.length > 256) throw new Error('tool_availability_schema_count_limit');
    const body = JSON.stringify(input.request);
    if (typeof body !== 'string') throw new Error('tool_availability_schema_invalid');
    if (Buffer.byteLength(body, 'utf8') > 900 * 1024) throw new Error('tool_availability_schema_size_limit');
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) abortFromCaller();
    else input.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error('tool_availability_timeout')),
      PROOF_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/clio/internal/tool-availability-proof`, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${input.bearerToken}`,
          'x-internal-service-secret': this.serviceSecret.trim(),
          accept: 'application/json',
          'content-type': 'application/json',
          ...(input.impersonateTenantId
            ? { 'x-capiro-impersonate-tenant': input.impersonateTenantId }
            : {}),
        },
        body,
      });
      if (!response.ok) throw new Error(`tool_availability_http_${response.status}`);
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted && !input.signal?.aborted) {
        throw new Error('tool_availability_timeout');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}
