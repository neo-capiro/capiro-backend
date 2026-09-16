import { describe, expect, it, jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import { IntelligenceService } from './intelligence.service.js';

/**
 * getComingUp must apply the SAME owner predicate (ownMeetingWhere) as the
 * engagement meetings endpoint, keep the tenant scope (withTenant), keep the
 * tomorrow→+7d window, and still exclude cancelled/canceled/deleted meetings.
 * Synthetic fixtures only: the prisma surface is a jest mock, so the
 * assertions pin the QUERY CONTRACT, not DB-level isolation.
 */

const TOMORROW_ET = new Date('2026-09-16T04:00:00.000Z'); // Sep 16 00:00 ET

function meetingRow(id: string, subject: string, startsAt: Date) {
  return {
    id,
    subject,
    startsAt,
    location: null,
    organizerName: null,
    organizerEmail: null,
  };
}

function makeService(meetings: Array<ReturnType<typeof meetingRow>>) {
  // `any` matches the established mock convention in this suite's siblings
  // (district-nexus-representatives.spec.ts) so jest's untyped call tuples
  // can be asserted on directly.
  const prisma: any = {
    withTenant: jest.fn(async (_tid: string, fn: (t: any) => Promise<unknown>) => fn(tenantTx)),
    committeeHearing: { findMany: jest.fn(async () => []) },
    federalRegisterDocument: { findMany: jest.fn(async () => []) },
  };
  const tenantTx: any = {
    meeting: { findMany: jest.fn(async () => meetings) },
    client: { findMany: jest.fn(async () => [{ id: 'c1' }]) },
  };
  const svc = new IntelligenceService(prisma as never);
  return { svc, tenantTx, prisma };
}

describe('IntelligenceService.getComingUp meeting ownership (query contract)', () => {
  it('scopes the meeting query to the current user via ownMeetingWhere', async () => {
    const { svc, tenantTx } = makeService([meetingRow('m-own', 'My prep session', TOMORROW_ET)]);

    const result = await svc.getComingUp('tenant-1', 'user-1');

    expect(tenantTx.meeting.findMany).toHaveBeenCalledTimes(1);
    const where = tenantTx.meeting.findMany.mock.calls[0][0].where;
    // ownMeetingWhere: created by this user OR synced via their connection.
    expect(where.OR).toEqual([
      { createdByUserId: 'user-1' },
      { connection: { createdByUserId: 'user-1' } },
    ]);
    // Tenant scope is preserved via withTenant (RLS), and the date range stays
    // the same tomorrow→+7d window (exactly 7 days between bounds).
    expect(where.startsAt.gte).toBeInstanceOf(Date);
    expect(where.startsAt.lte).toBeInstanceOf(Date);
    expect(where.startsAt.lte.getTime() - where.startsAt.gte.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    // Cancellation/soft-delete rows stay excluded.
    expect(where.status).toEqual({ notIn: ['cancelled', 'canceled', 'deleted'] });

    const meetingItem = result.items.find((i: { kind: string }) => i.kind === 'meeting');
    expect(meetingItem).toMatchObject({
      id: 'meeting-m-own',
      href: '/engagement/meetings/m-own',
    });
  });

  it('yields zero meeting items when the owner-scoped query returns no rows', async () => {
    // The ownership enforcement is asserted above at the QUERY CONTRACT
    // level (the ownMeetingWhere predicate the service sends). This case
    // checks the mapping on an empty owned-query result — no DB isolation
    // against another user's rows is exercised here.
    const { svc } = makeService([]);
    const result = await svc.getComingUp('tenant-1', 'user-1');
    expect(result.items.filter((i: { kind: string }) => i.kind === 'meeting')).toHaveLength(0);
    expect(result.totalThisWeek).toBe(0);
  });

  it('runs inside withTenant with the caller\'s tenant', async () => {
    const { svc, prisma } = makeService([]);
    await svc.getComingUp('tenant-1', 'user-1');
    expect(prisma.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
  });

  it('fails closed when identity is unavailable (empty userId)', async () => {
    const { svc } = makeService([]);
    await expect(svc.getComingUp('tenant-1', '')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});