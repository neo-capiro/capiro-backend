import { createHash } from 'node:crypto';
import { MERI_CAPABILITY_REGISTRY } from '@capiro/shared';
import { fingerprintMeriFinalToolSchemas } from '@capiro/meriv2-core';

/** Input must come from the authenticated turn, after the final tool list is built. */
export interface AuthenticatedFinalToolScope {
  tenantId: string;
  userId: string;
  conversationId: string;
  clientId: string | null;
  surface: 'chat' | 'research';
}

export interface FinalOfferedToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface FinalOfferedCapabilitySnapshot {
  contractVersion: 'meri.final-offered-capabilities.v1';
  eligibility: 'unresolved';
  unresolvedChecks: readonly ['native-user-and-client-permission'];
  schemaVersion: 'meriv3.final-offered-schema.v1';
  catalogVersion: string;
  schemaFingerprint: string;
  candidateSetVersion: string;
  scope: Readonly<AuthenticatedFinalToolScope>;
  candidateIds: readonly string[];
}

/** A structural check, never an authorized or JEV-eligible selection. */
export interface StructurallyValidOfferedSelection {
  eligibility: 'unresolved';
  unresolvedChecks: readonly ['native-user-and-client-permission'];
  selectedIds: readonly string[];
}

const CONTRACT_VERSION = 'meri.final-offered-capabilities.v1' as const;
const SCHEMA_VERSION = 'meriv3.final-offered-schema.v1' as const;
const CAPABILITY_BY_NAME = new Map(MERI_CAPABILITY_REGISTRY.map((entry) => [entry.name, entry]));

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  throw new Error('final_tool_schema_not_json');
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export const FINAL_OFFERED_CAPABILITY_CATALOG_VERSION = `meri-capability-catalog.sha256:${hash(
  MERI_CAPABILITY_REGISTRY.map(({ name, description, backend, readOnly, surfaces }) => ({
    name,
    description,
    backend,
    readOnly,
    surfaces,
  })),
)}`;

function assertScope(scope: AuthenticatedFinalToolScope): void {
  for (const id of [scope.tenantId, scope.userId, scope.conversationId]) {
    if (typeof id !== 'string' || !id.trim() || id !== id.trim()) {
      throw new Error('final_tool_scope_missing');
    }
  }
  if (
    scope.clientId !== null &&
    (typeof scope.clientId !== 'string' ||
      !scope.clientId.trim() ||
      scope.clientId !== scope.clientId.trim())
  ) {
    throw new Error('final_tool_scope_invalid_client');
  }
  if (scope.surface !== 'chat' && scope.surface !== 'research') {
    throw new Error('final_tool_scope_invalid_surface');
  }
}

/** Pure compiler. It never fetches schemas, creates a provider, or authorizes invocation. */
export function compileFinalOfferedCapabilitySnapshot(input: {
  authenticatedScope: AuthenticatedFinalToolScope;
  finalOfferedSchemas: readonly FinalOfferedToolSchema[];
}): FinalOfferedCapabilitySnapshot {
  const { authenticatedScope: scope, finalOfferedSchemas: schemas } = input;
  assertScope(scope);
  if (!Array.isArray(schemas)) throw new Error('final_tool_schemas_missing');
  const seen = new Set<string>();
  for (const schema of schemas) {
    if (
      !schema ||
      typeof schema.name !== 'string' ||
      !schema.name.trim() ||
      schema.name !== schema.name.trim() ||
      typeof schema.description !== 'string' ||
      !schema.input_schema ||
      typeof schema.input_schema !== 'object' ||
      Array.isArray(schema.input_schema)
    ) {
      throw new Error('final_tool_schema_invalid');
    }
    if (seen.has(schema.name)) throw new Error('final_tool_schema_duplicate');
    seen.add(schema.name);
  }
  const schemaFingerprint = fingerprintMeriFinalToolSchemas(schemas, SCHEMA_VERSION);
  const candidateIds = Object.freeze(
    schemas.flatMap(({ name }) => {
      const capability = CAPABILITY_BY_NAME.get(name);
      return capability && (capability.surfaces as readonly string[]).includes('full_chat')
        ? [name]
        : [];
    }),
  );
  const frozenScope = Object.freeze({
    tenantId: scope.tenantId,
    userId: scope.userId,
    conversationId: scope.conversationId,
    clientId: scope.clientId,
    surface: scope.surface,
  });
  const candidateSetVersion = `meri-candidates.sha256:${hash({
    contractVersion: CONTRACT_VERSION,
    catalogVersion: FINAL_OFFERED_CAPABILITY_CATALOG_VERSION,
    schemaFingerprint,
    scope: frozenScope,
    candidateIds,
  })}`;
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    eligibility: 'unresolved',
    unresolvedChecks: Object.freeze(['native-user-and-client-permission'] as const),
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: FINAL_OFFERED_CAPABILITY_CATALOG_VERSION,
    schemaFingerprint,
    candidateSetVersion,
    scope: frozenScope,
    candidateIds,
  });
}

/** Rebuild against the current turn before accepting an advisory selection. */
export function validateFinalOfferedCapabilitySelection(input: {
  snapshot: FinalOfferedCapabilitySnapshot;
  authenticatedScope: AuthenticatedFinalToolScope;
  finalOfferedSchemas: readonly FinalOfferedToolSchema[];
  candidateSetVersion: string;
  selectedIds: unknown;
}): StructurallyValidOfferedSelection {
  const current = compileFinalOfferedCapabilitySnapshot(input);
  if (
    input.snapshot.contractVersion !== current.contractVersion ||
    input.snapshot.eligibility !== 'unresolved' ||
    hash(input.snapshot.unresolvedChecks) !== hash(current.unresolvedChecks) ||
    input.snapshot.schemaVersion !== current.schemaVersion ||
    input.snapshot.catalogVersion !== current.catalogVersion ||
    input.snapshot.schemaFingerprint !== current.schemaFingerprint ||
    input.snapshot.candidateSetVersion !== current.candidateSetVersion ||
    hash(input.snapshot.scope) !== hash(current.scope) ||
    hash(input.snapshot.candidateIds) !== hash(current.candidateIds) ||
    input.candidateSetVersion !== current.candidateSetVersion
  ) {
    throw new Error('final_tool_snapshot_stale');
  }
  if (!Array.isArray(input.selectedIds) || input.selectedIds.some((id) => typeof id !== 'string')) {
    throw new Error('final_tool_selection_invalid');
  }
  const selected = input.selectedIds as string[];
  if (new Set(selected).size !== selected.length) throw new Error('final_tool_selection_duplicate');
  const allowed = new Set(current.candidateIds);
  if (selected.some((id) => !allowed.has(id))) throw new Error('final_tool_selection_not_offered');
  return Object.freeze({
    eligibility: 'unresolved',
    unresolvedChecks: current.unresolvedChecks,
    selectedIds: Object.freeze([...selected]),
  });
}
