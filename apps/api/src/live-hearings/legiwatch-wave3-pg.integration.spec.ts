/**
 * LegiWatch V2 Wave 3 — Digest + Analytics contract proof against a REAL
 * Postgres with the full apps/api AND apps/intel-api migration chains
 * applied (both services share one physical database — see
 * reference_capirov2_db_backed_testing). Proves the cross-schema
 * `intel_alert` raw SQL actually runs (not just typechecks) and that tenant
 * isolation holds for both new tables.
 *
 * Gate: DATABASE_URL must point at the disposable PG. Skipped cleanly
 * otherwise, matching the posture of every sibling integration suite.
 */
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { LegiWatchDigestService } from './legiwatch-digest.service.js';
import { LegiWatchAnalyticsService } from './legiwatch-analytics.service.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
jest.setTimeout(180_000);

const TENANT_A = '00000000-0000-0000-0000-0000000000f3';
const TENANT_B = '00000000-0000-0000-0000-0000000000f4';
const CLIENT_A1 = '00000000-0000-0000-0000-00000000cf31';
const CLIENT_A2 = '00000000-0000-0000-0000-00000000cf32';
const CLIENT_B1 = '00000000-0000-0000-0000-00000000cf41';
const USER_A1 = 'lw-w3-user-a1';
const USER_B1 = 'lw-w3-user-b1';

const ctxA1: TenantContext = {
  tenantId: TENANT_A,
  tenantSlug: 'lw-w3-a',
  userId: USER_A1,
  clerkUserId: USER_A1,
  role: 'standard_user',
};
const ctxB1: TenantContext = {
  tenantId: TENANT_B,
  tenantSlug: 'lw-w3-b',
  userId: USER_B1,
  clerkUserId: USER_B1,
  role: 'standard_user',
};

const HEARING_1 = 'lw-w3-hearing-1';
const COMMITTEE_1 = 'hsw3-committee';

describeDb('LegiWatch Wave 3 — Digest + Analytics (real Postgres)', () => {
  const prisma = new PrismaService();
  const digest = new LegiWatchDigestService(prisma);
  const analytics = new LegiWatchAnalyticsService(prisma);

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE legiwatch_digest_run, legiwatch_digest_schedule,
                intel_live_hearing_session, intel_watchlist_topic, intel_watchlist,
                committee_hearing, congress_bill, congress_committee, clients
       CASCADE`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM intel_alert WHERE tenant_id IN ($1, $2)`, TENANT_A, TENANT_B);

    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1::uuid, 'lw-w3-a', 'Wave3 Tenant A'), ($2::uuid, 'lw-w3-b', 'Wave3 Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_A,
      TENANT_B,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clients (id, tenant_id, name, status) VALUES
         ($1::uuid, $4::uuid, 'Overland AI', 'active'),
         ($2::uuid, $4::uuid, 'Kela Systems', 'active'),
         ($3::uuid, $5::uuid, 'Beta Advocacy', 'active')
       ON CONFLICT (id) DO NOTHING`,
      CLIENT_A1,
      CLIENT_A2,
      CLIENT_B1,
      TENANT_A,
      TENANT_B,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO congress_committee (system_code, thomas_id, name, chamber, parent_system_code, url, is_current)
       VALUES ($1, 'HSW3', 'Armed Services (wave3 test)', 'house', NULL, 'https://x', true)
       ON CONFLICT (system_code) DO NOTHING`,
      COMMITTEE_1,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing (id, chamber, committee_name, committee_system_code, title, date, visibility)
       VALUES ($1, 'House', 'Armed Services (wave3 test)', $2, 'Ground Robotics Program Update', now(), 'public')
       ON CONFLICT (id) DO NOTHING`,
      HEARING_1,
      COMMITTEE_1,
    );
    // intel_live_hearing_session / intel_alert / intel_watchlist* all store
    // tenant_id/client_id as plain TEXT (intel-api's own convention) — no
    // ::uuid cast, unlike apps/api's own tables above.
    await prisma.$executeRawUnsafe(
      `INSERT INTO intel_live_hearing_session
         (id, tenant_id, title, committee_id, hearing_id, status, source_type, audio_source, recording_policy, created_by, updated_at)
       VALUES ($1, $2, 'Ground Robotics Program Update', $3, $4, 'ended', 'hearing', 'browser_mic', 'transcript_only', $5, now())
       ON CONFLICT (id) DO NOTHING`,
      'lw-w3-session-1',
      TENANT_A,
      COMMITTEE_1,
      HEARING_1,
      USER_A1,
    );

    // 3 hearing-sourced alerts (2 for client A1, 1 for A2), 1 bill-sourced
    // alert, all inside the 48h digest / 30-day analytics windows, plus one
    // alert for tenant B to prove isolation.
    await prisma.$executeRawUnsafe(
      `INSERT INTO intel_alert
         (id, tenant_id, client_id, source_type, source_ref, title, kind, severity, materiality, score,
          recommended_action, status, created_at)
       VALUES
         ('lw-w3-alert-1', $1, $2, 'hearing', 'lw-w3-session-1', 'Ground robotics capability assessment directed', 'kind', 'critical', 'high', 92,
          'Brief Overland AI this morning.', 'new', now() - interval '1 hour'),
         ('lw-w3-alert-2', $1, $2, 'hearing', 'lw-w3-session-1', 'Witness testimony on industrial base workforce', 'kind', 'notable', 'medium', 61,
          NULL, 'new', now() - interval '1 hour'),
         ('lw-w3-alert-3', $1, $3, 'bill', 'lw-w3-bill-1', 'H.R. 8800 remains in committee', 'kind', 'notable', 'medium', 55,
          NULL, 'new', now() - interval '1 hour'),
         ('lw-w3-alert-b1', $4, $5, 'hearing', 'lw-w3-session-1', 'Should never leak into tenant A', 'kind', 'critical', 'high', 99,
          NULL, 'new', now() - interval '1 hour')`,
      TENANT_A,
      CLIENT_A1,
      CLIENT_A2,
      TENANT_B,
      CLIENT_B1,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO congress_bill (id, congress, bill_type, bill_number, title, status, status_at)
       VALUES ('119-hr-8800', 119, 'hr', '8800', 'Defense Industrial Base Workforce Act of 2026', 'committee', now() - interval '1 hour')
       ON CONFLICT (id) DO NOTHING`,
    );
  });

  describe('Digest', () => {
    it('generates a real brief from the seeded alerts and persists it', async () => {
      const result = await digest.generate(ctxA1, null);
      expect(result.whatChanged).toHaveLength(3);
      expect(result.decisionsRequired).toHaveLength(1);
      expect(result.decisionsRequired[0]?.recommendedAction).toBe('Brief Overland AI this morning.');
      expect(result.clientImplications.map((c) => c.clientName).sort()).toEqual(['Kela Systems', 'Overland AI']);
      expect(result.provenance.sourceFamilies.sort()).toEqual(['Committee pages', 'Congress.gov']);
    });

    it('persists the run so history and getRun can read it back', async () => {
      const generated = await digest.generate(ctxA1, null);
      const history = await digest.history(ctxA1, null);
      expect(history.rows).toHaveLength(1);
      expect(history.rows[0]?.id).toBe(generated.id);
      const reread = await digest.getRun(ctxA1, generated.id as string);
      expect((reread as { whatChanged: unknown[] }).whatChanged).toHaveLength(3);
    });

    it('never leaks tenant B alerts into tenant A digest', async () => {
      const result = await digest.generate(ctxA1, null);
      const titles = result.whatChanged.map((w) => w.title);
      expect(titles).not.toContain('Should never leak into tenant A');
    });

    it('schedule upserts by (tenant, user, scope) without a DB unique constraint', async () => {
      const saved1 = await digest.putSchedule(ctxA1, null, { cadence: 'daily', hourUtc: 11, emailEnabled: true });
      expect(saved1.cadence).toBe('daily');
      const saved2 = await digest.putSchedule(ctxA1, null, { cadence: 'weekly', hourUtc: 14, emailEnabled: false });
      expect(saved2.cadence).toBe('weekly');
      const read = await digest.getSchedule(ctxA1, null);
      expect(read).toEqual(saved2);
      const rows = await prisma.legiWatchDigestSchedule.findMany({ where: { tenantId: TENANT_A, userId: USER_A1 } });
      expect(rows).toHaveLength(1); // upsert, not a second row
    });
  });

  describe('Analytics', () => {
    it('summary counts real alerts and bills, tenant-scoped', async () => {
      const result = await analytics.summary(ctxA1, null);
      expect(result.signalsTotal).toBe(3);
      expect(result.billsMoved).toBe(1);
      expect(result.billsTrackedTotal).toBe(1);
    });

    it('tenant B sees none of tenant A signals', async () => {
      const result = await analytics.summary(ctxB1, null);
      expect(result.signalsTotal).toBe(1);
    });

    it('signal volume buckets by day and totals match summary', async () => {
      const volume = await analytics.signalVolume(ctxA1, null);
      expect(volume.total).toBe(3);
      expect(volume.days.length).toBeGreaterThan(0);
    });

    it('committee activity attributes hearing alerts to the real committee, never the bill alert', async () => {
      const result = await analytics.committeeActivity(ctxA1, null);
      expect(result.total).toBe(2); // the 2 hearing alerts only, not the bill alert
      expect(result.rows[0]?.committeeName).toBe('Armed Services (wave3 test)');
    });

    it('source coverage returns a real percentage for committee pages, never a fabricated 100%', async () => {
      const result = await analytics.sourceCoverage();
      const committeePages = result.sources.find((s) => s.family === 'Committee pages');
      expect(committeePages).toBeDefined();
      expect(committeePages?.total).toBe(0); // no CommitteeSource rows seeded — coveragePct is null, not 0 or 100
      expect(committeePages?.coveragePct).toBeNull();
    });

    it('client exposure distinguishes a monitored zero from an unmonitored client', async () => {
      // Seed a watchlist WITH a topic for client A1 only.
      await prisma.$executeRawUnsafe(
        `INSERT INTO intel_watchlist (id, tenant_id, client_id, name, created_by, updated_at)
         VALUES ('lw-w3-watchlist-1', $1, $2, 'Overland watchlist', $3, now())`,
        TENANT_A,
        CLIENT_A1,
        USER_A1,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO intel_watchlist_topic (id, watchlist_id, tenant_id, label)
         VALUES ('lw-w3-topic-1', 'lw-w3-watchlist-1', $1, 'Ground robotics')`,
        TENANT_A,
      );
      const result = await analytics.clientExposure(ctxA1);
      const overland = result.rows.find((r) => r.clientName === 'Overland AI');
      const kela = result.rows.find((r) => r.clientName === 'Kela Systems');
      expect(overland?.monitored).toBe(true);
      expect(overland?.bySourceFamily?.['Committee pages']).toBe(2);
      expect(kela?.monitored).toBe(false);
      expect(kela?.bySourceFamily).toBeNull();
    });
  });
});
