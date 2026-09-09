import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service.js';

const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' } as TenantContext;
const messageId = '33333333-3333-4333-8333-333333333333';
function setup() {
  const row = {
    id: messageId, tenantId: ctx.tenantId, userId: ctx.userId, conversationId: 'conversation-1',
    role: 'assistant', clientId: null, metadata: { citations: [{ id: 'source-1' }], turnScope: { kind: 'general' } } as Record<string, unknown>,
  };
  const tx = {
    $queryRaw: jest.fn(async (_sql: unknown) => [{ id: row.id }]),
    $executeRaw: jest.fn(async (sql: { sql: string; values: unknown[] }) => {
      if (!sql.sql.includes('UPDATE clio_messages')) return 0;
      row.metadata = { ...row.metadata, feedback: JSON.parse(String(sql.values[0])) };
      return 1;
    }),
    clioMessage: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value) ? { ...row } : null),
      findMany: jest.fn(async () => [{ ...row }]),
    },
    clioConversation: { findFirst: jest.fn(async () => ({ id: row.conversationId })) },
  };
  const capture = jest.fn(async () => undefined);
  const recordEvent = jest.fn(async () => undefined);
  const service = Object.assign(Object.create(MeriService.prototype), {
    prisma: { withTenant: jest.fn(async (_tenantId: string, callback: (db: typeof tx) => unknown) => callback(tx)) },
    logger: { warn: jest.fn() }, learningSignals: { capture }, qualityTelemetry: { recordEvent },
  }) as MeriService;
  return { service, tx, row, capture, recordEvent };
}

const feedbackWriteCount = (tx: ReturnType<typeof setup>['tx']) =>
  tx.$executeRaw.mock.calls.filter(([query]) => query.sql.includes('UPDATE clio_messages')).length;

describe('Phase 4 durable message feedback', () => {
  it.each(['up', 'down', null] as const)('persists %s and returns it in owned history without losing other metadata', async (rating) => {
    const { service, row, tx } = setup();
    await service.recordMessageFeedback(ctx, messageId, { rating, reasons: ['outdated'], note: ' Check date ' });
    const messages = await service.listMessages(ctx, row.conversationId);
    expect(messages[0]!.metadata).toMatchObject({
      citations: [{ id: 'source-1' }], turnScope: { kind: 'general' },
      feedback: { rating, reasons: ['outdated'], note: 'Check date', userId: ctx.userId },
    });
    expect(tx.clioMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      tenantId: ctx.tenantId, userId: ctx.userId, conversationId: row.conversationId,
    } }));
    const lock = tx.$queryRaw.mock.calls[0]![0] as unknown as { sql: string; values: unknown[] };
    expect(lock.sql).toContain('FOR UPDATE');
    expect(lock.values).toEqual([messageId, ctx.tenantId, ctx.userId]);
    const update = tx.$executeRaw.mock.calls[0]![0] as unknown as { sql: string; values: unknown[] };
    expect(update.sql).toContain('jsonb_set');
    expect(update.values.slice(1)).toEqual([messageId, ctx.tenantId, ctx.userId]);
  });

  it('does not duplicate a committed retry or reorder equivalent reason sets', async () => {
    const { service, tx, row, capture, recordEvent } = setup();
    await service.recordMessageFeedback(ctx, messageId, { rating: 'down', reasons: ['outdated', 'too_generic'], note: ' Date ' });
    const stored = row.metadata.feedback;
    await service.recordMessageFeedback(ctx, messageId, { rating: 'down', reasons: ['too_generic', 'outdated'], note: 'Date' });
    expect(feedbackWriteCount(tx)).toBe(1);
    expect(row.metadata.feedback).toBe(stored);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it('persists a change and clear as distinct values, but an identical clear is idempotent', async () => {
    const { service, row, tx, capture } = setup();
    await service.recordMessageFeedback(ctx, messageId, { rating: 'up' });
    await service.recordMessageFeedback(ctx, messageId, { rating: 'down', note: 'Needs detail' });
    await service.recordMessageFeedback(ctx, messageId, { rating: null });
    await service.recordMessageFeedback(ctx, messageId, { rating: null });
    expect(row.metadata.feedback).toMatchObject({ rating: null, reasons: [], note: null });
    expect(feedbackWriteCount(tx)).toBe(3);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it.each([{ ...ctx, userId: '44444444-4444-4444-8444-444444444444' }, { ...ctx, tenantId: '55555555-5555-4555-8555-555555555555' }])('rejects another owner before writing or collecting signals', async (foreign) => {
    const { service, tx, capture } = setup();
    await expect(service.recordMessageFeedback(foreign, messageId, { rating: 'up' })).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it('rejects feedback on user messages', async () => {
    const { service, row, tx } = setup(); row.role = 'user';
    await expect(service.recordMessageFeedback(ctx, messageId, { rating: 'up' })).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('leaves the saved selection untouched on a failed write, then allows a retry', async () => {
    const { service, tx, row, capture } = setup();
    await service.recordMessageFeedback(ctx, messageId, { rating: 'up' });
    tx.$executeRaw.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(service.recordMessageFeedback(ctx, messageId, { rating: 'down' })).rejects.toThrow('Database unavailable');
    expect(row.metadata.feedback).toMatchObject({ rating: 'up' });
    expect(capture).toHaveBeenCalledTimes(1);
    await service.recordMessageFeedback(ctx, messageId, { rating: 'down' });
    expect(row.metadata.feedback).toMatchObject({ rating: 'down' });
    expect(capture).toHaveBeenCalledTimes(2);
  });
});
