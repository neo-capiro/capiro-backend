import { describe, expect, jest, test } from '@jest/globals';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { ClientCapabilityFitController } from './client-capability-fit.controller.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import type { ClientCapabilityFitService } from './client-capability-fit.service.js';

/**
 * HTTP contract for the capability-fit card.
 *
 * The GET must NOT compute. The PE fan-out behind a refresh runs with a 30s
 * transaction budget, so a lazily-computing GET (the pattern
 * target-recommendations uses) would stall the Capabilities tab on first paint
 * for every cold client. That difference is the whole reason this controller
 * exists separately, so it is pinned here.
 */
describe('ClientCapabilityFitController', () => {
  const ctx = { tenantId: 't1', userId: 'u1', role: 'standard_user' } as any;

  function makeController() {
    const service = {
      getFit: jest.fn<() => Promise<any>>().mockResolvedValue({
        matches: [],
        computedAt: null,
        status: 'empty',
        sources: { pe: true, bill: false, fo: false },
      }),
    } as unknown as ClientCapabilityFitService;
    return { controller: new ClientCapabilityFitController(service), service };
  }

  test('is mounted under the client-scoped capability-fit path', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ClientCapabilityFitController)).toBe(
      'clients/:clientId/capability-fit',
    );
  });

  test('is guarded by RolesGuard and requires standard_user, like the other client routes', () => {
    const guards = new Reflector().get<unknown[]>('__guards__', ClientCapabilityFitController) ?? [];
    expect(guards).toContain(RolesGuard);
    expect(new Reflector().get<string[]>(ROLES_KEY, ClientCapabilityFitController)).toContain(
      'standard_user',
    );
  });

  test('GET reads without refreshing, so a cold tab never waits on the PE fan-out', async () => {
    const { controller, service } = makeController();

    await controller.get(ctx, 'client-1');

    expect(service.getFit).toHaveBeenCalledWith(ctx, 'client-1');
  });

  test('POST refresh asks for a recompute', async () => {
    const { controller, service } = makeController();

    await controller.refresh(ctx, 'client-1');

    expect(service.getFit).toHaveBeenCalledWith(ctx, 'client-1', { refresh: true });
  });
});
