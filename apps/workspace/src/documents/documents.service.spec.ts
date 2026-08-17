import { describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { DocumentsService } from './documents.service.js';

function makeService() {
  const prisma = {
    wsDraft: {
      findFirst: jest.fn(async () => ({ id: 'draft-1' })),
      findMany: jest.fn(async () => []),
    },
    wsDocument: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
    },
  };
  const collaborators = {
    assertCan: jest.fn(async () => 'owner'),
  };
  return {
    service: new DocumentsService(prisma as never, collaborators as never),
    prisma,
    collaborators,
  };
}

describe('DocumentsService Meri imports', () => {
  it('returns a document only after Workspace checks read access on its parent draft', async () => {
    const { service, prisma, collaborators } = makeService();
    prisma.wsDocument.findFirst.mockResolvedValue({
      id: 'document-1',
      name: 'Board memo',
      body: { blocks: [{ content: 'Source text.' }] },
    } as never);

    await expect(
      service.readForMeriImport('tenant-1', 'draft-1', 'document-1', 'clerk-user-1'),
    ).resolves.toEqual({
      id: 'document-1',
      name: 'Board memo',
      body: { blocks: [{ content: 'Source text.' }] },
    });
    expect(collaborators.assertCan).toHaveBeenCalled();
    expect(prisma.wsDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'document-1', tenantId: 'tenant-1', draftId: 'draft-1' } }),
    );
  });

  it('does not expose a missing or foreign document', async () => {
    const { service, prisma } = makeService();
    prisma.wsDocument.findFirst.mockResolvedValue(null as never);

    await expect(
      service.readForMeriImport('tenant-1', 'draft-1', 'document-missing', 'clerk-user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('requires parent-draft read access before listing document names', async () => {
    const { service, prisma, collaborators } = makeService();
    prisma.wsDocument.findMany.mockResolvedValue([
      { id: 'document-1', name: 'Board memo' },
    ] as never);

    await expect(service.listForMeriImport('tenant-1', 'draft-1', 'clerk-user-1')).resolves.toEqual([
      { id: 'document-1', name: 'Board memo' },
    ]);
    expect(collaborators.assertCan).toHaveBeenCalled();
    expect(prisma.wsDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-1', draftId: 'draft-1' } }),
    );
  });
});
