import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import {
  advanceScheduledTaskExecution,
  parseScheduledTaskDurableReceipt,
  type ScheduledTaskExecutionClaim,
} from '../src/meri/meri-schedule-execution-boundary.js';

const CONFIG_PATH = 'C:/dev/cap-meri-foundation-evidence/private/local-postgres.json';
const NODE = 'C:/Program Files/nodejs/node.exe';
const API_ROOT = resolve(__dirname, '..');
const CHILD_SOURCE = resolve(__dirname, 'run-clio-scheduled-tasks.postgres-child.ts');
const task = {
  id: '91111111-1111-4111-8111-111111111111',
  tenantId: '92222222-2222-4222-8222-222222222222',
  ownerUserId: '93333333-3333-4333-8333-333333333333',
};

type OwnedChild = {
  process: ChildProcessWithoutNullStreams;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => string;
};

describe('production scheduled runner — owned PostgreSQL kill/restart', () => {
  let pool: Pool;
  let schema: string;
  const children = new Set<OwnedChild>();

  beforeAll(async () => {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as {
      host: string;
      port: number;
      user: string;
      password: string;
      database: string;
      scope: string;
    };
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(55433);
    expect(config.user.length).toBeGreaterThan(0);
    expect(config.scope.length).toBeGreaterThan(0);
    pool = new Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      max: 8,
    });
    const identity = await pool.query<{
      user_ok: boolean;
      host_ok: boolean;
      port_ok: boolean;
    }>(
      `SELECT current_user = $1 AS user_ok,
              host(inet_server_addr()) = '127.0.0.1' AS host_ok,
              inet_server_port() = 55433 AS port_ok`,
      [config.user],
    );
    expect(identity.rows[0]).toEqual({ user_ok: true, host_ok: true, port_ok: true });

    schema = `meri_scheduler_runner_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const ownership = await pool.query<{ owned: boolean }>(
      `SELECT pg_get_userbyid(nspowner) = current_user AS owned
         FROM pg_namespace WHERE nspname = $1`,
      [schema],
    );
    expect(ownership.rows[0]).toEqual({ owned: true });
    await pool.query(`
      CREATE TABLE "${schema}".clio_scheduled_task (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        owner_user_id uuid NOT NULL,
        scope text NOT NULL DEFAULT 'user_private',
        name text NOT NULL,
        prompt text NOT NULL,
        interval_minutes integer NOT NULL,
        tool_allow_list jsonb NOT NULL DEFAULT '[]'::jsonb,
        metadata_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
        next_run_at timestamptz NOT NULL,
        last_run_at timestamptz,
        last_status varchar(40),
        run_count integer NOT NULL DEFAULT 0,
        enabled boolean NOT NULL DEFAULT true,
        created_by text NOT NULL DEFAULT 'meri',
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE "${schema}".tenants (
        id uuid PRIMARY KEY, slug text NOT NULL, status text NOT NULL
      );
      CREATE TABLE "${schema}".users (
        id uuid PRIMARY KEY, clerk_user_id text NOT NULL
      );
      CREATE TABLE "${schema}".tenant_memberships (
        tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL, status text NOT NULL,
        PRIMARY KEY (tenant_id, user_id)
      );
      CREATE TABLE "${schema}".clients (
        id uuid PRIMARY KEY, tenant_id uuid NOT NULL, status text NOT NULL DEFAULT 'active',
        memory_wall boolean NOT NULL DEFAULT false
      );
      CREATE TABLE "${schema}".client_memory_access (
        tenant_id uuid NOT NULL, client_id uuid NOT NULL, user_id uuid NOT NULL,
        PRIMARY KEY (tenant_id, client_id, user_id)
      );
      CREATE TABLE "${schema}".clio_proactive_alerts (
        id uuid PRIMARY KEY, tenant_id uuid NOT NULL, owner_user_id uuid,
        alert_type text NOT NULL, title text NOT NULL, body text NOT NULL,
        priority text NOT NULL, status text NOT NULL DEFAULT 'pending',
        source_type text, source_id text, metadata_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE "${schema}".controlled_effects (
        id bigserial PRIMARY KEY, kind text NOT NULL, worker_pid integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE "${schema}".runner_checkpoints (
        id bigserial PRIMARY KEY, stage text NOT NULL, occurrence_id uuid NOT NULL,
        fence uuid NOT NULL, recovered boolean NOT NULL, worker_pid integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      INSERT INTO "${schema}".tenants (id, slug, status)
        VALUES ('${task.tenantId}', 'runner-native', 'active');
      INSERT INTO "${schema}".users (id, clerk_user_id)
        VALUES ('${task.ownerUserId}', 'clerk-runner-owner');
      INSERT INTO "${schema}".tenant_memberships (tenant_id, user_id, role, status)
        VALUES ('${task.tenantId}', '${task.ownerUserId}', 'standard_user', 'active');
    `);
  }, 30_000);

  afterEach(async () => {
    for (const child of [...children]) await terminateOwnedChild(child);
    await pool.query(`
      TRUNCATE TABLE "${schema}".clio_scheduled_task,
                     "${schema}".clio_proactive_alerts,
                     "${schema}".controlled_effects,
                     "${schema}".runner_checkpoints RESTART IDENTITY;
      UPDATE "${schema}".tenant_memberships SET status = 'active';
      UPDATE "${schema}".tenants SET status = 'active';
    `);
  });

  afterAll(async () => {
    for (const child of [...children]) await terminateOwnedChild(child);
    if (pool && schema) {
      const ownership = await pool.query<{ owned: boolean }>(
        `SELECT pg_get_userbyid(nspowner) = current_user AS owned
           FROM pg_namespace WHERE nspname = $1`,
        [schema],
      );
      if (ownership.rows[0]?.owned !== true) {
        throw new Error('refusing to drop an unowned runner integration schema');
      }
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      const remaining = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_namespace WHERE nspname = $1`,
        [schema],
      );
      expect(remaining.rows[0]).toEqual({ count: 0 });
    }
    if (pool) await pool.end();
  }, 30_000);

  function startRunner(checkpoint = ''): OwnedChild {
    const child = spawn(NODE, ['--import', 'tsx', CHILD_SOURCE], {
      cwd: API_ROOT,
      env: {
        ...process.env,
        MERI_SCHEDULER_RUNNER_SCHEMA: schema,
        MERI_SCHEDULER_RUNNER_CHECKPOINT: checkpoint,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => {
        child.once('exit', (code, signal) => resolveExit({ code, signal }));
      },
    );
    const owned = { process: child, exited, output: () => output };
    children.add(owned);
    return owned;
  }

  async function terminateOwnedChild(child: OwnedChild): Promise<void> {
    if (!children.has(child)) throw new Error('refusing to terminate an unrecorded process');
    if (!child.process.pid) throw new Error('owned test child has no recorded pid');
    child.process.kill('SIGTERM');
    await child.exited;
    children.delete(child);
  }

  async function runToCompletion(): Promise<string> {
    const child = startRunner();
    const result = await child.exited;
    children.delete(child);
    if (result.code !== 0) throw new Error(`runner child exited ${result.code}: ${child.output()}`);
    return child.output();
  }

  async function waitForCheckpoint(stage: string, recovered?: boolean) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const result = await pool.query<{
        stage: string;
        occurrence_id: string;
        fence: string;
        recovered: boolean;
        worker_pid: number;
      }>(
        `SELECT stage, occurrence_id, fence, recovered, worker_pid
           FROM "${schema}".runner_checkpoints
          WHERE stage = $1 AND ($2::boolean IS NULL OR recovered = $2)
          ORDER BY id DESC LIMIT 1`,
        [stage, recovered ?? null],
      );
      if (result.rows[0]) return result.rows[0];
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`timed out waiting for ${stage} checkpoint`);
  }

  async function insertTask(emailTo: string | null = null, fractional = false) {
    const due = new Date(Date.now() - 1_000);
    await pool.query(
      `INSERT INTO "${schema}".clio_scheduled_task (
         id, tenant_id, owner_user_id, name, prompt, interval_minutes,
         tool_allow_list, metadata_jsonb, next_run_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'runner crash fixture', 'controlled research', 1440,
         '[]'::jsonb, $4::jsonb,
         $5::timestamptz + CASE WHEN $6::boolean THEN interval '0.000456 second' ELSE interval '0' END
       )`,
      [
        task.id,
        task.tenantId,
        task.ownerUserId,
        JSON.stringify(emailTo ? { emailTo } : {}),
        due,
        fractional,
      ],
    );
  }

  async function expireLease() {
    await pool.query(
      `UPDATE "${schema}".clio_scheduled_task
          SET metadata_jsonb = jsonb_set(
                metadata_jsonb,
                '{scheduleExecution,leaseExpiresAt}',
                to_jsonb((clock_timestamp() - interval '1 second')::text),
                false
              )
        WHERE id = $1::uuid`,
      [task.id],
    );
  }

  async function counts() {
    const result = await pool.query<{ providers: number; emails: number; alerts: number }>(
      `SELECT
         (SELECT count(*)::int FROM "${schema}".controlled_effects WHERE kind = 'provider') AS providers,
         (SELECT count(*)::int FROM "${schema}".controlled_effects WHERE kind = 'email') AS emails,
         (SELECT count(*)::int FROM "${schema}".clio_proactive_alerts) AS alerts`,
    );
    return result.rows[0]!;
  }

  function executionTransaction(client: PoolClient) {
    return {
      client: { findFirst: async () => null },
      $queryRawUnsafe: async (sql: string, ...params: unknown[]) =>
        (await client.query(sql, params)).rows,
      $executeRawUnsafe: async (sql: string, ...params: unknown[]) =>
        (await client.query(sql, params)).rowCount ?? 0,
    };
  }

  async function withTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      const value = await fn(executionTransaction(client));
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  test('kill after exact fractional claim recovers before the future cadence without advancing it twice', async () => {
    await insertTask(null, true);
    const first = startRunner('claimed');
    const checkpoint = await waitForCheckpoint('claimed', false);
    expect(checkpoint.worker_pid).toBe(first.process.pid);
    const claimed = await pool.query<{
      next_run_at: string;
      last_status: string;
      scheduled_for: string;
    }>(
      `SELECT next_run_at::text AS next_run_at, last_status,
              metadata_jsonb #>> '{scheduleExecution,scheduledFor}' AS scheduled_for
         FROM "${schema}".clio_scheduled_task WHERE id = $1::uuid`,
      [task.id],
    );
    expect(claimed.rows[0]?.last_status).toBe('running');
    expect(claimed.rows[0]?.scheduled_for).toMatch(/\.\d{6}/);
    expect(new Date(claimed.rows[0]!.next_run_at).getTime()).toBeGreaterThan(Date.now());
    await terminateOwnedChild(first);
    await expireLease();

    await runToCompletion();
    const completed = await pool.query<{
      next_run_at: string;
      last_status: string;
      run_count: number;
      outcome: string;
    }>(
      `SELECT next_run_at::text AS next_run_at, last_status, run_count,
              metadata_jsonb #>> '{scheduleExecution,notification,outcome}' AS outcome
         FROM "${schema}".clio_scheduled_task WHERE id = $1::uuid`,
      [task.id],
    );
    expect(completed.rows[0]).toEqual({
      next_run_at: claimed.rows[0]!.next_run_at,
      last_status: 'ok',
      run_count: 1,
      outcome: 'not_requested',
    });
    expect(await counts()).toEqual({ providers: 1, emails: 0, alerts: 1 });
  }, 30_000);

  test('a malformed legacy expiry cannot crash or block another due runner row', async () => {
    const malformedId = '94444444-4444-4444-8444-444444444444';
    await pool.query(
      `INSERT INTO "${schema}".clio_scheduled_task (
         id, tenant_id, owner_user_id, name, prompt, interval_minutes,
         next_run_at, last_status, metadata_jsonb
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'malformed legacy', 'do not run', 1440,
         clock_timestamp() + interval '1 day', 'running',
         $4::jsonb
       )`,
      [
        malformedId,
        task.tenantId,
        task.ownerUserId,
        JSON.stringify({
          scheduleExecution: {
            version: 1,
            occurrenceId: '95555555-5555-4555-8555-555555555555',
            fence: '96666666-6666-4666-8666-666666666666',
            stage: 'claimed',
            leaseExpiresAt: 'malformed-legacy-expiry',
          },
        }),
      ],
    );
    await insertTask();

    const output = await runToCompletion();
    expect(output).toContain('CLIO_SCHEDULED_REPORT {"due":1,"delivered":1,"failed":0}');
    expect(await counts()).toEqual({ providers: 1, emails: 0, alerts: 1 });
    const rows = await pool.query<{ id: string; last_status: string; run_count: number }>(
      `SELECT id, last_status, run_count
         FROM "${schema}".clio_scheduled_task
        ORDER BY id`,
    );
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        { id: task.id, last_status: 'ok', run_count: 1 },
        { id: malformedId, last_status: 'running', run_count: 0 },
      ]),
    );
  }, 30_000);

  test('kill after saved result restarts without another provider effect or alert', async () => {
    await insertTask();
    const first = startRunner('result_saved');
    const checkpoint = await waitForCheckpoint('result_saved');
    expect(checkpoint.worker_pid).toBe(first.process.pid);
    expect(await counts()).toEqual({ providers: 1, emails: 0, alerts: 1 });
    await terminateOwnedChild(first);
    await expireLease();

    await runToCompletion();
    expect(await counts()).toEqual({ providers: 1, emails: 0, alerts: 1 });
    const row = await pool.query<{ last_status: string; run_count: number }>(
      `SELECT last_status, run_count FROM "${schema}".clio_scheduled_task WHERE id = $1::uuid`,
      [task.id],
    );
    expect(row.rows[0]).toEqual({ last_status: 'ok', run_count: 1 });
  }, 30_000);

  test('kill after possible email acceptance records unknown and never resends', async () => {
    await insertTask('owner@example.test');
    const first = startRunner('email_effect');
    const checkpoint = await waitForCheckpoint('email_effect');
    expect(checkpoint.worker_pid).toBe(first.process.pid);
    expect(await counts()).toEqual({ providers: 1, emails: 1, alerts: 1 });
    await terminateOwnedChild(first);
    await expireLease();

    await runToCompletion();
    expect(await counts()).toEqual({ providers: 1, emails: 1, alerts: 1 });
    const row = await pool.query<{
      last_status: string;
      run_count: number;
      task_outcome: string;
      alert_outcome: string;
      started_at: string;
      confirmed_at: string | null;
    }>(
      `SELECT st.last_status, st.run_count,
              st.metadata_jsonb #>> '{scheduleExecution,notification,outcome}' AS task_outcome,
              a.metadata_jsonb ->> 'notificationOutcome' AS alert_outcome,
              st.metadata_jsonb #>> '{scheduleExecution,notification,startedAt}' AS started_at,
              st.metadata_jsonb #>> '{scheduleExecution,notification,confirmedAt}' AS confirmed_at
         FROM "${schema}".clio_scheduled_task st
         JOIN "${schema}".clio_proactive_alerts a
           ON a.id::text = st.metadata_jsonb #>> '{scheduleExecution,result,alertId}'
        WHERE st.id = $1::uuid`,
      [task.id],
    );
    expect(row.rows[0]).toMatchObject({
      last_status: 'notification_unknown',
      run_count: 1,
      task_outcome: 'unknown',
      alert_outcome: 'unknown',
      started_at: expect.any(String),
      confirmed_at: null,
    });
  }, 30_000);

  test('a recovered runner fence prevents the killed child fence from committing', async () => {
    await insertTask();
    const first = startRunner('claimed');
    await waitForCheckpoint('claimed', false);
    const oldRow = await pool.query<{ metadata_jsonb: unknown }>(
      `SELECT metadata_jsonb FROM "${schema}".clio_scheduled_task WHERE id = $1::uuid`,
      [task.id],
    );
    const oldReceipt = parseScheduledTaskDurableReceipt(oldRow.rows[0]?.metadata_jsonb);
    expect(oldReceipt).not.toBeNull();
    await terminateOwnedChild(first);
    await expireLease();

    const recovered = startRunner('claimed_recovered');
    const current = await waitForCheckpoint('claimed', true);
    expect(current.worker_pid).toBe(recovered.process.pid);
    expect(current.fence).not.toBe(oldReceipt!.fence);
    const oldClaim: ScheduledTaskExecutionClaim = {
      claimedAt: new Date(oldReceipt!.claimedAt),
      nextRunAt: new Date(oldReceipt!.nextRunAt),
      occurrenceId: oldReceipt!.occurrenceId,
      fence: oldReceipt!.fence,
      receipt: oldReceipt!,
      recovered: false,
    };
    await expect(
      withTransaction((tx) => advanceScheduledTaskExecution(tx, task, oldClaim, 'error')),
    ).resolves.toBe(false);
    const row = await pool.query<{ last_status: string; run_count: number; fence: string }>(
      `SELECT last_status, run_count,
              metadata_jsonb #>> '{scheduleExecution,fence}' AS fence
         FROM "${schema}".clio_scheduled_task WHERE id = $1::uuid`,
      [task.id],
    );
    expect(row.rows[0]).toEqual({ last_status: 'running', run_count: 0, fence: current.fence });
    expect(await counts()).toEqual({ providers: 0, emails: 0, alerts: 0 });
    await terminateOwnedChild(recovered);
  }, 30_000);
});
