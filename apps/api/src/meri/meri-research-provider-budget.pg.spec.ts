import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { TenantContext } from '@capiro/shared';
import { MeriResearchService } from './meri-research.service.js';
import { readResearchProviderBudget } from './meri-research-tool-budget.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const RUN_1 = '44444444-4444-4444-8444-444444444444';
const RUN_2 = '55555555-5555-4555-8555-555555555555';
const ctx = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  tenantSlug: 'provider-budget',
} as TenantContext;

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

function run(id = RUN_1, leaseEpoch = 1, status = 'running', startedAt = new Date().toISOString()) {
  return {
    id,
    leaseEpoch,
    eventSequence: 0,
    phase: 'research',
    status,
    stage: 'Gathering',
    startedAt,
    heartbeatAt: new Date().toISOString(),
  };
}

function binding(
  operation: string,
  index = 0,
  retryOfAttemptId: string | null = null,
  extra: Partial<{
    leaseEpoch: number;
    kind: 'openai_responses' | 'anthropic_messages' | 'jev';
    phase: string;
    provider: string;
    model: string;
    maxInputTokens: number;
    maxOutputTokens: number | null;
  }> = {},
) {
  return {
    leaseEpoch: 1,
    logicalOperationId: operation,
    attemptId: `${operation}:${index}`,
    retryOfAttemptId,
    kind: 'openai_responses' as const,
    phase: 'acquisition',
    provider: 'openai',
    model: 'gpt-4.1',
    maxInputTokens: 100,
    maxOutputTokens: 200,
    ...extra,
  };
}

describeLocal('research provider budget — native PostgreSQL production CAS', () => {
  jest.setTimeout(30_000);
  let pool: Pool;
  let schemaName: string;
  let service: MeriResearchService;

  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as LocalPostgresConfig;
    expect(config).toMatchObject({ host: '127.0.0.1', port: 55433 });
    expect(config.scope).toEqual(expect.any(String));
    pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: 8,
    });
    const identity = await pool.query<{
      owned: boolean;
      address: string;
      port: number;
    }>(
      `SELECT current_user = $1 AS owned,
              host(inet_server_addr()) AS address,
              inet_server_port() AS port`,
      [config.user],
    );
    expect(identity.rows[0]).toMatchObject({ owned: true, address: '127.0.0.1', port: 55433 });

    schemaName = `meri_provider_budget_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
    const ownership = await pool.query<{ owned: boolean }>(
      'SELECT pg_get_userbyid(nspowner) = current_user AS owned FROM pg_namespace WHERE nspname=$1',
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
          const result = await callback(tx);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    };
    const values: Record<string, unknown> = {
      CLIO_RESEARCH_PROVIDER_BUDGET_ENABLED: true,
      CLIO_RESEARCH_MAX_PROVIDER_ATTEMPTS: 6,
      CLIO_RESEARCH_MAX_TOTAL_TOKENS: 10_000,
      CLIO_RESEARCH_MAX_COST_USD: 1,
      CLIO_RESEARCH_TOTAL_BUDGET_MS: 600_000,
    };
    service = new MeriResearchService(
      prisma as never,
      { get: (key: string) => values[key] } as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }, 30_000);

  afterAll(async () => {
    if (pool && schemaName) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      const absent = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM pg_namespace WHERE nspname=$1',
        [schemaName],
      );
      expect(absent.rows[0]?.count).toBe(0);
    }
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE "${schemaName}".clio_research_sessions`);
  });

  async function insert(metadata: Record<string, unknown>) {
    await pool.query(
      `INSERT INTO "${schemaName}".clio_research_sessions
       (id,tenant_id,user_id,title,status,metadata_jsonb,updated_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'Provider budget','researching',$4::jsonb,now())`,
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

  const reserve = (input: ReturnType<typeof binding>, runId = RUN_1) =>
    service.reserveProviderAttempt(ctx, SESSION_ID, runId, input);

  async function settle(
    reservation: Awaited<ReturnType<typeof reserve>>,
    input: ReturnType<typeof binding>,
    outcome: 'known' | 'rejected' | 'uncertain',
    tokens?: [number, number],
    runId = RUN_1,
  ) {
    return service.settleProviderAttempt(ctx, SESSION_ID, runId, {
      leaseEpoch: input.leaseEpoch,
      reservationId: reservation.reservationId,
      logicalOperationId: input.logicalOperationId,
      attemptId: input.attemptId,
      retryOfAttemptId: input.retryOfAttemptId,
      kind: input.kind,
      phase: input.phase,
      provider: input.provider,
      model: input.model,
      outcome,
      inputTokens: tokens?.[0] ?? null,
      outputTokens: tokens?.[1] ?? null,
    });
  }

  test('concurrent CAS admits exactly one claimant to the final aggregate attempt', async () => {
    await insert({ run: run() });
    for (let index = 0; index < 5; index += 1) await reserve(binding(`seed-${index}`));
    const results = await Promise.allSettled([
      reserve(binding('last-left')),
      reserve(binding('last-right')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(readResearchProviderBudget(await metadata())?.chargedAttempts).toBe(6);
  });

  test('lost dispatch cannot be blindly recreated; explicit ambiguous outcome permits one linked retry', async () => {
    await insert({ run: run() });
    const firstInput = binding('logical-operation');
    const first = await reserve(firstInput);
    await expect(reserve(binding('logical-operation', 1))).rejects.toThrow(
      'research_provider_budget_operation_recovery_required',
    );
    await settle(first, firstInput, 'uncertain');
    const retryInput = binding('logical-operation', 1, firstInput.attemptId);
    const retry = await reserve(retryInput);
    expect(retry.dispatchAllowed).toBe(true);
    const budget = readResearchProviderBudget(await metadata())!;
    expect(budget.attempts.map((attempt) => attempt.status)).toEqual(['uncertain', 'reserved']);
    expect(budget.chargedTokens).toBe(600);
  });

  test('known effective JEV pricing settles measured cost and leaves synthesis budget', async () => {
    await insert({ run: run() });
    const jevInput = binding('jev-check', 0, null, {
      kind: 'jev',
      provider: 'jev',
      model: 'jev-1.13.0',
      maxInputTokens: 100,
      maxOutputTokens: 2_000,
    });
    const jev = await reserve(jevInput);
    const settled = await settle(jev, jevInput, 'known', [10, 5]);
    expect(settled.chargedCostMicros).toBe(1);
    const synthesis = await reserve(
      binding('synthesis', 0, null, {
        phase: 'synthesis',
        maxInputTokens: 100,
        maxOutputTokens: 200,
      }),
    );
    expect(synthesis.dispatchAllowed).toBe(true);
    expect(readResearchProviderBudget(await metadata())?.attempts[0]).toMatchObject({
      priceKnown: true,
      actualCostMicros: 1,
    });
  });

  test('deadline, Stop, and replacement lease fence late dispatch and settlement while preserving spend', async () => {
    await insert({ run: run(RUN_1, 1, 'running', new Date(Date.now() - 700_000).toISOString()) });
    await expect(reserve(binding('late'))).rejects.toThrow('research_provider_budget_deadline');

    await pool.query(`TRUNCATE "${schemaName}".clio_research_sessions`);
    await insert({ run: run() });
    const firstInput = binding('lease-one');
    const first = await reserve(firstInput);
    await pool.query(
      `UPDATE "${schemaName}".clio_research_sessions
          SET metadata_jsonb=jsonb_set(metadata_jsonb,'{run}',$2::jsonb),updated_at=now()
        WHERE id=$1::uuid`,
      [SESSION_ID, JSON.stringify(run(RUN_2, 2, 'interrupted'))],
    );
    await expect(reserve(binding('after-stop', 0, null, { leaseEpoch: 2 }), RUN_2)).rejects.toThrow(
      'lease',
    );
    await pool.query(
      `UPDATE "${schemaName}".clio_research_sessions
          SET metadata_jsonb=jsonb_set(metadata_jsonb,'{run}',$2::jsonb),updated_at=now()
        WHERE id=$1::uuid`,
      [SESSION_ID, JSON.stringify(run(RUN_2, 2))],
    );
    await expect(settle(first, firstInput, 'known', [1, 1])).rejects.toThrow('lease');
    const next = await reserve(binding('lease-two', 0, null, { leaseEpoch: 2 }), RUN_2);
    expect(next.dispatchAllowed).toBe(true);
    expect(readResearchProviderBudget(await metadata())?.chargedAttempts).toBe(2);
  });
});
