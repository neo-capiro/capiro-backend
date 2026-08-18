import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriVNextLibraryService } from './meri-vnext-library.service.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;

function makeService() {
  const tx = {
    meriSavedPrompt: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'prompt-1', ...data })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'prompt-1', ...data })),
      delete: jest.fn(async () => ({ id: 'prompt-1' })),
      findFirst: jest.fn(async () => null),
    },
    meriWorkspace: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'workspace-1', ...data })),
      findFirst: jest.fn(async () => null),
    },
    meriVnextPreference: {
      findFirst: jest.fn(async () => null),
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        ...create,
        updatedAt: new Date('2026-08-17T00:00:00.000Z'),
      })),
    },
    client: {
      findFirst: jest.fn(async () => null),
    },
    clioConversation: {
      findFirst: jest.fn(async () => null),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'conversation-1', ...data })),
    },
    clioAttachment: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'attachment-1', ...data })),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (transaction: typeof tx) => unknown) => fn(tx)),
  };
  return { service: new MeriVNextLibraryService(prisma as never), tx };
}

describe('MeriVNextLibraryService', () => {
  it('creates a tenant-and-user scoped saved prompt with bounded normalized copy', async () => {
    const { service, tx } = makeService();

    const prompt = await service.createSavedPrompt(ctx, {
      title: '  Monday brief  ',
      body: '  Summarize changes for this client.  ',
    });

    expect(prompt).toEqual(expect.objectContaining({ title: 'Monday brief', body: 'Summarize changes for this client.' }));
    expect(tx.meriSavedPrompt.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenantId: 'tenant-1', userId: 'user-1' }) }),
    );
  });

  it('rejects blank saved-prompt copy before attempting a write', async () => {
    const { service, tx } = makeService();

    await expect(service.createSavedPrompt(ctx, { title: 'Useful', body: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.meriSavedPrompt.create).not.toHaveBeenCalled();
  });

  it('rejects a malformed workspace client id before looking up a client', async () => {
    const { service, tx } = makeService();

    await expect(
      service.createWorkspace(ctx, { name: 'Legislative work', clientId: 'not-a-uuid' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.client.findFirst).not.toHaveBeenCalled();
  });

  it('does not update a prompt outside the caller ownership boundary', async () => {
    const { service, tx } = makeService();
    tx.meriSavedPrompt.findFirst.mockResolvedValue(null);

    await expect(service.updateSavedPrompt(ctx, 'prompt-missing', { title: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.meriSavedPrompt.update).not.toHaveBeenCalled();
  });

  it('creates a durable workspace and assigns only an owned conversation to it', async () => {
    const { service, tx } = makeService();
    (tx.meriWorkspace.findFirst as jest.Mock).mockResolvedValue({ id: 'workspace-1', tenantId: 'tenant-1', userId: 'user-1' } as never);
    (tx.clioConversation.findFirst as jest.Mock).mockResolvedValue({ id: 'conversation-1', tenantId: 'tenant-1', userId: 'user-1' } as never);

    const workspace = await service.createWorkspace(ctx, { name: 'Legislative work', clientId: null });
    await service.assignConversation(ctx, 'conversation-1', 'workspace-1');

    expect(workspace).toEqual(expect.objectContaining({ name: 'Legislative work' }));
    expect(tx.clioConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ workspaceId: 'workspace-1' }) }),
    );
  });

  it('refuses assigning a conversation to another user workspace', async () => {
    const { service, tx } = makeService();
    (tx.meriWorkspace.findFirst as jest.Mock).mockResolvedValue(null as never);

    await expect(service.assignConversation(ctx, 'conversation-1', 'workspace-foreign')).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.clioConversation.findFirst).not.toHaveBeenCalled();
  });

  it('returns safe defaults when the caller has no persisted vNext preferences', async () => {
    const { service, tx } = makeService();

    await expect(service.getPreferences(ctx)).resolves.toEqual({
      windowChrome: 'undocked',
      railCollapsed: false,
      openSection: null,
    });
    expect(tx.meriVnextPreference.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-1', userId: 'user-1' } }),
    );
  });

  it('persists vNext chrome preferences under the caller tenant and user', async () => {
    const { service, tx } = makeService();

    const preference = await service.savePreferences(ctx, {
      windowChrome: 'maximized',
      railCollapsed: true,
      openSection: 'actions',
    });

    expect(preference).toEqual({
      windowChrome: 'maximized',
      railCollapsed: true,
      openSection: 'actions',
    });
    expect(tx.meriVnextPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_userId: { tenantId: 'tenant-1', userId: 'user-1' } },
        create: expect.objectContaining({ tenantId: 'tenant-1', userId: 'user-1' }),
      }),
    );
  });

  it('rejects malformed vNext preference input before persisting it', async () => {
    const { service, tx } = makeService();

    await expect(service.savePreferences(ctx, { windowChrome: 'invalid' })).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.meriVnextPreference.upsert).not.toHaveBeenCalled();
  });

  it('accepts the v4 memory rail section like the other three', async () => {
    const { service, tx } = makeService();

    const preference = await service.savePreferences(ctx, {
      windowChrome: 'undocked',
      railCollapsed: false,
      openSection: 'memory',
    });

    expect(preference.openSection).toBe('memory');
    expect(tx.meriVnextPreference.upsert).toHaveBeenCalled();
  });

  it('still rejects an openSection outside the four known rail sections', async () => {
    const { service, tx } = makeService();

    await expect(
      service.savePreferences(ctx, { windowChrome: 'undocked', railCollapsed: false, openSection: 'bogus' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.meriVnextPreference.upsert).not.toHaveBeenCalled();
  });

});
