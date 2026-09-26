import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  MERI_PHASE4_SIGNING_VERSION,
  MERI_PHASE4_SIGNER_ROLE,
  MERI_PHASE4_VERIFIER_ROLE,
  MERI_PHASE4_KEY_ADMIN_ROLE,
  isMeriPhase4SigningKeyRegistryEntryV1,
  validateSigningKeyPublicMaterial,
  isMeriPhase4KeyLifecycleEventV1,
  meriPhase4QualificationSha256V1,
  isMeriPhase4SigningRequestV1,
  isMeriPhase4SignatureSubmissionV1,
  isMeriPhase4AttestationV1,
  verifyMeriPhase4SignatureV1,
  signMeriPhase4DigestV1,
  isSigningBlocker,
  type MeriPhase4SigningKeyRegistryEntryV1,
  type MeriPhase4KeyLifecycleEventV1,
  type MeriPhase4SigningRequestV1,
  type MeriPhase4SignatureSubmissionV1,
  type MeriPhase4AttestationV1,
  type MeriPhase4SigningDisposition,
} from './meri-hermes-phase4-signing-pipeline.contract.js';

// Generate a real Ed25519 keypair for testing
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
const privateKeyDer = privateKey.export({ format: 'der', type: 'pkcs8' });
const publicKeySha256 = createHash('sha256').update(publicKeyDer).digest('hex');

const tenantId = '11111111-1111-4111-8111-111111111111';
const scopeId = `tenant:${tenantId}:user:33333333-3333-4333-8333-333333333333`;
const keyId = 'meri-phase4-signer-key-001';
const claimsSha256 = createHash('sha256').update('test-claims').digest('hex');
const now = String(Date.now() * 1000);
const later = String((Date.now() + 300_000) * 1000);
const farLater = String((Date.now() + 86_400_000) * 1000);

function validKeyEntry(): MeriPhase4SigningKeyRegistryEntryV1 {
  return {
    version: MERI_PHASE4_SIGNING_VERSION,
    keyId,
    publicKeySpkiDer: new Uint8Array(publicKeyDer),
    publicKeySpkiSha256: publicKeySha256,
    algorithm: 'Ed25519',
    state: 'active',
    notBeforeEpochMicros: now,
    notAfterEpochMicros: farLater,
    createdAtEpochMicros: now,
  };
}

describe('Phase 4 signing pipeline role constants', () => {
  it('exports the three capability roles', () => {
    expect(MERI_PHASE4_SIGNER_ROLE).toBe('meri_phase4_broker_signer');
    expect(MERI_PHASE4_VERIFIER_ROLE).toBe('meri_phase4_broker_signer_owner');
    expect(MERI_PHASE4_KEY_ADMIN_ROLE).toBe('meri_phase4_signing_key_admin');
  });
});

describe('Phase 4 key registry entry', () => {
  it('validates a well-formed entry', () => {
    expect(isMeriPhase4SigningKeyRegistryEntryV1(validKeyEntry())).toBe(true);
  });

  it('rejects null, primitives, arrays', () => {
    expect(isMeriPhase4SigningKeyRegistryEntryV1(null)).toBe(false);
    expect(isMeriPhase4SigningKeyRegistryEntryV1(42)).toBe(false);
    expect(isMeriPhase4SigningKeyRegistryEntryV1([])).toBe(false);
  });

  it('rejects invalid key ID', () => {
    expect(isMeriPhase4SigningKeyRegistryEntryV1({
      ...validKeyEntry(), keyId: '',
    })).toBe(false);
  });

  it('rejects invalid algorithm', () => {
    expect(isMeriPhase4SigningKeyRegistryEntryV1({
      ...validKeyEntry(), algorithm: 'RSA',
    })).toBe(false);
  });

  it('rejects invalid lifecycle state', () => {
    expect(isMeriPhase4SigningKeyRegistryEntryV1({
      ...validKeyEntry(), state: 'expired',
    })).toBe(false);
  });

  it('accepts all four lifecycle states', () => {
    for (const state of ['pending', 'active', 'retired', 'revoked'] as const) {
      expect(isMeriPhase4SigningKeyRegistryEntryV1({
        ...validKeyEntry(), state,
      })).toBe(true);
    }
  });

  it('rejects notBefore >= notAfter', () => {
    expect(isMeriPhase4SigningKeyRegistryEntryV1({
      ...validKeyEntry(),
      notBeforeEpochMicros: farLater,
      notAfterEpochMicros: now,
    })).toBe(false);
  });

  it('rejects short public key', () => {
    expect(isMeriPhase4SigningKeyRegistryEntryV1({
      ...validKeyEntry(),
      publicKeySpkiDer: new Uint8Array(10),
      publicKeySpkiSha256: createHash('sha256').update(new Uint8Array(10)).digest('hex'),
    })).toBe(false);
  });
});

describe('Phase 4 public key validation', () => {
  it('accepts a real Ed25519 public key', () => {
    const result = validateSigningKeyPublicMaterial(new Uint8Array(publicKeyDer));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.sha256).toBe(publicKeySha256);
    }
  });

  it('rejects too-short bytes', () => {
    const result = validateSigningKeyPublicMaterial(new Uint8Array(10));
    expect(result.valid).toBe(false);
  });

  it('rejects garbage bytes', () => {
    const garbage = new Uint8Array(44);
    garbage.fill(0xff);
    const result = validateSigningKeyPublicMaterial(garbage);
    expect(result.valid).toBe(false);
  });
});

describe('Phase 4 key lifecycle event', () => {
  const validEvent: MeriPhase4KeyLifecycleEventV1 = {
    version: MERI_PHASE4_SIGNING_VERSION,
    eventId: '44444444-4444-4444-8444-444444444444',
    keyId,
    kind: 'activated',
    reason: 'Initial activation for Phase 4 broker effects',
    occurredAtEpochMicros: now,
  };

  it('validates a well-formed event', () => {
    expect(isMeriPhase4KeyLifecycleEventV1(validEvent)).toBe(true);
  });

  it('accepts all three event kinds', () => {
    for (const kind of ['activated', 'retired', 'revoked'] as const) {
      expect(isMeriPhase4KeyLifecycleEventV1({ ...validEvent, kind })).toBe(true);
    }
  });

  it('rejects empty reason', () => {
    expect(isMeriPhase4KeyLifecycleEventV1({ ...validEvent, reason: '' })).toBe(false);
  });

  it('rejects invalid event ID', () => {
    expect(isMeriPhase4KeyLifecycleEventV1({ ...validEvent, eventId: 'bad' })).toBe(false);
  });
});

describe('Phase 4 qualification digest', () => {
  it('produces a deterministic SHA-256', () => {
    const a = meriPhase4QualificationSha256V1(keyId, tenantId, scopeId, 'meri-phase4-broker-effect-receipt-v1');
    const b = meriPhase4QualificationSha256V1(keyId, tenantId, scopeId, 'meri-phase4-broker-effect-receipt-v1');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different tenants produce different digests', () => {
    const a = meriPhase4QualificationSha256V1(keyId, tenantId, scopeId, 'purpose');
    const b = meriPhase4QualificationSha256V1(keyId, '22222222-2222-4222-8222-222222222222', scopeId, 'purpose');
    expect(a).not.toBe(b);
  });

  it('different keys produce different digests', () => {
    const a = meriPhase4QualificationSha256V1(keyId, tenantId, scopeId, 'purpose');
    const b = meriPhase4QualificationSha256V1('other-key-002', tenantId, scopeId, 'purpose');
    expect(a).not.toBe(b);
  });

  it('rejects invalid inputs', () => {
    expect(() => meriPhase4QualificationSha256V1('', tenantId, scopeId, 'purpose'))
      .toThrow('invalid qualification input');
    expect(() => meriPhase4QualificationSha256V1(keyId, 'bad', scopeId, 'purpose'))
      .toThrow('invalid qualification input');
  });
});

describe('Phase 4 signing request', () => {
  const validRequest: MeriPhase4SigningRequestV1 = {
    version: MERI_PHASE4_SIGNING_VERSION,
    requestId: '55555555-5555-4555-8555-555555555555',
    claimsSha256,
    qualificationSha256: meriPhase4QualificationSha256V1(keyId, tenantId, scopeId, 'purpose'),
    keyId,
    requestedAtEpochMicros: now,
    signByEpochMicros: later,
  };

  it('validates a well-formed request', () => {
    expect(isMeriPhase4SigningRequestV1(validRequest)).toBe(true);
  });

  it('rejects requestedAt >= signBy', () => {
    expect(isMeriPhase4SigningRequestV1({
      ...validRequest,
      requestedAtEpochMicros: later,
      signByEpochMicros: now,
    })).toBe(false);
  });

  it('rejects invalid claims SHA-256', () => {
    expect(isMeriPhase4SigningRequestV1({
      ...validRequest, claimsSha256: 'short',
    })).toBe(false);
  });
});

describe('Phase 4 signature submission', () => {
  // Sign a real digest to get a valid signature
  const data = Buffer.from(claimsSha256, 'hex');
  const sig = cryptoSign(null, data, privateKey);
  const signatureBase64url = sig.toString('base64url');

  const validSubmission: MeriPhase4SignatureSubmissionV1 = {
    version: MERI_PHASE4_SIGNING_VERSION,
    requestId: '55555555-5555-4555-8555-555555555555',
    keyId,
    signature: signatureBase64url,
    signedAtEpochMicros: now,
  };

  it('validates a well-formed submission', () => {
    expect(isMeriPhase4SignatureSubmissionV1(validSubmission)).toBe(true);
  });

  it('rejects invalid signature format', () => {
    expect(isMeriPhase4SignatureSubmissionV1({
      ...validSubmission, signature: 'not-base64url',
    })).toBe(false);
  });
});

describe('Phase 4 attestation', () => {
  const data = Buffer.from(claimsSha256, 'hex');
  const sig = cryptoSign(null, data, privateKey);
  const signatureBase64url = sig.toString('base64url');

  const validAttestation: MeriPhase4AttestationV1 = {
    version: MERI_PHASE4_SIGNING_VERSION,
    attestationId: '66666666-6666-4666-8666-666666666666',
    claimsSha256,
    signerKeyId: keyId,
    signature: signatureBase64url,
    verificationMethod: 'Ed25519-SPKI-SHA256',
    qualificationSha256: meriPhase4QualificationSha256V1(keyId, tenantId, scopeId, 'purpose'),
    verifiedAtEpochMicros: now,
    expiresAtEpochMicros: later,
  };

  it('validates a well-formed attestation', () => {
    expect(isMeriPhase4AttestationV1(validAttestation)).toBe(true);
  });

  it('has attestation_id primary key (UUID), not claims_sha256', () => {
    expect(validAttestation.attestationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('rejects verifiedAt >= expiresAt', () => {
    expect(isMeriPhase4AttestationV1({
      ...validAttestation,
      verifiedAtEpochMicros: later,
      expiresAtEpochMicros: now,
    })).toBe(false);
  });

  it('rejects invalid verification method', () => {
    expect(isMeriPhase4AttestationV1({
      ...validAttestation, verificationMethod: 'RSA-SHA256',
    })).toBe(false);
  });
});

describe('Phase 4 Ed25519 sign and verify', () => {
  it('round-trips: sign then verify succeeds', () => {
    const signature = signMeriPhase4DigestV1(
      claimsSha256, new Uint8Array(privateKeyDer),
    );
    expect(signature).toMatch(/^[A-Za-z0-9_-]{85}[AQgw]$/);
    expect(verifyMeriPhase4SignatureV1(
      claimsSha256, signature, new Uint8Array(publicKeyDer),
    )).toBe(true);
  });

  it('rejects a tampered digest', () => {
    const signature = signMeriPhase4DigestV1(
      claimsSha256, new Uint8Array(privateKeyDer),
    );
    const tamperedDigest = createHash('sha256').update('tampered').digest('hex');
    expect(verifyMeriPhase4SignatureV1(
      tamperedDigest, signature, new Uint8Array(publicKeyDer),
    )).toBe(false);
  });

  it('rejects a wrong public key', () => {
    const signature = signMeriPhase4DigestV1(
      claimsSha256, new Uint8Array(privateKeyDer),
    );
    const { publicKey: otherPub } = generateKeyPairSync('ed25519');
    const otherPubDer = otherPub.export({ format: 'der', type: 'spki' });
    expect(verifyMeriPhase4SignatureV1(
      claimsSha256, signature, new Uint8Array(otherPubDer),
    )).toBe(false);
  });

  it('rejects invalid digest for signing', () => {
    expect(() => signMeriPhase4DigestV1(
      'short', new Uint8Array(privateKeyDer),
    )).toThrow('invalid claims SHA-256');
  });

  it('verify returns false for garbage signature', () => {
    expect(verifyMeriPhase4SignatureV1(
      claimsSha256, 'not-valid', new Uint8Array(publicKeyDer),
    )).toBe(false);
  });

  it('verify returns false for garbage public key', () => {
    const signature = signMeriPhase4DigestV1(
      claimsSha256, new Uint8Array(privateKeyDer),
    );
    const garbage = new Uint8Array(44);
    garbage.fill(0xff);
    expect(verifyMeriPhase4SignatureV1(claimsSha256, signature, garbage)).toBe(false);
  });
});

describe('Phase 4 signing disposition', () => {
  it('identifies blockers correctly', () => {
    const blockers: MeriPhase4SigningDisposition[] = [
      'signing_unavailable', 'key_revoked', 'quarantined',
    ];
    const nonBlockers: MeriPhase4SigningDisposition[] = [
      'signature_pending', 'signature_submitted', 'attested',
    ];
    for (const d of blockers) expect(isSigningBlocker(d)).toBe(true);
    for (const d of nonBlockers) expect(isSigningBlocker(d)).toBe(false);
  });
});
