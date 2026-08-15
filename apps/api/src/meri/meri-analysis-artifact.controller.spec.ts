import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriAnalysisArtifactController } from './meri-analysis-artifact.controller.js';

const ctx = {
  tenantId: 'tenant-1',
  tenantSlug: 'capiro-internal',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
} as TenantContext;

function make(overrides: Record<string, unknown> = {}) {
  const visualAnalysis = {
    getArtifact: jest.fn(async () => ({
      id: 'chart-1',
      title: 'Funding trajectory',
      visualization: { version: 1, chartType: 'line', title: 'Funding trajectory', data: [] },
      imageAvailable: true,
    })),
    getArtifactImage: jest.fn(async () => ({
      buffer: Buffer.from('png'),
      contentType: 'image/png',
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

  test('returns a private nosniff PNG response', async () => {
    const { controller, visualAnalysis } = make();
    const response = {
      setHeader: jest.fn(),
      send: jest.fn(),
    };
    await controller.getArtifactImage(ctx, 'chart-1', response as never);
    expect(visualAnalysis.getArtifactImage).toHaveBeenCalledWith(ctx, 'chart-1');
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, max-age=3600');
    expect(response.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(response.send).toHaveBeenCalledWith(Buffer.from('png'));
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
