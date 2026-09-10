import { describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service.js';
import { LearningSignalCaptureService } from '../learning/learning-signal-capture.service.js';

/**
 * Phase 27A closure (handoff §A2): proves "capture failure does not undo the
 * originating product action" at the actual `recordMessageFeedback` call
 * site, not just inside LearningSignalCaptureService's own unit tests.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '66666666-6666-4666-8666-666666666666';
const ctx: TenantContext = { tenantId: TENANT, userId: USER } as TenantContext;

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE,
    tenantId: TENANT,
    userId: USER,
    conversationId: 'conversation-1',
    clientId: null,
    role: 'assistant',
    content: 'Here is the answer.',
    metadata: {},
    ...overrides,
  };
}

function buildService(learningSignals: Pick<LearningSignalCaptureService, 'capture'> | undefined) {
  const tx = {
    $queryRaw: jest.fn(async () => [{ id: MESSAGE }]),
    $executeRaw: jest.fn(async (_sql: { sql: string }) => 1),
    clioMessage: {
      findFirst: jest.fn(async () => assistantMessage()),
    },
    learningSignal: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'signal-1', ...args.data })),
      findFirst: jest.fn(async () => null),
    },
  };
  const prisma = { withTenant: jest.fn((_tenantId: string, cb: (tx: unknown) => unknown) => cb(tx)) };
  const service = new MeriService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    learningSignals as never,
  );
  return { service, tx, prisma };
}

const feedbackWriteCount = (tx: ReturnType<typeof buildService>['tx']) =>
  tx.$executeRaw.mock.calls.filter(([query]) => query.sql.includes('UPDATE clio_messages')).length;

describe('MeriService.recordMessageFeedback — learning-signal capture is non-blocking', () => {
  it('persists feedback even when learning-signal capture rejects', async () => {
    const capture = jest.fn(async (..._args: unknown[]): Promise<unknown> => {
      throw new Error('learning_signal insert failed');
    });
    const { service, tx } = buildService({ capture: capture as never });

    const result = await service.recordMessageFeedback(ctx, MESSAGE, { rating: 'down', reasons: ['inaccurate'] });

    expect(result.rating).toBe('down');
    expect(feedbackWriteCount(tx)).toBe(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('persists feedback identically when no learning-signal collaborator is wired', async () => {
    const { service, tx } = buildService(undefined);

    const result = await service.recordMessageFeedback(ctx, MESSAGE, { rating: 'up' });

    expect(result.rating).toBe('up');
    expect(feedbackWriteCount(tx)).toBe(1);
  });

  it('on success, captures a signal carrying human_explicit provenance and no sourceAuthority', async () => {
    const capture = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({
      status: 'captured',
      id: 'signal-1',
    }));
    const { service, tx } = buildService({ capture: capture as never });

    await service.recordMessageFeedback(ctx, MESSAGE, { rating: 'down', reasons: ['inaccurate'] });

    expect(capture).toHaveBeenCalledTimes(1);
    const [, input] = capture.mock.calls[0] as [unknown, { signalType: string; provenanceKind: string; sourceAuthority: unknown }];
    expect(input.signalType).toBe('meri_feedback_negative');
    expect(input.provenanceKind).toBe('human_explicit');
    expect(input.sourceAuthority).toBeFalsy();
    expect(feedbackWriteCount(tx)).toBe(1);
  });

  it('a cleared rating (no new signal) never calls capture()', async () => {
    const capture = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ status: 'captured', id: 'x' }));
    const { service } = buildService({ capture: capture as never });

    await service.recordMessageFeedback(ctx, MESSAGE, {});

    expect(capture).not.toHaveBeenCalled();
  });

  describe('LEARNING_SIGNAL_CAPTURE kill switch, end to end through the real capture service', () => {
    const prior = process.env.LEARNING_SIGNAL_CAPTURE;
    afterEach(() => {
      if (prior === undefined) delete process.env.LEARNING_SIGNAL_CAPTURE;
      else process.env.LEARNING_SIGNAL_CAPTURE = prior;
    });

    it('enabled (default): feedback succeeds and a real signal row is created', async () => {
      delete process.env.LEARNING_SIGNAL_CAPTURE;
      const { service, tx } = buildService(new LearningSignalCaptureService());

      const result = await service.recordMessageFeedback(ctx, MESSAGE, { rating: 'down', reasons: ['inaccurate'] });

      expect(result.rating).toBe('down');
      expect(feedbackWriteCount(tx)).toBe(1);
      expect(tx.learningSignal.create).toHaveBeenCalledTimes(1);
    });

    it('disabled: feedback still succeeds but no signal row is created', async () => {
      process.env.LEARNING_SIGNAL_CAPTURE = 'disabled';
      const { service, tx } = buildService(new LearningSignalCaptureService());

      const result = await service.recordMessageFeedback(ctx, MESSAGE, { rating: 'down', reasons: ['inaccurate'] });

      expect(result.rating).toBe('down');
      expect(feedbackWriteCount(tx)).toBe(1);
      expect(tx.learningSignal.create).not.toHaveBeenCalled();
    });
  });
});


describe('Meri feedback capture transaction savepoint', () => {
  function postgresCaptureHarness(failWithDatabaseError = false) {
    const { service, tx, prisma } = buildService(new LearningSignalCaptureService());
    const message = assistantMessage();
    const signals = new Map<string, string>();
    const commits: unknown[] = [];
    let aborted = false;
    let savepoint: Record<string, unknown> | null = null;
    const requireHealthy = () => {
      if (aborted) throw new Error('current transaction is aborted, commands ignored until end of transaction block');
    };
    tx.clioMessage.findFirst.mockImplementation(async () => { requireHealthy(); return message; });
    tx.$executeRaw.mockImplementation(async (query) => {
      const sql = query.sql.trim();
      if (sql.startsWith('ROLLBACK TO SAVEPOINT')) {
        if (!savepoint) throw new Error('No savepoint to roll back to');
        message.metadata = { ...savepoint };
        aborted = false;
        return 0;
      }
      requireHealthy();
      if (sql.startsWith('SAVEPOINT')) savepoint = { ...message.metadata };
      else if (sql.startsWith('RELEASE SAVEPOINT')) savepoint = null;
      else if (sql.startsWith('UPDATE clio_messages')) {
        const values = (query as { sql: string; values: unknown[] }).values;
        message.metadata = { ...message.metadata, feedback: JSON.parse(String(values[0])) };
      }
      return 1;
    });
    tx.learningSignal.create.mockImplementation(async ({ data }) => {
      requireHealthy();
      const key = String(data.idempotencyKey);
      if (failWithDatabaseError || signals.has(key)) {
        aborted = true;
        throw Object.assign(new Error(failWithDatabaseError ? 'database statement failure' : 'duplicate signal'), {
          code: failWithDatabaseError ? 'P2010' : 'P2002',
        });
      }
      const id = `signal-${signals.size + 1}`; signals.set(key, id); return { id, ...data };
    });
    // Real capture attempts this read after a P2002. PostgreSQL rejects it
    // until the caller restores the savepoint, not merely until JS catches.
    tx.learningSignal.findFirst.mockImplementation(async () => { requireHealthy(); return null; });
    prisma.withTenant.mockImplementation(async (_tenantId, callback) => {
      const before = { ...message.metadata };
      try {
        const result = await callback(tx);
        requireHealthy();
        commits.push((message.metadata as Record<string, unknown>).feedback);
        return result;
      } catch (error) {
        message.metadata = before;
        aborted = false;
        throw error;
      }
    });
    return { service, tx, message, commits, signals };
  }

  it.each(['down', null] as const)('commits up → %s → up after the original signal key repeats', async (middle) => {
    const { service, tx, message, commits, signals } = postgresCaptureHarness();
    await service.recordMessageFeedback(ctx, MESSAGE, { rating: 'up' });
    await service.recordMessageFeedback(ctx, MESSAGE, { rating: middle });
    await expect(service.recordMessageFeedback(ctx, MESSAGE, { rating: 'up' })).resolves.toMatchObject({ rating: 'up' });
    expect(message.metadata).toMatchObject({ feedback: { rating: 'up', userId: USER } });
    expect(commits).toHaveLength(3);
    expect(signals.size).toBe(middle === 'down' ? 2 : 1);
    expect(tx.$executeRaw.mock.calls.some(([query]) => query.sql.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
    expect(tx.$executeRaw.mock.calls.at(-1)?.[0].sql).toBe('RELEASE SAVEPOINT meri_feedback_learning');
  });

  it('restores a transaction aborted by optional learning SQL while committing the feedback itself', async () => {
    const { service, tx, message, commits } = postgresCaptureHarness(true);
    await expect(service.recordMessageFeedback(ctx, MESSAGE, { rating: 'down', note: 'Check the current date' })).resolves.toMatchObject({ rating: 'down' });
    expect(message.metadata).toMatchObject({ feedback: { rating: 'down', note: 'Check the current date' } });
    expect(commits).toHaveLength(1);
    const commands = tx.$executeRaw.mock.calls.map(([query]) => query.sql.trim());
    expect(commands[0]).toContain('UPDATE clio_messages');
    expect(commands.slice(1)).toEqual([
      'SAVEPOINT meri_feedback_learning',
      'ROLLBACK TO SAVEPOINT meri_feedback_learning',
      'RELEASE SAVEPOINT meri_feedback_learning',
    ]);
  });
});
