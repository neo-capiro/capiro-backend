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
      text: 'Source text.',
    });
    expect(collaborators.assertCan).toHaveBeenCalled();
    expect(prisma.wsDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'document-1', tenantId: 'tenant-1', draftId: 'draft-1' } }),
    );
  });

  // Draft creation always makes one primary tab with `{ blocks: [] }`, so the
  // body-only projection imported nothing for the ordinary (non-packet) draft.
  it('falls back to the draft section content when the tab has no body of its own', async () => {
    const { service, prisma } = makeService();
    prisma.wsDraft.findFirst.mockResolvedValue({
      id: 'draft-1',
      config: {
        sections: ['Background', 'Ask'],
        sectionContent: {
          Background: '<p>The program moved to FY27.</p>',
          Ask: '<p>Fund &amp; extend it.</p>',
        },
      },
    } as never);
    prisma.wsDocument.findFirst.mockResolvedValue({
      id: 'document-1',
      name: 'Document',
      body: { blocks: [] },
    } as never);

    await expect(
      service.readForMeriImport('tenant-1', 'draft-1', 'document-1', 'clerk-user-1'),
    ).resolves.toMatchObject({
      text: 'Background\nThe program moved to FY27.\n\nAsk\nFund & extend it.',
    });
  });

  it('renders stored HTML block content as readable text', async () => {
    const { service, prisma } = makeService();
    prisma.wsDocument.findFirst.mockResolvedValue({
      id: 'document-1',
      name: 'Board memo',
      body: { blocks: [{ content: '<h1>Ask</h1><p>Fund the&nbsp;program.</p>' }] },
    } as never);

    await expect(
      service.readForMeriImport('tenant-1', 'draft-1', 'document-1', 'clerk-user-1'),
    ).resolves.toMatchObject({ text: 'Ask\nFund the program.' });
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
