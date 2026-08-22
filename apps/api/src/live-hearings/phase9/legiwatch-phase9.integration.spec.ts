import { CommitteeSourceRepository } from '../../hearing-discovery/committee-source.repository.js';
import { HearingObservationRepository } from '../../hearing-discovery/hearing-observation.repository.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LegiWatchPhase9PreflightService } from './legiwatch-phase9-preflight.service.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const TENANT_ID = '00000000-0000-0000-0000-000000000990';
const HEARING_ID = 'phase9-postgres-hearing';
const USER_ID = 'phase9-postgres-user';
const ADAPTER_KEY = 'phase9-postgres-source';
const SOURCE_URL = 'https://example.invalid/phase9-postgres-source';

describeDb('LegiWatch Phase 9 (Postgres)', () => {
  const prisma = new PrismaService();
  const sources = new CommitteeSourceRepository(prisma);
  const observations = new HearingObservationRepository(prisma);
  const preflight = new LegiWatchPhase9PreflightService(prisma);

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanup();
  });

  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `DELETE FROM legiwatch_verification_evidence
       WHERE recorded_by='phase9-postgres-test'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM legiwatch_cutover_run
       WHERE created_by='phase9-postgres-test'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM public_hearing_capture_job WHERE hearing_id=$1`,
      HEARING_ID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM hearing_subscription WHERE hearing_id=$1`,
      HEARING_ID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM public_hearing_capture WHERE hearing_id=$1`,
      HEARING_ID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM hearing_source_observation
       WHERE source_id IN (
         SELECT id FROM committee_source WHERE adapter_key=$1
       )`,
      ADAPTER_KEY,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM committee_hearing WHERE id=$1`,
      HEARING_ID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM committee_source WHERE adapter_key=$1`,
      ADAPTER_KEY,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id=$1::uuid`,
      TENANT_ID,
    );
  }

  it('seeds the complete runtime registry dark and a fail-closed SHADOW state', async () => {
    const state = await prisma.$queryRawUnsafe<
      Array<{
        phase: string;
        productionDefault: boolean;
        schedulesEnabled: boolean;
        killSwitchEngaged: boolean;
        captureAllPublicEvents: boolean;
      }>
    >(
      `SELECT phase,
              production_default AS "productionDefault",
              schedules_enabled AS "schedulesEnabled",
              kill_switch_engaged AS "killSwitchEngaged",
              capture_all_public_events AS "captureAllPublicEvents"
       FROM legiwatch_cutover_state
       WHERE id='global'`,
    );
    expect(state[0]).toEqual({
      phase: 'SHADOW',
      productionDefault: false,
      schedulesEnabled: false,
      killSwitchEngaged: true,
      captureAllPublicEvents: false,
    });

    const runtime = await prisma.$queryRawUnsafe<
      Array<{ total: number; enabled: number; scheduled: number }>
    >(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE enabled)::int AS enabled,
              COUNT(*) FILTER (WHERE schedule_enabled)::int AS scheduled
       FROM legiwatch_runtime_heartbeat`,
    );
    expect(runtime[0]).toEqual({ total: 11, enabled: 0, scheduled: 0 });
  });

  it('rejects production-default, kill-switch release, and capture-all in SHADOW', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE legiwatch_cutover_state
         SET production_default=true
         WHERE id='global'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE legiwatch_cutover_state
         SET kill_switch_engaged=false
         WHERE id='global'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE legiwatch_cutover_state
         SET capture_all_public_events=true
         WHERE id='global'`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a passing readiness row without an evidence source', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO legiwatch_cutover_run (
           mode, status, evidence_source, window_start, window_end, created_by
         ) VALUES (
           'READINESS', 'PASS', 'NONE', now()-interval '1 hour', now(),
           'phase9-postgres-test'
         )`,
      ),
    ).rejects.toThrow();
  });

  it('persists unanchored operational blockers as RUN-scoped audit evidence', async () => {
    const run = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO legiwatch_cutover_run (
         mode, status, evidence_source, window_start, window_end,
         blocker_count, blockers, created_by
       ) VALUES (
         'READINESS', 'BLOCKED', 'NONE', now()-interval '1 hour', now(),
         1, ARRAY['JOB_FRESHNESS: worker stale'], 'phase9-postgres-test'
       ) RETURNING id::text AS id`,
    );
    const rows = await prisma.$queryRawUnsafe<Array<{ auditScope: string }>>(
      `INSERT INTO legiwatch_event_audit (
         run_id, gate_key, status, reason_code, details
       ) VALUES (
         $1::uuid, 'JOB_FRESHNESS', 'FAIL', 'RUNTIME_JOB_STALE',
         '{"jobKey":"capture-worker"}'::jsonb
       ) RETURNING audit_scope AS "auditScope"`,
      run[0]?.id,
    );
    expect(rows).toEqual([{ auditScope: 'RUN' }]);
  });

  it('auto-dispositions a canonical observation link and sanitizes malformed source time', async () => {
    await insertHearing(new Date('2026-08-22T13:00:00Z'));
    const source = await sources.ensureSource({
      committeeSystemCode: 'hsas00',
      chamber: 'house',
      sourceType: 'COMMITTEE_SITE',
      sourceUrl: SOURCE_URL,
      adapterKey: ADAPTER_KEY,
      priority: 100,
    });
    const observed = await observations.recordObservation(
      source,
      {
        externalEventId: 'phase9-postgres-event',
        congress: 119,
        chamber: 'house',
        committeeSystemCode: 'hsas00',
        committeeName: 'House Armed Services Committee',
        title: 'Phase 9 Postgres hearing',
        eventType: 'hearing',
        eventStatus: 'scheduled',
        visibility: 'public',
        startsAt: new Date('2026-08-22T13:00:00Z'),
        calendarDate: new Date('2026-08-22T00:00:00Z'),
        officialPageUrl: SOURCE_URL,
        streamCandidates: [],
      },
      new Date('2026-08-21T12:00:00Z'),
    );

    let state = await observationState(observed.observationId);
    expect(state).toMatchObject({ status: 'PENDING', reasonCode: null, hearingId: null });

    await observations.linkToHearing(observed.observationId, HEARING_ID);
    state = await observationState(observed.observationId);
    expect(state).toMatchObject({
      status: 'RECONCILED',
      reasonCode: 'CANONICAL_HEARING_LINKED',
      hearingId: HEARING_ID,
    });

    await prisma.$executeRawUnsafe(
      `UPDATE hearing_source_observation
       SET source_metadata=jsonb_set(
         source_metadata,
         '{event,startsAt}',
         to_jsonb('not-a-date'::text),
         true
       )
       WHERE id=$1::uuid`,
      observed.observationId,
    );
    const metadata = await prisma.$queryRawUnsafe<Array<{ startsAt: string | null }>>(
      `SELECT source_metadata #>> '{event,startsAt}' AS "startsAt"
       FROM hearing_source_observation
       WHERE id=$1::uuid`,
      observed.observationId,
    );
    expect(metadata).toEqual([{ startsAt: null }]);
  });

  it('creates one canonical capture and four idempotent preflight jobs across repeated planning', async () => {
    const now = new Date('2026-08-21T12:00:00Z');
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, status, created_at, updated_at)
       VALUES ($1::uuid, 'phase9-postgres', 'Phase 9 Postgres', 'active', now(), now())`,
      TENANT_ID,
    );
    await insertHearing(new Date('2026-08-21T13:00:00Z'));
    await prisma.$executeRawUnsafe(
      `INSERT INTO hearing_subscription (
         tenant_id, user_id, hearing_id, notify_on_start, notify_on_mention,
         scheduled_by_user, scheduled_by_rule_id, client_ids, watchlist_id,
         created_at, updated_at
       ) VALUES (
         $1::uuid, $2, $3, true, false, true, NULL,
         ARRAY[]::text[], NULL, now(), now()
       )`,
      TENANT_ID,
      USER_ID,
      HEARING_ID,
    );

    const first = await preflight.plan({ now, lookaheadDays: 2 });
    const second = await preflight.plan({ now, lookaheadDays: 2 });
    expect(first).toMatchObject({
      eligible: 1,
      capturesCreated: 1,
      checkpointsInserted: 4,
      errors: [],
    });
    expect(second).toMatchObject({
      eligible: 1,
      capturesCreated: 0,
      errors: [],
    });

    const captures = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count
       FROM public_hearing_capture
       WHERE hearing_id=$1`,
      HEARING_ID,
    );
    const jobs = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count
       FROM public_hearing_capture_job
       WHERE hearing_id=$1 AND job_type='preflight'`,
      HEARING_ID,
    );
    expect(captures[0]?.count).toBe(1);
    expect(jobs[0]?.count).toBe(4);
  });

  it('keeps verification evidence global and rejects tenant/client columns', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO legiwatch_verification_evidence (
         evidence_type, evidence_source, status, observed_at, expires_at,
         artifact_uri, details, recorded_by
       ) VALUES (
         'TENANT_RLS', 'LOCAL_FIXTURE', 'PASS', now(), now()+interval '30 days',
         's3://phase9/rls.json', '{"fixture":"rls"}'::jsonb,
         'phase9-postgres-test'
       )`,
    );
    const columns = await prisma.$queryRawUnsafe<Array<{ columnName: string }>>(
      `SELECT column_name AS "columnName"
       FROM information_schema.columns
       WHERE table_schema=current_schema()
         AND table_name='legiwatch_verification_evidence'`,
    );
    expect(columns.some((row) => row.columnName === 'tenant_id')).toBe(false);
    expect(columns.some((row) => row.columnName === 'client_id')).toBe(false);
    expect(columns.some((row) => row.columnName === 'watchlist_id')).toBe(false);
  });

  async function insertHearing(startsAt: Date): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing (
         id, chamber, committee_name, committee_system_code, title, type,
         date, starts_at, timezone, event_status, visibility, url,
         stream_availability, coverage_status, created_at, updated_at
       ) VALUES (
         $1, 'house', 'House Armed Services Committee', 'hsas00',
         'Phase 9 Postgres hearing', 'hearing', $2::date, $3,
         'America/New_York', 'scheduled', 'public', $4,
         'unknown', 'discovered', now(), now()
       )`,
      HEARING_ID,
      startsAt.toISOString().slice(0, 10),
      startsAt,
      SOURCE_URL,
    );
  }

  async function observationState(observationId: string): Promise<{
    status: string;
    reasonCode: string | null;
    hearingId: string | null;
  }> {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ status: string; reasonCode: string | null; hearingId: string | null }>
    >(
      `SELECT reconciliation_status AS status,
              reconciliation_reason_code AS "reasonCode",
              hearing_id AS "hearingId"
       FROM hearing_source_observation
       WHERE id=$1::uuid`,
      observationId,
    );
    if (!rows[0]) throw new Error(`observation ${observationId} not found`);
    return rows[0];
  }
});
