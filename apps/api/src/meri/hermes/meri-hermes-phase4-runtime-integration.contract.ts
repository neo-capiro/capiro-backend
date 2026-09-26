/**
 * Phase 4 trusted runtime integration contract (item 6).
 *
 * This contract defines the default-off coordinator that wires the
 * effect/signing/operation-ID packages together. It is registered only
 * when all prerequisite packages pass together. The coordinator is not
 * a Nest module until explicit activation.
 *
 * Requirements:
 * - register a default-off coordinator and exact-byte transport;
 * - add the private claim controller and deterministic dispatch bearer;
 * - use the source-qualified V2 route resolver and current tool view;
 * - enforce all ingress before provider, broker or memory effects,
 *   including MCP and background refresh paths;
 * - preserve Stop/unknown/recovery ordering and restart/crash/retention;
 * - keep private keys and signer scheduling outside the general API process.
 *
 * No shared worker-profile mutation is acceptable for request-local
 * tool exposure.
 */

export const MERI_PHASE4_RUNTIME_VERSION = 1 as const;

// ── Feature flag ──

export const MERI_PHASE4_COORDINATOR_FLAG =
  'MERI_PHASE4_COORDINATOR_ENABLED' as const;

/**
 * The coordinator is default-off. It must be explicitly enabled per-tenant
 * or globally. The flag check is the first gate before any Phase 4 path.
 */
export interface MeriPhase4CoordinatorConfigV1 {
  readonly version: typeof MERI_PHASE4_RUNTIME_VERSION;
  /** Master switch: false means all Phase 4 paths are inert. */
  readonly enabled: boolean;
  /** Per-tenant overrides: tenant UUID -> enabled. */
  readonly tenantOverrides: ReadonlyMap<string, boolean>;
}

export function isMeriPhase4CoordinatorEnabled(
  config: Readonly<MeriPhase4CoordinatorConfigV1>,
  tenantId: string,
): boolean {
  if (!config || config.version !== MERI_PHASE4_RUNTIME_VERSION) return false;
  const override = config.tenantOverrides.get(tenantId);
  if (override !== undefined) return override;
  return config.enabled;
}

// ── Ingress gate ──

/**
 * Every Phase 4 ingress must pass this gate before provider, broker,
 * or memory effects. The gate enforces:
 * - coordinator is enabled for the tenant
 * - dispatch identity is V2 and source-qualified
 * - route resolver is V2 with current tool view
 * - operation namespace was minted in the claim transaction
 * - signing key is active and qualified for the tenant/scope
 */
export type MeriPhase4IngressGateResult =
  | { readonly kind: 'admitted'; readonly reason: null }
  | { readonly kind: 'rejected'; readonly reason: MeriPhase4IngressRejectionReason };

export type MeriPhase4IngressRejectionReason =
  | 'coordinator_disabled'
  | 'dispatch_identity_mismatch'
  | 'route_resolver_incompatible'
  | 'operation_namespace_missing'
  | 'signing_key_unavailable'
  | 'signing_key_revoked'
  | 'tenant_not_authorized'
  | 'worker_credential_expired'
  | 'stop_requested';

export function meriPhase4IngressAdmitted(): MeriPhase4IngressGateResult {
  return Object.freeze({ kind: 'admitted' as const, reason: null });
}

export function meriPhase4IngressRejected(
  reason: MeriPhase4IngressRejectionReason,
): MeriPhase4IngressGateResult {
  return Object.freeze({ kind: 'rejected' as const, reason });
}

// ── Transport registration ──

/**
 * The exact-byte transport is registered with the coordinator. It handles
 * the wire protocol between the API and the worker, including the
 * operation namespace grant in the claim response.
 */
export interface MeriPhase4TransportRegistrationV1 {
  readonly version: typeof MERI_PHASE4_RUNTIME_VERSION;
  readonly transportId: string;
  /** Whether the transport is active and accepting connections. */
  readonly active: boolean;
  /** The dispatch protocol version this transport supports. */
  readonly dispatchProtocolVersion: 2;
  /** Whether the transport enforces exact-byte request matching. */
  readonly exactByteMatching: true;
}

// ── Coordinator lifecycle ──

export type MeriPhase4CoordinatorState =
  | 'initializing'
  | 'ready'
  | 'degraded'
  | 'shutting_down'
  | 'stopped';

/**
 * The coordinator lifecycle is managed by the NestJS module system.
 * It starts in 'initializing', moves to 'ready' when all prerequisites
 * are verified, and can be 'degraded' if a signing key is retired or
 * the signer task is unavailable.
 */
export interface MeriPhase4CoordinatorStatusV1 {
  readonly version: typeof MERI_PHASE4_RUNTIME_VERSION;
  readonly state: MeriPhase4CoordinatorState;
  readonly signingAvailable: boolean;
  readonly activeKeyId: string | null;
  readonly registeredTransports: number;
  readonly enabledTenants: number;
}

export function isMeriPhase4CoordinatorStatusV1(
  value: unknown,
): value is MeriPhase4CoordinatorStatusV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_RUNTIME_VERSION &&
    (row.state === 'initializing' || row.state === 'ready' ||
     row.state === 'degraded' || row.state === 'shutting_down' ||
     row.state === 'stopped') &&
    typeof row.signingAvailable === 'boolean' &&
    (row.activeKeyId === null || typeof row.activeKeyId === 'string') &&
    typeof row.registeredTransports === 'number' &&
    Number.isInteger(row.registeredTransports) &&
    typeof row.enabledTenants === 'number' &&
    Number.isInteger(row.enabledTenants);
}
