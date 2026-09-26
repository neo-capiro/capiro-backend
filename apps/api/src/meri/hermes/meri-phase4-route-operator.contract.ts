import { createHash } from 'node:crypto';
import {
  MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1,
  MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1,
} from './meri-hermes-tool-view.js';

export const MERI_PHASE4_WORKER_AUDIENCE_V1 = 'meri-hermes-scope-worker' as const;
export const MERI_PHASE4_ROUTE_COMMAND_VERSION_V1 = 'capiro.meri.phase4.route-command/v1' as const;
export const MERI_PHASE4_WORKER_BINDING_VERSION_V2 = 2 as const;
export const MERI_PHASE4_TOOL_VIEW_PROTOCOL_V1 =
  'capiro.meri.phase4.request-local-tool-view/v1' as const;
export const MERI_PHASE4_CLAIM_ATTESTATION_PROTOCOL_V1 =
  'capiro.meri.phase4.claim-tool-view-attestation/v1' as const;
export const MERI_PHASE4_ROUTE_MAX_LIFETIME_MICROS_V1 = 2_592_000_000_000n; // 30 days
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

declare const trustedOperatorContextBrand: unique symbol;

/**
 * Constructed only by the future auth/control-plane boundary after it has
 * checked a live Capiro-admin impersonation session for this exact tenant.
 * This package deliberately has no HTTP DTO that can create the context.
 */
export interface MeriPhase4TrustedOperatorContextV1 {
  readonly [trustedOperatorContextBrand]: true;
  readonly role: 'capiro_admin';
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly impersonationSessionId: string;
  readonly reason: string;
  readonly grantId: string;
  readonly grantNonce: string;
  readonly grantOperation: MeriPhase4RouteOperationV1;
}

/** Input to the capiro_app-only database grant issuer. */
export interface MeriPhase4RouteGrantRequestV1 {
  readonly tenantId: string;
  readonly impersonationSessionId: string;
  readonly operation: MeriPhase4RouteOperationV1;
  readonly requestId: string;
  readonly requestDigest: string;
}

/** Authenticated external metadata producer; it cannot issue route operations. */
export interface MeriPhase4TrustedBindingAttestorV1 {
  readonly sourceId: string;
  /** Exact source-specific database session role selected by trusted server configuration. */
  readonly producerRole: string;
}

/** No body can choose tenant, actor, impersonation session, or reason. */
export interface MeriPhase4ProvisionRouteV1 {
  readonly requestId: string;
  readonly bindingId: string;
  readonly lifetimeMicros: bigint;
}

export interface MeriPhase4RouteIdentityV1 {
  readonly requestId: string;
  readonly scopeId: string;
  readonly ingressId: string;
  readonly expectedGeneration: string;
  readonly expectedCredentialId: string;
}

export interface MeriPhase4RotateRouteV1 extends MeriPhase4RouteIdentityV1 {
  readonly bindingId: string;
  readonly lifetimeMicros: bigint;
}

/** External producer metadata only; never includes credential bytes or URLs. */
export interface MeriPhase4AttestBindingV1 {
  readonly bindingId: string;
  readonly externalRecordId: string;
  readonly tenantId: string;
  readonly scopeId: string;
  readonly ingressId: string;
  readonly generation: string;
  readonly credentialId: string;
  readonly notBeforeEpochMicros: bigint;
  readonly notAfterEpochMicros: bigint;
}

/**
 * Complete source-qualified binding. V1 rows remain valid tombstones but are
 * deliberately ineligible for Phase 4 predispatch and claim authority.
 */
export interface MeriPhase4AttestBindingV2 extends MeriPhase4AttestBindingV1 {
  readonly bindingVersion: typeof MERI_PHASE4_WORKER_BINDING_VERSION_V2;
  readonly workerImageDigest: string;
  readonly workerBuildId: string;
  readonly workerCatalogDigestAlgorithm:
    typeof MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1;
  readonly workerCatalogDigest: string;
  readonly meriCatalogVersion: string;
  readonly meriCatalogDigest: string;
  readonly capabilityMappingVersion: string;
  readonly capabilityMappingDigest: string;
  readonly toolViewProtocol: typeof MERI_PHASE4_TOOL_VIEW_PROTOCOL_V1;
  readonly claimAttestationProtocol: typeof MERI_PHASE4_CLAIM_ATTESTATION_PROTOCOL_V1;
  /** Must equal credentialId; it names the purpose-separated attestation key. */
  readonly attestationCredentialId: string;
  /** Pins the applied-view digest algorithm even though the digest is per run. */
  readonly appliedToolViewDigestAlgorithm:
    typeof MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1;
}

export interface MeriPhase4RevokeBindingV1 {
  readonly tenantId: string;
  readonly bindingId: string;
  readonly revocationId: string;
}

export type MeriPhase4RouteOperationV1 = 'provision' | 'enable' | 'close' | 'rotate';
export type MeriPhase4RouteOutcomeV1 = 'changed' | 'no_op';
export type MeriPhase4RouteReceiptRecoveryV1 =
  | { readonly kind: 'receipt'; readonly receipt: MeriPhase4RouteReceiptV1 }
  | { readonly kind: 'not_found'; readonly requestId: string; readonly requestDigest: string };

/** The receipt reports database authority only, never worker/ingress state. */
export interface MeriPhase4RouteReceiptV1 {
  readonly receiptId: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly operation: MeriPhase4RouteOperationV1;
  readonly outcome: MeriPhase4RouteOutcomeV1;
  readonly actorUserId: string;
  readonly impersonationSessionId: string;
  readonly reason: string;
  readonly scopeId: string;
  readonly workerAudience: typeof MERI_PHASE4_WORKER_AUDIENCE_V1;
  readonly workerIngressId: string;
  readonly oldGeneration: string | null;
  readonly oldCredentialId: string | null;
  readonly newGeneration: string | null;
  readonly newCredentialId: string | null;
  readonly bindingId: string | null;
  readonly occurredAtEpochMicros: string;
  readonly fenceRevision: string;
  readonly ingressClosureProven: false;
  readonly workerTerminationProven: false;
}

export type MeriPhase4RouteOperatorResultV1 =
  | { readonly kind: 'receipt'; readonly receipt: MeriPhase4RouteReceiptV1 }
  | { readonly kind: 'UNKNOWN'; readonly requestId: string;
      readonly requestDigest: string; readonly retryWithSameRequestId: true };

export interface MeriPhase4BindingReceiptV1 {
  readonly bindingId: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly externalRecordId: string;
  readonly attestationSha256: string;
  readonly revokedAtEpochMicros: string | null;
}

export type MeriPhase4BindingOperationV1 = 'attest' | 'revoke';
export type MeriPhase4BindingOperatorResultV1 =
  | { readonly kind: 'receipt'; readonly receipt: MeriPhase4BindingReceiptV1 }
  | { readonly kind: 'UNKNOWN'; readonly operation: MeriPhase4BindingOperationV1;
      readonly tenantId: string; readonly sourceId: string; readonly bindingId: string;
      readonly idempotencyKey: string; readonly retryWithSameCommand: true };

export function assertMeriPhase4UuidV1(value: string, field: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`invalid ${field}`);
}

function assertToken(value: string, maxLength: number, field: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength ||
      !TOKEN.test(value)) throw new Error(`invalid ${field}`);
}

export function assertMeriPhase4PrivateScopeV1(tenantId: string, scopeId: string): void {
  assertMeriPhase4UuidV1(tenantId, 'tenantId');
  if (typeof scopeId !== 'string' || scopeId.length > 200 ||
      !new RegExp(`^tenant:${tenantId}:user:${UUID_PART}$`).test(scopeId)) {
    throw new Error('invalid private scope');
  }
}

export function assertMeriPhase4RouteTokenV1(value: string, field: string): void {
  assertToken(value, 128, field);
}

export function assertMeriPhase4TrustedOperatorContextV1(
  context: MeriPhase4TrustedOperatorContextV1,
): void {
  if (!context || context.role !== 'capiro_admin') throw new Error('trusted Capiro operator context required');
  assertMeriPhase4UuidV1(context.tenantId, 'tenantId');
  assertMeriPhase4UuidV1(context.actorUserId, 'actorUserId');
  assertMeriPhase4UuidV1(context.impersonationSessionId, 'impersonationSessionId');
  assertMeriPhase4UuidV1(context.grantId, 'grantId');
  if (!/^[0-9a-f]{64}$/.test(context.grantNonce) ||
      !['provision', 'enable', 'close', 'rotate'].includes(context.grantOperation)) {
    throw new Error('invalid route-operator grant');
  }
  if (typeof context.reason !== 'string' || context.reason.trim() !== context.reason ||
      context.reason.length < 10 || context.reason.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(context.reason)) {
    throw new Error('invalid operator reason');
  }
}

export function assertMeriPhase4LifetimeV1(lifetimeMicros: bigint): void {
  if (typeof lifetimeMicros !== 'bigint' || lifetimeMicros <= 0n ||
      lifetimeMicros > MERI_PHASE4_ROUTE_MAX_LIFETIME_MICROS_V1) {
    throw new Error('invalid route lifetime');
  }
}

/**
 * Mirrors SQL int4send(length)||UTF-8 framing and the domain/version in the
 * migration. Every part is non-null and its UTF-8 length is unambiguous.
 */
export function computeMeriPhase4RouteRequestDigestV1(parts: readonly string[]): string {
  if (!Array.isArray(parts) || parts.some((part) => typeof part !== 'string')) {
    throw new Error('invalid route command digest material');
  }
  const hash = createHash('sha256');
  for (const part of [MERI_PHASE4_ROUTE_COMMAND_VERSION_V1, ...parts]) {
    const bytes = Buffer.from(part, 'utf8');
    if (bytes.length > 0x7fffffff) throw new Error('route command field is too large');
    const length = Buffer.alloc(4);
    length.writeInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest('hex');
}

export function assertMeriPhase4AttestationV1(command: MeriPhase4AttestBindingV1): void {
  assertMeriPhase4UuidV1(command.bindingId, 'bindingId');
  assertMeriPhase4UuidV1(command.tenantId, 'tenantId');
  assertMeriPhase4PrivateScopeV1(command.tenantId, command.scopeId);
  assertToken(command.ingressId, 128, 'ingressId');
  assertToken(command.generation, 128, 'generation');
  assertToken(command.credentialId, 128, 'credentialId');
  assertToken(command.externalRecordId, 128, 'externalRecordId');
  if (typeof command.notBeforeEpochMicros !== 'bigint' ||
      typeof command.notAfterEpochMicros !== 'bigint' ||
      command.notBeforeEpochMicros <= 0n ||
      command.notAfterEpochMicros <= command.notBeforeEpochMicros ||
      command.notBeforeEpochMicros > MAX_SIGNED_INT64 ||
      command.notAfterEpochMicros > MAX_SIGNED_INT64 ||
      command.notAfterEpochMicros - command.notBeforeEpochMicros >
        MERI_PHASE4_ROUTE_MAX_LIFETIME_MICROS_V1) {
    throw new Error('invalid external route binding attestation');
  }
}

export function assertMeriPhase4AttestationV2(command: MeriPhase4AttestBindingV2): void {
  assertMeriPhase4AttestationV1(command);
  if (command.bindingVersion !== MERI_PHASE4_WORKER_BINDING_VERSION_V2 ||
      !/^[0-9a-f]{64}$/.test(command.workerImageDigest) ||
      command.workerCatalogDigestAlgorithm !== MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1 ||
      !/^[0-9a-f]{64}$/.test(command.workerCatalogDigest) ||
      !/^[0-9a-f]{64}$/.test(command.meriCatalogDigest) ||
      !/^[0-9a-f]{64}$/.test(command.capabilityMappingDigest) ||
      command.toolViewProtocol !== MERI_PHASE4_TOOL_VIEW_PROTOCOL_V1 ||
      command.claimAttestationProtocol !== MERI_PHASE4_CLAIM_ATTESTATION_PROTOCOL_V1 ||
      command.appliedToolViewDigestAlgorithm !==
        MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1 ||
      command.attestationCredentialId !== command.credentialId) {
    throw new Error('invalid source-qualified worker binding v2');
  }
  assertToken(command.workerBuildId, 128, 'workerBuildId');
  assertToken(command.meriCatalogVersion, 128, 'meriCatalogVersion');
  assertToken(command.capabilityMappingVersion, 128, 'capabilityMappingVersion');
  assertToken(command.attestationCredentialId, 128, 'attestationCredentialId');
}

export function assertMeriPhase4RouteIdentityV1(
  tenantId: string,
  command: MeriPhase4RouteIdentityV1,
): void {
  assertMeriPhase4UuidV1(command.requestId, 'requestId');
  assertMeriPhase4PrivateScopeV1(tenantId, command.scopeId);
  assertToken(command.ingressId, 128, 'ingressId');
  assertToken(command.expectedGeneration, 128, 'expectedGeneration');
  assertToken(command.expectedCredentialId, 128, 'expectedCredentialId');
}
