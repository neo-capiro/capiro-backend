import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { LiveHearingsService } from './live-hearings.service.js';
import { LegiWatchWave1Service } from './legiwatch-wave1.service.js';
import { federalHearingWhere } from '../hearing-discovery/hearing-geography.js';

describe('Phase 3 calendar selection and export on PostgreSQL', () => {
  jest.setTimeout(60000);
  const p = new PrismaService(),
    calendar = new LiveHearingsService(p);
  const wave = new LegiWatchWave1Service(p, null as never, null as never, null as never);
  const tenant = randomUUID(),
    suffix = randomUUID(),
    bill = 'fl-2097-' + suffix;
  const ids = Array.from(
    { length: 205 },
    (_, i) => `state-test-${suffix}-${String(i).padStart(3, '0')}`,
  );
  const foreign = 'state-other-' + suffix;
  const ctx: TenantContext = {
    tenantId: tenant,
    tenantSlug: 'phase3',
    userId: 'reader-' + suffix,
    clerkUserId: 'reader-' + suffix,
    role: 'standard_user',
  };
  const selection = {
    jurisdiction: 'FL' as const,
    session: '2097',
    from: '2097-01-02',
    to: '2097-01-02',
    billIds: [bill],
    eventType: 'committee',
  };
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw Error('Disposable PostgreSQL is required');
    await p.$connect();
    await p.tenant.create({
      data: { id: tenant, slug: 'calendar-query-' + suffix, name: 'Synthetic calendar query' },
    });
    await p.$executeRaw`INSERT INTO intel_feature_flag(id,feature,tenant_id,enabled) VALUES(${randomUUID()},'legiwatch_state_calendar_v1',${tenant},true)`;
    await p.stateBill.create({
      data: {
        id: bill,
        state: 'FL',
        session: '2097',
        sessionKey: '2097',
        identifier: 'HB 99',
        billNumber: 'hb99',
        title: 'Synthetic bill',
      },
    });
    await p.committeeHearing.createMany({
      data: [...ids, foreign].map((id) => ({
        id,
        geographicJurisdiction: 'FL',
        legislativeSession: '2097',
        chamber: 'House',
        committeeName: 'Synthetic state committee',
        title: 'Synthetic state proceeding',
        type: 'committee',
        date: new Date('2097-01-02T00:00:00Z'),
        startsAt: new Date('2097-01-02T15:00:00Z'),
        time: '10:00 AM',
        timezone: 'America/New_York',
        calendarRevision: 4,
        sourceRevision: 1,
        timePrecision: 'instant',
      })),
    });
    await p.legislativeAgendaItem.createMany({
      data: ids.map((hearingId) => ({
        hearingId,
        itemKey: bill,
        position: 0,
        kind: 'bill',
        title: 'HB 99',
        billScope: 'state',
        stateBillKey: bill,
        sourceUrl: 'https://example.gov/agenda',
        evidence: {},
        revision: 4,
      })),
    });
    await p.withTenant(tenant, (tx) =>
      tx.hearingFollow.create({
        data: { tenantId: tenant, userId: ctx.userId, hearingId: ids[204]! },
      }),
    );
  });
  afterAll(async () => {
    await p.legislativeAgendaItem.deleteMany({ where: { hearingId: { in: ids } } });
    await p.withTenant(tenant, (tx) =>
      tx.hearingFollow.deleteMany({ where: { tenantId: tenant } }),
    );
    await p.committeeHearing.deleteMany({ where: { id: { in: [...ids, foreign] } } });
    await p.stateBill.deleteMany({ where: { id: bill } });
    await p.$executeRaw`DELETE FROM intel_feature_flag WHERE tenant_id=${tenant}`;
    await p.tenant.deleteMany({ where: { id: tenant } });
    await p.$disconnect();
  });
  it('counts the exact bill selection before paging and exports every selected event beyond page one', async () => {
    const page = await calendar.calendar(ctx, { ...selection, page: 2, pageSize: 200 });
    expect(page.total).toBe(205);
    expect(page.rows.map((r) => r.id)).toEqual(ids.slice(200));
    const exported = await wave.calendarExportBulk(ctx, selection, 'https://os.capiro.ai');
    expect(exported.includedCount).toBe(205);
    expect(exported.skipped).toEqual([]);
    expect(exported.ics.match(/BEGIN:VEVENT/g)).toHaveLength(205);
    expect(exported.ics).not.toContain(foreign);
    expect(exported.ics).not.toContain('DTEND');
    expect(exported.ics.match(/SEQUENCE:5/g)).toHaveLength(205);
  });
  it('applies this user’s follows before paging without creating attendance or capture demand', async () => {
    const page = await calendar.calendar(ctx, { ...selection, following: true });
    expect(page.rows.map((r) => r.id)).toEqual([ids[204]]);
    expect(page.rows[0]?.following).toBe(true);
    const other = await calendar.calendar(
      { ...ctx, userId: 'different-reader' },
      { ...selection, following: true },
    );
    expect(other.total).toBe(0);
    expect(await p.publicHearingCapture.count({ where: { hearingId: { in: ids } } })).toBe(0);
    expect(
      await p.withTenant(tenant, (tx) =>
        tx.hearingSubscription.count({ where: { tenantId: tenant } }),
      ),
    ).toBe(0);
  });
  it('excludes state rows from both legacy federal read contracts', async () => {
    expect(
      await p.committeeHearing.count({ where: federalHearingWhere({ id: { in: ids } }) }),
    ).toBe(0);
    const rows = await p.$queryRawUnsafe<Array<{ n: number }>>(
      'SELECT count(*)::int AS n FROM federal_committee_hearing WHERE id=ANY($1::text[])',
      ids,
    );
    expect(rows[0]?.n).toBe(0);
  });
  it('rejects invalid dates and reports explicitly selected unavailable IDs', async () => {
    await expect(calendar.calendar(ctx, { ...selection, from: '2097-02-30' })).rejects.toThrow(
      'valid YYYY-MM-DD',
    );
    await expect(calendar.calendar(ctx, { ...selection, from: '2097-01-03' })).rejects.toThrow(
      'must not follow',
    );
    const result = await wave.calendarExportBulk(
      ctx,
      { ...selection, hearingIds: [ids[0]!, 'missing-event'] },
      'https://os.capiro.ai',
    );
    expect(result.includedCount).toBe(1);
    expect(result.skipped).toEqual([
      { id: 'missing-event', reason: 'Event unavailable in this selection' },
    ]);
  });
  it('fails closed for direct state queries and export when the tenant capability is off', async () => {
    await p.$executeRaw`UPDATE intel_feature_flag SET enabled=false WHERE tenant_id=${tenant}`;
    await expect(calendar.calendar(ctx, selection)).rejects.toThrow('not enabled');
    await expect(wave.calendarExportBulk(ctx, selection, 'https://os.capiro.ai')).rejects.toThrow(
      'not enabled',
    );
    await expect(wave.calendarExport(ctx, ids[0]!, 'https://os.capiro.ai')).rejects.toThrow(
      'not enabled',
    );
  });
});
