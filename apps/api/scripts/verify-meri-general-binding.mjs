/** Synthetic disposable PostgreSQL 16 gate. Never accepts a remote database. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/verify-meri-general-binding.mjs --config <json>\nJSON: {"url":"postgresql://...@127.0.0.1:PORT/disposable_test_db"}. Exits 0 on PASS, 1 on failure. Creates and removes only a random synthetic schema.');
  process.exit(0);
}
const flag = process.argv.indexOf('--config');
if (flag !== 2 || process.argv.length !== 4) throw new Error('An explicit local test config is required; use --help');
const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
const url = new URL(config.url);
if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
    !url.pathname.slice(1) || url.searchParams.has('host') || url.searchParams.has('options'))
  throw new Error('Only an explicit loopback disposable PostgreSQL test database is allowed');
const client = new pg.Client({ connectionString: url.toString() });
const schema = `wave2_binding_${randomUUID().replaceAll('-', '')}`;
const migration = await readFile(new URL('../prisma/migrations/20281023010000_meri_general_conversation_binding/migration.sql', import.meta.url), 'utf8');
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let checks = 0;
async function refused(sql, values = [], code = '23514') {
  await assert.rejects(client.query(sql, values), (error) => error.code === code);
  checks++;
}
await client.connect();
try {
  const version = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(version >= 160000 && version < 170000, 'Use PostgreSQL 16');
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, pg_catalog`);
  await client.query(`
    CREATE TABLE tenants(id uuid PRIMARY KEY);
    CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE clients(id uuid PRIMARY KEY, tenant_id uuid REFERENCES tenants ON DELETE CASCADE);
    CREATE TABLE clio_conversations(id uuid PRIMARY KEY, tenant_id uuid REFERENCES tenants ON DELETE CASCADE,
      user_id uuid REFERENCES users ON DELETE CASCADE, client_id uuid REFERENCES clients ON DELETE SET NULL,
      title text NOT NULL DEFAULT 'Synthetic');
    CREATE TABLE clio_conversation_bootstrap_receipts(tenant_id uuid REFERENCES tenants ON DELETE CASCADE,
      actor_user_id uuid NOT NULL, request_id uuid NOT NULL, client_id uuid NOT NULL,
      conversation_id uuid UNIQUE REFERENCES clio_conversations ON DELETE SET NULL,
      PRIMARY KEY(tenant_id, actor_user_id, request_id));
  `);
  await client.query('INSERT INTO tenants VALUES ($1);', [id(1)]);
  await client.query('INSERT INTO users VALUES ($1),($2);', [id(2), id(3)]);
  await client.query('INSERT INTO clients VALUES ($1,$2);', [id(4), id(1)]);
  await client.query('INSERT INTO clio_conversations(id,tenant_id,user_id,client_id) VALUES ($1,$2,$3,$4),($5,$2,$3,null);', [id(5),id(1),id(2),id(4),id(6)]);
  await client.query('INSERT INTO clio_conversation_bootstrap_receipts VALUES ($1,$2,$3,$4,$5);', [id(1),id(2),id(7),id(4),id(5)]);
  await client.query(migration);
  await client.query(migration);
  assert.equal((await client.query('SELECT scope_kind FROM clio_conversation_bootstrap_receipts')).rows[0].scope_kind, 'client'); checks++;
  assert.equal((await client.query('SELECT count(*) FROM clio_conversation_bootstrap_receipts WHERE conversation_id=$1', [id(6)])).rows[0].count, '0'); checks++;
  await refused('UPDATE clio_conversation_bootstrap_receipts SET scope_kind=\'general\',client_id=null');
  await refused('UPDATE clio_conversation_bootstrap_receipts SET conversation_id=null');
  await refused('UPDATE clio_conversations SET client_id=null WHERE id=$1', [id(5)]);
  await refused('UPDATE clio_conversations SET user_id=$1 WHERE id=$2', [id(3),id(5)]);
  await client.query('UPDATE clio_conversations SET title=$1 WHERE id=$2', ['Changed synthetic title',id(5)]); checks++;
  await client.query('INSERT INTO clio_conversations(id,tenant_id,user_id,client_id) VALUES ($1,$2,$3,null)', [id(8),id(1),id(2)]);
  await client.query('INSERT INTO clio_conversation_bootstrap_receipts(tenant_id,actor_user_id,request_id,scope_kind,client_id,conversation_id) VALUES ($1,$2,$3,\'general\',null,$4)', [id(1),id(2),id(9),id(8)]);
  await refused('UPDATE clio_conversations SET client_id=$1 WHERE id=$2', [id(4),id(8)]);
  await client.query('DELETE FROM clio_conversations WHERE id=$1', [id(8)]);
  assert.equal((await client.query('SELECT conversation_id FROM clio_conversation_bootstrap_receipts WHERE request_id=$1', [id(9)])).rows[0].conversation_id, null); checks++;
  await refused('UPDATE clio_conversation_bootstrap_receipts SET conversation_id=$1 WHERE request_id=$2', [id(6),id(9)]);
  await client.query('DELETE FROM clients WHERE id=$1', [id(4)]);
  assert.equal((await client.query('SELECT client_id FROM clio_conversations WHERE id=$1',[id(5)])).rows[0].client_id, null); checks++;
  assert.equal((await client.query('SELECT client_id,scope_kind FROM clio_conversation_bootstrap_receipts WHERE request_id=$1',[id(7)])).rows[0].client_id,id(4)); checks++;
  await client.query('DELETE FROM tenants WHERE id=$1', [id(1)]);
  assert.equal((await client.query('SELECT count(*) FROM clio_conversation_bootstrap_receipts')).rows[0].count,'0'); checks++;
  await client.query(`CREATE OR REPLACE FUNCTION protect_meri_bootstrap_binding() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END;'`);
  await assert.rejects(client.query(migration), /Conflicting Meri binding function/); checks++;
  await client.query('ROLLBACK');
  console.log(JSON.stringify({ tier:'synthetic-disposable-postgresql-16', result:'PASS', checks, migrationRuns:2 }));
} finally {
  await client.query('ROLLBACK');
  await client.query('SET search_path TO pg_catalog');
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.end();
}
