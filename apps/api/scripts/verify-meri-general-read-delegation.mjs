/** Synthetic disposable PostgreSQL 16 gate for RESERVED sources; never a deployment runner. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/verify-meri-general-read-delegation.mjs --config <json>\nJSON: {"url":"postgresql://...@127.0.0.1:PORT/disposable_test_db"}. Random synthetic schema only; reserved sources do not enter the deploy ledger.');
  process.exit(0);
}
if (process.argv.indexOf('--config') !== 2 || process.argv.length !== 4) throw new Error('Explicit local test config required; use --help');
const config = JSON.parse(await readFile(process.argv[3], 'utf8')), url = new URL(config.url);
if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || !url.pathname.slice(1) ||
    url.searchParams.has('host') || url.searchParams.has('options')) throw new Error('Only a loopback disposable PostgreSQL database is allowed');
const source = path => readFile(new URL(`../prisma/${path}/migration.sql`, import.meta.url), 'utf8');
const [baseline, binding, predecessor, migration] = await Promise.all([
  source('migrations/20281016020000_clio_conversation_bootstrap_receipts'),
  source('migrations/20281023010000_meri_general_conversation_binding'),
  source('reserved-migrations/20281018060000_meri_read_delegation'),
  source('reserved-migrations/20281023030000_meri_general_read_delegation'),
]);
const client = new pg.Client({ connectionString: url.toString() });
const suffix = randomUUID().replaceAll('-', ''), schema = `wave2_read_${suffix}`, role = `wave2_read_role_${suffix}`;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let checks = 0, roleCreated = false;
async function refused(sql, values = [], code = '23514') {
  await assert.rejects(client.query(sql, values), error => error.code === code); checks++;
}
async function rerunRefused(pattern) {
  await assert.rejects(client.query(migration), pattern); checks++;
  await client.query('ROLLBACK');
}
async function delegation(n, { scopeKind, clientId = id(4), conversationId = id(5), actorId = id(2), tenantId = id(1), mode = 'attended' } = {}) {
  const generalColumn = scopeKind === undefined ? '' : ',scope_kind';
  const generalValue = scopeKind === undefined ? '' : ',$9';
  return client.query(`INSERT INTO meri_read_delegations
    (id,idempotency_key,mode,tenant_id,user_id,membership_id,client_id,conversation_id,run_id,attempt_id,
     writer_fence,budget_attempt,budget_fence,budget_policy_revision,allocation_sha256,operations_digest,policy_revision,
     state,issued_at,expires_at${generalColumn}) VALUES
    ($1, $2, $3, $4, $5, $6, $7, $8, $1, $1, 1,1,1,repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),
     'active',clock_timestamp(),clock_timestamp()+interval '10 minutes'${generalValue})`,
    [id(n), n.toString(16).padStart(64, '0'), mode, tenantId, actorId, id(10), clientId, conversationId, ...(scopeKind === undefined ? [] : [scopeKind])]);
}
await client.connect();
try {
  const version = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(version >= 160000 && version < 170000, 'Use PostgreSQL 16');
  await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}, pg_catalog`);
  await rerunRefused(/predecessors are required/);
  await client.query(`
    CREATE TABLE tenants(id uuid PRIMARY KEY);
    CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE clients(id uuid PRIMARY KEY, tenant_id uuid REFERENCES tenants ON DELETE CASCADE);
    CREATE TABLE clio_conversations(id uuid PRIMARY KEY, tenant_id uuid REFERENCES tenants ON DELETE CASCADE,
      user_id uuid REFERENCES users ON DELETE CASCADE, client_id uuid REFERENCES clients ON DELETE SET NULL,
      title text NOT NULL DEFAULT 'Synthetic', status text NOT NULL DEFAULT 'active', archived_at timestamptz);
    CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('app.current_tenant',true),'')::uuid$$;
    CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(current_setting('app.bypass_rls',true),'off')='on'$$;
  `);
  await client.query(baseline);
  await client.query(binding);
  await client.query(predecessor);
  await client.query('INSERT INTO tenants VALUES ($1),($2)', [id(1),id(11)]);
  await client.query('INSERT INTO users VALUES ($1),($2)', [id(2),id(3)]);
  await client.query('INSERT INTO clients VALUES ($1,$2)', [id(4),id(1)]);
  await client.query('INSERT INTO clio_conversations(id,tenant_id,user_id,client_id) VALUES ($1,$2,$3,$4),($5,$2,$3,null),($6,$2,$3,null)', [id(5),id(1),id(2),id(4),id(6),id(7)]);
  await client.query(`INSERT INTO clio_conversation_bootstrap_receipts(tenant_id,actor_user_id,request_id,client_id,conversation_id,scope_kind)
    VALUES ($1,$2,$3,$4,$5,'client'),($1,$2,$6,null,$7,'general')`, [id(1),id(2),id(8),id(4),id(5),id(9),id(6)]);
  await delegation(20);
  await client.query('INSERT INTO meri_read_delegation_slots(run_id,call_key,tenant_id,delegation_id,current_tokens) VALUES ($1,\'legacy\',$2,$1,2)', [id(20),id(1)]);
  const before = (await client.query('SELECT * FROM meri_read_delegations WHERE id=$1',[id(20)])).rows[0];
  await client.query(migration);
  await client.query(migration);
  const { scope_kind, ...after } = (await client.query('SELECT * FROM meri_read_delegations WHERE id=$1',[id(20)])).rows[0];
  assert.equal(scope_kind, 'client'); assert.deepEqual(after, before); checks++;
  const legacy = (await client.query('SELECT current_tokens,target_client_id FROM meri_read_delegation_slots WHERE run_id=$1',[id(20)])).rows[0];
  assert.deepEqual(legacy, { current_tokens: 2, target_client_id: null }); checks++;
  await delegation(21, { scopeKind: 'general', clientId: null, conversationId: id(6) }); checks++;
  for (const options of [
    { scopeKind: 'client', clientId: null }, { scopeKind: 'general', clientId: id(4), conversationId: id(6) },
    { scopeKind: 'general', clientId: null, conversationId: id(7) }, { scopeKind: 'general', clientId: null, conversationId: id(6), actorId: id(3) },
    { scopeKind: 'general', clientId: null, conversationId: id(6), tenantId: id(11) },
    { scopeKind: 'general', clientId: null, conversationId: id(6), mode: 'unattended' },
  ]) { await assert.rejects(delegation(22, options), error => error.code === '23514'); checks++; }
  await client.query("UPDATE clio_conversations SET status='archived', archived_at=clock_timestamp() WHERE id=$1",[id(6)]);
  await assert.rejects(delegation(22,{ scopeKind:'general',clientId:null,conversationId:id(6) }), error => error.code === '23514'); checks++;
  await client.query("UPDATE clio_conversations SET status='active', archived_at=null WHERE id=$1",[id(6)]);
  for (const assignment of ["scope_kind='client',client_id='"+id(4)+"'", "user_id='"+id(3)+"'", "tenant_id='"+id(11)+"'", "conversation_id='"+id(7)+"'", "run_id='"+id(31)+"'"])
    await refused(`UPDATE meri_read_delegations SET ${assignment} WHERE id=$1`,[id(21)]);
  await client.query('INSERT INTO meri_read_delegation_slots(run_id,call_key,tenant_id,delegation_id,target_client_id) VALUES ($1,\'general_client\',$2,$1,$3),($1,\'general_memory\',$2,$1,null)',[id(21),id(1),id(4)]);
  await refused("UPDATE meri_read_delegation_slots SET target_client_id=null WHERE call_key='general_client'");
  await refused("UPDATE meri_read_delegation_slots SET target_client_id=$1 WHERE call_key='general_memory'",[id(4)]);
  await refused("UPDATE meri_read_delegation_slots SET call_key='changed' WHERE call_key='general_memory'");
  await client.query("UPDATE meri_read_delegation_slots SET current_tokens=1 WHERE call_key='general_memory'"); checks++;
  await refused("UPDATE meri_read_delegation_slots SET current_tokens=36 WHERE call_key='general_memory'");
  // Canonical deletion uses both real bootstrap triggers; existing origin is retained for revocation.
  await client.query('DELETE FROM clio_conversations WHERE id=$1',[id(6)]);
  assert.equal((await client.query('SELECT conversation_id FROM clio_conversation_bootstrap_receipts WHERE request_id=$1',[id(9)])).rows[0].conversation_id,null); checks++;
  await assert.rejects(delegation(22,{ scopeKind:'general',clientId:null,conversationId:id(6) }), error => error.code === '23514'); checks++;
  await client.query("UPDATE meri_read_delegations SET state='revoked',revoked_reason='Synthetic origin deleted' WHERE id=$1",[id(21)]);
  assert.equal((await client.query('SELECT conversation_id FROM meri_read_delegations WHERE id=$1',[id(21)])).rows[0].conversation_id,id(6)); checks++;
  // RLS is tested with a non-bypass role; migration grants are not widened by these new columns.
  await client.query(`CREATE ROLE ${role} NOLOGIN; GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT ON meri_read_delegations,meri_read_delegation_slots TO ${role}`); roleCreated=true;
  await client.query(`SET ROLE ${role}`);
  await client.query("SELECT set_config('app.current_tenant',$1,false)",[id(11)]);
  assert.equal((await client.query('SELECT count(*) FROM meri_read_delegations')).rows[0].count,'0'); checks++;
  await client.query("SELECT set_config('app.current_tenant',$1,false)",[id(1)]);
  assert.equal((await client.query('SELECT count(*) FROM meri_read_delegations')).rows[0].count,'2'); checks++;
  await client.query('RESET ROLE');
  const fn=(await client.query("SELECT pg_get_functiondef('protect_meri_read_general_binding()'::regprocedure) AS value")).rows[0].value;
  await client.query('ALTER TABLE meri_read_delegations DISABLE TRIGGER meri_read_delegations_general_binding');
  await rerunRefused(/Conflicting read binding trigger/);
  await client.query('ALTER TABLE meri_read_delegations ENABLE TRIGGER meri_read_delegations_general_binding');
  await client.query("CREATE OR REPLACE FUNCTION protect_meri_read_general_binding() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END;'");
  await rerunRefused(/Conflicting read binding trigger function/);
  await client.query(fn);
  await client.query("ALTER TABLE meri_read_delegations ALTER COLUMN scope_kind SET DEFAULT 'general'");
  await rerunRefused(/Conflicting read delegation scope column/);
  await client.query("ALTER TABLE meri_read_delegations ALTER COLUMN scope_kind SET DEFAULT 'client'");
  await client.query("ALTER TABLE meri_read_delegations DROP CONSTRAINT meri_read_delegations_scope_check; ALTER TABLE meri_read_delegations ADD CONSTRAINT meri_read_delegations_scope_check CHECK (scope_kind IN ('client','general'))");
  await rerunRefused(/Conflicting read scope constraint/);
  console.log(JSON.stringify({ tier:'synthetic-disposable-postgresql-16', result:'PASS', checks, migrationRuns:2, reserved:true }));
} finally {
  await client.query('ROLLBACK'); await client.query('RESET ROLE'); await client.query('SET search_path TO pg_catalog');
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  if(roleCreated) await client.query(`DROP ROLE ${role}`);
  await client.end();
}
