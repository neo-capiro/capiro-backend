import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma } from '@prisma/client';
import type { EmbeddingProvider } from '../../embeddings/embedding-provider.js';
import type { TemporalKnowledgeGraphService } from '../../knowledge/graph/temporal-knowledge-graph.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RetrievalRequest, SemanticDatasetDescriptor } from '../retrieval-v2.types.js';
import {
  DDL_PROVENANCE,
  QUALIFICATION_SCHEMA,
  assertDisposableLocalUrl,
  createQualificationDatabase,
  qualificationAdminUrl,
  type QualificationDatabase,
} from '../../../test/memory-postgres-qualification/harness.js';
import { InstitutionalKnowledgeRetrievalAdapter } from './institutional-knowledge-retrieval.adapter.js';

const TENANT = '10000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '10000000-0000-4000-8000-000000000002';
const USER = '20000000-0000-4000-8000-000000000001';
const OTHER_USER = '20000000-0000-4000-8000-000000000002';
const CLIENT = '30000000-0000-4000-8000-000000000001';
const OTHER_CLIENT = '30000000-0000-4000-8000-000000000002';
const FOREIGN_CLIENT = '30000000-0000-4000-8000-000000000003';
const CURRENT_MODEL = 'qualification-current-1024';
const OLD_MODEL = 'qualification-old-1024';
const dataset = { domain: 'institutional_knowledge' } as SemanticDatasetDescriptor;
const adminUrl = qualificationAdminUrl();
const databaseIt = adminUrl ? it : it.skip;
const requireVector = process.env.MEMORY_POSTGRES_REQUIRE_VECTOR === '1';

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
    query: 'qualification sentinel',
    pageSize: 50,
    ...overrides,
  };
}

function provider(embed: () => Promise<number[]>): EmbeddingProvider {
  return {
    metadata: {
      provider: 'qualification',
      model: CURRENT_MODEL,
      modelVersion: '1',
      dimensions: 1024,
    },
    embed: jest.fn(embed),
    embedBatch: jest.fn(),
  } as unknown as EmbeddingProvider;
}

function adapter(prisma: PrismaService, embeddingProvider: EmbeddingProvider) {
  return new InstitutionalKnowledgeRetrievalAdapter(
    {} as TemporalKnowledgeGraphService,
    prisma,
    embeddingProvider,
  );
}

function axisVector(axis: number): number[] {
  const vector = Array<number>(1024).fill(0);
  vector[axis] = 1;
  return vector;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

type MemoryFixture = {
  id: string;
  tenantId?: string;
  clientId?: string | null;
  ownerUserId?: string | null;
  visibility?: 'tenant' | 'user';
  body?: string;
  title?: string;
  updatedAt?: string;
  status?: string;
  governedStatus?: string;
  memoryClass?: string;
  memoryAuthority?: string;
  memoryScope?: string;
  sensitivity?: string;
  sourceHash?: string;
  sourceVersion?: string;
  effectiveFrom?: string | null;
  expiresAt?: string | null;
  conflictStatus?: string;
  controllingItemId?: string | null;
};

describe('canonical memory PostgreSQL qualification harness', () => {
  jest.setTimeout(180_000);

  let qualification: QualificationDatabase | undefined;
  let prisma: PrismaService | undefined;

  beforeAll(async () => {
    if (!adminUrl) {
      console.log('MEMORY_POSTGRES_DATABASE NOT_RUN mode=DB_FREE');
      return;
    }
    qualification = await createQualificationDatabase(adminUrl, requireVector);
    prisma = new PrismaService({ datasources: { db: { url: qualification.appUrl } } });
    await prisma.$connect();
    console.log(
      qualification.vectorAvailable
        ? 'MEMORY_POSTGRES_VECTOR RUN engine=postgresql extension=vector dimensions=1024'
        : 'MEMORY_POSTGRES_VECTOR NOT_RUN reason=extension_unavailable nonvector=RUN',
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await qualification?.dispose();
  });

  beforeEach(async () => {
    if (!qualification) return;
    const tables = qualification.vectorAvailable
      ? 'context_embeddings, memory_items, client_memory_access, clients, users, tenants'
      : 'memory_items, client_memory_access, clients, users, tenants';
    await qualification.admin.$executeRawUnsafe(`TRUNCATE ${tables} CASCADE`);
    await qualification.admin.$executeRaw(Prisma.sql`
      INSERT INTO tenants (id) VALUES (${TENANT}::uuid), (${OTHER_TENANT}::uuid)
    `);
    await qualification.admin.$executeRaw(Prisma.sql`
      INSERT INTO users (id) VALUES (${USER}::uuid), (${OTHER_USER}::uuid)
    `);
    await qualification.admin.$executeRaw(Prisma.sql`
      INSERT INTO clients (id, tenant_id, memory_wall) VALUES
        (${CLIENT}::uuid, ${TENANT}::uuid, true),
        (${OTHER_CLIENT}::uuid, ${TENANT}::uuid, false),
        (${FOREIGN_CLIENT}::uuid, ${OTHER_TENANT}::uuid, false)
    `);
    await grantWallAccess();
  });

  it('is DB_FREE-reviewable and refuses non-loopback targets', () => {
    const workflow = readFileSync(
      resolve(__dirname, '../../../../../.github/workflows/memory-postgres-qualification.yml'),
      'utf8',
    );
    expect(DDL_PROVENANCE.minimalParentFixtures).toEqual(['tenants', 'users', 'clients']);
    expect(DDL_PROVENANCE.canonicalRelations).toEqual([
      'client_memory_access',
      'memory_items',
      'context_embeddings',
    ]);
    expect(DDL_PROVENANCE.sourceMigrations).toContain(
      '20260712010000_memory_items_governance_fields',
    );
    expect(DDL_PROVENANCE.sourceMigrations).toContain(
      '20260713020000_memory_client_scope_ephemeral',
    );
    expect(DDL_PROVENANCE.sourceMigrations).toContain('20260719221000_memory_wall_rls');
    expect(QUALIFICATION_SCHEMA).not.toBe('public');
    expect(() =>
      assertDisposableLocalUrl('postgresql://user:password@db.example.com/capiro'),
    ).toThrow('refuses non-loopback');
    expect(
      assertDisposableLocalUrl('postgresql://user:password@127.0.0.1:55433/local').hostname,
    ).toBe('127.0.0.1');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('image: pgvector/pgvector:pg16');
    expect(workflow).toContain('pnpm install --frozen-lockfile');
    expect(workflow).toContain("MEMORY_POSTGRES_REQUIRE_VECTOR: '1'");
    expect(workflow).toContain('127.0.0.1:5432/postgres');
    expect(workflow).not.toMatch(/prisma migrate deploy|aws-actions|deploy/i);
  });

  databaseIt(
    'uses a NOSUPERUSER/NOBYPASSRLS/NOINHERIT app role and production SET LOCAL wrapper',
    async () => {
      const scoped = await prisma!.withTenantUser(TENANT, USER, (tx) =>
        tx.$queryRaw<
          Array<{
            currentUser: string;
            tenantGuc: string;
            userGuc: string;
            rolsuper: boolean;
            rolcreatedb: boolean;
            rolcreaterole: boolean;
            rolbypassrls: boolean;
            rolinherit: boolean;
            rolreplication: boolean;
            rolcanlogin: boolean;
            ownerMember: boolean;
          }>
        >(Prisma.sql`
        SELECT current_user AS "currentUser",
               current_setting('app.current_tenant', true) AS "tenantGuc",
               current_setting('app.current_user', true) AS "userGuc",
               r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls,
               r.rolinherit, r.rolreplication, r.rolcanlogin,
               pg_has_role(current_user, ${qualification!.ownerRole}, 'MEMBER') AS "ownerMember"
          FROM pg_roles r
         WHERE r.rolname = current_user
      `),
      );

      expect(scoped[0]).toEqual({
        currentUser: qualification!.appRole,
        tenantGuc: TENANT,
        userGuc: USER,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolbypassrls: false,
        rolinherit: false,
        rolreplication: false,
        rolcanlogin: true,
        ownerMember: false,
      });
      const outside = await prisma!.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS count FROM clients
    `);
      expect(outside[0]?.count).toBe(0);
    },
  );

  databaseIt(
    'enforces governed eligibility, tenant/private/client walls, and controlling claims',
    async () => {
      const active = '40000000-0000-4000-8000-000000000001';
      const stale = '40000000-0000-4000-8000-000000000002';
      const controlling = '40000000-0000-4000-8000-000000000003';
      await insertMemory({ id: active });
      await insertMemory({ id: stale, governedStatus: 'stale' });
      await insertMemory({
        id: controlling,
        governedStatus: 'conflicted',
        conflictStatus: 'controlling',
        controllingItemId: controlling,
      });
      await insertMemory({ id: '40000000-0000-4000-8000-000000000004', governedStatus: 'revoked' });
      await insertMemory({
        id: '40000000-0000-4000-8000-000000000005',
        tenantId: OTHER_TENANT,
        clientId: FOREIGN_CLIENT,
      });
      await insertMemory({
        id: '40000000-0000-4000-8000-000000000006',
        clientId: null,
        ownerUserId: OTHER_USER,
        visibility: 'user',
        memoryScope: 'user_private',
        memoryClass: 'user_preference',
        memoryAuthority: 'user_asserted',
      });
      await insertMemory({
        id: '40000000-0000-4000-8000-000000000007',
        clientId: OTHER_CLIENT,
      });
      await insertMemory({ id: '40000000-0000-4000-8000-000000000008', sensitivity: 'restricted' });
      await insertMemory({
        id: '40000000-0000-4000-8000-000000000009',
        effectiveFrom: '2999-01-01T00:00:00Z',
      });
      await insertMemory({
        id: '40000000-0000-4000-8000-000000000010',
        governedStatus: 'conflicted',
        conflictStatus: 'open',
        controllingItemId: null,
      });

      const result = await adapter(
        prisma!,
        provider(async () => axisVector(0)),
      ).retrieve(dataset, request());
      expect(result.records.map((record) => record.recordId).sort()).toEqual(
        [active, stale, controlling].sort(),
      );
      expect(
        result.records.find((record) => record.recordId === stale)?.payload.governance,
      ).toMatchObject({
        status: 'stale',
        stale: true,
      });

      await qualification!.admin.$executeRaw(Prisma.sql`
      DELETE FROM client_memory_access
       WHERE tenant_id = ${TENANT}::uuid AND client_id = ${CLIENT}::uuid AND user_id = ${USER}::uuid
    `);
      const denied = await adapter(
        prisma!,
        provider(async () => axisVector(0)),
      ).retrieve(dataset, request());
      expect(denied).toMatchObject({
        records: [],
        sourceStatus: 'unauthorized',
        stopReason: 'requested_client_scope_failed_ethical_wall',
      });
    },
  );

  databaseIt('rechecks wall grants and canonical revocation on a cursor', async () => {
    const firstId = '41000000-0000-4000-8000-000000000001';
    const secondId = '41000000-0000-4000-8000-000000000002';
    await insertMemory({ id: firstId, title: 'Alpha', updatedAt: '2026-01-02T00:00:00Z' });
    await insertMemory({ id: secondId, title: 'Beta', updatedAt: '2026-01-01T00:00:00Z' });
    const retrieval = adapter(
      prisma!,
      provider(async () => axisVector(0)),
    );
    const pagedRequest = request({ query: '', pageSize: 1 });
    const first = await retrieval.retrieve(dataset, pagedRequest);
    expect(first.nextCursor).toMatch(/^memory:v3:1:[a-f0-9]{64}$/);

    await qualification!.admin.$executeRaw(Prisma.sql`
      UPDATE memory_items
         SET governed_status = 'revoked', status = 'revoked', updated_at = now()
       WHERE id = ${secondId}::uuid
    `);
    const changed = await retrieval.retrieve(dataset, pagedRequest, first.nextCursor);
    expect(changed).toMatchObject({
      records: [],
      sourceStatus: 'degraded',
      stopReason: 'governed_memory_changed_restart_search',
    });
    const restarted = await retrieval.retrieve(dataset, pagedRequest);
    expect(restarted.records.map((record) => record.recordId)).not.toContain(secondId);

    await qualification!.admin.$executeRaw(Prisma.sql`
      UPDATE memory_items
         SET governed_status = 'active', status = 'active', updated_at = '2026-01-01T00:00:00Z'
       WHERE id = ${secondId}::uuid
    `);
    const wallCursor = await retrieval.retrieve(dataset, pagedRequest);
    await qualification!.admin.$executeRaw(Prisma.sql`
      DELETE FROM client_memory_access
       WHERE tenant_id = ${TENANT}::uuid AND client_id = ${CLIENT}::uuid AND user_id = ${USER}::uuid
    `);
    const denied = await retrieval.retrieve(dataset, pagedRequest, wallCursor.nextCursor);
    expect(denied).toMatchObject({ records: [], sourceStatus: 'unauthorized' });
  });

  databaseIt(
    'rejects malformed current-model query vectors without poisoning lexical fallback',
    async () => {
      const lexicalId = '42000000-0000-4000-8000-000000000001';
      await insertMemory({ id: lexicalId, body: 'qualification sentinel lexical fallback' });
      const malformed = [
        Array<number>(1023).fill(0.1),
        [...Array<number>(1023).fill(0.1), Number.NaN],
      ];

      for (const embedding of malformed) {
        const result = await adapter(
          prisma!,
          provider(async () => embedding),
        ).retrieve(dataset, request({ queryClass: 'semantic_recall' }));
        expect(result.records.map((record) => record.recordId)).toContain(lexicalId);
        expect(result).toMatchObject({
          sourceStatus: 'degraded',
          coverageComplete: false,
          stopReason: 'governed_memory_semantic_projection_incomplete',
        });
      }
    },
  );

  databaseIt(
    'uses genuine 1024-d vectors, exact current-model/source correlation, and canonical body versions',
    async () => {
      if (!qualification!.vectorAvailable) return;
      const currentBody = 'Current document body version two';
      const target = '50000000-0000-4000-8000-000000000001';
      const distractor = '50000000-0000-4000-8000-000000000002';
      await insertMemory({
        id: target,
        body: currentBody,
        sourceHash: 'canonical-document-v2-hash',
        sourceVersion: 'document-body:v2',
        updatedAt: '2026-01-01T00:00:00Z',
      });
      await insertMemory({
        id: distractor,
        body: 'Distractor current body',
        sourceHash: 'distractor-v2-hash',
        sourceVersion: 'document-body:v2',
        updatedAt: '2026-01-02T00:00:00Z',
      });
      await insertEmbedding(target, CURRENT_MODEL, axisVector(0), {
        contentText: 'Stale document body version one',
        contentHash: 'stale-document-v1-hash',
      });
      await insertEmbedding(target, OLD_MODEL, axisVector(1));
      await insertEmbedding(distractor, CURRENT_MODEL, axisVector(1));
      await insertEmbedding(distractor, OLD_MODEL, axisVector(0));
      await insertEmbedding(distractor, CURRENT_MODEL, axisVector(0), {
        sourceType: 'document',
        sourceId: 'unrelated-document',
      });
      await insertEmbedding(distractor, CURRENT_MODEL, axisVector(0), {
        tenantId: OTHER_TENANT,
        clientId: FOREIGN_CLIENT,
        sourceId: distractor,
      });

      const retrieval = adapter(
        prisma!,
        provider(async () => axisVector(0)),
      );
      const result = await retrieval.retrieve(
        dataset,
        request({
          queryClass: 'semantic_recall',
          query: 'tokens absent from both bodies',
          pageSize: 1,
        }),
      );
      expect(result.records[0]).toMatchObject({
        recordId: target,
        payload: { value: currentBody },
        provenance: {
          contentHash: 'canonical-document-v2-hash',
          sourceVersion: 'document-body:v2',
        },
        retrievalSignals: { semanticSimilarity: 1 },
      });
      expect(result.nextCursor).toBeDefined();

      await qualification!.admin.$executeRaw(Prisma.sql`
      UPDATE context_embeddings
         SET content_hash = 'stale-document-v1-hash-refreshed'
       WHERE tenant_id = ${TENANT}::uuid
         AND source_type = 'memory_item'
         AND source_id = ${target}
         AND model = ${CURRENT_MODEL}
    `);
      const changed = await retrieval.retrieve(
        dataset,
        request({
          queryClass: 'semantic_recall',
          query: 'tokens absent from both bodies',
          pageSize: 1,
        }),
        result.nextCursor,
      );
      expect(changed.stopReason).toBe('governed_memory_changed_restart_search');
    },
  );

  databaseIt('retains an old unembedded lexical body hit after 1000 embedded rows', async () => {
    if (!qualification!.vectorAvailable) return;
    const target = '51000000-0000-4000-8000-000000000001';
    const far = vectorLiteral(axisVector(1));
    await qualification!.admin.$executeRaw(Prisma.sql`
      INSERT INTO memory_items (
        id, tenant_id, client_id, type, visibility, slug, title, source, sections_jsonb,
        created_at, updated_at, status, memory_class, memory_authority, memory_scope,
        governed_status, source_type, source_id, source_content_hash, source_version,
        approved_by_user_id, approved_at, sensitivity, conflict_status
      )
      SELECT ('51000000-0000-4000-8001-' || lpad(i::text, 12, '0'))::uuid,
             ${TENANT}::uuid, ${CLIENT}::uuid, 'client-compass', 'tenant',
             'embedded-distractor-' || i, 'Embedded distractor ' || i, 'fixture',
             jsonb_build_array(jsonb_build_object('key','memory','heading','Memory','body','unrelated embedded body')),
             now() - (i || ' seconds')::interval, now() - (i || ' seconds')::interval,
             'active', 'client_steering', 'client_approved', 'client', 'active',
             'approved_document_edit', 'source-' || i, 'canonical-' || i, 'document-body:v1',
             ${USER}::uuid, now(), 'normal', 'none'
        FROM generate_series(1, 1000) AS i
    `);
    await qualification!.admin.$executeRaw(Prisma.sql`
      INSERT INTO context_embeddings (
        tenant_id, client_id, source_type, source_id, model, content_text, content_hash, embedding
      )
      SELECT ${TENANT}::uuid, ${CLIENT}::uuid, 'memory_item',
             ('51000000-0000-4000-8001-' || lpad(i::text, 12, '0')),
             ${CURRENT_MODEL}, 'unrelated embedded body', 'embedded-' || i, ${far}::vector
        FROM generate_series(1, 1000) AS i
    `);
    await insertMemory({
      id: target,
      body: 'The old lexical sentinel requires maritime approval.',
      title: 'Old canonical fact',
      updatedAt: '2020-01-01T00:00:00Z',
    });

    const result = await adapter(
      prisma!,
      provider(async () => axisVector(0)),
    ).retrieve(
      dataset,
      request({ queryClass: 'semantic_recall', query: 'maritime approval', pageSize: 500 }),
    );
    expect(result.records.map((record) => record.recordId)).toContain(target);
    expect(result).toMatchObject({
      returned: 500,
      truncated: true,
      sourceStatus: 'degraded',
      stopReason: 'governed_memory_safety_cap_reached',
    });
  });

  databaseIt(
    'retains a semantic-only hit beside 501 sparse NULL-projection lexical rows',
    async () => {
      if (!qualification!.vectorAvailable) return;
      const semanticOnly = '52000000-0000-4000-8000-000000000001';
      await qualification!.admin.$executeRaw(Prisma.sql`
      INSERT INTO memory_items (
        id, tenant_id, client_id, type, visibility, slug, title, source, sections_jsonb,
        created_at, updated_at, status, memory_class, memory_authority, memory_scope,
        governed_status, source_type, source_id, source_content_hash, source_version,
        approved_by_user_id, approved_at, sensitivity, conflict_status
      )
      SELECT ('52000000-0000-4000-8001-' || lpad(i::text, 12, '0'))::uuid,
             ${TENANT}::uuid, ${CLIENT}::uuid, 'client-compass', 'tenant',
             'sparse-' || i, 'Sparse lexical ' || i, 'fixture',
             jsonb_build_array(jsonb_build_object('key','memory','heading','Memory','body','sparse beacon lexical row')),
             now() - (i || ' seconds')::interval, now() - (i || ' seconds')::interval,
             'active', 'client_steering', 'client_approved', 'client', 'active',
             'approved_document_edit', 'sparse-source-' || i, 'sparse-' || i, 'document-body:v1',
             ${USER}::uuid, now(), 'normal', 'none'
        FROM generate_series(1, 501) AS i
    `);
      await insertMemory({
        id: semanticOnly,
        title: 'Old semantic result',
        body: 'No lexical overlap here',
        updatedAt: '2020-01-01T00:00:00Z',
      });
      await insertEmbedding(semanticOnly, CURRENT_MODEL, axisVector(0));

      const result = await adapter(
        prisma!,
        provider(async () => axisVector(0)),
      ).retrieve(
        dataset,
        request({ queryClass: 'semantic_recall', query: 'sparse beacon', pageSize: 500 }),
      );
      expect(result.records).toHaveLength(500);
      expect(result.records.map((record) => record.recordId)).toContain(semanticOnly);
      expect(
        result.records.find((record) => record.recordId === semanticOnly)?.retrievalSignals,
      ).toEqual({ semanticSimilarity: 1 });
    },
  );

  databaseIt(
    'observes a real vector-dimension abort and recovers in a fresh production transaction',
    async () => {
      if (!qualification!.vectorAvailable) return;
      let mismatchObserved = false;
      let abortedObserved = false;
      await expect(
        prisma!.$transaction(async (tx) => {
          try {
            await tx.$queryRawUnsafe("SELECT '[1,0]'::vector <=> '[1,0,0]'::vector");
          } catch (error) {
            mismatchObserved = String(error).includes('different vector dimensions');
          }
          try {
            await tx.$queryRawUnsafe('SELECT 1');
          } catch (error) {
            const candidate = error as { meta?: { code?: string }; message?: string };
            abortedObserved =
              candidate.meta?.code === '25P02' ||
              String(candidate.message).includes('current transaction is aborted');
            throw error;
          }
        }),
      ).rejects.toBeDefined();
      expect(mismatchObserved).toBe(true);
      expect(abortedObserved).toBe(true);

      const lexicalId = '53000000-0000-4000-8000-000000000001';
      await insertMemory({ id: lexicalId });
      const recovered = await adapter(
        prisma!,
        provider(async () => axisVector(0)),
      ).retrieve(dataset, request());
      expect(recovered.records.map((record) => record.recordId)).toContain(lexicalId);
    },
  );

  databaseIt('rolls back a real semantic SQL failure before lexical adapter fallback', async () => {
    if (!qualification!.vectorAvailable) return;
    const lexicalId = '54000000-0000-4000-8000-000000000001';
    await insertMemory({ id: lexicalId });
    await insertEmbedding(lexicalId, CURRENT_MODEL, axisVector(0));
    await qualification!.admin.$executeRawUnsafe(
      `REVOKE SELECT ON "${QUALIFICATION_SCHEMA}".context_embeddings FROM "${qualification!.appRole}"`,
    );
    try {
      const result = await adapter(
        prisma!,
        provider(async () => axisVector(0)),
      ).retrieve(dataset, request({ queryClass: 'semantic_recall' }));
      expect(result.records.map((record) => record.recordId)).toContain(lexicalId);
      expect(result).toMatchObject({
        sourceStatus: 'degraded',
        coverageComplete: false,
        stopReason: 'governed_memory_semantic_projection_incomplete',
      });
    } finally {
      await qualification!.admin.$executeRawUnsafe(
        `GRANT SELECT ON "${QUALIFICATION_SCHEMA}".context_embeddings TO "${qualification!.appRole}"`,
      );
    }
  });

  async function grantWallAccess(): Promise<void> {
    await qualification!.admin.$executeRaw(Prisma.sql`
      INSERT INTO client_memory_access (tenant_id, client_id, user_id, granted_by)
      VALUES (${TENANT}::uuid, ${CLIENT}::uuid, ${USER}::uuid, ${USER}::uuid)
    `);
  }

  async function insertMemory(fixture: MemoryFixture): Promise<void> {
    const tenantId = fixture.tenantId ?? TENANT;
    const clientId = fixture.clientId === undefined ? CLIENT : fixture.clientId;
    const ownerUserId = fixture.ownerUserId ?? null;
    const visibility = fixture.visibility ?? 'tenant';
    const body = fixture.body ?? 'qualification sentinel canonical fact';
    const updatedAt = fixture.updatedAt ?? '2026-01-01T00:00:00Z';
    const sections = JSON.stringify([{ key: 'memory', heading: 'Memory', body }]);
    await qualification!.admin.$executeRaw(Prisma.sql`
      INSERT INTO memory_items (
        id, tenant_id, client_id, owner_user_id, type, visibility, slug, title, source,
        sections_jsonb, created_at, updated_at, status, memory_class, memory_authority,
        memory_scope, governed_status, source_type, source_id, source_content_hash,
        source_version, approved_by_user_id, approved_at, sensitivity, effective_from,
        expires_at, conflict_status, controlling_item_id
      ) VALUES (
        ${fixture.id}::uuid, ${tenantId}::uuid, ${clientId}::uuid, ${ownerUserId}::uuid,
        'client-compass', ${visibility}, ${`fixture-${fixture.id}`},
        ${fixture.title ?? 'Qualification memory'}, 'fixture', ${sections}::jsonb,
        ${updatedAt}::timestamptz, ${updatedAt}::timestamptz, ${fixture.status ?? 'active'},
        ${fixture.memoryClass ?? 'client_steering'},
        ${fixture.memoryAuthority ?? 'client_approved'},
        ${fixture.memoryScope ?? 'client'}, ${fixture.governedStatus ?? 'active'},
        'approved_document_edit', ${`source-${fixture.id}`},
        ${fixture.sourceHash ?? `canonical-${fixture.id}`},
        ${fixture.sourceVersion ?? 'document-body:v1'}, ${USER}::uuid, now(),
        ${fixture.sensitivity ?? 'normal'}, ${fixture.effectiveFrom}::timestamptz,
        ${fixture.expiresAt}::timestamptz, ${fixture.conflictStatus ?? 'none'},
        ${fixture.controllingItemId}::uuid
      )
    `);
  }

  async function insertEmbedding(
    memoryId: string,
    model: string,
    embedding: readonly number[],
    overrides: {
      tenantId?: string;
      clientId?: string;
      sourceType?: string;
      sourceId?: string;
      contentText?: string;
      contentHash?: string;
    } = {},
  ): Promise<void> {
    await qualification!.admin.$executeRaw(Prisma.sql`
      INSERT INTO context_embeddings (
        tenant_id, client_id, source_type, source_id, model, content_text, content_hash, embedding
      ) VALUES (
        ${overrides.tenantId ?? TENANT}::uuid, ${overrides.clientId ?? CLIENT}::uuid,
        ${overrides.sourceType ?? 'memory_item'}, ${overrides.sourceId ?? memoryId}, ${model},
        ${overrides.contentText ?? 'fixture projection'},
        ${overrides.contentHash ?? `embedding-${memoryId}-${model}`},
        ${vectorLiteral(embedding)}::vector
      )
    `);
  }
});
