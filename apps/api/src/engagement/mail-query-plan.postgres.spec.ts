import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  mailReadCountSql, mailReadCoverageSql, mailReadMessageWhere, mailReadPageSql, normalizeMailReadFilters,
} from './mail-query.js';

/**
 * 2 November 2026: "summarize emails from yesterday" in General spent Core's whole 10 s mail budget on a
 * 37k-message mailbox (POST /api/clio/tools/:name 10012 ms at 03:37:04Z, a 503 to Meri). The clone plan showed
 * why: after mail_messages_tenant_connection_active_idx (tenant_id, connection_id) found the mailbox, the two-day
 * window was a heap filter over every stored message for the count and the page, and the coverage statement
 * walked the mailbox once more probing mail_threads per message (SubPlan). This test reproduces that shape on a
 * disposable PostgreSQL 16, then proves the migration's expression index turns the window into an index
 * condition and the lateral coverage aggregate into one join without a per-message subplan.
 */
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
const MIGRATION = join(__dirname, '../../prisma/migrations/20281102110000_mail_messages_owned_connection_activity/migration.sql');
const TENANT = '00000000-0000-4000-8000-00000000000a', USER = '00000000-0000-4000-8000-00000000000b';
const MAILBOX = '00000000-0000-4000-8000-00000000000c', OTHER_MAILBOX = '00000000-0000-4000-8000-00000000000d';
const ctx = { tenantId: TENANT, userId: USER } as unknown as TenantContext;

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
const explain = async (prisma: PrismaService, sql: Prisma.Sql) => {
  const rows = await prisma.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`);
  return nodes(rows[0]!['QUERY PLAN'][0]!.Plan);
};
const messageScan = (plan: PlanNode[]) => plan.find(n => n['Relation Name'] === 'mail_messages')!;

(configPath ? describe : describe.skip)('actual PostgreSQL plan of a date-bounded owned-mailbox read', () => {
  let prisma: PrismaService;
  beforeAll(async () => {
    assert.ok(configPath && isAbsolute(configPath));
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 55433);
    assert.equal(config.scope, 'owned local disposable test cluster; no AWS connection');
    const url = new URL(`postgresql://${config.host}:${config.port}/${config.database}`);
    url.username = config.user; url.password = config.password;
    prisma = new PrismaService({ datasources: { db: { url: url.toString() } }, log: [] });
    await prisma.$connect();
    const rows = await prisma.$queryRaw<Array<{ owner: boolean; port: number }>>`SELECT current_user=${config.user} AS owner,inet_server_port() AS port`;
    assert.equal(rows[0]?.owner, true); assert.equal(rows[0]?.port, 55433);
    // The columns the three statements touch, in the production shapes that matter to the planner.
    // One statement per round trip: Prisma prepares each statement, and a prepared statement holds one command.
    const ddl = `
      DROP TABLE IF EXISTS mail_messages, mail_threads, engagement_connections, clients, client_memory_access;
      CREATE TABLE clients (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text, status text NOT NULL DEFAULT 'active', memory_wall boolean NOT NULL DEFAULT false, created_by_user_id uuid);
      CREATE TABLE client_memory_access (tenant_id uuid NOT NULL, client_id uuid NOT NULL, user_id uuid NOT NULL);
      CREATE INDEX client_memory_access_user_idx ON client_memory_access (tenant_id, user_id);
      CREATE TABLE engagement_connections (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, created_by_user_id uuid, provider text NOT NULL, status text NOT NULL,
        account_email text, last_sync_at timestamptz, sync_state_jsonb jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE mail_threads (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, connection_id uuid, client_id uuid);
      CREATE INDEX mail_threads_tenant_connection_id_cover_idx ON mail_threads (tenant_id, connection_id, id) INCLUDE (client_id);
      CREATE TABLE mail_messages (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, thread_id uuid NOT NULL, connection_id uuid, subject text, from_email text, from_name text,
        to_recipients_jsonb jsonb NOT NULL DEFAULT '[]', cc_recipients_jsonb jsonb NOT NULL DEFAULT '[]', bcc_recipients_jsonb jsonb NOT NULL DEFAULT '[]',
        sent_at timestamptz, received_at timestamptz, body_text text, has_attachments boolean NOT NULL DEFAULT false, removed_at timestamptz,
        metadata_jsonb jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX mail_messages_tenant_connection_active_idx ON mail_messages (tenant_id, connection_id) WHERE removed_at IS NULL;
      CREATE INDEX mail_messages_tenant_received_idx ON mail_messages (tenant_id, received_at);
      INSERT INTO engagement_connections (id, tenant_id, created_by_user_id, provider, status, account_email)
        VALUES ('${MAILBOX}', '${TENANT}', '${USER}', 'google_workspace', 'connected', 'owner@example.test'),
               ('${OTHER_MAILBOX}', '${TENANT}', '${USER}', 'microsoft_365', 'connected', 'owner@example.test');
      -- 40k stored messages across two owned mailboxes over 400 days, the largest preview mailbox's shape; a tenth
      -- carry only sent_at (COALESCE matters), every message on its own thread, bodies wide enough to matter.
      INSERT INTO mail_threads (id, tenant_id, connection_id)
        SELECT ('10000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, '${TENANT}',
               CASE WHEN g % 2 = 0 THEN '${MAILBOX}'::uuid ELSE '${OTHER_MAILBOX}'::uuid END FROM generate_series(1, 40000) g;
      INSERT INTO mail_messages (id, tenant_id, thread_id, connection_id, subject, from_email, sent_at, received_at, body_text, metadata_jsonb)
        SELECT ('20000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, '${TENANT}', ('10000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
               CASE WHEN g % 2 = 0 THEN '${MAILBOX}'::uuid ELSE '${OTHER_MAILBOX}'::uuid END, 'subject ' || g, 'sender' || (g % 97) || '@example.test',
               now() - (g % 400) * interval '1 day' - interval '1 minute',
               CASE WHEN g % 10 = 0 THEN NULL ELSE now() - (g % 400) * interval '1 day' END,
               repeat('body ', 200), jsonb_build_object('folder', 'inbox', 'internetMessageId', '<' || g || '@example.test>')
        FROM generate_series(1, 40000) g;
      ANALYZE clients; ANALYZE client_memory_access; ANALYZE engagement_connections; ANALYZE mail_threads; ANALYZE mail_messages;`;
    const commentFree = ddl.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
    for (const statement of commentFree.split(';').map(part => part.trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(statement);
    }
  }, 120_000);
  afterAll(async () => { await prisma?.$disconnect(); });

  function statements() {
    const filters = normalizeMailReadFilters({ withinDays: 2, asOf: new Date().toISOString() });
    assert.ok(!('error' in filters));
    const where = mailReadMessageWhere(ctx, filters, [Prisma.sql`${MAILBOX}::uuid`]);
    return { count: mailReadCountSql(where), page: mailReadPageSql(where, 20, 0), coverage: mailReadCoverageSql(ctx, [Prisma.sql`${MAILBOX}::uuid`]) };
  }

  test('without the activity index the window is a heap filter applied after the mailbox index found every stored message', async () => {
    const { count, page } = statements();
    for (const sql of [count, page]) {
      const scan = messageScan(await explain(prisma, sql));
      const conditions = `${scan['Index Cond'] ?? ''} ${scan['Recheck Cond'] ?? ''}`;
      assert.doesNotMatch(conditions, /COALESCE\(received_at, sent_at\) >=/u, 'the window is not an index condition');
      assert.match(String(scan.Filter), /COALESCE\(received_at, sent_at\) >=/u, 'the window is applied after the index found the mailbox');
      assert.equal(scan['Plan Rows'] !== undefined && Number(scan['Plan Rows']) >= 0, true);
    }
    // The real window set is small: the shape, not the window, costs the budget.
    const windowed = await prisma.$queryRaw<Array<{ n: number }>>(mailReadCountSql(mailReadMessageWhere(ctx, normalizeMailReadFilters({ withinDays: 2 }) as never, [Prisma.sql`${MAILBOX}::uuid`])));
    assert.ok(windowed[0]!.n > 0 && windowed[0]!.n * 50 < 20000, `two-day window is under 2% of the mailbox, got ${windowed[0]!.n} of 20000`);
  }, 60_000);

  test('the migration index makes the window an index condition and the coverage a single join', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    const statement = migration.split('\n').filter(line => !line.startsWith('--')).join('\n').trim();
    assert.equal(statement.split(';').filter(part => part.trim()).length, 1, 'exactly one statement so CONCURRENTLY runs outside a transaction');
    // CONCURRENTLY cannot run inside a transaction; $executeRawUnsafe sends a single statement outside one.
    await prisma.$executeRawUnsafe(statement.replace(/;\s*$/u, ''));
    const valid = await prisma.$queryRaw<Array<{ indisvalid: boolean }>>`SELECT indisvalid FROM pg_index WHERE indexrelid = 'mail_messages_tenant_connection_activity_idx'::regclass`;
    assert.deepEqual(valid, [{ indisvalid: true }]);
    await prisma.$executeRawUnsafe('ANALYZE mail_messages');
    const { count, page, coverage } = statements();
    for (const sql of [count, page]) {
      const plan = await explain(prisma, sql);
      const scan = messageScan(plan);
      const indexed = plan.find(n => n['Index Name'] === 'mail_messages_tenant_connection_activity_idx');
      assert.ok(indexed, `${scan['Node Type']} uses the activity index`);
      const conditions = `${indexed['Index Cond'] ?? ''} ${scan['Recheck Cond'] ?? ''}`;
      assert.match(conditions, /COALESCE\(received_at, sent_at\) >=/u, 'the window is an index condition');
      assert.doesNotMatch(String(scan.Filter ?? ''), /COALESCE\(received_at, sent_at\) >=/u);
    }
    const plan = await explain(prisma, coverage);
    assert.equal(plan.some(n => n['Parent Relationship'] === 'SubPlan' && nodes(n).some(m => m['Relation Name'] === 'mail_threads')), false,
      'coverage no longer probes mail_threads once per stored message');
    assert.ok(plan.some(n => n['Relation Name'] === 'mail_threads' && n['Parent Relationship'] !== 'SubPlan'), 'threads are joined once');
    const result = await prisma.$queryRaw<Array<{ connection_id: string; synced_messages: number; oldest_synced: Date | null; newest_synced: Date | null }>>(coverage);
    assert.equal(result.length, 1); assert.equal(result[0]!.connection_id, MAILBOX);
    assert.equal(result[0]!.synced_messages, 20000);
    assert.ok(result[0]!.oldest_synced instanceof Date && result[0]!.newest_synced instanceof Date && result[0]!.oldest_synced < result[0]!.newest_synced);
  }, 120_000);
});
