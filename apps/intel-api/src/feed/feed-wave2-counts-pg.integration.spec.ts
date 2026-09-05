/**
 * LegiWatch V2 Wave 2 (W2-3) — exact Feed work-state bucket counts, against a
 * real Postgres.
 *
 * Proves three things the approximate `items.length + (hasMore?1:0)` floor
 * (the old `useLwBucketCount`) could not:
 *
 *   1. counts are EXACT across the whole filtered set, not just the loaded
 *      page (seeded here with more rows than one page holds);
 *   2. faceting semantics — the work-state facet reflects every OTHER active
 *      filter (severity) but never its own dimension;
 *   3. moving one alert between two states changes exactly those two buckets,
 *      by exactly one each, and no others.
 */
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { HearingCryptoService } from '../hearing/hearing-crypto.service.js';
import { ActionItemService } from './action-item.service.js';
import { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import { AlertWorkStateService } from './alert-work-state.service.js';
import { TrackerWatchlistService } from '../tracker/tracker-watchlist.service.js';
import { FeedService } from './feed.service.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
jest.setTimeout(180_000);

const TENANT = '00000000-0000-0000-0000-0000000000e9';
const CLIENT = '00000000-0000-0000-0000-00000000ce91';
const USER = 'lw-w2-feed-user';

describeDb('LegiWatch W2-3 Feed exact counts (real Postgres)', () => {
  const prisma = new PrismaService();
  const watchlist = new TrackerWatchlistService(prisma);
  const actions = new ActionItemService(prisma, watchlist);
  const sourceData = new SourceDataRepository(prisma);
  const crypto = new HearingCryptoService(new ConfigService({}));
  const workState = new AlertWorkStateService(prisma, watchlist);
  const feed = new FeedService(prisma, crypto, actions, sourceData, workState);

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE intel_alert_work_state, intel_alert, clients CASCADE`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'lw-w2-feed', 'Feed Counts Tenant')
       ON CONFLICT (id) DO NOTHING`,
      TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clients (id, tenant_id, name, status) VALUES ($1::uuid, $2::uuid, 'Aperture', 'active')
       ON CONFLICT (id) DO NOTHING`,
      CLIENT,
      TENANT,
    );

    // 30 alerts: more than one page (DEFAULT_LIMIT=25), across two
    // severities, all starting in the implicit 'new' bucket (no work-state
    // row at all). alert-0..19 are 'bill'/notable; alert-20..29 are
    // 'hearing'/critical.
    const values = Array.from({ length: 30 }, (_, idx) => {
      const critical = idx >= 20;
      return `($1, $2, '${critical ? 'hearing' : 'bill'}', 'ref-${idx}', 'x', 'kind', 'alert-${idx}', '${critical ? 'critical' : 'notable'}', 'medium', 'new')`;
    }).join(', ');
    await prisma.$executeRawUnsafe(
      `INSERT INTO intel_alert (tenant_id, client_id, source_type, source_ref, title, kind, id, severity, materiality, status)
       VALUES ${values}`,
      TENANT,
      CLIENT,
    );
  });

  it('reports the exact total across the whole filtered set, not one page', async () => {
    const result = await feed.getFeed(TENANT, CLIENT, { userId: USER, limit: 10 });
    expect(result.items).toHaveLength(10); // one page
    expect(result.total).toBe(30); // the WHOLE filtered set
  });

  it('every alert with no work-state row buckets as "new", exactly', async () => {
    const result = await feed.getFeed(TENANT, CLIENT, { userId: USER, limit: 1 });
    expect(result.workStateCounts).toEqual({
      new: 30,
      in_review: 0,
      assigned: 0,
      actioned: 0,
      snoozed: 0,
      dismissed: 0,
    });
  });

  it('the work-state facet respects an active severity filter (a DIFFERENT dimension)', async () => {
    const result = await feed.getFeed(TENANT, CLIENT, {
      userId: USER,
      limit: 1,
      severities: ['critical'],
    });
    // Only the 10 critical alerts should count, not all 30.
    expect(result.workStateCounts?.new).toBe(10);
    expect(result.total).toBe(10);
  });

  it('the work-state facet does NOT respect its own dimension — selecting one bucket does not zero the others', async () => {
    await workState.setState(TENANT, CLIENT, 'alert-0', USER, { state: 'in_review' });
    const result = await feed.getFeed(TENANT, CLIENT, {
      userId: USER,
      limit: 1,
      workStates: ['in_review'],
    });
    // The ITEMS are narrowed to in_review (that's the filter working)...
    expect(result.total).toBe(1);
    // ...but the FACET still shows all six buckets as if no work-state filter
    // were applied — exactly the faceted-search convention documented in
    // feed.service.ts.
    expect(result.workStateCounts).toEqual({
      new: 29,
      in_review: 1,
      assigned: 0,
      actioned: 0,
      snoozed: 0,
      dismissed: 0,
    });
  });

  it('moving one alert NEW → IN_REVIEW changes exactly two buckets by exactly one each', async () => {
    const before = (await feed.getFeed(TENANT, CLIENT, { userId: USER, limit: 1 })).workStateCounts!;
    await workState.setState(TENANT, CLIENT, 'alert-5', USER, { state: 'in_review' });
    const after = (await feed.getFeed(TENANT, CLIENT, { userId: USER, limit: 1 })).workStateCounts!;

    expect(after.new).toBe(before.new - 1);
    expect(after.in_review).toBe(before.in_review + 1);
    expect(after.assigned).toBe(before.assigned);
    expect(after.actioned).toBe(before.actioned);
    expect(after.snoozed).toBe(before.snoozed);
    expect(after.dismissed).toBe(before.dismissed);
  });

  it('an expired snooze buckets as "new", not "snoozed" — matching the item-fetch path exactly', async () => {
    await workState.setState(TENANT, CLIENT, 'alert-1', USER, {
      state: 'snoozed',
      snoozedUntil: new Date(Date.now() - 60_000), // already expired
    });
    const result = await feed.getFeed(TENANT, CLIENT, { userId: USER, limit: 1 });
    expect(result.workStateCounts?.snoozed).toBe(0);
    expect(result.workStateCounts?.new).toBe(30);

    // And the item-fetch path (the 'new' filter) must agree: an expired
    // snooze is default-visible again, so it appears under 'new' there too.
    const newView = await feed.getFeed(TENANT, CLIENT, {
      userId: USER,
      limit: 50,
      workStates: ['new'],
    });
    expect(newView.items.map((i) => i.id)).toContain('alert-1');
  });

  it('an ACTIVE snooze buckets as "snoozed", not "new"', async () => {
    await workState.setState(TENANT, CLIENT, 'alert-2', USER, {
      state: 'snoozed',
      snoozedUntil: new Date(Date.now() + 60 * 60_000),
    });
    const result = await feed.getFeed(TENANT, CLIENT, { userId: USER, limit: 1 });
    expect(result.workStateCounts?.snoozed).toBe(1);
    expect(result.workStateCounts?.new).toBe(29);
  });

  it('is scoped per-tenant/client — never counts another client’s alerts', async () => {
    const otherClient = '00000000-0000-0000-0000-00000000ce92';
    await prisma.$executeRawUnsafe(
      `INSERT INTO clients (id, tenant_id, name, status) VALUES ($1::uuid, $2::uuid, 'Other', 'active')`,
      otherClient,
      TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO intel_alert (tenant_id, client_id, source_type, source_ref, title, kind, id, severity, materiality, status)
       VALUES ($1, $2, 'bill', 'ref-other', 'x', 'kind', 'alert-other', 'notable', 'medium', 'new')`,
      TENANT,
      otherClient,
    );
    const result = await feed.getFeed(TENANT, CLIENT, { userId: USER, limit: 1 });
    expect(result.total).toBe(30); // unaffected by the other client's alert
  });
});
