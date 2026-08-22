import { PrismaService } from '../../prisma/prisma.service.js';
import { HearingIntelligenceWorker } from './hearing-intelligence.worker.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const TENANT_A = '00000000-0000-0000-0000-00000000008a';
const TENANT_B = '00000000-0000-0000-0000-00000000008b';
const CLIENT_A = '00000000-0000-0000-0000-00000000018a';
const CLIENT_B = '00000000-0000-0000-0000-00000000018b';
const HEARING_ID = 'phase8-hearing';
const CAPTURE_ID = 'phase8-capture';
const SEGMENT_ID = 'phase8-segment';

describeDb('LegiWatch Phase 8 live intelligence (Postgres)', () => {
  const prisma = new PrismaService();

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

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
                hearing_follow,
                committee_hearing,
                tracked_bill,
                client_watchlist,
                client_capabilities,
                client_targets
       CASCADE`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, status)
       VALUES ($1::uuid, 'phase8-a', 'Phase 8 A', 'active'),
              ($2::uuid, 'phase8-b', 'Phase 8 B', 'active')
       ON CONFLICT (id) DO UPDATE SET status='active'`,
      TENANT_A,
      TENANT_B,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clients (id, tenant_id, name, status)
       VALUES ($1::uuid, $2::uuid, 'Autonomy Systems', 'active'),
              ($3::uuid, $4::uuid, 'Unrelated Health Client', 'active')
       ON CONFLICT (id) DO NOTHING`,
      CLIENT_A,
      TENANT_A,
      CLIENT_B,
      TENANT_B,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO client_watchlist
         (tenant_id, client_id, issue_areas, tags, created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, ARRAY['autonomy','Department of Defense'],
          '[{"tag":"secure AI compute","synonyms":["autonomous systems"]}]'::jsonb,
          now(), now())`,
      TENANT_A,
      CLIENT_A,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tracked_bill
         (tenant_id, client_id, bill_id, source, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, '119-hr-1234', 'manual_search', now(), now())`,
      TENANT_A,
      CLIENT_A,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO client_capabilities
         (tenant_id, client_id, name, type, description, pe_number, pe_numbers,
          keywords, service_branch, tags, issue_codes_jsonb, created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, 'Autonomous ground systems', 'product',
          'Secure autonomous systems for contested environments', '0601234A',
          ARRAY['0601234A'], ARRAY['autonomy','secure AI compute'], 'Department of Defense',
          '[]'::jsonb, '[]'::jsonb, now(), now())`,
      TENANT_A,
      CLIENT_A,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing
         (id, chamber, committee_name, committee_system_code, title, type, date,
          starts_at, timezone, event_status, visibility, url,
          stream_availability, coverage_status, witnesses)
       VALUES ($1, 'House', 'House Armed Services', 'hsas00',
               'Autonomous systems oversight hearing', 'hearing', CURRENT_DATE,
               now(), 'America/New_York', 'in_progress', 'public',
               'https://armedservices.house.gov/hearings/phase8',
               'live_only', 'capturing', ARRAY['Witness One'])`,
      HEARING_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_capture
         (id, hearing_id, status, domain_status, scheduled_start, actual_start,
          created_at, updated_at)
       VALUES ($1, $2, 'capturing', 'CAPTURING', now(), now(), now(), now())`,
      CAPTURE_ID,
      HEARING_ID,
    );
  });

  it('final transcript enqueue -> public insights -> tenant-private client relevance', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_transcript_segment
         (id, capture_id, sequence, start_ms, end_ms, text, speaker_label,
          transcription_confidence, is_final, has_gap_before, revision)
       VALUES ($1, $2, 1, 0, 9000,
         'We will provide the H.R. 1234 report to the Department of Defense by September 1, 2026 for PE 0601234A autonomous systems.',
         'Witness One', 0.97, true, false, 1)`,
      SEGMENT_ID,
      CAPTURE_ID,
    );

    const queued = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count
       FROM public_hearing_intelligence_job
       WHERE segment_id=$1`,
      SEGMENT_ID,
    );
    expect(queued[0]?.count).toBe(1);

    const worker = new HearingIntelligenceWorker(prisma, 'phase8-test-worker');
    const result = await worker.drainOnce();
    expect(result.publicCompleted).toBe(1);
    expect(result.publicInsightsPersisted).toBeGreaterThan(0);
    expect(result.tenantCompleted).toBe(2);
    expect(result.tenantMatchesPersisted).toBeGreaterThan(0);

    const insights = await prisma.$queryRawUnsafe<
      Array<{ id: string; type: string; entities: unknown }>
    >(
      `SELECT id, insight_type AS type, entities
       FROM public_hearing_insight
       WHERE hearing_id=$1
       ORDER BY insight_type`,
      HEARING_ID,
    );
    expect(insights.length).toBeGreaterThan(0);
    expect(insights.map((row) => row.type)).toEqual(
      expect.arrayContaining(['COMMITMENT', 'BILL_REFERENCE', 'PROGRAM_ELEMENT_REFERENCE']),
    );
    const publicJson = JSON.stringify(insights);
    expect(publicJson).not.toContain(TENANT_A);
    expect(publicJson).not.toContain(CLIENT_A);
    expect(publicJson).not.toContain('watchlist');

    const relevance = await prisma.$queryRawUnsafe<
      Array<{ tenantId: string; clientId: string; score: number }>
    >(
      `SELECT tenant_id::text AS "tenantId", client_id::text AS "clientId", score
       FROM tenant_hearing_relevance
       WHERE hearing_id=$1
       ORDER BY tenant_id, score DESC`,
      HEARING_ID,
    );
    expect(relevance.some((row) => row.tenantId === TENANT_A && row.clientId === CLIENT_A)).toBe(true);
    expect(relevance.some((row) => row.tenantId === TENANT_B)).toBe(false);

    const columns = await prisma.$queryRawUnsafe<Array<{ columnName: string }>>(
      `SELECT column_name AS "columnName"
       FROM information_schema.columns
       WHERE table_name='public_hearing_insight'`,
    );
    expect(columns.some((column) => column.columnName === 'tenant_id')).toBe(false);
  });

  it('a segment revision replaces stale derived insight and cascades stale tenant relevance', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_transcript_segment
         (id, capture_id, sequence, start_ms, end_ms, text, speaker_label,
          transcription_confidence, is_final, has_gap_before, revision)
       VALUES ($1, $2, 1, 0, 6000,
         'We will provide the H.R. 1234 report.', 'Witness One', 0.95, true, false, 1)`,
      SEGMENT_ID,
      CAPTURE_ID,
    );
    const worker = new HearingIntelligenceWorker(prisma, 'phase8-revision-worker');
    await worker.drainOnce();

    const before = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM public_hearing_insight WHERE segment_id=$1`,
      SEGMENT_ID,
    );
    expect(before.length).toBeGreaterThan(0);

    await prisma.$executeRawUnsafe(
      `UPDATE public_hearing_transcript_segment
       SET text='The report has already been delivered.', revision=2, updated_at=now()
       WHERE id=$1`,
      SEGMENT_ID,
    );
    await worker.drainOnce();

    const after = await prisma.$queryRawUnsafe<Array<{ id: string; summary: string }>>(
      `SELECT id, summary FROM public_hearing_insight WHERE segment_id=$1`,
      SEGMENT_ID,
    );
    expect(after.some((row) => row.summary.includes('will provide'))).toBe(false);

    const staleRelevance = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count
       FROM tenant_hearing_relevance
       WHERE insight_id = ANY($1::text[])`,
      before.map((row) => row.id),
    );
    expect(staleRelevance[0]?.count).toBe(0);
  });
});
