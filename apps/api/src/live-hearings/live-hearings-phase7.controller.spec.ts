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
    };
    const scheduleGuard = {
      assertSchedulable: jest.fn().mockResolvedValue({ allowed: true }),
    };
    const publicGuard = {
      assertPublic: jest.fn().mockResolvedValue(undefined),
    };
    const phase8 = {
      intelligence: jest.fn().mockResolvedValue({
        status: 'READY',
        items: [
          {
            id: 'phi-1',
            title: 'Commitment',
            summary: 'The witness committed to provide a report.',
            evidence: {
              segmentId: 'segment-1',
              sequence: 7,
              startMs: 10_000,
              endMs: 14_000,
              text: 'We will provide that report.',
            },
          },
        ],
      }),
    };
    return {
      controller: new LiveHearingsPhase7Controller(
        service as never,
        scheduleGuard as never,
        publicGuard as never,
        phase8 as never,
      ),
      service,
      scheduleGuard,
      publicGuard,
      phase8,
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

  it('guards canonical transcript reads to public proceedings before reading segments', async () => {
    const { controller, service, publicGuard } = fixture();
    await controller.transcript('h-1', { cursor: 'cursor', limit: 25 });
    expect(publicGuard.assertPublic).toHaveBeenCalledWith('h-1');
    expect(service.transcript).toHaveBeenCalledWith('h-1', { cursor: 'cursor', limit: 25 });
    expect(publicGuard.assertPublic.mock.invocationCallOrder[0]).toBeLessThan(
      service.transcript.mock.invocationCallOrder[0]!,
    );
  });

  it('delegates canonical room and participation reads', async () => {
    const { controller, service } = fixture();
    await controller.room(ctx, 'h-1');
    await controller.participation(ctx, 'h-1');
    expect(service.room).toHaveBeenCalledWith(ctx, 'h-1');
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

  it('promotes the established intelligence route while preserving legacy transcript aliases', async () => {
    const { controller, phase8 } = fixture();
    const query = {
      cursor: 'cursor',
      limit: 50,
      clientId: '00000000-0000-0000-0000-000000000001',
      onlyRelevant: true,
    };
    await expect(controller.intelligence(ctx, 'h-1', query)).resolves.toMatchObject({
      status: 'READY',
      items: [
        {
          id: 'phi-1',
          evidenceText: 'We will provide that report.',
          segmentId: 'segment-1',
          startMs: 10_000,
          endMs: 14_000,
          evidence: { sequence: 7 },
        },
      ],
    });
    expect(phase8.intelligence).toHaveBeenCalledWith(ctx, 'h-1', query);
  });
});
