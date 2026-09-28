import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import type { TenantContext } from '@capiro/shared';
import { MeriToolsService } from './meri-tools.service.js';
import {
  advanceScheduledTaskExecution,
  checkScheduledTaskExecutionBoundary,
  claimScheduledTaskExecution,
  executeScheduledTaskEffect,
} from './meri-schedule-execution-boundary.js';

jest.mock('../program-element/program-element-read.service.js', () => ({
  ProgramElementReadService: class {},
}));
jest.mock('./meri-defense-budget-tool.helpers.js', () => ({}));

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
} as TenantContext;
const PROPOSAL = '33333333-3333-4333-8333-333333333333';
const input = {
  name: 'Native PostgreSQL watch',
  prompt: 'Read the latest authorized sources.',
  intervalMinutes: 60,
  toolAllowList: ['search_crs_reports', 'query_intelligence'],
};

type ScheduleTask = (
  actor: TenantContext,
  value: Record<string, unknown>,
  actionProposalId?: string,
) => Promise<Record<string, any>>;

type LocalPostgresConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  scope: string;
};

const configuredPath = process.env.MERI_SCHEDULER_POSTGRES_CONFIG;
const defaultPath = resolve(
  process.cwd(),
  '../../../cap-meri-foundation-evidence/private/local-postgres.json',
);
const configPath = configuredPath || defaultPath;
const describeLocal = existsSync(configPath) ? describe : describe.skip;

/**
 * Native PostgreSQL boundary proof for the production schedule handler.
 *
 * The adapter below intentionally mirrors only the Prisma methods used by
 * scheduleTask. Every withTenant call is a real, separate PostgreSQL
 * transaction. This proves PK conflict/failed-transaction/fresh-read behavior;
 * it is not represented as full Prisma middleware or RLS integration proof.
 */
describeLocal('Meri schedule handler — native PostgreSQL receipt boundary', () => {
  let pool: Pool;
  let schemaName: string;

  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as LocalPostgresConfig;

    // Fail before the first write unless this is the explicitly supplied local
    // task database and the credential declares a user. Never fall back to
    // DATABASE_URL or print any credential field.
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(55433);
    expect(typeof config.user).toBe('string');
    expect(config.user.length).toBeGreaterThan(0);
    expect(typeof config.scope).toBe('string');
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
      user_matches: boolean;
      server_addr: string;
      server_port: number;
    }>(
      `SELECT current_user = $1 AS user_matches,
              host(inet_server_addr()) AS server_addr,
              inet_server_port() AS server_port`,
      [config.user],
    );
    expect(identity.rows[0]).toMatchObject({
      user_matches: true,
      server_addr: '127.0.0.1',
      server_port: 55433,
    });

    schemaName = `meri_scheduler_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
    const ownership = await pool.query<{ owned: boolean }>(
      `SELECT pg_get_userbyid(nspowner) = current_user AS owned
         FROM pg_namespace
        WHERE nspname = $1`,
      [schemaName],
    );
    expect(ownership.rows[0]?.owned).toBe(true);
    await pool.query(`
      CREATE TABLE "${schemaName}".clio_scheduled_task (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        owner_user_id uuid NOT NULL,
        scope text NOT NULL,
        name varchar(200) NOT NULL,
        prompt text NOT NULL,
        interval_minutes integer NOT NULL,
        tool_allow_list jsonb NOT NULL DEFAULT '[]'::jsonb,
        last_run_at timestamptz,
        next_run_at timestamptz NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        last_status varchar(20),
        run_count integer NOT NULL DEFAULT 0,
        created_by varchar(40) NOT NULL,
        metadata_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }, 30_000);

  afterEach(async () => {
    if (pool && schemaName) {
      await pool.query(`TRUNCATE TABLE "${schemaName}".clio_scheduled_task`);
    }
  });

  afterAll(async () => {
    if (pool && schemaName) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
    if (pool) await pool.end();
  });

  function harness(options: {
    barrier?: boolean;
    ackLoss?: boolean;
    cancelAfterAckLoss?: boolean;
  } = {}) {
    let initialReads = 0;
    let releaseInitialReads: () => void = () => undefined;
    const initialReadGate = new Promise<void>((resolveGate) => {
      releaseInitialReads = resolveGate;
    });
    let ackLost = false;
    let failureObserved = false;
    const evidence = {
      insertAttempts: 0,
      uniqueViolations: 0,
      failedTransactionState: 0,
      freshReadsAfterFailure: 0,
      transactions: 0,
    };

    const prisma = {
      withTenant: async (_tenantId: string, fn: (tx: any) => Promise<any>) => {
        evidence.transactions += 1;
        const client = await pool.connect();
        let createdInTransaction = false;
        try {
          await client.query('BEGIN');
          await client.query(`SET LOCAL search_path TO "${schemaName}"`);
          const tx = {
            clioScheduledTask: {
              findFirst: async ({ where }: { where: Record<string, any> }) => {
                const result = await client.query(
                  `SELECT id, tenant_id, owner_user_id, scope, name, prompt,
                          interval_minutes, tool_allow_list, next_run_at, enabled,
                          last_status, created_by, metadata_jsonb
                     FROM clio_scheduled_task
                    WHERE id = $1::uuid AND tenant_id = $2::uuid
                      AND owner_user_id = $3::uuid AND scope = $4
                    LIMIT 1`,
                  [where.id, where.tenantId, where.ownerUserId, where.scope],
                );
                if (failureObserved) evidence.freshReadsAfterFailure += 1;
                if (options.barrier && result.rows.length === 0 && initialReads < 2) {
                  initialReads += 1;
                  if (initialReads === 2) releaseInitialReads();
                  await initialReadGate;
                }
                const row = result.rows[0];
                return row
                  ? {
                      id: row.id,
                      tenantId: row.tenant_id,
                      ownerUserId: row.owner_user_id,
                      scope: row.scope,
                      name: row.name,
                      prompt: row.prompt,
                      intervalMinutes: row.interval_minutes,
                      toolAllowList: row.tool_allow_list,
                      nextRunAt: row.next_run_at,
                      enabled: row.enabled,
                      lastStatus: row.last_status,
                      createdBy: row.created_by,
                      metadata: row.metadata_jsonb,
                    }
                  : null;
              },
              findMany: async () => [],
              count: async ({ where }: { where: Record<string, unknown> }) => {
                const result = await client.query<{ count: string }>(
                  `SELECT count(*)::text AS count
                     FROM clio_scheduled_task
                    WHERE tenant_id = $1::uuid AND owner_user_id = $2::uuid`,
                  [where.tenantId, where.ownerUserId],
                );
                return Number(result.rows[0]?.count ?? 0);
              },
              create: async ({ data }: { data: Record<string, any> }) => {
                evidence.insertAttempts += 1;
                const result = await client.query(
                  `INSERT INTO clio_scheduled_task (
                     id, tenant_id, owner_user_id, scope, name, prompt,
                     interval_minutes, tool_allow_list, next_run_at, created_by,
                     metadata_jsonb
                   ) VALUES (
                     $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
                     $7, $8::jsonb, $9, $10, $11::jsonb
                   )
                   RETURNING id, name, interval_minutes, next_run_at, enabled, last_status`,
                  [
                    data.id,
                    data.tenantId,
                    data.ownerUserId,
                    data.scope,
                    data.name,
                    data.prompt,
                    data.intervalMinutes,
                    JSON.stringify(data.toolAllowList),
                    data.nextRunAt,
                    data.createdBy,
                    JSON.stringify(data.metadata),
                  ],
                );
                createdInTransaction = true;
                const row = result.rows[0];
                return {
                  id: row.id,
                  name: row.name,
                  intervalMinutes: row.interval_minutes,
                  nextRunAt: row.next_run_at,
                  enabled: row.enabled,
                  lastStatus: row.last_status,
                };
              },
            },
          };
          const value = await fn(tx);
          await client.query('COMMIT');
          if (options.ackLoss && createdInTransaction && !ackLost) {
            ackLost = true;
            failureObserved = true;
            if (options.cancelAfterAckLoss) {
              await pool.query(
                `UPDATE "${schemaName}".clio_scheduled_task
                    SET enabled = false, last_status = 'canceled'
                  WHERE id = $1::uuid`,
                [PROPOSAL],
              );
            }
            throw new Error('simulated acknowledgement loss after COMMIT');
          }
          return value;
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === '23505') {
            evidence.uniqueViolations += 1;
            failureObserved = true;
            try {
              await client.query('SELECT 1');
            } catch (failedTransaction) {
              if ((failedTransaction as { code?: string }).code === '25P02') {
                evidence.failedTransactionState += 1;
              }
            }
          }
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    };
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    (service as unknown as { prisma: unknown }).prisma = prisma;
    const scheduleTask = (service as unknown as { scheduleTask: ScheduleTask }).scheduleTask.bind(
      service,
    );
    return { scheduleTask, evidence };
  }

  function executionTransaction(client: PoolClient) {
    return {
      clioScheduledTask: {
        findFirst: async ({ where }: { where: Record<string, any> }) => {
          const result = await client.query(
            `SELECT metadata_jsonb
               FROM clio_scheduled_task
              WHERE id = $1::uuid AND tenant_id = $2::uuid AND owner_user_id = $3::uuid
                AND enabled = true
                AND ($4::text IS NULL OR last_status = $4)
                AND ($5::timestamptz IS NULL OR last_run_at = $5)
                AND ($6::timestamptz IS NULL OR updated_at = $6)
              LIMIT 1`,
            [
              where.id,
              where.tenantId,
              where.ownerUserId,
              where.lastStatus ?? null,
              where.lastRunAt ?? null,
              where.updatedAt ?? null,
            ],
          );
          return result.rows[0] ? { metadata: result.rows[0].metadata_jsonb } : null;
        },
      },
      client: { findFirst: async () => null },
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) =>
        (await client.query(sql, args)).rows,
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) =>
        (await client.query(sql, args)).rowCount ?? 0,
    };
  }

  async function withExecutionTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO "${schemaName}"`);
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

  async function insertDueExecutionTask() {
    await pool.query(
      `INSERT INTO "${schemaName}".clio_scheduled_task (
         id, tenant_id, owner_user_id, scope, name, prompt, interval_minutes,
         next_run_at, created_by
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'user_private', 'race', 'race', 60, $4, 'meri')`,
      [PROPOSAL, ctx.tenantId, ctx.userId, new Date('2026-09-28T10:00:00.000Z')],
    );
  }

  test('real PK race aborts the loser transaction and fresh scoped read converges one receipt', async () => {
    const h = harness({ barrier: true });

    const [first, second] = await Promise.all([
      h.scheduleTask(ctx, input, PROPOSAL),
      h.scheduleTask(ctx, input, PROPOSAL),
    ]);

    expect(first).toMatchObject({ creationConfirmed: true, task: { id: PROPOSAL } });
    expect(second).toMatchObject({ creationConfirmed: true, task: { id: PROPOSAL } });
    expect([first, second].filter((value) => value.reconciled === true)).toHaveLength(1);
    const stored = await pool.query<{ id: string }>(
      `SELECT id FROM "${schemaName}".clio_scheduled_task WHERE id = $1::uuid`,
      [PROPOSAL],
    );
    expect(stored.rows).toEqual([{ id: PROPOSAL }]);
    expect(h.evidence).toMatchObject({
      insertAttempts: 2,
      uniqueViolations: 1,
      failedTransactionState: 1,
    });
    expect(h.evidence.freshReadsAfterFailure).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test('commit then acknowledgement loss fresh-reads the original receipt without duplicate insert', async () => {
    const h = harness({ ackLoss: true });

    const recovered = await h.scheduleTask(ctx, input, PROPOSAL);

    expect(recovered).toMatchObject({
      scheduled: true,
      active: true,
      creationConfirmed: true,
      reconciled: true,
      task: { id: PROPOSAL },
    });
    const stored = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM "${schemaName}".clio_scheduled_task
        WHERE id = $1::uuid`,
      [PROPOSAL],
    );
    expect(stored.rows[0]?.count).toBe('1');
    expect(h.evidence.insertAttempts).toBe(1);
    expect(h.evidence.uniqueViolations).toBe(0);
    expect(h.evidence.freshReadsAfterFailure).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test('commit then lost acknowledgement then cancellation fresh-reads inactive historical receipt', async () => {
    const h = harness({ ackLoss: true, cancelAfterAckLoss: true });

    const recovered = await h.scheduleTask(ctx, input, PROPOSAL);

    expect(recovered).toMatchObject({
      scheduled: false,
      active: false,
      creationConfirmed: true,
      reconciled: true,
      task: {
        id: PROPOSAL,
        enabled: false,
        lastStatus: 'canceled',
        active: false,
        creationConfirmed: true,
      },
    });
    const stored = await pool.query<{
      count: string;
      enabled: boolean;
      last_status: string | null;
    }>(
      `SELECT count(*)::text AS count,
              bool_and(enabled) AS enabled,
              min(last_status) AS last_status
         FROM "${schemaName}".clio_scheduled_task
        WHERE id = $1::uuid`,
      [PROPOSAL],
    );
    expect(stored.rows[0]).toEqual({ count: '1', enabled: false, last_status: 'canceled' });
    expect(h.evidence.insertAttempts).toBe(1);
    expect(h.evidence.freshReadsAfterFailure).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test('two native PostgreSQL runners atomically claim one occurrence and reach one sink', async () => {
    await insertDueExecutionTask();
    const sink = jest.fn();
    const identity = { id: PROPOSAL, tenantId: ctx.tenantId, ownerUserId: ctx.userId };
    const claimedAt = new Date('2026-09-28T10:00:00.000Z');
    const nextRunAt = new Date('2026-09-28T11:00:00.000Z');
    const run = () => withExecutionTransaction(async (tx) => {
      const result = await claimScheduledTaskExecution(tx, identity, claimedAt, nextRunAt);
      if (result.state !== 'claimed') return result.state;
      const effect = await executeScheduledTaskEffect(
        async () => 'runnable',
        async () => sink(),
      );
      expect(effect.executed).toBe(true);
      await expect(
        advanceScheduledTaskExecution(tx, identity, result.claim, 'ok'),
      ).resolves.toBe(true);
      return 'completed';
    });

    await expect(Promise.all([run(), run()])).resolves.toEqual(
      expect.arrayContaining(['completed', 'inactive']),
    );
    expect(sink).toHaveBeenCalledTimes(1);
    const stored = await pool.query<{
      enabled: boolean;
      last_status: string;
      run_count: number;
      next_run_at: Date;
    }>(
      `SELECT enabled, last_status, run_count, next_run_at
         FROM "${schemaName}".clio_scheduled_task WHERE id = $1::uuid`,
      [PROPOSAL],
    );
    expect(stored.rows[0]).toMatchObject({ enabled: true, last_status: 'ok', run_count: 1 });
    expect(stored.rows[0]?.next_run_at).toEqual(nextRunAt);
  }, 30_000);

  test('native next-cadence claim fails closed while the prior controlled effect is active', async () => {
    await insertDueExecutionTask();
    const sink = jest.fn(async () => 'started');
    const identity = { id: PROPOSAL, tenantId: ctx.tenantId, ownerUserId: ctx.userId };
    const first = await withExecutionTransaction((tx) =>
      claimScheduledTaskExecution(
        tx,
        identity,
        new Date('2026-09-28T10:00:00.000Z'),
        new Date('2026-09-28T11:00:00.000Z'),
      ),
    );
    expect(first.state).toBe('claimed');
    if (first.state !== 'claimed') throw new Error('expected first claim');
    await expect(withExecutionTransaction((tx) => executeScheduledTaskEffect(
      () => checkScheduledTaskExecutionBoundary(tx, identity, first.claim),
      sink,
    ))).resolves.toEqual({ executed: true, value: 'started' });

    await expect(withExecutionTransaction((tx) =>
      claimScheduledTaskExecution(
        tx,
        identity,
        new Date('2026-09-28T11:00:00.000Z'),
        new Date('2026-09-28T12:00:00.000Z'),
      ),
    )).resolves.toEqual({ state: 'already_running' });
    expect(sink).toHaveBeenCalledTimes(1);
    const running = await pool.query<{
      last_status: string;
      run_count: number;
      next_run_at: Date;
    }>(
      `SELECT last_status, run_count, next_run_at
         FROM "${schemaName}".clio_scheduled_task WHERE id = $1::uuid`,
      [PROPOSAL],
    );
    expect(running.rows[0]).toEqual({
      last_status: 'running',
      run_count: 0,
      next_run_at: new Date('2026-09-28T11:00:00.000Z'),
    });
    await expect(withExecutionTransaction((tx) =>
      advanceScheduledTaskExecution(tx, identity, first.claim, 'ok'),
    )).resolves.toBe(true);
  }, 30_000);

  test('native cancellation after claim defeats fenced completion and retains canceled status', async () => {
    await insertDueExecutionTask();
    const identity = { id: PROPOSAL, tenantId: ctx.tenantId, ownerUserId: ctx.userId };
    const claim = await withExecutionTransaction((tx) =>
      claimScheduledTaskExecution(
        tx,
        identity,
        new Date('2026-09-28T10:00:00.000Z'),
        new Date('2026-09-28T11:00:00.000Z'),
      ),
    );
    expect(claim.state).toBe('claimed');
    if (claim.state !== 'claimed') throw new Error('expected claim');
    await pool.query(
      `UPDATE "${schemaName}".clio_scheduled_task
          SET enabled = false, last_status = 'canceled', updated_at = clock_timestamp()
        WHERE id = $1::uuid`,
      [PROPOSAL],
    );

    await expect(withExecutionTransaction((tx) =>
      advanceScheduledTaskExecution(tx, identity, claim.claim, 'ok'),
    )).resolves.toBe(false);
    const stored = await pool.query<{
      enabled: boolean;
      last_status: string;
      run_count: number;
    }>(
      `SELECT enabled, last_status, run_count
         FROM "${schemaName}".clio_scheduled_task WHERE id = $1::uuid`,
      [PROPOSAL],
    );
    expect(stored.rows[0]).toEqual({ enabled: false, last_status: 'canceled', run_count: 0 });
  }, 30_000);
});
