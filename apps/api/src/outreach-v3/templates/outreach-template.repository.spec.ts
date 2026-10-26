import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { OutreachTemplateRepository } from './outreach-template.repository.js';

const ctx = { tenantId: randomUUID(), userId: randomUUID() } as TenantContext;

describe('OutreachTemplateRepository application transaction', () => {
  it('locks the tenant/actor/request key before any write, normalizing UUID case', async () => {
    const repository = new OutreachTemplateRepository();
    const execute = jest.fn(async () => 1);
    const tx = { $executeRaw: execute } as unknown as Prisma.TransactionClient;
    const requestKey = randomUUID();
    await repository.lockApplicationRequest(tx, ctx, requestKey);
    await repository.lockApplicationRequest(
      tx,
      { ...ctx, tenantId: ctx.tenantId.toUpperCase(), userId: ctx.userId.toUpperCase() },
      requestKey.toUpperCase(),
    );
    const calls = execute.mock.calls as unknown as [TemplateStringsArray, string][];
    expect(calls[0]![0].join('?')).toContain('pg_advisory_xact_lock(hashtextextended(?, 0))');
    expect(calls[0]![1]).toBe(`outreach-template-use:${ctx.tenantId}:${ctx.userId}:${requestKey}`);
    expect(calls[1]![1]).toBe(calls[0]![1]);
    await repository.lockApplicationRequest(tx, { ...ctx, userId: randomUUID() }, requestKey);
    expect((execute.mock.calls as unknown as [unknown, string][])[2]![1]).not.toBe(calls[0]![1]);
  });

  const input = () => ({
    applicationId: randomUUID(),
    template: { id: randomUUID() } as never,
    version: { id: randomUUID(), contentHash: 'a'.repeat(64) } as never,
    sessionId: randomUUID(),
    requestKey: randomUUID(),
    requestFingerprint: 'b'.repeat(64),
    commandBatch: [],
    resultingStateVersion: 2,
    receipt: { inherited: [] },
  });

  it('records one application and provenance in the caller transaction', async () => {
    const repository = new OutreachTemplateRepository();
    const application = { id: randomUUID() };
    const query = jest.fn(async () => [application]);
    const execute = jest.fn(async () => 1);
    const tx = { $queryRaw: query, $executeRaw: execute } as unknown as Prisma.TransactionClient;
    await expect(repository.recordApplication(tx, ctx, input())).resolves.toEqual({
      application,
      replayed: false,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['23505', '08006'])(
    'propagates %s so the entire session transaction rolls back; never queries an aborted transaction',
    async (code) => {
      const repository = new OutreachTemplateRepository();
      const failure = Object.assign(new Error('synthetic database failure'), { code });
      const query = jest
        .fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce([{ requestFingerprint: 'b'.repeat(64) }]);
      const execute = jest.fn();
      const tx = { $queryRaw: query, $executeRaw: execute } as unknown as Prisma.TransactionClient;
      await expect(repository.recordApplication(tx, ctx, input())).rejects.toBe(failure);
      expect(query).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
