import type { TenantContext } from '@capiro/shared';
import { DefenseBudgetClientWatchController } from './defense-budget-client-watch.controller.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;

describe('DefenseBudgetClientWatchController', () => {
  test('binds every operation to the route client and tenant context', async () => {
    const watches = {
      list: jest.fn().mockResolvedValue([]),
      subscribe: jest.fn().mockResolvedValue({ id: 'watch-1' }),
      setSubscribed: jest.fn().mockResolvedValue({ eventType: 'unsubscribed' }),
      decide: jest.fn().mockResolvedValue({ eventType: 'acknowledged' }),
    };
    const controller = new DefenseBudgetClientWatchController(watches as never);

    await controller.list(ctx, 'client-1');
    await controller.subscribe(ctx, 'client-1', {
      targetType: 'pe',
      targetKey: '0600000A',
      clientReason: 'Supports the client priority.',
    });
    await controller.setSubscribed(ctx, 'client-1', 'watch-1', { subscribed: false });
    await controller.decide(ctx, 'client-1', 'watch-1', 'event-1', {
      decision: 'acknowledged',
    });

    expect(watches.list).toHaveBeenCalledWith(ctx, 'client-1');
    expect(watches.subscribe).toHaveBeenCalledWith(ctx, {
      clientId: 'client-1',
      targetType: 'pe',
      targetKey: '0600000A',
      clientReason: 'Supports the client priority.',
    });
    expect(watches.setSubscribed).toHaveBeenCalledWith(ctx, {
      clientId: 'client-1',
      watchId: 'watch-1',
      subscribed: false,
    });
    expect(watches.decide).toHaveBeenCalledWith(ctx, {
      clientId: 'client-1',
      watchId: 'watch-1',
      updateEventId: 'event-1',
      decision: 'acknowledged',
    });
  });
});
