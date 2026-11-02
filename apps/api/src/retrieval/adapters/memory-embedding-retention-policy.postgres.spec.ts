import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma } from '@prisma/client';
import type { EmbeddingProvider } from '../../embeddings/embedding-provider.js';
import type { TemporalKnowledgeGraphService } from '../../knowledge/graph/temporal-knowledge-graph.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RetrievalRequest, SemanticDatasetDescriptor } from '../retrieval-v2.types.js';
import {
  QUALIFICATION_SCHEMA,
  createQualificationDatabase,
  qualificationAdminUrl,
  type QualificationDatabase,
} from '../../../test/memory-postgres-qualification/harness.js';
import { InstitutionalKnowledgeRetrievalAdapter } from './institutional-knowledge-retrieval.adapter.js';

/**
 * The owner-retention policies of 20281029050000 on top of the memory
 * qualification harness, and the probe-shaped context_embeddings policy of
 * 20281102160000 applied from its migration file. On preview (2 November 2026)
 * every semantic recall expired its transaction: the retention policy's
 * memory_items subquery compared `m.id::text` with the embedding source id, so
 * each embedding probe scanned the tenant's memory items and evaluated
 * memory_retention_visible() per scanned row. This spec reads the adapter's own
 * statement plan as the application role under RLS, before and after, and then
 * runs the real recall, the retention rule and the malformed-source guard.
 */
const adminUrl = qualificationAdminUrl();
const run = adminUrl && process.env.MEMORY_POSTGRES_REQUIRE_VECTOR === '1' ? describe : describe.skip;
const TENANT = '10000000-0000-4000-8000-000000000001';
const USER = '20000000-0000-4000-8000-000000000001';
const SUBJECT = '70000000-0000-4000-8000-000000000001';
const TARGET = '71000000-0000-4000-8000-000000000001';
const MODEL = 'qualification-current-1024';
const ITEMS = 1200;
const dataset = { domain: 'institutional_knowledge' } as SemanticDatasetDescriptor;
const migrationsDir = resolve(process.cwd(), 'prisma/migrations');
const retentionMigration = readFileSync(resolve(migrationsDir, '20281029050000_memory_owner_retention/migration.sql'), 'utf8');
const probeMigration = readFileSync(
  resolve(migrationsDir, '20281102160000_memory_embedding_retention_policy_probe/migration.sql'),
  'utf8',
);

/** The migration's statements without comment lines; policy bodies carry no inner semicolons. */
function migrationStatements(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function policyText(source: string, policy: string): string {
  const start = source.indexOf(`CREATE POLICY ${policy} `);
  if (start < 0) throw new Error(`${policy} not found`);
  return source.slice(start, source.indexOf(';', start) + 1);
}

function axisVector(axis: number): number[] {
  const vector = Array<number>(1024).fill(0);
  vector[axis] = 1;
  return vector;
}

function provider(embed: () => Promise<number[]>): EmbeddingProvider {
  return {
    metadata: { provider: 'qualification', model: MODEL, modelVersion: '1', dimensions: 1024 },
    embed: jest.fn(embed),
    embedBatch: jest.fn(),
  } as unknown as EmbeddingProvider;
}

function request(): RetrievalRequest {
  return {
    queryClass: 'semantic_recall',
    requestedDomains: ['institutional_knowledge'],
    caller: { tenantId: TENANT, userId: USER, clientIds: [], authorizedClientIds: [] },
    query: 'appropriations strategy for rural water systems',
    pageSize: 3,
  };
}

/** The adapter's statement with Prisma's parameter list, recorded through a transaction stub. */
async function captureStatement(): Promise<{ text: string; values: unknown[] }> {
  const captured: Array<{ text: string; values: unknown[] }> = [];
  const tx = {
    $queryRaw: async (sql: Prisma.Sql) => {
      captured.push({ text: sql.text, values: sql.values });
      return [];
    },
    $executeRaw: async () => 1,
  };
  const recorder = { withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx) };
  await new InstitutionalKnowledgeRetrievalAdapter(
    {} as TemporalKnowledgeGraphService,
    recorder as unknown as PrismaService,
    provider(async () => axisVector(0)),
  ).retrieve(dataset, request());
  const statement = captured.find((entry) => entry.text.includes('semantic_candidates'));
  if (!statement) throw new Error('semantic recall statement not captured');
  return statement;
}

run('memory embedding retention policy on PostgreSQL with pgvector', () => {
  jest.setTimeout(180_000);
  let qualification: QualificationDatabase | undefined;
  let prisma: PrismaService | undefined;

  const ddl = (statements: string[]) =>
    qualification!.admin.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${qualification!.ownerRole}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${QUALIFICATION_SCHEMA}"`);
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
    });

  async function explain(): Promise<string> {
    const statement = await captureStatement();
    const rows = await prisma!.withTenantUser(TENANT, USER, (tx) =>
      tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN (FORMAT TEXT) ${statement.text}`, ...statement.values),
    );
    return rows.map((row) => row['QUERY PLAN']).join('\n');
  }

  beforeAll(async () => {
    qualification = await createQualificationDatabase(adminUrl!, true);
    const schema = QUALIFICATION_SCHEMA;
    // Retention subset of 20281029050000 over the harness relations: the subjects table,
    // the visibility function (search_path bound to the qualification schema instead of public),
    // the memory_items restrictive policy and the ORIGINAL context_embeddings policy.
    await ddl([
      `ALTER TABLE tenants ADD COLUMN status text NOT NULL DEFAULT 'active'`,
      `ALTER TABLE clients ADD COLUMN status text NOT NULL DEFAULT 'active'`,
      `CREATE TABLE tenant_memberships (tenant_id uuid NOT NULL, user_id uuid NOT NULL, status text NOT NULL DEFAULT 'active')`,
      `CREATE TABLE memory_retention_subjects (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
         owner_kind text NOT NULL, owner_id uuid NOT NULL, closed_at timestamptz(6), UNIQUE (tenant_id, id))`,
      `ALTER TABLE memory_retention_subjects ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE memory_retention_subjects FORCE ROW LEVEL SECURITY`,
      `CREATE POLICY memory_retention_subject_isolation ON memory_retention_subjects
         USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id())`,
      `ALTER TABLE memory_items ADD COLUMN retention_subject_id uuid`,
      `CREATE INDEX memory_items_retention_subject ON memory_items(tenant_id, retention_subject_id)`,
      `CREATE FUNCTION memory_retention_visible(p_tenant uuid,p_subject uuid) RETURNS boolean
       LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path="${schema}",pg_temp AS $$
         SELECT EXISTS(SELECT 1 FROM memory_retention_subjects s JOIN tenants t ON t.id=s.tenant_id
           WHERE (rls_bypass() OR p_tenant=current_tenant_id())
             AND s.tenant_id=p_tenant AND s.id=p_subject AND s.closed_at IS NULL AND t.status::text='active'
             AND (s.owner_kind='firm'
               OR (s.owner_kind='personal' AND EXISTS(SELECT 1 FROM tenant_memberships member
                 WHERE member.tenant_id=s.tenant_id AND member.user_id=s.owner_id AND member.status::text='active'))
               OR (s.owner_kind='client' AND EXISTS(SELECT 1 FROM clients client
                 WHERE client.tenant_id=s.tenant_id AND client.id=s.owner_id AND client.status='active'))))
       $$`,
      policyText(retentionMigration, 'memory_items_owner_retention'),
      policyText(retentionMigration, 'memory_embedding_owner_retention'),
    ]);
    await qualification.admin.$executeRawUnsafe(
      `GRANT SELECT ON "${schema}".memory_retention_subjects, "${schema}".tenant_memberships TO "${qualification.appRole}"`,
    );
    await qualification.admin.$executeRawUnsafe(
      `GRANT EXECUTE ON FUNCTION "${schema}".memory_retention_visible(uuid, uuid) TO "${qualification.appRole}"`,
    );
    const admin = qualification.admin;
    await admin.$executeRaw`INSERT INTO tenants (id) VALUES (${TENANT}::uuid) ON CONFLICT DO NOTHING`;
    await admin.$executeRaw`INSERT INTO users (id) VALUES (${USER}::uuid) ON CONFLICT DO NOTHING`;
    await admin.$executeRaw`INSERT INTO memory_retention_subjects (id, tenant_id, owner_kind, owner_id)
      VALUES (${SUBJECT}::uuid, ${TENANT}::uuid, 'firm', ${TENANT}::uuid)`;
    // ITEMS eligible firm memories bound to the open subject, each with a current-model embedding;
    // the target item carries the unit vector the query embeds to.
    await admin.$executeRaw`INSERT INTO memory_items (
        id, tenant_id, client_id, owner_user_id, type, visibility, slug, title, source, sections_jsonb,
        created_at, updated_at, status, memory_class, memory_authority, memory_scope, governed_status,
        source_type, source_id, source_content_hash, source_version, approved_by_user_id, approved_at,
        sensitivity, conflict_status, retention_subject_id)
      SELECT CASE WHEN g = 0 THEN ${TARGET}::uuid ELSE gen_random_uuid() END, ${TENANT}::uuid, NULL, NULL,
        'client-compass', 'tenant', 'retention-' || g, 'Retention memory ' || g, 'fixture',
        jsonb_build_array(jsonb_build_object('key', 'memory', 'heading', 'Memory', 'body', 'rural water body ' || g)),
        now(), now(), 'active', 'institutional_authoritative', 'firm_approved', 'firm', 'active',
        'approved_document_edit', 'source-' || g, 'hash-' || g, 'document-body:v1', ${USER}::uuid, now(),
        'normal', 'none', ${SUBJECT}::uuid
      FROM generate_series(0, ${ITEMS - 1}) g`;
    await admin.$executeRaw`INSERT INTO context_embeddings (tenant_id, client_id, source_type, source_id, model, content_text, content_hash, embedding)
      SELECT tenant_id, NULL, 'memory_item', id::text, ${MODEL}, 'projection', md5(id::text),
        CASE WHEN id = ${TARGET}::uuid THEN ${`[${axisVector(0).join(',')}]`}::vector
             ELSE (SELECT array_agg(random()) FROM generate_series(1, 1024))::vector END
      FROM memory_items WHERE tenant_id = ${TENANT}::uuid`;
    await admin.$executeRawUnsafe('ANALYZE memory_items, context_embeddings, memory_retention_subjects');
    prisma = new PrismaService({ datasources: { db: { url: qualification.appUrl } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await qualification?.dispose();
  });

  it('20281029050000 shape: the embedding policy subquery cannot probe memory_items by primary key', async () => {
    const plan = await explain();
    expect(plan).toContain('on context_embeddings ce');
    expect(plan).toMatch(/\(\(id\)::text = ce\.source_id\)/);
    expect(plan).not.toContain('Index Scan using memory_items_pkey on memory_items m');
  });

  it('20281102160000 applies from its migration file and turns the subquery into a primary-key probe', async () => {
    await ddl(migrationStatements(probeMigration));
    const plan = await explain();
    expect(plan).toContain('Index Scan using memory_items_pkey on memory_items m');
    expect(plan).toMatch(/Index Cond: \(id = \(ce\.source_id\)::uuid\)/);
    expect(plan).not.toMatch(/\(\(id\)::text = ce\.source_id\)/);
  });

  it('recalls the nearest visible memory through the real adapter, and a closed subject hides it', async () => {
    const retrieval = new InstitutionalKnowledgeRetrievalAdapter(
      {} as TemporalKnowledgeGraphService,
      prisma!,
      provider(async () => axisVector(0)),
    );
    const result = await retrieval.retrieve(dataset, request());
    expect(result.records[0]).toMatchObject({ recordId: TARGET, retrievalSignals: { semanticSimilarity: 1 } });
    // 1,200 eligible items exceed the adapter's 500-row safety cap, which it reports rather than hides.
    expect(result.stopReason).toBe('governed_memory_safety_cap_reached');
    // Close the owner period: every item of the subject leaves recall, embeddings included.
    await qualification!.admin.$executeRaw`UPDATE memory_retention_subjects SET closed_at = now() WHERE id = ${SUBJECT}::uuid`;
    const closed = await retrieval.retrieve(dataset, request());
    expect(closed.records).toEqual([]);
    expect(closed.total).toBe(0);
    await qualification!.admin.$executeRaw`UPDATE memory_retention_subjects SET closed_at = NULL WHERE id = ${SUBJECT}::uuid`;
  });

  it('a memory_item embedding whose source id is not a uuid stays invisible without raising', async () => {
    await qualification!.admin.$executeRaw`INSERT INTO context_embeddings (tenant_id, source_type, source_id, model, content_text, content_hash, embedding)
      VALUES (${TENANT}::uuid, 'memory_item', 'legacy:not-a-uuid', ${MODEL}, 'orphan', 'orphan-hash', ${`[${axisVector(0).join(',')}]`}::vector)`;
    const visible = await prisma!.withTenantUser(TENANT, USER, (tx) =>
      tx.$queryRaw<Array<{ source_id: string }>>`SELECT source_id FROM context_embeddings WHERE source_type = 'memory_item' AND content_text = 'orphan'`,
    );
    expect(visible).toEqual([]);
    const result = await new InstitutionalKnowledgeRetrievalAdapter(
      {} as TemporalKnowledgeGraphService,
      prisma!,
      provider(async () => axisVector(0)),
    ).retrieve(dataset, request());
    expect(result.records[0]).toMatchObject({ recordId: TARGET });
  });
});
