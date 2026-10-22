'use strict';

// A1's native tests are opt-in and can mutate ONLY a new schema in an explicitly
// named loopback disposable database. No production/default DATABASE_URL fallback.
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DATABASE_PREFIX = /^a1_disposable_[a-z0-9_]{8,48}$/;
const SCHEMA_NAME = /^a1_native_[a-f0-9]{24}$/;
const SAFE_CONNECT_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET']);

function disposableConfiguration(env = process.env) {
  const input = env.A1_NATIVE_PG_URL;
  if (!input) return null;
  if (env.A1_NATIVE_PG_ALLOW_DISPOSABLE !== '1') {
    throw new Error('A1 native PostgreSQL requires A1_NATIVE_PG_ALLOW_DISPOSABLE=1.');
  }
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error('A1_NATIVE_PG_URL is not a valid disposable PostgreSQL URL.'); }
  const port = Number(parsed.port);
  let database;
  try { database = decodeURIComponent(parsed.pathname.slice(1)); } catch { database = ''; }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)
    || !Number.isInteger(port) || port < 1024 || port > 65535
    || !parsed.username || !DATABASE_PREFIX.test(database)
    || parsed.search || parsed.hash) {
    throw new Error('A1_NATIVE_PG_URL must name an explicit loopback port and a1_disposable_<nonce> database, with no query or fragment.');
  }
  return { url: parsed.toString(), database };
}

function packageFile(repoRoot, specifier) {
  return require.resolve(specifier, { paths: [path.join(repoRoot, 'apps', 'api')] });
}

function childEnvironment(url) {
  // Prisma runs outside the checkout, so it cannot load a repository .env. Only
  // these process necessities are retained; no inherited database or cloud vars.
  const env = { DATABASE_URL: url, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' };
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TMPDIR', 'TMP', 'TEMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function nativePostgresReadiness({ repoRoot }) {
  const config = disposableConfiguration();
  if (!config) return { available: false, reason: 'A1_NATIVE_PG_URL is unset; disposable PostgreSQL 16 qualification is Fable-run.' };
  const pgPath = packageFile(repoRoot, 'pg');
  const source = `
    const fs = require('node:fs');
    const { Client } = require(process.argv[1]);
    const { url, database } = JSON.parse(fs.readFileSync(0, 'utf8'));
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000, query_timeout: 3000, ssl: false });
    (async () => {
      try {
        await client.connect();
        const r = await client.query("SELECT current_database() AS database, current_setting('server_version_num')::int AS version");
        const row = r.rows[0];
        if (row.database !== database || row.version < 160000 || row.version >= 170000) {
          process.stdout.write(JSON.stringify({ invalid: true }));
        } else process.stdout.write(JSON.stringify({ available: true }));
      } catch (e) {
        process.stdout.write(JSON.stringify({ code: typeof e.code === 'string' ? e.code : 'CONNECT_FAILED' }));
      } finally { await client.end().catch(() => {}); }
    })();`;
  const result = spawnSync(process.execPath, ['-e', source, pgPath], {
    input: JSON.stringify(config), encoding: 'utf8', timeout: 8000,
    env: childEnvironment(config.url), maxBuffer: 64 * 1024,
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    return { available: false, reason: 'Disposable PostgreSQL connection probe timed out; native qualification is Fable-run.' };
  }
  if (result.error || result.status !== 0) throw new Error('A1 disposable PostgreSQL probe could not run.');
  let receipt;
  try { receipt = JSON.parse(result.stdout); } catch { throw new Error('A1 disposable PostgreSQL probe returned no valid receipt.'); }
  if (receipt.invalid) throw new Error('A1 native tests require PostgreSQL 16 and the exact disposable database identity.');
  if (receipt.available === true) return { available: true, reason: 'Explicit disposable PostgreSQL 16 is reachable.' };
  if (SAFE_CONNECT_CODES.has(receipt.code) || receipt.code === 'CONNECT_FAILED') {
    return { available: false, reason: `Disposable PostgreSQL is unreachable (${receipt.code}); native qualification is Fable-run.` };
  }
  // Authentication, nonexistent database, and SQL errors are configuration/gate
  // failures, not an excuse to silently skip a configured native qualification.
  throw new Error('Configured disposable PostgreSQL rejected the probe; check its database, credentials and PostgreSQL 16 setup.');
}

function schemaWithoutConnections(text, label) {
  const generators = [...text.matchAll(/^generator\s+\w+\s*\{[\s\S]*?^\}/gm)];
  const datasources = [...text.matchAll(/^datasource\s+\w+\s*\{[\s\S]*?^\}/gm)];
  if (generators.length !== 1 || datasources.length !== 1) throw new Error(`${label} must have exactly one generator and datasource.`);
  return text.replace(generators[0][0], '').replace(datasources[0][0], '');
}

function composeSchema(coreText, workspaceText, extraModels = '') {
  const datasource = [...coreText.matchAll(/^datasource\s+\w+\s*\{[\s\S]*?^\}/gm)];
  const generator = [...coreText.matchAll(/^generator\s+\w+\s*\{[\s\S]*?^\}/gm)];
  if (datasource.length !== 1 || generator.length !== 1
    || !/^\s*provider\s*=\s*"postgresql"\s*$/m.test(datasource[0][0])
    || !/^\s*url\s*=\s*env\("DATABASE_URL"\)\s*$/m.test(datasource[0][0])
    || /\b(?:directUrl|shadowDatabaseUrl)\s*=/.test(datasource[0][0])) {
    throw new Error('Core fixture schema must use only PostgreSQL DATABASE_URL, with no direct/shadow endpoint.');
  }
  if (/^\s*(?:datasource|generator)\b/m.test(extraModels)) throw new Error('Fixture additions must contain models/enums only.');
  const combined = [coreText, workspaceText ? schemaWithoutConnections(workspaceText, 'Workspace') : '', extraModels].join('\n');
  const declarations = new Set();
  for (const match of combined.matchAll(/^\s*(?:model|enum|type)\s+(\w+)\s*\{/gm)) {
    if (declarations.has(match[1])) throw new Error(`Duplicate fixture declaration: ${match[1]}`);
    declarations.add(match[1]);
  }
  return combined;
}

async function assertServer(client, database) {
  const { rows } = await client.query("SELECT current_database() AS database, current_setting('server_version_num')::int AS version");
  if (rows[0]?.database !== database || rows[0]?.version < 160000 || rows[0]?.version >= 170000) {
    throw new Error('A1 native schema creation refused: database identity or PostgreSQL 16 version mismatch.');
  }
}

async function dropOwnedSchema(client, schema, token) {
  if (!SCHEMA_NAME.test(schema) || !/^a1-native-owner:[a-f0-9]{48}$/.test(token)) throw new Error('Invalid disposable schema ownership receipt.');
  const { rows } = await client.query(
    "SELECT obj_description(oid, 'pg_namespace') AS owner FROM pg_namespace WHERE nspname = $1", [schema],
  );
  if (rows.length === 0) return;
  if (rows.length !== 1 || rows[0].owner !== token) throw new Error('Refusing to drop a schema without the exact A1 ownership receipt.');
  await client.query(`DROP SCHEMA "${schema}" CASCADE`);
}

async function createDisposableSchema({ repoRoot, coreSchemaPath, workspaceSchemaPath, extraModels = '' }) {
  const config = disposableConfiguration();
  if (!config) throw new Error('A1 native schema creation requires the explicit disposable PostgreSQL configuration.');
  const { Client } = require(packageFile(repoRoot, 'pg'));
  const cli = packageFile(repoRoot, 'prisma/build/index.js');
  const schemaText = composeSchema(
    fs.readFileSync(coreSchemaPath, 'utf8'),
    workspaceSchemaPath ? fs.readFileSync(workspaceSchemaPath, 'utf8') : undefined,
    extraModels,
  );
  const schema = `a1_native_${randomBytes(12).toString('hex')}`;
  const token = `a1-native-owner:${randomBytes(24).toString('hex')}`;
  const ownedUrl = new URL(config.url);
  ownedUrl.searchParams.set('schema', schema);
  const url = ownedUrl.toString();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-native-schema-'));
  const schemaPath = path.join(temp, 'schema.prisma');
  fs.writeFileSync(schemaPath, schemaText, { mode: 0o600 });
  let closed = false;
  const client = new Client({ connectionString: config.url, connectionTimeoutMillis: 3000, query_timeout: 30000, ssl: false });
  let connected = false;
  const cleanup = async () => {
    if (closed) return;
    // A fresh connection also handles a dropped setup connection/ambiguous ACK.
    const cleaner = new Client({ connectionString: config.url, connectionTimeoutMillis: 3000, query_timeout: 30000, ssl: false });
    try {
      await cleaner.connect();
      await assertServer(cleaner, config.database);
      await dropOwnedSchema(cleaner, schema, token);
      closed = true;
    } finally {
      await cleaner.end().catch(() => {});
      fs.rmSync(temp, { recursive: true, force: true });
    }
  };
  try {
    await client.connect();
    connected = true;
    await assertServer(client, config.database);
    await client.query('BEGIN');
    // CREATE has no IF NOT EXISTS: a collision cannot claim a preexisting schema.
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`COMMENT ON SCHEMA "${schema}" IS '${token}'`);
    await client.query('COMMIT');
    const result = spawnSync(process.execPath, [cli, 'db', 'push', '--schema', schemaPath, '--skip-generate'], {
      cwd: temp, env: childEnvironment(url), encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      // Do not forward Prisma stderr: it can echo credentials or inherited URLs.
      throw new Error(`Disposable prisma db push failed (exit ${result.status ?? 'unavailable'}); check the pinned Prisma client and PG16 extensions. No native gate passed.`);
    }
    return { url, schema, cleanup };
  } catch (error) {
    if (connected) await client.query('ROLLBACK').catch(() => {});
    // Close the setup connection before inspecting ownership: an in-flight
    // CREATE/COMMIT cannot finish after cleanup has observed an absent schema.
    await client.end().catch(() => {});
    try { await cleanup(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'A1 disposable setup failed and its owned schema cleanup could not complete.');
    }
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = {
  nativePostgresReadiness,
  createDisposableSchema,
  // Pure ownership/configuration components are exported for safety regression tests.
  disposableConfiguration,
  composeSchema,
  dropOwnedSchema,
  childEnvironment,
};
