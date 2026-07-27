import { BadRequestException } from '@nestjs/common';
import { FeedController } from '../src/feed/feed.controller.js';

/**
 * Gate F c-3 (RB-01): an unrecognised workState must 400 at the controller
 * boundary rather than silently falling through to the default view — that
 * silent fallthrough is exactly how RB-01 shipped undetected. FeedController
 * is a thin pass-through with no other dependencies (guards run outside the
 * class), so it is instantiated directly, matching this codebase's existing
 * convention of unit-testing the class rather than going through Nest's HTTP
 * layer.
 */
function makeCtx() {
  return { tenantId: 't1', clerkUserId: 'u1' } as any;
}

describe('FeedController — workState validation (Gate F c-3)', () => {
  it('rejects an unrecognised workState on the per-client route', async () => {
    const svc = { getFeed: jest.fn() } as any;
    const controller = new FeedController(svc);
    expect(() => controller.getFeed(makeCtx(), 'c1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'not_a_real_state')).toThrow(
      BadRequestException,
    );
    expect(svc.getFeed).not.toHaveBeenCalled();
  });

  it('rejects an unrecognised workState on the tenant-wide (_all) route', async () => {
    const svc = { getFeed: jest.fn() } as any;
    const controller = new FeedController(svc);
    expect(() =>
      controller.getTenantFeed(makeCtx(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'bogus'),
    ).toThrow(BadRequestException);
    expect(svc.getFeed).not.toHaveBeenCalled();
  });

  it.each(['all', 'new', 'in_review', 'assigned', 'actioned', 'snoozed', 'dismissed'])(
    "accepts the recognised value '%s'",
    (v) => {
      const svc = { getFeed: jest.fn() } as any;
      const controller = new FeedController(svc);
      expect(() =>
        controller.getFeed(makeCtx(), 'c1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, v),
      ).not.toThrow();
      expect(svc.getFeed).toHaveBeenCalledTimes(1);
    },
  );

  it('omitted workState (default view) does not throw', () => {
    const svc = { getFeed: jest.fn() } as any;
    const controller = new FeedController(svc);
    expect(() =>
      controller.getFeed(makeCtx(), 'c1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined),
    ).not.toThrow();
    expect(svc.getFeed).toHaveBeenCalledTimes(1);
  });

  it('one bad value in a multi-value workState array still 400s', () => {
    const svc = { getFeed: jest.fn() } as any;
    const controller = new FeedController(svc);
    expect(() =>
      controller.getFeed(makeCtx(), 'c1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ['dismissed', 'nonsense']),
    ).toThrow(BadRequestException);
    expect(svc.getFeed).not.toHaveBeenCalled();
  });
});
