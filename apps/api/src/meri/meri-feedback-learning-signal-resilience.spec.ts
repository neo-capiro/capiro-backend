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
    clioMessage: {
      findFirst: jest.fn(async () => assistantMessage()),
      update: jest.fn(async () => undefined),
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
  return { service, tx };
}

describe('MeriService.recordMessageFeedback — learning-signal capture is non-blocking', () => {
  it('persists feedback even when learning-signal capture rejects', async () => {
    const capture = jest.fn(async (..._args: unknown[]): Promise<unknown> => {
      throw new Error('learning_signal insert failed');
    });
    const { service, tx } = buildService({ capture: capture as never });

    const result = await service.recordMessageFeedback(ctx, MESSAGE, { rating: 'down', reasons: ['inaccurate'] });

    expect(result.rating).toBe('down');
    expect(tx.clioMessage.update).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('persists feedback identically when no learning-signal collaborator is wired', async () => {
    const { service, tx } = buildService(undefined);

    const result = await service.recordMessageFeedback(ctx, MESSAGE, { rating: 'up' });

    expect(result.rating).toBe('up');
    expect(tx.clioMessage.update).toHaveBeenCalledTimes(1);
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
    expect(tx.clioMessage.update).toHaveBeenCalledTimes(1);
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
      expect(tx.clioMessage.update).toHaveBeenCalledTimes(1);
      expect(tx.learningSignal.create).toHaveBeenCalledTimes(1);
    });

    it('disabled: feedback still succeeds but no signal row is created', async () => {
      process.env.LEARNING_SIGNAL_CAPTURE = 'disabled';
      const { service, tx } = buildService(new LearningSignalCaptureService());

      const result = await service.recordMessageFeedback(ctx, MESSAGE, { rating: 'down', reasons: ['inaccurate'] });

      expect(result.rating).toBe('down');
      expect(tx.clioMessage.update).toHaveBeenCalledTimes(1);
      expect(tx.learningSignal.create).not.toHaveBeenCalled();
    });
  });
});
