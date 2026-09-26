import { createHash } from 'node:crypto';
import { MERI_FINAL_TOOL_SCHEMA_VERSION } from '@capiro/meriv2-core';

/** Dark, non-executable authorization proof contract. Not connected to JEV or routing. */
export const MERI_TOOL_AVAILABILITY_PROOF_VERSION = 'meri.tool-availability-proof.v3' as const;
export const MERI_OFFERED_TOOL_DIAGNOSTIC_VERSION = 'meri.offered-tool-diagnostic.v2' as const;
export const MERI_FINAL_SCHEMA_VERSION = MERI_FINAL_TOOL_SCHEMA_VERSION;

export const MERI_TOOL_AVAILABILITY_PROOF_CATALOG = [
  { tool: 'get_client_context', proof: 'tenant-active-client-and-current-user-memory-wall' },
  { tool: 'search_client_knowledge', proof: 'tenant-active-client-and-client-kb-memory-wall' },
  { tool: 'get_representation', proof: 'tenant-active-client-wall-aware-visibility' },
] as const;

const canonicalCatalog = JSON.stringify({
  version: MERI_TOOL_AVAILABILITY_PROOF_VERSION,
  tools: MERI_TOOL_AVAILABILITY_PROOF_CATALOG,
});

/** Fingerprint changes with the version or any server-owned tool/policy entry. */
export const MERI_TOOL_AVAILABILITY_PROOF_CATALOG_SHA256 = createHash('sha256')
  .update(canonicalCatalog, 'utf8')
  .digest('hex');

/** Separate policy identity: adding diagnostics must not silently expand the v3 proof catalog. */
export const MERI_OFFERED_TOOL_DIAGNOSTIC_CATALOG_SHA256 = createHash('sha256')
  .update(JSON.stringify({
    version: MERI_OFFERED_TOOL_DIAGNOSTIC_VERSION,
    baseCatalogSha256: MERI_TOOL_AVAILABILITY_PROOF_CATALOG_SHA256,
    extra: [{
      tool: 'run_analysis',
      proof: 'v3-enabled-tenant-run-analysis-and-conversation-client-wall',
    }],
  }), 'utf8')
  .digest('hex');

export type MeriToolAvailabilityProofTool =
  (typeof MERI_TOOL_AVAILABILITY_PROOF_CATALOG)[number]['tool'];
export type MeriPermissionDiagnosticTool = MeriToolAvailabilityProofTool | 'run_analysis';
export type MeriToolAvailabilityStatus = 'eligible' | 'denied' | 'unknown';
export type MeriToolPermissionReason = 'authorized' | 'client_not_visible' | 'conversation_unavailable' | 'needs_input' | 'check_failed' | 'caller_role_insufficient' | 'not_offered' | 'permission_semantics_unresolved' | 'v3_disabled' | 'tenant_feature_disabled' | 'analysis_scope_unavailable';

export interface MeriToolAvailabilityTurnBinding {
  nonce: string;
  nonceProvenance: 'authenticated_internal_service_assertion';
  surface: 'chat' | 'research';
  surfaceProvenance: 'authenticated_internal_service_assertion';
  finalSchemaVersion: typeof MERI_FINAL_SCHEMA_VERSION;
  finalSchemaFingerprint: string;
  schemaFingerprintProvenance: 'api_recomputed_from_exact_provider_schemas';
  checkTime: string;
  integrity: 'api_recomputed_schema_fingerprint';
}

export interface MeriFinalProviderToolSchema {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

const MAX_FINAL_TOOLS = 256;
const MAX_FINAL_TOOLS_BYTES = 900 * 1024;

export function isMeriFinalProviderTools(value: unknown): value is MeriFinalProviderToolSchema[] {
  if (!Array.isArray(value) || value.length > MAX_FINAL_TOOLS) return false;
  const names = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const tool = entry as Record<string, unknown>;
    const keys = Object.keys(tool).sort();
    if (
      (keys.join(',') !== 'description,name,parameters,type' &&
        keys.join(',') !== 'description,name,parameters,strict,type') ||
      tool.type !== 'function' ||
      typeof tool.name !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(tool.name) ||
      names.has(tool.name) ||
      typeof tool.description !== 'string' ||
      tool.description.length > 16_000 ||
      !tool.parameters ||
      typeof tool.parameters !== 'object' ||
      Array.isArray(tool.parameters) ||
      (tool.strict !== undefined && typeof tool.strict !== 'boolean')
    ) return false;
    names.add(tool.name);
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') <= MAX_FINAL_TOOLS_BYTES;
  } catch {
    return false;
  }
}

export interface MeriToolAvailabilityProof {
  version: typeof MERI_TOOL_AVAILABILITY_PROOF_VERSION;
  catalogSha256: string;
  semantics: 'permission_only';
  runtimeAvailability: 'unresolved';
  eligibility: 'unresolved';
  unresolvedChecks: readonly ['runtime-availability'];
  conversationId: string;
  scope: Readonly<{
    tenantId: string;
    userId: string;
    conversationId: string;
    clientId: string | null;
    surface: 'chat' | 'research';
    source: 'authenticated_context_only' | 'authenticated_context_and_persisted_conversation';
  }>;
  turnBinding: Readonly<MeriToolAvailabilityTurnBinding>;
  clientScope: 'present' | 'needs_input' | 'unavailable';
  /** Diagnostic rows follow the exact final provider schema order. No row authorizes invocation. */
  offeredDiagnostic: Readonly<{
    version: typeof MERI_OFFERED_TOOL_DIAGNOSTIC_VERSION;
    /** Three fixed checks plus the v2 analysis permission policy; the offered schema list is separately turn-bound. */
    catalogSha256: string;
    tools: readonly Readonly<{
      tool: string;
      permissionStatus: MeriToolAvailabilityStatus;
      permissionReason: MeriToolPermissionReason;
      runtimeAvailability: 'unresolved';
      eligibility: 'unresolved';
      executable: false;
    }>[];
  }>;
  tools: Array<{
    tool: MeriToolAvailabilityProofTool;
    status: MeriToolAvailabilityStatus;
    executable: false;
    reason: MeriToolPermissionReason;
  }>;
}
