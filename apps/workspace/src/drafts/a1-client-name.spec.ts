import { describe, expect, it, jest } from '@jest/globals';
import { DraftsService } from './drafts.service.js';

describe('A1 ordinary draft client identity', () => {
  it('refuses a display name without a client UUID before any draft or document write', async () => {
    const draft = { id: 'draft', documents: [] };
    const db = {
      $executeRaw: jest.fn(async () => 1),
      $queryRaw: jest.fn(async () => [{ id: 'active-user' }]),
      wsDraft: { create: jest.fn(async () => draft), findFirstOrThrow: jest.fn(async () => draft) },
      wsDocument: { create: jest.fn(async () => ({ id: 'document' })) },
    };
    const prisma = {
      ...db,
      $transaction: async (run: (tx: typeof db) => Promise<unknown>) => run(db),
      withSystem: async (run: (tx: typeof db) => Promise<unknown>) => run(db),
    };
    const service = new DraftsService(prisma as never, {} as never);
    await expect(
      service.create('tenant', 'owner', { client: '  Same display name  ' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.wsDraft.create).not.toHaveBeenCalled();
    expect(db.wsDocument.create).not.toHaveBeenCalled();
    // Firm-level drafts are still valid: whitespace does not infer an identity.
    await expect(service.create('tenant', 'owner', { client: '  ' })).resolves.toEqual(draft);
    expect(db.wsDraft.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientId: null }),
      }),
    );
  });
});
