/** Real owned-loopback PG, ordinary nonowner role, FORCE RLS, actual canonical
 * query SQL. No AWS, shared data, provider calls or production plan changes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const repo = path.resolve(__dirname, '../../..');
const qualify452 = process.argv.includes('--qualify-452') || process.env.MAIL_MESSAGE_INDEX_452 === '1';
const requireApi = createRequire(path.join(repo, 'apps/api/package.json'));
const { Client } = requireApi('pg');
const { Prisma } = requireApi('@prisma/client');
const ts = requireApi('typescript');
const modules = new Map();
const hashes = {};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function loadTs(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const source = fs.readFileSync(file, 'utf8');
  hashes[path.relative(repo, file).replaceAll('\\', '/')] = hash(source);
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file,
  }).outputText;
  const mod = { exports: {} };
  modules.set(file, mod);
  const req = (name) =>
    name.startsWith('.')
      ? loadTs(path.resolve(path.dirname(file), name.replace(/\.js$/, '.ts')))
      : requireApi(name);
  vm.runInThisContext(`(function(require,module,exports){${js}\n})`, { filename: file })(
    req,
    mod,
    mod.exports,
  );
  return mod.exports;
}
const { queryMailMessages } = loadTs(path.join(repo, 'apps/api/src/engagement/mail-query.ts'));
const migrationPath = path.join(
  repo,
  'apps/api/prisma/migrations/20281006010000_mail_threads_owned_connection_covering/migration.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');
assert.equal(migration.includes(String.fromCharCode(13)), false, 'Migration must be LF-exact');
const messageMigrationPath = path.join(
  repo,
  'apps/api/prisma/migrations/20281007010000_mail_messages_owned_connection_active/migration.sql',
);
const messageMigration = qualify452 ? fs.readFileSync(messageMigrationPath, 'utf8') : null;
if (qualify452) assert.equal(messageMigration.includes(String.fromCharCode(13)), false, 'Message migration must be LF-exact');
const cfg = JSON.parse(fs.readFileSync(process.env.MERI_APPROVED_MEMORY_PG_CONFIG, 'utf8'));
assert.equal(cfg.host, '127.0.0.1');
assert.equal(cfg.port, 55433);
assert.equal(cfg.scope, 'owned local disposable test cluster; no AWS connection');
assert.ok(path.isAbsolute(cfg.dataDirectory));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = uuid(1),
  otherTenant = uuid(2),
  user = uuid(3),
  otherUser = uuid(4);
const own = uuid(10),
  otherOwn = uuid(11),
  outside = uuid(12),
  clientId = uuid(20);
const asOf = '2026-09-07T12:00:00.000Z';
const ctx = {
  tenantId: tenant,
  userId: user,
  role: 'user',
  requestId: 'owned-local-covering-index',
};
const schema = `meri_mail_cover_${randomUUID().replaceAll('-', '')}`;
const role = `meri_mail_role_${randomUUID().replaceAll('-', '')}`;
const db = new Client({
  host: cfg.host,
  port: cfg.port,
  user: cfg.user,
  password: cfg.password,
  database: cfg.database,
  connectionTimeoutMillis: 3000,
});
const checks = [];
let created = false,
  roleCreated = false,
  statements = [];
async function scope(fn, selectedTenant = tenant) {
  await db.query('BEGIN');
  try {
    await db.query(`SET LOCAL ROLE ${role}`);
    await db.query(`SET LOCAL search_path TO ${schema},public`);
    await db.query(
      "SELECT set_config('app.current_tenant',$1,true),set_config('app.bypass_rls','off',true)",
      [selectedTenant],
    );
    const out = await fn();
    await db.query('ROLLBACK');
    return out;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}
const prisma = {
  withTenant: async (id, fn) =>
    scope(
      () =>
        fn({
          $executeRaw: async (strings, ...values) => {
            const sql = Prisma.sql(strings, ...values);
            return db.query(sql.text, sql.values);
          },
          $queryRaw: async (sql) => {
            statements.push(sql);
            return (await db.query(sql.text, sql.values)).rows;
          },
        }),
      id,
    ),
};
async function check(name, fn) {
  await fn();
  checks.push({ name, passed: true });
  console.log('PASS ' + name);
}
function nodes(plan) {
  return [plan, ...(plan.Plans || []).flatMap(nodes)];
}
async function explain(sql) {
  return scope(async () => {
    await db.query("SET LOCAL statement_timeout='10s'");
    const doc = (await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql.text, sql.values))
      .rows[0]['QUERY PLAN'][0];
    return {
      executionMs: doc['Execution Time'],
      totalCost: doc.Plan['Total Cost'],
      nodes: nodes(doc.Plan).map((n) => ({
        node: n['Node Type'],
        relation: n['Relation Name'] || null,
        index: n['Index Name'] || null,
        actualRows: n['Actual Rows'],
        loops: n['Actual Loops'],
        heapFetches: n['Heap Fetches'] ?? null,
        sharedHits: n['Shared Hit Blocks'],
        sharedReads: n['Shared Read Blocks'],
      })),
    };
  });
}
const scenarios = [
  { query: 'CAPIRO_MERI_DIAGNOSTIC_20261002_1616_NO_MATCH', asOf },
  { query: 'Scope Needle', asOf, limit: 2 },
  { query: 'Scope Needle', asOf, limit: 2, offset: 2 },
  { query: 'Ångström_50%\\literal', asOf },
  { query: 'recipient-only', asOf },
  { query: 'cc-only', asOf },
  { query: 'display-only', asOf },
  { from: 'sender-only', asOf },
  { participant: 'bcc-only', asOf },
  { query: 'Scope Needle', clientId, asOf },
];
async function runScenarios() {
  const results = [];
  for (const input of scenarios) results.push(await queryMailMessages(prisma, ctx, input));
  return results;
}
async function main() {
  let beforePlan, afterPlan, before, after, migrationMs;
  try {
    await db.connect();
    const actual = (
      await db.query(
        "SELECT current_user=$1 AS owner,host(inet_server_addr()) AS address,inet_server_port() AS port,current_setting('data_directory') AS directory",
        [cfg.user],
      )
    ).rows[0];
    assert.equal(actual.owner, true);
    assert.equal(actual.address, cfg.host);
    assert.equal(actual.port, cfg.port);
    assert.equal(actual.directory.replaceAll('\\', '/'), cfg.dataDirectory.replaceAll('\\', '/'));
    await db.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    roleCreated = true;
    await db.query(`SET search_path TO ${schema},public`);
    await db.query(`CREATE TABLE engagement_connections(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,created_by_user_id uuid NOT NULL,account_email text,provider text,status text,last_sync_at timestamptz,sync_state_jsonb jsonb,created_at timestamptz);
      CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid,name text);
      CREATE TABLE mail_threads(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,connection_id uuid,client_id uuid,last_message_at timestamptz,padding text);
      CREATE TABLE mail_messages(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,connection_id uuid,thread_id uuid,subject text,from_email text,from_name text,to_recipients_jsonb jsonb,cc_recipients_jsonb jsonb,bcc_recipients_jsonb jsonb,sent_at timestamptz,received_at timestamptz,body_text text,has_attachments boolean,removed_at timestamptz,metadata_jsonb jsonb,created_at timestamptz,updated_at timestamptz);
      CREATE INDEX mail_threads_tenant_client_last_idx ON mail_threads(tenant_id,client_id,last_message_at);
      CREATE INDEX mail_messages_thread_removed_received_idx ON mail_messages(thread_id,removed_at,received_at);
      CREATE INDEX mail_messages_tenant_received_idx ON mail_messages(tenant_id,received_at);
      ALTER TABLE mail_threads ALTER COLUMN padding SET STORAGE PLAIN`);
    for (const [id, t, u] of [
      [own, tenant, user],
      [otherOwn, tenant, otherUser],
      [outside, otherTenant, user],
    ])
      await db.query(
        `INSERT INTO engagement_connections VALUES($1,$2,$3,'local@example.test','microsoft_365','connected','2026-09-07', '{}','2026-01-01')`,
        [id, t, u],
      );
    await db.query('INSERT INTO clients VALUES($1,$2,$3)', [
      clientId,
      tenant,
      'Owned synthetic client',
    ]);
    await db.query(
      `INSERT INTO mail_threads SELECT md5('thread'||i)::uuid,
      CASE WHEN i<=30000 THEN $1::uuid ELSE $2::uuid END,
      CASE WHEN i<=1000 THEN $3::uuid WHEN i<=30000 THEN $4::uuid ELSE $5::uuid END,
      CASE WHEN i=1 THEN $6::uuid ELSE NULL END,'2026-09-05',repeat(md5('padding'||i),55)
      FROM generate_series(1,100000) AS i`,
      [tenant, otherTenant, own, otherOwn, outside, clientId],
    );
    await db.query(`INSERT INTO mail_messages SELECT md5('message'||i)::uuid,t.tenant_id,t.connection_id,t.id,
      'catalog '||i,'sender@example.test','Sender','[]','[]','[]','2026-09-05','2026-09-05',repeat(md5('text'||i),20),false,NULL,
      jsonb_build_object('folder','inbox','internetMessageId','message'||i),'2026-09-05','2026-09-05'
      FROM generate_series(1,100000) AS i JOIN mail_threads t ON t.id=md5('thread'||i)::uuid`);
    await db.query(`UPDATE mail_messages SET subject='Scope Needle' WHERE id IN(md5('message1')::uuid,md5('message2')::uuid,md5('message3')::uuid,md5('message1001')::uuid,md5('message30001')::uuid);
      UPDATE mail_messages SET body_text='Ångström_50%\\literal' WHERE id=md5('message4')::uuid;
      UPDATE mail_messages SET to_recipients_jsonb='[{"name":"recipient-only"}]' WHERE id=md5('message5')::uuid;
      UPDATE mail_messages SET cc_recipients_jsonb='[{"name":"cc-only"}]' WHERE id=md5('message6')::uuid;
      UPDATE mail_messages SET from_name='display-only' WHERE id=md5('message7')::uuid;
      UPDATE mail_messages SET from_email='sender-only@example.test' WHERE id=md5('message8')::uuid;
      UPDATE mail_messages SET bcc_recipients_jsonb='[{"name":"bcc-only"}]' WHERE id=md5('message9')::uuid;
      INSERT INTO mail_messages SELECT '${uuid(50)}',tenant_id,connection_id,thread_id,subject,from_email,from_name,to_recipients_jsonb,cc_recipients_jsonb,bcc_recipients_jsonb,sent_at,received_at,body_text,has_attachments,removed_at,metadata_jsonb,created_at,updated_at FROM mail_messages WHERE id=md5('message1')::uuid;
      INSERT INTO mail_messages SELECT '${uuid(51)}',tenant_id,connection_id,thread_id,subject,from_email,from_name,to_recipients_jsonb,cc_recipients_jsonb,bcc_recipients_jsonb,sent_at,received_at,body_text,has_attachments,removed_at,jsonb_set(metadata_jsonb,'{internetMessageId}','"later"'),'2026-09-08',updated_at FROM mail_messages WHERE id=md5('message1')::uuid`);
    if (qualify452)
      await db.query(`UPDATE mail_messages SET subject='Removed Needle',removed_at='2026-09-06' WHERE id=md5('message10')::uuid;
        UPDATE mail_messages SET body_text=repeat('bounded-large-body ',2048) WHERE id=md5('message12')::uuid`);
    const historical = fs.readFileSync(
      path.join(
        repo,
        'apps/api/prisma/migrations/20260501000000_init_identity_tenancy/migration.sql',
      ),
      'utf8',
    );
    for (const name of ['current_tenant_id', 'rls_bypass']) {
      const found = historical.match(
        new RegExp(
          'CREATE OR REPLACE FUNCTION ' + name + '\\(\\)[\\s\\S]+?\\$\\$ LANGUAGE plpgsql STABLE;',
        ),
      );
      assert.ok(found);
      await db.query(found[0]);
    }
    for (const table of ['engagement_connections', 'mail_threads', 'mail_messages', 'clients'])
      await db.query(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;CREATE POLICY scoped ON ${table} USING(rls_bypass() OR tenant_id=current_tenant_id()) WITH CHECK(rls_bypass() OR tenant_id=current_tenant_id())`,
      );
    await db.query(
      `GRANT USAGE ON SCHEMA ${schema} TO ${role};GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role};GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`,
    );
    for (const table of ['engagement_connections', 'mail_threads', 'mail_messages', 'clients'])
      await db.query(`VACUUM (ANALYZE) ${table}`);
    await check('actual nonowner/NOBYPASSRLS role executes original FORCE-RLS policy', async () => {
      const r = await scope(
        async () =>
          (
            await db.query(
              "SELECT rolsuper,rolbypassrls,pg_has_role(current_user,c.relowner,'USAGE') AS owns,c.relrowsecurity,c.relforcerowsecurity FROM pg_roles r JOIN pg_class c ON c.oid='mail_threads'::regclass WHERE r.rolname=current_user",
            )
          ).rows[0],
      );
      assert.deepEqual(r, {
        rolsuper: false,
        rolbypassrls: false,
        owns: false,
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    });
    before = await runScenarios();
    const count = statements[0];
    beforePlan = await explain(count);
    await check(
      'actual source preserves ownership, zero-result, paging, Unicode, literal escapes and six-field matches before migration',
      async () => {
        assert.equal(before[0].totalMatches, 0);
        assert.equal(before[0].searchedMailboxes.length, 1);
        assert.equal(before[1].totalMatches, 3);
        assert.equal(before[1].returned, 2);
        assert.equal(before[2].returned, 1);
        for (let i = 3; i < before.length; i++)
          assert.equal(before[i].totalMatches, 1, JSON.stringify(scenarios[i]));
        assert.equal(
          new Set([...before[1].messages, ...before[2].messages].map((m) => m.id)).size,
          3,
        );
      },
    );
    await check(
      'actual conflicting writer causes bounded lock refusal with no index left behind',
      async () => {
        const blocker = new Client({
          host: cfg.host,
          port: cfg.port,
          user: cfg.user,
          password: cfg.password,
          database: cfg.database,
          connectionTimeoutMillis: 3000,
        });
        try {
          await blocker.connect();
          await blocker.query('BEGIN');
          await blocker.query(`LOCK TABLE ${schema}.mail_threads IN ROW EXCLUSIVE MODE`);
          const started = performance.now();
          let failure;
          try {
            await db.query(migration);
          } catch (e) {
            failure = e;
          }
          const elapsed = performance.now() - started;
          await db.query('ROLLBACK');
          assert.equal(failure?.code, '55P03');
          assert.ok(elapsed >= 4500 && elapsed < 8000);
          assert.equal(
            (
              await db.query(
                "SELECT to_regclass('mail_threads_tenant_connection_id_cover_idx') AS relation",
              )
            ).rows[0].relation,
            null,
          );
          assert.equal((await db.query('SHOW lock_timeout')).rows[0].lock_timeout, '0');
        } finally {
          await blocker.query('ROLLBACK').catch(() => {});
          await blocker.end();
        }
      },
    );
    await check(
      'exact bounded migration creates a valid covering index without policy changes',
      async () => {
        const started = performance.now();
        await db.query(migration);
        migrationMs = performance.now() - started;
        const index = (
          await db.query(
            "SELECT indisvalid,indisready,indnkeyatts,indnatts FROM pg_index WHERE indexrelid='mail_threads_tenant_connection_id_cover_idx'::regclass",
          )
        ).rows[0];
        assert.deepEqual(index, {
          indisvalid: true,
          indisready: true,
          indnkeyatts: 3,
          indnatts: 4,
        });
        assert.equal((await db.query('SHOW lock_timeout')).rows[0].lock_timeout, '0');
      },
    );
    after = await runScenarios();
    afterPlan = await explain(count);
    await check(
      'ordinary FORCE-RLS planner uses new connection covering index and reduces thread heap work',
      async () => {
        assert.ok(
          afterPlan.nodes.some(
            (n) =>
              n.index === 'mail_threads_tenant_connection_id_cover_idx' &&
              n.node === 'Index Only Scan',
          ),
        );
        const thread = afterPlan.nodes.find(
          (n) => n.index === 'mail_threads_tenant_connection_id_cover_idx',
        );
        assert.equal(thread.heapFetches, 0);
        assert.ok(
          afterPlan.totalCost < beforePlan.totalCost,
          `cost ${beforePlan.totalCost} -> ${afterPlan.totalCost}`,
        );
      },
    );
    await check(
      'all actual source query outputs stay identical and tenant isolation remains enforced',
      async () => {
        assert.deepEqual(after, before);
        const crossed = await scope(
          async () =>
            (
              await db.query('SELECT count(*)::int AS n FROM mail_threads WHERE tenant_id=$1', [
                otherTenant,
              ])
            ).rows[0].n,
        );
        assert.equal(crossed, 0);
      },
    );
    let messageIndexPlan, messageMigrationMs;
    if (qualify452) {
      const removedProbe = await queryMailMessages(prisma, ctx, { query: 'Removed Needle', asOf });
      const largeBodyProbe = await queryMailMessages(prisma, ctx, {
        query: 'bounded-large-body',
        asOf,
      });
      await check('active-owner fixture includes removed-row and bounded large-body probes', async () => {
        const removed = await scope(async () =>
          (await db.query("SELECT removed_at IS NOT NULL AS removed FROM mail_messages WHERE id=md5('message10')::uuid")).rows[0],
        );
        assert.deepEqual(removed, { removed: true });
        assert.equal(removedProbe.totalMatches, 0);
        assert.equal(largeBodyProbe.totalMatches, 1);
        assert.equal(largeBodyProbe.returned, 1);
      });
      await check('actual conflicting writer causes bounded message-index lock refusal with no index left behind', async () => {
        const blocker = new Client({
          host: cfg.host,
          port: cfg.port,
          user: cfg.user,
          password: cfg.password,
          database: cfg.database,
          connectionTimeoutMillis: 3000,
        });
        try {
          await blocker.connect();
          await blocker.query('BEGIN');
          await blocker.query(`LOCK TABLE ${schema}.mail_messages IN ROW EXCLUSIVE MODE`);
          const started = performance.now();
          let failure;
          try {
            await db.query(messageMigration);
          } catch (e) {
            failure = e;
          }
          const elapsed = performance.now() - started;
          await db.query('ROLLBACK');
          assert.equal(failure?.code, '55P03');
          assert.ok(elapsed >= 4500 && elapsed < 8000);
          assert.equal(
            (await db.query("SELECT to_regclass('mail_messages_tenant_connection_active_idx') AS relation")).rows[0].relation,
            null,
          );
          assert.equal((await db.query('SHOW lock_timeout')).rows[0].lock_timeout, '0');
        } finally {
          await blocker.query('ROLLBACK').catch(() => {});
          await blocker.end();
        }
      });
      await check('exact 452 migration creates the valid active-owner btree index and predicate', async () => {
        const started = performance.now();
        await db.query(messageMigration);
        messageMigrationMs = performance.now() - started;
        const catalog = (
          await db.query(
            `SELECT i.indisvalid,i.indisready,i.indnkeyatts,i.indnatts,am.amname,pg_get_indexdef(i.indexrelid) AS definition,pg_get_expr(i.indpred,i.indrelid) AS predicate
             FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_am am ON am.oid=x.relam
             WHERE x.relnamespace=$1::regnamespace AND x.relname='mail_messages_tenant_connection_active_idx'`,
            [schema],
          )
        ).rows[0];
        assert.deepEqual(
          {
            indisvalid: catalog.indisvalid,
            indisready: catalog.indisready,
            indnkeyatts: catalog.indnkeyatts,
            indnatts: catalog.indnatts,
            amname: catalog.amname,
            predicate: catalog.predicate,
          },
          {
            indisvalid: true,
            indisready: true,
            indnkeyatts: 2,
            indnatts: 2,
            amname: 'btree',
            predicate: '(removed_at IS NULL)',
          },
        );
        assert.ok(catalog.definition.includes('USING btree (tenant_id, connection_id)'));
        assert.ok(catalog.definition.endsWith('WHERE (removed_at IS NULL)'));
        assert.equal((await db.query('SHOW lock_timeout')).rows[0].lock_timeout, '0');
      });
      await db.query('ANALYZE mail_messages');
      const after452 = await runScenarios();
      const removedAfter452 = await queryMailMessages(prisma, ctx, { query: 'Removed Needle', asOf });
      const largeBodyAfter452 = await queryMailMessages(prisma, ctx, {
        query: 'bounded-large-body',
        asOf,
      });
      messageIndexPlan = await explain(count);
      await check('active-owner partial index is selected in the representative count plan', async () => {
        assert.ok(
          messageIndexPlan.nodes.some(
            (n) => n.index === 'mail_messages_tenant_connection_active_idx' && n.node === 'Bitmap Index Scan',
          ),
          JSON.stringify(messageIndexPlan.nodes),
        );
      });
      await check('452 preserves all ten source scenarios, removed-row exclusion, and large-body owned search', async () => {
        assert.deepEqual(after452, after);
        assert.deepEqual(removedAfter452, removedProbe);
        assert.deepEqual(largeBodyAfter452, largeBodyProbe);
        assert.equal(removedAfter452.totalMatches, 0);
        assert.equal(largeBodyAfter452.totalMatches, 1);
      });
    }
    const report = {
      qualificationMode: qualify452 ? '452' : '451-default',
      status: 'PASS',
      checks,
      sourceHashes: hashes,
      migrationSha256: hash(migration),
      ...(qualify452
        ? {
            messageMigrationSha256: hash(messageMigration),
            messageMigrationMs,
            messageIndexPlan,
            resultScenariosUnchanged: true,
          }
        : {}),
      fixtureThreads: 100000,
      fixtureMessages: 100002,
      migrationMs,
      beforePlan,
      afterPlan,
      awsCalls: 0,
      sharedDatabaseCalls: 0,
      limits: [
        'Owned local warm-cache execution timings are diagnostic only; no production or cold-I/O latency claim.',
        'No production EXPLAIN or query executed by this script.',
        'No GIN, leakproof declaration, policy change or search semantic change.',
      ],
    };
    if (process.env.MAIL_THREAD_INDEX_REPORT)
      fs.writeFileSync(
        process.env.MAIL_THREAD_INDEX_REPORT,
        JSON.stringify(report, null, 2) + '\n',
        { flag: 'wx' },
      );
    console.log(JSON.stringify(report));
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    await db.query('RESET ROLE').catch(() => {});
    if (created) await db.query(`DROP SCHEMA ${schema} CASCADE`);
    if (roleCreated) await db.query(`DROP ROLE ${role}`);
    await db.end();
  }
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
