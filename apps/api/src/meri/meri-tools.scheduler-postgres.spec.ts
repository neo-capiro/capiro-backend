import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { TenantContext } from '@capiro/shared';
import { MeriToolsService } from './meri-tools.service.js';
import {
  advanceScheduledTaskExecution,
  beginScheduledTaskEmailDispatch,
  checkScheduledTaskExecutionBoundary,
  claimScheduledTaskExecution,
  executeScheduledTaskEffect,
  markScheduledTaskResearchStarted,
  parseScheduledTaskDurableReceipt,
  persistScheduledTaskResultAndAlert,
  readScheduledTaskSavedResult,
  reconcileScheduledTaskClaim,
  recordScheduledTaskEmailOutcome,
  renewScheduledTaskExecutionLease,
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

const configPath = 'C:/dev/cap-meri-foundation-evidence/private/local-postgres.json';

/**
 * Native PostgreSQL boundary proof for the production schedule handler.
 *
 * The adapter below intentionally mirrors only the Prisma methods used by
 * scheduleTask. Every withTenant call is a real, separate PostgreSQL
 * transaction. This proves PK conflict/failed-transaction/fresh-read behavior;
 * it is not represented as full Prisma middleware or RLS integration proof.
 */
describe('Meri schedule handler — native PostgreSQL receipt boundary', () => {
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
      );
      CREATE TABLE "${schemaName}".tenants (
        id uuid PRIMARY KEY,
        status text NOT NULL,
        slug text NOT NULL
      );
      CREATE TABLE "${schemaName}".users (
        id uuid PRIMARY KEY,
        clerk_user_id text NOT NULL
      );
      CREATE TABLE "${schemaName}".tenant_memberships (
        tenant_id uuid NOT NULL,
        user_id uuid NOT NULL,
        role text NOT NULL,
        status text NOT NULL,
        PRIMARY KEY (tenant_id, user_id)
      );
      CREATE TABLE "${schemaName}".clients (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        status text NOT NULL DEFAULT 'active',
        memory_wall boolean NOT NULL DEFAULT false
      );
      CREATE TABLE "${schemaName}".client_memory_access (
        tenant_id uuid NOT NULL,
        client_id uuid NOT NULL,
        user_id uuid NOT NULL,
        PRIMARY KEY (tenant_id, client_id, user_id)
      );
      CREATE TABLE "${schemaName}".clio_proactive_alerts (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        owner_user_id uuid,
        alert_type text NOT NULL,
        title text NOT NULL,
        body text NOT NULL,
        priority text NOT NULL DEFAULT 'normal',
        status text NOT NULL DEFAULT 'pending',
        source_type text,
        source_id text,
        metadata_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO "${schemaName}".tenants (id, status, slug)
        VALUES ('${ctx.tenantId}', 'active', 'native-tenant');
      INSERT INTO "${schemaName}".users (id, clerk_user_id)
        VALUES ('${ctx.userId}', 'clerk-native-owner');
      INSERT INTO "${schemaName}".tenant_memberships (tenant_id, user_id, role, status)
        VALUES ('${ctx.tenantId}', '${ctx.userId}', 'standard_user', 'active')
    `);
  }, 30_000);

  afterEach(async () => {
    if (pool && schemaName) {
      await pool.query(`
        TRUNCATE TABLE "${schemaName}".clio_scheduled_task,
                       "${schemaName}".clio_proactive_alerts,
                       "${schemaName}".clients,
                       "${schemaName}".client_memory_access;
        UPDATE "${schemaName}".tenant_memberships
           SET status = 'active', role = 'standard_user';
        UPDATE "${schemaName}".tenants SET status = 'active';
      `);
    }
  });

  afterAll(async () => {
    if (pool && schemaName) {
      const ownership = await pool.query<{ owned: boolean }>(
        `SELECT pg_get_userbyid(nspowner) = current_user AS owned
           FROM pg_namespace
          WHERE nspname = $1`,
        [schemaName],
      );
      if (ownership.rows[0]?.owned !== true) {
        throw new Error('refusing to drop an unowned scheduler fixture schema');
      }
      await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    }
    if (pool) await pool.end();
  });

  function harness(
    options: {
      barrier?: boolean;
      ackLoss?: boolean;
      cancelAfterAckLoss?: boolean;
    } = {},
  ) {
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
      client: {
        findFirst: async ({ where }: { where: Record<string, any> }) => {
          const result = await client.query(
            `SELECT id
               FROM clients
              WHERE id = $1::uuid AND tenant_id = $2::uuid AND status <> 'archived'
              LIMIT 1`,
            [where.id, where.tenantId],
          );
          return result.rows[0] ?? null;
        },
      },
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) =>
        (await client.query(sql, args)).rows,
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) =>
        (await client.query(sql, args)).rowCount ?? 0,
    };
  }

  async function withExecutionTransaction<T>(
    fn: (tx: any) => Promise<T>,
    options: { loseAck?: boolean } = {},
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO "${schemaName}"`);
      const value = await fn(executionTransaction(client));
      await client.query('COMMIT');
      if (options.loseAck) throw new Error('simulated acknowledgement loss after COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function insertDueExecutionTask(dueAt: Date, metadata: Record<string, unknown> = {}) {
    await pool.query(
      `INSERT INTO "${schemaName}".clio_scheduled_task (
         id, tenant_id, owner_user_id, scope, name, prompt, interval_minutes,
         next_run_at, created_by, metadata_jsonb
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'user_private', 'race', 'race', 60,
         $4, 'meri', $5::jsonb
       )`,
      [PROPOSAL, ctx.tenantId, ctx.userId, dueAt, JSON.stringify(metadata)],
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

  const identity = { id: PROPOSAL, tenantId: ctx.tenantId, ownerUserId: ctx.userId };

  function times() {
    const claimedAt = new Date();
    const scheduledFor = new Date(claimedAt.getTime() - 1_000);
    const nextRunAt = new Date(claimedAt.getTime() + 60 * 60_000);
    return { claimedAt, scheduledFor, nextRunAt };
  }

  async function claimFresh(notificationRecipient: string | null = null) {
    const value = times();
    await insertDueExecutionTask(
      value.scheduledFor,
      notificationRecipient ? { emailTo: notificationRecipient } : {},
    );
    const result = await withExecutionTransaction((tx) =>
      claimScheduledTaskExecution(
        tx,
        identity,
        value.claimedAt,
        value.nextRunAt,
        value.scheduledFor,
        notificationRecipient,
      ),
    );
    expect(result.state).toBe('claimed');
    if (result.state !== 'claimed') throw new Error('expected claim');
    return { ...value, claim: result.claim };
  }

  async function saveResult(claim: Awaited<ReturnType<typeof claimFresh>>['claim']) {
    await expect(
      withExecutionTransaction((tx) => markScheduledTaskResearchStarted(tx, identity, claim)),
    ).resolves.toBe(true);
    await withExecutionTransaction((tx) =>
      persistScheduledTaskResultAndAlert(tx, identity, claim, {
        taskName: 'race',
        text: 'saved briefing',
        toolsUsed: ['query_intelligence'],
      }),
    );
    const saved = await withExecutionTransaction((tx) =>
      readScheduledTaskSavedResult(tx, identity, claim),
    );
    expect(saved).toMatchObject({ text: 'saved briefing', toolsUsed: ['query_intelligence'] });
    return saved!;
  }

  async function expireLease() {
    await pool.query(
      `UPDATE "${schemaName}".clio_scheduled_task
          SET metadata_jsonb = jsonb_set(
                metadata_jsonb,
                '{scheduleExecution,leaseExpiresAt}',
                to_jsonb((clock_timestamp() - interval '1 second')::text),
                false
              )
        WHERE id = $1::uuid`,
      [PROPOSAL],
    );
  }

  test('two native PostgreSQL workers claim one occurrence and only one reaches the sink', async () => {
    const value = times();
    await insertDueExecutionTask(value.scheduledFor);
    const run = () =>
      withExecutionTransaction((tx) =>
        claimScheduledTaskExecution(
          tx,
          identity,
          value.claimedAt,
          value.nextRunAt,
          value.scheduledFor,
        ),
      );
    const claims = await Promise.all([run(), run()]);
    expect(claims.map((entry) => entry.state).sort()).toEqual(['already_running', 'claimed']);
    const winner = claims.find((entry) => entry.state === 'claimed');
    if (!winner || winner.state !== 'claimed') throw new Error('expected claim winner');
    const sink = jest.fn(async () => 'controlled');

    await expect(
      withExecutionTransaction((tx) =>
        executeScheduledTaskEffect(
          () => checkScheduledTaskExecutionBoundary(tx, identity, winner.claim),
          sink,
        ),
      ),
    ).resolves.toEqual({ executed: true, value: 'controlled' });
    expect(sink).toHaveBeenCalledTimes(1);
  }, 30_000);

  test('claims the exact six-digit PostgreSQL due token without rounding through Date', async () => {
    const claimedAt = new Date();
    const roundedDue = new Date(claimedAt.getTime() - 1_000);
    await pool.query(
      `INSERT INTO "${schemaName}".clio_scheduled_task (
         id, tenant_id, owner_user_id, scope, name, prompt, interval_minutes,
         next_run_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'user_private', 'fractional', 'fractional', 60,
         $4::timestamptz + interval '0.000456 second', 'meri'
       )`,
      [PROPOSAL, ctx.tenantId, ctx.userId, roundedDue],
    );
    const observed = await pool.query<{ next_run_at: Date; exact: string }>(
      `SELECT next_run_at, next_run_at::text AS exact
         FROM "${schemaName}".clio_scheduled_task
        WHERE id = $1::uuid`,
      [PROPOSAL],
    );
    expect(observed.rows[0]?.exact).toMatch(/\.\d{6}/);
    const nextRunAt = new Date(claimedAt.getTime() + 60 * 60_000);
    await expect(
      withExecutionTransaction((tx) =>
        claimScheduledTaskExecution(
          tx,
          identity,
          claimedAt,
          nextRunAt,
          observed.rows[0]!.next_run_at,
        ),
      ),
    ).resolves.toEqual({ state: 'inactive' });

    const exact = await withExecutionTransaction((tx) =>
      claimScheduledTaskExecution(tx, identity, claimedAt, nextRunAt, observed.rows[0]!.exact),
    );
    expect(exact.state).toBe('claimed');
    if (exact.state !== 'claimed') throw new Error('expected exact fractional claim');
    expect(exact.claim.receipt.scheduledFor).toBe(observed.rows[0]!.exact);
  }, 30_000);

  test('does not start the next cadence while the prior fence owns a live lease', async () => {
    const first = await claimFresh();
    const nextCadence = new Date(first.nextRunAt.getTime() + 1_000);
    await pool.query(
      `UPDATE "${schemaName}".clio_scheduled_task
          SET metadata_jsonb = jsonb_set(
                metadata_jsonb,
                '{scheduleExecution,leaseExpiresAt}',
                to_jsonb(($2::timestamptz + interval '120 seconds')::text),
                false
              )
        WHERE id = $1::uuid`,
      [PROPOSAL, nextCadence],
    );
    await expect(
      withExecutionTransaction((tx) =>
        claimScheduledTaskExecution(
          tx,
          identity,
          nextCadence,
          new Date(nextCadence.getTime() + 60 * 60_000),
          first.nextRunAt,
          null,
          { occurrenceId: first.claim.occurrenceId, fence: first.claim.fence },
        ),
      ),
    ).resolves.toEqual({ state: 'already_running' });
    const stored = await pool.query<{ last_status: string; run_count: number; next_run_at: Date }>(
      `SELECT last_status, run_count, next_run_at
         FROM "${schemaName}".clio_scheduled_task
        WHERE id = $1::uuid`,
      [PROPOSAL],
    );
    expect(stored.rows[0]).toEqual({
      last_status: 'running',
      run_count: 0,
      next_run_at: first.nextRunAt,
    });
  }, 30_000);

  test('heartbeat renews the exact lease and a stale fence cannot renew', async () => {
    const { claim } = await claimFresh();
    const heartbeatAt = new Date(Date.now() + 5_000);
    await expect(
      withExecutionTransaction((tx) =>
        renewScheduledTaskExecutionLease(tx, identity, claim, heartbeatAt),
      ),
    ).resolves.toBe(true);
    const row = await pool.query<{ metadata_jsonb: Record<string, unknown> }>(
      `SELECT metadata_jsonb FROM "${schemaName}".clio_scheduled_task WHERE id = $1::uuid`,
      [PROPOSAL],
    );
    const renewed = parseScheduledTaskDurableReceipt(row.rows[0]?.metadata_jsonb);
    expect(renewed?.heartbeatAt).toBe(heartbeatAt.toISOString());
    await expect(
      withExecutionTransaction((tx) =>
        renewScheduledTaskExecutionLease(
          tx,
          identity,
          { ...claim, fence: '77777777-7777-4777-8777-777777777777' },
          new Date(),
        ),
      ),
    ).resolves.toBe(false);
  }, 30_000);

  test('expired pre-effect claims retry boundedly with a new fence and reject stale completion', async () => {
    const first = await claimFresh();
    await expireLease();
    const secondResult = await withExecutionTransaction((tx) =>
      claimScheduledTaskExecution(
        tx,
        identity,
        new Date(),
        first.nextRunAt,
        first.nextRunAt,
        null,
        { occurrenceId: first.claim.occurrenceId, fence: first.claim.fence },
      ),
    );
    expect(secondResult.state).toBe('claimed');
    if (secondResult.state !== 'claimed') throw new Error('expected recovered claim');
    expect(secondResult.claim).toMatchObject({ recovered: true });
    expect(secondResult.claim.fence).not.toBe(first.claim.fence);
    await expect(
      withExecutionTransaction((tx) =>
        advanceScheduledTaskExecution(tx, identity, first.claim, 'ok'),
      ),
    ).resolves.toBe(false);

    await expireLease();
    const thirdResult = await withExecutionTransaction((tx) =>
      claimScheduledTaskExecution(
        tx,
        identity,
        new Date(),
        first.nextRunAt,
        first.nextRunAt,
        null,
        { occurrenceId: secondResult.claim.occurrenceId, fence: secondResult.claim.fence },
      ),
    );
    expect(thirdResult.state).toBe('claimed');
    if (thirdResult.state !== 'claimed') throw new Error('expected third bounded claim');
    expect(thirdResult.claim.receipt.attempt).toBe(3);
    await expireLease();
    await expect(
      withExecutionTransaction((tx) =>
        claimScheduledTaskExecution(
          tx,
          identity,
          new Date(),
          first.nextRunAt,
          first.nextRunAt,
          null,
          { occurrenceId: thirdResult.claim.occurrenceId, fence: thirdResult.claim.fence },
        ),
      ),
    ).resolves.toMatchObject({ state: 'ambiguous_effect', stage: 'recovery_unknown' });
  }, 30_000);

  test('lost claim COMMIT acknowledgement reconciles the exact durable occurrence', async () => {
    const value = times();
    await insertDueExecutionTask(value.scheduledFor);
    await expect(
      withExecutionTransaction(
        (tx) =>
          claimScheduledTaskExecution(
            tx,
            identity,
            value.claimedAt,
            value.nextRunAt,
            value.scheduledFor,
          ),
        { loseAck: true },
      ),
    ).rejects.toThrow('acknowledgement loss');

    const reconciled = await withExecutionTransaction((tx) =>
      reconcileScheduledTaskClaim(tx, identity, value.claimedAt, value.scheduledFor),
    );
    expect(reconciled).toMatchObject({ claimedAt: value.claimedAt, recovered: false });
  }, 30_000);

  test('lost alert/result commit acknowledgement fresh-reads one atomic result receipt', async () => {
    const { claim } = await claimFresh();
    await withExecutionTransaction((tx) => markScheduledTaskResearchStarted(tx, identity, claim));
    await expect(
      withExecutionTransaction(
        (tx) =>
          persistScheduledTaskResultAndAlert(tx, identity, claim, {
            taskName: 'race',
            text: 'atomic saved result',
            toolsUsed: [],
          }),
        { loseAck: true },
      ),
    ).rejects.toThrow('acknowledgement loss');

    await expect(
      withExecutionTransaction((tx) => readScheduledTaskSavedResult(tx, identity, claim)),
    ).resolves.toMatchObject({ text: 'atomic saved result' });
    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${schemaName}".clio_proactive_alerts`,
    );
    expect(count.rows[0]?.count).toBe('1');
  }, 30_000);

  test('crash after email dispatch-start never auto-sends again and surfaces unknown separately', async () => {
    const { claim, nextRunAt } = await claimFresh('owner@example.test');
    const saved = await saveResult(claim);
    await expect(
      withExecutionTransaction((tx) => beginScheduledTaskEmailDispatch(tx, identity, claim)),
    ).resolves.toBe(true);
    const controlledEmailSink = jest.fn(async () => 'possible-send');
    await controlledEmailSink();
    await expireLease();

    await expect(
      withExecutionTransaction((tx) =>
        claimScheduledTaskExecution(
          tx,
          identity,
          new Date(),
          nextRunAt,
          nextRunAt,
          'owner@example.test',
          { occurrenceId: claim.occurrenceId, fence: claim.fence },
        ),
      ),
    ).resolves.toEqual({
      state: 'notification_unknown',
      result: { alertId: saved.alertId, savedAt: expect.any(String) },
    });
    expect(controlledEmailSink).toHaveBeenCalledTimes(1);
    const stored = await pool.query<{
      last_status: string;
      alert_outcome: string;
      task_outcome: string;
    }>(
      `SELECT st.last_status,
              a.metadata_jsonb ->> 'notificationOutcome' AS alert_outcome,
              st.metadata_jsonb #>> '{scheduleExecution,notification,outcome}' AS task_outcome
         FROM "${schemaName}".clio_scheduled_task st
         JOIN "${schemaName}".clio_proactive_alerts a ON a.id = $2::uuid
        WHERE st.id = $1::uuid`,
      [PROPOSAL, saved.alertId],
    );
    expect(stored.rows[0]).toEqual({
      last_status: 'notification_unknown',
      alert_outcome: 'unknown',
      task_outcome: 'unknown',
    });
  }, 30_000);

  test('confirmed controlled email persists confirmation before terminal completion', async () => {
    const { claim } = await claimFresh('owner@example.test');
    await saveResult(claim);
    const startedAt = new Date(Date.now() - 30_000);
    const confirmedAt = new Date();
    await withExecutionTransaction((tx) =>
      beginScheduledTaskEmailDispatch(tx, identity, claim, startedAt),
    );
    await expect(
      withExecutionTransaction((tx) =>
        recordScheduledTaskEmailOutcome(
          tx,
          identity,
          claim,
          { confirmed: true, sentFrom: 'controlled@example.test' },
          confirmedAt,
        ),
      ),
    ).resolves.toBe(true);
    await expect(
      withExecutionTransaction((tx) => advanceScheduledTaskExecution(tx, identity, claim, 'ok')),
    ).resolves.toBe(true);
    const row = await pool.query<{
      last_status: string;
      outcome: string;
      started_at: string;
      confirmed_at: string;
    }>(
      `SELECT last_status,
              metadata_jsonb #>> '{scheduleExecution,notification,outcome}' AS outcome,
              metadata_jsonb #>> '{scheduleExecution,notification,startedAt}' AS started_at,
              metadata_jsonb #>> '{scheduleExecution,notification,confirmedAt}' AS confirmed_at
         FROM "${schemaName}".clio_scheduled_task WHERE id = $1::uuid`,
      [PROPOSAL],
    );
    expect(row.rows[0]).toEqual({
      last_status: 'ok',
      outcome: 'confirmed',
      started_at: startedAt.toISOString(),
      confirmed_at: confirmedAt.toISOString(),
    });
  }, 30_000);

  test('membership-only revocation rejects ok but permits a truthful denied terminal status', async () => {
    const { claim } = await claimFresh();
    await saveResult(claim);
    await pool.query(`UPDATE "${schemaName}".tenant_memberships SET status = 'removed'`);
    await expect(
      withExecutionTransaction((tx) => advanceScheduledTaskExecution(tx, identity, claim, 'ok')),
    ).resolves.toBe(false);
    const before = await pool.query<{ last_status: string; run_count: number }>(
      `SELECT last_status, run_count
         FROM "${schemaName}".clio_scheduled_task
        WHERE id = $1::uuid`,
      [PROPOSAL],
    );
    expect(before.rows[0]).toEqual({ last_status: 'running', run_count: 0 });
    await expect(
      withExecutionTransaction((tx) =>
        advanceScheduledTaskExecution(tx, identity, claim, 'skipped_authority'),
      ),
    ).resolves.toBe(true);
    const after = await pool.query<{ last_status: string; run_count: number }>(
      `SELECT last_status, run_count
         FROM "${schemaName}".clio_scheduled_task
        WHERE id = $1::uuid`,
      [PROPOSAL],
    );
    expect(after.rows[0]).toEqual({ last_status: 'skipped_authority', run_count: 1 });
  }, 30_000);

  test('current wall and membership revocation block effects; cancellation defeats completion', async () => {
    const client = '88888888-8888-4888-8888-888888888888';
    const value = times();
    await pool.query(
      `INSERT INTO "${schemaName}".clients (id, tenant_id, memory_wall)
       VALUES ($1::uuid, $2::uuid, true)`,
      [client, ctx.tenantId],
    );
    await pool.query(
      `INSERT INTO "${schemaName}".client_memory_access (tenant_id, client_id, user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [ctx.tenantId, client, ctx.userId],
    );
    await insertDueExecutionTask(value.scheduledFor, { clientId: client });
    const result = await withExecutionTransaction((tx) =>
      claimScheduledTaskExecution(
        tx,
        identity,
        value.claimedAt,
        value.nextRunAt,
        value.scheduledFor,
      ),
    );
    expect(result.state).toBe('claimed');
    if (result.state !== 'claimed') throw new Error('expected claim');
    await pool.query(`DELETE FROM "${schemaName}".client_memory_access`);
    const sink = jest.fn(async () => undefined);
    await expect(
      withExecutionTransaction((tx) =>
        executeScheduledTaskEffect(
          () => checkScheduledTaskExecutionBoundary(tx, identity, result.claim),
          sink,
        ),
      ),
    ).resolves.toEqual({ executed: false, boundary: 'wall_denied' });
    await pool.query(`UPDATE "${schemaName}".tenant_memberships SET status = 'removed'`);
    await expect(
      withExecutionTransaction((tx) =>
        executeScheduledTaskEffect(
          () => checkScheduledTaskExecutionBoundary(tx, identity, result.claim),
          sink,
        ),
      ),
    ).resolves.toEqual({ executed: false, boundary: 'authority_denied' });
    expect(sink).not.toHaveBeenCalled();

    await pool.query(
      `UPDATE "${schemaName}".clio_scheduled_task
          SET enabled = false, last_status = 'canceled', updated_at = clock_timestamp()
        WHERE id = $1::uuid`,
      [PROPOSAL],
    );
    await expect(
      withExecutionTransaction((tx) =>
        advanceScheduledTaskExecution(tx, identity, result.claim, 'ok'),
      ),
    ).resolves.toBe(false);
    const canceled = await pool.query<{
      enabled: boolean;
      last_status: string;
      run_count: number;
    }>(
      `SELECT enabled, last_status, run_count
         FROM "${schemaName}".clio_scheduled_task
        WHERE id = $1::uuid`,
      [PROPOSAL],
    );
    expect(canceled.rows[0]).toEqual({
      enabled: false,
      last_status: 'canceled',
      run_count: 0,
    });
  }, 30_000);

  test('legacy running rows without a lease fail closed without replay', async () => {
    const value = times();
    await insertDueExecutionTask(value.scheduledFor);
    await pool.query(
      `UPDATE "${schemaName}".clio_scheduled_task
          SET last_status = 'running', last_run_at = $2, next_run_at = $3
        WHERE id = $1::uuid`,
      [PROPOSAL, value.claimedAt, value.nextRunAt],
    );
    await expect(
      withExecutionTransaction((tx) =>
        claimScheduledTaskExecution(
          tx,
          identity,
          new Date(),
          new Date(Date.now() + 60 * 60_000),
          value.nextRunAt,
        ),
      ),
    ).resolves.toEqual({ state: 'legacy_running_unknown' });
  }, 30_000);
});
