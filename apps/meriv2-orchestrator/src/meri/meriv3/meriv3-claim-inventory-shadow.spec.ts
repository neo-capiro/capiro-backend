import {
  buildClaimInventoryEvent,
  scheduleClaimInventoryShadow,
} from './meriv3-claim-inventory-shadow';

describe('claim inventory shadow', () => {
  it('builds the structured aggregate without returning answer content', () => {
    expect(
      buildClaimInventoryEvent(
        {
          conversationId: 'conversation-1',
          turnId: 'turn-1',
          replyText: 'H.R. 1 passed.',
          citations: [],
          asOf: '2026-09-22T00:00:00.000Z',
          logger: { log: jest.fn(), warn: jest.fn() },
        },
        Date.now(),
      ),
    ).toMatchObject({
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      claims: 1,
      material: 1,
      uncited: 1,
      compound: 0,
      byKind: { fact: 1 },
      eligibilityFailures: {},
    });
  });

  it('does not run inventory until the zero-delay post-release callback', async () => {
    const order: string[] = ['emit'];
    const logger = { log: jest.fn(() => order.push('inventory')), warn: jest.fn() };
    const callbacks: Array<() => void> = [];
    const setTimer = ((callback: () => void, timeout?: number) => {
      if (timeout === 0) callbacks.push(callback);
      return 1 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
    scheduleClaimInventoryShadow({
      replyText: 'The bill passed.',
      citations: [],
      asOf: '2026-09-22T00:00:00.000Z',
      logger,
      setTimer,
    });
    expect(order).toEqual(['emit']);
    callbacks[0]?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['emit', 'inventory']);
  });

  it('swallows and logs inventory exceptions', async () => {
    const logger = { log: jest.fn(), warn: jest.fn() };
    const setTimer = ((callback: () => void, timeout?: number) => {
      if (timeout === 0) callback();
      return 1 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
    const input = {
      replyText: 'The bill passed.',
      citations: [],
      asOf: '2026-09-22T00:00:00.000Z',
      logger,
      setTimer,
    };
    Object.defineProperty(input, 'citations', {
      get() {
        throw new Error('inventory boom');
      },
    });
    scheduleClaimInventoryShadow(input);
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledWith(
      'meri.claim_inventory.failed',
      expect.objectContaining({ reason: 'inventory boom' }),
    );
  });
});
