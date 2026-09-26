import { createHash, createPublicKey, verify } from 'node:crypto';

/**
 * Phase 4 qualified signing and verification pipeline contract (item 4).
 *
 * Provides the types and pure functions for:
 * - immutable Ed25519 public-key registry with activate/retire/revoke lifecycle;
 * - durable signing requests (claims digest + tenant/scope qualification);
 * - append-only signature submissions from the signer task;
 * - verifier-produced attestations with an `attestation_id` primary key;
 * - deterministic latest-unexpired selection by claims digest;
 * - separate memberless capability roles: signer, verifier, key-admin.
 *
 * The signer signs the raw 32-byte SHA-256 digest, not ASCII hex.
 * Never reuse `MERI_HERMES_BROKER_SIGNING_KEY` (unrelated HMAC credential).
 * The API and ordinary broker/recovery/route roles get no signing-table DML.
 */

// ── Domain constants ──

const SIGNING_DOMAIN =
  'capiro.meri.phase4.signing-pipeline/v1' as const;
const QUALIFICATION_DOMAIN =
  'capiro.meri.phase4.signing-qualification/v1' as const;

export const MERI_PHASE4_SIGNING_VERSION = 1 as const;

/** Signer: reads private key from Secrets Manager, signs digests. */
export const MERI_PHASE4_SIGNER_ROLE = 'meri_phase4_broker_signer' as const;
/** Verifier: reads public key from registry, verifies signatures. */
export const MERI_PHASE4_VERIFIER_ROLE =
  'meri_phase4_broker_signer_owner' as const;
/** Key admin: manages key registry lifecycle events. */
export const MERI_PHASE4_KEY_ADMIN_ROLE =
  'meri_phase4_signing_key_admin' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const POSITIVE_MICROS = /^[1-9][0-9]{0,18}$/;
const ED25519_SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const MAX_PUBLIC_KEY_BYTES = 512;

// ── Key lifecycle ──

export type MeriPhase4KeyLifecycleState =
  | 'pending'    // created but not yet activated
  | 'active'     // available for signing
  | 'retired'    // no longer used for new signatures, still valid for verification
  | 'revoked';   // compromised or invalid, all attestations with this key are suspect

export interface MeriPhase4SigningKeyRegistryEntryV1 {
  readonly version: typeof MERI_PHASE4_SIGNING_VERSION;
  readonly keyId: string;
  readonly publicKeySpkiDer: Uint8Array;
  readonly publicKeySpkiSha256: string;
  readonly algorithm: 'Ed25519';
  readonly state: MeriPhase4KeyLifecycleState;
  readonly notBeforeEpochMicros: string;
  readonly notAfterEpochMicros: string;
  readonly createdAtEpochMicros: string;
}

export function isMeriPhase4SigningKeyRegistryEntryV1(
  value: unknown,
): value is MeriPhase4SigningKeyRegistryEntryV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_SIGNING_VERSION &&
    typeof row.keyId === 'string' && KEY_ID.test(row.keyId) &&
    row.publicKeySpkiDer instanceof Uint8Array &&
    row.publicKeySpkiDer.length >= 32 &&
    row.publicKeySpkiDer.length <= MAX_PUBLIC_KEY_BYTES &&
    typeof row.publicKeySpkiSha256 === 'string' &&
    SHA256.test(row.publicKeySpkiSha256) &&
    row.algorithm === 'Ed25519' &&
    (row.state === 'pending' || row.state === 'active' ||
     row.state === 'retired' || row.state === 'revoked') &&
    typeof row.notBeforeEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.notBeforeEpochMicros) &&
    typeof row.notAfterEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.notAfterEpochMicros) &&
    BigInt(row.notBeforeEpochMicros) < BigInt(row.notAfterEpochMicros) &&
    typeof row.createdAtEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.createdAtEpochMicros);
}

export function validateSigningKeyPublicMaterial(
  publicKeySpkiDer: Uint8Array,
): { valid: true; sha256: string } | { valid: false; reason: string } {
  if (!(publicKeySpkiDer instanceof Uint8Array) ||
      publicKeySpkiDer.length < 32 ||
      publicKeySpkiDer.length > MAX_PUBLIC_KEY_BYTES) {
    return { valid: false, reason: 'invalid public key byte length' };
  }
  try {
    const pk = createPublicKey({
      key: Buffer.from(publicKeySpkiDer), format: 'der', type: 'spki',
    });
    if (pk.asymmetricKeyType !== 'ed25519' ||
        pk.type !== 'public') {
      return { valid: false, reason: 'not an Ed25519 public key' };
    }
  } catch {
    return { valid: false, reason: 'failed to parse DER SubjectPublicKeyInfo' };
  }
  const sha256 = createHash('sha256').update(publicKeySpkiDer).digest('hex');
  return { valid: true, sha256 };
}

// ── Key lifecycle event ──

export type MeriPhase4KeyLifecycleEventKind =
  | 'activated' | 'retired' | 'revoked';

export interface MeriPhase4KeyLifecycleEventV1 {
  readonly version: typeof MERI_PHASE4_SIGNING_VERSION;
  readonly eventId: string;
  readonly keyId: string;
  readonly kind: MeriPhase4KeyLifecycleEventKind;
  readonly reason: string;
  readonly occurredAtEpochMicros: string;
}

export function isMeriPhase4KeyLifecycleEventV1(
  value: unknown,
): value is MeriPhase4KeyLifecycleEventV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_SIGNING_VERSION &&
    typeof row.eventId === 'string' && UUID.test(row.eventId) &&
    typeof row.keyId === 'string' && KEY_ID.test(row.keyId) &&
    (row.kind === 'activated' || row.kind === 'retired' ||
     row.kind === 'revoked') &&
    typeof row.reason === 'string' && row.reason.length > 0 &&
    row.reason.length <= 500 &&
    typeof row.occurredAtEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.occurredAtEpochMicros);
}

// ── Tenant/scope qualification digest ──

/**
 * Deterministic qualification digest binding a signing key to a specific
 * tenant, scope, and purpose. This prevents a key qualified for one
 * tenant from being used to forge attestations for another.
 */
export function meriPhase4QualificationSha256V1(
  keyId: string,
  tenantId: string,
  scopeId: string,
  purpose: string,
): string {
  if (!KEY_ID.test(keyId) || !UUID.test(tenantId) ||
      typeof scopeId !== 'string' || scopeId.length === 0 ||
      typeof purpose !== 'string' || purpose.length === 0) {
    throw new Error('invalid qualification input');
  }
  return createHash('sha256')
    .update([QUALIFICATION_DOMAIN, keyId, tenantId, scopeId, purpose].join('\0'))
    .digest('hex');
}

// ── Signing request ──

export interface MeriPhase4SigningRequestV1 {
  readonly version: typeof MERI_PHASE4_SIGNING_VERSION;
  readonly requestId: string;
  readonly claimsSha256: string;
  readonly qualificationSha256: string;
  readonly keyId: string;
  readonly requestedAtEpochMicros: string;
  /** DB-clock deadline after which the signer must not sign. */
  readonly signByEpochMicros: string;
}

export function isMeriPhase4SigningRequestV1(
  value: unknown,
): value is MeriPhase4SigningRequestV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_SIGNING_VERSION &&
    typeof row.requestId === 'string' && UUID.test(row.requestId) &&
    typeof row.claimsSha256 === 'string' && SHA256.test(row.claimsSha256) &&
    typeof row.qualificationSha256 === 'string' &&
    SHA256.test(row.qualificationSha256) &&
    typeof row.keyId === 'string' && KEY_ID.test(row.keyId) &&
    typeof row.requestedAtEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.requestedAtEpochMicros) &&
    typeof row.signByEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.signByEpochMicros) &&
    BigInt(row.requestedAtEpochMicros) < BigInt(row.signByEpochMicros);
}

// ── Signature submission ──

/**
 * The signer task produces this after reading the private key from
 * Secrets Manager and signing the raw 32-byte SHA-256 digest (not hex).
 */
export interface MeriPhase4SignatureSubmissionV1 {
  readonly version: typeof MERI_PHASE4_SIGNING_VERSION;
  readonly requestId: string;
  readonly keyId: string;
  readonly signature: string;
  readonly signedAtEpochMicros: string;
}

export function isMeriPhase4SignatureSubmissionV1(
  value: unknown,
): value is MeriPhase4SignatureSubmissionV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_SIGNING_VERSION &&
    typeof row.requestId === 'string' && UUID.test(row.requestId) &&
    typeof row.keyId === 'string' && KEY_ID.test(row.keyId) &&
    typeof row.signature === 'string' &&
    ED25519_SIGNATURE.test(row.signature) &&
    typeof row.signedAtEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.signedAtEpochMicros);
}

// ── Attestation (verifier output) ──

/**
 * Verifier-produced attestation with an `attestation_id` UUID primary key.
 * Replaces the previous `claims_sha256` primary key which prevented
 * refreshing the same claims after the five-minute attestation expired.
 * Multiple attestations may exist for the same claims digest; the latest
 * unexpired one is selected deterministically.
 */
export interface MeriPhase4AttestationV1 {
  readonly version: typeof MERI_PHASE4_SIGNING_VERSION;
  readonly attestationId: string;
  readonly claimsSha256: string;
  readonly signerKeyId: string;
  readonly signature: string;
  readonly verificationMethod: 'Ed25519-SPKI-SHA256';
  readonly qualificationSha256: string;
  readonly verifiedAtEpochMicros: string;
  readonly expiresAtEpochMicros: string;
}

export function isMeriPhase4AttestationV1(
  value: unknown,
): value is MeriPhase4AttestationV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_PHASE4_SIGNING_VERSION &&
    typeof row.attestationId === 'string' && UUID.test(row.attestationId) &&
    typeof row.claimsSha256 === 'string' && SHA256.test(row.claimsSha256) &&
    typeof row.signerKeyId === 'string' && KEY_ID.test(row.signerKeyId) &&
    typeof row.signature === 'string' &&
    ED25519_SIGNATURE.test(row.signature) &&
    row.verificationMethod === 'Ed25519-SPKI-SHA256' &&
    typeof row.qualificationSha256 === 'string' &&
    SHA256.test(row.qualificationSha256) &&
    typeof row.verifiedAtEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.verifiedAtEpochMicros) &&
    typeof row.expiresAtEpochMicros === 'string' &&
    POSITIVE_MICROS.test(row.expiresAtEpochMicros) &&
    BigInt(row.verifiedAtEpochMicros) < BigInt(row.expiresAtEpochMicros);
}

/**
 * Verify an Ed25519 signature over the raw 32-byte SHA-256 digest.
 * The signer signs `Buffer.from(claimsSha256, 'hex')` (32 bytes),
 * NOT the ASCII hex string.
 */
export function verifyMeriPhase4SignatureV1(
  claimsSha256: string,
  signatureBase64url: string,
  publicKeySpkiDer: Uint8Array,
): boolean {
  if (!SHA256.test(claimsSha256) ||
      !ED25519_SIGNATURE.test(signatureBase64url)) {
    return false;
  }
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeySpkiDer), format: 'der', type: 'spki',
    });
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    const data = Buffer.from(claimsSha256, 'hex');
    const sig = Buffer.from(signatureBase64url, 'base64url');
    return verify(null, data, publicKey, sig);
  } catch {
    return false;
  }
}

/**
 * Sign the raw 32-byte SHA-256 digest with an Ed25519 private key.
 * Returns the signature as base64url. Used ONLY by the signer task.
 */
export function signMeriPhase4DigestV1(
  claimsSha256: string,
  privateKeyPkcs8Der: Uint8Array,
): string {
  if (!SHA256.test(claimsSha256)) {
    throw new Error('invalid claims SHA-256 for signing');
  }
  // Import is done here to avoid importing createPrivateKey in the
  // verifier/API process which should never see private key material.
  const { createPrivateKey, sign: cryptoSign } = require('node:crypto');
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyPkcs8Der), format: 'der', type: 'pkcs8',
  });
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('not an Ed25519 private key');
  }
  const data = Buffer.from(claimsSha256, 'hex');
  const sig = cryptoSign(null, data, privateKey);
  return Buffer.from(sig).toString('base64url');
}

// ── Disposition types ──

/**
 * The signing pipeline status for an effect. Used by the broker to
 * determine whether to proceed with the effect or wait.
 */
export type MeriPhase4SigningDisposition =
  | 'signature_pending'   // signing request submitted, awaiting signer
  | 'signature_submitted' // signer produced a signature, awaiting verifier
  | 'attested'            // verifier confirmed the signature
  | 'quarantined'         // signature verification failed
  | 'signing_unavailable' // no active key or signer is down
  | 'key_revoked';        // key was revoked after signing

/**
 * Missing or revoked signing authority must produce zero budget/domain/event
 * effects. `signature_pending` is distinct from `effect_unknown`.
 */
export function isSigningBlocker(
  disposition: MeriPhase4SigningDisposition,
): boolean {
  return disposition === 'signing_unavailable' ||
    disposition === 'key_revoked' ||
    disposition === 'quarantined';
}
