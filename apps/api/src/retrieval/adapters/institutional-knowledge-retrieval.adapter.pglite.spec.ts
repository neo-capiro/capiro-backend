import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { EmbeddingProvider } from '../../embeddings/embedding-provider.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { RetrievalRequest, SemanticDatasetDescriptor } from '../retrieval-v2.types.js';
import { InstitutionalKnowledgeRetrievalAdapter } from './institutional-knowledge-retrieval.adapter.js';

const requireFromApi = createRequire(resolve(__dirname, '../../../package.json'));
const { PGlite } = requireFromApi('@electric-sql/pglite') as {
  PGlite: { create(): Promise<PGliteDb> };
};

type QueryResult = { rows: Array<Record<string, unknown>> };
type PGliteDb = {
  exec(sql: string): Promise<unknown>;
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  close(): Promise<void>;
};
type PrismaQuery = { text: string; values: unknown[] };

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_USER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CLIENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_CLIENT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const TARGET = '11111111-1111-4111-8111-111111111111';
const STALE = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333';
const PRIVATE = '44444444-4444-4444-8444-444444444444';
const REVOKED = '55555555-5555-4555-8555-555555555555';
const RESTRICTED = '66666666-6666-4666-8666-666666666666';
const FUTURE = '77777777-7777-4777-8777-777777777777';
const WRONG_CLIENT = '88888888-8888-4888-8888-888888888888';

const schema = `
CREATE TABLE clients (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  memory_wall boolean NOT NULL DEFAULT false
);
CREATE TABLE client_memory_access (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  user_id uuid NOT NULL
);
CREATE TABLE memory_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_id uuid,
  owner_user_id uuid,
  title text NOT NULL,
  type text NOT NULL DEFAULT 'client-compass',
  slug text NOT NULL,
  sections_jsonb jsonb NOT NULL DEFAULT '[]'::jsonb,
  visibility text NOT NULL DEFAULT 'tenant',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  memory_class text NOT NULL DEFAULT 'client_steering',
  memory_authority text NOT NULL DEFAULT 'client_approved',
  memory_scope text NOT NULL DEFAULT 'client',
  governed_status text NOT NULL DEFAULT 'active',
  conflict_status text NOT NULL DEFAULT 'none',
  controlling_item_id uuid,
  sensitivity text NOT NULL DEFAULT 'normal',
  source_type text NOT NULL DEFAULT 'approved_document_edit',
  source_id text,
  source_ref text,
  source_excerpt text,
  source_content_hash text,
  source_version text,
  asserted_by_user_id uuid,
  approved_by_user_id uuid,
  approved_at timestamptz,
  second_approved_by_user_id uuid,
  second_approved_at timestamptz,
  as_of timestamptz,
  effective_from timestamptz,
  valid_until timestamptz,
  expires_at timestamptz,
  last_confirmed_at timestamptz,
  review_due_at timestamptz,
  review_cadence_days integer,
  instructions_allowed boolean NOT NULL DEFAULT false
);
CREATE INDEX memory_items_governed_recall_fixture_idx
  ON memory_items(tenant_id, governed_status, memory_class, memory_scope, client_id);
`;

function request(overrides: Partial<RetrievalRequest> = {}): RetrievalRequest {
  return {
    queryClass: 'lookup',
    requestedDomains: ['institutional_knowledge'],
    caller: {
      tenantId: TENANT,
      userId: USER,
      clientIds: [CLIENT],
      authorizedClientIds: [CLIENT],
    },
    query: 'autonomous maritime demo',
    pageSize: 50,
    ...overrides,
  };
}

function fixtureRow(
  id: string,
  overrides: {
    tenantId?: string;
    clientId?: string | null;
    ownerUserId?: string | null;
    visibility?: string;
    scope?: string;
    governedStatus?: string;
    sensitivity?: string;
    effectiveFrom?: string | null;
    body?: string;
    updatedAt?: string;
    sourceHash?: string;
  } = {},
): unknown[] {
  return [
    id,
    overrides.tenantId ?? TENANT,
    overrides.clientId === undefined ? CLIENT : overrides.clientId,
    overrides.ownerUserId ?? null,
    overrides.visibility ?? 'tenant',
    overrides.scope ?? 'client',
    overrides.governedStatus ?? 'active',
    overrides.sensitivity ?? 'normal',
    overrides.effectiveFrom ?? null,
    overrides.body ?? 'continuity sentinel control fact',
    overrides.updatedAt ?? '2026-01-01T00:00:00Z',
    overrides.sourceHash ?? `source-${id}`,
  ];
}

async function insertFixtureRow(db: PGliteDb, values: unknown[]): Promise<void> {
  await db.query(
    `INSERT INTO memory_items (
       id, tenant_id, client_id, owner_user_id, visibility, memory_scope,
       governed_status, sensitivity, effective_from, sections_jsonb, updated_at,
       created_at, title, slug, source_id, source_content_hash, approved_by_user_id, approved_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::timestamptz,
       jsonb_build_array(jsonb_build_object('key','memory','heading','autonomous maritime demo','body',$10::text)),
       $11::timestamptz, $11::timestamptz, 'Routine control', 'fixture-' || $1::text,
       'source-' || $1::text, $12, $2::uuid, '2025-01-01T00:00:00Z'
     )`,
    values,
  );
}

function planMetrics(explain: unknown): Record<string, unknown> {
  const parsed = typeof explain === 'string' ? JSON.parse(explain) : explain;
  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  const plan = (root as { Plan?: Record<string, unknown> })?.Plan ?? {};
  return {
    planningTimeMs: (root as { 'Planning Time'?: number })?.['Planning Time'] ?? null,
    executionTimeMs: (root as { 'Execution Time'?: number })?.['Execution Time'] ?? null,
    rootNode: plan['Node Type'] ?? null,
    actualRows: plan['Actual Rows'] ?? null,
    planRows: plan['Plan Rows'] ?? null,
  };
}

describe('canonical memory recall production SQL on embedded PostgreSQL', () => {
  jest.setTimeout(120_000);

  let db: PGliteDb;
  let adapter: InstitutionalKnowledgeRetrievalAdapter;
  let candidateQuery: PrismaQuery | undefined;
  let transactionCount = 0;
  const dataset = { domain: 'institutional_knowledge' } as SemanticDatasetDescriptor;

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(schema);
    await db.query(
      'INSERT INTO clients(id, tenant_id, memory_wall) VALUES ($1::uuid,$2::uuid,false)',
      [CLIENT, TENANT],
    );
    await db.query(
      'INSERT INTO clients(id, tenant_id, memory_wall) VALUES ($1::uuid,$2::uuid,false)',
      [OTHER_CLIENT, TENANT],
    );

    await db.query(
      `INSERT INTO memory_items (
         id, tenant_id, client_id, title, slug, sections_jsonb, updated_at, created_at,
         source_id, source_content_hash, approved_by_user_id, approved_at
       )
       SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
              $1::uuid, $2::uuid, 'Routine update ' || i, 'routine-' || i,
              jsonb_build_array(jsonb_build_object(
                'key', 'autonomous-maritime-demo-' || i,
                'heading', 'autonomous maritime demo',
                'body', 'Unrelated routine update ' || i
              )),
              '2026-08-20T00:00:00Z'::timestamptz - (i || ' seconds')::interval,
              '2026-08-20T00:00:00Z'::timestamptz - (i || ' seconds')::interval,
              'source-' || i, 'hash-' || i, $3::uuid, '2026-08-19T00:00:00Z'
       FROM generate_series(1, 1001) AS i`,
      [TENANT, CLIENT, USER],
    );
    await insertFixtureRow(
      db,
      fixtureRow(TARGET, {
        body: 'The autonomous maritime demo requires an approved safety review.',
        updatedAt: '2020-01-01T00:00:00Z',
        sourceHash: 'target-content-hash',
      }),
    );
    await insertFixtureRow(db, fixtureRow(STALE, { governedStatus: 'stale' }));
    await insertFixtureRow(db, fixtureRow(FOREIGN, { tenantId: OTHER_TENANT }));
    await insertFixtureRow(
      db,
      fixtureRow(PRIVATE, {
        clientId: null,
        ownerUserId: OTHER_USER,
        visibility: 'user',
        scope: 'user_private',
      }),
    );
    await insertFixtureRow(db, fixtureRow(REVOKED, { governedStatus: 'revoked' }));
    await insertFixtureRow(db, fixtureRow(RESTRICTED, { sensitivity: 'restricted' }));
    await insertFixtureRow(db, fixtureRow(FUTURE, { effectiveFrom: '2999-01-01T00:00:00Z' }));
    await insertFixtureRow(db, fixtureRow(WRONG_CLIENT, { clientId: OTHER_CLIENT }));

    const tx = {
      $queryRawUnsafe: async (sql: string, ...values: unknown[]) =>
        (await db.query(sql, values)).rows,
      $queryRaw: async (query: PrismaQuery) => {
        candidateQuery = query;
        return (await db.query(query.text, query.values)).rows;
      },
    };
    const prisma = {
      withTenantUser: async (
        _tenantId: string,
        _userId: string,
        work: (transaction: unknown) => Promise<unknown>,
      ) => {
        transactionCount += 1;
        await db.exec('BEGIN');
        try {
          const result = await work(tx);
          await db.exec('COMMIT');
          return result;
        } catch (error) {
          await db.exec('ROLLBACK');
          throw error;
        }
      },
    } as unknown as PrismaService;
    const provider = {
      metadata: {
        provider: 'test',
        model: 'test-memory-model',
        modelVersion: '1',
        dimensions: 1024,
      },
      embed: jest.fn().mockRejectedValue(new Error('lookup must not embed')),
      embedBatch: jest.fn(),
    } as unknown as EmbeddingProvider;
    adapter = new InstitutionalKnowledgeRetrievalAdapter({} as never, prisma, provider);
  });

  afterAll(async () => {
    await db.close();
  });

  it('recalls the old body match beyond 1000 misleading headings with a bounded production query', async () => {
    const startedAt = performance.now();
    const result = await adapter.retrieve(dataset, request());
    const wallMs = performance.now() - startedAt;

    expect(result.records[0]?.recordId).toBe(TARGET);
    expect(result.recordsEvaluated).toBe(501);
    expect(result).toMatchObject({
      truncated: true,
      coverageComplete: false,
      stopReason: 'governed_memory_safety_cap_reached',
    });
    expect(candidateQuery?.text).toContain("JSONB_TYPEOF(section.value -> 'body')");
    expect(candidateQuery?.text).not.toContain('LOWER(mi.sections_jsonb::text)');
    expect(candidateQuery?.text).toContain('LIMIT');

    const explained = await db.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidateQuery!.text}`,
      candidateQuery!.values,
    );
    const fixtureCount = await db.query('SELECT COUNT(*)::int AS count FROM memory_items');
    const eligibleCount = await db.query(
      `SELECT COUNT(*)::int AS count
         FROM memory_items
        WHERE tenant_id = $1::uuid
          AND (visibility = 'tenant' OR owner_user_id = $2::uuid)
          AND status = 'active'
          AND memory_class IN ('institutional_authoritative', 'client_steering', 'user_preference', 'episodic_working')
          AND (memory_scope <> 'user_private' OR owner_user_id = $2::uuid)
          AND (memory_scope <> 'client' OR client_id = $3::uuid)
          AND approved_by_user_id IS NOT NULL
          AND sensitivity = 'normal'
          AND (effective_from IS NULL OR effective_from <= now())
          AND (client_id IS NULL OR client_id = $3::uuid)
          AND governed_status IN ('active', 'stale')`,
      [TENANT, USER, CLIENT],
    );
    const metrics = {
      engine: '@electric-sql/pglite@0.5.8',
      fixtureMemoryRows: Number(fixtureCount.rows[0]?.count),
      governedEligibleRows: Number(eligibleCount.rows[0]?.count),
      candidateRows: result.recordsEvaluated,
      adapterWallMs: Number(wallMs.toFixed(3)),
      ...planMetrics(explained.rows[0]?.['QUERY PLAN']),
    };
    expect(metrics).toMatchObject({ fixtureMemoryRows: 1009, governedEligibleRows: 1003 });
    console.log(`MEMORY_SQL_EVIDENCE ${JSON.stringify(metrics)}`);
  });

  it('preserves stale approved facts and rejects exact foreign/private/revoked/sensitive/future/client controls', async () => {
    const stale = await adapter.retrieve(
      dataset,
      request({ memoryItemId: STALE, query: 'continuity sentinel' }),
    );
    expect(stale.records.map((record) => record.recordId)).toEqual([STALE]);
    expect(stale.records[0]?.payload.governance).toMatchObject({ status: 'stale', stale: true });

    for (const id of [FOREIGN, PRIVATE, REVOKED, RESTRICTED, FUTURE, WRONG_CLIENT]) {
      const denied = await adapter.retrieve(
        dataset,
        request({ memoryItemId: id, query: 'continuity sentinel' }),
      );
      expect(denied.records).toEqual([]);
    }
    expect(transactionCount).toBe(8);
  });
});
