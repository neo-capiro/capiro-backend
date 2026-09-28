import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { TenantContext } from '@capiro/shared';
import { MeriToolsService } from './meri-tools.service.js';

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
        next_run_at timestamptz NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        last_status varchar(20),
        created_by varchar(40) NOT NULL,
        metadata_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb
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

  function harness(options: { barrier?: boolean; ackLoss?: boolean } = {}) {
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
});
