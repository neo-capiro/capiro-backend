/**
 * PR B §4/§5/§10 — canonical detail/transcript/intelligence/committee contract
 * proof against a REAL Postgres (disposable capiro-lwqa-pg, api-migrated schema).
 *
 * Why real PG (not mocks): the PR A reschedule defect was only catchable against
 * a real engine (physical column vs allowlist). The tenant-boundary guarantees
 * asserted here (§5-E/F) are exactly the kind port-level mocks hide.
 *
 * Gate: process.env.DATABASE_URL must point at the disposable PG with the
 * apps/api migration chain applied. Skipped cleanly otherwise (same posture as
 * live-hearings-phase7.integration.spec).
 */
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { CommitteeDirectoryService } from './committee-directory.service.js';
import { LiveHearingsPhase7PublicGuard } from './live-hearings-phase7-public.guard.js';
import { LiveHearingsPhase7Service } from './live-hearings-phase7.service.js';
import { LiveHearingsPhase8Service, derivePhase8Status } from './live-hearings-phase8.service.js';
import { LiveHearingsService } from './live-hearings.service.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

// TRUNCATE CASCADE across 14 tables + a wide seed can exceed jest's 5s default
// hook timeout on a loaded container; an aborted hook leaves orphaned seed
// statements that then collide with the next beforeEach. Generous budgets.
jest.setTimeout(180_000);

const TENANT_A = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000b2';
const CLIENT_A = '00000000-0000-0000-0000-000000000ca1';
const CLIENT_B = '00000000-0000-0000-0000-000000000cb2';

const ctxA: TenantContext = {
  tenantId: TENANT_A,
  tenantSlug: 'lw-detail-a',
  userId: 'lw-user-a',
  clerkUserId: 'lw-clerk-a',
  role: 'standard_user',
};
const ctxB: TenantContext = {
  tenantId: TENANT_B,
  tenantSlug: 'lw-detail-b',
  userId: 'lw-user-b',
  clerkUserId: 'lw-clerk-b',
  role: 'standard_user',
};

const H_MAIN = 'lw-detail-main'; // completed public + capture COMPLETE + transcript + insights
const H_UPCOMING = 'lw-detail-upcoming';
const H_CANCELED = 'lw-detail-canceled';
const H_CLOSED = 'lw-detail-closed';
const H_FAILED = 'lw-detail-failed'; // completed public + capture FAILED / NO_PUBLIC_STREAM
const H_NOCAP = 'lw-detail-nocap'; // completed public, no capture requested
const H_LIVE = 'lw-detail-live'; // in_progress + capture CAPTURING
const H_EMPTY = 'lw-detail-empty'; // completed public, capture ended, zero segments

interface InsightWire {
  id: string;
  insightType: string;
  evidence: { segmentId: string; startMs: number; endMs: number; text: string | null };
  speakerName: string | null;
  preliminary: boolean;
  relevance: Array<{ clientId: string; clientName: string | null; rationale: string }>;
}

interface CommitteeRoom {
  systemCode: string;
  chamber: string;
  officialUrl: string | null;
  parent: { systemCode: string } | null;
  subcommittees: Array<{ systemCode: string }>;
  members: Array<{ bioguideId: string; role: string | null }>;
  chair: { bioguideId: string; name: string; role: string | null } | null;
  rankingMember: { bioguideId: string; name: string; role: string | null } | null;
  upcomingEvents: Array<{ id: string }>;
  recentEvents: Array<{ id: string }>;
  liveEvent: { id: string } | null;
  updates: Array<{ id: string }>;
}

describeDb('Live Hearings canonical detail stack (Postgres integration, PR B §4/§5/§10)', () => {
  const prisma = new PrismaService();
  const hearings = new LiveHearingsService(prisma);
  const committees = new CommitteeDirectoryService(prisma, hearings);
  const phase7 = new LiveHearingsPhase7Service(prisma, hearings, committees);
  const phase8 = new LiveHearingsPhase8Service(prisma);
  const publicGuard = new LiveHearingsPhase7PublicGuard(prisma);

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE tenant_hearing_relevance_job,
                tenant_hearing_relevance,
                public_hearing_intelligence_job,
                public_hearing_insight,
                public_hearing_transcript_segment,
                public_hearing_capture_attempt,
                public_hearing_capture,
                hearing_subscription,
                hearing_stream_candidate,
                committee_site_update,
                committee_hearing,
                committee_source,
                congress_committee_membership,
                clients
       CASCADE`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'lw-detail-a', 'LW Detail A'),
              ($2::uuid, 'lw-detail-b', 'LW Detail B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_A,
      TENANT_B,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clients (id, tenant_id, name, status)
       VALUES ($1::uuid, $3::uuid, 'Alpha Gov Relations', 'active'),
              ($2::uuid, $4::uuid, 'Beta Advocacy', 'active')
       ON CONFLICT (id) DO NOTHING`,
      CLIENT_A,
      CLIENT_B,
      TENANT_A,
      TENANT_B,
    );
    // Committee directory: unique per-run codes (the shared disposable PG keeps
    // rows from other suites; committee rows are global reference data we must
    // not TRUNCATE). Suffix keeps FK-safe isolation without cross-suite coupling.
    await prisma.$executeRawUnsafe(
      `INSERT INTO congress_committee (system_code, thomas_id, name, chamber, parent_system_code, url, is_current)
       VALUES ('hs00-lwdt', 'HSLWD', 'Armed Services Committee (detail test)', 'house', NULL, 'https://armedservices.house.gov', true),
              ('hs16-lwdt', 'HS16L', 'Seapower and Projection Forces (detail test)', 'house', 'hs00-lwdt', 'https://armedservices.house.gov/subcommittees/seapower', true),
              ('ss00-lwdt', 'SS00L', 'Committee on Armed Services (detail test, Senate)', 'senate', NULL, 'https://www.armed-services.senate.gov', true)
       ON CONFLICT (system_code) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, is_current = true`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM congress_committee_membership WHERE system_code='hs00-lwdt' AND bioguide_id IN ('A000001','B000002','C000003')`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO congress_committee_membership (id, system_code, bioguide_id, side, rank, title)
       VALUES (gen_random_uuid(), 'hs00-lwdt', 'A000001', 'majority', 1, 'Chair'),
              (gen_random_uuid(), 'hs00-lwdt', 'B000002', 'minority', 1, 'Ranking Member'),
              (gen_random_uuid(), 'hs00-lwdt', 'C000003', 'majority', 2, NULL)`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO congress_member (bioguide_id, first_name, last_name, full_name, party, chamber, is_current)
       VALUES ('A000001', 'Alice', 'Smith', 'Rep. Alice Smith', 'R', 'house', true),
              ('B000002', 'Bob', 'Jones', 'Rep. Bob Jones', 'D', 'house', true),
              ('C000003', 'Carol', 'Lee', 'Rep. Carol Lee', 'D', 'house', true)
       ON CONFLICT (bioguide_id) DO NOTHING`,
    );

    // Eight canonical hearings covering the detail state matrix.
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing
         (id, chamber, committee_name, committee_system_code, subcommittee_system_code,
          title, type, date, starts_at, time, timezone, event_status, visibility, url, location,
          stream_availability, coverage_status, congress)
       VALUES
         ($1, 'House', 'House Armed Services', 'hs00-lwdt', NULL,
          'Shipbuilding industrial base oversight', 'hearing', CURRENT_DATE - 1,
          now() - interval '1 day', '10:00 AM', 'America/New_York', 'completed', 'public',
          'https://armedservices.house.gov/hearings/main', '2167 Rayburn House Office Building',
          'archived', 'captured', 119),
         ($2, 'House', 'House Armed Services', 'hs00-lwdt', NULL,
          'Future upcoming hearing', 'hearing', CURRENT_DATE + 2,
          now() + interval '2 days', '2:00 PM', 'America/New_York', 'scheduled', 'public',
          'https://armedservices.house.gov/hearings/upcoming', '2118 Rayburn', 'unknown', 'discovered', 119),
         ($3, 'House', 'House Armed Services', 'hs00-lwdt', NULL,
          'Canceled markup', 'markup', CURRENT_DATE + 3, now() + interval '3 days', NULL,
          'America/New_York', 'canceled', 'public', NULL, NULL, 'unknown', 'not_covered', 119),
         ($4, 'House', 'House Armed Services', 'hs00-lwdt', NULL,
          'Closed briefing on classified programs', 'briefing', CURRENT_DATE + 1,
          now() + interval '1 day', NULL, 'America/New_York', 'scheduled', 'private', NULL,
          'SCIF', 'unknown', 'blocked', 119),
         ($5, 'House', 'House Armed Services', 'hs00-lwdt', NULL,
          'Field hearing with failed capture', 'hearing', CURRENT_DATE - 2,
          now() - interval '2 days', '1:00 PM', 'America/Los_Angeles', 'completed', 'public',
          'https://armedservices.house.gov/hearings/failed', 'Santa Clarita, CA', 'none', 'no_public_stream', 119),
         ($6, 'House', 'House Armed Services', 'hs00-lwdt', NULL,
          'Completed without capture requested', 'hearing', CURRENT_DATE - 3,
          now() - interval '3 days', '9:30 AM', 'America/New_York', 'completed', 'public',
          NULL, '2118 Rayburn', 'unknown', 'not_covered', 119),
         ($7, 'House', 'House Armed Services', 'hs00-lwdt', NULL,
          'Live proceeding', 'hearing', CURRENT_DATE, now(), NULL, 'America/New_York',
          'in_progress', 'public', NULL, '2167 Rayburn', 'live_only', 'capturing', 119),
         ($8, 'House', 'House Armed Services', 'hs00-lwdt', NULL,
          'Completed, capture ended, no segments yet', 'hearing', CURRENT_DATE - 1,
          now() - interval '1 day', '11:00 AM', 'America/New_York', 'completed', 'public',
          NULL, '2118 Rayburn', 'archived', 'captured', 119)`,
      H_MAIN,
      H_UPCOMING,
      H_CANCELED,
      H_CLOSED,
      H_FAILED,
      H_NOCAP,
      H_LIVE,
      H_EMPTY,
    );

    const seedCapture = async (
      captureId: string,
      hearingId: string,
      status: string,
      domainStatus: string,
      failureCode: string | null = null,
    ): Promise<void> => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO public_hearing_capture
           (id, hearing_id, status, domain_status, scheduled_start, actual_start, actual_end,
            captured_seconds, failure_code)
         VALUES ($1, $2, $3, $4, now() - interval '1 day', now() - interval '1 day',
                 CASE WHEN $4::text IN ('COMPLETE','COMPLETE_WITH_GAPS','ENDED','FAILED','BLOCKED') THEN now() ELSE NULL END,
                 CASE WHEN $4::text IN ('COMPLETE','COMPLETE_WITH_GAPS') THEN 3600 ELSE 0 END,
                 $5)`,
        captureId,
        hearingId,
        status,
        domainStatus,
        failureCode,
      );
    };
    await seedCapture('lw-detail-capture-main', H_MAIN, 'ended', 'COMPLETE');
    await seedCapture('lw-detail-capture-failed', H_FAILED, 'failed', 'FAILED', 'NO_PUBLIC_STREAM');
    await seedCapture('lw-detail-capture-live', H_LIVE, 'capturing', 'CAPTURING');
    await seedCapture('lw-detail-capture-empty', H_EMPTY, 'ended', 'COMPLETE_WITH_GAPS');

    // Ordered segments for the main hearing; a gap before segment 2; distinct speakers.
    await prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_transcript_segment
         (id, capture_id, sequence, start_ms, end_ms, text, speaker_label, transcription_confidence, is_final, has_gap_before)
       VALUES ('lw-seg-1', 'lw-detail-capture-main', 1, 0, 40000, 'The committee will come to order. Today we examine the shipbuilding industrial base.', 'Chair', 0.98, true, false),
              ('lw-seg-2', 'lw-detail-capture-main', 2, 41000, 90000, 'We must reaffirm our commitment to the skilled trades workforce.', 'Witness', 0.94, true, true),
              ('lw-seg-3', 'lw-detail-capture-main', 3, 91000, 150000, 'What is the timeline for the next generation of unmanned vessels?', 'Ranking Member', 0.96, true, false)`,
    );
    // The phase8 enqueue trigger writes durable jobs for these final segments —
    // the intelligence route must honestly report PROCESSING until they drain.

    await prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_insight
         (id, hearing_id, capture_id, segment_id, sequence, start_ms, end_ms,
          insight_type, title, summary, evidence_text, speaker_name, confidence,
          preliminary, entities, extractor, extractor_version)
       VALUES
         ('lw-insight-1', $1, 'lw-detail-capture-main', 'lw-seg-2', 2, 41000, 90000,
          'COMMITMENT', 'Workforce commitment', 'The witness committed to expanding the skilled trades pipeline.',
          'We must reaffirm our commitment to the skilled trades workforce.', 'Witness', 0.9, false,
          '[]'::jsonb, 'integration-test-extractor', '1.0.0'),
         ('lw-insight-2', $1, 'lw-detail-capture-main', 'lw-seg-3', 3, 91000, 150000,
          'QUESTION', 'Unmanned vessel timeline', 'The ranking member asked for the unmanned vessels timeline.',
          'What is the timeline for the next generation of unmanned vessels?', 'Ranking Member', 0.88, true,
          '[]'::jsonb, 'integration-test-extractor', '1.0.0')`,
      H_MAIN,
    );

    // Tenant A relevance on insight 1 only (via client A). Tenant B gets nothing.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenant_hearing_relevance
         (id, tenant_id, client_id, client_name, hearing_id, insight_id, score, matched_on, rationale)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'Alpha Gov Relations', $3, 'lw-insight-1', 0.87,
               '[{"kind":"KEYWORD","value":"shipbuilding"}]'::jsonb,
               'Matches client shipbuilding interest')`,
      TENANT_A,
      CLIENT_A,
      H_MAIN,
    );

    // Site update for the committee room (§10)
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_site_update
         (id, committee_system_code, hearing_id, update_type, normalized_title, source_url,
          content_hash, official_published_at)
       VALUES ('lw-update-1', 'hs00-lwdt', $1, 'witness_added',
               'Witness list updated for shipbuilding oversight',
               'https://armedservices.house.gov/news', 'hash-lw-update-1', now() - interval '2 hours')`,
      H_MAIN,
    );
  });

  // ── §4: Event detail contract ─────────────────────────────────────────────

  it('§4 event detail — completed hearing carries every required field', async () => {
    const event = await hearings.event(ctxA, H_MAIN);
    expect(event).not.toBeNull();
    expect(event!.id).toBe(H_MAIN);
    expect(event!.title).toContain('Shipbuilding industrial base');
    expect(event!.committeeName).toBe('Armed Services Committee (detail test)');
    expect(event!.committeeSystemCode).toBe('hs00-lwdt');
    expect(event!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(event!.startsAt).toBeTruthy();
    expect(event!.timezone).toBe('America/New_York');
    expect(event!.time).toBe('10:00 AM');
    expect(event!.location).toBe('2167 Rayburn House Office Building');
    expect(event!.visibility).toBe('public');
    expect(event!.officialPageUrl).toContain('armedservices.house.gov');
    expect(event!.eventStatus).toBe('completed');
    // Hydration prefers the canonical domain outcome over the legacy storage
    // status ('ended'); transcript and event detail share that lifecycle.
    expect(event!.capture).toMatchObject({ status: 'COMPLETE' });
  });

  it('§4-A detail resolves the correct hearing in every lifecycle state', async () => {
    const upcoming = await hearings.event(ctxA, H_UPCOMING);
    expect(upcoming!.eventStatus).toBe('scheduled');
    expect(upcoming!.capture).toBeNull();

    const canceled = await hearings.event(ctxA, H_CANCELED);
    expect(canceled!.eventStatus).toBe('canceled');

    const closed = await hearings.event(ctxA, H_CLOSED);
    expect(closed!.visibility).toBe('private');

    const failed = await hearings.event(ctxA, H_FAILED);
    expect(failed!.capture).toMatchObject({ status: 'FAILED', failureCode: 'NO_PUBLIC_STREAM' });
    expect(failed!.timezone).toBe('America/Los_Angeles');

    const noCap = await hearings.event(ctxA, H_NOCAP);
    expect(noCap!.eventStatus).toBe('completed');
    expect(noCap!.capture).toBeNull();

    const live = await hearings.event(ctxA, H_LIVE);
    expect(live!.eventStatus).toBe('in_progress');
    expect(live!.capture!.status).toBe('CAPTURING');

    await expect(hearings.event(ctxA, 'lw-detail-missing')).resolves.toBeNull();
  });

  // ── §4/§5: Transcript contract ────────────────────────────────────────────

  it('§4/§5-B/C transcript belongs to the hearing, orders monotonic, cursor pagination works', async () => {
    const first = await phase7.transcript(H_MAIN, { limit: 2 });
    expect(first.hearingId).toBe(H_MAIN);
    expect(first.total).toBe(3);
    expect(first.items.map((s) => s.sequence)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await phase7.transcript(H_MAIN, {
      limit: 10,
      cursor: first.nextCursor ?? undefined,
    });
    const sequences = [...first.items, ...second.items].map((s) => s.sequence);
    expect(sequences).toEqual([1, 2, 3]); // strictly monotonic across pages
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();

    // Segment content: speaker + timestamps + gap marker survive the read path
    const gapSeg = second.items.find((s) => s.sequence === 3);
    expect(gapSeg).toMatchObject({
      speakerLabel: 'Ranking Member',
      speakerName: 'Ranking Member',
      hasGapBefore: false,
    });
    expect(gapSeg!.startMs).toBe(91000);
    expect(gapSeg!.text).toContain('unmanned vessels');
    // The gap marker lives on segment 2 (page 1).
    const gapOnPage1 = first.items.find((s) => s.sequence === 2);
    expect(gapOnPage1).toMatchObject({ speakerLabel: 'Witness', gapBefore: true, hasGapBefore: true });
    expect(gapOnPage1!.text).toContain('skilled trades');
  });

  it('§4 transcript empty state: completed hearing with a capture but zero segments returns an honest empty page', async () => {
    const transcript = await phase7.transcript(H_EMPTY, { limit: 50 });
    expect(transcript.items).toHaveLength(0);
    expect(transcript.total).toBe(0);
    expect(transcript.hasMore).toBe(false);
    expect(transcript.capture).not.toBeNull();
    // Hearing with NO capture at all → capture: null, still an honest empty page.
    const noCap = await phase7.transcript(H_NOCAP, { limit: 50 });
    expect(noCap.items).toHaveLength(0);
    expect(noCap.capture).toBeNull();
  });

  it('§5-F global transcript payload carries no tenant or client content', async () => {
    const transcript = await phase7.transcript(H_MAIN, { limit: 250 });
    const wire = JSON.stringify(transcript).toLowerCase();
    expect(wire).not.toContain(TENANT_A);
    expect(wire).not.toContain(TENANT_B);
    expect(wire).not.toContain(CLIENT_A);
    expect(wire).not.toContain(CLIENT_B);
    expect(wire).not.toContain('alpha gov relations');
    expect(wire).not.toContain('beta advocacy');
  });

  it('§5-H closed hearing: public transcript guard refuses (public path blocked)', async () => {
    await expect(publicGuard.assertPublic(H_CLOSED)).rejects.toMatchObject({ status: 403 });
    // Unknown hearing is a 404 from the same guard.
    await expect(publicGuard.assertPublic('lw-detail-missing')).rejects.toMatchObject({
      status: 404,
    });
    // Defense-in-depth from the service layer: the closed hearing has no PUBLIC
    // transcript surface even when addressed directly.
    await expect(phase7.transcript(H_CLOSED, { limit: 10 })).rejects.toMatchObject({ status: 403 });
  });

  it('§5-H closed hearing: intelligence route refuses non-public proceedings (404 contract)', async () => {
    await expect(phase8.intelligence(ctxA, H_CLOSED, {})).rejects.toMatchObject({ status: 404 });
  });

  // ── §4/§5: Intelligence contract ──────────────────────────────────────────

  it('§4/§5-D intelligence: typed, evidence-linked, timestamp/speaker grounded', async () => {
    const response = await phase8.intelligence(ctxA, H_MAIN, {});
    const items = response.items as InsightWire[];
    expect(items).toHaveLength(2);

    const commitment = items.find((i) => i.id === 'lw-insight-1')!;
    expect(commitment.insightType).toBe('COMMITMENT');
    expect(commitment.evidence.segmentId).toBe('lw-seg-2'); // real transcript evidence
    expect(commitment.evidence.startMs).toBe(41000);
    expect(commitment.evidence.text).toContain('skilled trades');
    expect(commitment.speakerName).toBe('Witness');

    // Tenant A relevance attaches to its own insight only
    expect(commitment.relevance).toHaveLength(1);
    expect(commitment.relevance[0]).toMatchObject({
      clientId: CLIENT_A,
      clientName: 'Alpha Gov Relations',
    });
    const question = items.find((i) => i.id === 'lw-insight-2')!;
    expect(question.relevance).toHaveLength(0);
  });

  it('§5-E/F tenant boundary: relevance is tenant-scoped; global payload stays tenant-free', async () => {
    const forA = await phase8.intelligence(ctxA, H_MAIN, {});
    const forB = await phase8.intelligence(ctxB, H_MAIN, {});
    const itemsA = forA.items as InsightWire[];
    const itemsB = forB.items as InsightWire[];

    expect(itemsA.some((i) => i.relevance.length > 0)).toBe(true);
    // Tenant B reads the SAME global insights with ZERO relevance rows.
    expect(itemsB.every((i) => i.relevance.length === 0)).toBe(true);

    // No tenant-private content may leak into the B response.
    const wireB = JSON.stringify(forB).toLowerCase();
    expect(wireB).not.toContain(CLIENT_A);
    expect(wireB).not.toContain('alpha gov relations');
    expect(wireB).not.toContain('shipbuilding interest'); // A's rationale text
    expect(wireB).not.toContain(TENANT_A);

    // And the wire for A never carries B's identity either.
    const wireA = JSON.stringify(forA).toLowerCase();
    expect(wireA).not.toContain(CLIENT_B);
    expect(wireA).not.toContain('beta advocacy');
  });

  it('filters client relevance before paging and counts only this tenant matches', async () => {
    // Make the first public insight unrelated and the later one relevant. A
    // post-LIMIT filter would incorrectly return an empty first page.
    await prisma.$executeRawUnsafe(
      `UPDATE tenant_hearing_relevance SET insight_id='lw-insight-2'
       WHERE tenant_id=$1::uuid AND hearing_id=$2`,
      TENANT_A,
      H_MAIN,
    );
    const relevant = await phase8.intelligence(ctxA, H_MAIN, {
      onlyRelevant: true, clientId: CLIENT_A, limit: 1,
    });
    expect((relevant.items as InsightWire[]).map((item) => item.id)).toEqual(['lw-insight-2']);
    expect(relevant).toMatchObject({
      hasMore: false,
      nextCursor: null,
      summary: { total: 1, returned: 1, byType: { QUESTION: 1 } },
    });

    const otherTenant = await phase8.intelligence(ctxB, H_MAIN, {
      onlyRelevant: true, clientId: CLIENT_A, limit: 1,
    });
    expect(otherTenant).toMatchObject({ items: [], hasMore: false, summary: { total: 0 } });
  });

  it('§4/§8 intelligence status: PROCESSING while extraction pending, READY when drained, EMPTY only when truly nothing', async () => {
    // Freshly seeded segments → durable jobs pending → status PROCESSING.
    const processing = await phase8.intelligence(ctxA, H_MAIN, {});
    expect(processing.status).toBe('PROCESSING');
    const processingJobs = processing.jobs as { public: Record<string, number> };
    expect(processingJobs.public.pending).toBeGreaterThan(0);

    // Drain the queue for the main hearing → READY with real summary counts.
    await prisma.$executeRawUnsafe(
      `UPDATE public_hearing_intelligence_job SET status='completed' WHERE hearing_id=$1`,
      H_MAIN,
    );
    const ready = await phase8.intelligence(ctxA, H_MAIN, {});
    expect(ready.status).toBe('READY');
    expect((ready.summary as { total: number }).total).toBe(2);
    expect((ready.summary as { evidenceSegments: number }).evidenceSegments).toBe(2);

    // Completed public hearing, capture ended, but zero segments/insights/jobs:
    // only here may the product say "nothing was extracted".
    const empty = await phase8.intelligence(ctxA, H_EMPTY, {});
    expect(empty.status).toBe('EMPTY');
    expect(empty.items).toHaveLength(0);
    expect((empty.summary as { total: number }).total).toBe(0);
    expect((empty.summary as { evidenceSegments: number }).evidenceSegments).toBe(0);

    // The pure classifier agrees on all four terminal shapes (unit-level pin).
    expect(derivePhase8Status({ total: 0, publicCounts: { pending: 1 }, tenantCounts: {} })).toBe('PROCESSING');
    expect(derivePhase8Status({ total: 2, publicCounts: {}, tenantCounts: {} })).toBe('READY');
    expect(derivePhase8Status({ total: 0, publicCounts: {}, tenantCounts: {} })).toBe('EMPTY');
    expect(derivePhase8Status({ total: 0, publicCounts: { failed: 1 }, tenantCounts: {} })).toBe('FAILED');
  });

  it('§5-G reads create no duplicate capture/transcript rows', async () => {
    const count = async (): Promise<{ captures: number; segments: number }> => {
      const rows = await prisma.$queryRawUnsafe<Array<{ captures: number; segments: number }>>(
        `SELECT
           (SELECT COUNT(*)::int FROM public_hearing_capture WHERE hearing_id=$1) AS captures,
           (SELECT COUNT(*)::int FROM public_hearing_transcript_segment WHERE capture_id=$2) AS segments`,
        H_MAIN,
        'lw-detail-capture-main',
      );
      return rows[0]!;
    };
    const before = await count();
    await hearings.event(ctxA, H_MAIN);
    await phase7.transcript(H_MAIN, { limit: 2 });
    await phase7.transcript(H_MAIN, { limit: 250 });
    await phase8.intelligence(ctxA, H_MAIN, {});
    await phase8.intelligence(ctxB, H_MAIN, {});
    const after = await count();
    expect(after).toEqual(before);
    expect(after.captures).toBe(1);
    expect(after.segments).toBe(3);
  });

  // ── §10: Committee room ───────────────────────────────────────────────────

  it('§10 House full committee room: hierarchy, leadership from stated titles, members, official site, event windows, updates', async () => {
    const room = (await committees.committee('hs00-lwdt', ctxA)) as unknown as CommitteeRoom;
    expect(room).not.toBeNull();
    expect(room.systemCode).toBe('hs00-lwdt');
    expect(room.chamber).toBe('house');
    expect(room.officialUrl).toBe('https://armedservices.house.gov');
    expect(room.parent).toBeNull();
    expect(room.subcommittees.map((s) => s.systemCode)).toContain('hs16-lwdt');

    // Leadership comes from the roster's stated title, never array order.
    expect(room.chair).toMatchObject({ bioguideId: 'A000001', role: 'Chair' });
    expect(room.rankingMember).toMatchObject({ bioguideId: 'B000002', role: 'Ranking Member' });
    expect(room.members.map((m) => m.bioguideId).sort()).toEqual(['A000001', 'B000002', 'C000003']);

    expect(room.upcomingEvents.map((e) => e.id)).toContain(H_UPCOMING);
    expect(room.recentEvents.map((e) => e.id)).toContain(H_MAIN);
    expect(room.recentEvents.map((e) => e.id)).not.toContain(H_UPCOMING);

    expect(room.updates.map((u) => u.id)).toContain('lw-update-1');
  });

  it('§10 subcommittee room: parent hierarchy present; scoped event windows', async () => {
    const room = (await committees.committee('hs16-lwdt', ctxA)) as unknown as CommitteeRoom;
    expect(room).not.toBeNull();
    expect(room.parent?.systemCode).toBe('hs00-lwdt');
    // The subcommittee window contains only subcommittee events (none seeded).
    expect(room.upcomingEvents).toHaveLength(0);
  });

  it('§10 Senate body zero-hearing state; unknown committee resolves null (404 shape)', async () => {
    const room = (await committees.committee('ss00-lwdt', ctxA)) as unknown as CommitteeRoom;
    expect(room.systemCode).toBe('ss00-lwdt');
    expect(room.chamber).toBe('senate');
    expect(room.upcomingEvents).toHaveLength(0);
    expect(room.recentEvents).toHaveLength(0);
    expect(room.members).toHaveLength(0); // honest "roster not synced" zero-state
    expect(room.chair).toBeNull();
    expect(room.rankingMember).toBeNull();

    await expect(committees.committee('hs99-lwdt', ctxA)).resolves.toBeNull();
  });
});
