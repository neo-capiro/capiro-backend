import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriV3SettingsController } from './meriv3-settings.controller.js';

const ctx = {
  tenantId: 'tenant-1',
  tenantSlug: 'capiro-internal',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
} as TenantContext;

function make(options?: { enabled?: boolean; sandboxAvailable?: boolean }) {
  const prisma = { withTenant: jest.fn() };
  const flags = {
    isMeriV3ChatEnabled: jest.fn(async () => options?.enabled ?? true),
  };
  const managedMcp = {
    listApps: jest.fn(async () => []),
    connect: jest.fn(),
    disconnect: jest.fn(),
    schemasForMeriV3: jest.fn(async () => []),
    executeRead: jest.fn(),
  };
  const visualAnalysis = {
    isAvailable: jest.fn(async () => options?.sandboxAvailable ?? true),
    run: jest.fn(async () => ({ ok: true, artifacts: [] })),
    discardUnreleasedArtifacts: jest.fn(async () => 1),
  };
  return {
    controller: new MeriV3SettingsController(
      prisma as never,
      flags as never,
      managedMcp as never,
      visualAnalysis as never,
    ),
    prisma,
    flags,
    managedMcp,
    visualAnalysis,
  };
}

describe('MeriV3SettingsController visual analysis', () => {
  test('advertises the strict interactive contract only when the sandbox gate is available', async () => {
    const available = make({ sandboxAvailable: true });
    await expect(available.controller.capabilities(ctx)).resolves.toEqual(
      expect.objectContaining({
        visualAnalysis: {
          enabled: true,
          version: 1,
          interactive: true,
          canonicalExport: 'png',
          chartTypes: [
            'line',
            'area',
            'bar',
            'stacked_bar',
            'scatter',
            'pie',
            'waterfall',
            'heatmap',
            'timeline',
          ],
        },
      }),
    );
    expect(available.visualAnalysis.isAvailable).toHaveBeenCalledWith('tenant-1');

    const disabled = make({ sandboxAvailable: false });
    const result = await disabled.controller.capabilities(ctx);
    expect(result.visualAnalysis.enabled).toBe(false);
    expect(result.visualAnalysis.chartTypes).toContain('waterfall');
  });

  test('the V3 canary gate fails closed before checking sandbox, compute, or discard', async () => {
    const { controller, visualAnalysis } = make({ enabled: false });
    await expect(controller.capabilities(ctx)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      controller.executeVisualAnalysis(ctx, {
        conversationId: 'conversation-1',
        code: 'print(1)',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      controller.discardVisualAnalysis(ctx, {
        artifactIds: ['a1111111-1111-4111-8111-111111111111'],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(visualAnalysis.isAvailable).not.toHaveBeenCalled();
    expect(visualAnalysis.run).not.toHaveBeenCalled();
    expect(visualAnalysis.discardUnreleasedArtifacts).not.toHaveBeenCalled();
  });

  test('passes authenticated tenant context and opaque analysis input to the service', async () => {
    const { controller, visualAnalysis } = make();
    const input = {
      conversationId: 'conversation-1',
      purpose: 'Compare marks',
      code: 'print(1)',
      datasets: [{ name: 'marks', rows: [{ stage: 'HASC', amount: 10 }] }],
    };
    await expect(controller.executeVisualAnalysis(ctx, input)).resolves.toEqual({
      ok: true,
      artifacts: [],
    });
    expect(visualAnalysis.run).toHaveBeenCalledWith(ctx, input);
  });

  test('passes only artifact ids to the service-owned discard boundary', async () => {
    const { controller, visualAnalysis } = make();
    const artifactIds = ['a1111111-1111-4111-8111-111111111111'];
    await expect(controller.discardVisualAnalysis(ctx, { artifactIds })).resolves.toEqual({
      deleted: 1,
    });
    expect(visualAnalysis.discardUnreleasedArtifacts).toHaveBeenCalledWith(ctx, artifactIds);
  });
});
