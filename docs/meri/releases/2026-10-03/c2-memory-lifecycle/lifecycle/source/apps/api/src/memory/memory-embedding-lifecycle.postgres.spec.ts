import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Client } from 'pg';
import { Prisma } from '@prisma/client';
import { MemoryIngestService } from './memory-ingest.service.js';
import { getDefaultEmbeddingProvider } from '../embeddings/embedding-provider.factory.js';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.js';

jest.mock('../embeddings/embedding-provider.factory.js', () => ({
  getDefaultEmbeddingProvider: jest.fn(() => ({ metadata: { model: 'local-test' } })),
}));

const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
const suite = configPath ? describe : describe.skip;
suite('memory backfill lifecycle at the actual PostgreSQL source/write boundary', () => {
  const schema = `meri_embedding_${randomUUID().replaceAll('-', '')}`;
  const tenant = randomUUID(),
    otherTenant = randomUUID(),
    item = randomUUID();
  const clientId = randomUUID(),
    actor = randomUUID();
  let db: Client, writer: Client, mutation: Client;
  let created = false;
  let service: MemoryIngestService;
  let beforeSourceRead: (() => Promise<void>) | undefined;
  let afterSourceLock: (() => Promise<void>) | undefined;
  const embed = jest.fn<Promise<number[]>, [string]>();
  const oldLifecycle = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  const stringsSql = (strings: TemplateStringsArray, values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    return { text: sql.text, values: sql.values };
  };
  const port = (connection: Client) => ({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = stringsSql(strings, values);
      // Other ingestion sources are deliberately empty. Phase F and every
      // memory/source/embedding query execute real SQL in this isolated schema.
      if (!q.text.includes('memory_items')) return [];
      return (await connection.query(q)).rows;
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await connection.query(stringsSql(strings, values))).rowCount,
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
      if (sql.includes('FROM memory_items') && beforeSourceRead) {
        const hook = beforeSourceRead;
        beforeSourceRead = undefined;
        await hook();
      }
      const rows = (await connection.query(sql, values)).rows;
      if (sql.includes('FOR UPDATE OF mi') && afterSourceLock) await afterSourceLock();
      return rows;
    },
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) =>
      (await connection.query(sql, values)).rowCount,
  });
  beforeAll(async () => {
    if (!isAbsolute(configPath!)) throw new Error('Absolute owned PostgreSQL config required');
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    if (
      config.host !== '127.0.0.1' ||
      config.port !== 55433 ||
      config.scope !== 'owned local disposable test cluster; no AWS connection' ||
      config.dataDirectory.replaceAll('\\', '/') !==
        'C:/dev/main/outputs/meri-c1-20261002/private/pgdata'
    )
      throw new Error('Unqualified PostgreSQL target');
    const connection = {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    };
    db = new Client(connection);
    writer = new Client(connection);
    mutation = new Client(connection);
    await db.connect();
    const actual = (
      await db.query(
        "SELECT host(inet_server_addr()) AS host, inet_server_port() AS port, current_setting('data_directory') AS directory",
      )
    ).rows[0];
    expect(actual.host).toBe('127.0.0.1');
    expect(actual.port).toBe(55433);
    expect(actual.directory.replaceAll('\\', '/')).toBe(config.dataDirectory.replaceAll('\\', '/'));
    await db.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await db.query(`SET search_path TO "${schema}"`);
    // Native PG16 has no pgvector extension. This domain only accepts the
    // embedder's generated literal; these tests prove row/source transaction
    // behavior, not vector arithmetic or pgvector indexing.
    await db.query(`CREATE DOMAIN vector AS text;
      CREATE TABLE memory_items(id uuid PRIMARY KEY, tenant_id uuid NOT NULL, client_id uuid,
        owner_user_id uuid, type text NOT NULL DEFAULT 'note', title text NOT NULL,
        slug text NOT NULL, sections_jsonb jsonb NOT NULL, visibility text NOT NULL DEFAULT 'tenant',
        status text NOT NULL DEFAULT 'active', governed_status text DEFAULT 'active',
        conflict_status text DEFAULT 'none', controlling_item_id uuid, legal_hold boolean DEFAULT false,
        expires_at timestamptz, valid_until timestamptz, updated_at timestamptz DEFAULT now());
      CREATE TABLE context_embeddings(tenant_id uuid,client_id uuid,owner_user_id uuid,
        source_type text,source_id text,model text,content_text text,content_hash text,embedding vector,
        updated_at timestamptz DEFAULT now(), UNIQUE(tenant_id,source_type,source_id,model));
      CREATE TABLE memory_ingest_run(id uuid PRIMARY KEY,tenant_id uuid,trigger text,actor_user_id uuid,
        status text,finished_at timestamptz,counts_jsonb jsonb);`);
    await writer.connect();
    await mutation.connect();
    await writer.query(`SET search_path TO "${schema}"`);
    await mutation.query(`SET search_path TO "${schema}"`);
    const prisma = {
      ...port(db),
      withSystem: async (fn: (tx: unknown) => unknown) => fn(port(db)),
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        await writer.query('BEGIN');
        try {
          const result = await fn(port(writer));
          await writer.query('COMMIT');
          return result;
        } catch (error) {
          await writer.query('ROLLBACK');
          throw error;
        }
      },
    };
    service = new MemoryIngestService(
      prisma as never,
      { upsertSystem: jest.fn() } as never,
      {
        require: () => ({ tenantId: tenant, userId: actor, clerkUserId: 'system:local-test' }),
      } as never,
    );
    jest.mocked(getDefaultEmbeddingProvider).mockReturnValue({
      metadata: { provider: 'test', model: 'local-test', modelVersion: '1', dimensions: 1024 },
      embed,
      embedBatch: jest.fn(),
    } as EmbeddingProvider);
  });
  beforeEach(async () => {
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    embed.mockReset().mockResolvedValue(Array(1024).fill(0));
    beforeSourceRead = undefined;
    afterSourceLock = undefined;
    await db.query('TRUNCATE context_embeddings,memory_items,memory_ingest_run');
    await db.query(
      `INSERT INTO memory_items(id,tenant_id,client_id,title,slug,sections_jsonb)
      VALUES($1,$2,$3,'Current source','local-source',$4)`,
      [
        item,
        tenant,
        clientId,
        JSON.stringify([
          { owner: 'human', heading: 'Memory', body: 'Only this current source body.' },
        ]),
      ],
    );
  });
  afterAll(async () => {
    if (oldLifecycle === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    else process.env.MEMORY_GOVERNANCE_LIFECYCLE = oldLifecycle;
    await writer?.end();
    await mutation?.end();
    if (created) await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db?.end();
  });
  const embeddings = async () =>
    Number((await db.query('SELECT count(*) AS count FROM context_embeddings')).rows[0].count);
  test('already revoked canonical source is not sent to the provider or re-embedded', async () => {
    await db.query(
      "UPDATE memory_items SET status='revoked',governed_status='revoked' WHERE id=$1",
      [item],
    );
    const result = await service.backfillCurrentTenant();
    expect(embed).not.toHaveBeenCalled();
    expect(await embeddings()).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.embedded).toBe(0);
  });
  test('revoke committed while the provider is paused cannot recreate a deleted embedding', async () => {
    embed.mockImplementation(async () => {
      await mutation.query('BEGIN');
      await mutation.query(
        "UPDATE memory_items SET status='revoked',governed_status='revoked' WHERE id=$1",
        [item],
      );
      await mutation.query('DELETE FROM context_embeddings WHERE source_id=$1', [item]);
      await mutation.query('COMMIT');
      return Array(1024).fill(0);
    });
    const result = await service.backfillCurrentTenant();
    expect(embed).toHaveBeenCalledTimes(1);
    expect(await embeddings()).toBe(0);
    expect(result.embedded).toBe(0);
    expect(result.failed).toBe(0);
  });
  test('eligible canonical source still embeds and a stable second run does not call the provider', async () => {
    expect((await service.backfillCurrentTenant()).embedded).toBe(1);
    expect(await embeddings()).toBe(1);
    expect(embed).toHaveBeenCalledTimes(1);
    expect((await service.backfillCurrentTenant()).embedded).toBe(0);
    expect(embed).toHaveBeenCalledTimes(1);
  });
  test('tenant-qualified Phase F never embeds another tenant source', async () => {
    await db.query('UPDATE memory_items SET tenant_id=$1 WHERE id=$2', [otherTenant, item]);
    await service.backfillCurrentTenant();
    expect(embed).not.toHaveBeenCalled();
    expect(await embeddings()).toBe(0);
  });
  test.each([
    "status='superseded'",
    "governed_status='revoked'",
    "governed_status='superseded'",
    "governed_status='rejected'",
    "governed_status='expired'",
    "governed_status='pending_review'",
    "expires_at=clock_timestamp()-interval '1 second'",
    "valid_until=clock_timestamp()-interval '1 second'",
    "conflict_status='open'",
    "governed_status='conflicted',conflict_status='controlling'",
    "visibility='user',owner_user_id=NULL",
  ])('pre-provider eligibility excludes %s', async (change) => {
    await db.query(`UPDATE memory_items SET ${change} WHERE id=$1`, [item]);
    const result = await service.backfillCurrentTenant();
    expect(result.failed).toBe(0);
    expect(result.embedded).toBe(0);
    expect(embed).not.toHaveBeenCalled();
    expect(await embeddings()).toBe(0);
  });
  test.each([
    'legal_hold=true',
    "governed_status='stale'",
    "governed_status='conflicted',conflict_status='controlling',controlling_item_id=id",
    "conflict_status='open',controlling_item_id=id",
  ])('preserves canonically eligible %s', async (change) => {
    await db.query(`UPDATE memory_items SET ${change} WHERE id=$1`, [item]);
    expect((await service.backfillCurrentTenant()).embedded).toBe(1);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(await embeddings()).toBe(1);
  });
  test.each([
    "status='superseded',governed_status='superseded'",
    "governed_status='revoked'",
    "expires_at=clock_timestamp()-interval '1 second'",
    "valid_until=clock_timestamp()-interval '1 second'",
    'client_id=NULL',
    'owner_user_id=id',
    'tenant_id=id',
    "title='Changed source'",
    "sections_jsonb='[]'::jsonb",
    "visibility='user'",
  ])('source change during provider discards stale vector: %s', async (change) => {
    embed.mockImplementation(async () => {
      await mutation.query(`UPDATE memory_items SET ${change} WHERE id=$1`, [item]);
      return Array(1024).fill(0);
    });
    const result = await service.backfillCurrentTenant();
    expect(result.failed).toBe(0);
    expect(result.embedded).toBe(0);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(await embeddings()).toBe(0);
  });
  test('source deleted during provider cannot leave an orphan embedding', async () => {
    embed.mockImplementation(async () => {
      await mutation.query('DELETE FROM memory_items WHERE id=$1', [item]);
      return Array(1024).fill(0);
    });
    expect((await service.backfillCurrentTenant()).embedded).toBe(0);
    expect(await embeddings()).toBe(0);
  });
  test('a fresh preflight snapshot cannot certify old caller text', async () => {
    beforeSourceRead = async () => {
      await mutation.query(
        "UPDATE memory_items SET title='New version before snapshot' WHERE id=$1",
        [item],
      );
    };
    const result = await service.backfillCurrentTenant();
    expect(result.failed).toBe(0);
    expect(result.embedded).toBe(0);
    expect(embed).not.toHaveBeenCalled();
    expect(await embeddings()).toBe(0);
  });
  test.each([null, 'pending_review'])(
    'legacy compatibility permits %s only while lifecycle enforcement is off',
    async (governed) => {
      process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'off';
      await db.query('UPDATE memory_items SET governed_status=$1 WHERE id=$2', [governed, item]);
      expect((await service.backfillCurrentTenant()).embedded).toBe(1);
      await db.query('TRUNCATE context_embeddings');
      embed.mockClear();
      await db.query("UPDATE memory_items SET governed_status='revoked' WHERE id=$1", [item]);
      expect((await service.backfillCurrentTenant()).embedded).toBe(0);
      expect(embed).not.toHaveBeenCalled();
    },
  );
  test('matching-hash scope-only correction still locks the current source and needs no provider', async () => {
    await service.backfillCurrentTenant();
    embed.mockClear();
    await db.query('UPDATE context_embeddings SET client_id=NULL');
    let locks = 0;
    afterSourceLock = async () => {
      locks++;
    };
    expect((await service.backfillCurrentTenant()).embedded).toBe(1);
    expect((await db.query('SELECT client_id FROM context_embeddings')).rows[0].client_id).toBe(
      clientId,
    );
    expect(locks).toBe(1);
    expect(embed).not.toHaveBeenCalled();
  });
  test('matching-hash scope-only update is blocked when source authority changes after preflight', async () => {
    await service.backfillCurrentTenant();
    embed.mockClear();
    await db.query('UPDATE context_embeddings SET client_id=NULL');
    beforeSourceRead = async () => {
      beforeSourceRead = async () => {
        await mutation.query("UPDATE memory_items SET governed_status='revoked' WHERE id=$1", [
          item,
        ]);
      };
    };
    expect((await service.backfillCurrentTenant()).embedded).toBe(0);
    expect(
      (await db.query('SELECT client_id FROM context_embeddings')).rows[0].client_id,
    ).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });
  test('real expiry crossing during the provider call blocks writing without any source update', async () => {
    await db.query(
      "UPDATE memory_items SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",
      [item],
    );
    embed.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return Array(1024).fill(0);
    });
    expect((await service.backfillCurrentTenant()).embedded).toBe(0);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(await embeddings()).toBe(0);
  });
  test('the write lock serializes concurrent revoke before its canonical projection deletion', async () => {
    let revoke: Promise<unknown> | undefined;
    afterSourceLock = async () => {
      await mutation.query('BEGIN');
      revoke = mutation.query(
        "UPDATE memory_items SET status='revoked',governed_status='revoked' WHERE id=$1",
        [item],
      );
      let waiting = false;
      for (let i = 0; i < 40 && !waiting; i++) {
        const rows = (
          await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [
            (mutation as any).processID,
          ])
        ).rows;
        waiting = rows[0]?.wait_event_type === 'Lock';
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    };
    try {
      expect((await service.backfillCurrentTenant()).embedded).toBe(1);
      await revoke;
      await mutation.query('DELETE FROM context_embeddings WHERE source_id=$1', [item]);
      await mutation.query('COMMIT');
      expect(await embeddings()).toBe(0);
    } finally {
      await mutation.query('ROLLBACK');
    }
  });
});
