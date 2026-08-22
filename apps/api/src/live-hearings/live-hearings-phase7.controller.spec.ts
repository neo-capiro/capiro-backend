import { LiveHearingsPhase7Controller } from './live-hearings-phase7.controller.js';

describe('LiveHearingsPhase7Controller', () => {
  const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as never;

  function fixture() {
    const service = {
      room: jest.fn().mockResolvedValue({ event: { id: 'h-1' } }),
      transcript: jest.fn().mockResolvedValue({ hearingId: 'h-1', items: [] }),
      participation: jest.fn().mockResolvedValue({ scheduled: false, followed: false }),
      schedule: jest.fn().mockResolvedValue({ hearingId: 'h-1', oneCanonicalCapture: true }),
      cancelSchedule: jest.fn().mockResolvedValue({ hearingId: 'h-1', canonicalCapturePreserved: true }),
      follow: jest.fn().mockResolvedValue({ hearingId: 'h-1' }),
      unfollow: jest.fn().mockResolvedValue({ hearingId: 'h-1' }),
      browserJoin: jest.fn().mockResolvedValue({ mode: 'ATTACH_CANONICAL' }),
      recordings: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
      archive: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
      intelligenceSeam: jest.fn().mockResolvedValue({ status: 'PHASE_8_PERSISTENCE_NOT_ENABLED' }),
    };
    const scheduleGuard = {
      assertSchedulable: jest.fn().mockResolvedValue({ allowed: true }),
    };
    return {
      controller: new LiveHearingsPhase7Controller(service as never, scheduleGuard as never),
      service,
      scheduleGuard,
    };
  }

  it('gates schedule through the strict policy boundary before creating tenant demand', async () => {
    const { controller, service, scheduleGuard } = fixture();
    await controller.schedule(ctx, 'h-1');
    expect(scheduleGuard.assertSchedulable).toHaveBeenCalledWith('h-1');
    expect(service.schedule).toHaveBeenCalledWith(ctx, 'h-1');
    expect(scheduleGuard.assertSchedulable.mock.invocationCallOrder[0]).toBeLessThan(
      service.schedule.mock.invocationCallOrder[0]!,
    );
  });

  it('delegates canonical room, transcript and participation reads', async () => {
    const { controller, service } = fixture();
    await controller.room(ctx, 'h-1');
    await controller.transcript('h-1', { cursor: 'cursor', limit: 25 });
    await controller.participation(ctx, 'h-1');
    expect(service.room).toHaveBeenCalledWith(ctx, 'h-1');
    expect(service.transcript).toHaveBeenCalledWith('h-1', { cursor: 'cursor', limit: 25 });
    expect(service.participation).toHaveBeenCalledWith(ctx, 'h-1');
  });

  it('keeps cancel/follow/unfollow tenant scoped', async () => {
    const { controller, service } = fixture();
    await controller.cancelSchedule(ctx, 'h-1');
    await controller.follow(ctx, 'h-1');
    await controller.unfollow(ctx, 'h-1');
    expect(service.cancelSchedule).toHaveBeenCalledWith(ctx, 'h-1');
    expect(service.follow).toHaveBeenCalledWith(ctx, 'h-1');
    expect(service.unfollow).toHaveBeenCalledWith(ctx, 'h-1');
  });

  it('returns the safe browser handoff and list surfaces', async () => {
    const { controller, service } = fixture();
    await controller.joinBrowser(ctx, 'h-1');
    await controller.recordings(ctx, { page: 2, pageSize: 20 });
    await controller.archive(ctx, { page: 3, pageSize: 10, q: 'budget' });
    expect(service.browserJoin).toHaveBeenCalledWith(ctx, 'h-1');
    expect(service.recordings).toHaveBeenCalledWith(ctx, { page: 2, pageSize: 20 });
    expect(service.archive).toHaveBeenCalledWith(ctx, { page: 3, pageSize: 10, q: 'budget' });
  });

  it('keeps Phase 8 intelligence explicit rather than fabricating data', async () => {
    const { controller } = fixture();
    await expect(controller.intelligence('h-1')).resolves.toMatchObject({
      status: 'PHASE_8_PERSISTENCE_NOT_ENABLED',
    });
  });
});
