/**
 * Behavioral PostgreSQL regression for the Phase 9 planner demand predicate
 * (hearing-demand-08 root requirement: actual semantics, not SQL-shape
 * mocks). The real LegiWatchPhase9PreflightService SQL runs against TEMP
 * tables on one connection inside a rolled-back transaction — no application
 * records are created or changed, and the canonical Judiciary338740 QA
 * fixture is never touched.
 *
 *   - browser-only attendance must NOT create planner work
 *     (skippedNoDemand, zero captures, zero checkpoints);
 *   - automatic attendance with an explicit origin (scheduled_by_user OR
 *     scheduled_by_rule_id) creates the canonical capture + 4 checkpoints;
 *   - notification-only automatic rows (neither origin set) do not count;
 *   - mixed automatic+browser demand counts exactly 1.
 *
 * The planner re-scans every in-window hearing on each plan() call and
 * fixtures persist inside the transaction, so expectations are asserted as
 * CUMULATIVE running totals; per-hearing truth uses id-scoped queries.
 */
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  LegiWatchPhase9PreflightService,
} from './legiwatch-phase9-preflight.service.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('LegiWatchPhase9PreflightService automatic demand (PostgreSQL)', () => {
  jest.setTimeout(60_000);
  let pool: Pool;
  let client: PoolClient;
  let service: LegiWatchPhase9PreflightService;
  const now = new Date();
  const STARTS_AT = new Date(now.getTime() + 2 * 3_600_000);
  const prefix = `lw-plan-${randomUUID().slice(0, 8)}`;

  const tx = {
    $queryRawUnsafe: async <T = unknown>(sql: string, ...values: unknown[]): Promise<T> =>
      (await client.query(sql, values)).rows as T,
  };

  async function hearing(key: string) {
    await client.query(
      `INSERT INTO committee_hearing (id, title, url, starts_at, event_status, visibility)
       VALUES ($1, 'Planner demand case', 'https://example.invalid/' || $1, $2, 'scheduled', 'public')`,
      [`${prefix}-${key}`, STARTS_AT],
    );
  }

  async function subscribe(
    key: string,
    user: string,
    opts: { mode: string; byUser: boolean; byRule?: boolean },
  ) {
    await client.query(
      `INSERT INTO hearing_subscription
         (tenant_id, user_id, hearing_id, attendance_mode, scheduled_by_user, scheduled_by_rule_id)
       VALUES ('tenant-a', $1, $2, $3, $4, $5)`,
      [user, `${prefix}-${key}`, opts.mode, opts.byUser, opts.byRule ? `${prefix}-rule` : null],
    );
  }

  async function plan() {
    return service.plan({ now });
  }

  const capturesFor = async (key: string) =>
    (
      await client.query(
        `SELECT status, domain_status FROM public_hearing_capture WHERE hearing_id=$1`,
        [`${prefix}-${key}`],
      )
    ).rows;

  const jobsFor = async (key: string) =>
    (
      await client.query(
        `SELECT dedupe_key, status, payload FROM public_hearing_capture_job
         WHERE hearing_id=$1 ORDER BY dedupe_key`,
        [`${prefix}-${key}`],
      )
    ).rows as Array<{ dedupe_key: string; status: string; payload: { mustReresolve: boolean } }>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE committee_hearing (
        id text PRIMARY KEY, title text, visibility text DEFAULT 'public', url text,
        chamber text DEFAULT 'Senate', committee_name text DEFAULT 'Oversight',
        date date DEFAULT CURRENT_DATE, starts_at timestamptz,
        event_status text DEFAULT 'scheduled', type text DEFAULT 'hearing',
        geographic_jurisdiction text DEFAULT 'US'
      );
      CREATE TEMP VIEW federal_committee_hearing AS SELECT * FROM committee_hearing;
      CREATE TEMP TABLE hearing_subscription (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id text NOT NULL, user_id text NOT NULL, hearing_id text NOT NULL,
        attendance_mode text NOT NULL DEFAULT 'automatic',
        scheduled_by_user boolean NOT NULL DEFAULT false,
        scheduled_by_rule_id text
      );
      CREATE TEMP TABLE public_hearing_capture (
        id text PRIMARY KEY, hearing_id text NOT NULL UNIQUE,
        status text NOT NULL DEFAULT 'scheduled', domain_status text,
        scheduled_start timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TEMP TABLE public_hearing_capture_job (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_type text NOT NULL, dedupe_key text NOT NULL UNIQUE,
        hearing_id text NOT NULL, capture_id text REFERENCES public_hearing_capture(id),
        status text NOT NULL DEFAULT 'pending', due_at timestamptz NOT NULL DEFAULT now(),
        attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 10,
        lease_owner text, lease_expires_at timestamptz, last_error text,
        payload jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      );
      CREATE TEMP TABLE hearing_stream_candidate (
        id text PRIMARY KEY, hearing_id text NOT NULL,
        official_page_url text, media_url text,
        resolution_state text NOT NULL DEFAULT 'NOT_CHECKED',
        capture_policy text NOT NULL DEFAULT 'REVIEW_REQUIRED'
      );
      CREATE TEMP TABLE legiwatch_cutover_state (
        id text PRIMARY KEY DEFAULT 'global',
        capture_all_public_events boolean NOT NULL DEFAULT false
      );
      INSERT INTO legiwatch_cutover_state (id) VALUES ('global');
    `);
    service = new LegiWatchPhase9PreflightService(tx as unknown as PrismaService);
  });

  afterAll(async () => {
    await client?.query('ROLLBACK');
    client?.release();
    await pool?.end();
  });

  it('browser-only attendance creates no capture and no checkpoints', async () => {
    await hearing('browser-only');
    await subscribe('browser-only', 'user-a', { mode: 'browser', byUser: false });
    const result = await plan();
    expect(result).toMatchObject({
      eligible: 0,
      capturesCreated: 0,
      checkpointsInserted: 0,
      skippedNoDemand: 1,
      errors: [],
    });
    expect(await capturesFor('browser-only')).toEqual([]);
    expect(await jobsFor('browser-only')).toEqual([]);
  });

  it('notification-only automatic rows (no user/rule origin) create no work', async () => {
    await hearing('notify-only');
    await subscribe('notify-only', 'user-a', { mode: 'automatic', byUser: false });
    const result = await plan();
    // browser-only still scans and skips again; notify-only adds one more skip.
    expect(result).toMatchObject({ skippedNoDemand: 2, capturesCreated: 0, eligible: 0 });
    expect(await capturesFor('notify-only')).toEqual([]);
    expect(await jobsFor('notify-only')).toEqual([]);
  });

  it('automatic user-scheduled creates the canonical capture and four checkpoints', async () => {
    await hearing('auto-user');
    await subscribe('auto-user', 'user-a', { mode: 'automatic', byUser: true });
    const result = await plan();
    expect(result).toMatchObject({ eligible: 1, capturesCreated: 1, checkpointsInserted: 4 });
    expect(await capturesFor('auto-user')).toEqual([
      { status: 'scheduled', domain_status: 'SCHEDULED' },
    ]);
    const jobs = await jobsFor('auto-user');
    expect(jobs.map((j) => j.dedupe_key)).toEqual([
      `hearing-stream-preflight:v2:${prefix}-auto-user:start`,
      `hearing-stream-preflight:v2:${prefix}-auto-user:t15`,
      `hearing-stream-preflight:v2:${prefix}-auto-user:t2`,
      `hearing-stream-preflight:v2:${prefix}-auto-user:t60`,
    ]);
    expect(jobs.every((j) => j.status === 'pending' && j.payload.mustReresolve)).toBe(true);
  });

  it('automatic rule-scheduled counts as demand (one new capture, four checkpoints)', async () => {
    await hearing('auto-rule');
    await subscribe('auto-rule', 'user-a', { mode: 'automatic', byUser: false, byRule: true });
    const result = await plan();
    // Per-call semantics: each plan() re-scans all in-window hearings but only
    // the newly added row creates a capture (existing ones are reused and
    // their checkpoints re-arm, not re-insert).
    expect(result).toMatchObject({
      eligible: 2,
      capturesCreated: 1,
      checkpointsInserted: 4,
      skippedNoDemand: 2,
      errors: [],
    });
    expect(await capturesFor('auto-rule')).toEqual([
      { status: 'scheduled', domain_status: 'SCHEDULED' },
    ]);
    expect((await jobsFor('auto-rule')).map((j) => j.dedupe_key)).toHaveLength(4);
  });

  it('rule surviving manual cancel (scheduled_by_user cleared) still counts', async () => {
    await hearing('auto-rule-after-cancel');
    await subscribe('auto-rule-after-cancel', 'user-a', {
      mode: 'automatic',
      byUser: false,
      byRule: true,
    });
    const result = await plan();
    expect(result).toMatchObject({
      eligible: 3,
      capturesCreated: 1,
      checkpointsInserted: 4,
      skippedNoDemand: 2,
    });
    expect(await capturesFor('auto-rule-after-cancel')).toEqual([
      { status: 'scheduled', domain_status: 'SCHEDULED' },
    ]);
  });

  it('mixed automatic+browser demand counts exactly one and creates one capture', async () => {
    await hearing('mixed');
    await subscribe('mixed', 'user-a', { mode: 'automatic', byUser: true });
    await subscribe('mixed', 'user-b', { mode: 'browser', byUser: false });
    const counted = (
      await client.query(
        `SELECT COUNT(DISTINCT s.id) FILTER (
           WHERE s.attendance_mode='automatic'
             AND (s.scheduled_by_user OR s.scheduled_by_rule_id IS NOT NULL)
         )::int AS demand
         FROM hearing_subscription s WHERE s.hearing_id=$1`,
        [`${prefix}-mixed`],
      )
    ).rows[0];
    expect(counted.demand).toBe(1);
    const result = await plan();
    expect(result).toMatchObject({ eligible: 4, capturesCreated: 1, skippedNoDemand: 2 });
    expect(await capturesFor('mixed')).toHaveLength(1);
  });
});
