import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { createGovernedMeriToolsService } from './governed-meri-tools.proxy.js';
import type { MeriToolsService } from './meri-tools.service.js';

const ctx = {
  tenantId: 'tenant-1',
  tenantSlug: 'capiro-internal',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
} as TenantContext;

function make(ownedIds: string[]) {
  const raw = {
    execute: jest.fn(async () => ({ ok: true })),
    executeFromAuthenticatedUser: jest.fn(async () => ({ ok: true })),
  } as unknown as MeriToolsService;
  const findMany = jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
    ownedIds.filter((id) => where.id.in.includes(id)).map((id) => ({ id })),
  );
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, callback: (tx: unknown) => unknown) =>
      callback({ clioArtifact: { findMany } }),
    ),
  };
  return {
    raw,
    findMany,
    service: createGovernedMeriToolsService(raw, prisma as never),
  };
}

describe('governed Meri tool proxy — analysis chart ownership', () => {
  test('allows Word embedding only when every referenced chart belongs to the current user', async () => {
    const { service, raw, findMany } = make(['chart-1', 'chart-2']);
    const input = {
      title: 'Client brief',
      sections: [{ heading: 'Funding', imageArtifactIds: ['chart-1', 'chart-2', 'chart-1'] }],
    };
    await expect(service.execute(ctx, 'create_word' as never, input)).resolves.toEqual({
      ok: true,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['chart-1', 'chart-2'] },
        tenantId: 'tenant-1',
        userId: 'user-1',
        kind: 'analysis_chart',
      },
      select: { id: true },
    });
    expect(raw.execute).toHaveBeenCalledWith(ctx, 'create_word', input);
  });

  test('fails with the same not-found shape when one PowerPoint chart is missing or unauthorized', async () => {
    const { service, raw } = make(['chart-1']);
    const input = {
      title: 'Client deck',
      slides: [{ title: 'Exposure', imageArtifactIds: ['chart-1', 'chart-foreign'] }],
    };
    await expect(
      service.executeFromAuthenticatedUser(ctx, 'create_powerpoint', input),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(raw.executeFromAuthenticatedUser).not.toHaveBeenCalled();
  });

  test('does not query chart ownership for unrelated tools or documents without chart ids', async () => {
    const { service, raw, findMany } = make([]);
    await expect(
      service.executeFromAuthenticatedUser(ctx, 'search_memory', { query: 'appropriations' }),
    ).resolves.toEqual({ ok: true });
    await expect(
      service.execute(ctx, 'create_word' as never, {
        title: 'Text-only brief',
        sections: [{ heading: 'Summary', paragraphs: ['Text only.'] }],
      }),
    ).resolves.toEqual({ ok: true });
    expect(findMany).not.toHaveBeenCalled();
    expect(raw.executeFromAuthenticatedUser).toHaveBeenCalledTimes(1);
    expect(raw.execute).toHaveBeenCalledTimes(1);
  });

  test('rejects a document with more references than the ownership normalizer can retain', async () => {
    const { service, raw, findMany } = make([]);
    const slides = Array.from({ length: 61 }, (_, slideIndex) => ({
      title: `Slide ${slideIndex + 1}`,
      imageArtifactIds: Array.from(
        { length: 4 },
        (_, imageIndex) => `chart-${slideIndex}-${imageIndex}`,
      ),
    }));
    await expect(
      service.executeFromAuthenticatedUser(ctx, 'create_powerpoint', {
        title: 'Oversized deck',
        slides,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
    expect(raw.executeFromAuthenticatedUser).not.toHaveBeenCalled();
  });

  test('fails closed if the proxy is constructed without its ownership dependency', async () => {
    const raw = {
      execute: jest.fn(async () => ({ ok: true })),
    } as unknown as MeriToolsService;
    const service = createGovernedMeriToolsService(raw);
    await expect(
      service.execute(ctx, 'create_word' as never, {
        title: 'Brief',
        sections: [{ heading: 'Chart', imageArtifactIds: ['chart-1'] }],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(raw.execute).not.toHaveBeenCalled();
  });
});
