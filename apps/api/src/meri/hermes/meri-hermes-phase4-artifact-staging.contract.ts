import { createHash } from 'node:crypto';

/**
 * Phase 4 artifact staging and reconciliation contract (item 3).
 *
 * Replaces the current blind-PUT artifact path with a staged state machine:
 * 1. Validate and prepare under current authority; reserve budget once.
 * 2. Claim a fenced upload lease.
 * 3. Upload to a deterministic key with If-None-Match: *, checksum and
 *    operation metadata.
 * 4. Reconcile exact bytes and S3 version history.
 * 5. Atomically finalize one database artifact/event only for a selected
 *    immutable VersionId.
 * 6. Seal a signed receipt; quarantine mismatches and create version-
 *    specific cleanup obligations.
 */

const ARTIFACT_STAGING_DOMAIN =
  'capiro.meri.phase4.artifact-staging/v1' as const;
const ARTIFACT_KEY_DOMAIN =
  'capiro.meri.phase4.artifact-key/v1' as const;

export const MERI_PHASE4_ARTIFACT_STAGING_VERSION = 1 as const;

/** Maximum artifact size (50 MiB). Unresolved prerequisite from handoff. */
export const MERI_PHASE4_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const POSITIVE_MICROS = /^[1-9][0-9]{0,18}$/;

// ── Staged state machine ──

export type MeriPhase4ArtifactStage =
  | 'validated'     // input validated, budget reserved
  | 'lease_claimed' // fenced upload lease acquired
  | 'uploaded'      // S3 PUT completed with VersionId
  | 'reconciled'    // bytes and version history verified
  | 'finalized'     // database artifact/event created
  | 'sealed'        // signed receipt committed
  | 'quarantined'   // mismatch detected, cleanup obligation created
  | 'cancelled';    // cancelled before finalization

// ── Deterministic S3 key ──

/**
 * Deterministic S3 key for staged artifacts. The key is derived from the
 * operation identity, preventing collisions and enabling reconciliation.
 */
export function meriPhase4ArtifactStagedKeyV1(
  tenantId: string,
  operationId: string,
  filename: string,
): string {
  if (!UUID.test(tenantId) || !UUID.test(operationId) ||
      typeof filename !== 'string' || filename.length === 0 ||
      filename.length > 255) {
    throw new Error('invalid artifact key input');
  }
  // Sanitize filename: allow alphanumeric, hyphens, underscores, dots
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `meri-phase4-staged/${tenantId}/${operationId}/${safeName}`;
}

// ── Validate stage ──

export interface MeriPhase4ArtifactValidateInputV1 {
  readonly version: typeof MERI_PHASE4_ARTIFACT_STAGING_VERSION;
  readonly operationId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly workerRunId: string;
  readonly dispatchRequestSha256: string;
  readonly scopeId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly contentLengthBytes: number;
  readonly contentSha256: string;
  /** Strict one-of: either text content or base64 bytes, never both. */
  readonly inputKind: 'text' | 'base64';
}

export function isMeriPhase4ArtifactValidateInputV1(
  value: unknown,
): value is MeriPhase4ArtifactValidateInputV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_ARTIFACT_STAGING_VERSION &&
    typeof row.operationId === 'string' && UUID.test(row.operationId) &&
    typeof row.tenantId === 'string' && UUID.test(row.tenantId) &&
    typeof row.runId === 'string' && UUID.test(row.runId) &&
    typeof row.workerRunId === 'string' && row.workerRunId.length > 0 &&
    row.workerRunId.length <= 120 &&
    typeof row.dispatchRequestSha256 === 'string' &&
    SHA256.test(row.dispatchRequestSha256) &&
    typeof row.scopeId === 'string' && row.scopeId.length > 0 &&
    typeof row.filename === 'string' && row.filename.length > 0 &&
    row.filename.length <= 255 &&
    typeof row.contentType === 'string' && row.contentType.length > 0 &&
    row.contentType.length <= 255 &&
    typeof row.contentLengthBytes === 'number' &&
    Number.isInteger(row.contentLengthBytes) &&
    row.contentLengthBytes > 0 &&
    row.contentLengthBytes <= MERI_PHASE4_MAX_ARTIFACT_BYTES &&
    typeof row.contentSha256 === 'string' && SHA256.test(row.contentSha256) &&
    (row.inputKind === 'text' || row.inputKind === 'base64');
}

// ── Upload lease ──

export interface MeriPhase4ArtifactUploadLeaseV1 {
  readonly version: typeof MERI_PHASE4_ARTIFACT_STAGING_VERSION;
  readonly operationId: string;
  readonly s3Key: string;
  readonly fenceToken: string;
  readonly expectedContentSha256: string;
  readonly grantedAtEpochMicros: string;
  readonly expiresAtEpochMicros: string;
}

export function isMeriPhase4ArtifactUploadLeaseV1(
  value: unknown,
): value is MeriPhase4ArtifactUploadLeaseV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_ARTIFACT_STAGING_VERSION &&
    typeof row.operationId === 'string' && UUID.test(row.operationId) &&
    typeof row.s3Key === 'string' && row.s3Key.length > 0 &&
    row.s3Key.startsWith('meri-phase4-staged/') &&
    typeof row.fenceToken === 'string' && UUID.test(row.fenceToken) &&
    typeof row.expectedContentSha256 === 'string' &&
    SHA256.test(row.expectedContentSha256) &&
    typeof row.grantedAtEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.grantedAtEpochMicros) &&
    typeof row.expiresAtEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.expiresAtEpochMicros) &&
    BigInt(row.grantedAtEpochMicros) < BigInt(row.expiresAtEpochMicros);
}

// ── Reconciliation ──

export interface MeriPhase4ArtifactReconciliationV1 {
  readonly version: typeof MERI_PHASE4_ARTIFACT_STAGING_VERSION;
  readonly operationId: string;
  readonly s3Key: string;
  readonly s3VersionId: string;
  readonly actualContentSha256: string;
  readonly actualContentLengthBytes: number;
  readonly expectedContentSha256: string;
  /** true if actual matches expected. */
  readonly digestMatch: boolean;
  readonly reconciledAtEpochMicros: string;
}

export function isMeriPhase4ArtifactReconciliationV1(
  value: unknown,
): value is MeriPhase4ArtifactReconciliationV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_ARTIFACT_STAGING_VERSION &&
    typeof row.operationId === 'string' && UUID.test(row.operationId) &&
    typeof row.s3Key === 'string' && row.s3Key.length > 0 &&
    typeof row.s3VersionId === 'string' && row.s3VersionId.length > 0 &&
    row.s3VersionId.length <= 1024 &&
    typeof row.actualContentSha256 === 'string' &&
    SHA256.test(row.actualContentSha256) &&
    typeof row.actualContentLengthBytes === 'number' &&
    Number.isInteger(row.actualContentLengthBytes) &&
    row.actualContentLengthBytes >= 0 &&
    typeof row.expectedContentSha256 === 'string' &&
    SHA256.test(row.expectedContentSha256) &&
    typeof row.digestMatch === 'boolean' &&
    typeof row.reconciledAtEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.reconciledAtEpochMicros);
}

// ── Finalization ──

/**
 * Atomically creates one database artifact and event for a selected
 * immutable S3 VersionId. The receipt proves one Capiro publication
 * and the selected version's exact bytes.
 */
export interface MeriPhase4ArtifactFinalizationV1 {
  readonly version: typeof MERI_PHASE4_ARTIFACT_STAGING_VERSION;
  readonly operationId: string;
  readonly artifactId: string;
  readonly s3Key: string;
  readonly s3VersionId: string;
  readonly contentSha256: string;
  readonly contentLengthBytes: number;
  readonly contentType: string;
  readonly filename: string;
  readonly finalizedAtEpochMicros: string;
  readonly signedClaimsSha256: string;
}

export function isMeriPhase4ArtifactFinalizationV1(
  value: unknown,
): value is MeriPhase4ArtifactFinalizationV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_ARTIFACT_STAGING_VERSION &&
    typeof row.operationId === 'string' && UUID.test(row.operationId) &&
    typeof row.artifactId === 'string' && UUID.test(row.artifactId) &&
    typeof row.s3Key === 'string' && row.s3Key.length > 0 &&
    typeof row.s3VersionId === 'string' && row.s3VersionId.length > 0 &&
    typeof row.contentSha256 === 'string' && SHA256.test(row.contentSha256) &&
    typeof row.contentLengthBytes === 'number' &&
    Number.isInteger(row.contentLengthBytes) &&
    row.contentLengthBytes > 0 &&
    typeof row.contentType === 'string' && row.contentType.length > 0 &&
    typeof row.filename === 'string' && row.filename.length > 0 &&
    typeof row.finalizedAtEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.finalizedAtEpochMicros) &&
    typeof row.signedClaimsSha256 === 'string' &&
    SHA256.test(row.signedClaimsSha256);
}

/**
 * Compute the signed claims SHA-256 for the artifact finalization receipt.
 */
export function meriPhase4ArtifactFinalizationClaimsSha256V1(
  operationId: string,
  artifactId: string,
  s3Key: string,
  s3VersionId: string,
  contentSha256: string,
  contentLengthBytes: number,
  finalizedAtEpochMicros: string,
): string {
  if (!UUID.test(operationId) || !UUID.test(artifactId) ||
      typeof s3Key !== 'string' || s3Key.length === 0 ||
      typeof s3VersionId !== 'string' || s3VersionId.length === 0 ||
      !SHA256.test(contentSha256) ||
      !Number.isInteger(contentLengthBytes) || contentLengthBytes <= 0 ||
      !POSITIVE_MICROS.test(finalizedAtEpochMicros)) {
    throw new Error('invalid artifact finalization claims input');
  }
  return createHash('sha256')
    .update([ARTIFACT_STAGING_DOMAIN, operationId, artifactId, s3Key,
      s3VersionId, contentSha256, String(contentLengthBytes),
      finalizedAtEpochMicros].join('\0'))
    .digest('hex');
}

// ── Cleanup obligation ──

export interface MeriPhase4ArtifactCleanupObligationV1 {
  readonly version: typeof MERI_PHASE4_ARTIFACT_STAGING_VERSION;
  readonly obligationId: string;
  readonly operationId: string;
  readonly s3Key: string;
  readonly s3VersionId: string;
  readonly reason: 'digest_mismatch' | 'orphaned_upload' | 'cancelled';
  readonly createdAtEpochMicros: string;
}

export function isMeriPhase4ArtifactCleanupObligationV1(
  value: unknown,
): value is MeriPhase4ArtifactCleanupObligationV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_ARTIFACT_STAGING_VERSION &&
    typeof row.obligationId === 'string' && UUID.test(row.obligationId) &&
    typeof row.operationId === 'string' && UUID.test(row.operationId) &&
    typeof row.s3Key === 'string' && row.s3Key.length > 0 &&
    typeof row.s3VersionId === 'string' && row.s3VersionId.length > 0 &&
    (row.reason === 'digest_mismatch' || row.reason === 'orphaned_upload' ||
     row.reason === 'cancelled') &&
    typeof row.createdAtEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.createdAtEpochMicros);
}
