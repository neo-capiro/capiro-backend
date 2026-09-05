/**
 * LegiWatch V2 Wave 1 — contract + tenant-isolation proof against a REAL
 * Postgres with the full apps/api migration chain applied.
 *
 * Why real PG rather than mocks: every guarantee asserted here is enforced by
 * the database — FORCE RLS policies, the COALESCE-based saved-item dedup index,
 * the notification dedup unique index, and the full-text search behavior. A
 * port-level mock would pass while all four were broken.
 *
 * Gate: DATABASE_URL must point at the disposable PG. Skipped cleanly
 * otherwise, matching the posture of the sibling integration suites.
 */
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { CommitteeDirectoryService } from './committee-directory.service.js';
import { LiveHearingsPhase7Service } from './live-hearings-phase7.service.js';
import { LiveHearingsService } from './live-hearings.service.js';
import { LegiWatchLifecycleNotificationService } from './legiwatch-lifecycle-notification.service.js';
import { LegiWatchWave1Service } from './legiwatch-wave1.service.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

// TRUNCATE CASCADE across many tables plus a wide seed can exceed jest's
// default hook timeout on a loaded container.
jest.setTimeout(180_000);

const TENANT_A = '00000000-0000-0000-0000-0000000000e1';
const TENANT_B = '00000000-0000-0000-0000-0000000000e2';
const CLIENT_A1 = '00000000-0000-0000-0000-00000000ce11';
const CLIENT_A2 = '00000000-0000-0000-0000-00000000ce12';
const CLIENT_A_ARCHIVED = '00000000-0000-0000-0000-00000000ce13';
const CLIENT_B1 = '00000000-0000-0000-0000-00000000ce21';

const ctxA: TenantContext = {
  tenantId: TENANT_A,
  tenantSlug: 'lw-w1-a',
  userId: 'lw-w1-user-a',
  clerkUserId: 'lw-w1-clerk-a',
  role: 'standard_user',
};
const ctxB: TenantContext = {
  tenantId: TENANT_B,
  tenantSlug: 'lw-w1-b',
  userId: 'lw-w1-user-b',
  clerkUserId: 'lw-w1-clerk-b',
  role: 'standard_user',
};

// The hearing state matrix Wave 1 has to distinguish.
const H_DONE = 'lw-w1-done'; // completed public, capture COMPLETE, transcript + insights
const H_ELIGIBLE = 'lw-w1-eligible'; // upcoming public, SERVER_CAPTURE_ALLOWED
const H_BROWSER = 'lw-w1-browser'; // upcoming public, BROWSER_CAPTURE_ONLY
const H_NOSTREAM = 'lw-w1-nostream'; // upcoming public, no capturable source
const H_CLOSED = 'lw-w1-closed'; // private/closed session
const H_DATEONLY = 'lw-w1-dateonly'; // public, no announced time
const CAPTURE_DONE = 'lw-w1-capture-done';
const SEG_1 = 'lw-w1-seg-1';
const SEG_2 = 'lw-w1-seg-2';
const INSIGHT_1 = 'lw-w1-insight-1';
const INSIGHT_2 = 'lw-w1-insight-2';
const COMMITTEE = 'hs00-lww1';
const SUBCOMMITTEE = 'hs16-lww1';

// Ranking fixtures (LW-QA-023). Seeded per-test rather than in beforeEach so
// the population every other archive assertion counts stays exactly as it was.
const H_DECOY = 'lw-w1-decoy'; // newer, unrelated committee, scattered terms in one segment
const CAPTURE_DECOY = 'lw-w1-capture-decoy';
const SEG_DECOY = 'lw-w1-seg-decoy';
const TIE_A = 'lw-w1-tie-a'; // identical identity + identical date as TIE_B
const TIE_B = 'lw-w1-tie-b';

describeDb('LegiWatch Wave 1 (real Postgres)', () => {
  const prisma = new PrismaService();
  const hearings = new LiveHearingsService(prisma);
  const committees = new CommitteeDirectoryService(prisma, hearings);
  const phase7 = new LiveHearingsPhase7Service(prisma, hearings, committees);
  const notifications = new LegiWatchLifecycleNotificationService(prisma);
  const wave1 = new LegiWatchWave1Service(prisma, phase7, committees, notifications);

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE legiwatch_notification_event,
                legiwatch_saved_item,
                legiwatch_committee_follow,
                hearing_follow,
                tenant_hearing_relevance_job,
                tenant_hearing_relevance,
                public_hearing_intelligence_job,
                public_hearing_insight,
                public_hearing_transcript_segment,
                public_hearing_capture_attempt,
                public_hearing_capture,
                hearing_subscription,
                hearing_stream_candidate,
                official_hearing_transcript,
                committee_hearing,
                notification_log,
                clients
       CASCADE`,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'lw-w1-a', 'Wave1 Tenant A'),
              ($2::uuid, 'lw-w1-b', 'Wave1 Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_A,
      TENANT_B,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO clients (id, tenant_id, name, status)
       VALUES ($1::uuid, $5::uuid, 'Aperture Defense', 'active'),
              ($2::uuid, $5::uuid, 'Northwind Maritime', 'active'),
              ($3::uuid, $5::uuid, 'Retired Client', 'archived'),
              ($4::uuid, $6::uuid, 'Beta Advocacy', 'active')
       ON CONFLICT (id) DO NOTHING`,
      CLIENT_A1,
      CLIENT_A2,
      CLIENT_A_ARCHIVED,
      CLIENT_B1,
      TENANT_A,
      TENANT_B,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO congress_committee (system_code, thomas_id, name, chamber, parent_system_code, url, is_current)
       VALUES ($1, 'HSLW1', 'Armed Services Committee (wave1 test)', 'house', NULL, 'https://armedservices.house.gov', true),
              ($2, 'HS16W', 'Seapower Subcommittee (wave1 test)', 'house', $1, 'https://armedservices.house.gov/seapower', true)
       ON CONFLICT (system_code) DO UPDATE SET name = EXCLUDED.name, is_current = true`,
      COMMITTEE,
      SUBCOMMITTEE,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing
         (id, chamber, committee_name, committee_system_code, subcommittee_system_code,
          title, type, date, starts_at, time, timezone, event_status, visibility, url, location,
          stream_availability, coverage_status, congress, witnesses)
       VALUES
         ($1, 'House', 'House Armed Services', $7, NULL,
          'Shipbuilding industrial base oversight', 'hearing', CURRENT_DATE - 1,
          now() - interval '1 day', '10:00 AM', 'America/New_York', 'completed', 'public',
          'https://armedservices.house.gov/hearings/done', '2118 Rayburn',
          'archived', 'captured', 119, ARRAY['Jane Whitfield','Admiral Cortez']),
         ($2, 'House', 'House Armed Services', $7, NULL,
          'Acquisition reform posture hearing', 'hearing', CURRENT_DATE + 2,
          now() + interval '2 days', '2:00 PM', 'America/New_York', 'scheduled', 'public',
          'https://armedservices.house.gov/hearings/eligible', '2118 Rayburn',
          'live_only', 'discovered', 119, ARRAY[]::text[]),
         ($3, 'House', 'House Armed Services', $7, NULL,
          'Third-party embedded stream hearing', 'hearing', CURRENT_DATE + 3,
          now() + interval '3 days', '11:00 AM', 'America/New_York', 'scheduled', 'public',
          'https://armedservices.house.gov/hearings/browser', '2118 Rayburn',
          'embedded_third_party', 'discovered', 119, ARRAY[]::text[]),
         ($4, 'House', 'House Armed Services', $7, NULL,
          'Field hearing with no public stream', 'hearing', CURRENT_DATE + 4,
          now() + interval '4 days', '1:00 PM', 'America/Los_Angeles', 'scheduled', 'public',
          NULL, 'San Diego, CA', 'none', 'no_public_stream', 119, ARRAY[]::text[]),
         ($5, 'House', 'House Armed Services', $7, NULL,
          'Closed briefing on classified programs', 'briefing', CURRENT_DATE + 1,
          now() + interval '1 day', NULL, 'America/New_York', 'scheduled', 'private', NULL,
          'SCIF', 'unknown', 'blocked', 119, ARRAY[]::text[]),
         ($6, 'Senate', 'Senate Armed Services', $8, NULL,
          'Markup with no announced time', 'markup', CURRENT_DATE + 5,
          NULL, NULL, 'America/New_York', 'scheduled', 'public', NULL, NULL,
          'unknown', 'not_covered', 119, ARRAY[]::text[])`,
      H_DONE,
      H_ELIGIBLE,
      H_BROWSER,
      H_NOSTREAM,
      H_CLOSED,
      H_DATEONLY,
      COMMITTEE,
      SUBCOMMITTEE,
    );

    // Stream candidates drive the Phase 7 policy verdict Wave 1 builds on.
    await prisma.$executeRawUnsafe(
      `INSERT INTO hearing_stream_candidate
         (id, hearing_id, provider, official_page_url, media_url,
          capture_policy, resolution_state, priority)
       VALUES
         (gen_random_uuid(), $1, 'senate_isvp', 'https://armedservices.house.gov/hearings/eligible',
          'https://senate.gov/isvp/eligible.m3u8', 'SERVER_CAPTURE_ALLOWED', 'READY', 1),
         (gen_random_uuid(), $2, 'youtube', 'https://armedservices.house.gov/hearings/browser',
          'https://youtube.com/watch?v=x', 'BROWSER_CAPTURE_ONLY', 'READY', 1),
         (gen_random_uuid(), $3, 'unknown', 'https://armedservices.house.gov/hearings/nostream',
          'https://unknown.example/stream', 'BLOCKED', 'POLICY_BLOCKED', 1)`,
      H_ELIGIBLE,
      H_BROWSER,
      H_NOSTREAM,
    );

    // The completed hearing's ONE canonical capture, transcript and insights.
    await prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_capture
         (id, hearing_id, status, domain_status, scheduled_start, actual_start, actual_end,
          captured_seconds, transcript_gap_seconds, reconnect_count, terminal_reason_code)
       VALUES ($1, $2, 'ended', 'COMPLETE', now() - interval '1 day',
               now() - interval '1 day', now() - interval '22 hours', 7200, 0, 0, 'CAPTURE_COMPLETE')`,
      CAPTURE_DONE,
      H_DONE,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_transcript_segment
         (id, capture_id, sequence, start_ms, end_ms, text, speaker_label, is_final)
       VALUES
         ($1, $3, 1, 0, 30000,
          'The submarine industrial base requires sustained multiyear procurement funding to stabilize the workforce.',
          'CHAIR', true),
         ($2, $3, 2, 30000, 61000,
          'Ms. Whitfield, will you commit to delivering the shipyard modernization report by March?',
          'REP_SMITH', true)`,
      SEG_1,
      SEG_2,
      CAPTURE_DONE,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_insight
         (id, hearing_id, capture_id, segment_id, sequence, start_ms, end_ms, insight_type,
          title, summary, evidence_text, speaker_name, confidence, preliminary, extractor, extractor_version)
       VALUES
         ($1, $4, $3, $5, 1, 0, 30000, 'FUNDING_AMOUNT',
          'Multiyear procurement funding for the submarine industrial base',
          'The chair tied workforce stability to sustained multiyear procurement funding.',
          'sustained multiyear procurement funding to stabilize the workforce', 'CHAIR',
          0.91, false, 'legiwatch-extractor', '1.0'),
         ($2, $4, $3, $6, 2, 30000, 61000, 'COMMITMENT',
          'Shipyard modernization report commitment',
          'A member sought a commitment to deliver the shipyard modernization report by March.',
          'will you commit to delivering the shipyard modernization report by March', 'REP_SMITH',
          0.88, false, 'legiwatch-extractor', '1.0')`,
      INSIGHT_1,
      INSIGHT_2,
      CAPTURE_DONE,
      H_DONE,
      SEG_1,
      SEG_2,
    );

    // Tenant relevance: A has a HIGH and a MEDIUM match; B has its own row on
    // the same GLOBAL hearing, which is exactly the cross-tenant case.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenant_hearing_relevance
         (id, tenant_id, client_id, client_name, hearing_id, insight_id, score, matched_on, rationale)
       VALUES
         (gen_random_uuid(), $1::uuid, $3::uuid, 'Aperture Defense', $6, $7, 0.92,
          '[{"label":"submarine industrial base","kind":"topic"}]'::jsonb,
          'Aperture supplies the submarine industrial base named in this exchange.'),
         (gen_random_uuid(), $1::uuid, $4::uuid, 'Northwind Maritime', $6, $8, 0.51,
          '[{"label":"shipyard modernization","kind":"term"}]'::jsonb,
          'Northwind holds shipyard modernization contracts referenced here.'),
         (gen_random_uuid(), $2::uuid, $5::uuid, 'Beta Advocacy', $6, $7, 0.80,
          '[{"label":"procurement","kind":"topic"}]'::jsonb,
          'Beta tracks procurement funding.')`,
      TENANT_A,
      TENANT_B,
      CLIENT_A1,
      CLIENT_A2,
      CLIENT_B1,
      H_DONE,
      INSIGHT_1,
      INSIGHT_2,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO official_hearing_transcript
         (id, hearing_id, source, congress, chamber, committee_name, title, date,
          source_url, text, char_count)
       VALUES ('CHRG-lw-w1', $1, 'govinfo', 119, 'House', 'House Armed Services',
               'Shipbuilding industrial base oversight', CURRENT_DATE - 1,
               'https://govinfo.gov/CHRG-lw-w1',
               'Official published transcript mentioning periscope maintenance depots.', 68)`,
      H_DONE,
    );
  });

  // ── W1-1 · configurable hearing following ──────────────────────────────

  describe('W1-1 follow', () => {
    it('creates a follow with clients and notification preferences', async () => {
      const state = await wave1.upsertFollow(ctxA, H_ELIGIBLE, {
        clientIds: [CLIENT_A1, CLIENT_A2],
        notifyOnTranscriptReady: false,
      });
      expect(state.following).toBe(true);
      expect(state.clientIds.sort()).toEqual([CLIENT_A1, CLIENT_A2].sort());
      expect(state.notifyOnTranscriptReady).toBe(false);
      expect(state.notifyOnScheduleChange).toBe(true);
    });

    it('is idempotent: upserting twice leaves exactly one row', async () => {
      await wave1.upsertFollow(ctxA, H_ELIGIBLE, { clientIds: [CLIENT_A1] });
      await wave1.upsertFollow(ctxA, H_ELIGIBLE, { clientIds: [CLIENT_A1] });
      const rows = await prisma.withTenant(TENANT_A, (tx) =>
        tx.hearingFollow.findMany({ where: { hearingId: H_ELIGIBLE } }),
      );
      expect(rows).toHaveLength(1);
    });

    it('edits an existing follow through the same call', async () => {
      await wave1.upsertFollow(ctxA, H_ELIGIBLE, { clientIds: [CLIENT_A1] });
      const edited = await wave1.upsertFollow(ctxA, H_ELIGIBLE, {
        clientIds: [CLIENT_A2],
        notifyOnHearingStarting: false,
      });
      expect(edited.clientIds).toEqual([CLIENT_A2]);
      expect(edited.notifyOnHearingStarting).toBe(false);
    });

    it('leaves an unspecified preference alone rather than resetting it', async () => {
      await wave1.upsertFollow(ctxA, H_ELIGIBLE, {
        clientIds: [CLIENT_A1],
        notifyOnScheduleChange: false,
      });
      // A later call that only changes the client list must not silently
      // re-enable the notification the user switched off.
      const after = await wave1.upsertFollow(ctxA, H_ELIGIBLE, { clientIds: [CLIENT_A2] });
      expect(after.notifyOnScheduleChange).toBe(false);
    });

    it('de-duplicates repeated client ids', async () => {
      const state = await wave1.upsertFollow(ctxA, H_ELIGIBLE, {
        clientIds: [CLIENT_A1, CLIENT_A1, CLIENT_A1],
      });
      expect(state.clientIds).toEqual([CLIENT_A1]);
    });

    it('unfollows cleanly and is idempotent', async () => {
      await wave1.upsertFollow(ctxA, H_ELIGIBLE, { clientIds: [CLIENT_A1] });
      const gone = await wave1.unfollow(ctxA, H_ELIGIBLE);
      expect(gone.following).toBe(false);
      // Unfollowing again is not an error.
      await expect(wave1.unfollow(ctxA, H_ELIGIBLE)).resolves.toMatchObject({
        following: false,
      });
    });

    it('reports an archived client rather than silently dropping it', async () => {
      const state = await wave1.upsertFollow(ctxA, H_ELIGIBLE, {
        clientIds: [CLIENT_A1, CLIENT_A_ARCHIVED],
      });
      // The id is kept — hiding it would make the follow look narrower than it is.
      expect(state.clientIds).toContain(CLIENT_A_ARCHIVED);
      const archived = state.clients.find((c) => c.id === CLIENT_A_ARCHIVED);
      expect(archived?.archived).toBe(true);
      expect(state.clients.find((c) => c.id === CLIENT_A1)?.archived).toBe(false);
    });

    it('refuses the whole request when any client belongs to another tenant', async () => {
      await expect(
        wave1.upsertFollow(ctxA, H_ELIGIBLE, { clientIds: [CLIENT_A1, CLIENT_B1] }),
      ).rejects.toThrow(/Client not found/);
      // Nothing was persisted: a partial follow would be worse than a refusal.
      const rows = await prisma.withTenant(TENANT_A, (tx) =>
        tx.hearingFollow.findMany({ where: { hearingId: H_ELIGIBLE } }),
      );
      expect(rows).toHaveLength(0);
    });

    it('NEVER creates capture demand — the Follow/Attend invariant', async () => {
      await wave1.upsertFollow(ctxA, H_ELIGIBLE, { clientIds: [CLIENT_A1] });
      const subs = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM hearing_subscription WHERE hearing_id = $1`,
        H_ELIGIBLE,
      );
      expect(subs[0]?.count).toBe(0);
      const captures = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM public_hearing_capture WHERE hearing_id = $1`,
        H_ELIGIBLE,
      );
      expect(captures[0]?.count).toBe(0);
    });

    it('404s an unknown hearing', async () => {
      await expect(wave1.followState(ctxA, 'no-such-hearing')).rejects.toThrow(/not found/);
    });
  });

  // ── Tenant / RLS isolation ─────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('Tenant A cannot read Tenant B follows', async () => {
      await wave1.upsertFollow(ctxB, H_ELIGIBLE, { clientIds: [CLIENT_B1] });
      const aState = await wave1.followState(ctxA, H_ELIGIBLE);
      expect(aState.following).toBe(false);
      const aRows = await prisma.withTenant(TENANT_A, (tx) => tx.hearingFollow.findMany({}));
      expect(aRows).toHaveLength(0);
    });

    it('Tenant A cannot mutate Tenant B follows', async () => {
      await wave1.upsertFollow(ctxB, H_ELIGIBLE, { clientIds: [CLIENT_B1] });
      // A's unfollow is scoped to A and must leave B's row intact.
      await wave1.unfollow(ctxA, H_ELIGIBLE);
      const bState = await wave1.followState(ctxB, H_ELIGIBLE);
      expect(bState.following).toBe(true);
      expect(bState.clientIds).toEqual([CLIENT_B1]);
    });

    it('Tenant A cannot see Tenant B client relevance', async () => {
      const all = (await wave1.allClientsRelevance(ctxA, H_DONE)) as {
        clients: Array<{ clientId: string }>;
      };
      const ids = all.clients.map((c) => c.clientId);
      expect(ids).toContain(CLIENT_A1);
      expect(ids).not.toContain(CLIENT_B1);
    });

    it('Tenant A cannot request relevance for a Tenant B client', async () => {
      await expect(wave1.clientRelevance(ctxA, H_DONE, CLIENT_B1)).rejects.toThrow(
        /Client not found/,
      );
    });

    it('Tenant A cannot see Tenant B saved items', async () => {
      await wave1.saveItem(ctxB, H_DONE, { kind: 'hearing', clientId: CLIENT_B1 });
      const aList = (await wave1.listSavedItems(ctxA, {})) as { total: number };
      expect(aList.total).toBe(0);
      const bList = (await wave1.listSavedItems(ctxB, {})) as { total: number };
      expect(bList.total).toBe(1);
    });

    it('Tenant A cannot delete a Tenant B saved item', async () => {
      const saved = (await wave1.saveItem(ctxB, H_DONE, {
        kind: 'hearing',
        clientId: CLIENT_B1,
      })) as { id: string };
      const attempt = await wave1.deleteSavedItem(ctxA, saved.id);
      expect(attempt.deleted).toBe(false);
      const bList = (await wave1.listSavedItems(ctxB, {})) as { total: number };
      expect(bList.total).toBe(1);
    });

    it('committee follows are isolated', async () => {
      await wave1.upsertCommitteeFollow(ctxB, COMMITTEE, { clientIds: [CLIENT_B1] });
      const aState = (await wave1.committeeFollowState(ctxA, COMMITTEE)) as {
        following: boolean;
      };
      expect(aState.following).toBe(false);
    });

    it('notifications are isolated', async () => {
      await wave1.upsertFollow(ctxA, H_ELIGIBLE, { clientIds: [CLIENT_A1] });
      await wave1.upsertFollow(ctxB, H_ELIGIBLE, { clientIds: [CLIENT_B1] });
      await notifications.emit({
        tenantId: TENANT_A,
        eventType: 'hearing_starting',
        hearingId: H_ELIGIBLE,
        title: 'Starting',
        dedupKey: 'iso-test',
      });
      const aInbox = (await notifications.inbox(ctxA, {})) as { total: number };
      const bInbox = (await notifications.inbox(ctxB, {})) as { total: number };
      expect(aInbox.total).toBeGreaterThan(0);
      // B follows the same GLOBAL hearing but the emit was scoped to A.
      expect(bInbox.total).toBe(0);
    });

    it('the RLS policy itself blocks a cross-tenant read, not just the query', async () => {
      await wave1.upsertFollow(ctxA, H_DONE, { clientIds: [CLIENT_A1] });
      await wave1.upsertFollow(ctxB, H_ELIGIBLE, { clientIds: [CLIENT_B1] });

      // The test connection is `capiro`, a SUPERUSER with rolbypassrls — RLS is
      // skipped for it entirely, which would make this assertion vacuous.
      // `capiro_app` is the plain, NON-BYPASSRLS role the deployed API actually
      // connects as, so the read has to run as that role to prove anything.
      const read = (tenantId: string) =>
        prisma.withTenant(tenantId, async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE capiro_app`);
          // No tenant predicate: the FORCE RLS policy is the only thing filtering.
          return tx.$queryRawUnsafe<Array<{ hearingId: string }>>(
            `SELECT hearing_id AS "hearingId" FROM hearing_follow`,
          );
        });

      const asA = await read(TENANT_A);
      const asB = await read(TENANT_B);

      // Positive control: the policy ALLOWS each tenant its own row. Without
      // this, a missing GRANT would produce two empty results and look like
      // isolation working.
      expect(asA.map((r) => r.hearingId)).toEqual([H_DONE]);
      expect(asB.map((r) => r.hearingId)).toEqual([H_ELIGIBLE]);
    });
  });

  // ── W1-2 · attendance ──────────────────────────────────────────────────

  describe('W1-2 attendance', () => {
    it('reports an eligible public event as automatic-available', async () => {
      const state = await wave1.attendanceState(ctxA, H_ELIGIBLE);
      expect(state.state).toBe('AUTOMATIC_AVAILABLE');
      expect(state.canRequest).toBe(true);
      expect(state.availableModes).toContain('automatic');
    });

    it('reports a browser-only event honestly and requires consent', async () => {
      const state = await wave1.attendanceState(ctxA, H_BROWSER);
      expect(state.state).toBe('BROWSER_ONLY');
      expect(state.availableModes).toEqual(['browser']);
      expect(state.consentRequired).toBe(true);
    });

    it('reports a no-public-stream event as such', async () => {
      const state = await wave1.attendanceState(ctxA, H_NOSTREAM);
      expect(state.state).toBe('NO_PUBLIC_STREAM');
      // No official page on this row, so not even browser attendance is offered.
      expect(state.availableModes).toEqual([]);
      expect(state.canRequest).toBe(false);
    });

    it('reports a closed session as closed and offers no attendance', async () => {
      const state = await wave1.attendanceState(ctxA, H_CLOSED);
      expect(state.state).toBe('CLOSED_SESSION');
      expect(state.canRequest).toBe(false);
      expect(state.availableModes).toEqual([]);
    });

    it('refuses a closed session at the SERVER even when the client bypasses the UI', async () => {
      await expect(
        wave1.requestAttendance(ctxA, H_CLOSED, { mode: 'automatic' }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CLOSED_PROCEEDING' }),
      });
      const subs = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM hearing_subscription WHERE hearing_id = $1`,
        H_CLOSED,
      );
      expect(subs[0]?.count).toBe(0);
    });

    it('refuses automatic capture on a browser-only source', async () => {
      await expect(
        wave1.requestAttendance(ctxA, H_BROWSER, { mode: 'automatic' }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ATTENDANCE_MODE_NOT_AVAILABLE' }),
      });
    });

    it('requires an explicit consent acknowledgement for browser attendance', async () => {
      await expect(
        wave1.requestAttendance(ctxA, H_BROWSER, { mode: 'browser' }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CONSENT_REQUIRED' }),
      });
    });

    it('schedules an eligible event and records the mode', async () => {
      const result = (await wave1.requestAttendance(ctxA, H_ELIGIBLE, {
        mode: 'automatic',
      })) as { attendance: { state: string } };
      expect(result.attendance.state).toBe('SCHEDULED');
      const rows = await prisma.withTenant(TENANT_A, (tx) =>
        tx.hearingSubscription.findMany({ where: { hearingId: H_ELIGIBLE } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.attendanceMode).toBe('automatic');
      expect(rows[0]?.scheduledByUser).toBe(true);
    });

    it('creates exactly ONE canonical capture for the hearing', async () => {
      await wave1.requestAttendance(ctxA, H_ELIGIBLE, { mode: 'automatic' });
      await wave1.requestAttendance(ctxB, H_ELIGIBLE, { mode: 'automatic' });
      const captures = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM public_hearing_capture WHERE hearing_id = $1`,
        H_ELIGIBLE,
      );
      // Two tenants' demand, one capture. The Wave 1 invariant.
      expect(captures[0]?.count).toBe(1);
    });

    it('handles duplicate scheduling as a no-op rather than an error', async () => {
      await wave1.requestAttendance(ctxA, H_ELIGIBLE, { mode: 'automatic' });
      await expect(
        wave1.requestAttendance(ctxA, H_ELIGIBLE, { mode: 'automatic' }),
      ).resolves.toBeDefined();
      const rows = await prisma.withTenant(TENANT_A, (tx) =>
        tx.hearingSubscription.findMany({ where: { hearingId: H_ELIGIBLE } }),
      );
      expect(rows).toHaveLength(1);
    });

    it('browser attendance does not create server-capture demand', async () => {
      await wave1.requestAttendance(ctxA, H_BROWSER, {
        mode: 'browser',
        consentAcknowledged: true,
      });
      const rows = await prisma.withTenant(TENANT_A, (tx) =>
        tx.hearingSubscription.findMany({ where: { hearingId: H_BROWSER } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.attendanceMode).toBe('browser');
      // scheduled_by_user stays false: the capture worker counts that column.
      expect(rows[0]?.scheduledByUser).toBe(false);
      expect(rows[0]?.consentAcknowledgedAt).not.toBeNull();
    });

    it('cancelling leaves the canonical capture and other tenants alone', async () => {
      await wave1.requestAttendance(ctxA, H_ELIGIBLE, { mode: 'automatic' });
      await wave1.requestAttendance(ctxB, H_ELIGIBLE, { mode: 'automatic' });
      await wave1.cancelAttendance(ctxA, H_ELIGIBLE);

      const aRows = await prisma.withTenant(TENANT_A, (tx) =>
        tx.hearingSubscription.findMany({ where: { hearingId: H_ELIGIBLE } }),
      );
      expect(aRows).toHaveLength(0);
      const bRows = await prisma.withTenant(TENANT_B, (tx) =>
        tx.hearingSubscription.findMany({ where: { hearingId: H_ELIGIBLE } }),
      );
      expect(bRows).toHaveLength(1);
      const captures = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM public_hearing_capture WHERE hearing_id = $1`,
        H_ELIGIBLE,
      );
      expect(captures[0]?.count).toBe(1);
    });

    it('reports a completed capture with a transcript as COMPLETE', async () => {
      const state = await wave1.attendanceState(ctxA, H_DONE);
      expect(state.state).toBe('COMPLETE');
      expect(state.canRequest).toBe(false);
    });

    it('reports a finished capture with no transcript yet as PROCESSING', async () => {
      await prisma.$executeRawUnsafe(
        `DELETE FROM public_hearing_transcript_segment WHERE capture_id = $1`,
        CAPTURE_DONE,
      );
      const state = await wave1.attendanceState(ctxA, H_DONE);
      // Calling this COMPLETE is what makes a user open a hearing and find
      // nothing there.
      expect(state.state).toBe('PROCESSING');
    });
  });

  // ── W1-3 · archive search ──────────────────────────────────────────────

  describe('W1-3 archive search', () => {
    it('finds a hearing by transcript text and returns the timecoded snippet', async () => {
      const result = (await wave1.searchArchive(ctxA, { q: 'multiyear procurement' })) as {
        total: number;
        rows: Array<{ id: string; transcriptHit: { segmentId: string; startMs: number } | null }>;
      };
      expect(result.total).toBe(1);
      expect(result.rows[0]?.id).toBe(H_DONE);
      expect(result.rows[0]?.transcriptHit?.segmentId).toBe(SEG_1);
      expect(result.rows[0]?.transcriptHit?.startMs).toBe(0);
    });

    it('finds a hearing by title', async () => {
      const result = (await wave1.searchArchive(ctxA, { q: 'shipbuilding' })) as {
        total: number;
      };
      expect(result.total).toBe(1);
    });

    it('finds a hearing by witness name', async () => {
      const result = (await wave1.searchArchive(ctxA, { q: 'Whitfield' })) as {
        total: number;
        rows: Array<{ id: string }>;
      };
      // The witness FTS path is the one array_to_string could not index.
      expect(result.rows.map((r) => r.id)).toContain(H_DONE);
    });

    it('finds a hearing by official published transcript text', async () => {
      const result = (await wave1.searchArchive(ctxA, { q: 'periscope' })) as {
        total: number;
        rows: Array<{ id: string }>;
      };
      expect(result.rows.map((r) => r.id)).toContain(H_DONE);
    });

    it('finds a hearing by intelligence finding and returns the hit', async () => {
      const result = (await wave1.searchArchive(ctxA, { q: 'shipyard modernization' })) as {
        rows: Array<{ id: string; intelligenceHit: { insightId: string } | null }>;
      };
      expect(result.rows[0]?.id).toBe(H_DONE);
      expect(result.rows[0]?.intelligenceHit?.insightId).toBe(INSIGHT_2);
    });

    // LW-QA-015: `total` is post-filter for every shape of request, so it can
    // never tell a search that missed from an archive that is empty. Only a
    // count taken before the query and facets apply can.
    it('reports corpusTotal unchanged by the query and the facets', async () => {
      const unfiltered = (await wave1.searchArchive(ctxA, {})) as {
        total: number;
        corpusTotal: number;
      };
      expect(unfiltered.corpusTotal).toBeGreaterThan(0);
      expect(unfiltered.corpusTotal).toBe(unfiltered.total);

      const missedQuery = (await wave1.searchArchive(ctxA, {
        q: 'zzzznotawordinthiscorpus',
      })) as { total: number; corpusTotal: number };
      expect(missedQuery.total).toBe(0);
      expect(missedQuery.corpusTotal).toBe(unfiltered.corpusTotal);

      const missedFacet = (await wave1.searchArchive(ctxA, {
        committee: 'nonexistent-code',
      })) as { total: number; corpusTotal: number };
      expect(missedFacet.total).toBe(0);
      expect(missedFacet.corpusTotal).toBe(unfiltered.corpusTotal);
    });

    it('reports corpusTotal 0 only when the archive really is empty', async () => {
      // Push every proceeding back out of the archive predicate: nothing has
      // happened yet, no capture reached a terminal state, no official
      // transcript exists.
      await prisma.$executeRawUnsafe(`UPDATE committee_hearing SET event_status = 'scheduled'`);
      await prisma.$executeRawUnsafe(
        `UPDATE public_hearing_capture SET domain_status = 'SCHEDULED'`,
      );
      await prisma.$executeRawUnsafe(`DELETE FROM official_hearing_transcript`);

      const empty = (await wave1.searchArchive(ctxA, {})) as {
        total: number;
        corpusTotal: number;
      };
      expect(empty.total).toBe(0);
      expect(empty.corpusTotal).toBe(0);
    });

    it('filters by committee', async () => {
      const match = (await wave1.searchArchive(ctxA, { committee: COMMITTEE })) as {
        total: number;
      };
      expect(match.total).toBeGreaterThan(0);
      const miss = (await wave1.searchArchive(ctxA, { committee: 'nonexistent-code' })) as {
        total: number;
      };
      expect(miss.total).toBe(0);
    });

    it('filters by date range', async () => {
      const future = (await wave1.searchArchive(ctxA, {
        from: '2099-01-01',
        to: '2099-12-31',
      })) as { total: number };
      expect(future.total).toBe(0);
    });

    it('filters by transcript availability', async () => {
      const withTranscript = (await wave1.searchArchive(ctxA, { hasTranscript: true })) as {
        rows: Array<{ id: string }>;
      };
      expect(withTranscript.rows.map((r) => r.id)).toContain(H_DONE);
      const without = (await wave1.searchArchive(ctxA, { hasTranscript: false })) as {
        rows: Array<{ id: string }>;
      };
      expect(without.rows.map((r) => r.id)).not.toContain(H_DONE);
    });

    it('reports a no-transcript hearing honestly rather than omitting it', async () => {
      // A cancelled proceeding is durable history with no transcript.
      await prisma.$executeRawUnsafe(
        `UPDATE committee_hearing SET event_status = 'canceled' WHERE id = $1`,
        H_NOSTREAM,
      );
      const result = (await wave1.searchArchive(ctxA, {})) as {
        rows: Array<{ id: string; transcript: { available: boolean; segmentCount: number } }>;
      };
      const row = result.rows.find((r) => r.id === H_NOSTREAM);
      expect(row).toBeDefined();
      expect(row?.transcript.available).toBe(false);
      expect(row?.transcript.segmentCount).toBe(0);
    });

    it('excludes future scheduled hearings — they belong to the calendar', async () => {
      const result = (await wave1.searchArchive(ctxA, {})) as { rows: Array<{ id: string }> };
      expect(result.rows.map((r) => r.id)).not.toContain(H_ELIGIBLE);
    });

    it('never returns a non-public proceeding', async () => {
      await prisma.$executeRawUnsafe(
        `UPDATE committee_hearing SET event_status = 'completed' WHERE id = $1`,
        H_CLOSED,
      );
      const result = (await wave1.searchArchive(ctxA, {})) as { rows: Array<{ id: string }> };
      expect(result.rows.map((r) => r.id)).not.toContain(H_CLOSED);
    });

    it('paginates server-side and reports hasMore honestly', async () => {
      await prisma.$executeRawUnsafe(
        `UPDATE committee_hearing SET event_status = 'completed' WHERE id IN ($1, $2)`,
        H_NOSTREAM,
        H_DATEONLY,
      );
      const first = (await wave1.searchArchive(ctxA, { pageSize: 1, page: 1 })) as {
        rows: unknown[];
        total: number;
        hasMore: boolean;
      };
      expect(first.rows).toHaveLength(1);
      expect(first.total).toBe(3);
      expect(first.hasMore).toBe(true);

      const last = (await wave1.searchArchive(ctxA, { pageSize: 1, page: 3 })) as {
        hasMore: boolean;
      };
      expect(last.hasMore).toBe(false);
    });

    it('narrows to a client via tenant relevance', async () => {
      const forA1 = (await wave1.searchArchive(ctxA, { clientId: CLIENT_A1 })) as {
        rows: Array<{ id: string }>;
      };
      expect(forA1.rows.map((r) => r.id)).toContain(H_DONE);
    });

    it('refuses a client id from another tenant', async () => {
      await expect(wave1.searchArchive(ctxA, { clientId: CLIENT_B1 })).rejects.toThrow(
        /Client not found/,
      );
    });

    it('returns facets describing the same population as the results', async () => {
      const result = (await wave1.searchArchive(ctxA, {})) as {
        total: number;
        facets: { chamber: Array<{ value: string; count: number }> };
      };
      const facetTotal = result.facets.chamber.reduce((sum, f) => sum + Number(f.count), 0);
      expect(facetTotal).toBe(result.total);
    });

    it('every result carries the canonical detail path', async () => {
      const result = (await wave1.searchArchive(ctxA, {})) as {
        rows: Array<{ id: string; detailPath: string }>;
      };
      for (const row of result.rows) {
        expect(row.detailPath).toBe(`/legiwatch/hearings/${row.id}`);
      }
    });

    it('survives punctuation that would break to_tsquery', async () => {
      // websearch_to_tsquery accepts real user input; to_tsquery would throw.
      await expect(
        wave1.searchArchive(ctxA, { q: 'shipbuilding & !! ()' }),
      ).resolves.toBeDefined();
    });

    it('emits a calendar day string, never an instant', async () => {
      const result = (await wave1.searchArchive(ctxA, {})) as {
        rows: Array<{ calendarDate: string }>;
      };
      for (const row of result.rows) {
        expect(row.calendarDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    // ── relevance ranking (LW-QA-023) ────────────────────────────────────
    //
    // The archive used to order a four-way boolean OR by recency alone, so
    // "Armed Services" returned the newest proceedings that happened to contain
    // both stems somewhere rather than the Armed Services proceedings.

    type RankedPage = {
      total: number;
      matchMode: string | null;
      rows: Array<{
        id: string;
        matchTier: number | null;
        transcriptHit: { segmentId: string; startMs: number } | null;
      }>;
    };

    /**
     * A NEWER, unrelated proceeding whose transcript merely contains the words
     * "armed" and "services" in one sentence, non-adjacent. Under a pure
     * recency sort this outranked the House Armed Services Committee itself.
     */
    const seedRecentDecoy = async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO committee_hearing
           (id, chamber, committee_name, committee_system_code, subcommittee_system_code,
            title, type, date, starts_at, time, timezone, event_status, visibility, url, location,
            stream_availability, coverage_status, congress, witnesses)
         VALUES ($1, 'House', 'House Small Business', NULL, NULL,
                 'Oversight of contracting support programs for small suppliers', 'hearing',
                 CURRENT_DATE, now() - interval '1 hour', '9:00 AM', 'America/New_York',
                 'completed', 'public', 'https://smallbusiness.house.gov/hearings/decoy',
                 '2360 Rayburn', 'archived', 'captured', 119, ARRAY[]::text[])`,
        H_DECOY,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO public_hearing_capture
           (id, hearing_id, status, domain_status, scheduled_start, actual_start, actual_end,
            captured_seconds, transcript_gap_seconds, reconnect_count, terminal_reason_code)
         VALUES ($1, $2, 'ended', 'COMPLETE', now() - interval '2 hours',
                 now() - interval '2 hours', now() - interval '30 minutes', 5400, 0, 0,
                 'CAPTURE_COMPLETE')`,
        CAPTURE_DECOY,
        H_DECOY,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO public_hearing_transcript_segment
           (id, capture_id, sequence, start_ms, end_ms, text, speaker_label, is_final)
         VALUES ($1, $2, 1, 0, 30000,
                 'The armed forces liaison walked through the procurement services available to small suppliers.',
                 'CHAIR', true)`,
        SEG_DECOY,
        CAPTURE_DECOY,
      );
    };

    it('ranks the real Armed Services proceeding above a newer transcript-only match', async () => {
      await seedRecentDecoy();
      const result = (await wave1.searchArchive(ctxA, { q: 'Armed Services' })) as RankedPage;

      const ids = result.rows.map((r) => r.id);
      // Both still match — ranking reorders the population, it does not shrink it.
      expect(ids).toContain(H_DONE);
      expect(ids).toContain(H_DECOY);
      expect(ids[0]).toBe(H_DONE);
      expect(ids.indexOf(H_DONE)).toBeLessThan(ids.indexOf(H_DECOY));

      const done = result.rows.find((r) => r.id === H_DONE);
      const decoy = result.rows.find((r) => r.id === H_DECOY);
      expect(done?.matchTier).toBeLessThan(decoy?.matchTier as number);
    });

    it('tiers an exact identity phrase ahead of a prefix, and a prefix ahead of containment', async () => {
      const exact = (await wave1.searchArchive(ctxA, {
        q: 'Shipbuilding industrial base oversight House Armed Services',
      })) as RankedPage;
      expect(exact.rows[0]?.id).toBe(H_DONE);
      expect(exact.rows[0]?.matchTier).toBe(0);

      const prefix = (await wave1.searchArchive(ctxA, {
        q: 'Shipbuilding industrial base',
      })) as RankedPage;
      expect(prefix.rows[0]?.matchTier).toBe(1);

      const contained = (await wave1.searchArchive(ctxA, { q: 'Armed Services' })) as RankedPage;
      expect(contained.rows.find((r) => r.id === H_DONE)?.matchTier).toBe(2);
    });

    it('honours a quoted phrase and does not throw on it', async () => {
      await seedRecentDecoy();
      const result = (await wave1.searchArchive(ctxA, { q: '"armed services"' })) as RankedPage;
      expect(result.rows[0]?.id).toBe(H_DONE);
      // Quoting makes websearch_to_tsquery a phrase query, so the scattered
      // decoy does not even match — the honest outcome, not a demoted row.
      expect(result.rows.map((r) => r.id)).not.toContain(H_DECOY);
    });

    it('still matches a single term', async () => {
      const result = (await wave1.searchArchive(ctxA, { q: 'shipbuilding' })) as RankedPage;
      expect(result.total).toBe(1);
      expect(result.rows[0]?.id).toBe(H_DONE);
      expect(result.matchMode).toBe('all-terms');
    });

    it('tiers a transcript phrase below identity but keeps its timecoded snippet', async () => {
      const result = (await wave1.searchArchive(ctxA, {
        q: 'multiyear procurement',
      })) as RankedPage;
      expect(result.rows[0]?.id).toBe(H_DONE);
      expect(result.rows[0]?.transcriptHit?.segmentId).toBe(SEG_1);
      expect(result.rows[0]?.transcriptHit?.startMs).toBe(0);
      // The phrase is in a body corpus, not in the hearing's identity.
      expect(result.rows[0]?.matchTier).toBe(5);
    });

    it('returns an empty page for a query nothing matches', async () => {
      const result = (await wave1.searchArchive(ctxA, { q: 'zzzzq qqzzzw' })) as RankedPage;
      expect(result.total).toBe(0);
      expect(result.rows).toEqual([]);
      expect(result.matchMode).toBe('all-terms');
    });

    it('falls back to partial matches rather than an empty page, and labels them', async () => {
      // Nothing contains BOTH terms, so the strict pass is empty and the
      // any-term pass runs. The label is what stops the UI implying an exact hit.
      const result = (await wave1.searchArchive(ctxA, {
        q: 'shipbuilding zzzzq',
      })) as RankedPage;
      expect(result.matchMode).toBe('partial');
      expect(result.rows.map((r) => r.id)).toContain(H_DONE);
    });

    it('orders identically on repeat and breaks ties by id', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO committee_hearing
           (id, chamber, committee_name, committee_system_code, subcommittee_system_code,
            title, type, date, starts_at, time, timezone, event_status, visibility, url, location,
            stream_availability, coverage_status, congress, witnesses)
         VALUES ($1, 'House', 'House Armed Services', $3, NULL,
                 'Tie-break oversight hearing', 'hearing', CURRENT_DATE - 5, NULL, NULL,
                 'America/New_York', 'completed', 'public', NULL, NULL,
                 'unknown', 'not_covered', 119, ARRAY[]::text[]),
                ($2, 'House', 'House Armed Services', $3, NULL,
                 'Tie-break oversight hearing', 'hearing', CURRENT_DATE - 5, NULL, NULL,
                 'America/New_York', 'completed', 'public', NULL, NULL,
                 'unknown', 'not_covered', 119, ARRAY[]::text[])`,
        TIE_A,
        TIE_B,
        COMMITTEE,
      );

      const first = (await wave1.searchArchive(ctxA, { q: 'Armed Services' })) as RankedPage;
      const second = (await wave1.searchArchive(ctxA, { q: 'Armed Services' })) as RankedPage;
      expect(second.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));

      // Same tier, same identity document (so same rank), same date — only the
      // id tiebreak can separate them, and it is DESC.
      const ids = first.rows.map((r) => r.id);
      expect(ids.indexOf(TIE_B)).toBe(ids.indexOf(TIE_A) - 1);
    });

    it('keeps the count and facets correct once ranking parameters are bound', async () => {
      // The ranking binds are appended after the filter binds. The count and the
      // three facet queries reuse only the filter ones; handing them a stray
      // parameter makes Postgres reject the statement outright.
      const result = (await wave1.searchArchive(ctxA, {
        q: 'Armed Services',
        chamber: 'House',
        hasTranscript: true,
      })) as RankedPage & { facets: { chamber: Array<{ value: string; count: number }> } };
      expect(result.total).toBe(1);
      expect(result.rows.map((r) => r.id)).toEqual([H_DONE]);
      const facetTotal = result.facets.chamber.reduce((sum, f) => sum + Number(f.count), 0);
      expect(facetTotal).toBe(result.total);
    });
  });

  // ── W1-4 · committee following ─────────────────────────────────────────

  describe('W1-4 committees', () => {
    it('follows and unfollows a committee', async () => {
      const followed = (await wave1.upsertCommitteeFollow(ctxA, COMMITTEE, {
        clientIds: [CLIENT_A1],
        notifyOnTranscriptReady: true,
      })) as { following: boolean; clientIds: string[]; notifyOnTranscriptReady: boolean };
      expect(followed.following).toBe(true);
      expect(followed.clientIds).toEqual([CLIENT_A1]);
      expect(followed.notifyOnTranscriptReady).toBe(true);

      const gone = (await wave1.unfollowCommittee(ctxA, COMMITTEE)) as { following: boolean };
      expect(gone.following).toBe(false);
    });

    it('is idempotent', async () => {
      await wave1.upsertCommitteeFollow(ctxA, COMMITTEE, { clientIds: [CLIENT_A1] });
      await wave1.upsertCommitteeFollow(ctxA, COMMITTEE, { clientIds: [CLIENT_A1] });
      const rows = await prisma.withTenant(TENANT_A, (tx) =>
        tx.legiWatchCommitteeFollow.findMany({}),
      );
      expect(rows).toHaveLength(1);
    });

    it('404s an unknown committee rather than creating a follow for nothing', async () => {
      await expect(
        wave1.upsertCommitteeFollow(ctxA, 'not-a-committee', {}),
      ).rejects.toThrow(/not found/);
    });

    it('supports a subcommittee as a first-class follow target', async () => {
      const state = (await wave1.upsertCommitteeFollow(ctxA, SUBCOMMITTEE, {})) as {
        following: boolean;
      };
      expect(state.following).toBe(true);
    });

    it('derives intelligence history from the committee’s own hearings', async () => {
      const history = (await wave1.committeeIntelligenceHistory(ctxA, COMMITTEE, {})) as {
        total: number;
        rows: Array<{ id: string; hearingId: string; detailPath: string }>;
        corpus: { hearings: number; hearingsWithTranscript: number };
      };
      expect(history.total).toBe(2);
      expect(history.rows.map((r) => r.id).sort()).toEqual([INSIGHT_1, INSIGHT_2].sort());
      expect(history.rows[0]?.detailPath).toBe(`/legiwatch/hearings/${H_DONE}`);
      expect(history.corpus.hearingsWithTranscript).toBe(1);
    });

    it('reports an empty history with the corpus counts that explain it', async () => {
      const history = (await wave1.committeeIntelligenceHistory(ctxA, SUBCOMMITTEE, {})) as {
        total: number;
        corpus: { hearings: number; hearingsWithTranscript: number };
      };
      expect(history.total).toBe(0);
      // Honest unavailability: one hearing exists, none transcribed.
      expect(history.corpus.hearings).toBe(1);
      expect(history.corpus.hearingsWithTranscript).toBe(0);
    });

    it('filters intelligence history by client without leaking another tenant', async () => {
      const forA1 = (await wave1.committeeIntelligenceHistory(ctxA, COMMITTEE, {
        clientId: CLIENT_A1,
      })) as { total: number; rows: Array<{ id: string }> };
      expect(forA1.rows.map((r) => r.id)).toEqual([INSIGHT_1]);
      await expect(
        wave1.committeeIntelligenceHistory(ctxA, COMMITTEE, { clientId: CLIENT_B1 }),
      ).rejects.toThrow(/Client not found/);
    });

    // ── LW-QA-016 / LW-QA-017 ────────────────────────────────────────────
    //
    // The Committee Room (`CommitteeDirectoryService`) has always resolved a
    // systemCode through `normalizeCode()` — trim + lowercase — so it answers
    // 200 for any casing. Wave 1's follow and intelligence-history routes
    // resolved with an exact-case Postgres match instead, so the same code that
    // opened the room 404'd one route over. These pin the canonical, casing-
    // insensitive identity that closes that gap.

    it('resolves a committee whatever casing the caller sends (LW-QA-016)', async () => {
      const state = (await wave1.committeeFollowState(ctxA, COMMITTEE.toUpperCase())) as {
        committeeSystemCode: string;
        following: boolean;
      };
      expect(state.following).toBe(false);
      // Echoes the CANONICAL stored code, not the caller's casing.
      expect(state.committeeSystemCode).toBe(COMMITTEE);
    });

    it('keys one follow row per committee regardless of casing (LW-QA-016)', async () => {
      await wave1.upsertCommitteeFollow(ctxA, COMMITTEE, { clientIds: [CLIENT_A1] });
      const upper = (await wave1.upsertCommitteeFollow(ctxA, COMMITTEE.toUpperCase(), {
        clientIds: [CLIENT_A2],
      })) as { committeeSystemCode: string; clientIds: string[] };

      expect(upper.committeeSystemCode).toBe(COMMITTEE);
      const rows = await prisma.withTenant(TENANT_A, (tx) =>
        tx.legiWatchCommitteeFollow.findMany({}),
      );
      // One row that was UPDATED — not a second row under a different casing.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.committeeSystemCode).toBe(COMMITTEE);
      expect(upper.clientIds).toEqual([CLIENT_A2]);

      // …and the mixed-case caller can remove the row it just edited.
      const gone = (await wave1.unfollowCommittee(ctxA, COMMITTEE.toUpperCase())) as {
        following: boolean;
      };
      expect(gone.following).toBe(false);
      const after = await prisma.withTenant(TENANT_A, (tx) =>
        tx.legiWatchCommitteeFollow.findMany({}),
      );
      expect(after).toHaveLength(0);
    });

    it('returns the same intelligence history for any casing (LW-QA-017)', async () => {
      const canonical = (await wave1.committeeIntelligenceHistory(ctxA, COMMITTEE, {})) as {
        total: number;
        committeeSystemCode: string;
        rows: Array<{ id: string }>;
      };
      const upper = (await wave1.committeeIntelligenceHistory(
        ctxA,
        COMMITTEE.toUpperCase(),
        {},
      )) as { total: number; committeeSystemCode: string; rows: Array<{ id: string }> };

      expect(upper.total).toBe(canonical.total);
      expect(upper.total).toBe(2);
      expect(upper.rows.map((r) => r.id).sort()).toEqual(canonical.rows.map((r) => r.id).sort());
      expect(upper.committeeSystemCode).toBe(COMMITTEE);
    });

    it('still 404s an unknown committee — casing tolerance is not fabrication', async () => {
      await expect(
        wave1.committeeIntelligenceHistory(ctxA, 'NOT-A-COMMITTEE', {}),
      ).rejects.toThrow(/not found/);
      await expect(wave1.committeeFollowState(ctxA, 'NOT-A-COMMITTEE')).rejects.toThrow(
        /not found/,
      );
    });
  });

  // ── W1-6 · client relevance ────────────────────────────────────────────

  describe('W1-6 client relevance', () => {
    it('returns a structured HIGH result with grounded evidence', async () => {
      const result = await wave1.clientRelevance(ctxA, H_DONE, CLIENT_A1);
      expect(result.band).toBe('HIGH');
      expect(result.score).toBeCloseTo(0.92, 5);
      expect(result.whyItMatters).toContain('Aperture supplies the submarine industrial base');
      expect(result.matchedPriorities.map((p) => p.label)).toContain(
        'submarine industrial base',
      );
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]?.insightId).toBe(INSIGHT_1);
      expect(result.evidence[0]?.segmentId).toBe(SEG_1);
      expect(result.evidence[0]?.timecode).toBe('0:00:00');
      expect(result.implications.length).toBeGreaterThan(0);
      expect(result.recommendedActions.length).toBeGreaterThan(0);
      expect(result.provenance.insightIds).toEqual([INSIGHT_1]);
      expect(result.provenance.transcriptAvailable).toBe(true);
      expect(result.evaluatedAt).not.toBeNull();
    });

    it('bands a mid-scoring client as MEDIUM', async () => {
      const result = await wave1.clientRelevance(ctxA, H_DONE, CLIENT_A2);
      expect(result.band).toBe('MEDIUM');
    });

    it('returns NONE, not an error, for a client with no match', async () => {
      const result = await wave1.clientRelevance(ctxA, H_DONE, CLIENT_A_ARCHIVED);
      expect(result.band).toBe('NONE');
      expect(result.evidence).toEqual([]);
      expect(result.recommendedActions).toEqual([]);
      expect(result.whyItMatters).toContain('No watchlist or client-priority match');
    });

    it('reports NONE with no evidence once the transcript is deleted', async () => {
      await prisma.$executeRawUnsafe(
        `DELETE FROM public_hearing_transcript_segment WHERE capture_id = $1`,
        CAPTURE_DONE,
      );
      const result = await wave1.clientRelevance(ctxA, H_DONE, CLIENT_A1);
      // public_hearing_insight.segment_id is FK'd ON DELETE CASCADE, so removing
      // the segments removes the insights and, cascading again, the tenant
      // relevance rows citing them. The schema therefore makes it impossible for
      // a surviving relevance row to cite a segment that no longer exists — the
      // reachable outcome is NONE, and no transcript-derived claim is emitted.
      // The INSUFFICIENT_EVIDENCE guard covers the same class defensively and is
      // exercised directly in legiwatch-wave1-relevance.spec.ts, where that state
      // can be constructed.
      expect(result.band).toBe('NONE');
      expect(result.evidence).toEqual([]);
      expect(result.implications).toEqual([]);
      expect(result.provenance.transcriptAvailable).toBe(false);
    });

    it('ranks All Clients and includes non-matching clients as NONE', async () => {
      const all = (await wave1.allClientsRelevance(ctxA, H_DONE)) as {
        clients: Array<{ clientId: string; band: string }>;
        counts: Record<string, number>;
      };
      expect(all.clients[0]?.clientId).toBe(CLIENT_A1);
      expect(all.clients[0]?.band).toBe('HIGH');
      expect(all.counts.HIGH).toBe(1);
      expect(all.counts.MEDIUM).toBe(1);
      // Archived clients are excluded from the active client list.
      expect(all.clients.map((c) => c.clientId)).not.toContain(CLIENT_B1);
    });
  });

  // ── W1-5 · lifecycle notifications ─────────────────────────────────────

  describe('W1-5 notifications', () => {
    beforeEach(async () => {
      await wave1.upsertFollow(ctxA, H_DONE, { clientIds: [CLIENT_A1] });
    });

    it('emits a schedule-change notification to a follower', async () => {
      const result = await notifications.emitScheduleChanged({
        tenantId: TENANT_A,
        hearingId: H_DONE,
        hearingTitle: 'Shipbuilding',
        newStartsAt: new Date('2026-10-01T14:00:00Z'),
        newCalendarDate: '2026-10-01',
      });
      expect(result.created).toBe(1);
      const inbox = (await notifications.inbox(ctxA, {})) as {
        rows: Array<{ eventType: string; deepLink: string; clientId: string | null }>;
      };
      expect(inbox.rows[0]?.eventType).toBe('schedule_changed');
      expect(inbox.rows[0]?.deepLink).toBe(`/legiwatch/hearings/${H_DONE}`);
      expect(inbox.rows[0]?.clientId).toBe(CLIENT_A1);
    });

    it('does NOT duplicate on a repeated observation of the same schedule', async () => {
      const args = {
        tenantId: TENANT_A,
        hearingId: H_DONE,
        hearingTitle: 'Shipbuilding',
        newStartsAt: new Date('2026-10-01T14:00:00Z'),
        newCalendarDate: '2026-10-01',
      };
      const first = await notifications.emitScheduleChanged(args);
      const second = await notifications.emitScheduleChanged(args);
      const third = await notifications.emitScheduleChanged(args);
      expect(first.created).toBe(1);
      expect(second.created).toBe(0);
      expect(third.created).toBe(0);
      expect(second.duplicates).toBe(1);
      const inbox = (await notifications.inbox(ctxA, {})) as { total: number };
      expect(inbox.total).toBe(1);
    });

    it('DOES notify again when the schedule genuinely changes a second time', async () => {
      await notifications.emitScheduleChanged({
        tenantId: TENANT_A,
        hearingId: H_DONE,
        hearingTitle: 'Shipbuilding',
        newStartsAt: new Date('2026-10-01T14:00:00Z'),
        newCalendarDate: '2026-10-01',
      });
      await notifications.emitScheduleChanged({
        tenantId: TENANT_A,
        hearingId: H_DONE,
        hearingTitle: 'Shipbuilding',
        newStartsAt: new Date('2026-10-08T14:00:00Z'),
        newCalendarDate: '2026-10-08',
      });
      const inbox = (await notifications.inbox(ctxA, {})) as { total: number };
      expect(inbox.total).toBe(2);
    });

    it('treats a reordered witness list as no change', async () => {
      const a = await notifications.emitWitnessesChanged({
        tenantId: TENANT_A,
        hearingId: H_DONE,
        hearingTitle: 'Shipbuilding',
        witnesses: ['Jane Whitfield', 'Admiral Cortez'],
      });
      const b = await notifications.emitWitnessesChanged({
        tenantId: TENANT_A,
        hearingId: H_DONE,
        hearingTitle: 'Shipbuilding',
        witnesses: ['Admiral Cortez', 'Jane Whitfield'],
      });
      expect(a.created).toBe(1);
      expect(b.created).toBe(0);
    });

    it('suppresses delivery when the preference is off', async () => {
      await wave1.upsertFollow(ctxA, H_DONE, {
        clientIds: [CLIENT_A1],
        notifyOnScheduleChange: false,
      });
      const result = await notifications.emitScheduleChanged({
        tenantId: TENANT_A,
        hearingId: H_DONE,
        hearingTitle: 'Shipbuilding',
        newStartsAt: new Date('2026-10-01T14:00:00Z'),
        newCalendarDate: '2026-10-01',
      });
      expect(result.created).toBe(0);
      expect(result.suppressedByPreference).toBe(1);
      const inbox = (await notifications.inbox(ctxA, {})) as { total: number };
      expect(inbox.total).toBe(0);
    });

    it('emits transcript-ready to followers who want it', async () => {
      const result = await notifications.emitTranscriptReady({
        tenantId: TENANT_A,
        hearingId: H_DONE,
        hearingTitle: 'Shipbuilding',
        captureId: CAPTURE_DONE,
      });
      expect(result.created).toBe(1);
    });

    it('sends a high-priority match only to followers who named that client', async () => {
      await wave1.upsertFollow(ctxA, H_DONE, { clientIds: [CLIENT_A2] });
      const result = await notifications.emitHighPriorityMatch({
        tenantId: TENANT_A,
        hearingId: H_DONE,
        hearingTitle: 'Shipbuilding',
        clientId: CLIENT_A1,
        clientName: 'Aperture Defense',
        insightId: INSIGHT_1,
      });
      // The follow names A2, so an A1 match must not reach it.
      expect(result.created).toBe(0);
    });

    it('fans a hearing-level event out once per named client', async () => {
      await wave1.upsertFollow(ctxA, H_DONE, { clientIds: [CLIENT_A1, CLIENT_A2] });
      const result = await notifications.emitTranscriptReady({
        tenantId: TENANT_A,
        hearingId: H_DONE,
        hearingTitle: 'Shipbuilding',
        captureId: CAPTURE_DONE,
      });
      expect(result.created).toBe(2);
    });

    it('marks a notification read, idempotently', async () => {
      await notifications.emitTranscriptReady({
        tenantId: TENANT_A,
        hearingId: H_DONE,
        hearingTitle: 'Shipbuilding',
        captureId: CAPTURE_DONE,
      });
      const inbox = (await notifications.inbox(ctxA, {})) as { rows: Array<{ id: string }> };
      const id = inbox.rows[0]!.id;
      expect((await notifications.markRead(ctxA, id)).read).toBe(true);
      expect((await notifications.markRead(ctxA, id)).read).toBe(false);
      const after = (await notifications.inbox(ctxA, { unreadOnly: true })) as { total: number };
      expect(after.total).toBe(0);
    });

    it('claims channel delivery once through the shipped NotificationLog', async () => {
      const first = await notifications.claimDelivery({
        tenantId: TENANT_A,
        clientId: CLIENT_A1,
        userId: ctxA.userId,
        dedupKey: 'transcript_ready:x',
        channel: 'email',
      });
      const second = await notifications.claimDelivery({
        tenantId: TENANT_A,
        clientId: CLIENT_A1,
        userId: ctxA.userId,
        dedupKey: 'transcript_ready:x',
        channel: 'email',
      });
      expect(first).not.toBeNull();
      expect(second).toBeNull(); // already claimed — no second send
    });

    it('reaches committee followers for a committee-scoped event', async () => {
      await wave1.unfollow(ctxA, H_DONE);
      await wave1.upsertCommitteeFollow(ctxA, COMMITTEE, {
        clientIds: [CLIENT_A1],
        notifyOnTranscriptReady: true,
      });
      const result = await notifications.emitTranscriptReady({
        tenantId: TENANT_A,
        hearingId: H_DONE,
        committeeSystemCode: COMMITTEE,
        hearingTitle: 'Shipbuilding',
        captureId: CAPTURE_DONE,
      });
      expect(result.created).toBe(1);
    });
  });

  // ── W1-7 · saved items and actions ─────────────────────────────────────

  describe('W1-7 actions', () => {
    it('saves a moment by canonical reference, not by copying the transcript', async () => {
      const saved = (await wave1.saveItem(ctxA, H_DONE, {
        kind: 'moment',
        segmentId: SEG_1,
        clientId: CLIENT_A1,
        note: 'Funding hook',
      })) as { id: string };
      const row = await prisma.withTenant(TENANT_A, (tx) =>
        tx.legiWatchSavedItem.findFirst({ where: { id: saved.id } }),
      );
      expect(row?.segmentId).toBe(SEG_1);
      expect(row?.hearingId).toBe(H_DONE);
      expect(row?.note).toBe('Funding hook');
      // No transcript text is duplicated into the tenant row.
      expect(JSON.stringify(row)).not.toContain('multiyear procurement');
    });

    it('is idempotent on re-save rather than creating a duplicate', async () => {
      await wave1.saveItem(ctxA, H_DONE, { kind: 'moment', segmentId: SEG_1, clientId: CLIENT_A1 });
      await wave1.saveItem(ctxA, H_DONE, { kind: 'moment', segmentId: SEG_1, clientId: CLIENT_A1 });
      const list = (await wave1.listSavedItems(ctxA, { hearingId: H_DONE })) as { total: number };
      expect(list.total).toBe(1);
    });

    it('treats the same segment saved for a different client as distinct', async () => {
      await wave1.saveItem(ctxA, H_DONE, { kind: 'moment', segmentId: SEG_1, clientId: CLIENT_A1 });
      await wave1.saveItem(ctxA, H_DONE, { kind: 'moment', segmentId: SEG_1, clientId: CLIENT_A2 });
      const list = (await wave1.listSavedItems(ctxA, { hearingId: H_DONE })) as { total: number };
      expect(list.total).toBe(2);
    });

    it('dedupes a client-less save, which a plain unique index would not', async () => {
      await wave1.saveItem(ctxA, H_DONE, { kind: 'hearing' });
      await wave1.saveItem(ctxA, H_DONE, { kind: 'hearing' });
      const list = (await wave1.listSavedItems(ctxA, { hearingId: H_DONE })) as { total: number };
      // NULL client_id would compare unequal in a plain unique index; the
      // COALESCE index is what makes this one row.
      expect(list.total).toBe(1);
    });

    it('refuses a segment that belongs to a different hearing', async () => {
      await expect(
        wave1.saveItem(ctxA, H_ELIGIBLE, { kind: 'moment', segmentId: SEG_1 }),
      ).rejects.toThrow(/does not belong to hearing/);
    });

    it('refuses a moment with no segment', async () => {
      await expect(wave1.saveItem(ctxA, H_DONE, { kind: 'moment' })).rejects.toThrow(
        /segmentId is required/,
      );
    });

    it('refuses a cross-tenant client on save', async () => {
      await expect(
        wave1.saveItem(ctxA, H_DONE, { kind: 'hearing', clientId: CLIENT_B1 }),
      ).rejects.toThrow(/Client not found/);
    });

    it('builds a grounded Meri packet carrying references, not a blob', async () => {
      const packet = (await wave1.buildMeriContextPacket(ctxA, H_DONE, {
        segmentId: SEG_1,
        insightId: INSIGHT_1,
        clientId: CLIENT_A1,
        question: 'What is the funding ask?',
      })) as {
        hearing: { id: string; detailPath: string };
        client: { id: string } | null;
        transcriptSegment: { id: string } | null;
        intelligenceFinding: { id: string } | null;
        clientRelevance: Array<{ insightId: string; band: string }>;
        evidenceReferences: { hearingId: string; segmentIds: string[]; insightIds: string[] };
      };
      expect(packet.hearing.id).toBe(H_DONE);
      expect(packet.client?.id).toBe(CLIENT_A1);
      expect(packet.transcriptSegment?.id).toBe(SEG_1);
      expect(packet.intelligenceFinding?.id).toBe(INSIGHT_1);
      expect(packet.clientRelevance[0]?.band).toBe('HIGH');
      expect(packet.evidenceReferences).toEqual({
        hearingId: H_DONE,
        segmentIds: [SEG_1],
        insightIds: [INSIGHT_1],
      });
    });

    it('does not put another client’s context into the Meri packet', async () => {
      const packet = (await wave1.buildMeriContextPacket(ctxA, H_DONE, {
        insightId: INSIGHT_1,
        clientId: CLIENT_A1,
      })) as { clientRelevance: Array<{ insightId: string }> };
      // Only the SELECTED client's relevance, and only for the selected finding.
      expect(packet.clientRelevance).toHaveLength(1);
      expect(JSON.stringify(packet)).not.toContain('Northwind');
      expect(JSON.stringify(packet)).not.toContain('Beta Advocacy');
    });

    it('refuses a Meri packet naming another tenant’s client', async () => {
      await expect(
        wave1.buildMeriContextPacket(ctxA, H_DONE, { clientId: CLIENT_B1 }),
      ).rejects.toThrow(/Client not found/);
    });

    it('builds a brief prefill grounded in the client’s matched findings', async () => {
      const prefill = (await wave1.buildBriefPrefill(ctxA, H_DONE, {
        clientId: CLIENT_A1,
      })) as {
        draft: { docTitle: string; client?: string };
        context: { findings: Array<{ id: string }> };
        sources: Array<{ kind: string; id: string }>;
      };
      expect(prefill.draft.docTitle).toContain('Shipbuilding');
      expect(prefill.draft.client).toBe('Aperture Defense');
      // Grounded in the CLIENT'S matched findings, not every finding.
      expect(prefill.context.findings.map((f) => f.id)).toEqual([INSIGHT_1]);
      expect(prefill.sources.some((s) => s.kind === 'hearing')).toBe(true);
      expect(prefill.sources.some((s) => s.kind === 'intelligence_finding')).toBe(true);
    });

    it('builds an outreach prefill that is staged, never sent', async () => {
      const prefill = (await wave1.buildOutreachPrefill(ctxA, H_DONE, {
        clientId: CLIENT_A1,
        insightId: INSIGHT_2,
        segmentId: SEG_2,
      })) as {
        status: string;
        autoSend: boolean;
        clientId: string;
        context: { finding: { id: string } | null; transcriptMoment: { id: string } | null };
      };
      expect(prefill.status).toBe('staged');
      expect(prefill.autoSend).toBe(false);
      expect(prefill.clientId).toBe(CLIENT_A1);
      expect(prefill.context.finding?.id).toBe(INSIGHT_2);
      expect(prefill.context.transcriptMoment?.id).toBe(SEG_2);
    });

    it('refuses an outreach prefill for another tenant’s client', async () => {
      await expect(
        wave1.buildOutreachPrefill(ctxA, H_DONE, { clientId: CLIENT_B1 }),
      ).rejects.toThrow(/Client not found/);
    });
  });

  // ── W1-8 · calendar export against real rows ───────────────────────────

  describe('W1-8 calendar export', () => {
    it('exports a timed hearing as a UTC instant', async () => {
      const result = await wave1.calendarExport(ctxA, H_DONE, 'https://os.capiro.ai');
      expect(result.allDay).toBe(false);
      expect(result.ics).toContain('BEGIN:VEVENT');
      expect(result.ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
      expect(result.detailUrl).toBe(`https://os.capiro.ai/legiwatch/hearings/${H_DONE}`);
    });

    it('exports a date-only hearing as an all-day event with no invented time', async () => {
      const result = await wave1.calendarExport(ctxA, H_DATEONLY, 'https://os.capiro.ai');
      expect(result.allDay).toBe(true);
      expect(result.ics).toMatch(/DTSTART;VALUE=DATE:\d{8}/);
      expect(result.ics).not.toContain('T000000Z');
    });

    it('keeps the UID stable across exports', async () => {
      const a = await wave1.calendarExport(ctxA, H_DONE, 'https://os.capiro.ai');
      const b = await wave1.calendarExport(ctxB, H_DONE, 'https://os.capiro.ai');
      // The event is a public record; the UID does not vary by tenant.
      expect(a.uid).toBe(b.uid);
    });
  });

  // ── Hearing Detail V2 composition ──────────────────────────────────────

  describe('Hearing Detail V2', () => {
    it('composes the detail without serializing the transcript body', async () => {
      const detail = (await wave1.detailV2(ctxA, H_DONE)) as {
        hearing: { id: string; calendarDate: string };
        followState: { following: boolean };
        attendanceState: { state: string };
        transcriptSummary: { available: boolean; segmentCount: number; transcriptPath: string };
        intelligenceSummary: { total: number };
        clientRelevance: unknown;
        availableActions: Record<string, boolean>;
      };
      expect(detail.hearing.id).toBe(H_DONE);
      expect(detail.hearing.calendarDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(detail.followState.following).toBe(false);
      expect(detail.attendanceState.state).toBe('COMPLETE');
      expect(detail.transcriptSummary.available).toBe(true);
      expect(detail.transcriptSummary.segmentCount).toBe(2);
      expect(detail.intelligenceSummary.total).toBe(2);
      expect(detail.availableActions.exportCalendar).toBe(true);
      // The transcript BODY stays on its own paginated endpoint. Short grounded
      // evidence quotes from client relevance are deliberately present, so this
      // asserts on the part of the segment text that exists ONLY in the full
      // transcript row and not in any insight's evidence quote.
      const payload = JSON.stringify(detail);
      expect(payload).not.toContain('The submarine industrial base requires');
      expect(payload).not.toContain('Ms. Whitfield, will you commit');
      expect(detail.transcriptSummary).not.toHaveProperty('segments');
      expect(detail.transcriptSummary.transcriptPath).toContain('/transcript');
    });

    it('offers no attendance action on a closed session', async () => {
      const detail = (await wave1.detailV2(ctxA, H_CLOSED)) as {
        attendanceState: { state: string };
        availableActions: Record<string, boolean>;
      };
      expect(detail.attendanceState.state).toBe('CLOSED_SESSION');
      expect(detail.availableActions.attend).toBe(false);
    });

    it('switches the client lens without changing the public facts', async () => {
      const all = (await wave1.detailV2(ctxA, H_DONE)) as {
        hearing: Record<string, unknown>;
        transcriptSummary: Record<string, unknown>;
      };
      const scoped = (await wave1.detailV2(ctxA, H_DONE, { clientId: CLIENT_A1 })) as {
        hearing: Record<string, unknown>;
        transcriptSummary: Record<string, unknown>;
        clientRelevance: { band: string };
      };
      // Analysis changes; the canonical record does not.
      expect(scoped.clientRelevance.band).toBe('HIGH');
      expect(scoped.hearing).toEqual(all.hearing);
      expect(scoped.transcriptSummary).toEqual(all.transcriptSummary);
    });
  });
});
