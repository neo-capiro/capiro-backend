import { createHash } from 'node:crypto';
import {
  MERI_PHASE4_ARTIFACT_STAGING_VERSION,
  MERI_PHASE4_MAX_ARTIFACT_BYTES,
  meriPhase4ArtifactStagedKeyV1,
  isMeriPhase4ArtifactValidateInputV1,
  isMeriPhase4ArtifactUploadLeaseV1,
  isMeriPhase4ArtifactReconciliationV1,
  isMeriPhase4ArtifactFinalizationV1,
  meriPhase4ArtifactFinalizationClaimsSha256V1,
  isMeriPhase4ArtifactCleanupObligationV1,
} from './meri-hermes-phase4-artifact-staging.contract.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const operationId = '44444444-4444-4444-8444-444444444444';
const artifactId = '77777777-7777-4777-8777-777777777777';
const fenceToken = '55555555-5555-4555-8555-555555555555';
const scopeId = `tenant:${tenantId}:user:33333333-3333-4333-8333-333333333333`;
const sha = 'a'.repeat(64);
const now = String(Date.now() * 1000);
const later = String((Date.now() + 300_000) * 1000);

describe('Phase 4 artifact deterministic S3 key', () => {
  it('produces a key under the staged prefix', () => {
    const key = meriPhase4ArtifactStagedKeyV1(tenantId, operationId, 'report.pdf');
    expect(key).toBe(`meri-phase4-staged/${tenantId}/${operationId}/report.pdf`);
  });

  it('sanitizes unsafe filename characters', () => {
    const key = meriPhase4ArtifactStagedKeyV1(tenantId, operationId, 'my file (1).pdf');
    expect(key).toBe(`meri-phase4-staged/${tenantId}/${operationId}/my_file__1_.pdf`);
  });

  it('rejects invalid tenantId', () => {
    expect(() => meriPhase4ArtifactStagedKeyV1('bad', operationId, 'f.pdf'))
      .toThrow('invalid artifact key input');
  });

  it('rejects empty filename', () => {
    expect(() => meriPhase4ArtifactStagedKeyV1(tenantId, operationId, ''))
      .toThrow('invalid artifact key input');
  });
});

describe('Phase 4 artifact validate input', () => {
  const valid = {
    version: MERI_PHASE4_ARTIFACT_STAGING_VERSION,
    operationId, tenantId, runId,
    workerRunId: 'worker-run-1',
    dispatchRequestSha256: sha,
    scopeId,
    filename: 'report.pdf',
    contentType: 'application/pdf',
    contentLengthBytes: 1024,
    contentSha256: sha,
    inputKind: 'base64' as const,
  };

  it('validates a well-formed input', () => {
    expect(isMeriPhase4ArtifactValidateInputV1(valid)).toBe(true);
  });

  it('accepts text input kind', () => {
    expect(isMeriPhase4ArtifactValidateInputV1({
      ...valid, inputKind: 'text',
    })).toBe(true);
  });

  it('rejects zero content length', () => {
    expect(isMeriPhase4ArtifactValidateInputV1({
      ...valid, contentLengthBytes: 0,
    })).toBe(false);
  });

  it('rejects content exceeding max artifact bytes', () => {
    expect(isMeriPhase4ArtifactValidateInputV1({
      ...valid, contentLengthBytes: MERI_PHASE4_MAX_ARTIFACT_BYTES + 1,
    })).toBe(false);
  });

  it('rejects invalid input kind', () => {
    expect(isMeriPhase4ArtifactValidateInputV1({
      ...valid, inputKind: 'both',
    })).toBe(false);
  });

  it('rejects null and primitives', () => {
    expect(isMeriPhase4ArtifactValidateInputV1(null)).toBe(false);
    expect(isMeriPhase4ArtifactValidateInputV1(42)).toBe(false);
  });
});

describe('Phase 4 artifact upload lease', () => {
  const valid = {
    version: MERI_PHASE4_ARTIFACT_STAGING_VERSION,
    operationId,
    s3Key: `meri-phase4-staged/${tenantId}/${operationId}/report.pdf`,
    fenceToken,
    expectedContentSha256: sha,
    grantedAtEpochMicros: now,
    expiresAtEpochMicros: later,
  };

  it('validates a well-formed lease', () => {
    expect(isMeriPhase4ArtifactUploadLeaseV1(valid)).toBe(true);
  });

  it('rejects s3Key without staged prefix', () => {
    expect(isMeriPhase4ArtifactUploadLeaseV1({
      ...valid, s3Key: 'wrong-prefix/key',
    })).toBe(false);
  });

  it('rejects grantedAt >= expiresAt', () => {
    expect(isMeriPhase4ArtifactUploadLeaseV1({
      ...valid, grantedAtEpochMicros: later, expiresAtEpochMicros: now,
    })).toBe(false);
  });
});

describe('Phase 4 artifact reconciliation', () => {
  const valid = {
    version: MERI_PHASE4_ARTIFACT_STAGING_VERSION,
    operationId,
    s3Key: `meri-phase4-staged/${tenantId}/${operationId}/report.pdf`,
    s3VersionId: 'abc123',
    actualContentSha256: sha,
    actualContentLengthBytes: 1024,
    expectedContentSha256: sha,
    digestMatch: true,
    reconciledAtEpochMicros: now,
  };

  it('validates a matching reconciliation', () => {
    expect(isMeriPhase4ArtifactReconciliationV1(valid)).toBe(true);
  });

  it('validates a mismatched reconciliation', () => {
    expect(isMeriPhase4ArtifactReconciliationV1({
      ...valid, digestMatch: false, actualContentSha256: 'b'.repeat(64),
    })).toBe(true);
  });

  it('rejects empty s3VersionId', () => {
    expect(isMeriPhase4ArtifactReconciliationV1({
      ...valid, s3VersionId: '',
    })).toBe(false);
  });
});

describe('Phase 4 artifact finalization', () => {
  const valid = {
    version: MERI_PHASE4_ARTIFACT_STAGING_VERSION,
    operationId,
    artifactId,
    s3Key: `meri-phase4-staged/${tenantId}/${operationId}/report.pdf`,
    s3VersionId: 'abc123',
    contentSha256: sha,
    contentLengthBytes: 1024,
    contentType: 'application/pdf',
    filename: 'report.pdf',
    finalizedAtEpochMicros: now,
    signedClaimsSha256: sha,
  };

  it('validates a well-formed finalization', () => {
    expect(isMeriPhase4ArtifactFinalizationV1(valid)).toBe(true);
  });

  it('finalization claims SHA-256 is deterministic', () => {
    const a = meriPhase4ArtifactFinalizationClaimsSha256V1(
      operationId, artifactId, 'key', 'v1', sha, 1024, now,
    );
    const b = meriPhase4ArtifactFinalizationClaimsSha256V1(
      operationId, artifactId, 'key', 'v1', sha, 1024, now,
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different operations produce different claims', () => {
    const a = meriPhase4ArtifactFinalizationClaimsSha256V1(
      operationId, artifactId, 'key', 'v1', sha, 1024, now,
    );
    const b = meriPhase4ArtifactFinalizationClaimsSha256V1(
      '88888888-8888-4888-8888-888888888888', artifactId, 'key', 'v1', sha, 1024, now,
    );
    expect(a).not.toBe(b);
  });

  it('rejects invalid claims input', () => {
    expect(() => meriPhase4ArtifactFinalizationClaimsSha256V1(
      'bad', artifactId, 'key', 'v1', sha, 1024, now,
    )).toThrow('invalid artifact finalization claims input');
  });
});

describe('Phase 4 artifact cleanup obligation', () => {
  const valid = {
    version: MERI_PHASE4_ARTIFACT_STAGING_VERSION,
    obligationId: '99999999-9999-4999-8999-999999999999',
    operationId,
    s3Key: `meri-phase4-staged/${tenantId}/${operationId}/report.pdf`,
    s3VersionId: 'abc123',
    reason: 'digest_mismatch' as const,
    createdAtEpochMicros: now,
  };

  it('validates a well-formed obligation', () => {
    expect(isMeriPhase4ArtifactCleanupObligationV1(valid)).toBe(true);
  });

  it('accepts all cleanup reasons', () => {
    for (const reason of ['digest_mismatch', 'orphaned_upload', 'cancelled'] as const) {
      expect(isMeriPhase4ArtifactCleanupObligationV1({
        ...valid, reason,
      })).toBe(true);
    }
  });

  it('rejects invalid reason', () => {
    expect(isMeriPhase4ArtifactCleanupObligationV1({
      ...valid, reason: 'unknown',
    })).toBe(false);
  });
});
