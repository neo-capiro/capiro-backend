import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { CommitteeDirectoryService } from './committee-directory.service.js';
import { LiveHearingsPhase7Service } from './live-hearings-phase7.service.js';
import { LiveHearingsService } from './live-hearings.service.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const TENANT_A = '00000000-0000-0000-0000-00000000007a';
const TENANT_B = '00000000-0000-0000-0000-00000000007b';
const HEARING_ID = 'phase7-hearing';

const ctxA: TenantContext = {
  tenantId: TENANT_A,
  tenantSlug: 'phase7-a',
  userId: 'phase7-user-a',
  clerkUserId: 'phase7-clerk-a',
  role: 'standard_user',
};
const ctxB: TenantContext = {
  tenantId: TENANT_B,
  tenantSlug: 'phase7-b',
  userId: 'phase7-user-b',
  clerkUserId: 'phase7-clerk-b',
  role: 'standard_user',
};

describeDb('LiveHearingsPhase7Service (Postgres)', () => {
  const prisma = new PrismaService();
  const hearings = new LiveHearingsService(prisma);
  const committees = new CommitteeDirectoryService(prisma, hearings);
  const phase7 = new LiveHearingsPhase7Service(prisma, hearings, committees);

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    try {
      // This public row is visible to other suites' real provenance selectors.
      // Delete our own fixture (and its cascading dependents) before releasing PG.
      await prisma.$executeRaw`DELETE FROM committee_hearing WHERE id=${HEARING_ID}`;
    } finally {
      await prisma.$disconnect();
    }
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE hearing_follow,
                public_hearing_capture_job,
                public_hearing_transcript_segment,
                public_hearing_capture_attempt,
                public_hearing_capture,
                hearing_subscription,
                hearing_stream_candidate,
                committee_site_update,
                committee_hearing
       CASCADE`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'phase7-a', 'Phase 7 A'),
              ($2::uuid, 'phase7-b', 'Phase 7 B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_A,
      TENANT_B,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing
         (id, chamber, committee_name, committee_system_code, title, type, date,
          starts_at, timezone, event_status, visibility, url,
          stream_availability, coverage_status)
       VALUES ($1, 'House', 'House Armed Services', 'hsas00',
               'Phase 7 integration hearing', 'hearing', CURRENT_DATE + 2,
               now() + interval '2 days', 'America/New_York', 'scheduled', 'public',
               'https://armedservices.house.gov/hearings/phase7',
               'unknown', 'discovered')`,
      HEARING_ID,
    );
  });

  it('two tenants scheduling one hearing produce one global capture and one preflight job', async () => {
    const [a, b] = await Promise.all([
      phase7.schedule(ctxA, HEARING_ID),
      phase7.schedule(ctxB, HEARING_ID),
    ]);

    expect(a).toMatchObject({ hearingId: HEARING_ID, oneCanonicalCapture: true });
    expect(b).toMatchObject({ hearingId: HEARING_ID, oneCanonicalCapture: true });

    const captures = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM public_hearing_capture WHERE hearing_id=$1`,
      HEARING_ID,
    );
    const subscriptions = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM hearing_subscription WHERE hearing_id=$1`,
      HEARING_ID,
    );
    const jobs = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count
       FROM public_hearing_capture_job
       WHERE hearing_id=$1 AND job_type='preflight'`,
      HEARING_ID,
    );

    expect(captures[0]?.count).toBe(1);
    expect(subscriptions[0]?.count).toBe(2);
    expect(jobs[0]?.count).toBe(1);
  });

  it('cancel removes only this user demand and never deletes canonical capture history or another tenant demand', async () => {
    await phase7.schedule(ctxA, HEARING_ID);
    await phase7.schedule(ctxB, HEARING_ID);
    await phase7.cancelSchedule(ctxA, HEARING_ID);

    const rows = await prisma.$queryRawUnsafe<Array<{ tenantId: string; userId: string }>>(
      `SELECT tenant_id::text AS "tenantId", user_id AS "userId"
       FROM hearing_subscription
       WHERE hearing_id=$1
       ORDER BY tenant_id`,
      HEARING_ID,
    );
    const captures = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM public_hearing_capture WHERE hearing_id=$1`,
      HEARING_ID,
    );

    expect(rows).toEqual([{ tenantId: TENANT_B, userId: ctxB.userId }]);
    expect(captures[0]?.count).toBe(1);
    expect((await phase7.participation(ctxA, HEARING_ID)).scheduled).toBe(false);
    expect((await phase7.participation(ctxB, HEARING_ID)).scheduled).toBe(true);
  });

  it('following is tenant-isolated and does not create capture demand', async () => {
    await phase7.follow(ctxA, HEARING_ID);

    expect((await phase7.participation(ctxA, HEARING_ID)).followed).toBe(true);
    expect((await phase7.participation(ctxB, HEARING_ID)).followed).toBe(false);

    const schedules = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM hearing_subscription WHERE hearing_id=$1`,
      HEARING_ID,
    );
    const captures = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM public_hearing_capture WHERE hearing_id=$1`,
      HEARING_ID,
    );
    expect(schedules[0]?.count).toBe(0);
    expect(captures[0]?.count).toBe(0);

    await phase7.unfollow(ctxA, HEARING_ID);
    expect((await phase7.participation(ctxA, HEARING_ID)).followed).toBe(false);
  });

  it('reads the one canonical transcript with gap markers and stable keyset pagination', async () => {
    const scheduled = await phase7.schedule(ctxA, HEARING_ID);
    const captureId = String(scheduled.captureId);
    await prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_transcript_segment
         (id, capture_id, sequence, start_ms, end_ms, text, speaker_label,
          transcription_confidence, is_final, has_gap_before)
       VALUES ('phase7-seg-1', $1, 1, 0, 1000, 'Opening statement', 'Chair', 0.98, true, false),
              ('phase7-seg-2', $1, 2, 2000, 3000, 'After reconnect', 'Witness', 0.94, true, true)`,
      captureId,
    );

    const first = await phase7.transcript(HEARING_ID, { limit: 1 });
    expect(first.total).toBe(2);
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await phase7.transcript(HEARING_ID, {
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items).toEqual([
      expect.objectContaining({
        id: 'phase7-seg-2',
        sequence: 2,
        text: 'After reconnect',
        speakerName: 'Witness',
        hasGapBefore: true,
        gapBefore: true,
      }),
    ]);
    expect(second.hasMore).toBe(false);
    expect(JSON.stringify(second)).not.toContain('deepgram');
  });

  it('browser join attaches to an active canonical capture instead of creating a duplicate browser transcript', async () => {
    const scheduled = await phase7.schedule(ctxA, HEARING_ID);
    await prisma.$executeRawUnsafe(
      `UPDATE public_hearing_capture
       SET status='capturing', domain_status='CAPTURING'
       WHERE id=$1`,
      String(scheduled.captureId),
    );

    expect(await phase7.browserJoin(ctxA, HEARING_ID)).toMatchObject({
      mode: 'ATTACH_CANONICAL',
      captureId: String(scheduled.captureId),
      reasonCode: 'CANONICAL_CAPTURE_ACTIVE',
    });
  });
});
