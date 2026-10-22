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
  it('lists Hill Day packets only, and pages over them alone, when kind=hillday', async () => {
    const id = (n: string) => `11111111-1111-4111-8111-11111111111${n.slice(-1)}`;
    const at = (iso: string) => new Date(iso);
    const hill = (key: string, iso: string) => ({
      id: id(key),
      name: key,
      clientId: '11111111-1111-4111-8111-111111111111',
      clientName: null,
      status: 'generated',
      updatedAt: at(iso),
      ownerId: 'actor',
    });
    const prisma = {
      wsHillDayDocument: {
        findFirst: jest.fn(async ({where}: any) => ({ id: where.id, ownerId: 'actor', clientId: '11111111-1111-4111-8111-111111111111' })),
        findMany: jest.fn(async () => [
          hill('h3', '2026-09-14T12:00:00Z'),
          hill('h2', '2026-09-14T11:00:00Z'),
          hill('h1', '2026-09-14T10:00:00Z'),
        ]),
      },
      wsCollaborator: { findMany: jest.fn(async () => []) },
      wsDraft: { findMany: jest.fn(async () => []) },
    };
    const collaborators = { sourceAccess: jest.fn(async () => true) };
    const service = new HillDayDocumentService(
      prisma as never,
      { userDisplays: jest.fn(async () => new Map()), requireClient: jest.fn(async () => ({wallAllowed:true})) } as never,
      {} as never,
      collaborators as never,
    );
    const page = await service.listDocuments('tenant', 'actor', { kind: 'hillday', limit: '2' });
    expect(page.items.map((d) => [d.kind, d.id])).toEqual([
      ['hillday', id('h3')],
      ['hillday', id('h2')],
    ]);
    expect(decodeCursor(page.nextCursor!)).toEqual({ u: '2026-09-14T11:00:00.000Z', i: id('h2') });
    expect(prisma.wsDraft.findMany).not.toHaveBeenCalled();
    expect(prisma.wsCollaborator.findMany).not.toHaveBeenCalled();
    expect(collaborators.sourceAccess).not.toHaveBeenCalled();
  });
  it('never aliases a canonical prospect draft into a client library by display name', async () => {
    const rows = [
      { id: 'prospect-draft', prospectId: 'prospect', client: 'Same name', clientId: '11111111-1111-4111-8111-111111111111' },
      { id: 'legacy-draft', prospectId: null, client: 'Same name', clientId: '11111111-1111-4111-8111-111111111111' },
    ].map((row) => ({
      ...row,
      ownerId: 'actor',
      updatedAt: new Date(),
      docTitle: row.id,
      status: 'draft',
      product: null,
    }));
    const prisma = {
      wsHillDayDocument: { findMany: jest.fn(async () => []) },
      wsCollaborator: { findMany: jest.fn(async () => []) },
      wsDraft: {
        findMany: jest.fn(async ({ where }: any) =>
          rows.filter(
            (row) =>
              (where.prospectId === undefined || row.prospectId === where.prospectId) &&
              (!where.clientId || row.clientId === where.clientId),
          ),
        ),
      },
    };
    const service = new HillDayDocumentService(
      prisma as never,
      {
        resolveUserId: jest.fn(async () => 'core-actor'),
        getClient: jest.fn(async () => ({ name: 'Same name', wallAllowed: true })),
        userDisplays: jest.fn(async () => new Map()),
      } as never,
      {} as never,
      { sourceAccess: jest.fn(async () => true) } as never,
    );
    const page = await service.listDocuments('tenant', 'actor', {
      clientId: '11111111-1111-4111-8111-111111111111',
    });
    expect(page.items.map((row) => row.id)).toEqual(['legacy-draft']);
  });
});
