import { LiveHearingsController } from './live-hearings.controller.js';

describe('LiveHearingsController contract', () => {
  const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as never;

  function fixture() {
    const service = {
      calendar: jest.fn().mockResolvedValue({ rows: [{ id: 'h-1' }], total: 1, page: 1, pageSize: 25 }),
      live: jest.fn().mockResolvedValue({ rows: [{ id: 'h-live' }], asOf: '2026-08-21T00:00:00.000Z' }),
      event: jest.fn(),
      updates: jest.fn(),
      coverage: jest.fn(),
    };
    const committees = {
      committees: jest.fn().mockResolvedValue({
        rows: [{ systemCode: 'hsag00' }],
        total: 1,
        parentCount: 1,
        subcommitteeCount: 0,
        asOf: '2026-08-21T00:00:00.000Z',
      }),
      committee: jest.fn(),
      members: jest.fn(),
      updates: jest.fn(),
    };
    return {
      controller: new LiveHearingsController(service as never, committees as never),
      service,
      committees,
    };
  }

  it('normalizes the shipped frontend aliases to the canonical calendar contract', async () => {
    const { controller, service } = fixture();

    const result = await controller.calendar(ctx, {
      committeeId: 'hsag00',
      subcommitteeId: 'hsag16',
      scheduled: 'true',
      search: 'commodity',
      cursor: '3',
      limit: 25,
    } as never);

    expect(service.calendar).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        committee: 'hsag00',
        subcommittee: 'hsag16',
        followState: 'scheduled',
        q: 'commodity',
        page: 3,
        pageSize: 25,
      }),
    );
    expect(result).toMatchObject({
      rows: [{ id: 'h-1' }],
      items: [{ id: 'h-1' }],
      total: 1,
    });
  });

  it('keeps rows canonical while providing the compatibility items envelope for live', async () => {
    const { controller } = fixture();

    await expect(controller.live(ctx)).resolves.toMatchObject({
      rows: [{ id: 'h-live' }],
      items: [{ id: 'h-live' }],
    });
  });

  it('returns the canonical committee directory without deriving identities from events', async () => {
    const { controller, committees } = fixture();

    const result = await controller.committeeDirectory(ctx);

    expect(committees.committees).toHaveBeenCalledWith(ctx);
    expect(result.rows).toEqual([{ systemCode: 'hsag00' }]);
  });

  it('forwards the whitelisted sort direction to the calendar service', async () => {
    const { controller, service } = fixture();

    await controller.calendar(ctx, { sort: 'desc', jurisdiction: 'FL', pageSize: 1 } as never);

    expect(service.calendar).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ sort: 'desc', jurisdiction: 'FL', pageSize: 1 }),
    );
  });

  it('leaves the sort direction undefined by default (asc contract preserved)', async () => {
    const { controller, service } = fixture();

    await controller.calendar(ctx, { jurisdiction: 'FL' } as never);

    expect(service.calendar).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ sort: undefined }),
    );
  });
});
