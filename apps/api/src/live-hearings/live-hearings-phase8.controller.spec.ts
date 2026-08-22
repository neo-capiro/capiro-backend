import { LiveHearingsPhase8Controller } from './live-hearings-phase8.controller.js';

describe('LiveHearingsPhase8Controller', () => {
  it('passes tenant context, hearing id and bounded query to the Phase 8 service', async () => {
    const service = {
      intelligence: jest.fn().mockResolvedValue({ hearingId: 'hearing-1', status: 'READY' }),
    };
    const controller = new LiveHearingsPhase8Controller(service as never);
    const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as never;
    const query = {
      cursor: 'cursor',
      limit: 125,
      clientId: '00000000-0000-0000-0000-000000000001',
      onlyRelevant: true,
    };

    await expect(controller.intelligence(ctx, 'hearing-1', query)).resolves.toMatchObject({
      hearingId: 'hearing-1',
      status: 'READY',
    });
    expect(service.intelligence).toHaveBeenCalledWith(ctx, 'hearing-1', query);
  });
});
