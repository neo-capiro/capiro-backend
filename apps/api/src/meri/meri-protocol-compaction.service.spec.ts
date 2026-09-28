import { describe, expect, it, jest } from '@jest/globals';
import { MeriService } from './meri.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const REVISION = new Date('2026-09-28T12:00:00.000Z');

function harness() {
  const messages = Array.from({ length: 18 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    role: index % 2 ? 'assistant' : 'user',
    body: index === 0 ? 'Prepare the client briefing.' : 'x'.repeat(1000),
    clientId: null,
    metadata: index % 2 ? { finishReason: 'completed' } : {},
  }));
  const tx = {
    clioConversation: {
      findFirst: jest.fn(async () => ({
        summary: null,
        summaryUpToMessageId: null,
        clientId: null,
        userId: ACTOR,
        updatedAt: REVISION,
        metadata: { meriv3: { reasoningMode: 'max' } },
      })),
    },
    clioMessage: { findMany: jest.fn(async () => messages) },
    $executeRaw: jest.fn(async (_query: unknown): Promise<number> => 1),
  };
  const logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const service = Object.assign(Object.create(MeriService.prototype), {
    config: {
      get: jest.fn((key: string) => {
        if (key === 'CLIO_COMPACTION_ENABLED') return true;
        if (key === 'CLIO_COMPACTION_TRIGGER_TOKENS') return 1000;
        if (key === 'CLIO_COMPACTION_TAIL_MESSAGES') return 12;
        throw new Error(`Unexpected config key ${key}`);
      }),
    },
    prisma: { withTenant: jest.fn(async (_tenantId: string, callback: (value: typeof tx) => unknown) => callback(tx)) },
    logger,
  }) as MeriService;
  return { service, tx, logger };
}

describe('MeriService protocol compaction commit', () => {
  it('uses the old boundary as a CAS token and atomically merges protected metadata', async () => {
    const { service, tx, logger } = harness();

    await (service as any).maybeCompactConversation({ tenantId: TENANT, userId: ACTOR }, CONVERSATION);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const query = tx.$executeRaw.mock.calls[0]![0] as { strings: string[]; values: unknown[] };
    const sql = query.strings.join('?');
    expect(sql).toContain("jsonb_typeof(metadata_jsonb) = 'object'");
    expect(sql).toContain('summary_up_to_message_id IS NOT DISTINCT FROM');
    expect(sql).toContain('user_id =');
    expect(sql).toContain('client_id IS NOT DISTINCT FROM');
    expect(sql).toContain('updated_at =');
    expect(query.values).toContain(ACTOR);
    expect(query.values).toContain(REVISION);
    expect(query.values.some((value) =>
      typeof value === 'string' && value.includes('meriProtocolCompaction'))).toBe(true);
    expect(query.values.some((value) =>
      typeof value === 'string' && value.includes('Prepare the client briefing.'))).toBe(true);
    expect(logger.log).toHaveBeenCalledTimes(1);
  });

  it('allows only the concurrent boundary-CAS winner to report a committed compaction', async () => {
    const { service, tx, logger } = harness();
    tx.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await Promise.all([
      (service as any).maybeCompactConversation({ tenantId: TENANT, userId: ACTOR }, CONVERSATION),
      (service as any).maybeCompactConversation({ tenantId: TENANT, userId: ACTOR }, CONVERSATION),
    ]);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(logger.log).toHaveBeenCalledTimes(1);
  });

  it('rejects stale actor/client/revision publication instead of replacing the objective', async () => {
    const { service, tx, logger } = harness();
    tx.$executeRaw.mockResolvedValueOnce(0);

    await (service as any).maybeCompactConversation(
      { tenantId: TENANT, userId: ACTOR },
      CONVERSATION,
    );

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(logger.log).not.toHaveBeenCalled();
    const query = tx.$executeRaw.mock.calls[0]![0] as { strings: string[]; values: unknown[] };
    expect(query.strings.join('?')).toEqual(expect.stringContaining('updated_at ='));
    expect(query.values).toEqual(expect.arrayContaining([TENANT, ACTOR, null, REVISION]));
  });
});
