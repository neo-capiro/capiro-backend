import { PrismaService } from '../../prisma/prisma.service.js';
import { HearingSubscriptionRepository } from './hearing-subscription.repository.js';
import { PublicHearingCaptureStore } from './public-hearing-capture.store.js';

/**
 * RLS / tenant-isolation proof (Phase 4 exit gate item 15).
 *
 * The runtime DB role (capiro_app) is a member of the table-owner role and
 * BYPASSES Postgres RLS in this cluster (see PrismaService's documented
 * rationale) — so the real isolation boundary is the in-query tenant_id
 * predicate, not the RLS policy alone. This proves that boundary holds for
 * HearingSubscription while the GLOBAL capture/transcript layer stays
 * tenant-free, using real disposable Postgres.
 */
describe('hearing capture RLS / tenant isolation (Postgres)', () => {
  const prisma = new PrismaService();
  const subs = new HearingSubscriptionRepository(prisma);
  const store = new PublicHearingCaptureStore(prisma);
  const tenantA = '00000000-0000-0000-0000-0000000000a1';
  const tenantB = '00000000-0000-0000-0000-0000000000b2';

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE public_hearing_transcript_segment, public_hearing_capture_attempt, public_hearing_capture, hearing_subscription, committee_hearing CASCADE`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id,slug,name) VALUES
        ($1::uuid,'rls-test-a','RLS Test A'),
        ($2::uuid,'rls-test-b','RLS Test B')
       ON CONFLICT (id) DO NOTHING`,
      tenantA,
      tenantB,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing (id,chamber,committee_name,title,date,starts_at,event_status,visibility)
       VALUES ('rls-hearing','Senate','Test','RLS Hearing',CURRENT_DATE,now(),'scheduled','public')`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO hearing_subscription (tenant_id,user_id,hearing_id) VALUES
        ($1::uuid,'user-a','rls-hearing'),
        ($2::uuid,'user-b','rls-hearing')`,
      tenantA,
      tenantB,
    );
  });

  it('tenant A sees only its own subscription and cannot see tenant B', async () => {
    const rowsForA = await subs.list(tenantA, 'rls-hearing');
    expect(rowsForA).toHaveLength(1);
    expect(rowsForA[0]?.userId).toBe('user-a');
    expect(rowsForA.some((r) => r.userId === 'user-b')).toBe(false);
  });

  it('tenant B sees only its own subscription and cannot see tenant A', async () => {
    const rowsForB = await subs.list(tenantB, 'rls-hearing');
    expect(rowsForB).toHaveLength(1);
    expect(rowsForB[0]?.userId).toBe('user-b');
    expect(rowsForB.some((r) => r.userId === 'user-a')).toBe(false);
  });

  it('the global capture/demand layer is not tenant-owned and carries no tenant identifiers', async () => {
    const demand = await store.getDemand('rls-hearing');
    expect(demand.activeSubscriptionCount).toBe(2);
    const capture = await store.ensureCapture({ hearingId: 'rls-hearing', idempotencyKey: 'k', now: new Date() });
    const raw = JSON.stringify(capture);
    expect(raw).not.toContain(tenantA);
    expect(raw).not.toContain(tenantB);
    expect(raw).not.toContain('user-a');
    expect(raw).not.toContain('user-b');
    const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='public_hearing_capture'`,
    );
    expect(columns.some((c) => c.column_name === 'tenant_id')).toBe(false);
  });
});
