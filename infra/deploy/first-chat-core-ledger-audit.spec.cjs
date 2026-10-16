'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { audit, requireRuntime, SQL } = require('./first-chat-core-ledger-audit.cjs');

const ca = readFileSync(join(__dirname, '../../docs/meri/releases/2026-10-02/composed-eval-prerequisites/readback/rds-us-east-1-bundle.pem'), 'utf8');
const host = 'capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv.cluster-csryw28ai752.us-east-1.rds.amazonaws.com';
const env = {
  DB_HOST: host,
  DB_PORT: '5432',
  DB_NAME: 'capiro',
  DB_USER: 'capiro_app',
  DB_PASSWORD: 'test-password-never-output',
  RDS_CA_PEM: ca,
};

function fakeClient(options = {}) {
  const queries = [];
  const attest = {
    database_ok: true, role_ok: true, session_role_ok: true,
    read_only_ok: true, writer_ok: true, ledger_select_ok: true,
    ...options.attestation,
  };
  const prerequisites = {
    tenants_present: true, conversations_present: true,
    tenant_fn_present: true, bypass_fn_present: true, app_role_present: true,
  };
  class Client {
    constructor(config) {
      assert.equal(config.ssl.rejectUnauthorized, true);
      assert.equal(config.host, host);
      this.connection = {
        stream: {
          encrypted: true, authorized: options.tlsAuthorized !== false,
          servername: host,
        },
      };
    }
    async connect() { queries.push('CONNECT'); }
    async query(sql) {
      queries.push(sql);
      if (sql === SQL.attestation) return { rows: [attest] };
      if (sql === SQL.prerequisites) return { rows: [prerequisites] };
      if (sql === SQL.ledger) return { rows: options.ledger ?? [{
        migration_name: '20281016020000_clio_conversation_bootstrap_receipts',
        checksum: 'a'.repeat(64), finished: false, rolled_back: false, has_error: false,
      }] };
      return { rows: [] };
    }
    async end() { queries.push('END'); }
  }
  return { Client, queries };
}

test('fixed reader attests TLS, role, writer, privileges, and a read-only transaction before exporting five fields', async () => {
  const { Client, queries } = fakeClient();
  const result = await audit(env, ['node'], Client);
  assert.deepEqual(Object.keys(result), ['schemaVersion', 'sourceSha', 'attestation', 'prerequisites', 'ledger']);
  assert.equal(result.attestation.tls_verified, true);
  assert.equal(result.attestation.ledger_select_ok, true);
  assert.deepEqual(Object.keys(result.ledger[0]).sort(),
    ['checksum', 'finished', 'has_error', 'migration_name', 'rolled_back']);
  assert.equal(JSON.stringify(result).includes(env.DB_PASSWORD), false);
  assert.deepEqual(queries, [
    'CONNECT', SQL.sessionReadOnly, SQL.begin, SQL.statementTimeout,
    SQL.lockTimeout, SQL.idleTimeout, SQL.attestation,
    SQL.prerequisites, SQL.ledger, SQL.commit, 'END',
  ]);
});

test('altered CA, command override, or non-verifying TLS fails before ledger output', async () => {
  assert.throws(() => requireRuntime({ ...env, RDS_CA_PEM: `${ca}\n` }, ['node']));
  assert.throws(() => requireRuntime(env, ['node', 'migrate']));
  const { Client, queries } = fakeClient({ tlsAuthorized: false });
  await assert.rejects(audit(env, ['node'], Client));
  assert.deepEqual(queries, ['CONNECT', 'END']);
});

test('identity failure or extra ledger field rolls back and refuses output', async () => {
  const identity = fakeClient({ attestation: { writer_ok: false } });
  await assert.rejects(audit(env, ['node'], identity.Client));
  assert.equal(identity.queries.includes(SQL.ledger), false);
  assert.deepEqual(identity.queries.slice(-2), [SQL.rollback, 'END']);

  const extra = fakeClient({ ledger: [{
    migration_name: '20281016020000_clio_conversation_bootstrap_receipts',
    checksum: 'a'.repeat(64), finished: false, rolled_back: false,
    has_error: false, logs: 'must not leave task',
  }] });
  await assert.rejects(audit(env, ['node'], extra.Client));
  assert.deepEqual(extra.queries.slice(-2), [SQL.rollback, 'END']);
});
