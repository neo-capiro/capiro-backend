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

/**
 * Certification-pass regression: `getFeed()` always answers with the
 * paginated envelope (`{items, nextCursor, hasMore, counts, ...}`), even when
 * narrowed to one `alertId` — it is the list method, reused here for its
 * filtering/decoration pipeline rather than duplicated. `useLwAlert` on the
 * web client expects a single `FeedItem | null`, so `getAlert`/
 * `getTenantAlert` MUST unwrap `items[0]` themselves; returning the envelope
 * verbatim silently hands the frontend an object with no `sourceType` /
 * `evidence` / `workState`, which crashed `PacketDrawer` — a bare
 * `it.sourceType.toUpperCase()` — on EVERY alert opened, in EVERY client
 * scope, live in production.
 */
describe('FeedController — single-alert routes unwrap the list envelope', () => {
  const ENVELOPE_KEYS = ['nextCursor', 'hasMore', 'counts', 'severityCounts', 'total', 'workStateCounts'];

  it('getAlert (per-client) returns the bare item, not the envelope', async () => {
    const item = { id: 'a1', clientId: 'c1', sourceType: 'bill', evidence: {}, workState: { state: 'new' } };
    const svc = { getFeed: jest.fn().mockResolvedValue({ items: [item], nextCursor: null, hasMore: false, counts: {}, severityCounts: {}, total: 1, workStateCounts: {} }) } as any;
    const controller = new FeedController(svc);
    const result = await controller.getAlert(makeCtx(), 'c1', 'a1');
    expect(result).toEqual(item);
    for (const key of ENVELOPE_KEYS) expect(result).not.toHaveProperty(key);
    expect(svc.getFeed).toHaveBeenCalledWith('t1', 'c1', expect.objectContaining({ alertId: 'a1', limit: 1 }));
  });

  it('getTenantAlert (_all) returns the bare item, not the envelope', async () => {
    const item = { id: 'a1', clientId: 'c9', sourceType: 'hearing', evidence: {}, workState: { state: 'new' } };
    const svc = { getFeed: jest.fn().mockResolvedValue({ items: [item], nextCursor: null, hasMore: false, counts: {}, severityCounts: {}, total: 1, workStateCounts: {} }) } as any;
    const controller = new FeedController(svc);
    const result = await controller.getTenantAlert(makeCtx(), 'a1');
    expect(result).toEqual(item);
    for (const key of ENVELOPE_KEYS) expect(result).not.toHaveProperty(key);
    // clientId=null is the tenant-wide predicate (never the literal '_all')
    expect(svc.getFeed).toHaveBeenCalledWith('t1', null, expect.objectContaining({ alertId: 'a1', limit: 1 }));
  });

  it('getAlert returns null (not an empty envelope) when the alert is not found', async () => {
    const svc = { getFeed: jest.fn().mockResolvedValue({ items: [], nextCursor: null, hasMore: false, counts: {}, severityCounts: {}, total: 0, workStateCounts: {} }) } as any;
    const controller = new FeedController(svc);
    expect(await controller.getAlert(makeCtx(), 'c1', 'ghost')).toBeNull();
  });

  it('getTenantAlert returns null (not an empty envelope) when the alert is not found', async () => {
    const svc = { getFeed: jest.fn().mockResolvedValue({ items: [], nextCursor: null, hasMore: false, counts: {}, severityCounts: {}, total: 0, workStateCounts: {} }) } as any;
    const controller = new FeedController(svc);
    expect(await controller.getTenantAlert(makeCtx(), 'ghost')).toBeNull();
  });
});
