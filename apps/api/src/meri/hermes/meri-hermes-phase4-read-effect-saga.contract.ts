import { createHash } from 'node:crypto';

/**
 * Phase 4 read-effect saga contract (item 2).
 *
 * `meri_memory_search` and `meri_fetch_attachment` are not transactionally
 * pure reads. Memory search writes content-free audit rows and Context Plane
 * packet metadata. Attachment reads may return ~13.3 MiB of base64.
 *
 * This contract implements the prepare/admit/execute/seal stages with one
 * durable budget reservation and a fenced lease. Response digests and
 * content-free manifests are stored, not query text, excerpts, attachment
 * bytes, or extracted text.
 *
 * Exact replay without encrypted result storage is not guaranteed: a
 * recomputed response may be released only if its digest matches the
 * sealed receipt.
 */

const READ_EFFECT_DOMAIN =
  'capiro.meri.phase4.read-effect/v1' as const;
const READ_EFFECT_LEASE_DOMAIN =
  'capiro.meri.phase4.read-effect-lease/v1' as const;
const READ_EFFECT_SEAL_DOMAIN =
  'capiro.meri.phase4.read-effect-seal/v1' as const;

export const MERI_PHASE4_READ_EFFECT_VERSION = 1 as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const POSITIVE_MICROS = /^[1-9][0-9]{0,18}$/;

// ── Read-effect tools ──

export type MeriPhase4ReadEffectTool =
  | 'meri_memory_search'
  | 'meri_fetch_attachment';

// ── Saga stages ──

export type MeriPhase4ReadEffectStage =
  | 'prepared'     // budget reserved, identity validated
  | 'admitted'     // fenced lease acquired, ready to execute
  | 'executing'    // external call in progress (outside DB transaction)
  | 'sealing'      // response received, computing digest
  | 'sealed'       // receipt committed with response digest
  | 'cancelled'    // cancelled before seal (timeout, error, Stop)
  | 'quarantined'; // digest mismatch on replay or other integrity failure

// ── Prepare stage ──

/**
 * Input for the prepare stage. Validates the caller, tool, and request
 * parameters before reserving budget.
 */
export interface MeriPhase4ReadEffectPrepareInputV1 {
  readonly version: typeof MERI_PHASE4_READ_EFFECT_VERSION;
  readonly operationId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly workerRunId: string;
  readonly dispatchRequestSha256: string;
  readonly scopeId: string;
  readonly tool: MeriPhase4ReadEffectTool;
  /** Tool-specific request parameters (query text, attachment ID, etc.) */
  readonly requestParamsSha256: string;
}

export function isMeriPhase4ReadEffectPrepareInputV1(
  value: unknown,
): value is MeriPhase4ReadEffectPrepareInputV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_READ_EFFECT_VERSION &&
    typeof row.operationId === 'string' && UUID.test(row.operationId) &&
    typeof row.tenantId === 'string' && UUID.test(row.tenantId) &&
    typeof row.runId === 'string' && UUID.test(row.runId) &&
    typeof row.workerRunId === 'string' && row.workerRunId.length > 0 &&
    row.workerRunId.length <= 120 &&
    typeof row.dispatchRequestSha256 === 'string' &&
    SHA256.test(row.dispatchRequestSha256) &&
    typeof row.scopeId === 'string' && row.scopeId.length > 0 &&
    (row.tool === 'meri_memory_search' || row.tool === 'meri_fetch_attachment') &&
    typeof row.requestParamsSha256 === 'string' &&
    SHA256.test(row.requestParamsSha256);
}

// ── Fenced lease ──

/**
 * The fenced lease prevents concurrent operations on the same resource.
 * The fence token is a DB-clock-derived value that must be presented
 * to advance the saga.
 */
export interface MeriPhase4ReadEffectLeaseV1 {
  readonly version: typeof MERI_PHASE4_READ_EFFECT_VERSION;
  readonly operationId: string;
  readonly fenceToken: string;
  readonly leaseSha256: string;
  readonly grantedAtEpochMicros: string;
  readonly expiresAtEpochMicros: string;
}

export function isMeriPhase4ReadEffectLeaseV1(
  value: unknown,
): value is MeriPhase4ReadEffectLeaseV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_READ_EFFECT_VERSION &&
    typeof row.operationId === 'string' && UUID.test(row.operationId) &&
    typeof row.fenceToken === 'string' && UUID.test(row.fenceToken) &&
    typeof row.leaseSha256 === 'string' && SHA256.test(row.leaseSha256) &&
    typeof row.grantedAtEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.grantedAtEpochMicros) &&
    typeof row.expiresAtEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.expiresAtEpochMicros) &&
    BigInt(row.grantedAtEpochMicros) < BigInt(row.expiresAtEpochMicros);
}

/**
 * Compute the lease SHA-256 binding the operation to the fence token.
 * This prevents a stale fence token from being replayed.
 */
export function meriPhase4ReadEffectLeaseSha256V1(
  operationId: string,
  fenceToken: string,
  grantedAtEpochMicros: string,
): string {
  if (!UUID.test(operationId) || !UUID.test(fenceToken) ||
      !POSITIVE_MICROS.test(grantedAtEpochMicros)) {
    throw new Error('invalid lease input');
  }
  return createHash('sha256')
    .update([READ_EFFECT_LEASE_DOMAIN, operationId, fenceToken,
      grantedAtEpochMicros].join('\0'))
    .digest('hex');
}

// ── Response manifest ──

/**
 * Content-free manifest describing the response without storing actual
 * data. The response digest proves the exact bytes without retaining them.
 */
export interface MeriPhase4ReadEffectResponseManifestV1 {
  readonly version: typeof MERI_PHASE4_READ_EFFECT_VERSION;
  readonly tool: MeriPhase4ReadEffectTool;
  readonly responseSha256: string;
  readonly responseLengthBytes: number;
  /** Whether the response contained readable content. */
  readonly hasContent: boolean;
  /** For meri_fetch_attachment: the attachment's content status. */
  readonly contentStatus: string | null;
  /** For meri_memory_search: number of results returned. */
  readonly resultCount: number | null;
}

export function isMeriPhase4ReadEffectResponseManifestV1(
  value: unknown,
): value is MeriPhase4ReadEffectResponseManifestV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_READ_EFFECT_VERSION &&
    (row.tool === 'meri_memory_search' || row.tool === 'meri_fetch_attachment') &&
    typeof row.responseSha256 === 'string' && SHA256.test(row.responseSha256) &&
    typeof row.responseLengthBytes === 'number' &&
    Number.isInteger(row.responseLengthBytes) &&
    row.responseLengthBytes >= 0 &&
    typeof row.hasContent === 'boolean' &&
    (row.contentStatus === null || typeof row.contentStatus === 'string') &&
    (row.resultCount === null || (typeof row.resultCount === 'number' &&
      Number.isInteger(row.resultCount) && row.resultCount >= 0));
}

/**
 * Compute the response SHA-256 from the raw response bytes.
 * This is what gets stored in the sealed receipt for replay verification.
 */
export function meriPhase4ReadEffectResponseSha256V1(
  responseBytes: Uint8Array,
): string {
  return createHash('sha256').update(responseBytes).digest('hex');
}

// ── Seal ──

/**
 * The sealed receipt binds the operation identity, response digest,
 * and manifest into a signed attestation target.
 */
export interface MeriPhase4ReadEffectSealV1 {
  readonly version: typeof MERI_PHASE4_READ_EFFECT_VERSION;
  readonly operationId: string;
  readonly tool: MeriPhase4ReadEffectTool;
  readonly stage: 'sealed';
  readonly requestParamsSha256: string;
  readonly responseSha256: string;
  readonly manifestSha256: string;
  readonly leaseSha256: string;
  readonly sealedAtEpochMicros: string;
  readonly signedClaimsSha256: string;
}

export function isMeriPhase4ReadEffectSealV1(
  value: unknown,
): value is MeriPhase4ReadEffectSealV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_READ_EFFECT_VERSION &&
    typeof row.operationId === 'string' && UUID.test(row.operationId) &&
    (row.tool === 'meri_memory_search' || row.tool === 'meri_fetch_attachment') &&
    row.stage === 'sealed' &&
    typeof row.requestParamsSha256 === 'string' &&
    SHA256.test(row.requestParamsSha256) &&
    typeof row.responseSha256 === 'string' && SHA256.test(row.responseSha256) &&
    typeof row.manifestSha256 === 'string' && SHA256.test(row.manifestSha256) &&
    typeof row.leaseSha256 === 'string' && SHA256.test(row.leaseSha256) &&
    typeof row.sealedAtEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.sealedAtEpochMicros) &&
    typeof row.signedClaimsSha256 === 'string' &&
    SHA256.test(row.signedClaimsSha256);
}

/**
 * Compute the signed claims SHA-256 for the sealed receipt.
 * This is the target for the signing pipeline attestation.
 */
export function meriPhase4ReadEffectSealClaimsSha256V1(
  operationId: string,
  tool: MeriPhase4ReadEffectTool,
  requestParamsSha256: string,
  responseSha256: string,
  manifestSha256: string,
  leaseSha256: string,
  sealedAtEpochMicros: string,
): string {
  if (!UUID.test(operationId) ||
      (tool !== 'meri_memory_search' && tool !== 'meri_fetch_attachment') ||
      !SHA256.test(requestParamsSha256) || !SHA256.test(responseSha256) ||
      !SHA256.test(manifestSha256) || !SHA256.test(leaseSha256) ||
      !POSITIVE_MICROS.test(sealedAtEpochMicros)) {
    throw new Error('invalid seal claims input');
  }
  return createHash('sha256')
    .update([READ_EFFECT_SEAL_DOMAIN, operationId, tool,
      requestParamsSha256, responseSha256, manifestSha256,
      leaseSha256, sealedAtEpochMicros].join('\0'))
    .digest('hex');
}

// ── Cancellation ──

export type MeriPhase4ReadEffectCancellationReason =
  | 'timeout'
  | 'stop_requested'
  | 'lease_expired'
  | 'authority_revoked'
  | 'execution_error';

export interface MeriPhase4ReadEffectCancellationV1 {
  readonly version: typeof MERI_PHASE4_READ_EFFECT_VERSION;
  readonly operationId: string;
  readonly stage: 'cancelled';
  readonly reason: MeriPhase4ReadEffectCancellationReason;
  readonly cancelledAtEpochMicros: string;
}

export function isMeriPhase4ReadEffectCancellationV1(
  value: unknown,
): value is MeriPhase4ReadEffectCancellationV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_READ_EFFECT_VERSION &&
    typeof row.operationId === 'string' && UUID.test(row.operationId) &&
    row.stage === 'cancelled' &&
    (row.reason === 'timeout' || row.reason === 'stop_requested' ||
     row.reason === 'lease_expired' || row.reason === 'authority_revoked' ||
     row.reason === 'execution_error') &&
    typeof row.cancelledAtEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.cancelledAtEpochMicros);
}
