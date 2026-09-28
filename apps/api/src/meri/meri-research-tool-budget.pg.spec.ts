import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { TenantContext } from '@capiro/shared';
import { MeriResearchService } from './meri-research.service.js';
import { readResearchToolBudget } from './meri-research-tool-budget.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const RUN_1 = '44444444-4444-4444-8444-444444444444';
const RUN_2 = '55555555-5555-4555-8555-555555555555';
const ctx = { tenantId: TENANT_ID, userId: USER_ID, tenantSlug: 'tenant' } as TenantContext;
const TOOL_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
};

type LocalPostgresConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  scope: string;
};

const configPath =
  process.env.MERI_RESEARCH_BUDGET_POSTGRES_CONFIG ||
  resolve(process.cwd(), '../../../cap-meri-foundation-evidence/private/local-postgres.json');
const describeLocal = existsSync(configPath) ? describe : describe.skip;

function plan(toolCalls: number) {
  return {
    version: 1,
    title: 'Persisted tool budget',
    scope: {
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      actorId: USER_ID,
      clientId: null,
      conversationId: null,
    },
    budget: { toolCalls, tokens: 1_000 },
    steps: [
      {
        id: 'read',
        objective: 'Read approved evidence',
        dependsOn: [],
        requiredEvidenceDomains: ['institutional_memory'],
        allowedCapabilities: ['search_memory'],
        effect: 'read',
        completionCondition: 'Evidence captured',
        budget: { toolCalls, tokens: 1_000 },
      },
    ],
    clarifyingQuestions: [],
  };
}

function run(id = RUN_1, leaseEpoch = 1, status = 'running') {
  return {
    id,
    leaseEpoch,
    eventSequence: 0,
    phase: 'research',
    status,
    stage: 'Gathering evidence',
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
}

describeLocal('research tool budget — native PostgreSQL production CAS', () => {
  jest.setTimeout(30_000);
  let pool: Pool;
  let schemaName: string;
  const execute = jest.fn();
  let service: MeriResearchService;

  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as LocalPostgresConfig;
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(55433);
    expect(config.user).toEqual(expect.any(String));
    expect(config.scope).toEqual(expect.any(String));
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

    schemaName = `meri_tool_budget_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
    const ownership = await pool.query<{ owned: boolean }>(
      `SELECT pg_get_userbyid(nspowner) = current_user AS owned
         FROM pg_namespace WHERE nspname = $1`,
      [schemaName],
    );
    expect(ownership.rows[0]?.owned).toBe(true);
    await pool.query(`
      CREATE TABLE "${schemaName}".clio_research_sessions (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        user_id uuid NOT NULL,
        client_id uuid,
        title text NOT NULL,
        status text NOT NULL,
        report_artifact_id uuid,
        metadata_jsonb jsonb NOT NULL,
        updated_at timestamptz NOT NULL
      )
    `);

    const prisma = {
      withTenant: async (_tenantId: string, callback: (tx: any) => Promise<unknown>) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`SET LOCAL search_path TO "${schemaName}"`);
          const tx = {
            clioResearchSession: {
              findFirst: async ({ where }: { where: Record<string, unknown> }) => {
                const found = await client.query(
                  `SELECT id, tenant_id, user_id, client_id, title, status,
                          report_artifact_id, metadata_jsonb, updated_at
                     FROM clio_research_sessions
                    WHERE id=$1::uuid AND tenant_id=$2::uuid AND user_id=$3::uuid`,
                  [where.id, where.tenantId, where.userId],
                );
                const row = found.rows[0];
                return row
                  ? {
                      id: row.id,
                      tenantId: row.tenant_id,
                      userId: row.user_id,
                      clientId: row.client_id,
                      title: row.title,
                      status: row.status,
                      reportArtifactId: row.report_artifact_id,
                      metadata: row.metadata_jsonb,
                      updatedAt: row.updated_at,
                    }
                  : null;
              },
            },
            clioConversation: { findFirst: async () => null },
            $queryRawUnsafe: async (sql: string, ...values: unknown[]) =>
              (await client.query(sql, values)).rows,
          };
          const value = await callback(tx);
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    };
    service = new MeriResearchService(
      prisma as never,
      { get: jest.fn() } as never,
      {
        anthropicToolSchemas: jest.fn(() => [
          { name: 'search_memory', description: 'Search memory', input_schema: TOOL_SCHEMA },
        ]),
        isConcurrencySafe: jest.fn((tool: string) => tool === 'search_memory'),
        isSideEffecting: jest.fn((tool: string) => tool !== 'search_memory'),
        execute,
      } as never,
      {} as never,
      {} as never,
    );
  }, 30_000);

  afterAll(async () => {
    if (pool && schemaName) await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    execute.mockClear();
    await pool.query(`TRUNCATE "${schemaName}".clio_research_sessions`);
  });

  async function insert(metadata: Record<string, unknown>) {
    await pool.query(
      `INSERT INTO "${schemaName}".clio_research_sessions
       (id, tenant_id, user_id, title, status, metadata_jsonb, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Budget', 'researching', $4::jsonb, now())`,
      [SESSION_ID, TENANT_ID, USER_ID, JSON.stringify(metadata)],
    );
  }

  async function metadata() {
    const stored = await pool.query<{ metadata_jsonb: Record<string, unknown> }>(
      `SELECT metadata_jsonb FROM "${schemaName}".clio_research_sessions WHERE id=$1::uuid`,
      [SESSION_ID],
    );
    return stored.rows[0]!.metadata_jsonb;
  }

  test('rejects caller-supplied quota fields before touching persisted spend', async () => {
    await insert({ run: run(), researchPlan: plan(2) });
    await expect(
      service.reserveSafeReadAttempt(ctx, SESSION_ID, RUN_1, {
        leaseEpoch: 1,
        providerCallId: 'model-attempt',
        tool: 'search_memory',
        input: { query: 'radar' },
        limit: 48,
      } as never),
    ).rejects.toThrow('malformed');

    expect(readResearchToolBudget(await metadata())).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  test('atomically admits exactly one concurrent claimant for the last slot', async () => {
    await insert({ run: run(), researchPlan: plan(1) });
    const results = await Promise.allSettled([
      service.reserveSafeReadAttempt(ctx, SESSION_ID, RUN_1, {
        leaseEpoch: 1,
        providerCallId: 'provider-left',
        tool: 'search_memory',
        input: { query: 'left' },
      }),
      service.reserveSafeReadAttempt(ctx, SESSION_ID, RUN_1, {
        leaseEpoch: 1,
        providerCallId: 'provider-right',
        tool: 'search_memory',
        input: { query: 'right' },
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(String(results.find((result) => result.status === 'rejected')?.reason)).toContain(
      'research_tool_budget_exhausted',
    );
    expect(readResearchToolBudget(await metadata())).toMatchObject({ spent: 1, limit: 1 });
    expect(execute).not.toHaveBeenCalled();
  });

  test('concurrent duplicate identity claims once and never authorizes a second dispatch', async () => {
    await insert({ run: run(), researchPlan: plan(2) });
    const [left, right] = await Promise.all([
      service.reserveSafeReadAttempt(ctx, SESSION_ID, RUN_1, {
        leaseEpoch: 1,
        providerCallId: 'provider-same',
        tool: 'search_memory',
        input: { query: 'same' },
      }),
      service.reserveSafeReadAttempt(ctx, SESSION_ID, RUN_1, {
        leaseEpoch: 1,
        providerCallId: 'provider-same',
        tool: 'search_memory',
        input: { query: 'same' },
      }),
    ]);

    expect([left.dispatchAllowed, right.dispatchAllowed].sort()).toEqual([false, true]);
    expect(left.reservationId).toBe(right.reservationId);
    expect(readResearchToolBudget(await metadata())).toMatchObject({ spent: 1, limit: 2 });
  });

  test('retains totals across owner replacement and rejects Stop-stale lease, changed input, and replan expansion', async () => {
    await insert({ run: run(), researchPlan: plan(2) });
    const first = await service.reserveSafeReadAttempt(ctx, SESSION_ID, RUN_1, {
      leaseEpoch: 1,
      providerCallId: 'provider-1',
      tool: 'search_memory',
      input: { query: 'one' },
    });
    expect(first.dispatchAllowed).toBe(true);

    await pool.query(
      `UPDATE "${schemaName}".clio_research_sessions
          SET metadata_jsonb = jsonb_set(metadata_jsonb, '{run}', $2::jsonb), updated_at=now()
        WHERE id=$1::uuid`,
      [SESSION_ID, JSON.stringify(run(RUN_2, 2))],
    );
    await expect(
      service.reserveSafeReadAttempt(ctx, SESSION_ID, RUN_1, {
        leaseEpoch: 1,
        providerCallId: 'stale-after-stop',
        tool: 'search_memory',
        input: { query: 'stale' },
      }),
    ).rejects.toThrow('lease');
    await expect(
      service.reserveSafeReadAttempt(ctx, SESSION_ID, RUN_2, {
        leaseEpoch: 2,
        providerCallId: 'provider-1',
        tool: 'search_memory',
        input: { query: 'changed' },
      }),
    ).rejects.toThrow('research_tool_budget_attempt_identity_reused');
    const second = await service.reserveSafeReadAttempt(ctx, SESSION_ID, RUN_2, {
      leaseEpoch: 2,
      providerCallId: 'provider-2',
      tool: 'search_memory',
      input: { query: 'two' },
    });
    expect(second).toMatchObject({ dispatchAllowed: true, spent: 2, limit: 2 });

    await pool.query(
      `UPDATE "${schemaName}".clio_research_sessions
          SET metadata_jsonb = jsonb_set(metadata_jsonb, '{researchPlan}', $2::jsonb), updated_at=now()
        WHERE id=$1::uuid`,
      [SESSION_ID, JSON.stringify(plan(3))],
    );
    await expect(
      service.reserveSafeReadAttempt(ctx, SESSION_ID, RUN_2, {
        leaseEpoch: 2,
        providerCallId: 'provider-3',
        tool: 'search_memory',
        input: { query: 'three' },
      }),
    ).rejects.toThrow('research_tool_budget_replan_expansion_denied');
    expect(readResearchToolBudget(await metadata())).toMatchObject({ spent: 2, limit: 2 });
    expect(execute).not.toHaveBeenCalled();
  });
});
