import { createHash } from 'node:crypto';
import {
  MERI_PHASE4_READ_EFFECT_VERSION,
  isMeriPhase4ReadEffectPrepareInputV1,
  isMeriPhase4ReadEffectLeaseV1,
  meriPhase4ReadEffectLeaseSha256V1,
  isMeriPhase4ReadEffectResponseManifestV1,
  meriPhase4ReadEffectResponseSha256V1,
  isMeriPhase4ReadEffectSealV1,
  meriPhase4ReadEffectSealClaimsSha256V1,
  isMeriPhase4ReadEffectCancellationV1,
  type MeriPhase4ReadEffectPrepareInputV1,
  type MeriPhase4ReadEffectLeaseV1,
  type MeriPhase4ReadEffectResponseManifestV1,
  type MeriPhase4ReadEffectSealV1,
  type MeriPhase4ReadEffectCancellationV1,
} from './meri-hermes-phase4-read-effect-saga.contract.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const operationId = '44444444-4444-4444-8444-444444444444';
const fenceToken = '55555555-5555-4555-8555-555555555555';
const scopeId = `tenant:${tenantId}:user:33333333-3333-4333-8333-333333333333`;
const sha = 'a'.repeat(64);
const now = String(Date.now() * 1000);
const later = String((Date.now() + 300_000) * 1000);

function validPrepareInput(): MeriPhase4ReadEffectPrepareInputV1 {
  return {
    version: MERI_PHASE4_READ_EFFECT_VERSION,
    operationId,
    tenantId,
    runId,
    workerRunId: 'worker-run-1',
    dispatchRequestSha256: sha,
    scopeId,
    tool: 'meri_memory_search',
    requestParamsSha256: sha,
  };
}

describe('Phase 4 read-effect prepare input', () => {
  it('validates a well-formed input', () => {
    expect(isMeriPhase4ReadEffectPrepareInputV1(validPrepareInput())).toBe(true);
  });

  it('accepts both tool types', () => {
    expect(isMeriPhase4ReadEffectPrepareInputV1({
      ...validPrepareInput(), tool: 'meri_fetch_attachment',
    })).toBe(true);
  });

  it('rejects invalid tool', () => {
    expect(isMeriPhase4ReadEffectPrepareInputV1({
      ...validPrepareInput(), tool: 'meri_propose_memory',
    })).toBe(false);
  });

  it('rejects invalid operationId', () => {
    expect(isMeriPhase4ReadEffectPrepareInputV1({
      ...validPrepareInput(), operationId: 'bad',
    })).toBe(false);
  });

  it('rejects null and primitives', () => {
    expect(isMeriPhase4ReadEffectPrepareInputV1(null)).toBe(false);
    expect(isMeriPhase4ReadEffectPrepareInputV1(42)).toBe(false);
    expect(isMeriPhase4ReadEffectPrepareInputV1([])).toBe(false);
  });
});

describe('Phase 4 read-effect fenced lease', () => {
  const validLease: MeriPhase4ReadEffectLeaseV1 = {
    version: MERI_PHASE4_READ_EFFECT_VERSION,
    operationId,
    fenceToken,
    leaseSha256: meriPhase4ReadEffectLeaseSha256V1(operationId, fenceToken, now),
    grantedAtEpochMicros: now,
    expiresAtEpochMicros: later,
  };

  it('validates a well-formed lease', () => {
    expect(isMeriPhase4ReadEffectLeaseV1(validLease)).toBe(true);
  });

  it('rejects grantedAt >= expiresAt', () => {
    expect(isMeriPhase4ReadEffectLeaseV1({
      ...validLease,
      grantedAtEpochMicros: later,
      expiresAtEpochMicros: now,
    })).toBe(false);
  });

  it('lease SHA-256 is deterministic', () => {
    const a = meriPhase4ReadEffectLeaseSha256V1(operationId, fenceToken, now);
    const b = meriPhase4ReadEffectLeaseSha256V1(operationId, fenceToken, now);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different fence tokens produce different lease digests', () => {
    const a = meriPhase4ReadEffectLeaseSha256V1(operationId, fenceToken, now);
    const b = meriPhase4ReadEffectLeaseSha256V1(operationId,
      '66666666-6666-4666-8666-666666666666', now);
    expect(a).not.toBe(b);
  });

  it('rejects invalid lease input', () => {
    expect(() => meriPhase4ReadEffectLeaseSha256V1('bad', fenceToken, now))
      .toThrow('invalid lease input');
  });
});

describe('Phase 4 read-effect response manifest', () => {
  const validManifest: MeriPhase4ReadEffectResponseManifestV1 = {
    version: MERI_PHASE4_READ_EFFECT_VERSION,
    tool: 'meri_memory_search',
    responseSha256: sha,
    responseLengthBytes: 1024,
    hasContent: true,
    contentStatus: null,
    resultCount: 5,
  };

  it('validates a well-formed manifest for memory search', () => {
    expect(isMeriPhase4ReadEffectResponseManifestV1(validManifest)).toBe(true);
  });

  it('validates a manifest for fetch attachment', () => {
    expect(isMeriPhase4ReadEffectResponseManifestV1({
      ...validManifest,
      tool: 'meri_fetch_attachment',
      contentStatus: 'readable',
      resultCount: null,
    })).toBe(true);
  });

  it('rejects negative response length', () => {
    expect(isMeriPhase4ReadEffectResponseManifestV1({
      ...validManifest, responseLengthBytes: -1,
    })).toBe(false);
  });

  it('rejects negative result count', () => {
    expect(isMeriPhase4ReadEffectResponseManifestV1({
      ...validManifest, resultCount: -1,
    })).toBe(false);
  });
});

describe('Phase 4 read-effect response SHA-256', () => {
  it('computes SHA-256 of response bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = meriPhase4ReadEffectResponseSha256V1(bytes);
    expect(result).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});

describe('Phase 4 read-effect seal', () => {
  const manifestSha = createHash('sha256').update('manifest').digest('hex');
  const leaseSha = meriPhase4ReadEffectLeaseSha256V1(operationId, fenceToken, now);
  const claimsSha = meriPhase4ReadEffectSealClaimsSha256V1(
    operationId, 'meri_memory_search', sha, sha, manifestSha, leaseSha, now,
  );

  const validSeal: MeriPhase4ReadEffectSealV1 = {
    version: MERI_PHASE4_READ_EFFECT_VERSION,
    operationId,
    tool: 'meri_memory_search',
    stage: 'sealed',
    requestParamsSha256: sha,
    responseSha256: sha,
    manifestSha256: manifestSha,
    leaseSha256: leaseSha,
    sealedAtEpochMicros: now,
    signedClaimsSha256: claimsSha,
  };

  it('validates a well-formed seal', () => {
    expect(isMeriPhase4ReadEffectSealV1(validSeal)).toBe(true);
  });

  it('seal claims SHA-256 is deterministic', () => {
    const a = meriPhase4ReadEffectSealClaimsSha256V1(
      operationId, 'meri_memory_search', sha, sha, manifestSha, leaseSha, now,
    );
    const b = meriPhase4ReadEffectSealClaimsSha256V1(
      operationId, 'meri_memory_search', sha, sha, manifestSha, leaseSha, now,
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different operations produce different claims', () => {
    const a = meriPhase4ReadEffectSealClaimsSha256V1(
      operationId, 'meri_memory_search', sha, sha, manifestSha, leaseSha, now,
    );
    const b = meriPhase4ReadEffectSealClaimsSha256V1(
      '77777777-7777-4777-8777-777777777777', 'meri_memory_search',
      sha, sha, manifestSha, leaseSha, now,
    );
    expect(a).not.toBe(b);
  });

  it('different tools produce different claims', () => {
    const a = meriPhase4ReadEffectSealClaimsSha256V1(
      operationId, 'meri_memory_search', sha, sha, manifestSha, leaseSha, now,
    );
    const b = meriPhase4ReadEffectSealClaimsSha256V1(
      operationId, 'meri_fetch_attachment', sha, sha, manifestSha, leaseSha, now,
    );
    expect(a).not.toBe(b);
  });

  it('rejects invalid seal claims input', () => {
    expect(() => meriPhase4ReadEffectSealClaimsSha256V1(
      'bad', 'meri_memory_search', sha, sha, manifestSha, leaseSha, now,
    )).toThrow('invalid seal claims input');
  });
});

describe('Phase 4 read-effect cancellation', () => {
  const validCancellation: MeriPhase4ReadEffectCancellationV1 = {
    version: MERI_PHASE4_READ_EFFECT_VERSION,
    operationId,
    stage: 'cancelled',
    reason: 'timeout',
    cancelledAtEpochMicros: now,
  };

  it('validates a well-formed cancellation', () => {
    expect(isMeriPhase4ReadEffectCancellationV1(validCancellation)).toBe(true);
  });

  it('accepts all cancellation reasons', () => {
    const reasons = ['timeout', 'stop_requested', 'lease_expired',
      'authority_revoked', 'execution_error'] as const;
    for (const reason of reasons) {
      expect(isMeriPhase4ReadEffectCancellationV1({
        ...validCancellation, reason,
      })).toBe(true);
    }
  });

  it('rejects invalid reason', () => {
    expect(isMeriPhase4ReadEffectCancellationV1({
      ...validCancellation, reason: 'unknown',
    })).toBe(false);
  });

  it('rejects wrong stage', () => {
    expect(isMeriPhase4ReadEffectCancellationV1({
      ...validCancellation, stage: 'sealed',
    })).toBe(false);
  });
});
