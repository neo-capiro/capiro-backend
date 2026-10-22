import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import type { ResolvedRole } from '../collaborators/role-policy.js';
import { DocumentsService } from './documents.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const draftId = '22222222-2222-4222-8222-222222222222';
const actorId = 'user_reader';

function fixture(role: ResolvedRole) {
  const origin = { id: draftId, tenantId, prospectId: null };
  const documents = [{ id: 'document', body: { blocks: [{ content: 'Protected body' }] } }];
  const prisma = {
    wsDraft: {
      findFirst: jest.fn(async (): Promise<typeof origin | null> => origin),
    },
    wsDocument: { findMany: jest.fn(async () => documents) },
  };
  const collaborators = new CollaboratorsService(prisma as never, {} as never);
  // Pin the real opaque admission/canRead predicate here. The joined HTTP
  // fixture independently exercises real role/source/membership resolution.
  const resolveRole = jest.spyOn(collaborators, 'resolveRole').mockResolvedValue(role);
  const service = new DocumentsService(prisma as never, collaborators);
  return { service, prisma, documents, resolveRole };
}

describe('DocumentsService list draft admission', () => {
  it('refuses an unrelated actor before origin or document reads', async () => {
    const h = fixture(null);
    await expect(h.service.list(tenantId, draftId, actorId)).rejects.toMatchObject({
      status: 404, message: 'Draft not found',
    });
    expect(h.resolveRole).toHaveBeenCalledWith(tenantId, draftId, actorId, undefined);
    expect(h.prisma.wsDraft.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.wsDocument.findMany).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('refuses missing identity %p without a data read', async actor => {
    const h = fixture('owner');
    await expect(h.service.list(tenantId, draftId, actor)).rejects.toMatchObject({
      status: 404, message: 'Draft not found',
    });
    expect(h.resolveRole).not.toHaveBeenCalled();
    expect(h.prisma.wsDraft.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.wsDocument.findMany).not.toHaveBeenCalled();
  });

  it.each(['owner', 'editor', 'reviewer', 'commenter', 'viewer'] as const)(
    'preserves the %s read role with a minimal tenant-bound parent lookup', async role => {
      const h = fixture(role);
      await expect(h.service.list(tenantId, draftId, actorId)).resolves.toEqual(h.documents);
      expect(h.prisma.wsDraft.findFirst).toHaveBeenCalledWith({
        where: { id: draftId, tenantId },
        select: { id: true, tenantId: true, prospectId: true },
      });
      expect(h.prisma.wsDocument.findMany).toHaveBeenCalledWith({
        where: { tenantId, draftId }, orderBy: { ordinal: 'asc' },
      });
      expect(h.resolveRole.mock.invocationCallOrder[0]).toBeLessThan(
        h.prisma.wsDraft.findFirst.mock.invocationCallOrder[0]!,
      );
      expect(h.prisma.wsDraft.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
        h.prisma.wsDocument.findMany.mock.invocationCallOrder[0]!,
      );
    },
  );

  it('rechecks admission on a subsequent call after access is revoked', async () => {
    const h = fixture('viewer');
    await expect(h.service.list(tenantId, draftId, actorId)).resolves.toEqual(h.documents);
    h.resolveRole.mockResolvedValue(null);
    h.prisma.wsDraft.findFirst.mockClear();
    h.prisma.wsDocument.findMany.mockClear();
    await expect(h.service.list(tenantId, draftId, actorId)).rejects.toMatchObject({ status: 404 });
    expect(h.prisma.wsDraft.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.wsDocument.findMany).not.toHaveBeenCalled();
  });

  it('refuses a parent removed after admission before listing its documents', async () => {
    const h = fixture('owner');
    h.prisma.wsDraft.findFirst.mockResolvedValue(null);
    await expect(h.service.list(tenantId, draftId, actorId)).rejects.toMatchObject({
      status: 404, message: 'Draft not found',
    });
    expect(h.prisma.wsDocument.findMany).not.toHaveBeenCalled();
  });
});
