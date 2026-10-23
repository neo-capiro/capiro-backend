/** Source-only runner for root's disposable PostgreSQL 16 gate. No remote DB. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/verify-meri-conversation-management.mjs --config <json> (explicit loopback disposable PostgreSQL 16 only)');
  process.exit(0);
}
if (process.argv[2] !== '--config' || process.argv.length !== 4) throw Error('Explicit local test config required');
const config = JSON.parse(await readFile(process.argv[3], 'utf8')), url = new URL(config.url);
if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || !url.pathname.slice(1) ||
    url.searchParams.has('host') || url.searchParams.has('options')) throw Error('Only loopback disposable PostgreSQL is allowed');
const client = new pg.Client({ connectionString: url.toString() });
const suffix = randomUUID().replaceAll('-', ''), schema = `wave2_management_${suffix}`, role = `wave2_management_reader_${suffix}`;
const sql = await readFile(new URL('../prisma/migrations/20281023020000_meri_conversation_management/migration.sql', import.meta.url), 'utf8');
const baseline = await readFile(new URL('../prisma/migrations/20281016020000_clio_conversation_bootstrap_receipts/migration.sql', import.meta.url), 'utf8');
const binding = await readFile(new URL('../prisma/migrations/20281023010000_meri_general_conversation_binding/migration.sql', import.meta.url), 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let checks = 0;
async function refused(statement, args = [], code = '23514') {
  await assert.rejects(client.query(statement, args), error => error.code === code); checks++;
}
await client.connect();
try {
  const version = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(version >= 160000 && version < 170000);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema},pg_catalog`);
  await client.query(`CREATE TABLE tenants(id uuid PRIMARY KEY);
    CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid REFERENCES tenants ON DELETE CASCADE);
    CREATE TABLE clio_conversations(id uuid PRIMARY KEY,tenant_id uuid REFERENCES tenants ON DELETE CASCADE,
      user_id uuid NOT NULL,client_id uuid REFERENCES clients ON DELETE SET NULL,title text NOT NULL DEFAULT 'Synthetic',status text NOT NULL DEFAULT 'active');
    CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('app.current_tenant',true),'')::uuid$$;
    CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(current_setting('app.bypass_rls',true),'off')='on'$$;`);
  await client.query(baseline);
  await client.query(binding); await client.query(binding);
  await client.query('INSERT INTO tenants VALUES($1),($2)',[id(1),id(2)]);
  await client.query('INSERT INTO clients VALUES($1,$2)',[id(10),id(2)]);
  await client.query('INSERT INTO clio_conversations(id,tenant_id,user_id,client_id) VALUES($1,$2,$3,null),($4,$5,$3,$6)',[id(4),id(1),id(3),id(5),id(2),id(10)]);
  await client.query("INSERT INTO clio_conversation_bootstrap_receipts(tenant_id,actor_user_id,request_id,conversation_id,client_id,scope_kind) VALUES($1,$2,$3,$4,null,'general'),($5,$2,$6,$7,$8,'client')",
    [id(1),id(3),id(11),id(4),id(2),id(12),id(5),id(10)]);
  await client.query(sql); await client.query(sql);
  const insert = 'INSERT INTO clio_conversation_management_receipts(tenant_id,actor_user_id,request_id,conversation_id,request_sha256,receipt) VALUES($1,$2,$3,$4,$5,$6)';
  const payload = { receipt:{ conversation:{ title:'Synthetic title removed at permanent deletion' } },releaseRetention:false };
  await client.query(insert,[id(1),id(3),id(6),id(4),'a'.repeat(64),payload]);
  await client.query(insert,[id(2),id(3),id(7),id(5),'b'.repeat(64),payload]);
  await refused(insert,[id(1),id(3),id(8),id(5),'c'.repeat(64),payload]);
  await refused(insert,[id(1),id(3),id(8),null,'c'.repeat(64),payload]);
  await refused('UPDATE clio_conversation_management_receipts SET conversation_id=null');
  await refused('UPDATE clio_conversation_management_receipts SET receipt=$1',[{tombstone:true}]);
  await refused('UPDATE clio_conversation_management_receipts SET request_sha256=$1',['c'.repeat(64)]);
  await refused('DELETE FROM clio_conversation_management_receipts');
  await refused('UPDATE clio_conversations SET metadata_revision=-1');
  await refused("UPDATE clio_conversations SET status='trashed',trashed_at=now(),restore_until=now()+interval '31 days'");
  await client.query("UPDATE clio_conversations SET status='trashed',trashed_at='2026-10-23T00:00Z',restore_until='2026-11-22T00:00Z',metadata_revision=1 WHERE id=$1",[id(4)]); checks++;
  await client.query(`CREATE ROLE ${role} NOLOGIN; GRANT USAGE ON SCHEMA ${schema} TO ${role};
    GRANT SELECT ON clio_conversation_management_receipts TO ${role}; SET ROLE ${role}`);
  await client.query("SELECT set_config('app.current_tenant',$1,false)",[id(1)]);
  assert.equal((await client.query('SELECT count(*) FROM clio_conversation_management_receipts')).rows[0].count,'1'); checks++;
  await client.query("SELECT set_config('app.current_tenant',$1,false)",[id(9)]);
  assert.equal((await client.query('SELECT count(*) FROM clio_conversation_management_receipts')).rows[0].count,'0'); checks++;
  await client.query('RESET ROLE');
  await client.query('DELETE FROM clio_conversations WHERE id=$1',[id(4)]);
  const tombstone = (await client.query('SELECT * FROM clio_conversation_management_receipts WHERE request_id=$1',[id(6)])).rows[0];
  assert.equal(tombstone.conversation_id,null); assert.deepEqual(tombstone.receipt,{tombstone:true});
  assert.equal(tombstone.request_sha256,'a'.repeat(64)); checks++;
  assert.equal((await client.query('SELECT conversation_id FROM clio_conversation_bootstrap_receipts WHERE request_id=$1',[id(11)])).rows[0].conversation_id,null); checks++;
  await refused('UPDATE clio_conversation_management_receipts SET conversation_id=$1 WHERE request_id=$2',[id(5),id(6)]);
  await refused(insert,[id(1),id(3),id(6),id(4),'a'.repeat(64),payload]);
  await client.query('DELETE FROM tenants WHERE id=$1',[id(2)]);
  assert.equal((await client.query('SELECT count(*) FROM clio_conversation_management_receipts WHERE tenant_id=$1',[id(2)])).rows[0].count,'0'); checks++;
  assert.equal((await client.query('SELECT count(*) FROM clio_conversation_bootstrap_receipts WHERE tenant_id=$1',[id(2)])).rows[0].count,'0'); checks++;
  await client.query('ALTER TABLE clio_conversation_management_receipts DISABLE TRIGGER clio_management_receipts_immutable');
  await assert.rejects(client.query(sql),/Conflicting management receipt trigger/); checks++;
  await client.query('ROLLBACK');
  await client.query('ALTER TABLE clio_conversation_management_receipts ENABLE TRIGGER clio_management_receipts_immutable');
  await client.query("CREATE OR REPLACE FUNCTION protect_meri_management_receipt() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END;'");
  await assert.rejects(client.query(sql),/Conflicting management receipt guard/); checks++;
  await client.query('ROLLBACK');
  console.log(JSON.stringify({tier:'synthetic-disposable-postgresql-16',result:'PASS',baseline:'20281016020000',bindingRuns:2,migrationRuns:2,checks}));
} finally {
  await client.query('ROLLBACK'); await client.query('RESET ROLE'); await client.query('SET search_path TO pg_catalog');
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`DROP ROLE IF EXISTS ${role}`); await client.end();
}
