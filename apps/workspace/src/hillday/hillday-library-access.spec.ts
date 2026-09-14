import { HillDayDocumentService, decodeCursor } from './hillday-document.service.js';

describe('Workspace library private drafts', () => {
  it('checks source access concurrently so one held source does not block checking ordinary drafts', async () => {
    let release!: (allowed: boolean) => void;
    const held = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const updatedAt = new Date('2026-09-14T10:00:00Z');
    const row = (id: string) => ({
      id,
      docTitle: id,
      ownerId: 'actor',
      updatedAt,
      product: null,
      client: null,
      status: 'draft',
    });
    const prisma = {
      wsHillDayDocument: { findMany: jest.fn(async () => []) },
      wsCollaborator: { findMany: jest.fn(async () => []) },
      wsDraft: { findMany: jest.fn(async () => [row('z-held'), row('y-visible'), row('x-older')]) },
    };
    const collaborators = {
      sourceAccess: jest.fn(async (_tenant: string, id: string) => (id === 'z-held' ? held : true)),
    };
    const service = new HillDayDocumentService(
      prisma as never,
      { userDisplays: jest.fn(async () => new Map()) } as never,
      {} as never,
      collaborators as never,
    );
    const pending = service.listDocuments('tenant', 'actor', { limit: '2' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(collaborators.sourceAccess).toHaveBeenCalledTimes(2);
    release(false);
    const page = await pending;
    expect(page.items.map((d) => d.id)).toEqual(['y-visible']);
    expect(decodeCursor(page.nextCursor!)).toEqual({ u: updatedAt.toISOString(), i: 'y-visible' });
  });
  it('filters owner/active collaboration in SQL and revoked source access before returning metadata', async () => {
    const updatedAt = new Date('2026-09-14T10:00:00Z');
    const row = (id: string) => ({
      id,
      docTitle: id,
      ownerId: 'actor',
      updatedAt,
      product: null,
      client: null,
      status: 'draft',
    });
    const prisma = {
      wsHillDayDocument: { findMany: jest.fn(async () => []) },
      wsCollaborator: { findMany: jest.fn(async () => [{ draftId: 'shared' }]) },
      wsDraft: { findMany: jest.fn(async () => [row('revoked'), row('older')]) },
    };
    const collaborators = {
      sourceAccess: jest.fn(async (_tenant: string, id: string) => id !== 'revoked'),
    };
    const source = { userDisplays: jest.fn(async () => new Map()) };
    const service = new HillDayDocumentService(
      prisma as never,
      source as never,
      {} as never,
      collaborators as never,
    );
    const page = await service.listDocuments('tenant', 'actor', { limit: '1' });
    expect(page.items).toEqual([]);
    expect(decodeCursor(page.nextCursor!)).toEqual({ u: updatedAt.toISOString(), i: 'revoked' });
    expect(prisma.wsCollaborator.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant', subjectId: 'actor', status: 'active' },
      select: { draftId: true },
    });
    expect(prisma.wsDraft.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant',
          AND: [{ OR: [{ ownerId: 'actor' }, { id: { in: ['shared'] } }] }],
        }),
      }),
    );
    expect(collaborators.sourceAccess).toHaveBeenCalledWith(
      'tenant',
      'revoked',
      'actor',
      expect.any(AbortSignal),
    );
    prisma.wsDraft.findMany.mockResolvedValueOnce([row('older')]);
    const next = await service.listDocuments('tenant', 'actor', {
      cursor: page.nextCursor!,
      limit: '1',
    });
    expect(prisma.wsDraft.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [{ OR: [{ ownerId: 'actor' }, { id: { in: ['shared'] } }] }],
          OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: 'revoked' } }],
        }),
      }),
    );
    expect(next.items.map((item) => item.id)).toEqual(['older']);
    expect(next.nextCursor).toBeNull();
  });
});
