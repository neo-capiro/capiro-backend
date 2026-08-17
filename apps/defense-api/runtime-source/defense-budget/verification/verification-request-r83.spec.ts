import { verificationRequestV1Schema } from './verification-contract-v1.js';

describe('R8.3 verification request replay contract', () => {
  const validRequest = {
    manifestLocator: '/tmp/manifest.json',
    manifestDocumentKey: 'r1_fy2027',
    extractionArtifactLocator: '/tmp/artifact.json',
    sourceDocumentId: 'source-document-1',
    mode: 'inspect' as const,
  };

  it('accepts the exact immutable verification request', () => {
    expect(verificationRequestV1Schema.safeParse(validRequest).success).toBe(true);
  });

  it('rejects the removed attemptId escape hatch', () => {
    const parsed = verificationRequestV1Schema.safeParse({
      ...validRequest,
      attemptId: 'retry-2',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
    }
  });
});
