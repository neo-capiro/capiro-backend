import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
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
import { buildCoverageManifest } from '../coverage-manifest.js';
import { searchGovernedMemory } from '../../meri/meri-memory-search.js';
import { readMeriGraph } from '../../meri/meri-graph-source.js';
import { installGraphFixture } from '../../../test/memory-postgres-qualification/graph-fixture.js';
import { ForbiddenException, HttpException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { canonicalSha256 } from '../../auth/read-delegation/read-delegation.contract.js';
import { readPassiveMemoryPage } from '../../meri/memory-receiving/meri-memory-page-source.js';
import { checkPassiveMemoryEligibility } from '../../meri/memory-receiving/meri-passive-memory-source.js';

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
const requireVector = process.env.MEMORY_POSTGRES_REQUIRE_VECTOR === '1';
const adminUrl = qualificationAdminUrl();
const databaseIt = adminUrl ? it : it.skip;
const semanticIt = adminUrl && requireVector ? it : it.skip;
const meriCompositionIt = adminUrl && process.env.MEMORY_MERI_SOURCE_ROOT ? it : it.skip;

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
    await installGraphFixture(qualification);
    prisma = new PrismaService({ datasources: { db: { url: qualification.appUrl } } });
    await prisma.$connect();
    console.log(
      requireVector && qualification.vectorAvailable
        ? 'MEMORY_POSTGRES_VECTOR RUN engine=postgresql extension=vector dimensions=1024'
        : `MEMORY_POSTGRES_VECTOR NOT_RUN reason=optional_mode extension=${qualification.vectorAvailable ? 'available' : 'unavailable'} semantic_tests=SKIP nonvector=RUN`,
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

  it('is DB_FREE-reviewable and fails closed before database setup', () => {
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
      assertDisposableLocalUrl(
        'postgresql://user:password@db.example.com:5432/capiro',
        'db.example.com:5432',
      ),
    ).toThrow('requires the IPv4 loopback host');
    expect(
      assertDisposableLocalUrl(
        'postgresql://user:password@127.0.0.1:55433/local',
        '127.0.0.1:55433',
      ).hostname,
    ).toBe('127.0.0.1');
    expect(() =>
      assertDisposableLocalUrl(
        'postgresql://user:password@localhost:55433/local',
        '127.0.0.1:55433',
      ),
    ).toThrow('requires the IPv4 loopback host');
    expect(() =>
      assertDisposableLocalUrl('postgresql://user:password@127.0.0.1/local', '127.0.0.1:5432'),
    ).toThrow('requires an explicit loopback port');
    expect(() =>
      assertDisposableLocalUrl('postgresql://127.0.0.1:55433/local', '127.0.0.1:55433'),
    ).toThrow('requires explicit database credentials');
    expect(() =>
      assertDisposableLocalUrl(
        'postgresql://user:password@127.0.0.1:55433/local',
        '127.0.0.1:5432',
      ),
    ).toThrow('must match the explicitly owned qualification endpoint');
    expect(() =>
      qualificationAdminUrl({
        MEMORY_POSTGRES_REQUIRE_VECTOR: '1',
        MEMORY_POSTGRES_DB_FREE: '1',
      }),
    ).toThrow('conflicts with MEMORY_POSTGRES_DB_FREE');
    expect(() => qualificationAdminUrl({ MEMORY_POSTGRES_REQUIRE_VECTOR: '1' })).toThrow(
      'requires MEMORY_POSTGRES_ADMIN_URL or MEMORY_POSTGRES_CREDENTIALS_FILE',
    );
    expect(() =>
      qualificationAdminUrl({
        MEMORY_POSTGRES_REQUIRE_VECTOR: '1',
        MEMORY_POSTGRES_ADMIN_URL: ' ',
        MEMORY_POSTGRES_CREDENTIALS_FILE: ' ',
      }),
    ).toThrow('requires MEMORY_POSTGRES_ADMIN_URL or MEMORY_POSTGRES_CREDENTIALS_FILE');
    expect(() =>
      qualificationAdminUrl({
        MEMORY_POSTGRES_REQUIRE_VECTOR: '1',
        MEMORY_POSTGRES_ADMIN_URL: 'postgresql://127.0.0.1:55433/postgres',
        MEMORY_POSTGRES_OWNED_ENDPOINT_ACK: '127.0.0.1:55433',
      }),
    ).toThrow('requires explicit database credentials');
    expect(() =>
      qualificationAdminUrl({
        MEMORY_POSTGRES_REQUIRE_VECTOR: '1',
        MEMORY_POSTGRES_CREDENTIALS_FILE: resolve(
          __dirname,
          'qualification-credentials-do-not-exist.json',
        ),
      }),
    ).toThrow('MEMORY_POSTGRES_CREDENTIALS_FILE does not exist');
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

  semanticIt(
    'uses the embedding as a derived ranking projection while returning the current canonical body/version',
    async () => {
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

  semanticIt('retains an old unembedded lexical body hit after 1000 embedded rows', async () => {
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

  semanticIt(
    'retains a semantic-only hit beside 501 sparse NULL-projection lexical rows',
    async () => {
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

  semanticIt(
    'observes a real vector-dimension abort and recovers in a fresh production transaction',
    async () => {
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

  semanticIt('rolls back a real semantic SQL failure before lexical adapter fallback', async () => {
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

  // These cases exercise Core's page and eligibility owners with real SQL and
  // ordinary-role RLS. Meri transport/composer release is a separate integration
  // check; this fixture does not substitute for it.
  describe('Core page and current eligibility over PostgreSQL', () => {
    const PERSONAL = '42000000-0000-4000-8000-000000000001';
    const FIRM = '42000000-0000-4000-8000-000000000002';
    const CLIENT_ITEM = '42000000-0000-4000-8000-000000000003';
    const SUPERSEDED = '42000000-0000-4000-8000-000000000004';
    const EXPIRED = '42000000-0000-4000-8000-000000000005';
    const REVOKED = '42000000-0000-4000-8000-000000000006';
    const HELD = '42000000-0000-4000-8000-000000000007';
    const POLICY = 'item01-rev-1';
    const memoryContext = {
      tenantId: TENANT,
      userId: USER,
      role: 'standard_user',
    } as TenantContext;

    const wire = (selected: string | null) => ({
      input: {
        query: 'qualification memory',
        clientId: selected,
        k: 3,
        cursor: null,
        memoryItemId: null,
        contentCursor: null,
      },
      metadata: {
        sourceConnected: false,
        authoritative: false,
        currentPolicyQualified: false,
        cursorAuthenticated: false,
        absenceEvidence: false,
      },
    });

    const retainedContext = (selected: string | null) => ({
      binding: {
        tenantId: TENANT,
        actorId: USER,
        conversationId: '43000000-0000-4000-8000-000000000001',
        runId: '43000000-0000-4000-8000-000000000002',
        attemptId: '43000000-0000-4000-8000-000000000003',
        workerId: '43000000-0000-4000-8000-000000000004',
        writerFence: 1,
      },
      subject: {
        kind: selected === null ? 'personal' : 'client',
        entityType: selected === null ? 'user' : 'client',
        entityIds: [selected ?? USER],
        tenantId: TENANT,
        actorId: USER,
        policyRevision: POLICY,
        scopes: [
          {
            tenantId: TENANT,
            kind: selected === null ? 'private-user' : 'client',
            resourceId: selected ?? USER,
            policyRevision: POLICY,
          },
        ],
        rosterVersionId: null,
      },
      policyRevision: POLICY,
      normalizationContext: { tenantId: TENANT, userId: USER },
    });

    /** Fixture supplies the scope already resolved by the caller; the real
     * retrieval adapter independently enforces the current database wall. */
    const memoryTools = {
      executeFromAuthenticatedUser: async (
        ctx: TenantContext,
        tool: string,
        input: Record<string, unknown>,
      ) => {
        expect(tool).toBe('search_memory');
        return searchGovernedMemory(ctx, input, {
          async searchToolData(actor, selection) {
            const page = await adapter(
              prisma!,
              provider(async () => []),
            ).retrieve(
              dataset,
              request({
                query: selection.query ?? undefined,
                queryClass: 'lookup',
                memoryItemId: selection.memoryItemId ?? undefined,
                caller: {
                  tenantId: actor.tenantId,
                  userId: actor.userId,
                  clientIds: selection.clientId ? [selection.clientId] : [],
                  authorizedClientIds: selection.clientId ? [selection.clientId] : [],
                },
                pageSize: selection.pageSize,
              }),
              selection.cursors?.institutional_knowledge,
            );
            const coverage = buildCoverageManifest(['institutional_knowledge'], [page]);
            return {
              records: page.records,
              coverage,
              observability: {
                queryClass: selection.queryClass,
                requestedDomains: ['institutional_knowledge'],
                queriedDatasets: ['institutional_knowledge'],
                requestedEntityCount: page.requestedEntityCount,
                queriedEntityCount: page.searchedEntityCount,
                pagesByDomain: { institutional_knowledge: page.pagesRead },
                sourceHealth: { institutional_knowledge: page.sourceStatus },
                freshnessByDomain: { institutional_knowledge: page.lastSyncAt },
                coverageComplete: coverage.complete,
                stopReason: page.stopReason,
              },
            };
          },
        });
      },
    };

    const readPage = (selected: string | null) =>
      readPassiveMemoryPage(
        memoryContext,
        wire(selected),
        retainedContext(selected),
        true,
        Date.now() + 10_000,
        memoryTools as never,
      );

    const eligibilityRequest = (selected: string | null, ids: readonly string[]) => {
      const body = wire(selected);
      return {
        operation: { id: 'search_memory', version: '0.2.0' },
        ...body,
        normalizationContext: { tenantId: TENANT, userId: USER },
        argumentsSha256: canonicalSha256(body.input),
        requestSha256: canonicalSha256(body),
        binding: retainedContext(selected).binding,
        subject: retainedContext(selected).subject,
        policyRevision: POLICY,
        sourceIds: ['client_knowledge_memory'],
        resultSha256: 'a'.repeat(64),
        records: ids.map((id) => ({ memoryItemId: id, recordSha256: 'b'.repeat(64) })),
        deadlineMs: Date.now() + 10_000,
      };
    };
    const release = (selected: string | null, ids: readonly string[]) =>
      checkPassiveMemoryEligibility(prisma!, memoryContext, eligibilityRequest(selected, ids));

    const pageIds = (page: unknown) =>
      ((page as { records?: Array<{ recordId: string }> }).records ?? []).map((r) => r.recordId);

    async function throughMeri(
      selected: string | null,
      afterPage?: () => Promise<void>,
      graphSource?: 'legacy' | 'cache',
    ) {
      const calls: string[] = [];
      const failures: string[] = [];
      const server = createServer(async (req, res) => {
        try {
          expect(req.headers.authorization).toBe(
            graphSource ? 'Bearer SYNTHETIC_NATIVE_USER' : 'Bearer SYNTHETIC_USER',
          );
          expect(req.headers['x-internal-service-secret']).toBe(
            graphSource ? 'SYNTHETIC_INTERNAL_SERVICE' : 'SYNTHETIC_SERVICE',
          );
          let bytes = '';
          for await (const chunk of req) bytes += String(chunk);
          const body = JSON.parse(bytes);
          calls.push(req.url!);
          let result: unknown;
          if (req.url === '/api/clio/tools/search_memory') {
            const correlation = JSON.parse(
              Buffer.from(String(req.headers['x-meri-read-correlation']), 'base64url').toString(),
            );
            result = await readPassiveMemoryPage(
              memoryContext,
              body,
              correlation,
              true,
              Number(req.headers['x-meri-deadline-at']),
              memoryTools,
            );
            await afterPage?.();
          } else if (req.url === '/api/clio/tools/search_memory_eligibility') {
            result = await checkPassiveMemoryEligibility(prisma!, memoryContext, body);
          } else if (req.url === '/api/clio/tools/query_knowledge_graph' && graphSource) {
            result = await readMeriGraph(prisma!, memoryContext, body, graphSource);
          } else throw new Error('Unexpected fixture route');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
          res.writeHead(error instanceof HttpException ? error.getStatus() : 500, {
            'content-type': 'application/json',
          });
          res.end(
            JSON.stringify({
              code: error instanceof ForbiddenException ? 'ACCESS_DENIED' : 'FIXTURE_FAILURE',
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });
      await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
      try {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Missing local fixture address');
        const result = await new Promise<{ status: number; body: { resultJson?: string } }>(
          (resolveResult, reject) => {
            const child = spawn(
              process.execPath,
              [
                resolve(
                  __dirname,
                  '../../../test/memory-postgres-qualification/meri-recall-client.mjs',
                ),
              ],
              { env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
            );
            let stdout = '',
              stderr = '';
            const timer = setTimeout(() => {
              child.kill();
              reject(new Error('Meri fixture timed out'));
            }, 30_000);
            child.stdout.on('data', (chunk) => {
              stdout += String(chunk);
            });
            child.stderr.on('data', (chunk) => {
              stderr += String(chunk);
            });
            child.on('error', (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.on('exit', (code) => {
              clearTimeout(timer);
              if (code !== 0) return reject(new Error(`Meri fixture exited ${code}: ${stderr}`));
              try {
                resolveResult(JSON.parse(stdout));
              } catch (error) {
                reject(error);
              }
            });
            child.stdin.end(
              JSON.stringify({
                port: address.port,
                tenantId: TENANT,
                userId: USER,
                clientId: selected,
                ...(graphSource ? { operation: 'query_knowledge_graph' } : {}),
              }),
            );
          },
        );
        return { ...result, calls, failures };
      } finally {
        server.closeAllConnections();
        await new Promise<void>((closed) => server.close(() => closed()));
      }
    }

    meriCompositionIt(
      'releases canonical SQL content through the actual Meri runtime composer',
      async () => {
        await insertMemory({
          id: CLIENT_ITEM,
          clientId: CLIENT,
          body: 'qualification memory: item01 protected content',
        });
        const result = await throughMeri(CLIENT);
        expect(result.status).toBe(200);
        expect(result.calls).toEqual([
          '/api/clio/tools/search_memory',
          '/api/clio/tools/search_memory_eligibility',
        ]);
        expect(result.body.resultJson).toContain('item01 protected content');
        expect(JSON.parse(result.body.resultJson!).result.records[0].recordId).toBe(CLIENT_ITEM);
      },
    );

    meriCompositionIt(
      'withholds the already-read content in Meri after a database wall revocation',
      async () => {
        await insertMemory({
          id: CLIENT_ITEM,
          clientId: CLIENT,
          body: 'qualification memory: item01 protected content',
        });
        const result = await throughMeri(CLIENT, async () => {
          await qualification!.admin.$executeRaw(Prisma.sql`DELETE FROM client_memory_access
          WHERE tenant_id = ${TENANT}::uuid AND client_id = ${CLIENT}::uuid AND user_id = ${USER}::uuid`);
        });
        expect(result.status).toBe(403);
        expect(result.calls).toEqual([
          '/api/clio/tools/search_memory',
          '/api/clio/tools/search_memory_eligibility',
        ]);
        expect(JSON.stringify(result.body)).not.toContain('item01 protected content');
      },
    );

    meriCompositionIt(
      'withholds the already-read content in Meri after canonical supersession',
      async () => {
        await insertMemory({
          id: CLIENT_ITEM,
          clientId: CLIENT,
          body: 'qualification memory: item01 protected content',
        });
        const result = await throughMeri(CLIENT, async () => {
          await qualification!.admin
            .$executeRaw(Prisma.sql`UPDATE memory_items SET governed_status = 'superseded'
          WHERE id = ${CLIENT_ITEM}::uuid`);
        });
        expect(result.status).toBe(403);
        expect(result.calls).toHaveLength(2);
        expect(JSON.stringify(result.body)).not.toContain('item01 protected content');
      },
    );

    for (const change of ['expired', 'revoked', 'private-owner', 'forgotten'] as const) {
      meriCompositionIt(
        `withholds content when ${change} changes between SQL read and Meri release`,
        async () => {
          await insertMemory({
            id: CLIENT_ITEM,
            clientId: CLIENT,
            body: 'qualification memory: item01 protected content',
          });
          const result = await throughMeri(CLIENT, async () => {
            const mutation =
              change === 'expired'
                ? Prisma.sql`UPDATE memory_items SET expires_at = now() - interval '1 second' WHERE id = ${CLIENT_ITEM}::uuid`
                : change === 'revoked'
                  ? Prisma.sql`UPDATE memory_items SET governed_status = 'revoked' WHERE id = ${CLIENT_ITEM}::uuid`
                  : change === 'private-owner'
                    ? Prisma.sql`UPDATE memory_items SET visibility = 'user', owner_user_id = ${OTHER_USER}::uuid, memory_scope = 'user_private' WHERE id = ${CLIENT_ITEM}::uuid`
                    : Prisma.sql`DELETE FROM memory_items WHERE id = ${CLIENT_ITEM}::uuid`;
            await qualification!.admin.$executeRaw(mutation);
          });
          expect(result.status).toBe(403);
          expect(JSON.stringify(result.body)).not.toContain('item01 protected content');
        },
      );
    }

    meriCompositionIt(
      'passes only current graph destinations and reports failed cache reads as unavailable through Meri',
      async () => {
        await insertMemory({ id: FIRM, clientId: null, memoryScope: 'firm' });
        await insertMemory({
          id: PERSONAL,
          clientId: null,
          visibility: 'user',
          ownerUserId: OTHER_USER,
          memoryScope: 'user_private',
          memoryClass: 'user_preference',
          memoryAuthority: 'user_asserted',
        });
        await insertMemory({ id: SUPERSEDED, clientId: OTHER_CLIENT });
        await qualification!.admin.$executeRaw(
          Prisma.sql`INSERT INTO congress_bill (id) VALUES ('synthetic-public-bill')`,
        );
        await qualification!.admin
          .$executeRaw(Prisma.sql`INSERT INTO memory_edges (tenant_id, src_item_id, relation, dst_type, dst_slug) VALUES
        (${TENANT}::uuid, ${FIRM}::uuid, 'mentions', 'client', ${CLIENT}),
        (${TENANT}::uuid, ${FIRM}::uuid, 'mentions', 'client', ${FOREIGN_CLIENT}),
        (${TENANT}::uuid, ${FIRM}::uuid, 'mentions', 'client-compass', ${`fixture-${PERSONAL}`}),
        (${TENANT}::uuid, ${FIRM}::uuid, 'mentions', 'bill', 'synthetic-public-bill'),
        (${TENANT}::uuid, ${FIRM}::uuid, 'mentions', 'client-compass', ${`fixture-${SUPERSEDED}`})`);
        const before = await throughMeri(null, undefined, 'legacy');
        expect({
          status: before.status,
          failures: before.failures,
          calls: before.calls,
          code: (before.body as { code?: string }).code,
        }).toEqual({
          status: 200,
          failures: [],
          calls: ['/api/clio/tools/query_knowledge_graph'],
          code: undefined,
        });
        const beforeGraph = JSON.parse(before.body.resultJson!).result;
        expect(beforeGraph.nodes.map((n: { id: string }) => n.id)).toContain(`client:${CLIENT}`);
        expect(beforeGraph.nodes.map((n: { id: string }) => n.id)).toContain(
          `client-compass:fixture-${SUPERSEDED}`,
        );
        expect(JSON.stringify(beforeGraph)).not.toContain(PERSONAL);
        expect(JSON.stringify(beforeGraph)).not.toContain(FOREIGN_CLIENT);
        const scoped = await throughMeri(CLIENT, undefined, 'legacy');
        expect(scoped.status).toBe(200);
        expect(scoped.body.resultJson).not.toContain(SUPERSEDED);
        await qualification!.admin.$executeRaw(
          Prisma.sql`DELETE FROM client_memory_access WHERE client_id = ${CLIENT}::uuid`,
        );
        for (const source of ['legacy', 'cache'] as const) {
          const result = await throughMeri(null, undefined, source);
          if (source === 'cache') {
            expect(result.status).toBe(503);
            expect(result.body).toEqual({ code: 'UNAVAILABLE' });
            continue;
          }
          expect(result.status).toBe(200);
          const graph = JSON.parse(result.body.resultJson!).result;
          expect(graph.nodes.map((n: { id: string }) => n.id)).toContain(
            'bill:synthetic-public-bill',
          );
          expect(JSON.stringify(graph)).not.toContain(CLIENT);
          expect(JSON.stringify(graph)).not.toContain(FOREIGN_CLIENT);
          expect(JSON.stringify(graph)).not.toContain(PERSONAL);
        }
      },
    );

    meriCompositionIt(
      'releases eligible General personal and firm memory through Core and Meri without client borrowing',
      async () => {
        await insertMemory({
          id: PERSONAL,
          clientId: null,
          ownerUserId: USER,
          visibility: 'user',
          memoryScope: 'user_private',
          memoryClass: 'user_preference',
          memoryAuthority: 'user_asserted',
        });
        await insertMemory({
          id: FIRM,
          clientId: null,
          memoryScope: 'firm',
          visibility: 'tenant',
          memoryClass: 'institutional_authoritative',
          memoryAuthority: 'firm_approved',
        });
        await insertMemory({ id: CLIENT_ITEM, clientId: CLIENT });

        const page = await readPage(null);
        // General scope reads permitted personal and firm memory and never borrows a
        // client-only item into the page.
        expect(pageIds(page).sort()).toEqual([PERSONAL, FIRM].sort());
        const released = await release(null, pageIds(page));
        expect(
          released.records
            .map((record) => [record.memoryItemId, record.eligibleForRecall])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ).toEqual(
          [
            [PERSONAL, true],
            [FIRM, true],
          ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        );
        const result = await throughMeri(null);
        expect(result.status).toBe(200);
        const records = JSON.parse(result.body.resultJson!).result.records;
        expect(records.map((r: { recordId: string }) => r.recordId).sort()).toEqual(
          [PERSONAL, FIRM].sort(),
        );
      },
    );

    databaseIt(
      'releases granted client-scope memory and refuses it once the wall grant is removed after the page',
      async () => {
        await insertMemory({ id: CLIENT_ITEM, clientId: CLIENT });
        const page = await readPage(CLIENT);
        expect(pageIds(page)).toEqual([CLIENT_ITEM]);
        expect((await release(CLIENT, [CLIENT_ITEM])).records[0]).toMatchObject({
          memoryItemId: CLIENT_ITEM,
          eligibleForRecall: true,
        });

        // Current access is revoked between page retrieval and release: the page that
        // was already returned can no longer be released.
        await qualification!.admin.$executeRaw(Prisma.sql`
        DELETE FROM client_memory_access
         WHERE tenant_id = ${TENANT}::uuid AND client_id = ${CLIENT}::uuid AND user_id = ${USER}::uuid
      `);
        await expect(release(CLIENT, [CLIENT_ITEM])).rejects.toBeInstanceOf(ForbiddenException);
        // A revoked wall grant is not an empty result: the page itself now reports the
        // denied client scope instead of a complete empty page.
        const afterRevocation = await readPage(CLIENT);
        expect(pageIds(afterRevocation)).toEqual([]);
        expect(afterRevocation).toMatchObject({
          coverage: { sources: [{ sourceStatus: 'unauthorized', coverageComplete: false }] },
        });
        await grantWallAccess();
      },
    );

    databaseIt(
      'withholds superseded, expired and revoked items at the same release boundary',
      async () => {
        await insertMemory({ id: SUPERSEDED, governedStatus: 'superseded' });
        await insertMemory({ id: EXPIRED, expiresAt: '2020-01-01T00:00:00Z' });
        await insertMemory({ id: REVOKED, governedStatus: 'revoked' });
        const page = await readPage(CLIENT);
        expect(pageIds(page)).toEqual([]);
        for (const withheld of [SUPERSEDED, EXPIRED, REVOKED]) {
          await expect(release(CLIENT, [withheld])).rejects.toBeInstanceOf(ForbiddenException);
        }
      },
    );

    databaseIt('does not let legal hold alone suppress otherwise eligible recall', async () => {
      await insertMemory({ id: HELD, clientId: CLIENT });
      await qualification!.admin.$executeRaw(Prisma.sql`
        UPDATE memory_items SET legal_hold = true WHERE id = ${HELD}::uuid
      `);
      const page = await readPage(CLIENT);
      expect(pageIds(page)).toEqual([HELD]);
      const released = await release(CLIENT, [HELD]);
      expect(released.records[0]).toMatchObject({ memoryItemId: HELD, eligibleForRecall: true });
    });
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
