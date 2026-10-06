import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { TenantContext } from '@capiro/shared';
import { MeriResearchService } from './meri-research.service.js';
import {
  createResearchChildTaskBatch,
  persistResearchChildTaskBatch,
  readResearchChildTasks,
} from './meri-research-child-task.js';
import type { ResearchPlanV1 } from './meri-research-plan.js';

const SESSION_ID = '61111111-1111-4111-8111-111111111111';
const TENANT_ID = '62222222-2222-4222-8222-222222222222';
const USER_ID = '63333333-3333-4333-8333-333333333333';
const RUN_1 = '64444444-4444-4444-8444-444444444444';
const RUN_2 = '65555555-5555-4555-8555-555555555555';
const ctx = { tenantId: TENANT_ID, userId: USER_ID, tenantSlug: 'tenant' } as TenantContext;

type LocalPostgresConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  scope: string;
};

const configPath =
  process.env.MERI_RESEARCH_CHILD_POSTGRES_CONFIG ||
  resolve(process.cwd(), '../../../cap-meri-foundation-evidence/private/local-postgres.json');
const describeLocal = existsSync(configPath) ? describe : describe.skip;

const scope = {
  sessionId: SESSION_ID,
  tenantId: TENANT_ID,
  actorId: USER_ID,
  clientId: null,
  conversationId: null,
};
const plan: ResearchPlanV1 = {
  version: 1,
  title: 'Bounded PostgreSQL children',
  scope,
  budget: { toolCalls: 4, tokens: 4_000 },
  steps: [
    {
      id: 'memory',
      objective: 'Read current institutional memory',
      dependsOn: [],
      requiredEvidenceDomains: ['institutional_memory'],
      allowedCapabilities: ['search_memory'],
      effect: 'read',
      completionCondition: 'Memory reviewed',
      budget: { toolCalls: 4, tokens: 4_000 },
    },
  ],
  clarifyingQuestions: [],
};

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

function tasks(owner = run()) {
  return createResearchChildTaskBatch({
    specs: [
      {
        id: `${owner.id}:child:4:1`,
        role: 'evidence_reviewer',
        goal: 'Review the admitted current memory evidence.',
        allowedCapabilities: ['search_memory'],
      },
      {
        id: `${owner.id}:child:4:2`,
        role: 'scope_analyst',
        goal: 'Independently review gaps in the admitted current memory evidence.',
        allowedCapabilities: ['search_memory'],
      },
    ],
    run: owner,
    scope,
    parentPlan: plan,
    parentAllowedReadCapabilities: ['search_memory'],
    evidenceHandles: [],
    goalRevision: 4,
    modelConfig: {
      policy: 'current_approved_research_model',
      provider: 'openai',
      modelSelection: 'server_resolved',
      reasoningMode: 'deep',
      allowProviderFallback: false,
    },
    deadlineAt: '2099-09-28T13:00:00.000Z',
  });
}

function runtimeResult(taskId: string) {
  return {
    taskId,
    output: {
      version: 1 as const,
      goalRevision: 4,
      findings: [
        {
          id: `finding-${taskId.endsWith(':1') ? 'one' : 'two'}`,
          statement: 'The current owner-qualified memory supports this bounded finding.',
          evidenceHandles: ['search_memory:memory-1'],
          confidence: 'high' as const,
        },
      ],
      limitations: ['Only current admitted memory was reviewed.'],
    },
    model: 'current-approved-model',
    sources: [],
    toolsUsed: ['search_memory'],
    ledgerEntries: [],
    citations: [
      {
        n: 1,
        type: 'memory',
        id: 'memory-1',
        title: 'Memory',
        url: null,
        snippet: null,
        tool: 'search_memory',
      },
    ],
    producerInputSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    producerInputMode: 'covered_inputs' as const,
    clientContextSha256: null,
    producerInputDraft: null,
    producerInputCategories: { unsupported: {}, covered: {} },
    schemaCorrections: 0 as const,
  };
}

describeLocal('bounded research child tasks — native PostgreSQL production CAS', () => {
  jest.setTimeout(30_000);
  let pool: Pool;
  let schemaName: string;
  let service: MeriResearchService;

  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as LocalPostgresConfig;
    expect(config).toMatchObject({ host: '127.0.0.1', port: 55433 });
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
    schemaName = `meri_child_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
    const ownership = await pool.query<{ owned: boolean }>(
      `SELECT pg_get_userbyid(nspowner) = current_user AS owned FROM pg_namespace WHERE nspname = $1`,
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
        isConcurrencySafe: jest.fn(() => true),
        isSideEffecting: jest.fn(() => false),
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
    await pool.query(`TRUNCATE "${schemaName}".clio_research_sessions`);
  });

  async function insert(metadata: Record<string, unknown>) {
    await pool.query(
      `INSERT INTO "${schemaName}".clio_research_sessions
       (id, tenant_id, user_id, title, status, metadata_jsonb, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Children', 'researching', $4::jsonb, now())`,
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

  test('persists the batch before two concurrent completions and loses neither CAS update', async () => {
    await insert({
      run: run(),
      durableCoordinator: { version: 1, goalRevision: 4, retained: true },
      researchProviderBudget: { retained: true },
      researchToolBudget: { retained: true },
    });
    const batch = tasks();
    await service.persistChildTaskBatch(ctx, SESSION_ID, RUN_1, 1, batch);
    expect(readResearchChildTasks(await metadata()).map((task) => task.status)).toEqual([
      'pending',
      'pending',
    ]);

    await Promise.all([
      service.persistChildTaskResult(
        ctx,
        SESSION_ID,
        RUN_1,
        1,
        batch[0]!.id,
        runtimeResult(batch[0]!.id),
      ),
      service.persistChildTaskResult(
        ctx,
        SESSION_ID,
        RUN_1,
        1,
        batch[1]!.id,
        runtimeResult(batch[1]!.id),
      ),
    ]);

    const stored = await metadata();
    expect(readResearchChildTasks(stored).map((task) => task.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(stored).toMatchObject({
      durableCoordinator: { goalRevision: 4, retained: true },
      researchProviderBudget: { retained: true },
      researchToolBudget: { retained: true },
    });
  });

  test('a stopped lease rejects a late child result without replacing the persisted stop', async () => {
    const batch = tasks();
    await insert(
      persistResearchChildTaskBatch({
        metadata: { run: run(), durableCoordinator: { goalRevision: 4 } },
        run: run(),
        tasks: batch,
      }),
    );
    const stopped = { ...run(), status: 'cancelled', stage: 'Stopped' };
    await pool.query(
      `UPDATE "${schemaName}".clio_research_sessions
          SET metadata_jsonb = jsonb_set(metadata_jsonb, '{run}', $2::jsonb), updated_at = now()
        WHERE id=$1::uuid`,
      [SESSION_ID, JSON.stringify(stopped)],
    );

    await expect(
      service.persistChildTaskResult(
        ctx,
        SESSION_ID,
        RUN_1,
        1,
        batch[0]!.id,
        runtimeResult(batch[0]!.id),
      ),
    ).rejects.toThrow('lease is no longer active');
    expect(readResearchChildTasks(await metadata())[0]?.status).toBe('pending');
  });

  test('reclaim archives the old-owner batch and fences its late completion', async () => {
    const oldBatch = tasks();
    const oldMetadata = persistResearchChildTaskBatch({
      metadata: { run: run(), durableCoordinator: { goalRevision: 4 } },
      run: run(),
      tasks: oldBatch,
    });
    await insert({ ...oldMetadata, run: run(RUN_2, 2) });
    const replacement = tasks(run(RUN_2, 2));

    await service.persistChildTaskBatch(ctx, SESSION_ID, RUN_2, 2, replacement);
    const stored = await metadata();
    expect(readResearchChildTasks(stored).map((task) => task.parentRunId)).toEqual([RUN_2, RUN_2]);
    expect(stored.researchChildTaskHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tasks: expect.arrayContaining([expect.objectContaining({ parentRunId: RUN_1 })]),
        }),
      ]),
    );
    await expect(
      service.persistChildTaskResult(
        ctx,
        SESSION_ID,
        RUN_1,
        1,
        oldBatch[0]!.id,
        runtimeResult(oldBatch[0]!.id),
      ),
    ).rejects.toThrow('lease is no longer active');
  });
});
