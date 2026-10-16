'use strict';

// Source for a fixed ECS task-definition entryPoint: ["node", "-e", source].
// This file is not in the pinned PR43 API image. The registration renderer must
// embed these exact bytes and supply the reviewed public RDS CA PEM as an env var.
// No caller-supplied SQL, migration command, URL, or positional argument exists.
const { createHash } = require('node:crypto');

const SOURCE_SHA = '13d12a7d7bdbe0be021cb218dd4cf7690cc4420b';
const DB_HOST = 'capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv.cluster-csryw28ai752.us-east-1.rds.amazonaws.com';
const DB_NAME = 'capiro';
const DB_USER = 'capiro_app';
const CA_SHA256 = '52ef9c903529fa3999e576fea1bd6ea3251c4b1cd229d2fa41c65b0ff7464c11';
const MAX_LEDGER_ROWS = 1000;
const LEDGER_FIELDS = ['checksum', 'finished', 'has_error', 'migration_name', 'rolled_back'];

const SQL = Object.freeze({
  sessionReadOnly: 'SET default_transaction_read_only = on',
  begin: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  statementTimeout: "SET LOCAL statement_timeout = '5s'",
  lockTimeout: "SET LOCAL lock_timeout = '1s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout = '10s'",
  attestation: `SELECT
    current_database() = 'capiro' AS database_ok,
    current_user = 'capiro_app' AS role_ok,
    session_user = 'capiro_app' AS session_role_ok,
    current_setting('transaction_read_only') = 'on' AS read_only_ok,
    NOT pg_is_in_recovery() AS writer_ok,
    has_table_privilege(current_user, to_regclass('public."_prisma_migrations"'), 'SELECT') AS ledger_select_ok`,
  prerequisites: `SELECT
    to_regclass('public.tenants') IS NOT NULL AS tenants_present,
    to_regclass('public.clio_conversations') IS NOT NULL AS conversations_present,
    to_regprocedure('public.current_tenant_id()') IS NOT NULL AS tenant_fn_present,
    to_regprocedure('public.rls_bypass()') IS NOT NULL AS bypass_fn_present,
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') AS app_role_present`,
  ledger: `SELECT
    migration_name,
    checksum,
    finished_at IS NOT NULL AS finished,
    rolled_back_at IS NOT NULL AS rolled_back,
    COALESCE(length(logs), 0) > 0 AS has_error
  FROM public."_prisma_migrations"
  ORDER BY started_at, migration_name`,
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
});

function requireRuntime(env, argv) {
  if (argv.length !== 1 ||
      env.DB_HOST !== DB_HOST || env.DB_PORT !== '5432' ||
      env.DB_NAME !== DB_NAME || env.DB_USER !== DB_USER ||
      !env.DB_PASSWORD || env.DB_PASSWORD === '***' ||
      (env.DATABASE_URL && env.DATABASE_URL.length > 0) ||
      env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      (env.PGSSLMODE && env.PGSSLMODE !== 'verify-full') ||
      typeof env.RDS_CA_PEM !== 'string' ||
      createHash('sha256').update(env.RDS_CA_PEM, 'utf8').digest('hex') !== CA_SHA256) {
    throw new Error('invalid fixed audit runtime');
  }
  return {
    host: DB_HOST,
    port: 5432,
    database: DB_NAME,
    user: DB_USER,
    password: env.DB_PASSWORD,
    application_name: 'capiro_first_chat_ledger_audit',
    ssl: { ca: env.RDS_CA_PEM, rejectUnauthorized: true },
    sslnegotiation: 'postgres',
    connectionTimeoutMillis: 5000,
    query_timeout: 7000,
  };
}

function requireSingleRow(result) {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1 ||
      !result.rows[0] || typeof result.rows[0] !== 'object') {
    throw new Error('unexpected audit result shape');
  }
  return result.rows[0];
}

function requireTrueFlags(row, fields) {
  if (Object.keys(row).sort().join(',') !== [...fields].sort().join(',') ||
      fields.some(field => row[field] !== true)) {
    throw new Error('audit attestation failed');
  }
  return Object.fromEntries(fields.map(field => [field, true]));
}

function requireLedgerRows(result) {
  if (!result || !Array.isArray(result.rows) || result.rows.length > MAX_LEDGER_ROWS) {
    throw new Error('invalid ledger result shape');
  }
  return result.rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        Object.keys(row).sort().join(',') !== LEDGER_FIELDS.join(',') ||
        typeof row.migration_name !== 'string' ||
        !/^\d{14}_[a-z0-9_]+$/.test(row.migration_name) ||
        typeof row.checksum !== 'string' ||
        !/^[0-9a-f]{64}$/.test(row.checksum) ||
        typeof row.finished !== 'boolean' ||
        typeof row.rolled_back !== 'boolean' ||
        typeof row.has_error !== 'boolean') {
      throw new Error('invalid ledger metadata');
    }
    return {
      migration_name: row.migration_name,
      checksum: row.checksum,
      finished: row.finished,
      rolled_back: row.rolled_back,
      has_error: row.has_error,
    };
  });
}

async function audit(env, argv, Client) {
  const config = requireRuntime(env, argv);
  const client = new Client(config);
  let connected = false;
  let inTransaction = false;
  try {
    await client.connect();
    connected = true;
    const stream = client.connection && client.connection.stream;
    if (!stream || stream.encrypted !== true || stream.authorized !== true ||
        stream.servername !== DB_HOST) {
      throw new Error('TLS attestation failed');
    }

    await client.query(SQL.sessionReadOnly);
    await client.query(SQL.begin);
    inTransaction = true;
    await client.query(SQL.statementTimeout);
    await client.query(SQL.lockTimeout);
    await client.query(SQL.idleTimeout);

    const attestation = requireTrueFlags(requireSingleRow(await client.query(SQL.attestation)), [
      'database_ok', 'role_ok', 'session_role_ok', 'read_only_ok', 'writer_ok', 'ledger_select_ok',
    ]);
    const prerequisites = requireTrueFlags(requireSingleRow(await client.query(SQL.prerequisites)), [
      'tenants_present', 'conversations_present', 'tenant_fn_present', 'bypass_fn_present', 'app_role_present',
    ]);
    const ledger = requireLedgerRows(await client.query(SQL.ledger));
    await client.query(SQL.commit);
    inTransaction = false;

    return {
      schemaVersion: 1,
      sourceSha: SOURCE_SHA,
      attestation: { tls_verified: true, ...attestation },
      prerequisites,
      ledger,
    };
  } finally {
    if (connected && inTransaction) {
      try { await client.query(SQL.rollback); } catch { /* preserve failure */ }
    }
    if (connected) {
      try { await client.end(); } catch { /* preserve failure */ }
    }
  }
}

// `module.parent` is set when the focused local test imports this file. In the
// ECS `node -e` entryPoint it is absent, so the fixed task runs automatically.
if (!module.parent) {
  (async () => {
    const { Client } = require('pg');
    const result = await audit(process.env, process.argv, Client);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })().catch(() => {
    process.stderr.write('BLOCK: fixed migration ledger audit failed\n');
    process.exitCode = 1;
  });
}

module.exports = { audit, requireRuntime, requireLedgerRows, SQL };
