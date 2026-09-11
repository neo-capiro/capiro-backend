import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import {
  ClientBriefContextQueryDto,
  InternalLegiWatchController,
} from './internal-legiwatch.controller.js';
import type { LegiWatchWave1Service } from './legiwatch-wave1.service.js';

describe('InternalLegiWatchController', () => {
  it('is gated by InternalServiceGuard, never RolesGuard — a user JWT must not reach it', () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, InternalLegiWatchController) ?? [];
    expect(guards).toContain(InternalServiceGuard);
  });

  it('forwards tenantId/clientId and a trimmed hearingId to the service', async () => {
    const clientBriefContext = jest.fn().mockResolvedValue({ clientName: 'Anduril', relevance: null });
    const wave1 = { clientBriefContext } as unknown as LegiWatchWave1Service;
    const controller = new InternalLegiWatchController(wave1, {} as never);
    const query: ClientBriefContextQueryDto = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      clientId: '22222222-2222-4222-8222-222222222222',
      hearingId: '  cm-119-119533 ',
    };
    await expect(controller.clientBriefContext(query)).resolves.toEqual({
      clientName: 'Anduril',
      relevance: null,
    });
    expect(clientBriefContext).toHaveBeenCalledWith(query.tenantId, query.clientId, 'cm-119-119533');
  });

  it('passes null for an absent or blank hearingId (ad-hoc sessions have no canonical hearing)', async () => {
    const clientBriefContext = jest.fn().mockResolvedValue({ clientName: 'Anduril', relevance: null });
    const controller = new InternalLegiWatchController({
      clientBriefContext,
    } as unknown as LegiWatchWave1Service, {} as never);
    const base = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      clientId: '22222222-2222-4222-8222-222222222222',
    };
    await controller.clientBriefContext(base);
    await controller.clientBriefContext({ ...base, hearingId: '   ' });
    expect(clientBriefContext).toHaveBeenNthCalledWith(1, base.tenantId, base.clientId, null);
    expect(clientBriefContext).toHaveBeenNthCalledWith(2, base.tenantId, base.clientId, null);
  });
});
