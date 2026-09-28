import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriAnalysisArtifactController } from './meri-analysis-artifact.controller.js';
import { sha256Bytes } from './meri-artifact-integrity.js';
import { generatedPngBase64 } from './meri-artifact-test-fixtures.js';

const ctx = {
  tenantId: 'tenant-1',
  tenantSlug: 'capiro-internal',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
} as TenantContext;

function make(overrides: Record<string, unknown> = {}) {
  const imageBytes = Buffer.from(generatedPngBase64(), 'base64');
  const visualAnalysis = {
    getArtifact: jest.fn(async () => ({
      id: 'chart-1',
      title: 'Funding trajectory',
      visualization: { version: 1, chartType: 'line', title: 'Funding trajectory', data: [] },
      imageAvailable: true,
    })),
    getArtifactImage: jest.fn(async () => ({
      buffer: imageBytes,
      contentType: 'image/png',
      sha256: sha256Bytes(imageBytes),
      integrityPolicy: 'persisted_hash_match',
    })),
    ...overrides,
  };
  return {
    controller: new MeriAnalysisArtifactController(visualAnalysis as never),
    visualAnalysis,
  };
}

describe('MeriAnalysisArtifactController', () => {
  test('returns only the current user’s sanitized artifact metadata', async () => {
    const { controller, visualAnalysis } = make();
    await expect(controller.getArtifact(ctx, 'chart-1')).resolves.toEqual(
      expect.objectContaining({ id: 'chart-1', title: 'Funding trajectory' }),
    );
    expect(visualAnalysis.getArtifact).toHaveBeenCalledWith(ctx, 'chart-1');
  });

  test('returns validated private PNG bytes with canonical identity and digest', async () => {
    const { controller, visualAnalysis } = make();
    const response = {
      setHeader: jest.fn(),
      send: jest.fn(),
    };
    await controller.getArtifactImage(ctx, 'chart-1', response as never);
    expect(visualAnalysis.getArtifactImage).toHaveBeenCalledWith(ctx, 'chart-1');
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    const bytes = response.send.mock.calls[0]![0] as Buffer;
    const sha256 = sha256Bytes(bytes);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(response.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(response.setHeader).toHaveBeenCalledWith('ETag', `"sha256-${sha256}"`);
    expect(response.setHeader).toHaveBeenCalledWith('Content-Length', bytes.length.toString());
    expect(response.setHeader).toHaveBeenCalledWith('X-Capiro-Artifact-Id', 'chart-1');
    expect(response.setHeader).toHaveBeenCalledWith('X-Capiro-Image-Integrity', 'persisted_hash_match');
  });

  test('uses the same not-found shape for missing and unauthorized artifact ids', async () => {
    const { controller } = make({
      getArtifact: jest.fn(async () => null),
      getArtifactImage: jest.fn(async () => null),
    });
    await expect(controller.getArtifact(ctx, 'foreign-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      controller.getArtifactImage(ctx, 'foreign-id', {
        setHeader: jest.fn(),
        send: jest.fn(),
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
