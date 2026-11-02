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
 * 37k-message mailbox (POST /api/clio/tools/:name 10012 ms at 03:37:04Z, a 503 to Meri). Two causes, both
 * reproduced here on a disposable PostgreSQL 16 and both read as production reads: a login role that does not
 * own the tables, with row-level security enforced through the same current_tenant_id() / rls_bypass() policies
 * Core installs. (The first version of this spec read as the owner, which no policy touches, and so could not
 * see the second cause.)
 *
 * 1. The coverage statement walked the mailbox once per read with a per-message SubPlan into mail_threads;
 *    migration 20281102130000's activity index plus the lateral aggregate make it an Index Only Scan.
 * 2. The window `COALESCE(received_at, sent_at) >= $1` can never be an index condition under RLS: PostgreSQL
 *    promotes a user qual ahead of the policy qual only if it is leakproof (restriction_is_securely_promotable),
 *    and contain_leaked_vars does not whitelist CoalesceExpr. The owner sees the expression as an index
 *    condition; capiro_app sees a Filter after the mailbox index found every stored message (Core :50, where
 *    count and page still read 37k rows while the same statement as capiro_master used the expression index).
 *    The window is now written on plain columns, which the planner promotes and serves from the column indexes.
 */
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
const MIGRATION = join(__dirname, '../../prisma/migrations/20281102130000_mail_messages_owned_connection_activity/migration.sql');
const TENANT = '00000000-0000-4000-8000-00000000000a', USER = '00000000-0000-4000-8000-00000000000b';
const MAILBOX = '00000000-0000-4000-8000-00000000000c', OTHER_MAILBOX = '00000000-0000-4000-8000-00000000000d';
const APP_ROLE = 'meri_app_rls_test';
const ctx = { tenantId: TENANT, userId: USER } as unknown as TenantContext;

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
const explain = async (prisma: PrismaService, sql: Prisma.Sql, analyze = false) => {
  const rows = analyze
    ? await prisma.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`)
    : await prisma.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`);
  return nodes(rows[0]!['QUERY PLAN'][0]!.Plan);
};
const scanOf = (plan: PlanNode[], relation: string) => plan.find(n => n['Relation Name'] === relation)!;
/** The mail_messages scan with its index conditions (its own and its bitmap children's) and its filter. */
function messageQuals(plan: PlanNode[]) {
  const scan = scanOf(plan, 'mail_messages');
  const indexNodes = [scan, ...nodes(scan).filter(n => n['Node Type'] === 'Bitmap Index Scan')];
  return {
    scan,
    indexes: indexNodes.map(n => n['Index Name']).filter(Boolean) as string[],
    index: indexNodes.map(n => `${n['Index Cond'] ?? ''} ${n['Recheck Cond'] ?? ''}`).join(' '),
    filter: String(scan.Filter ?? ''),
  };
}

(configPath ? describe : describe.skip)('actual PostgreSQL plans of a date-bounded owned-mailbox read under row-level security', () => {
  let owner: PrismaService, app: PrismaService;
  beforeAll(async () => {
    assert.ok(configPath && isAbsolute(configPath));
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 55433);
    assert.equal(config.scope, 'owned local disposable test cluster; no AWS connection');
    const url = (user: string) => {
      const u = new URL(`postgresql://${config.host}:${config.port}/${config.database}`);
      u.username = user; u.password = config.password;
      // One connection, so the session's app.current_tenant setting is the one every statement sees.
      u.searchParams.set('connection_limit', '1'); u.searchParams.set('pool_timeout', '5');
      return u.toString();
    };
    owner = new PrismaService({ datasources: { db: { url: url(config.user) } }, log: [] });
    await owner.$connect();
    const migration = await readFile(MIGRATION, 'utf8');
    const indexStatement = migration.split('\n').filter(line => !line.startsWith('--')).join('\n').trim();
    assert.equal(indexStatement.split(';').filter(part => part.trim()).length, 1, 'exactly one statement so CONCURRENTLY runs outside a transaction');
    const ddl = `
      DROP TABLE IF EXISTS mail_messages, mail_threads, engagement_connections, clients, client_memory_access;
      DROP ROLE IF EXISTS ${APP_ROLE};
      -- Core's policy helpers (20260501000000_init_identity_tenancy), the same shape: plpgsql, STABLE, not leakproof.
      CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $f$
        DECLARE v_raw text := current_setting('app.current_tenant', true);
        BEGIN IF v_raw IS NULL OR v_raw = '' THEN RETURN NULL; END IF; RETURN v_raw::uuid; END $f$ LANGUAGE plpgsql STABLE;
      CREATE OR REPLACE FUNCTION rls_bypass() RETURNS boolean AS $f$
        BEGIN RETURN current_setting('app.bypass_rls', true) = 'on'; END $f$ LANGUAGE plpgsql STABLE;
      CREATE TABLE clients (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text, status text NOT NULL DEFAULT 'active', memory_wall boolean NOT NULL DEFAULT false, created_by_user_id uuid);
      CREATE TABLE client_memory_access (tenant_id uuid NOT NULL, client_id uuid NOT NULL, user_id uuid NOT NULL);
      CREATE INDEX client_memory_access_user_idx ON client_memory_access (tenant_id, user_id);
      CREATE TABLE engagement_connections (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, created_by_user_id uuid, provider text NOT NULL, status text NOT NULL,
        account_email text, last_sync_at timestamptz, sync_state_jsonb jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE mail_threads (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, connection_id uuid, client_id uuid, last_message_at timestamptz);
      CREATE INDEX mail_threads_tenant_connection_id_cover_idx ON mail_threads (tenant_id, connection_id, id) INCLUDE (client_id);
      CREATE TABLE mail_messages (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, thread_id uuid NOT NULL, connection_id uuid, subject text, from_email text, from_name text,
        to_recipients_jsonb jsonb NOT NULL DEFAULT '[]', cc_recipients_jsonb jsonb NOT NULL DEFAULT '[]', bcc_recipients_jsonb jsonb NOT NULL DEFAULT '[]',
        sent_at timestamptz, received_at timestamptz, body_text text, has_attachments boolean NOT NULL DEFAULT false, removed_at timestamptz,
        metadata_jsonb jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      -- The production indexes these statements can use.
      CREATE INDEX mail_messages_tenant_connection_active_idx ON mail_messages (tenant_id, connection_id) WHERE removed_at IS NULL;
      CREATE INDEX mail_messages_tenant_received_idx ON mail_messages (tenant_id, received_at);
      CREATE INDEX mail_messages_tenant_sent_idx ON mail_messages (tenant_id, sent_at);
      INSERT INTO engagement_connections (id, tenant_id, created_by_user_id, provider, status, account_email)
        VALUES ('${MAILBOX}', '${TENANT}', '${USER}', 'google_workspace', 'connected', 'owner@example.test'),
               ('${OTHER_MAILBOX}', '${TENANT}', '${USER}', 'microsoft_365', 'connected', 'owner@example.test');
      -- 40k stored messages across two owned mailboxes over 400 days (the largest preview mailbox's shape); a tenth
      -- carry only sent_at so COALESCE matters; every message on its own thread; bodies wide enough to matter.
      INSERT INTO mail_threads (id, tenant_id, connection_id, last_message_at)
        SELECT ('10000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, '${TENANT}',
               CASE WHEN g % 2 = 0 THEN '${MAILBOX}'::uuid ELSE '${OTHER_MAILBOX}'::uuid END, now() - (g % 400) * interval '1 day' FROM generate_series(1, 40000) g;
      INSERT INTO mail_messages (id, tenant_id, thread_id, connection_id, subject, from_email, sent_at, received_at, body_text, metadata_jsonb)
        SELECT ('20000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, '${TENANT}', ('10000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
               CASE WHEN g % 2 = 0 THEN '${MAILBOX}'::uuid ELSE '${OTHER_MAILBOX}'::uuid END, 'subject ' || g, 'sender' || (g % 97) || '@example.test',
               now() - (g % 400) * interval '1 day' - interval '1 minute',
               CASE WHEN g % 10 = 0 THEN NULL ELSE now() - (g % 400) * interval '1 day' END,
               repeat('body ', 200), jsonb_build_object('folder', 'inbox', 'internetMessageId', '<' || g || '@example.test>')
        FROM generate_series(1, 40000) g;
      -- Row-level security exactly as Core installs it; the app role is a plain login role, NOBYPASSRLS, not the owner.
      ALTER TABLE clients ENABLE ROW LEVEL SECURITY; ALTER TABLE client_memory_access ENABLE ROW LEVEL SECURITY;
      ALTER TABLE engagement_connections ENABLE ROW LEVEL SECURITY; ALTER TABLE mail_threads ENABLE ROW LEVEL SECURITY; ALTER TABLE mail_messages ENABLE ROW LEVEL SECURITY;
      CREATE POLICY clients_isolation ON clients USING (rls_bypass() OR tenant_id = current_tenant_id());
      CREATE POLICY client_memory_access_isolation ON client_memory_access USING (rls_bypass() OR tenant_id = current_tenant_id());
      CREATE POLICY engagement_connections_isolation ON engagement_connections USING (rls_bypass() OR tenant_id = current_tenant_id());
      CREATE POLICY mail_threads_isolation ON mail_threads USING (rls_bypass() OR tenant_id = current_tenant_id());
      CREATE POLICY mail_messages_isolation ON mail_messages USING (rls_bypass() OR tenant_id = current_tenant_id());
      CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${config.password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      GRANT SELECT ON clients, client_memory_access, engagement_connections, mail_threads, mail_messages TO ${APP_ROLE};
      ${indexStatement.replace(/;\s*$/u, '')};
      -- The release steps: an index build sets no visibility map, and the two Index Only Scans need it.
      VACUUM (ANALYZE) mail_messages; VACUUM (ANALYZE) mail_threads; ANALYZE clients; ANALYZE client_memory_access; ANALYZE engagement_connections`;
    const commentFree = ddl.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
    const statements: string[] = [];
    for (const piece of commentFree.split(';')) {
      // A semicolon inside a $f$ function body does not end the statement.
      const open = statements.length && (statements[statements.length - 1]!.split('$f$').length - 1) % 2 === 1;
      if (open) statements[statements.length - 1] += `;${piece}`; else statements.push(piece);
    }
    // One statement per round trip: Prisma prepares each statement, and a prepared statement holds one command.
    for (const statement of statements.map(part => part.trim()).filter(Boolean)) await owner.$executeRawUnsafe(statement);
    const valid = await owner.$queryRaw<Array<{ indisvalid: boolean }>>`SELECT indisvalid FROM pg_index WHERE indexrelid = 'mail_messages_tenant_connection_activity_idx'::regclass`;
    assert.deepEqual(valid, [{ indisvalid: true }]);
    app = new PrismaService({ datasources: { db: { url: url(APP_ROLE) } }, log: [] });
    await app.$connect();
    const who = await app.$queryRaw<Array<{ role: string; bypass: boolean; tenant: string | null }>>(Prisma.sql`
      SELECT current_user AS role, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
             set_config('app.current_tenant', ${TENANT}, false) AS tenant`);
    assert.deepEqual(who, [{ role: APP_ROLE, bypass: false, tenant: TENANT }]);
    const visible = await app.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM mail_messages`;
    assert.equal(Number(visible[0]!.n), 40000, 'the policy admits the tenant');
  }, 180_000);
  afterAll(async () => { await app?.$disconnect(); await owner?.$disconnect(); });

  function statements(withinDays = 2) {
    const filters = normalizeMailReadFilters({ withinDays, asOf: new Date().toISOString() });
    assert.ok(!('error' in filters));
    const mailbox = [Prisma.sql`${MAILBOX}::uuid`];
    const where = mailReadMessageWhere(ctx, filters, mailbox);
    return { where, start: filters.windowStart!, count: mailReadCountSql(where), page: mailReadPageSql(where, 20, 0), coverage: mailReadCoverageSql(ctx, mailbox) };
  }
  /** The production count with the window as PR 415 wrote it (the migration index's expression), on an unwindowed where. */
  function expressionWindow(start: Date) {
    const filters = normalizeMailReadFilters({ asOf: new Date().toISOString() });
    assert.ok(!('error' in filters));
    const where = mailReadMessageWhere(ctx, filters, [Prisma.sql`${MAILBOX}::uuid`]);
    return mailReadCountSql(Prisma.sql`${where} AND COALESCE(m.received_at, m.sent_at) >= ${start}`);
  }

  test('the COALESCE window is an index condition for the owner but a whole-mailbox filter under row-level security', async () => {
    const { start } = statements();
    // Leave the planner only index scans, so the two roles differ by what the planner may promote, not by its estimates.
    for (const prisma of [owner, app]) { await prisma.$executeRawUnsafe('SET enable_bitmapscan = off'); await prisma.$executeRawUnsafe('SET enable_seqscan = off'); }
    try {
      const asOwner = messageQuals(await explain(owner, expressionWindow(start)));
      assert.deepEqual(asOwner.indexes, ['mail_messages_tenant_connection_activity_idx']);
      assert.match(asOwner.index, /COALESCE\(received_at, sent_at\)\)? >=/u, 'no policy applies to the owner, so the expression is an index condition');
      assert.doesNotMatch(asOwner.filter, /COALESCE\(received_at, sent_at\) >=/u);
      const asApp = messageQuals(await explain(app, expressionWindow(start)));
      assert.doesNotMatch(asApp.index, /COALESCE\(received_at, sent_at\)/u, 'under RLS the CoalesceExpr qual is not leakproof and is never promoted to an index condition');
      assert.match(asApp.filter, /COALESCE\(received_at, sent_at\) >=/u, 'so it is a filter after the mailbox index found every stored message');
      assert.match(asApp.filter, /current_tenant_id\(\)/u, 'the policy qual sits in the same scan');
    } finally {
      for (const prisma of [owner, app]) { await prisma.$executeRawUnsafe('RESET enable_bitmapscan'); await prisma.$executeRawUnsafe('RESET enable_seqscan'); }
    }
  }, 120_000);

  test('the plain-column window is promoted under row-level security and plans against the column indexes', async () => {
    const { count, page, start } = statements();
    const expression = await explain(app, expressionWindow(start));
    for (const [name, sql] of [['count', count], ['page', page]] as const) {
      const plan = await explain(app, sql);
      const { indexes, index } = messageQuals(plan);
      assert.match(index, /received_at >= /u, `${name}: the received_at bound is an index condition`);
      assert.match(index, /sent_at >= /u, `${name}: the sent_at bound is an index condition`);
      assert.ok(indexes.includes('mail_messages_tenant_received_idx') && indexes.includes('mail_messages_tenant_sent_idx'), `${name}: ${indexes.join(', ')}`);
      assert.ok(Number(plan[0]!['Total Cost']) * 4 < Number(expression[0]!['Total Cost']),
        `${name}: cost ${plan[0]!['Total Cost']} against ${expression[0]!['Total Cost']} for the expression form`);
    }
    // The rewrite is an identity, nulls included: the same rows as the expression form.
    const [expected, actual] = await Promise.all([owner.$queryRaw<Array<{ n: number }>>(expressionWindow(start)), owner.$queryRaw<Array<{ n: number }>>(count)]);
    assert.equal(actual[0]!.n, expected[0]!.n); assert.ok(actual[0]!.n > 0 && actual[0]!.n * 50 < 20000, `two-day window is under 2% of the mailbox, got ${actual[0]!.n}`);
    const rows = await app.$queryRaw<Array<{ id: string; received_at: Date | null; sent_at: Date | null }>>(page);
    assert.equal(rows.length, 20);
    const at = (row: typeof rows[number]) => (row.received_at ?? row.sent_at)!.getTime();
    for (let i = 1; i < rows.length; i += 1) assert.ok(at(rows[i - 1]!) > at(rows[i]!) || (at(rows[i - 1]!) === at(rows[i]!) && rows[i - 1]!.id > rows[i]!.id), 'newest first, id descending within a tie');
  }, 120_000);

  test('coverage is an Index Only Scan of the activity index under row-level security, and the thread side needs its own VACUUM', async () => {
    const { coverage } = statements();
    const plan = await explain(app, coverage, true);
    const messages = scanOf(plan, 'mail_messages'), threads = scanOf(plan, 'mail_threads');
    assert.equal(messages['Node Type'], 'Index Only Scan', `got ${messages['Node Type']}`);
    assert.equal(messages['Index Name'], 'mail_messages_tenant_connection_activity_idx');
    assert.equal(Number(messages['Heap Fetches']), 0, 'mail_messages was vacuumed, so its visibility map is set');
    assert.equal(plan.some(n => n['Parent Relationship'] === 'SubPlan' && nodes(n).some(m => m['Relation Name'] === 'mail_threads')), false, 'no per-message probe');
    assert.equal(threads['Node Type'], 'Index Only Scan', `got ${threads['Node Type']}`);
    assert.equal(Number(threads['Heap Fetches']), 0);
    // A sync rewrites thread rows (last_message_at); those pages are not all-visible until mail_threads is vacuumed again.
    await owner.$executeRawUnsafe(`UPDATE mail_threads SET last_message_at = now() WHERE connection_id = '${MAILBOX}'::uuid AND id::text < '10000000-0000-4000-8000-000000001000'`);
    const touched = scanOf(await explain(app, coverage, true), 'mail_threads');
    assert.equal(touched['Node Type'], 'Index Only Scan');
    assert.ok(Number(touched['Heap Fetches']) > 0, `after a sync touched threads the join fetched ${touched['Heap Fetches']} heap tuples; VACUUM mail_threads is part of the release`);
    await owner.$executeRawUnsafe('VACUUM (ANALYZE) mail_threads');
    const vacuumed = scanOf(await explain(app, coverage, true), 'mail_threads');
    assert.equal(Number(vacuumed['Heap Fetches']), 0);
    const result = await app.$queryRaw<Array<{ connection_id: string; synced_messages: number; oldest_synced: Date | null; newest_synced: Date | null }>>(coverage);
    assert.equal(result.length, 1); assert.equal(result[0]!.connection_id, MAILBOX); assert.equal(result[0]!.synced_messages, 20000);
    assert.ok(result[0]!.oldest_synced instanceof Date && result[0]!.newest_synced instanceof Date && result[0]!.oldest_synced < result[0]!.newest_synced);
  }, 120_000);
});
