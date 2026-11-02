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
      archivedAt: new Date('2026-09-10T10:00:00Z'), status: 'archived', clientId: null, metadataRevision: 0n };
    const tx = {
      clioConversationBootstrapReceipt: {
        findFirst: jest.fn(async (): Promise<{ requestId: string } | null> => null),
      },
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
    const restored = await h.service.restoreConversation(ctx, 'conversation');
    expect(JSON.parse(JSON.stringify(restored))).toMatchObject({ status: 'active', metadataRevision: '0' });
    expect(h.row.metadataRevision).toBe(0n);
    expect(h.tx.clioConversationBootstrapReceipt.findFirst).toHaveBeenCalledWith({
      where: { tenantId: ctx.tenantId, conversationId: 'conversation' }, select: { requestId: true },
    });
    expect(h.row).toMatchObject({ archivedAt: null, status: 'active' });
    await expect(h.service.listMessages(ctx, 'conversation')).resolves.toEqual([{ id: 'saved-answer', body: 'Saved before archive.' }]);
  });

  it('requires versioned management before restoring a bootstrap-bound archived conversation', async () => {
    const h = archivedHarness();
    h.tx.clioConversationBootstrapReceipt.findFirst.mockResolvedValueOnce({ requestId: 'bootstrap-request' });
    await expect(h.service.restoreConversation(ctx, 'conversation')).rejects.toThrow('VERSIONED_CONVERSATION_MANAGEMENT_REQUIRED');
    expect(h.row.status).toBe('archived');
    expect(h.row.archivedAt).not.toBeNull();
    expect(h.tx.clioConversation.update).not.toHaveBeenCalled();
    expect(h.tx.clioMessage.findMany).not.toHaveBeenCalled();
  });

  it.each([{ tenantId: 'other-tenant' }, { userId: 'other-user' }])('rejects archive discovery and restore outside the owner (%j)', async (scope) => {
    const h = archivedHarness();
    const foreign = { ...ctx, ...scope };
    await expect(h.service.getConversation(foreign, 'conversation')).rejects.toThrow('Meri conversation not found');
    await expect(h.service.restoreConversation(foreign, 'conversation')).rejects.toThrow('Meri conversation not found');
    expect(h.tx.clioConversation.update).not.toHaveBeenCalled();
  });
});
