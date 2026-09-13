import { CommitteeSourceRepository } from '../../hearing-discovery/committee-source.repository.js';
import { HearingObservationRepository } from '../../hearing-discovery/hearing-observation.repository.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LegiWatchPhase9PreflightService } from './legiwatch-phase9-preflight.service.js';
import { LegiWatchPhase9ReadinessService } from './legiwatch-phase9-readiness.service.js';

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
    // Wipe the full disposable hearing surface, not only this fixture id.
    // Preflight eligibility is global; leftover rows from earlier suites
    // (e.g. phase7-hearing) inflate eligible/checkpoint counts.
    await prisma.$executeRawUnsafe(
      `DELETE FROM legiwatch_verification_evidence
       WHERE recorded_by='phase9-postgres-test'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM legiwatch_cutover_run
       WHERE created_by='phase9-postgres-test'`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM public_hearing_capture_job`);
    await prisma.$executeRawUnsafe(`DELETE FROM public_hearing_capture_attempt`);
    await prisma.$executeRawUnsafe(`DELETE FROM public_hearing_transcript_segment`);
    await prisma.$executeRawUnsafe(`DELETE FROM public_hearing_insight`);
    await prisma.$executeRawUnsafe(`DELETE FROM public_hearing_intelligence_job`);
    await prisma.$executeRawUnsafe(`DELETE FROM tenant_hearing_relevance`);
    await prisma.$executeRawUnsafe(`DELETE FROM tenant_hearing_relevance_job`);
    await prisma.$executeRawUnsafe(`DELETE FROM hearing_subscription`);
    await prisma.$executeRawUnsafe(`DELETE FROM hearing_follow`);
    await prisma.$executeRawUnsafe(`DELETE FROM public_hearing_capture`);
    await prisma.$executeRawUnsafe(`DELETE FROM hearing_stream_candidate`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM hearing_source_observation
       WHERE source_id IN (
         SELECT id FROM committee_source WHERE adapter_key=$1
       )
       OR hearing_id=$2`,
      ADAPTER_KEY,
      HEARING_ID,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM committee_hearing_bill`);
    await prisma.$executeRawUnsafe(`DELETE FROM committee_hearing`);
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
    expect(runtime[0]).toEqual({ total: 13, enabled: 0, scheduled: 0 });
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
       WHERE id=$1`,
      observed.observationId,
    );
    const metadata = await prisma.$queryRawUnsafe<Array<{ startsAt: string | null }>>(
      `SELECT source_metadata #>> '{event,startsAt}' AS "startsAt"
       FROM hearing_source_observation
       WHERE id=$1`,
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
         stream_availability, coverage_status
       ) VALUES (
         $1, 'house', 'House Armed Services Committee', 'hsas00',
         'Phase 9 Postgres hearing', 'hearing', $2::date, $3,
         'America/New_York', 'scheduled', 'public', $4,
         'unknown', 'discovered'
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
       WHERE id=$1`,
      observationId,
    );
    if (!rows[0]) throw new Error(`observation ${observationId} not found`);
    return rows[0];
  }
});

describeDb('LegiWatch Phase 9 readiness evaluateAndPersist (Postgres, extended tx budget)', () => {
  // Disposable-Postgres proof for the production tx-timeout hotfix: seeds a
  // real Phase 9 dataset (committee, source, observation, hearing, capture,
  // multiple exception-triggering rows) and calls evaluateAndPersist end to
  // end against the live schema, proving the 30s withSystem budget actually
  // lets the transaction complete rather than merely asserting it in a mock.
  const prisma = new PrismaService();
  const readiness = new LegiWatchPhase9ReadinessService(prisma);
  const sources = new CommitteeSourceRepository(prisma);
  const observations = new HearingObservationRepository(prisma);

  const SYSTEM_CODE = 'hsii00-p9tx';
  const SUB_SYSTEM_CODE = 'hsii01-p9tx';
  const HEARING_PASS_ID = 'phase9-tx-hearing-pass';
  const HEARING_PENDING_ID = 'phase9-tx-hearing-pending';
  const ADAPTER = 'phase9-tx-source';
  const SRC_URL = 'https://example.invalid/phase9-tx-source';
  const ACTOR = 'phase9-postgres-tx-test';

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterEach(async () => {
    await cleanup();
  });

  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `DELETE FROM legiwatch_event_audit
       WHERE run_id IN (
         SELECT id FROM legiwatch_cutover_run WHERE created_by=$1
       )`,
      ACTOR,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM legiwatch_cutover_run WHERE created_by=$1`,
      ACTOR,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM hearing_source_observation
       WHERE source_id IN (
         SELECT id FROM committee_source WHERE adapter_key=$1
       )
       OR hearing_id IN ($2, $3)`,
      ADAPTER,
      HEARING_PASS_ID,
      HEARING_PENDING_ID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM public_hearing_transcript_segment
       WHERE capture_id IN (
         SELECT id FROM public_hearing_capture WHERE hearing_id IN ($1, $2)
       )`,
      HEARING_PASS_ID,
      HEARING_PENDING_ID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM public_hearing_capture WHERE hearing_id IN ($1, $2)`,
      HEARING_PASS_ID,
      HEARING_PENDING_ID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM committee_hearing WHERE id IN ($1, $2)`,
      HEARING_PASS_ID,
      HEARING_PENDING_ID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM committee_source WHERE adapter_key=$1`,
      ADAPTER,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM congress_committee WHERE system_code IN ($1, $2)`,
      SYSTEM_CODE,
      SUB_SYSTEM_CODE,
    );
  }

  async function seed(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, status, created_at, updated_at)
       VALUES ($1::uuid, 'phase9-tx-test', 'Phase 9 Tx Test', 'active', now(), now())
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO congress_committee (
         system_code, thomas_id, name, chamber, parent_system_code, is_current
       ) VALUES
         ($1, 'p9tx00', 'Phase 9 Tx Committee', 'house', NULL, true),
         ($2, 'p9tx01', 'Phase 9 Tx Subcommittee', 'house', $1, true)`,
      SYSTEM_CODE,
      SUB_SYSTEM_CODE,
    );

    const source = await sources.ensureSource({
      committeeSystemCode: SYSTEM_CODE,
      chamber: 'house',
      sourceType: 'COMMITTEE_SITE',
      sourceUrl: SRC_URL,
      adapterKey: ADAPTER,
      priority: 100,
    });

    // Hearing 1: fully passing (official observation reconciled, capture
    // complete, transcript continuous) — exercises the clean PASS path.
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing (
         id, chamber, committee_name, committee_system_code, subcommittee_system_code,
         title, type, date, starts_at, timezone, event_status, visibility, url,
         stream_availability, coverage_status
       ) VALUES (
         $1, 'house', 'Phase 9 Tx Committee', $2, $3,
         'Phase 9 Tx passing hearing', 'hearing', $4::date, $4,
         'America/New_York', 'completed', 'public', $5,
         'archived', 'captured'
       )`,
      HEARING_PASS_ID,
      SYSTEM_CODE,
      SUB_SYSTEM_CODE,
      new Date('2026-08-20T13:00:00Z'),
      SRC_URL,
    );
    const passObservation = await observations.recordObservation(
      source,
      {
        externalEventId: 'phase9-tx-event-pass',
        congress: 119,
        chamber: 'house',
        committeeSystemCode: SYSTEM_CODE,
        committeeName: 'Phase 9 Tx Committee',
        title: 'Phase 9 Tx passing hearing',
        eventType: 'hearing',
        eventStatus: 'completed',
        visibility: 'public',
        startsAt: new Date('2026-08-20T13:00:00Z'),
        calendarDate: new Date('2026-08-20T00:00:00Z'),
        officialPageUrl: SRC_URL,
        streamCandidates: [],
      },
      new Date('2026-08-20T12:00:00Z'),
    );
    await observations.linkToHearing(passObservation.observationId, HEARING_PASS_ID);

    const passCapture = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO public_hearing_capture (
         id, hearing_id, domain_status, terminal_reason_code, transcript_gap_seconds, gaps
       ) VALUES (
         gen_random_uuid()::text, $1, 'COMPLETE', 'CAPTURE_COMPLETE', 0, '[]'::jsonb
       ) RETURNING id`,
      HEARING_PASS_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO hearing_subscription (
         tenant_id, user_id, hearing_id, notify_on_start, notify_on_mention,
         scheduled_by_user, client_ids, created_at, updated_at
       ) VALUES (
         $1::uuid, $2, $3, true, false, true, ARRAY[]::text[], now(), now()
       )`,
      TENANT_ID,
      USER_ID,
      HEARING_PASS_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_transcript_segment (
         id, capture_id, sequence, has_gap_before, text, start_ms, end_ms
       ) VALUES (
         gen_random_uuid()::text, $1, 0, false, 'seed segment', 0, 5000
       )`,
      passCapture[0]?.id,
    );

    // Hearing 2: a pending/unlinked observation + an incomplete capture —
    // exercises the multi-row exception-audit insert path inside the same
    // persistence transaction (several distinct blockers/exceptions).
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing (
         id, chamber, committee_name, committee_system_code, subcommittee_system_code,
         title, type, date, starts_at, timezone, event_status, visibility, url,
         stream_availability, coverage_status
       ) VALUES (
         $1, 'house', 'Phase 9 Tx Committee', $2, $3,
         'Phase 9 Tx pending hearing', 'hearing', $4::date, $4,
         'America/New_York', 'scheduled', 'public', $5,
         'unknown', 'discovered'
       )`,
      HEARING_PENDING_ID,
      SYSTEM_CODE,
      SUB_SYSTEM_CODE,
      new Date('2026-08-21T13:00:00Z'),
      SRC_URL,
    );
    await observations.recordObservation(
      source,
      {
        externalEventId: 'phase9-tx-event-pending',
        congress: 119,
        chamber: 'house',
        committeeSystemCode: SYSTEM_CODE,
        committeeName: 'Phase 9 Tx Committee',
        title: 'Phase 9 Tx pending hearing',
        eventType: 'hearing',
        eventStatus: 'scheduled',
        visibility: 'public',
        startsAt: new Date('2026-08-21T13:00:00Z'),
        calendarDate: new Date('2026-08-21T00:00:00Z'),
        officialPageUrl: SRC_URL,
        streamCandidates: [],
      },
      new Date('2026-08-21T12:00:00Z'),
    );
    // Left unlinked deliberately (no linkToHearing call) so it stays PENDING,
    // generating an OFFICIAL_OBSERVATION_PENDING exception row.
  }

  it('completes evaluateAndPersist end-to-end against a seeded Phase 9 dataset with the extended tx budget', async () => {
    const before = await prisma.$queryRawUnsafe<Array<{ lastRunId: string | null }>>(
      `SELECT last_run_id::text AS "lastRunId" FROM legiwatch_cutover_state WHERE id='global'`,
    );

    const { report, run } = await readiness.evaluateAndPersist(ACTOR, {
      now: new Date('2026-08-22T00:00:00Z'),
      lookbackDays: 30,
      lookaheadDays: 30,
      evidenceSource: 'LOCAL_FIXTURE',
      mode: 'READINESS',
    });

    // 1. It completes without throwing the Prisma "Transaction already
    //    closed" error that reproduced in production.
    expect(run.id).toBeTruthy();
    expect(report).toBeDefined();

    // 2. A cutover-run row was written.
    const runRows = await prisma.$queryRawUnsafe<
      Array<{ id: string; status: string; evidenceSource: string }>
    >(
      `SELECT id::text AS id, status, evidence_source AS "evidenceSource"
       FROM legiwatch_cutover_run WHERE id=$1::uuid`,
      run.id,
    );
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.evidenceSource).toBe('LOCAL_FIXTURE');

    // 3. Event-audit rows were written for the pending-observation exception
    //    (multiple exception rows exercised: the pending hearing generates at
    //    least one OFFICIAL_OBSERVATION_PENDING/related audit row).
    const auditRows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM legiwatch_event_audit WHERE run_id=$1::uuid`,
      run.id,
    );
    expect(auditRows[0]?.count).toBeGreaterThanOrEqual(1);

    // 4. legiwatch_cutover_state.last_run_id updated to this run.
    const after = await prisma.$queryRawUnsafe<Array<{ lastRunId: string | null }>>(
      `SELECT last_run_id::text AS "lastRunId" FROM legiwatch_cutover_state WHERE id='global'`,
    );
    expect(after[0]?.lastRunId).toBe(run.id);
    expect(after[0]?.lastRunId).not.toBe(before[0]?.lastRunId);

    // 5. Passing/non-passing semantics are unchanged: the pending observation
    //    for hearing 2 means this run cannot be a clean PASS.
    expect(['FAIL', 'BLOCKED']).toContain(report.status);
    expect(report.blockers.length).toBeGreaterThan(0);
  });
});
