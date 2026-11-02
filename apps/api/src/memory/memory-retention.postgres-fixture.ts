import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';

/** Isolated relational fixture for retention, not vector arithmetic. Relevant
 * restrictive revision FKs and candidate -> item SET NULL effects are real. */
export async function retentionDatabase(url: string) {
  if (
    !/^postgresql:\/\/wave6_fixture_admin@127\.0\.0\.1:55486\/memory_retention_[a-z0-9_]+$/.test(
      url,
    )
  )
    throw Error('Only the task-owned memory_retention database is admitted');
  const schema = `retention_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const ordinary = await admin.query(
    "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='capiro_app'",
  );
  if (ordinary.rows.length !== 1 || ordinary.rows[0].rolsuper || ordinary.rows[0].rolbypassrls) {
    await admin.end();
    throw Error('Ordinary test role required');
  }
  await admin.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
    CREATE TABLE memory_items(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,client_id uuid,
      slug text NOT NULL,legal_hold boolean NOT NULL DEFAULT false,expires_at timestamptz);
    CREATE TABLE clio_memory(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,client_id uuid,scope text,
      expires_at timestamptz);
    CREATE TABLE memory_candidate(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,client_id uuid,
      legal_hold boolean NOT NULL DEFAULT false,revision_root_id uuid,predecessor_candidate_id uuid,
      superseded_by_id uuid,duplicate_of_id uuid REFERENCES memory_candidate(id) ON DELETE SET NULL,
      committed_memory_item_id uuid REFERENCES memory_items(id) ON DELETE SET NULL,
      duplicate_memory_item_id uuid REFERENCES memory_items(id) ON DELETE SET NULL,
      contradicts_memory_item_id uuid REFERENCES memory_items(id) ON DELETE SET NULL,committed_memory_id uuid,
      payload_jsonb jsonb NOT NULL DEFAULT '{"value":"synthetic retained content"}',
      UNIQUE(tenant_id,id),
      FOREIGN KEY(tenant_id,revision_root_id) REFERENCES memory_candidate(tenant_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(tenant_id,predecessor_candidate_id) REFERENCES memory_candidate(tenant_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(tenant_id,superseded_by_id) REFERENCES memory_candidate(tenant_id,id) ON DELETE RESTRICT);
    CREATE TABLE context_embeddings(tenant_id uuid NOT NULL,client_id uuid,source_type text,source_id text);
    CREATE TABLE memory_edges(tenant_id uuid NOT NULL,src_item_id uuid REFERENCES memory_items(id) ON DELETE CASCADE);
    CREATE TABLE client_memory_access(tenant_id uuid NOT NULL,client_id uuid);
    CREATE TABLE memory_access_grant(tenant_id uuid NOT NULL,client_id uuid);
    CREATE TABLE audit_logs(tenant_id uuid NOT NULL,action text,details jsonb);
    CREATE TABLE clio_meri_memory_submissions(tenant_id uuid NOT NULL,candidate_id uuid NOT NULL,
      candidate_sha256 char(64) NOT NULL,proposer_user_id uuid NOT NULL,review_id uuid NOT NULL,
      created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP);
    GRANT USAGE ON SCHEMA "${schema}" TO capiro_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO capiro_app;`);
  const tables = (
    await admin.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [schema])
  ).rows;
  for (const { tablename } of tables) {
    await admin.query(`ALTER TABLE "${tablename}" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE "${tablename}" FORCE ROW LEVEL SECURITY;
      CREATE POLICY scope ON "${tablename}" USING
        (current_setting('app.bypass_rls',true)='on' OR tenant_id=nullif(current_setting('app.current_tenant',true),'')::uuid);`);
  }
  const port = (db: Client) =>
    ({
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = Prisma.sql(strings, ...values);
        return (await db.query(sql.text, sql.values)).rows;
      },
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = Prisma.sql(strings, ...values);
        return (await db.query(sql.text, sql.values)).rowCount;
      },
      auditLog: {
        create: async ({
          data,
        }: {
          data: { tenantId: string; action: string; before: unknown };
        }) => {
          await db.query('INSERT INTO audit_logs(tenant_id,action,details) VALUES($1,$2,$3)', [
            data.tenantId,
            data.action,
            JSON.stringify(data.before),
          ]);
          return {};
        },
      },
    }) as unknown as Prisma.TransactionClient;
  const connect = async () => {
    const db = new Client({ connectionString: url, statement_timeout: 8000 });
    await db.connect();
    await db.query(`SET search_path TO "${schema}"; SET ROLE capiro_app; SET app.bypass_rls='on'`);
    return db;
  };
  const transaction = async <T>(fn: (tx: Prisma.TransactionClient, db: Client) => Promise<T>) => {
    const db = await connect();
    await db.query('BEGIN');
    try {
      const result = await fn(port(db), db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      await db.end();
    }
  };
  return {
    admin,
    connect,
    port,
    transaction,
    prisma: {
      withSystem: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => transaction(fn),
    } as PrismaService,
    reset: () =>
      admin.query(
        'TRUNCATE memory_candidate,memory_items,clio_memory,context_embeddings,memory_edges,client_memory_access,memory_access_grant,audit_logs,clio_meri_memory_submissions',
      ),
    close: async () => {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}
