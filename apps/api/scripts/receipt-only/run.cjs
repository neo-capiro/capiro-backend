'use strict';

// One-purpose first-chat receipt migration for a fixed node -e ECS entrypoint.
// The exact qualified PR48 image supplies Prisma, pg and the source files.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { MIGRATION, verifyBundle } = require('./verify-bundle.cjs');

const execFileAsync = promisify(execFile);
const TARGET = Object.freeze({
  host: 'capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv.cluster-csryw28ai752.us-east-1.rds.amazonaws.com',
  port: 5432,
  database: 'capiro',
  schema: 'public',
  role: 'capiro_master',
  caSha256: '52ef9c903529fa3999e576fea1bd6ea3251c4b1cd229d2fa41c65b0ff7464c11',
});
const CLI = '/app/apps/api/node_modules/prisma/build/index.js';
const IMAGE_PRISMA = '/app/apps/api/prisma';
const IMAGE_SCHEMA_SHA256 = 'c909a6ce3610f35b9179473af3bf6f418a6e47b4c5ba761bac157aa41b9b0498';
const ENGINE_COMMIT = '605197351a3c8bdd595af2d2a9bc3025bca48ea2';
const SINGLE_CA_SHA256 = 'b4e7459e5d6a98672a557c20bfbb0bd4251983dc563bc4f8e2976ac3426a12ed';
const MAX_LEDGER_ROWS = 800; // audited capiro-dev baseline: 646
const MAX_CHILD_OUTPUT = 65536;
// `db execute` discards query rows. A fixed error-on-mismatch block provides
// an exit-status gate through Prisma's own schema-engine connection. It reads
// session/catalog state only and cannot change persistent database state.
const PRISMA_NAMESPACE_SQL = `DO $receipt_namespace$
BEGIN
  IF current_schema() IS DISTINCT FROM 'public'
    OR current_database() IS DISTINCT FROM 'capiro'
    OR current_user IS DISTINCT FROM 'capiro_master'
    OR pg_is_in_recovery() IS DISTINCT FROM false
    OR current_setting('transaction_read_only') IS DISTINCT FROM 'off'
    OR COALESCE((SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid = pg_backend_pid()), false) IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION 'receipt-only Prisma namespace check failed';
  END IF;
END
$receipt_namespace$;`;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function requireRuntime(env, argv) {
  assert.equal(argv.length, 1, 'arguments are forbidden');
  assert.equal(env.NODE_OPTIONS, '', 'Node preload/option override is forbidden');
  assert(!Object.hasOwn(env, 'DATABASE_URL'), 'database URL override is forbidden');
  for (const key of Object.keys(env)) {
    assert(!key.startsWith('PG'), 'PostgreSQL environment override is forbidden');
  }
  for (const key of Object.keys(env)) {
    assert(!key.startsWith('PRISMA_'), 'Prisma override is forbidden');
  }
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME']) {
    assert(!Object.hasOwn(env, key), 'database target is in source, not environment');
  }
  assert.equal(env.DB_USER, TARGET.role, 'migration role differs');
  assert(env.DB_PASSWORD && env.DB_PASSWORD !== '***', 'missing migration credential');
  assert.equal(sha256(Buffer.from(env.RDS_CA_PEM || '', 'utf8')), TARGET.caSha256, 'RDS CA bundle differs');
  const matches = env.RDS_CA_PEM.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  assert(matches && matches.length === 3, 'RDS CA bundle inventory differs');
  const first = new crypto.X509Certificate(matches[0]);
  assert(first.subject.includes('CN=Amazon RDS us-east-1 Root CA RSA2048 G1'), 'RDS CA identity differs');
  const single = matches[0] + '\n';
  assert.equal(sha256(Buffer.from(single)), SINGLE_CA_SHA256, 'single RDS root differs');
  return single;
}

function stageBundle(scratch, imagePrisma = IMAGE_PRISMA) {
  const root = path.join(scratch, 'prisma');
  const migrationDir = path.join(root, 'migrations', MIGRATION);
  fs.mkdirSync(migrationDir, { recursive: true, mode: 0o700 });
  const sourceSchema = path.join(imagePrisma, 'schema.prisma');
  const sourceLock = path.join(imagePrisma, 'migrations', 'migration_lock.toml');
  const sourceSql = path.join(imagePrisma, 'migrations', MIGRATION, 'migration.sql');
  for (const file of [sourceSchema, sourceLock, sourceSql]) {
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'image source is not a regular file');
  }
  const imageSchema = fs.readFileSync(sourceSchema);
  assert.equal(imageSchema.length, 989414, 'image-local schema length differs');
  assert.equal(sha256(imageSchema), IMAGE_SCHEMA_SHA256, 'image-local schema hash differs');
  const from = '"linux-musl-openssl-3.0.x"';
  const to = '"linux-arm64-openssl-3.0.x"';
  const text = imageSchema.toString('utf8');
  const generator = /generator client\s*\{[^}]*\}/.exec(text);
  assert(generator && generator[0].split(from).length === 2, 'image-local generator target differs');
  const canonical = text.replace(generator[0], generator[0].replace(from, to));
  fs.writeFileSync(path.join(root, 'schema.prisma'), canonical, { mode: 0o600, flag: 'wx' });
  fs.copyFileSync(sourceLock, path.join(root, 'migrations', 'migration_lock.toml'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(sourceSql, path.join(migrationDir, 'migration.sql'), fs.constants.COPYFILE_EXCL);
  return root;
}

function makePrismaUrl(password, certPath) {
  const url = new URL(`postgresql://${TARGET.host}:${TARGET.port}/${TARGET.database}`);
  url.username = TARGET.role;
  url.password = password;
  url.searchParams.set('schema', TARGET.schema);
  // Pinned Prisma 5.22 accepts these three exact parameters. It does not
  // recognize libpq's verify-full. Strict enables chain and hostname checks
  // using this pinned RDS root plus native-tls system roots. The direct
  // node-postgres attestation separately verifies the exact Aurora hostname.
  url.searchParams.set('sslmode', 'require');
  url.searchParams.set('sslcert', certPath);
  url.searchParams.set('sslaccept', 'strict');
  url.searchParams.set('connect_timeout', '5');
  url.searchParams.set('application_name', 'capiro_first_chat_receipt_only');
  return url.toString();
}

async function checkCli() {
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--version'], {
    env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'production', CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    timeout: 10000,
    maxBuffer: 16384,
  });
  assert(/prisma\s*:\s*5\.22\.0/.test(stdout), 'Prisma CLI version differs');
  assert(stdout.includes(ENGINE_COMMIT), 'Prisma engine commit differs');
}

function pgConfig(env) {
  return {
    host: TARGET.host,
    port: TARGET.port,
    database: TARGET.database,
    user: TARGET.role,
    password: env.DB_PASSWORD,
    ssl: { ca: env.RDS_CA_PEM, rejectUnauthorized: true, servername: TARGET.host },
    options: '-c search_path=public',
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    application_name: 'capiro_first_chat_receipt_only_prepost',
  };
}

const SQL = Object.freeze({
  attestation: `SELECT current_database() AS database_name, current_user AS current_role,
    session_user AS session_role, current_schema() AS schema_name,
    current_setting('transaction_read_only') AS read_only, pg_is_in_recovery() AS in_recovery,
    (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls`,
  privileges: `SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS public_usage,
    has_schema_privilege(current_user, 'public', 'CREATE') AS public_create,
    has_column_privilege(current_user, 'public.tenants', 'id', 'REFERENCES') AS tenants_ref,
    has_column_privilege(current_user, 'public.clio_conversations', 'id', 'REFERENCES') AS conversations_ref,
    has_table_privilege(current_user, 'public."_prisma_migrations"', 'SELECT') AS ledger_select,
    has_table_privilege(current_user, 'public."_prisma_migrations"', 'INSERT') AS ledger_insert,
    has_table_privilege(current_user, 'public."_prisma_migrations"', 'UPDATE') AS ledger_update`,
  ledger: `SELECT id::text, migration_name, checksum, started_at::text,
    finished_at::text, rolled_back_at::text, applied_steps_count,
    length(logs) AS logs_length, md5(logs) AS logs_md5
    FROM public."_prisma_migrations" ORDER BY id LIMIT 801`,
  relation: `SELECT c.relkind, c.relrowsecurity, c.relforcerowsecurity,
    pg_get_userbyid(c.relowner) AS owner
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='clio_conversation_bootstrap_receipts'`,
  function: `SELECT p.prosecdef, l.lanname, p.prosrc
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE n.nspname='public' AND p.proname='clio_bootstrap_receipt_update_guard' AND p.pronargs=0`,
  columns: `SELECT a.attname, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type_name,
    a.attnotnull, pg_get_expr(d.adbin,d.adrelid) AS default_expr
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relname='clio_conversation_bootstrap_receipts'
      AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
  constraints: `SELECT x.conname, x.contype, x.convalidated,
    x.confrelid::regclass::text AS referenced_relation, x.confdeltype,
    pg_get_constraintdef(x.oid,true) AS definition
    FROM pg_catalog.pg_constraint x JOIN pg_catalog.pg_class c ON c.oid=x.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='clio_conversation_bootstrap_receipts' ORDER BY x.conname`,
  indexes: `SELECT i.relname, x.indisunique, x.indisprimary, x.indisvalid, x.indisready
    FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid=x.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname='clio_conversation_bootstrap_receipts' ORDER BY i.relname`,
  trigger: `SELECT t.tgname, t.tgenabled, t.tgisinternal, p.proname AS function_name,
    pg_get_triggerdef(t.oid) AS definition
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    WHERE n.nspname='public' AND c.relname='clio_conversation_bootstrap_receipts'
      AND NOT t.tgisinternal`,
  policy: `SELECT p.polname, p.polcmd, p.polpermissive, p.polroles::text AS roles,
    pg_get_expr(p.polqual,p.polrelid) AS using_expr,
    pg_get_expr(p.polwithcheck,p.polrelid) AS check_expr
    FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='clio_conversation_bootstrap_receipts'`,
  base: `SELECT c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN
      ('tenants','clients','client_memory_access','clio_conversations') ORDER BY c.relname`,
  baseKeys: `SELECT c.relname, a.attname, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type_name,
    a.attnotnull, x.convalidated
    FROM pg_catalog.pg_constraint x JOIN pg_catalog.pg_class c ON c.oid=x.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=ANY(x.conkey)
    WHERE n.nspname='public' AND c.relname IN ('tenants','clio_conversations')
      AND x.contype='p' ORDER BY c.relname`,
  baseFunctions: `SELECT p.proname, p.prosecdef
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('current_tenant_id','rls_bypass')
      AND p.pronargs=0 ORDER BY p.proname`,
});

async function snapshot(Client, env, phase) {
  const client = new Client(pgConfig(env));
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
    await client.query("SET LOCAL timezone = 'UTC'");
    const one = async sql => (await client.query(sql)).rows;
    const attestation = await one(SQL.attestation);
    assert.equal(attestation.length, 1);
    assert.deepEqual(attestation[0], {
      database_name: TARGET.database, current_role: TARGET.role,
      session_role: TARGET.role, schema_name: TARGET.schema,
      read_only: 'on', in_recovery: false, tls: true,
    }, 'database, namespace, writer, role, read-only or TLS attestation failed');
    const ledger = await one(SQL.ledger);
    assert(ledger.length <= MAX_LEDGER_ROWS, 'migration ledger exceeded bound');
    const result = { ledger, relation: await one(SQL.relation), func: await one(SQL.function) };
    if (phase === 'pre') {
      assert(ledger.every(r => r.finished_at || r.rolled_back_at), 'unfinished migration exists');
      const privileges = await one(SQL.privileges);
      assert.equal(privileges.length, 1);
      assert(Object.values(privileges[0]).every(Boolean), 'migration role lacks required rights');
      const base = await one(SQL.base);
      assert.deepEqual(base.map(r => r.relname), ['client_memory_access','clients','clio_conversations','tenants']);
      assert(base.every(r => r.relkind === 'r' && r.relrowsecurity && r.relforcerowsecurity), 'base first-chat relation changed');
      const baseKeys = await one(SQL.baseKeys);
      assert.deepEqual(baseKeys.map(r => [r.relname,r.attname,r.type_name,r.attnotnull,r.convalidated]), [
        ['clio_conversations','id','uuid',true,true], ['tenants','id','uuid',true,true],
      ], 'referenced primary key changed');
      const baseFunctions = await one(SQL.baseFunctions);
      assert.deepEqual(baseFunctions, [
        { proname:'current_tenant_id', prosecdef:false }, { proname:'rls_bypass', prosecdef:false },
      ], 'tenant/RLS function changed');
    } else {
      for (const field of ['columns','constraints','indexes','trigger','policy']) result[field] = await one(SQL[field]);
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve first failure */ }
    throw error;
  } finally {
    await client.end();
  }
}

function assertPre(pre) {
  assert(pre.ledger.every(r => r.migration_name !== MIGRATION), 'receipt already has a ledger row');
  assert.equal(pre.relation.length, 0, 'receipt relation already exists');
  assert.equal(pre.func.length, 0, 'receipt guard function already exists');
}

function compareLedger(pre, post, migrationSha256) {
  const before = new Map(pre.ledger.map(r => [r.id, r]));
  const after = new Map(post.ledger.map(r => [r.id, r]));
  for (const [id, row] of before) assert.deepEqual(after.get(id), row, 'old migration ledger row changed');
  const added = post.ledger.filter(r => !before.has(r.id));
  assert.equal(added.length, 1, 'expected one new migration ledger ID');
  assert.equal(added[0].migration_name, MIGRATION);
  assert.equal(added[0].checksum, migrationSha256);
  assert(added[0].finished_at && !added[0].rolled_back_at, 'receipt migration not finished');
}

function assertPost(pre, post, migrationSha256) {
  compareLedger(pre, post, migrationSha256);
  assert.deepEqual(post.relation.map(r => [r.relkind, r.relrowsecurity, r.relforcerowsecurity]), [['r', true, true]]);
  assert.equal(post.relation[0].owner, TARGET.role);
  assert.equal(post.func.length, 1);
  assert.equal(post.func[0].lanname, 'plpgsql');
  assert.equal(post.func[0].prosecdef, false);
  for (const fragment of [
    'OLD.conversation_id IS NOT NULL', 'NEW.conversation_id IS NULL',
    'NEW.tenant_id=OLD.tenant_id', 'NEW.actor_user_id=OLD.actor_user_id',
    'NEW.request_id=OLD.request_id', 'NEW.client_id=OLD.client_id',
    'NEW.created_at=OLD.created_at', "ERRCODE='23514'",
  ]) {
    assert(post.func[0].prosrc.includes(fragment), 'receipt update guard body changed');
  }
  const columns = [
    ['tenant_id', 'uuid', true], ['actor_user_id', 'uuid', true],
    ['request_id', 'uuid', true], ['client_id', 'uuid', true],
    ['conversation_id', 'uuid', false], ['created_at', 'timestamp(6) with time zone', true],
  ];
  assert.deepEqual(post.columns.map(r => [r.attname, r.type_name, r.attnotnull]), columns);
  assert.equal(post.columns[5].default_expr, 'CURRENT_TIMESTAMP');
  const constraints = new Map(post.constraints.map(r => [r.conname, r]));
  assert.deepEqual([...constraints.keys()].sort(), [
    'clio_bootstrap_receipts_conversation_fkey', 'clio_bootstrap_receipts_conversation_key',
    'clio_bootstrap_receipts_pkey', 'clio_bootstrap_receipts_tenant_fkey',
  ].sort());
  assert.equal(constraints.get('clio_bootstrap_receipts_pkey').contype, 'p');
  assert.equal(constraints.get('clio_bootstrap_receipts_conversation_key').contype, 'u');
  assert.equal(constraints.get('clio_bootstrap_receipts_tenant_fkey').confdeltype, 'c');
  assert.equal(constraints.get('clio_bootstrap_receipts_conversation_fkey').confdeltype, 'n');
  assert.equal(constraints.get('clio_bootstrap_receipts_tenant_fkey').referenced_relation, 'tenants');
  assert.equal(constraints.get('clio_bootstrap_receipts_conversation_fkey').referenced_relation, 'clio_conversations');
  assert([...constraints.values()].every(r => r.convalidated));
  assert.equal(constraints.get('clio_bootstrap_receipts_pkey').definition,
    'PRIMARY KEY (tenant_id, actor_user_id, request_id)');
  assert.equal(constraints.get('clio_bootstrap_receipts_conversation_key').definition,
    'UNIQUE (conversation_id)');
  assert.match(constraints.get('clio_bootstrap_receipts_tenant_fkey').definition,
    /^FOREIGN KEY \(tenant_id\) REFERENCES (?:public\.)?tenants\(id\) ON DELETE CASCADE$/);
  assert.match(constraints.get('clio_bootstrap_receipts_conversation_fkey').definition,
    /^FOREIGN KEY \(conversation_id\) REFERENCES (?:public\.)?clio_conversations\(id\) ON DELETE SET NULL$/);
  assert.deepEqual(post.indexes.map(r => [r.relname,r.indisunique,r.indisvalid,r.indisready]), [
    ['clio_bootstrap_receipts_conversation_key',true,true,true],
    ['clio_bootstrap_receipts_pkey',true,true,true],
  ]);
  assert.equal(post.indexes[1].indisprimary, true);
  assert.equal(post.trigger.length, 1);
  assert.deepEqual([
    post.trigger[0].tgname,post.trigger[0].tgenabled,post.trigger[0].tgisinternal,
    post.trigger[0].function_name,
  ], ['clio_bootstrap_receipt_immutable','O',false,'clio_bootstrap_receipt_update_guard']);
  assert.match(post.trigger[0].definition,
    /^CREATE TRIGGER clio_bootstrap_receipt_immutable BEFORE UPDATE ON (?:public\.)?clio_conversation_bootstrap_receipts FOR EACH ROW EXECUTE FUNCTION (?:public\.)?clio_bootstrap_receipt_update_guard\(\)$/);
  assert.equal(post.policy.length, 1);
  assert.equal(post.policy[0].polname, 'clio_bootstrap_receipts_isolation');
  assert.equal(post.policy[0].polcmd, '*');
  assert.equal(post.policy[0].polpermissive, true);
  assert.equal(post.policy[0].roles, '{0}');
  for (const key of ['using_expr','check_expr']) {
    const expr = post.policy[0][key].replace(/\s+/g, ' ');
    assert(expr.includes('rls_bypass()') && expr.includes('current_tenant_id()') && expr.includes('tenant_id'));
  }
}

function prismaChildOptions(url, root, timeout) {
  return {
    cwd: path.dirname(root),
    env: {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: path.dirname(root), TMPDIR: '/dev/shm', NODE_ENV: 'production',
      DATABASE_URL: url, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1',
    },
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_CHILD_OUTPUT,
  };
}

async function prismaNamespacePreflight(url, root, execute = execFile) {
  // `--schema` resolves exactly the staged schema's datasource. stdin is the
  // fixed read-only block above, never a caller-supplied script or URL flag.
  const result = await new Promise((resolve, reject) => {
    const child = execute(process.execPath,
      [CLI, 'db', 'execute', `--schema=${root}/schema.prisma`, '--stdin'],
      prismaChildOptions(url, root, 60000),
      (error, stdout, stderr) => {
        const outputSha256 = sha256(Buffer.from(String(stdout || '') + String(stderr || '')));
        if (error || !String(stdout).includes('Script executed successfully.')) {
          reject(new Error(`Prisma namespace preflight failed; output_sha256=${outputSha256}`));
        }
        else resolve({ outputSha256 });
      });
    child.stdin.on('error', () => {}); // A child that exits early can close stdin.
    child.stdin.end(PRISMA_NAMESPACE_SQL);
  });
  return result;
}

async function prismaDeploy(url, root) {
  const start = Date.now();
  try {
    const result = await execFileAsync(process.execPath,
      [CLI, 'migrate', 'deploy', `--schema=${root}/schema.prisma`],
      prismaChildOptions(url, root, 240000));
    return { ok: true, elapsedMs: Date.now() - start, outputSha256: sha256(Buffer.from(result.stdout + result.stderr)) };
  } catch (error) {
    // Prisma may echo a URL on failure. Never relay its raw stdout/stderr.
    return { ok: false, elapsedMs: Date.now() - start, timedOut: Boolean(error.killed), outputSha256: sha256(Buffer.from(String(error.stdout || '') + String(error.stderr || ''))) };
  }
}

async function main() {
  const rsaRoot = requireRuntime(process.env, process.argv);
  await checkCli();
  const tmp = fs.mkdtempSync(path.join('/dev/shm', 'capiro-receipt-only-'));
  const certPath = path.join(tmp, 'rds-ca-rsa2048-g1.pem');
  try {
    const root = stageBundle(tmp);
    const { migrationSha256 } = verifyBundle(root);
    fs.writeFileSync(certPath, rsaRoot, { mode: 0o600, flag: 'wx' });
    const Client = require('/app/apps/api/node_modules/pg').Client;
    const pre = await snapshot(Client, process.env, 'pre');
    assertPre(pre);
    // The direct pg connection above validated the exact Aurora DNS hostname,
    // pinned CA bundle, writer, role, database and public search path.
    process.stdout.write(`RECEIPT_ONLY_PREFLIGHT_OK ledger=${pre.ledger.length}\n`);
    const url = makePrismaUrl(process.env.DB_PASSWORD, certPath);
    const namespace = await prismaNamespacePreflight(url, root);
    process.stdout.write(`PRISMA_NAMESPACE_OK output_sha256=${namespace.outputSha256}\n`);
    const result = await prismaDeploy(url, root);
    // Even a failed or timed-out Prisma child gets an independent read-only
    // ledger/catalog comparison. An unreadable result is an uncertain outcome.
    let post;
    try { post = await snapshot(Client, process.env, 'post'); }
    catch { throw new Error('post-migration ledger/catalog snapshot unavailable; outcome uncertain'); }
    const previousIds = new Set(pre.ledger.map(r => r.id));
    const newRows = post.ledger.filter(r => !previousIds.has(r.id));
    const unfinished = post.ledger.filter(r => !r.finished_at && !r.rolled_back_at);
    process.stdout.write(`RECEIPT_ONLY_POST_OBSERVED new_ledger_rows=${newRows.length} unfinished=${unfinished.length} receipt_relations=${post.relation.length}\n`);
    if (!result.ok) throw new Error(`Prisma exited unsuccessfully; outcome held; output_sha256=${result.outputSha256}`);
    assertPost(pre, post, migrationSha256);
    process.stdout.write(`RECEIPT_ONLY_APPLY_AND_POSTCHECK_OK ledger=${post.ledger.length} output_sha256=${result.outputSha256}\n`);
  } finally {
    // tmp came only from mkdtempSync under the fixed /dev/shm prefix.
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(() => {
    // No exception text: it may contain a credential-bearing connection URL.
    process.stderr.write('HOLD: receipt-only migration failed or outcome uncertain; do not retry\n');
    process.exitCode = 1;
  });
}

module.exports = { TARGET, requireRuntime, makePrismaUrl, stageBundle, assertPre, compareLedger, assertPost, SQL, PRISMA_NAMESPACE_SQL, prismaNamespacePreflight, main };
