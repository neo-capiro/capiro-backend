import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service.js';
import { MeriToolsService } from './meri-tools.service.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1', role: 'standard_user' } as TenantContext;

function fixture(granted: boolean) {
  const findFirst = jest.fn(async () => ({
    contentType: 'image/png', metadata: { imageBase64: 'cG5n' },
    clientId: 'client-1', conversation: { clientId: 'client-1' },
  }));
  const queryRaw = jest.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join('');
    if (sql.includes('FROM client_memory_access')) return granted ? [{ id: 'grant-1' }] : [];
    if (sql.includes('FROM clients')) return [{ memory_wall: true }];
    throw new Error('Unexpected chart scope query');
  });
  const tx = { clioArtifact: { findFirst }, $queryRaw: queryRaw };
  const withTenantUser = jest.fn(async (_tenantId: string, _userId: string,
    callback: (transaction: typeof tx) => unknown) => callback(tx));
  return { prisma: { withTenantUser }, findFirst, queryRaw };
}

describe('legacy analysis-chart consumption after wall changes', () => {
  test('legacy image route requires owning user and current grant', async () => {
    const allowed = fixture(true);
    const service = Object.assign(Object.create(MeriService.prototype), {
      prisma: allowed.prisma,
    }) as MeriService;
    await expect(service.getArtifactImage(ctx, 'chart-1')).resolves.toMatchObject({
      contentType: 'image/png', buffer: Buffer.from('png'),
    });
    expect(allowed.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'chart-1', tenantId: 'tenant-1', userId: 'user-1', kind: 'analysis_chart' },
    }));
    const denied = fixture(false);
    const deniedService = Object.assign(Object.create(MeriService.prototype), {
      prisma: denied.prisma,
    }) as MeriService;
    await expect(deniedService.getArtifactImage(ctx, 'chart-1'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  test('document chart embedding rejects a revoked grant', async () => {
    const denied = fixture(false);
    const tools = Object.assign(Object.create(MeriToolsService.prototype), {
      prisma: denied.prisma,
    }) as MeriToolsService;
    await expect((tools as unknown as { resolveChartImages: (ctx: TenantContext, ids: string[]) => Promise<unknown> })
      .resolveChartImages(ctx, ['chart-1'])).rejects.toBeInstanceOf(NotFoundException);
    expect(denied.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'chart-1', tenantId: 'tenant-1', userId: 'user-1', kind: 'analysis_chart' },
    }));
  });
});
