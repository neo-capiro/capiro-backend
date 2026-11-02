import { PrismaClient, type Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { performance } from 'node:perf_hooks';
import { BILL_EXTRACTION_VERSION, structureText } from '../ingestion/bill-document-structure.js';
import { CHUNKER_VERSION } from '../ingestion/bill-text-passages.js';
import { BillTextService } from './bill-text.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import {
  BILL_JURISDICTIONS,
  billTextSearchQuery,
  validateBillTextSearch,
} from './bill-text-query.js';
import {
  STATE_BILL_COVERAGE_SQL,
  STATE_FORMAT_COVERAGE_SQL,
  FEDERAL_BILL_COVERAGE_SQL,
} from './bill-text-coverage.js';
import { loadPinnedStateInventory } from '../ingestion/state-bill-inventory-read.js';
import { loadPinnedFederalInventory } from '../ingestion/federal-bill-inventory-read.js';
import { withBillPassageWriter } from '../../scripts/embed-bill-passages.js';
import { withStateBillWriter } from '../ingestion/state-bill-writer.js';
import { withFederalBillWriter } from '../ingestion/federal-bill-writer.js';
import {
  loadProvenBillPassages,
  billPassageIsProven,
} from '../ingestion/bill-passage-embedding.js';

// Root supplies a disposable synthetic database. This test never uses DATABASE_URL implicitly.
const url = process.env.BILL_TEXT_SEARCH_TEST_DATABASE_URL;
const pg = url ? describe : describe.skip;
pg('bill text PostgreSQL contract', () => {
  it('shares dataset leases across global, state, extraction and embedding entry scopes and fences an expired owner', async () => {
    const parsed = new URL(url!);
    if (
      process.env.CAPIRO_DISPOSABLE_PG !== '1' ||
      parsed.pathname !== '/bill_text_test' ||
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)
    )
      throw Error('DISPOSABLE_LOCAL_BILL_TEXT_TEST_DATABASE_REQUIRED');
    const admin = new PrismaClient({ datasources: { db: { url: url! } } });
    const schema = 'bill_passage_writer_' + randomUUID().replaceAll('-', '');
    let db: PrismaClient | undefined;
    let created = false;
    try {
      await admin.$executeRawUnsafe(`CREATE SCHEMA ${schema}`);
      created = true;
      parsed.searchParams.set('schema', schema);
      db = new PrismaClient({ datasources: { db: { url: parsed.href } } });
      const database = db;
      const migration = readFileSync(
        join(
          process.cwd(),
          'prisma/migrations/20280924030000_federal_legislative_evidence/migration.sql',
        ),
        'utf8',
      );
      const checkpoint = migration.match(
        /CREATE TABLE "federal_evidence_checkpoint" \([\s\S]*?\n\);/,
      )?.[0];
      if (!checkpoint) throw Error('CANONICAL_CHECKPOINT_CONTRACT_MISSING');
      await database.$executeRawUnsafe(checkpoint);
      await database.$executeRawUnsafe('CREATE TABLE marker(value integer)');
      await database.$executeRawUnsafe('INSERT INTO marker VALUES(0)');
      const global = { source: 'state' as const, states: [] };
      const florida = { source: 'state' as const, states: ['FL'] };
      const federal = { source: 'federal' as const, states: [] };
      const loser = jest.fn(async () => {});
      // Phases have separate progress cursors, but the entry scopes below are
      // deliberately phase/model independent and use the ordinary writer owner.
      await withBillPassageWriter(database, global, async (writer) => {
        await expect(withBillPassageWriter(database, florida, loser)).rejects.toThrow(
          'STATE_WRITER_ALREADY_RUNNING',
        );
        await expect(withStateBillWriter(database, ['FL'], loser)).rejects.toThrow(
          'STATE_WRITER_ALREADY_RUNNING',
        );
        await writer.$executeRawUnsafe('UPDATE marker SET value=1');
      });
      await withBillPassageWriter(database, florida, async (writer) => {
        await expect(withBillPassageWriter(database, global, loser)).rejects.toThrow(
          'STATE_WRITER_ALREADY_RUNNING',
        );
        // The failed global acquisition releases its earlier state leases only.
        await writer.$executeRawUnsafe('UPDATE marker SET value=2');
      });
      await withBillPassageWriter(database, federal, async (writer) => {
        await expect(withBillPassageWriter(database, federal, loser)).rejects.toThrow(
          'FEDERAL_WRITER_ALREADY_RUNNING',
        );
        await expect(withFederalBillWriter(database, loser)).rejects.toThrow(
          'FEDERAL_WRITER_ALREADY_RUNNING',
        );
        await writer.$executeRawUnsafe('UPDATE marker SET value=3');
      });
      expect(loser).not.toHaveBeenCalled();
      await withBillPassageWriter(database, global, async (stale) => {
        await database.$executeRawUnsafe(
          "UPDATE federal_evidence_checkpoint SET lease_until=clock_timestamp()-interval '1 second' WHERE source='state-bills:FL'",
        );
        await withBillPassageWriter(database, florida, async (successor) => {
          await expect(stale.$executeRawUnsafe('UPDATE marker SET value=99')).rejects.toThrow(
            'STATE_WRITER_LEASE_LOST',
          );
          await successor.$executeRawUnsafe('UPDATE marker SET value=4');
        });
      });
      expect(await database.$queryRawUnsafe('SELECT value FROM marker')).toEqual([{ value: 4 }]);
      expect(
        await database.$queryRawUnsafe(
          'SELECT count(*)::int n FROM federal_evidence_checkpoint WHERE lease_token IS NOT NULL',
        ),
      ).toEqual([{ n: 0 }]);
    } finally {
      await db?.$disconnect();
      if (created) await admin.$executeRawUnsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.$disconnect();
    }
  }, 60000);
  it('bounds the indexed public vector stage under FORCE RLS using a non-bypass application role', async () => {
    const parsed = new URL(url!);
    if (
      process.env.CAPIRO_DISPOSABLE_PG !== '1' ||
      parsed.pathname !== '/bill_text_test' ||
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)
    )
      throw Error('DISPOSABLE_LOCAL_BILL_TEXT_TEST_DATABASE_REQUIRED');
    const db = new Client({ connectionString: url });
    const schema = 'bill_ann_' + randomUUID().replace(/-/g, '');
    const role = schema + '_app';
    await db.connect();
    try {
      await db.query('BEGIN');
      // Schema and role are created in this transaction and rolled back even
      // after success. No shared schema, policy, role or setting is changed.
      await db.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema},public;
        CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS NOINHERIT NOLOGIN;
        CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE plpgsql STABLE AS $$
          BEGIN RETURN current_setting('app.bypass_rls',true)='on'; END $$;
        CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE plpgsql STABLE AS $$
          BEGIN RETURN nullif(current_setting('app.current_tenant',true),'')::uuid;
          EXCEPTION WHEN invalid_text_representation THEN RETURN NULL; END $$;
        CREATE FUNCTION current_user_id() RETURNS uuid LANGUAGE plpgsql STABLE AS $$
          BEGIN RETURN nullif(current_setting('app.current_user',true),'')::uuid;
          EXCEPTION WHEN invalid_text_representation THEN RETURN NULL; END $$;
        CREATE TABLE clients(id uuid,tenant_id uuid,memory_wall boolean);
        CREATE TABLE client_memory_access(tenant_id uuid,client_id uuid,user_id uuid);
        CREATE TABLE memory_items(id uuid,tenant_id uuid,retention_subject_id uuid);
        CREATE FUNCTION memory_retention_visible(uuid,uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$ BEGIN RETURN false; END $$;
        CREATE TABLE context_embeddings(id bigserial PRIMARY KEY,tenant_id uuid,client_id uuid,owner_user_id uuid,
          source_type text,source_id text,model text,metadata_jsonb jsonb,embedding vector(1024),content_text text,content_hash text);
        CREATE INDEX context_embeddings_source_idx ON context_embeddings(source_type,source_id);
        CREATE INDEX context_embeddings_tenant_client_idx ON context_embeddings(tenant_id,client_id);
        ALTER TABLE context_embeddings ENABLE ROW LEVEL SECURITY;
        ALTER TABLE context_embeddings FORCE ROW LEVEL SECURITY;`);
      // Apply the exact canonical public/tenant/owner/wall policy. The empty
      // private-owner tables and fail-closed retention helper are fixture-only;
      // the public vector query must never depend on a private retention grant.
      const wall = readFileSync(
        join(process.cwd(), 'prisma/migrations/20260719221000_memory_wall_rls/migration.sql'),
        'utf8',
      );
      const policy = wall.match(/CREATE POLICY "context_embeddings_isolation"[\s\S]*?;/)?.[0];
      if (!policy) throw Error('CANONICAL_VECTOR_RLS_POLICY_REQUIRED');
      await db.query(policy);
      // Restrictive owner-retention policy captured from the actual app-role
      // plan: preserve its correlated private lookup, even with bypass set.
      await db.query(`CREATE POLICY memory_embedding_owner_retention ON context_embeddings AS RESTRICTIVE FOR SELECT
        USING(rls_bypass() OR source_type<>'memory_item' OR EXISTS(SELECT 1 FROM memory_items m
          WHERE m.tenant_id=context_embeddings.tenant_id AND m.id::text=context_embeddings.source_id
          AND memory_retention_visible(m.tenant_id,m.retention_subject_id)))`);
      await db.query(
        `INSERT INTO context_embeddings(tenant_id,client_id,owner_user_id,source_type,source_id,model,metadata_jsonb,embedding,content_text,content_hash)
        SELECT CASE WHEN n>2400 THEN '00000000-0000-4000-8000-000000009999'::uuid END,
          CASE WHEN n>1800 AND n<=2100 THEN '00000000-0000-4000-8000-000000009998'::uuid END,
          CASE WHEN n>2100 AND n<=2400 THEN '00000000-0000-4000-8000-000000009997'::uuid END,
          CASE WHEN n>2400 THEN 'memory_item' WHEN n>1200 AND n<=1800 THEN 'bill_passage' ELSE 'state_bill_passage' END,
          'synthetic:'||n,CASE WHEN n>1500 AND n<=1800 THEN 'other-model' ELSE 'test-model' END,
          jsonb_build_object('chunkerVersion',$1::text,'extractionVersion',$2::text,'jurisdiction',CASE WHEN n<=600 OR n>1800 THEN 'FL' WHEN n<=1200 THEN 'TX' ELSE 'US' END),
          ('['||sin(n)::text||','||cos(n)::text||repeat(',0',1022)||']')::vector,'synthetic public passage',repeat('a',64)
        FROM generate_series(1,3000) n`,
        [CHUNKER_VERSION, BILL_EXTRACTION_VERSION],
      );
      for (const [migration, name] of [
        [
          '20281101010000_bill_full_text_passage_indexes',
          'context_embeddings_bill_passage_hnsw_idx',
        ],
        ['20281102010000_bill_structured_extractions', 'context_embeddings_bill_passage_hash_idx'],
      ]) {
        const text = readFileSync(
          join(process.cwd(), 'prisma/migrations', migration!, 'migration.sql'),
          'utf8',
        );
        const index = text.match(
          new RegExp(`CREATE INDEX (?:IF NOT EXISTS )?${name}[\\s\\S]*?;`),
        )?.[0];
        if (!index) throw Error('CANONICAL_VECTOR_INDEX_REQUIRED');
        await db.query(index);
      }
      await db.query(`ANALYZE context_embeddings;
        GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role};
        SET LOCAL ROLE ${role};`);
      await db.query(
        'SELECT set_config($1,$2,true),set_config($3,$4,true),set_config($5,$6,true)',
        ['app.bypass_rls', 'off', 'app.current_tenant', '', 'app.current_user', ''],
      );
      expect(
        (await db.query(`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`))
          .rows,
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      expect(
        (
          await db.query(
            `SELECT count(*)::int n FROM context_embeddings WHERE tenant_id IS NOT NULL`,
          )
        ).rows[0].n,
      ).toBe(0);
      const query = billTextSearchQuery(
        validateBillTextSearch({ mode: 'semantic', query: 'licensing', jurisdictions: ['FL'] }),
        { vector: Array.from({ length: 1024 }, (_, i) => Number(i === 0)), model: 'test-model' },
      );
      const nearest = query.sql.split('), semantic_revision_keys AS MATERIALIZED (')[0]! + ')';
      // Inspect exactly the production vector stage independently of canonical
      // hydration. Retain typed unused canonical parameters in this test SELECT.
      const used = new Set([...nearest.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));
      const unused = query.values
        .map((_, i) => i + 1)
        .filter((i) => !used.has(i))
        .map((i) => `($${i}::text IS NULL OR $${i}::text IS NOT NULL)`)
        .join(' AND ');
      const sql =
        nearest +
        ` SELECT source_type,tenant_id,client_id,owner_user_id,model,metadata_jsonb FROM semantic_candidates WHERE ${unused || 'true'}`;
      for (const bypass of ['off', 'on']) {
        await db.query(`SELECT set_config('app.bypass_rls',$1,true)`, [bypass]);
        const rows = (await db.query(sql, query.values)).rows;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThanOrEqual(600);
        for (const row of rows)
          expect(row).toMatchObject({
            source_type: 'state_bill_passage',
            tenant_id: null,
            client_id: null,
            owner_user_id: null,
            model: 'test-model',
            metadata_jsonb: {
              jurisdiction: 'FL',
              chunkerVersion: CHUNKER_VERSION,
              extractionVersion: BILL_EXTRACTION_VERSION,
            },
          });
      }
      const plan = (await db.query('EXPLAIN (ANALYZE,FORMAT JSON) ' + sql, query.values)).rows[0][
        'QUERY PLAN'
      ][0].Plan;
      const scans: Array<Record<string, unknown>> = [];
      const indexes: string[] = [];
      const walk = (node: Record<string, unknown>) => {
        if (node['Relation Name'] === 'context_embeddings') scans.push(node);
        if (typeof node['Index Name'] === 'string') indexes.push(node['Index Name']);
        for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) walk(child);
      };
      walk(plan);
      expect(scans).toHaveLength(1);
      expect(scans[0]!['Actual Loops']).toBe(1);
      // HNSW is available; a small filtered population can legitimately use the
      // canonical partial B-tree. Do not force a planner choice or claim 1000 hits.
      expect(
        indexes.some((name) => /^context_embeddings_bill_passage_(hnsw|hash)_idx$/.test(name)),
      ).toBe(true);
      // Exercise the worker's proof through an actual non-bypass role, on one
      // long document surrounded by unrelated passage rows. No per-passage IO.
      await db.query(`RESET ROLE;
        CREATE TABLE bill_text_extraction(id uuid PRIMARY KEY,source_kind text,revision_id uuid,
          document_hash text,parser_version text,structure_hash text,text_hash text);
        CREATE TABLE bill_text_passage(extraction_id uuid,chunker_version text,ordinal int,
          start_offset int,end_offset int,content_text text,metadata_jsonb jsonb,
          PRIMARY KEY(extraction_id,chunker_version,ordinal));`);
      const proofIdentity = {
        extractionId: '00000000-0000-4000-8000-000000000011',
        sourceKind: 'state' as const,
        revisionId: '00000000-0000-4000-8000-000000000001',
        documentHash: 'a'.repeat(64),
        structureHash: 'b'.repeat(64),
        textHash: 'c'.repeat(64),
        billId: 'FL-proof',
        model: 'test-model',
      };
      await db.query(`INSERT INTO bill_text_extraction VALUES($1,'state',$2,$3,$4,$5,$6)`, [
        proofIdentity.extractionId,
        proofIdentity.revisionId,
        proofIdentity.documentHash,
        BILL_EXTRACTION_VERSION,
        proofIdentity.structureHash,
        proofIdentity.textHash,
      ]);
      await db.query(
        `INSERT INTO bill_text_passage
        SELECT $1::uuid,$2,n,n*4000,n*4000+4000,repeat('qualified passage ',222)||'okok','{"semanticAvailable":true}'::jsonb
        FROM generate_series(0,999) n`,
        [proofIdentity.extractionId, CHUNKER_VERSION],
      );
      await db.query(
        `INSERT INTO bill_text_passage
        SELECT '00000000-0000-4000-8000-000000009999'::uuid,$1,n,n*20,n*20+20,'unrelated short text','{"semanticAvailable":true}'::jsonb
        FROM generate_series(0,4999) n`,
        [CHUNKER_VERSION],
      );
      await db.query(
        `UPDATE context_embeddings v SET source_id=$1||':'||p.extraction_id::text||':'||p.ordinal::text,
        content_text=p.content_text,content_hash=encode(sha256(convert_to(p.content_text,'UTF8')),'hex'),
        metadata_jsonb=jsonb_build_object('billId',$2::text,'revisionId',$3::text,'extractionId',$4::text,
          'structureHash',$5::text,'textHash',$6::text,'extractionVersion',$7::text,'chunkerVersion',$1::text,
          'startOffset',p.start_offset,'endOffset',p.end_offset)
        FROM bill_text_passage p WHERE p.extraction_id=$4::uuid AND v.source_id='synthetic:'||(p.ordinal+1)::text`,
        [
          CHUNKER_VERSION,
          proofIdentity.billId,
          proofIdentity.revisionId,
          proofIdentity.extractionId,
          proofIdentity.structureHash,
          proofIdentity.textHash,
          BILL_EXTRACTION_VERSION,
        ],
      );
      await db.query(`ANALYZE bill_text_extraction; ANALYZE bill_text_passage; ANALYZE context_embeddings;
        GRANT SELECT ON bill_text_extraction,bill_text_passage TO ${role}; SET LOCAL ROLE ${role};
        SET LOCAL app.bypass_rls='off'; SET LOCAL statement_timeout='5s';`);
      let proofSql = '',
        proofValues: unknown[] = [];
      const proofReader = {
        async $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T> {
          proofSql = sql;
          proofValues = values;
          return (await db.query(sql, values)).rows as T;
        },
      };
      const proofStarted = performance.now();
      const proven = await loadProvenBillPassages(proofReader, proofIdentity);
      const proofMs = performance.now() - proofStarted;
      expect(proven.size).toBe(1000);
      expect(proofMs).toBeLessThan(5000);
      expect(
        (
          await db.query(`SELECT rolsuper,rolbypassrls,current_setting('app.bypass_rls') AS bypass
        FROM pg_roles WHERE rolname=current_user`)
        ).rows,
      ).toEqual([{ rolsuper: false, rolbypassrls: false, bypass: 'off' }]);
      const proofPlan = (
        await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + proofSql, proofValues)
      ).rows[0]['QUERY PLAN'][0];
      const passageScans: Array<Record<string, number>> = [];
      const proofIndexes: string[] = [];
      const walkProof = (node: Record<string, unknown>) => {
        if (node['Relation Name'] === 'bill_text_passage')
          passageScans.push(node as Record<string, number>);
        if (typeof node['Index Name'] === 'string') proofIndexes.push(node['Index Name']);
        for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) walkProof(child);
      };
      walkProof(proofPlan.Plan);
      expect(passageScans.length).toBeGreaterThan(0);
      for (const scan of passageScans)
        expect(scan['Actual Rows']! * scan['Actual Loops']!).toBeLessThanOrEqual(1000);
      expect(proofIndexes).toContain('context_embeddings_source_idx');
      if (process.env.BILL_TEXT_PG_DIAGNOSTICS === '1')
        console.info(
          JSON.stringify({
            billPassageProofPlan: {
              passages: proven.size,
              elapsedMs: proofMs,
              executionMs: proofPlan['Execution Time'],
              jit: proofPlan.JIT,
              indexes: proofIndexes,
            },
          }),
        );
    } finally {
      await db.query('ROLLBACK').catch(() => undefined);
      await db.end();
    }
  }, 90000);

  it('searches independent lexical passages, exact retained revisions, vector concepts, and missing-parent coverage', async () => {
    const parsed = new URL(url!);
    if (!/bill[_-]text[_-]test/.test(parsed.pathname))
      throw Error('DEDICATED_BILL_TEXT_TEST_DATABASE_REQUIRED');
    const diagnostics = process.env.BILL_TEXT_PG_DIAGNOSTICS === '1';
    let phase = 'seed';
    let alternateCoverageQueries = 0;
    const started = performance.now();
    const timings = new Map<string, { count: number; totalMs: number; maxMs: number }>();
    const db = new PrismaClient({
      datasources: { db: { url: url! } },
      log: [{ level: 'query', emit: 'event' }],
    });
    db.$on('query', (event) => {
      if (event.query === STATE_FORMAT_COVERAGE_SQL) alternateCoverageQueries++;
      if (!diagnostics) return;
      const kind =
        event.query === STATE_BILL_COVERAGE_SQL
          ? 'state_coverage'
          : event.query === FEDERAL_BILL_COVERAGE_SQL
            ? 'federal_coverage'
            : event.query === STATE_FORMAT_COVERAGE_SQL
              ? 'alternate_format_coverage'
              : event.query.includes('semantic_candidates AS MATERIALIZED')
                ? 'semantic'
                : event.query.includes('FROM bill_text_extraction e JOIN bill_text_passage')
                  ? 'proven_passages'
                  : 'fixture_and_inventory';
      const key = `${phase}:${kind}`;
      const item = timings.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
      item.count++;
      item.totalMs += event.duration;
      item.maxMs = Math.max(item.maxMs, event.duration);
      timings.set(key, item);
    });
    try {
      await db.$transaction(
        async (tx) => {
          // Temporary tables shadow canonical names for this connection and disappear at transaction end.
          for (const ddl of [
            `CREATE TEMP TABLE congress_bill(id text PRIMARY KEY,congress int,bill_type text,bill_number text,title text,status text,introduced_date date) ON COMMIT DROP`,
            `CREATE TEMP TABLE congress_bill_action(bill_id text,date date) ON COMMIT DROP`,
            `CREATE TEMP TABLE federal_evidence_revision(id uuid PRIMARY KEY,bill_id text,collection text,version_code text,package_id text,extraction_hash text,content_hash text,source_url text,published_at timestamptz,metadata_jsonb jsonb,raw_content text,fetched_at timestamptz DEFAULT now()) ON COMMIT DROP`,
            `CREATE TEMP TABLE federal_evidence_observation(revision_id uuid,state text,metadata_jsonb jsonb) ON COMMIT DROP`,
            `CREATE TEMP TABLE state_bill(id text PRIMARY KEY,state text,session_key text,bill_number text,title text,status text,legiscan_progress jsonb,latest_action_date date,legiscan_bill_id int) ON COMMIT DROP`,
            `CREATE TEMP TABLE state_bill_action(bill_key text,date date,text text) ON COMMIT DROP`,
            `CREATE TEMP TABLE state_bill_published_record(id uuid PRIMARY KEY,bill_key text,kind text,source_identity text,revision_hash text,event_date text,evidence jsonb,first_observed_at timestamptz) ON COMMIT DROP`,
            `CREATE TEMP TABLE bill_text_extraction(id uuid PRIMARY KEY,source_kind text,revision_id uuid,parser_version text,document_hash text,text_hash text,structure_hash text,extracted_text text,structure_jsonb jsonb,completeness text,warnings_jsonb jsonb,created_at timestamptz) ON COMMIT DROP`,
            `CREATE TEMP TABLE bill_text_passage(extraction_id uuid,chunker_version text,ordinal int,start_offset int,end_offset int,content_text text,metadata_jsonb jsonb DEFAULT '{"semanticAvailable":true}',search_vector tsvector GENERATED ALWAYS AS(to_tsvector('english',content_text)) STORED,PRIMARY KEY(extraction_id,chunker_version,ordinal)) ON COMMIT DROP`,
            `CREATE INDEX ON bill_text_passage USING GIN(search_vector)`,
            `CREATE TEMP TABLE context_embeddings(tenant_id uuid,client_id uuid,owner_user_id uuid,source_type text,source_id text,model text,metadata_jsonb jsonb,embedding vector(1024),content_text text,content_hash text) ON COMMIT DROP`,
            `CREATE TEMP TABLE legal_source_receipt(id text PRIMARY KEY,source text,scope jsonb,manifest jsonb,complete boolean,observed_at timestamptz DEFAULT now()) ON COMMIT DROP`,
            `CREATE TEMP TABLE legal_dataset_archive(content_hash text PRIMARY KEY) ON COMMIT DROP`,
            // Mirror canonical keys/indexes on fixture columns, rather than
            // benchmarking unindexed temporary copies of the production owners.
            `CREATE INDEX ON congress_bill_action(bill_id,date)`,
            `CREATE INDEX ON state_bill_action(bill_key,date)`,
            `CREATE INDEX ON state_bill_published_record(bill_key,first_observed_at)`,
            `CREATE UNIQUE INDEX ON state_bill_published_record(bill_key,kind,source_identity,revision_hash)`,
            `CREATE INDEX ON federal_evidence_revision(bill_id,fetched_at DESC)`,
            `CREATE INDEX ON federal_evidence_revision(package_id,fetched_at DESC)`,
            `CREATE INDEX ON bill_text_extraction(source_kind,revision_id,parser_version,created_at DESC)`,
            `CREATE INDEX ON context_embeddings(source_type,source_id)`,
            `CREATE INDEX ON context_embeddings(tenant_id,client_id)`,
            `CREATE INDEX ON context_embeddings(model,content_hash) WHERE tenant_id IS NULL AND client_id IS NULL AND owner_user_id IS NULL AND source_type IN ('bill_passage','state_bill_passage')`,
          ])
            await tx.$executeRawUnsafe(ddl);
          const fixtureTables = [
            'congress_bill',
            'congress_bill_action',
            'federal_evidence_revision',
            'federal_evidence_observation',
            'state_bill',
            'state_bill_action',
            'state_bill_published_record',
            'bill_text_extraction',
            'bill_text_passage',
            'context_embeddings',
            'legal_source_receipt',
            'legal_dataset_archive',
          ];
          // Autovacuum cannot analyze these transaction-local tables. Refresh
          // estimates after each seed/population change; keep planner/JIT defaults.
          const analyze = async (tables = fixtureTables) => {
            for (const table of tables) await tx.$executeRawUnsafe(`ANALYZE pg_temp.${table}`);
          };
          const explainCoverage = async () => {
            if (!diagnostics) return;
            const state = await loadPinnedStateInventory(tx),
              federal = await loadPinnedFederalInventory(tx);
            for (const [kind, sql, inventory] of [
              ['state', STATE_BILL_COVERAGE_SQL, state.qualifiedReceiptIds],
              ['federal', FEDERAL_BILL_COVERAGE_SQL, JSON.stringify(federal.versions)],
            ] as const) {
              const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,
                BILL_EXTRACTION_VERSION,
                CHUNKER_VERSION,
                'test-model',
                inventory,
              );
              const plans = rows[0]?.['QUERY PLAN'];
              if (!Array.isArray(plans) || !plans[0])
                throw Error('COVERAGE_DIAGNOSTIC_PLAN_MISSING');
              const plan = plans[0] as Record<string, unknown>;
              const indexes = new Set<string>();
              let maxLoops = 0;
              const walk = (node: unknown) => {
                if (!node || typeof node !== 'object') return;
                const value = node as Record<string, unknown>;
                if (typeof value['Index Name'] === 'string') indexes.add(value['Index Name']);
                if (typeof value['Actual Loops'] === 'number')
                  maxLoops = Math.max(maxLoops, value['Actual Loops']);
                if (Array.isArray(value.Plans)) value.Plans.forEach(walk);
              };
              walk(plan.Plan);
              console.info(
                JSON.stringify({
                  billTextPgCoveragePlan: {
                    phase,
                    kind,
                    planningMs: plan['Planning Time'],
                    executionMs: plan['Execution Time'],
                    jit: plan.JIT,
                    indexes: [...indexes],
                    maxLoops,
                  },
                }),
              );
            }
          };
          const ids: Array<{
            billId: string;
            revisionId: string;
            extractionId: string;
            structureHash: string;
          }> = [];
          const boundaryPhrase = 'shelter ' + 'very '.repeat(80) + 'rights';
          const vector = (dimension: number) =>
            Array.from({ length: 1024 }, (_, index) => (index === dimension ? 1 : 0));
          for (const [index, jurisdiction, session, version] of [
            [1, 'FL', '2025', 'Introduced'],
            [2, 'FL', '2025', 'Enrolled'],
            [3, 'TX', '2025', 'Introduced'],
            [4, 'FL', '2026', 'Introduced'],
          ] as const) {
            const billId = `${jurisdiction}-${session}-HB1`,
              revisionId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
              extractionId = `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`;
            if (index !== 2)
              await tx.$executeRawUnsafe(
                `INSERT INTO state_bill VALUES($1,$2,$3,'HB1','Housing','introduced','[{"event":1,"date":"2025-10-02"}]','2025-10-02',$4)`,
                billId,
                jurisdiction,
                session,
                index,
              );
            const structure = structureText(
              'SECTION 1. Rights.\nThe right to cost-effective shelter is established for members of the household.\n' +
                'x'.repeat(2850) +
                ' ' +
                boundaryPhrase +
                '\n' +
                'resident '.repeat(800) +
                '\nSECTION 2. Aid.\nHousing assistance pays rent 😀.',
            );
            const structureHash = structure.structureHash;
            await tx.$executeRawUnsafe(
              `INSERT INTO state_bill_published_record VALUES($1::uuid,$2,'document',$3,$4,'2025-10-03',$5::jsonb,now())`,
              revisionId,
              billId,
              `text:${index}`,
              'a'.repeat(64),
              JSON.stringify({
                versionType: version,
                documentKind: 'text',
                providerId: String(index),
                providerHash: String(index),
                contentHash: 'b'.repeat(64),
                contentSnapshotBase64: 'c291cmNl',
                extractionState: 'extracted',
                url: 'https://example.test/document',
              }),
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO bill_text_extraction VALUES($1::uuid,'state',$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,'complete','[]',now())`,
              extractionId,
              revisionId,
              structure.parserVersion,
              'b'.repeat(64),
              structure.textHash,
              structureHash,
              structure.text,
              JSON.stringify(structure),
            );
            let ordinal = 0;
            for (let start = 0; start < structure.text.length; start += 3000) {
              const end = Math.min(start + 3200, structure.text.length);
              expect(structure.text.slice(start, end)).not.toContain(boundaryPhrase);
              await tx.$executeRawUnsafe(
                `INSERT INTO bill_text_passage(extraction_id,chunker_version,ordinal,start_offset,end_offset,content_text) VALUES($1::uuid,$2,$3,$4,$5,$6)`,
                extractionId,
                CHUNKER_VERSION,
                ordinal++,
                start,
                end,
                structure.text.slice(start, end),
              );
            }
            // Only two documents are embedded; lexical search must still return all four.
            if (index <= 2)
              await tx.$executeRawUnsafe(
                `INSERT INTO context_embeddings(tenant_id,source_type,source_id,model,metadata_jsonb,embedding,content_text,content_hash) VALUES(NULL,'state_bill_passage',$1,'test-model',$2::jsonb,$3::vector,$4,$5)`,
                `${CHUNKER_VERSION}:${extractionId}:0`,
                JSON.stringify({
                  billId,
                  revisionId,
                  extractionId,
                  structureHash,
                  textHash: structure.textHash,
                  jurisdiction,
                  chunkerVersion: CHUNKER_VERSION,
                  extractionVersion: BILL_EXTRACTION_VERSION,
                  startOffset: 0,
                }),
                JSON.stringify(vector(index - 1)),
                structure.text.slice(0, 3200),
                createHash('sha256').update(structure.text.slice(0, 3200)).digest('hex'),
              );
            ids.push({ billId, revisionId, extractionId, structureHash });
          }
          await analyze();
          phase = 'search_contract';
          const provider = {
            metadata: { model: 'test-model', dimensions: 1024 },
            embed: jest.fn().mockResolvedValue(vector(0)),
          } as unknown as EmbeddingProvider;
          const service = new BillTextService(
            {
              withSystem: <T>(callback: (client: Prisma.TransactionClient) => Promise<T>) =>
                callback(tx),
            } as PrismaService,
            provider,
          );
          const exact = await service.search({
            mode: 'exact',
            jurisdictions: ['FL'],
            session: '2025',
            billNumber: 'HB1',
          });
          expect(exact.totalRevisions).toBe(2);
          expect(exact.results.map((r) => r.identity.revisionId)).toEqual(
            expect.arrayContaining(ids.slice(0, 2).map((i) => i.revisionId)),
          );
          const lexical = await service.search({
            mode: 'keyword',
            query: 'rights rent',
            fiscalYear: 2026,
          });
          expect(lexical.totalRevisions).toBe(4); // Lexemes occur in distant passages, before and after vector indexing.
          const phrase = await service.search({
            mode: 'keyword',
            query: '"the right to" "cost-effective"',
          });
          expect(phrase.totalRevisions).toBe(4);
          for (const literal of ['house', 'of the', 'the right to']) {
            expect(
              (await service.search({ mode: 'keyword', query: `"${literal}"` })).totalRevisions,
            ).toBe(4);
          }
          expect(
            (await service.search({ mode: 'keyword', query: `"${boundaryPhrase}"` }))
              .totalRevisions,
          ).toBe(4);
          expect(
            (await service.search({ mode: 'keyword', query: '"cost effective"' })).totalRevisions,
          ).toBe(0);
          expect(
            (await service.search({ mode: 'keyword', query: 'rent', dateBefore: '2025-10-03' }))
              .totalRevisions,
          ).toBe(0);
          const semantic = await service.search({
            mode: 'semantic',
            query: 'help people afford a home',
            jurisdictions: ['FL'],
            session: '2025',
            version: 'Introduced',
          });
          expect(semantic.totalRevisions).toBeNull();
          if (!('candidatePassages' in semantic)) throw Error('Expected a semantic shortlist');
          // Both retained versions enter the nearest shortlist; the canonical
          // version filter admits only Introduced afterward.
          expect(semantic.candidatePassages).toBe(2);
          expect(semantic.results).toHaveLength(1);
          expect(semantic.results[0]!.identity.revisionId).toBe(ids[0]!.revisionId);
          expect(provider.embed).toHaveBeenCalledWith('help people afford a home');
          const duplicatePassageId = `${CHUNKER_VERSION}:${ids[0]!.extractionId}:1`;
          await tx.$executeRawUnsafe(
            `INSERT INTO context_embeddings SELECT NULL,NULL,NULL,e.source_type,$1,e.model,e.metadata_jsonb,
              e.embedding,p.content_text,encode(sha256(convert_to(p.content_text,'UTF8')),'hex')
              FROM context_embeddings e JOIN bill_text_passage p ON p.extraction_id=$2::uuid AND p.ordinal=1
              WHERE e.source_id=$3`,
            duplicatePassageId,
            ids[0]!.extractionId,
            `${CHUNKER_VERSION}:${ids[0]!.extractionId}:0`,
          );
          const deduplicated = await service.search({
            mode: 'semantic',
            query: 'housing',
            billId: ids[0]!.billId,
            version: 'Introduced',
          });
          expect(deduplicated.results).toHaveLength(1);
          if (!('candidatePassages' in deduplicated)) throw Error('Expected a semantic shortlist');
          expect(deduplicated.candidatePassages).toBe(3);
          expect(deduplicated.limitation).toContain('additional matching revisions may exist');
          await tx.$executeRawUnsafe(
            `DELETE FROM context_embeddings WHERE source_id=$1`,
            duplicatePassageId,
          );
          // More than the cap of strictly nearer vectors from each obsolete
          // generation/namespace or another state must not starve current FL
          // passages. Parser v1 and v2 deliberately share the same chunker.
          phase = 'generation_candidates';
          await tx.$executeRawUnsafe(
            'UPDATE context_embeddings SET embedding=$1::vector',
            JSON.stringify(vector(1)),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO context_embeddings
              SELECT NULL,NULL,NULL,e.source_type,'query-noise:'||bucket||':'||n,e.model,
                CASE bucket WHEN 'unstamped' THEN e.metadata_jsonb-'extractionVersion'
                  ELSE e.metadata_jsonb||CASE bucket WHEN 'old' THEN jsonb_build_object('chunkerVersion','obsolete')
                    WHEN 'old-parser' THEN jsonb_build_object('extractionVersion','bill-structure-v1')
                    ELSE jsonb_build_object('jurisdiction','TX') END END,$2::vector,e.content_text,e.content_hash
              FROM context_embeddings e CROSS JOIN generate_series(1,1001) n
              CROSS JOIN unnest(ARRAY['old','old-parser','unstamped','other-state']) bucket WHERE e.source_id=$1`,
            `${CHUNKER_VERSION}:${ids[0]!.extractionId}:0`,
            JSON.stringify(vector(0)),
          );
          await analyze(['context_embeddings']);
          const scoped = await service.search({
            mode: 'semantic',
            query: 'housing',
            jurisdictions: ['FL'],
            version: 'Introduced',
          });
          expect(scoped.results.map((row) => row.identity.revisionId)).toEqual([
            ids[0]!.revisionId,
          ]);
          if (!('candidatePassages' in scoped)) throw Error('Expected a semantic shortlist');
          expect(scoped.candidatePassages).toBe(2);
          await tx.$executeRawUnsafe(
            `DELETE FROM context_embeddings WHERE source_id LIKE 'query-noise:%'`,
          );
          await tx.$executeRawUnsafe(
            'UPDATE context_embeddings SET embedding=$1::vector WHERE source_id=$2',
            JSON.stringify(vector(0)),
            `${CHUNKER_VERSION}:${ids[0]!.extractionId}:0`,
          );
          await analyze(['context_embeddings']);
          phase = 'read_contract';
          // Malformed source identity is a rejected candidate, never a UUID
          // cast failure or a canonical document admitted from its metadata.
          await tx.$executeRawUnsafe(
            `INSERT INTO context_embeddings SELECT NULL,NULL,NULL,source_type,'query-malformed',model,
              metadata_jsonb||'{"revisionId":"invalid-uuid"}'::jsonb,embedding,content_text,content_hash
              FROM context_embeddings WHERE source_id=$1`,
            `${CHUNKER_VERSION}:${ids[0]!.extractionId}:0`,
          );
          const malformed = await service.search({
            mode: 'semantic',
            query: 'housing',
            jurisdictions: ['FL'],
            version: 'Introduced',
          });
          expect(malformed.results.map((row) => row.identity.revisionId)).toEqual([
            ids[0]!.revisionId,
          ]);
          if (!('candidatePassages' in malformed)) throw Error('Expected a semantic shortlist');
          expect(malformed.candidatePassages).toBe(3);
          await tx.$executeRawUnsafe(
            `DELETE FROM context_embeddings WHERE source_id='query-malformed'`,
          );
          const { structureHash: _hash, ...readIdentity } = ids[0]!;
          const old = await service.read({
            ...readIdentity,
            jurisdiction: 'FL',
            session: '2025',
            section: '2',
          });
          expect(old.available).toBe(true);
          if (!old.available || !('text' in old)) throw Error('Expected an available bill read');
          expect(old.text).toContain('rent 😀');
          await expect(
            service.read({ ...readIdentity, jurisdiction: 'TX', session: '2025' }),
          ).rejects.toThrow('BILL_REVISION_NOT_FOUND');
          for (const [invalidDate, dateFrom, dateBefore] of [
            ['2025-10-99', '2025-10-01', '2025-11-01'],
            ['2026-02-30', '2026-02-01', '2026-03-01'],
            ['2026-04-31', '2026-04-01', '2026-05-01'],
          ]) {
            await tx.$executeRawUnsafe(
              `UPDATE state_bill SET legiscan_progress=$2::jsonb,latest_action_date='2026-06-01' WHERE id=$1`,
              ids[0]!.billId,
              JSON.stringify([
                { event: 1, date: invalidDate },
                { event: 2, date: '2026-06-01' },
              ]),
            );
            for (const dateBasis of ['introduced', 'action'] as const) {
              expect(
                (
                  await service.search({
                    mode: 'keyword',
                    query: 'rent',
                    billId: ids[0]!.billId,
                    fiscalYear: 2026,
                    dateBasis,
                    dateFrom,
                    dateBefore,
                  })
                ).totalRevisions,
              ).toBe(0);
            }
            expect(
              (
                await service.search({
                  mode: 'keyword',
                  query: 'rent',
                  billId: ids[0]!.billId,
                  fiscalYear: 2026,
                  dateBasis: 'action',
                  dateFrom: '2026-06-01',
                  dateBefore: '2026-06-02',
                })
              ).totalRevisions,
            ).toBe(2);
          }
          await tx.$executeRawUnsafe(
            `INSERT INTO state_bill_published_record VALUES('00000000-0000-4000-8000-000000000099',$1,'action','invalid-date','invalid','2026-02-30','{}',now())`,
            ids[0]!.billId,
          );
          expect(
            (
              await service.search({
                mode: 'keyword',
                query: 'rent',
                billId: ids[0]!.billId,
                dateBasis: 'action',
                dateFrom: '2026-02-01',
                dateBefore: '2026-03-01',
              })
            ).totalRevisions,
          ).toBe(0);
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_dataset_archive VALUES($1)`,
            'c'.repeat(64),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES('synthetic','fy26-state-frozen-inventory',$1::jsonb,$2::jsonb,true)`,
            JSON.stringify({
              fiscalYear: 2026,
              jurisdiction: 'FL',
              sessionKey: '2025',
              providerSessionId: 1,
              archiveHash: 'c'.repeat(64),
            }),
            JSON.stringify({
              sourceListComplete: true,
              schemaVersion: 1,
              state: 'FL',
              sessionId: 1,
              archiveHash: 'c'.repeat(64),
              inspectedBills: 2,
              eligibleBills: 2,
              bills: [
                {
                  billKey: ids[0]!.billId,
                  providerBillId: 1,
                  documents: [
                    { kind: 'text', providerId: 1, providerHash: '1', versionType: 'Introduced' },
                  ],
                },
                {
                  billKey: 'FL-2025-HB2',
                  providerBillId: 99,
                  documents: [
                    { kind: 'text', providerId: 99, providerHash: '99', versionType: 'Introduced' },
                  ],
                },
              ],
            }),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_dataset_archive VALUES($1)`,
            'd'.repeat(64),
          );
          const discoveryStates = BILL_JURISDICTIONS.filter((state) => state !== 'US').map(
            (state) => ({
              state,
              status: 'complete',
              sessions:
                state === 'FL'
                  ? [
                      { sessionId: 1, archiveHash: 'c'.repeat(64), expectedBills: 2 },
                      { sessionId: 2, archiveHash: 'e'.repeat(64), expectedBills: 0 },
                    ]
                  : [],
            }),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES('discovery','fy26-state-discovery',$1::jsonb,$2::jsonb,true)`,
            JSON.stringify({ fiscalYear: 2026, manifestSha256: 'd'.repeat(64) }),
            JSON.stringify({
              schemaVersion: 1,
              fiscalYear: 2026,
              manifestSha256: 'd'.repeat(64),
              states: discoveryStates,
            }),
          );
          await analyze();
          phase = 'state_coverage';
          await explainCoverage();
          const coverage = await service.coverage();
          expect(alternateCoverageQueries).toBe(0);
          const fl = coverage.jurisdictions.find((row) => row.jurisdiction === 'FL')!;
          expect(fl.versions[0]).toMatchObject({
            expectedBills: 2,
            metadataBills: 1,
            expectedDocuments: 2,
            downloadedDocuments: 1,
            publisherUrlMissingDocuments: 2,
            sourceUnavailableDocuments: 0,
            embeddedPassages: 1,
            missingParents: 1,
          });
          // Public source family alone is insufficient: every scope and immutable input anchor is checked.
          const rejectTamperedVector = async (
            sourceId: string,
            billId: string,
            jurisdiction: string,
          ) => {
            phase = `${jurisdiction}_vector_tampering`;
            const [saved] = await tx.$queryRawUnsafe<
              Array<{ content_text: string; content_hash: string; metadata_jsonb: unknown }>
            >(
              `SELECT content_text,content_hash,metadata_jsonb FROM context_embeddings WHERE source_id=$1`,
              sourceId,
            );
            const metadata = saved!.metadata_jsonb as Record<string, string>;
            const proofIdentity = {
              extractionId: metadata.extractionId!,
              revisionId: metadata.revisionId!,
              billId,
              sourceKind: jurisdiction === 'US' ? ('federal' as const) : ('state' as const),
              documentHash: 'b'.repeat(64),
              structureHash: metadata.structureHash!,
              textHash: metadata.textHash!,
              model: 'test-model',
            };
            const currentProof = await loadProvenBillPassages(tx, proofIdentity);
            expect([...currentProof.keys()]).toEqual([0]);
            const expectedChunk = {
              ordinal: 0,
              start: 0,
              end: saved!.content_text.length,
              text: saved!.content_text,
            };
            expect(billPassageIsProven(currentProof.get(0), expectedChunk, metadata)).toBe(true);
            for (const changedIdentity of [
              { model: 'wrong-model' },
              { documentHash: 'f'.repeat(64) },
              { structureHash: 'f'.repeat(64) },
              { textHash: 'f'.repeat(64) },
            ])
              expect(
                (await loadProvenBillPassages(tx, { ...proofIdentity, ...changedIdentity })).size,
              ).toBe(0);
            for (const mutation of [
              "tenant_id='00000000-0000-4000-8000-000000009999'",
              "client_id='00000000-0000-4000-8000-000000009999'",
              "owner_user_id='00000000-0000-4000-8000-000000009999'",
              "content_text=content_text||' changed'",
              "content_hash=repeat('f',64)",
              "model='wrong-model'",
              "metadata_jsonb=metadata_jsonb-'revisionId'",
              "metadata_jsonb=metadata_jsonb-'billId'",
              "metadata_jsonb=metadata_jsonb-'chunkerVersion'",
              "metadata_jsonb=metadata_jsonb-'extractionVersion'",
              "metadata_jsonb=jsonb_set(metadata_jsonb,'{extractionVersion}','\"bill-structure-v1\"')",
            ]) {
              await tx.$executeRawUnsafe(
                `UPDATE context_embeddings SET ${mutation} WHERE source_id=$1`,
                sourceId,
              );
              expect(
                (
                  await service.search({
                    mode: 'semantic',
                    query: 'housing',
                    billId,
                    version: jurisdiction === 'US' ? 'ih' : 'Introduced',
                  })
                ).results,
              ).toHaveLength(0);
              expect(
                (await service.coverage()).jurisdictions.find(
                  (row) => row.jurisdiction === jurisdiction,
                )!.embeddedPassages,
              ).toBe(0);
              expect((await loadProvenBillPassages(tx, proofIdentity)).size).toBe(0);
              await tx.$executeRawUnsafe(
                `UPDATE context_embeddings SET tenant_id=NULL,client_id=NULL,owner_user_id=NULL,model='test-model',
                content_text=$2,content_hash=$3,metadata_jsonb=$4::jsonb WHERE source_id=$1`,
                sourceId,
                saved!.content_text,
                saved!.content_hash,
                JSON.stringify(saved!.metadata_jsonb),
              );
            }
            // Shared source/hash proof alone does not certify worker citation offsets.
            await tx.$executeRawUnsafe(
              `UPDATE context_embeddings SET metadata_jsonb=jsonb_set(metadata_jsonb,'{startOffset}','999') WHERE source_id=$1`,
              sourceId,
            );
            const staleOffsets = await loadProvenBillPassages(tx, proofIdentity);
            expect(staleOffsets.size).toBe(1);
            expect(billPassageIsProven(staleOffsets.get(0), expectedChunk, metadata)).toBe(false);
            await tx.$executeRawUnsafe(
              `UPDATE context_embeddings SET metadata_jsonb=$2::jsonb WHERE source_id=$1`,
              sourceId,
              JSON.stringify(metadata),
            );
          };
          await rejectTamperedVector(
            `${CHUNKER_VERSION}:${ids[0]!.extractionId}:0`,
            ids[0]!.billId,
            'FL',
          );
          phase = 'state_inventory_changes';
          expect(fl.status).toBe('unknown');
          expect(fl.missingSessions).toEqual(['2']);
          expect(coverage.jurisdictions.find((row) => row.jurisdiction === 'AK')).toMatchObject({
            status: 'complete_for_frozen_inventory',
            completionPercent: 100,
          });
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_dataset_archive VALUES($1)`,
            'e'.repeat(64),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES('empty-session','fy26-state-frozen-inventory',$1::jsonb,$2::jsonb,true)`,
            JSON.stringify({
              fiscalYear: 2026,
              jurisdiction: 'FL',
              providerSessionId: 2,
              sessionKey: '2026',
              archiveHash: 'e'.repeat(64),
            }),
            JSON.stringify({
              schemaVersion: 1,
              state: 'FL',
              sessionId: 2,
              sessionKey: '2026',
              archiveHash: 'e'.repeat(64),
              sourceListComplete: true,
              inspectedBills: 0,
              eligibleBills: 0,
              bills: [],
            }),
          );
          await analyze(['legal_source_receipt', 'legal_dataset_archive']);
          const qualified = await service.coverage();
          expect(qualified.jurisdictions.find((row) => row.jurisdiction === 'FL')).toMatchObject({
            status: 'partial',
            expectedDocuments: 2,
            missingSessions: [],
          });
          // An unlisted later archive must not change the frozen denominator.
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) SELECT 'unlisted-later',source,jsonb_set(scope,'{archiveHash}','"unlisted"'),manifest,false FROM legal_source_receipt WHERE id='synthetic'`,
          );
          expect(
            (await service.coverage()).jurisdictions.find((row) => row.jurisdiction === 'FL')!
              .expectedDocuments,
          ).toBe(2);
          const providerVersions = ['ih', 'enr'].map((versionCode, index) => ({
            versionId: String(index + 1).repeat(64),
            type: versionCode,
            date: '2025-10-02',
            formats: [{ type: 'xml', url: `https://example.test/federal-${versionCode}.xml` }],
            packageId: `BILLS-119hr1${versionCode}`,
            collection: 'BILLS',
            versionCode,
            sourceUrl: `https://example.test/federal-${versionCode}.xml`,
          }));
          const federalInventory = {
            schemaVersion: 1,
            kind: 'text',
            providerDocumentId: '119-hr-1',
            versions: [
              ...providerVersions,
              {
                versionId: '3'.repeat(64),
                type: 'Public law',
                date: '2025-10-02',
                formats: [],
                packageId: null,
                collection: 'PLAW',
                versionCode: null,
                sourceUrl: null,
              },
            ],
            reportedCount: 3,
            enumeratedCount: 3,
            providerUpdatedAt: '2026-06-01T00:00:00Z',
          };
          for (const billId of ['119-hr-1', '119-hr-2'])
            await tx.$executeRawUnsafe(
              `INSERT INTO congress_bill VALUES($1,119,'hr',$2,'Synthetic federal bill','introduced','2025-10-02')`,
              billId,
              billId.endsWith('-1') ? '1' : '2',
            );
          for (const [id, billId, manifest] of [
            ['federal-text', '119-hr-1', federalInventory],
            [
              'federal-empty',
              '119-hr-2',
              {
                ...federalInventory,
                providerDocumentId: '119-hr-2',
                versions: [],
                reportedCount: 0,
                enumeratedCount: 0,
              },
            ],
          ] as const)
            await tx.$executeRawUnsafe(
              `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES($1,'fy26-federal-provider-inventory',$2::jsonb,$3::jsonb,true)`,
              id,
              JSON.stringify({ fiscalYear: 2026, congress: 119, billId }),
              JSON.stringify(manifest),
            );
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES('federal-discovery','fy26-federal-discovery',$1::jsonb,$2::jsonb,true)`,
            JSON.stringify({ fiscalYear: 2026, congress: 119 }),
            JSON.stringify({
              schemaVersion: 1,
              billIds: ['119-hr-1', '119-hr-2'],
              requiredInventoryReceiptIds: ['federal-text', 'federal-empty', 'federal-amendment'],
              sourceListComplete: true,
              amendmentEnumerationComplete: true,
              amendmentParentsResolved: true,
              unresolvedAmendments: 0,
              excludedTreatyAmendments: 0,
              excludedNonFYAmendments: 0,
            }),
          );
          const bytesHash = createHash('sha256').update('source').digest('hex');
          for (const suffix of ['100', '101']) {
            const revisionId = `00000000-0000-4000-8000-000000000${suffix}`;
            await tx.$executeRawUnsafe(
              `INSERT INTO federal_evidence_revision(id,bill_id,collection,version_code,package_id,extraction_hash,content_hash,source_url,published_at,metadata_jsonb,raw_content) VALUES($1::uuid,'119-hr-1','BILLS','ih','BILLS-119hr1ih',$2,$3,'https://example.test/federal-ih.xml','2025-10-02','{}','source')`,
              revisionId,
              suffix.repeat(22).slice(0, 64),
              bytesHash,
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO federal_evidence_observation VALUES($1::uuid,'present',$2::jsonb)`,
              revisionId,
              JSON.stringify({
                providerDocumentId: '119-hr-1',
                providerVersionId: providerVersions[0]!.versionId,
                sourceInventoryReceiptId: 'federal-text',
              }),
            );
          }
          await analyze();
          phase = 'federal_inventory';
          const missingAmendmentInventory = await service.coverage();
          expect(
            missingAmendmentInventory.jurisdictions.find((row) => row.jurisdiction === 'US'),
          ).toMatchObject({
            inventoryStatus: 'unknown',
            expectedDocuments: 3,
            sourceUnavailableDocuments: 1,
            downloadedDocuments: 0,
          });
          expect(missingAmendmentInventory.federalDiscovery!.missingReceiptIds).toEqual([
            'federal-amendment',
          ]);
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES('federal-amendment','fy26-federal-provider-inventory',$1::jsonb,$2::jsonb,true)`,
            JSON.stringify({ fiscalYear: 2026, congress: 119, billId: '119-hr-1' }),
            JSON.stringify({
              ...federalInventory,
              kind: 'amendment',
              providerDocumentId: '119-hamdt-1',
              versions: [],
              reportedCount: 0,
              enumeratedCount: 0,
            }),
          );
          await tx.$executeRawUnsafe(
            `UPDATE federal_evidence_revision SET metadata_jsonb=$1::jsonb WHERE id='00000000-0000-4000-8000-000000000101'`,
            JSON.stringify({
              originalBytesBase64: Buffer.from('source').toString('base64'),
              rawBytesHash: bytesHash,
            }),
          );
          const federalExtractionId = '00000000-0000-4000-8000-000000000201';
          const federalRevisionId = '00000000-0000-4000-8000-000000000101';
          await tx.$executeRawUnsafe(
            `INSERT INTO bill_text_extraction SELECT $1::uuid,'federal',$2::uuid,parser_version,
            document_hash,text_hash,structure_hash,extracted_text,structure_jsonb,completeness,warnings_jsonb,created_at
            FROM bill_text_extraction WHERE id=$3::uuid`,
            federalExtractionId,
            federalRevisionId,
            ids[0]!.extractionId,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO bill_text_passage(extraction_id,chunker_version,ordinal,start_offset,end_offset,content_text,metadata_jsonb)
            SELECT $1::uuid,chunker_version,ordinal,start_offset,end_offset,content_text,metadata_jsonb
            FROM bill_text_passage WHERE extraction_id=$2::uuid`,
            federalExtractionId,
            ids[0]!.extractionId,
          );
          const federalPassageId = `${CHUNKER_VERSION}:${federalExtractionId}:0`;
          await tx.$executeRawUnsafe(
            `INSERT INTO context_embeddings SELECT NULL,NULL,NULL,'bill_passage',$1,model,
            metadata_jsonb||jsonb_build_object('billId','119-hr-1','extractionId',$2::text,'revisionId',$3::text),embedding,content_text,content_hash
            FROM context_embeddings WHERE source_id=$4`,
            federalPassageId,
            federalExtractionId,
            federalRevisionId,
            `${CHUNKER_VERSION}:${ids[0]!.extractionId}:0`,
          );
          await analyze();
          phase = 'federal_coverage';
          await explainCoverage();
          expect(
            (await service.coverage()).jurisdictions.find((row) => row.jurisdiction === 'US')!
              .embeddedPassages,
          ).toBe(1);
          await rejectTamperedVector(federalPassageId, '119-hr-1', 'US');
          phase = 'federal_freshness';
          const federal = (await service.coverage()).jurisdictions.find(
            (row) => row.jurisdiction === 'US',
          )!;
          expect(federal).toMatchObject({
            inventoryStatus: 'frozen_discovery_inventory',
            status: 'partial',
            expectedDocuments: 3,
            sourceUnavailableDocuments: 1,
            downloadedDocuments: 1,
          });
          expect(federal.versions.find((row) => row.version === 'ih')).toMatchObject({
            expectedDocuments: 1,
            downloadedDocuments: 1,
          }); // Parser revisions never enlarge the provider denominator.
          expect(
            federal.versions.find((row) => row.version === 'no_published_versions'),
          ).toMatchObject({ expectedDocuments: 0, failedExtractions: 0 });
          // A previously verified immutable receipt can be reused only while provider freshness is unchanged.
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) SELECT 'federal-old',source,scope,manifest,complete FROM legal_source_receipt WHERE id='federal-text'`,
          );
          await tx.$executeRawUnsafe(
            `UPDATE federal_evidence_observation SET metadata_jsonb=jsonb_set(metadata_jsonb,'{sourceInventoryReceiptId}','"federal-old"')`,
          );
          await analyze(['legal_source_receipt', 'federal_evidence_observation']);
          expect(
            (await service.coverage()).jurisdictions.find((row) => row.jurisdiction === 'US')!
              .downloadedDocuments,
          ).toBe(1);
          await tx.$executeRawUnsafe(
            `UPDATE legal_source_receipt SET manifest=jsonb_set(manifest,'{providerUpdatedAt}','"2025-01-01T00:00:00Z"') WHERE id='federal-old'`,
          );
          expect(
            (await service.coverage()).jurisdictions.find((row) => row.jurisdiction === 'US')!
              .downloadedDocuments,
          ).toBe(0);
          phase = 'alternate_format_coverage';
          // Every preceding coverage/tampering assertion has no qualified
          // companion receipt, so none should plan the alternate vector joins.
          expect(alternateCoverageQueries).toBe(0);
          const alternateRevision = '00000000-0000-4000-8000-000000000170',
            alternateExtraction = '00000000-0000-4000-8000-000000000171';
          const alternateBill = 'FL-2025-HB2',
            alternateHash = 'c'.repeat(32);
          await tx.$executeRawUnsafe(
            `INSERT INTO state_bill VALUES($1,'FL','2025','HB2','Alternative original','introduced','[]','2026-01-01',99)`,
            alternateBill,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES('formats','fy26-state-frozen-formats',$1::jsonb,$2::jsonb,true)`,
            JSON.stringify({
              fiscalYear: 2026,
              jurisdiction: 'FL',
              sessionKey: '2025',
              providerSessionId: 1,
              archiveHash: 'c'.repeat(64),
              primaryReceiptId: 'synthetic',
            }),
            JSON.stringify({
              schemaVersion: 1,
              sourceListComplete: true,
              primaryReceiptId: 'synthetic',
              archiveHash: 'c'.repeat(64),
              bills: [
                {
                  billKey: alternateBill,
                  providerBillId: 99,
                  formats: [
                    {
                      kind: 'text',
                      providerId: 99,
                      providerHash: alternateHash,
                      versionType: 'Introduced',
                      mime: 'application/pdf',
                      stateUrl: 'https://example.test/alternate.pdf',
                      format: { primaryProviderHash: '99' },
                    },
                  ],
                },
              ],
            }),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO state_bill_published_record VALUES($1::uuid,$2,'document','text:99:format:pdf',$3,'2026-01-01',$4::jsonb,now())`,
            alternateRevision,
            alternateBill,
            'e'.repeat(64),
            JSON.stringify({
              documentKind: 'text',
              providerId: '99',
              providerHash: alternateHash,
              versionType: 'Introduced',
              canonicalVersionId: 'text:99',
              mime: 'application/pdf',
              contentHash: 'b'.repeat(64),
              contentSnapshotBase64: 'c291cmNl',
              url: 'https://example.test/alternate.pdf',
              extractionState: 'extracted',
              format: { role: 'alternate', primaryProviderHash: '99' },
            }),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO bill_text_extraction SELECT $1::uuid,source_kind,$2::uuid,parser_version,document_hash,text_hash,structure_hash,extracted_text,structure_jsonb,completeness,warnings_jsonb,created_at FROM bill_text_extraction WHERE id=$3::uuid`,
            alternateExtraction,
            alternateRevision,
            ids[0]!.extractionId,
          );
          const alternateCoverage = (await service.coverage()).jurisdictions.find(
            (row) => row.jurisdiction === 'FL',
          )!;
          expect(alternateCoverageQueries).toBe(1);
          expect(alternateCoverage).toMatchObject({
            expectedDocuments: 2,
            downloadedDocuments: 1,
            alternateFormats: { expectedFormats: 1, downloadedFormats: 1, completeExtractions: 1 },
          });
          const alternateRead = await service.read({
            billId: alternateBill,
            jurisdiction: 'FL',
            session: '2025',
            revisionId: alternateRevision,
            extractionId: alternateExtraction,
          });
          expect(alternateRead.identity).toMatchObject({
            versionId: 'text:99',
            revisionId: alternateRevision,
            extractionId: alternateExtraction,
            format: {
              role: 'alternate',
              mime: 'application/pdf',
              primaryProviderHash: '99',
              sourceIdentity: 'text:99:format:pdf',
            },
          });
        },
        { timeout: 60000 },
      );
    } finally {
      if (diagnostics)
        console.info(
          JSON.stringify({
            billTextPgTimings: {
              elapsedMs: Math.round(performance.now() - started),
              lastPhase: phase,
              queries: Object.fromEntries(timings),
            },
          }),
        );
      await db.$disconnect();
    }
  }, 90000);
});
