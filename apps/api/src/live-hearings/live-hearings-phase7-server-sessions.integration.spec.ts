import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { CommitteeDirectoryService } from './committee-directory.service.js';
import { LiveHearingsPhase7Service } from './live-hearings-phase7.service.js';
import { LiveHearingsService } from './live-hearings.service.js';

// Disposable-PG opt-in: these specs TRUNCATE shared hearing tables, so they run
// ONLY against an explicitly disposable regression database — never merely
// because any DATABASE_URL happens to be present. Set
// CAPIRO_DISPOSABLE_PG=1 (or ALLOW_DISPOSABLE_PG=1) alongside DATABASE_URL.
const DISPOSABLE =
  process.env.CAPIRO_DISPOSABLE_PG === '1' || process.env.ALLOW_DISPOSABLE_PG === '1';
const describeDb = process.env.DATABASE_URL && DISPOSABLE ? describe : describe.skip;

const TENANT_A = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000a2';
const HEARING_ID = 'phase7-ss-hearing';
const HEARING_OLD = 'phase7-ss-hearing-old';
const HEARING_BROWSER = 'phase7-ss-hearing-browser';
const HEARING_NOTIFY = 'phase7-ss-hearing-notify';
const HEARING_STATE = 'phase7-ss-hearing-fl';

const ctxA: TenantContext = {
  tenantId: TENANT_A,
  tenantSlug: 'phase7-ss-a',
  userId: 'phase7-ss-user-a',
  clerkUserId: 'phase7-ss-clerk-a',
  role: 'standard_user',
};
const ctxA2: TenantContext = { ...ctxA, userId: 'phase7-ss-user-a2' };
const ctxB: TenantContext = {
  tenantId: TENANT_B,
  tenantSlug: 'phase7-ss-b',
  userId: 'phase7-ss-user-b',
  clerkUserId: 'phase7-ss-clerk-b',
  role: 'standard_user',
};

async function insertHearing(
  prisma: PrismaService,
  id: string,
  opts: { status?: string; daysFromNow?: number; jurisdiction?: string } = {},
) {
  const status = opts.status ?? 'scheduled';
  const days = opts.daysFromNow ?? 2;
  const jurisdiction = opts.jurisdiction ?? 'US';
  await prisma.$executeRawUnsafe(
    `INSERT INTO committee_hearing
       (id, chamber, committee_name, committee_system_code, title, type, date,
        starts_at, timezone, event_status, visibility, url,
        stream_availability, coverage_status, geographic_jurisdiction)
     VALUES ($1, 'House', 'House Armed Services', 'hsas00',
             $2, 'hearing', CURRENT_DATE + $3::int,
             now() + ($3::int || ' days')::interval, 'America/New_York', $4, 'public',
             'https://armedservices.house.gov/hearings/' || $1,
             'unknown', 'discovered', $5)`,
    id,
    `Server sessions ${id}`,
    days,
    status,
    jurisdiction,
  );
}

describeDb('LiveHearingsPhase7Service.serverSessions (Postgres)', () => {
  const prisma = new PrismaService();
  const hearings = new LiveHearingsService(prisma);
  const committees = new CommitteeDirectoryService(prisma, hearings);
  const phase7 = new LiveHearingsPhase7Service(prisma, hearings, committees);

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    try {
      await prisma.$executeRawUnsafe(
        `DELETE FROM committee_hearing WHERE id = ANY($1::text[])`,
        [HEARING_ID, HEARING_OLD, HEARING_BROWSER, HEARING_NOTIFY, HEARING_STATE],
      );
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
       VALUES ($1::uuid, 'phase7-ss-a', 'SS A'), ($2::uuid, 'phase7-ss-b', 'SS B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_A,
      TENANT_B,
    );
  });

  it('returns a scheduled row immediately after scheduling, exactly once (schedule ensures a SCHEDULED capture)', async () => {
    await insertHearing(prisma, HEARING_ID);
    await phase7.schedule(ctxA, HEARING_ID);

    const page = (await phase7.serverSessions(ctxA, {})) as {
      rows: Array<{
        id: string;
        capture: { status: string } | null;
        capturePending: boolean;
        scheduleSource: unknown;
      }>;
      total: number;
    };
    const matches = page.rows.filter((row) => row.id === HEARING_ID);
    expect(matches).toHaveLength(1);
    // schedule() ensures a canonical capture, so capture is present and
    // SCHEDULED (not pending) — the row is visible immediately.
    expect(matches[0]?.capture?.status).toBe('SCHEDULED');
    expect(matches[0]?.capturePending).toBe(false);
    expect(matches[0]?.scheduleSource).toMatchObject({ byUser: true, byRule: false });
    expect(page.total).toBeGreaterThanOrEqual(1);
  });

  it('shows capturePending for durable demand with no canonical capture yet', async () => {
    await insertHearing(prisma, HEARING_ID);
    // Manually persist the SAME demand row schedule() would write, but do NOT
    // create the canonical capture — proves the honest pre-capture state.
    await prisma.$executeRawUnsafe(
      `INSERT INTO hearing_subscription
         (tenant_id, user_id, hearing_id, notify_on_start, notify_on_mention,
          scheduled_by_user, scheduled_by_rule_id, client_ids, watchlist_id,
          attendance_mode, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, true, false, true, NULL, ARRAY[]::text[], NULL, 'automatic', now(), now())`,
      TENANT_A,
      ctxA.userId,
      HEARING_ID,
    );

    const page = (await phase7.serverSessions(ctxA, {})) as {
      rows: Array<{ id: string; capture: unknown; capturePending: boolean }>;
    };
    const row = page.rows.find((r) => r.id === HEARING_ID);
    expect(row).toBeDefined();
    expect(row?.capture).toBeNull();
    expect(row?.capturePending).toBe(true);
  });

  it('spans the full lifecycle and never disappears after completion', async () => {
    await insertHearing(prisma, HEARING_ID);
    const scheduled = await phase7.schedule(ctxA, HEARING_ID);
    const captureId = String(scheduled.captureId);

    const lifecycle: Array<{ domain: string; storage: string }> = [
      { domain: 'CAPTURING', storage: 'capturing' },
      { domain: 'COMPLETE', storage: 'ended' },
    ];
    for (const { domain, storage } of lifecycle) {
      await prisma.$executeRawUnsafe(
        `UPDATE public_hearing_capture SET domain_status=$2, status=$3 WHERE id=$1`,
        captureId,
        domain,
        storage,
      );
      const page = (await phase7.serverSessions(ctxA, {})) as {
        rows: Array<{ id: string; capture: { status: string } | null }>;
      };
      const row = page.rows.find((r) => r.id === HEARING_ID);
      expect(row).toBeDefined();
      expect(row?.capture?.status).toBe(domain);
    }

    // Even with a stale 'scheduled' event_status and a COMPLETE capture, the
    // row remains (completed source remains visible).
    await prisma.$executeRawUnsafe(
      `UPDATE public_hearing_capture SET domain_status='FAILED', status='failed' WHERE id=$1`,
      captureId,
    );
    const failed = (await phase7.serverSessions(ctxA, {})) as {
      rows: Array<{ id: string; capture: { status: string } | null }>;
    };
    expect(failed.rows.find((r) => r.id === HEARING_ID)?.capture?.status).toBe('FAILED');
  });

  it('excludes browser-only and notify-only demand', async () => {
    await insertHearing(prisma, HEARING_BROWSER);
    await insertHearing(prisma, HEARING_NOTIFY);
    // browser-only demand
    await prisma.$executeRawUnsafe(
      `INSERT INTO hearing_subscription
         (tenant_id, user_id, hearing_id, notify_on_start, notify_on_mention,
          scheduled_by_user, scheduled_by_rule_id, client_ids, watchlist_id,
          attendance_mode, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, true, false, true, NULL, ARRAY[]::text[], NULL, 'browser', now(), now())`,
      TENANT_A,
      ctxA.userId,
      HEARING_BROWSER,
    );
    // notify-only demand (automatic mode but no user/rule schedule demand)
    await prisma.$executeRawUnsafe(
      `INSERT INTO hearing_subscription
         (tenant_id, user_id, hearing_id, notify_on_start, notify_on_mention,
          scheduled_by_user, scheduled_by_rule_id, client_ids, watchlist_id,
          attendance_mode, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, true, false, false, NULL, ARRAY[]::text[], NULL, 'automatic', now(), now())`,
      TENANT_A,
      ctxA.userId,
      HEARING_NOTIFY,
    );

    const page = (await phase7.serverSessions(ctxA, {})) as { rows: Array<{ id: string }> };
    const ids = page.rows.map((r) => r.id);
    expect(ids).not.toContain(HEARING_BROWSER);
    expect(ids).not.toContain(HEARING_NOTIFY);
  });

  it('includes rule-demand rows and isolates tenant and user', async () => {
    await insertHearing(prisma, HEARING_ID);
    // rule-demand for ctxA
    await prisma.$executeRawUnsafe(
      `INSERT INTO hearing_subscription
         (tenant_id, user_id, hearing_id, notify_on_start, notify_on_mention,
          scheduled_by_user, scheduled_by_rule_id, client_ids, watchlist_id,
          attendance_mode, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, true, false, false, 'rule-1', ARRAY[]::text[], NULL, 'automatic', now(), now())`,
      TENANT_A,
      ctxA.userId,
      HEARING_ID,
    );

    const forA = (await phase7.serverSessions(ctxA, {})) as {
      rows: Array<{ id: string; scheduleSource: { byRule: boolean; ruleId?: string } }>;
    };
    expect(forA.rows.find((r) => r.id === HEARING_ID)?.scheduleSource).toMatchObject({
      byRule: true,
      ruleId: 'rule-1',
    });

    // another user in the same tenant sees nothing
    const forA2 = (await phase7.serverSessions(ctxA2, {})) as { rows: Array<{ id: string }> };
    expect(forA2.rows.find((r) => r.id === HEARING_ID)).toBeUndefined();
    // another tenant sees nothing
    const forB = (await phase7.serverSessions(ctxB, {})) as { rows: Array<{ id: string }> };
    expect(forB.rows.find((r) => r.id === HEARING_ID)).toBeUndefined();
  });

  it('is idempotent across repeat scheduling and never duplicates a row', async () => {
    await insertHearing(prisma, HEARING_ID);
    await phase7.schedule(ctxA, HEARING_ID);
    await phase7.schedule(ctxA, HEARING_ID);

    const page = (await phase7.serverSessions(ctxA, {})) as { rows: Array<{ id: string }> };
    expect(page.rows.filter((r) => r.id === HEARING_ID)).toHaveLength(1);
  });

  it('keeps an old-week / past-date row visible (calendar independent)', async () => {
    await insertHearing(prisma, HEARING_OLD, { daysFromNow: -30 });
    await phase7.schedule(ctxA, HEARING_OLD);

    const page = (await phase7.serverSessions(ctxA, {})) as { rows: Array<{ id: string }> };
    expect(page.rows.find((r) => r.id === HEARING_OLD)).toBeDefined();
  });

  it('removes the row on cancel before capture and does not resurrect it', async () => {
    await insertHearing(prisma, HEARING_ID);
    await phase7.schedule(ctxA, HEARING_ID);
    let page = (await phase7.serverSessions(ctxA, {})) as { rows: Array<{ id: string }> };
    expect(page.rows.find((r) => r.id === HEARING_ID)).toBeDefined();

    await phase7.cancelSchedule(ctxA, HEARING_ID);
    page = (await phase7.serverSessions(ctxA, {})) as { rows: Array<{ id: string }> };
    expect(page.rows.find((r) => r.id === HEARING_ID)).toBeUndefined();
  });

  it('includes a state (Florida) hearing from the canonical table', async () => {
    await insertHearing(prisma, HEARING_STATE, { jurisdiction: 'FL' });
    // schedule() is policy-gated for state capture; seed the durable demand row
    // directly (the same row schedule() would persist) to prove the canonical
    // federal+state table is read, not the legacy federal-only view.
    await prisma.$executeRawUnsafe(
      `INSERT INTO hearing_subscription
         (tenant_id, user_id, hearing_id, notify_on_start, notify_on_mention,
          scheduled_by_user, scheduled_by_rule_id, client_ids, watchlist_id,
          attendance_mode, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, true, false, true, NULL, ARRAY[]::text[], NULL, 'automatic', now(), now())`,
      TENANT_A,
      ctxA.userId,
      HEARING_STATE,
    );

    const page = (await phase7.serverSessions(ctxA, {})) as { rows: Array<{ id: string }> };
    expect(page.rows.find((r) => r.id === HEARING_STATE)).toBeDefined();
  });
});
