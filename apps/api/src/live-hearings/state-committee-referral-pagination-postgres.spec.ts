import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { LiveHearingsService } from './live-hearings.service.js';

describe('Florida committee referrals on PostgreSQL', () => {
  jest.setTimeout(60000);
  const p = new PrismaService();
  const service = new LiveHearingsService(p);
  const tenantId = randomUUID(), suffix = randomUUID();
  const committeeId = `referral-committee-${suffix}`;
  const billIds = Array.from({ length: 26 }, (_, i) => `referral-bill-${suffix}-${String(i).padStart(2, '0')}`);
  const outsideId = `referral-other-session-${suffix}`;
  const ctx = { tenantId, tenantSlug: `referral-${suffix}`, userId: `reader-${suffix}`, clerkUserId: `reader-${suffix}`, role: 'standard_user' } as TenantContext;
  beforeAll(async () => {
    if (!process.env.DATABASE_URL || process.env.CAPIRO_DISPOSABLE_PG !== '1') throw Error('Disposable PostgreSQL is required');
    await p.$connect();
    await p.tenant.create({ data: { id: tenantId, slug: ctx.tenantSlug, name: 'Synthetic referral qualification' } });
    await p.$executeRaw`INSERT INTO intel_feature_flag(id,feature,tenant_id,enabled) VALUES(${randomUUID()},'legiwatch_state_calendar_v1',${tenantId},true)`;
    await p.stateCommittee.create({ data: { id: committeeId, state: 'FL', name: 'Synthetic Referral Committee', chamber: 'lower', legislativeSession: '2097', officialSourceKey: `FL:2097:H:${suffix}`, sourceEvidence: {} } });
    await p.stateBill.createMany({ data: [...billIds, outsideId].map((id, index) => ({ id, state: 'FL', session: id === outsideId ? '2098' : '2097', sessionKey: id === outsideId ? '2098' : '2097', identifier: 'HB 1', billNumber: 'hb1', title: `Synthetic referral ${index}`, currentCommitteeId: committeeId, latestActionDate: new Date('2097-01-01T00:00:00Z') })) });
  });
  afterAll(async () => {
    await p.stateBill.deleteMany({ where: { id: { in: [...billIds, outsideId] } } });
    await p.stateCommittee.deleteMany({ where: { id: committeeId } });
    await p.$executeRaw`DELETE FROM intel_feature_flag WHERE tenant_id=${tenantId}`;
    await p.tenant.deleteMany({ where: { id: tenantId } });
    await p.$disconnect();
  });
  it('reaches every same-session referral in stable pages without leaking the other session', async () => {
    const first = await service.stateBody(ctx, committeeId, 1);
    const second = await service.stateBody(ctx, committeeId, 2);
    expect(first.referredBills).toMatchObject({ total: 26, page: 1, pageSize: 25 });
    expect(second.referredBills).toMatchObject({ total: 26, page: 2, pageSize: 25 });
    expect(first.referredBills.rows.map((row) => row.id)).toEqual(billIds.slice(0, 25));
    expect(second.referredBills.rows.map((row) => row.id)).toEqual(billIds.slice(25));
    expect((await service.stateBody(ctx, committeeId, 3)).referredBills.rows).toEqual([]);
  });
});
