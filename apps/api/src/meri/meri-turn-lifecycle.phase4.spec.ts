import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service.js';

// These injected ports use the fixture implementations below; loading their
// unrelated client/learning/embedding graphs is unnecessary for turn receipts.
jest.mock('./meri-tools.service.js', () => ({ MeriToolsService: class {} }));
jest.mock('../engagement/ai-credential-resolver.service.js', () => ({ AiCredentialResolverService: class {} }));
jest.mock('../context/context-compiler.service.js', () => ({ ContextCompilerService: class {} }));

const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' } as TenantContext;

describe('archived Meri thread deep-link recovery', () => {
  function archivedHarness() {
    const row = { id: 'conversation', tenantId: ctx.tenantId, userId: ctx.userId,
      archivedAt: new Date('2026-09-10T10:00:00Z'), status: 'archived', clientId: null };
    const tx = {
      clioConversation: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
          where.tenantId === row.tenantId && where.userId === row.userId &&
          where.id === row.id && (!('archivedAt' in where) || row.archivedAt === where.archivedAt) ? row : null),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(row, data)),
      },
      clioMessage: { findMany: jest.fn(async () => [{ id: 'saved-answer', body: 'Saved before archive.' }]) },
    };
    const service = Object.assign(Object.create(MeriService.prototype), {
      prisma: { withTenant: jest.fn(async (_id: string, fn: (db: typeof tx) => unknown) => fn(tx)) },
    }) as MeriService;
    return { service, tx, row };
  }

  it('discovers the owned archived row without restoring or reading its messages, then restores the saved conversation', async () => {
    const h = archivedHarness();
    await expect(h.service.getConversation(ctx, 'conversation')).resolves.toMatchObject({ status: 'archived' });
    expect(h.tx.clioConversation.update).not.toHaveBeenCalled();
    expect(h.tx.clioMessage.findMany).not.toHaveBeenCalled();
    await expect(h.service.listMessages(ctx, 'conversation')).rejects.toThrow('Meri conversation not found');
    await h.service.restoreConversation(ctx, 'conversation');
    expect(h.row).toMatchObject({ archivedAt: null, status: 'active' });
    await expect(h.service.listMessages(ctx, 'conversation')).resolves.toEqual([{ id: 'saved-answer', body: 'Saved before archive.' }]);
  });

  it.each([{ tenantId: 'other-tenant' }, { userId: 'other-user' }])('rejects archive discovery and restore outside the owner (%j)', async (scope) => {
    const h = archivedHarness();
    const foreign = { ...ctx, ...scope };
    await expect(h.service.getConversation(foreign, 'conversation')).rejects.toThrow('Meri conversation not found');
    await expect(h.service.restoreConversation(foreign, 'conversation')).rejects.toThrow('Meri conversation not found');
    expect(h.tx.clioConversation.update).not.toHaveBeenCalled();
  });
});
