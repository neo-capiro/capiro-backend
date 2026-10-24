import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { TenantContext } from '@capiro/shared';
import type { Request, Response } from 'express';
import { ClientsController } from './clients.controller.js';
import { ClientsService } from './clients.service.js';

jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const ctx = {
  tenantId: 'tenant-current',
  userId: 'actor-current',
  role: 'standard_user',
} as unknown as TenantContext;
const visibleId = 'client-visible';
const otherId = 'client-hidden';

type ClientRow = {
  id: string;
  logoS3Key: string | null;
  tenantId?: string;
  status?: string;
};

function serviceFixture(row: ClientRow | null = null) {
  const tx = {
    client: {
      findMany: jest.fn(async () => row ? [row] : []),
      findFirst: jest.fn(async ({ where }: { where: {
        id: string; tenantId: string; status: { not: string };
      } }) => row && row.id === where.id &&
        (row.tenantId ?? ctx.tenantId) === where.tenantId &&
        (row.status ?? 'active') !== where.status.not ? row : null),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, run: (value: typeof tx) => unknown) => run(tx)),
  };
  const config = {
    get: jest.fn((key: string) => key === 'ASSETS_BUCKET' ? 'private-assets' : key === 'AWS_REGION_DEFAULT' ? 'us-east-1' : false),
  };
  const service = new ClientsService(
    prisma as never,
    config as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma, tx };
}

describe('ClientsService preview native roster reads', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns an empty roster without querying or signing a logo', async () => {
    const { service, prisma, tx } = serviceFixture();
    await expect(service.listPreviewVisible(ctx, {}, [])).resolves.toEqual([]);
    expect(prisma.withTenant).not.toHaveBeenCalled();
    expect(tx.client.findMany).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('constrains list SQL to tenant, visible IDs and active status before applying profile filters', async () => {
    const { service, prisma, tx } = serviceFixture({ id: visibleId, logoS3Key: null });
    await expect(service.listPreviewVisible(
      ctx,
      { profileStatus: 'ACTIVE', sectorTag: 'defense' },
      [visibleId, otherId],
    )).resolves.toEqual([{ id: visibleId, logoS3Key: null, logoUrl: null }]);
    expect(prisma.withTenant).toHaveBeenCalledWith(ctx.tenantId, expect.any(Function));
    expect(tx.client.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: ctx.tenantId,
        id: { in: [visibleId, otherId] },
        status: { not: 'archived' },
        profileStatus: 'ACTIVE',
        sectorTag: 'defense',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('rejects an ID outside the current roster without database or logo access', async () => {
    const { service, prisma } = serviceFixture();
    await expect(service.getPreviewVisible(ctx, otherId, [visibleId]))
      .rejects.toThrow(new NotFoundException('Client not found'));
    expect(prisma.withTenant).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('queries detail by tenant, ID and nonarchived status, returning the current visible row', async () => {
    const { service, prisma, tx } = serviceFixture({ id: visibleId, logoS3Key: null });
    await expect(service.getPreviewVisible(ctx, visibleId, [visibleId]))
      .resolves.toEqual({ id: visibleId, logoS3Key: null, logoUrl: null });
    expect(prisma.withTenant).toHaveBeenCalledWith(ctx.tenantId, expect.any(Function));
    expect(tx.client.findFirst).toHaveBeenCalledWith({
      where: { id: visibleId, tenantId: ctx.tenantId, status: { not: 'archived' } },
    });
  });

  it('uses the same 404 for absent, foreign or archived rows', async () => {
    const rows: Array<ClientRow | null> = [
      null,
      { id: visibleId, tenantId: 'tenant-foreign', logoS3Key: 'foreign-logo' },
      { id: visibleId, status: 'archived', logoS3Key: 'archived-logo' },
    ];
    for (const row of rows) {
      const { service, tx } = serviceFixture(row);
      await expect(service.getPreviewVisible(ctx, visibleId, [visibleId]))
        .rejects.toThrow(new NotFoundException('Client not found'));
      expect(tx.client.findFirst).toHaveBeenLastCalledWith({
        where: { id: visibleId, tenantId: ctx.tenantId, status: { not: 'archived' } },
      });
    }
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});

function controllerFixture(previewMode: boolean) {
  const service = {
    list: jest.fn(async () => ['ordinary-list']),
    get: jest.fn(async () => 'ordinary-detail'),
    listPreviewVisible: jest.fn(async () => ['preview-list']),
    getPreviewVisible: jest.fn(async () => 'preview-detail'),
  };
  const preview = {
    mode: jest.fn(() => previewMode),
    run: jest.fn(async (_req: Request, _res: Response, _ctx: TenantContext,
      operation: (clientIds: readonly string[]) => Promise<unknown>) => operation([visibleId])),
  };
  const controller = new ClientsController(service as never, preview as never);
  const req = { headers: { host: 'core-roster-preview.capiro.ai' } } as Request;
  const res = { setHeader: jest.fn() } as unknown as Response;
  return { controller, service, preview, req, res };
}

describe('ClientsController preview native roster routing', () => {
  it('uses the canonical wall-filtered records owner for first-chat archived management and detail', async () => {
    const { controller, service, preview, req, res } = controllerFixture(true);
    req.headers.host = 'first-chat-preview.app-dev.capiro.ai';
    await expect(controller.list(ctx, { includeArchived: 'true' }, req, res)).resolves.toEqual(['ordinary-list']);
    expect(service.list).toHaveBeenCalledWith(ctx, { includeArchived: true, profileStatus: undefined, sectorTag: undefined });
    await expect(controller.get(ctx, visibleId, req, res)).resolves.toBe('ordinary-detail');
    expect(service.get).toHaveBeenCalledWith(ctx, visibleId);
    expect(preview.run).toHaveBeenCalledTimes(2);
    expect(service.listPreviewVisible).not.toHaveBeenCalled();
  });
  it('refuses archived-inclusive preview list requests before reading membership or clients', () => {
    const { controller, service, preview, req, res } = controllerFixture(true);
    expect(() => controller.list(ctx, { includeArchived: 'true' }, req, res))
      .toThrow(BadRequestException);
    expect(() => controller.list(ctx, { includeArchived: 'unexpected' }, req, res))
      .toThrow(BadRequestException);
    expect(preview.run).not.toHaveBeenCalled();
    expect(service.listPreviewVisible).not.toHaveBeenCalled();
    expect(service.list).not.toHaveBeenCalled();
  });

  it('routes preview list and detail through the narrowed service methods', async () => {
    const { controller, service, preview, req, res } = controllerFixture(true);
    await expect(controller.list(ctx, {
      includeArchived: 'false', profileStatus: 'ACTIVE', sectorTag: 'defense',
    }, req, res)).resolves.toEqual(['preview-list']);
    expect(service.listPreviewVisible).toHaveBeenCalledWith(ctx,
      { profileStatus: 'ACTIVE', sectorTag: 'defense' }, [visibleId]);
    await expect(controller.get(ctx, visibleId, req, res)).resolves.toBe('preview-detail');
    expect(service.getPreviewVisible).toHaveBeenCalledWith(ctx, visibleId, [visibleId]);
    expect(preview.run).toHaveBeenCalledTimes(2);
    expect(service.list).not.toHaveBeenCalled();
    expect(service.get).not.toHaveBeenCalled();
  });

  it('preserves ordinary list and detail delegation', async () => {
    const { controller, service, preview, req, res } = controllerFixture(false);
    await expect(controller.list(ctx, { includeArchived: 'true', sectorTag: 'energy' }, req, res))
      .resolves.toEqual(['ordinary-list']);
    expect(service.list).toHaveBeenCalledWith(ctx, {
      profileStatus: undefined,
      sectorTag: 'energy',
      includeArchived: true,
    });
    await expect(controller.get(ctx, visibleId, req, res)).resolves.toBe('ordinary-detail');
    expect(service.get).toHaveBeenCalledWith(ctx, visibleId);
    expect(preview.run).not.toHaveBeenCalled();
    expect(service.listPreviewVisible).not.toHaveBeenCalled();
    expect(service.getPreviewVisible).not.toHaveBeenCalled();
  });
});
