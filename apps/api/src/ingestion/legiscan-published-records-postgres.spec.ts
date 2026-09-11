import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { persistPublishedRecords } from './legiscan-published-records.js';
import { queueLegiWatchReportRefresh } from './legiwatch-report-refresh.js';
import type { LegiscanBill } from '../external/legiscan/legiscan.client.js';

describe('published records PostgreSQL ingestion', () => {
  const prisma = new PrismaClient(),
    id = `fl-2094-${randomUUID()}`;
  const raw = {
    history: [
      { date: '2026-09-01', action: 'First action' },
      { date: '2026-09-01', action: 'Second action' },
    ],
    amendments: [
      {
        amendment_id: 71,
        date: '2026-09-01',
        title: 'First amendment',
        description: 'Published text',
        adopted: 0,
        url: 'https://example.gov/a71',
      },
      { amendment_id: 72, date: '2026-08-01', title: 'Late amendment', adopted: 0 },
    ],
    referrals: [],
    sasts: [],
  } as unknown as LegiscanBill;
  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes('localhost:55462') && process.env.CI !== 'true')
      throw new Error('Disposable PostgreSQL required');
    await prisma.$connect();
    await prisma.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title) VALUES(${id},'FL','2094','2094','HB 93','hb93','Synthetic record measure')`;
  });
  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM state_bill WHERE id=${id}`;
    await prisma.$disconnect();
  });
  it('persists same-day and late-dated occurrences once and replays without moving observation time', async () => {
    const start = new Date();
    await persistPublishedRecords(prisma, id, raw);
    const first = await prisma.stateBillPublishedRecord.findMany({
      where: { billKey: id },
      orderBy: { sourceIdentity: 'asc' },
    });
    expect(first).toHaveLength(4);
    expect(first.every((r) => r.firstObservedAt >= start)).toBe(true);
    await persistPublishedRecords(prisma, id, raw);
    expect(
      await prisma.stateBillPublishedRecord.findMany({
        where: { billKey: id },
        orderBy: { sourceIdentity: 'asc' },
      }),
    ).toEqual(first);
  });
  it('refreshes only the explicit tenant scope and unions the existing governed queue', async () => {
    const tenant = randomUUID(),
      folder = randomUUID(),
      cursor = `FL-${randomUUID()}`,
      providerId = Math.floor(Math.random() * 1e8) + 100000000;
    const user = randomUUID(),
      actor = `refresh-${user}`;
    await prisma.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenant}::uuid,${actor},'Synthetic refresh')`;
    await prisma.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${user}::uuid,${actor},${actor + '@example.invalid'})`;
    await prisma.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenant}::uuid,${user}::uuid,'standard_user','active')`;
    await prisma.$executeRaw`INSERT INTO intel_legiwatch_folder(id,tenant_id,name,owner_clerk_id,created_by,updated_at) VALUES(${folder},${tenant},'Synthetic refresh',${actor},${actor},now())`;
    await prisma.$executeRaw`INSERT INTO intel_legiwatch_folder_bill(id,tenant_id,folder_id,bill_id,session_key,jurisdiction,updated_by,updated_at) VALUES(${randomUUID()},${tenant},${folder},${id},'2094','FL','synthetic-owner',now())`;
    await prisma.stateBill.update({ where: { id }, data: { legiscanBillId: providerId } });
    await prisma.stateSyncCursor.create({
      data: {
        id: cursor,
        state: 'FL',
        sessionKey: '2094',
        sessionId: providerId,
        pendingBills: [7],
      },
    });
    try {
      expect(await queueLegiWatchReportRefresh(prisma, randomUUID(), ['FL'])).toEqual({
        eligible: 0,
        queued: 0,
      });
      expect(await queueLegiWatchReportRefresh(prisma, tenant, ['FL'])).toEqual({
        eligible: 1,
        queued: 1,
      });
      expect(await queueLegiWatchReportRefresh(prisma, tenant, ['FL'])).toEqual({
        eligible: 1,
        queued: 0,
      });
      expect(
        (await prisma.stateSyncCursor.findUniqueOrThrow({ where: { id: cursor } })).pendingBills,
      ).toEqual([7, providerId]);
      await prisma.stateBill.update({
        where: { id },
        data: { sourceCheckStatus: 'success', sourceCheckedAt: new Date() },
      });
      expect(await queueLegiWatchReportRefresh(prisma, tenant, ['FL'])).toEqual({
        eligible: 0,
        queued: 0,
      });
    } finally {
      await prisma.stateSyncCursor.delete({ where: { id: cursor } });
      await prisma.$executeRaw`DELETE FROM intel_legiwatch_folder_bill WHERE folder_id=${folder}`;
      await prisma.$executeRaw`DELETE FROM intel_legiwatch_folder WHERE id=${folder}`;
      await prisma.$executeRaw`DELETE FROM tenant_memberships WHERE tenant_id=${tenant}::uuid`;
      await prisma.$executeRaw`DELETE FROM users WHERE id=${user}::uuid`;
      await prisma.$executeRaw`DELETE FROM tenants WHERE id=${tenant}::uuid`;
    }
  });
  it('retains amendment revision history and distinguishes checked-empty optional references', async () => {
    const revised = {
      ...raw,
      amendments: [{ ...raw.amendments![0]!, adopted: 1 as const }, raw.amendments![1]!],
    };
    await persistPublishedRecords(prisma, id, revised);
    expect(await prisma.stateBillPublishedRecord.count({ where: { billKey: id } })).toBe(5);
    const bill = await prisma.stateBill.findUniqueOrThrow({ where: { id } });
    expect(bill.reportSourceFacts).toMatchObject({
      coverage: { actions: true, amendments: true, committees: true, relations: true },
    });
  });
});
