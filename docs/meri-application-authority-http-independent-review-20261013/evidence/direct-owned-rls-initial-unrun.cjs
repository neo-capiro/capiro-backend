'use strict';
// Independent read-only fixture probe. Do not run before exact parent approval
// and a stable two-sided synthetic seed; no table/schema/role writes occur.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');
const pg = Module.createRequire('/workspace/capirov2/apps/api/package.json')('pg');
const SOURCE = 'bbb38185058fdc64c204da723943aee055b3dad3';
const TARGET = Object.freeze({
  databaseName: 'capiro_auth_http_20261013_4966f869fa', databaseOid: 16917,
  systemIdentifier: '7695590366852821031',
  databaseComment: `owned /root authority HTTP fixture at ${SOURCE}`,
  role: 'capiro_auth_http_20261013_4966f869fa_rls',
});
const A = 'a1000000-0000-4000-8000-000000000001';
const B = 'a1000000-0000-4000-8000-000000000002';
const TABLES = Object.freeze([
  ['tenants', 'id'], ['tenant_memberships', 'tenant_id'], ['audit_logs', 'tenant_id'],
  ['clients', 'tenant_id'], ['client_memory_access', 'tenant_id'], ['clio_conversations', 'tenant_id'],
]);
const ALL_TABLES = [...TABLES.map(([name]) => name), 'users', 'impersonation_sessions'].sort();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function loadConfig(input) {
  assert.equal(input, '/tmp/capiro-authority-http-runtime.json');
  const stat = fs.lstatSync(input);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.mode & 0o777, 0o600);
  const config = JSON.parse(fs.readFileSync(input, 'utf8'));
  assert.equal(config.sourceHead, SOURCE);
  assert.equal(config.approvedOwnedDatabase, true);
  for (const name of ['databaseName', 'databaseOid', 'systemIdentifier', 'databaseComment']) {
    assert.equal(config[name], TARGET[name], `Approved target field differs: ${name}`);
  }
  const url = new URL(config.connectionUrl);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(decodeURIComponent(url.pathname.slice(1)), TARGET.databaseName);
  assert.equal(url.searchParams.get('schema') ?? 'public', 'public');
  return config;
}

async function main(configPath, outputPath) {
  assert.equal(process.env.OWNED_RLS_PROBE_ACK, SOURCE, 'Explicit parent-approved invocation required');
  assert.ok(outputPath && !fs.existsSync(outputPath), 'Exclusive new evidence output required');
  const config = loadConfig(configPath);
  const client = new pg.Client({connectionString: config.connectionUrl, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, application_name: 'independent-owned-authority-rls'});
  const observations = [];
  const cases = [];
  let transaction = false;
  let originalRole;
  try {
    await client.connect();
    const fence = (await client.query(`SELECT current_database() AS "databaseName", d.oid::int AS "databaseOid",
      obj_description(d.oid,'pg_database') AS "databaseComment", system_identifier::text AS "systemIdentifier",
      current_user AS "currentUser", session_user AS "sessionUser", r.rolsuper AS "superuser",
      r.rolbypassrls AS "bypassRls", version() AS version
      FROM pg_database d CROSS JOIN pg_control_system() CROSS JOIN pg_roles r
      WHERE d.datname=current_database() AND r.rolname=current_user`)).rows;
    assert.equal(fence.length, 1);
    for (const name of ['databaseName','databaseOid','databaseComment','systemIdentifier']) {
      assert.equal(fence[0][name], TARGET[name], `Live owned target differs: ${name}`);
    }
    assert.match(fence[0].version, /PostgreSQL 16\.15/);
    originalRole = fence[0].currentUser;
    observations.push({kind:'owned-target', value:fence[0]});
    // All remaining SQL executes in a transaction PostgreSQL marks read-only.
    await client.query('BEGIN READ ONLY'); transaction = true;
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    const tables = (await client.query(`SELECT c.relname AS name,r.rolname AS owner,c.relrowsecurity AS "rowSecurity",
      c.relforcerowsecurity AS "forceRowSecurity",pg_has_role(current_user,c.relowner,'MEMBER') AS "ownerMembership"
      FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`)).rows;
    assert.deepEqual(tables.map(row=>row.name), ALL_TABLES);
    for (const [name] of TABLES) {
      const row = tables.find(row=>row.name === name);
      assert.equal(row.rowSecurity, true); assert.equal(row.forceRowSecurity, true);
    }
    observations.push({kind:'tables-before-role', value:tables});
    const policies = (await client.query(`SELECT tablename,policyname,roles,cmd,qual,with_check
      FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname`)).rows;
    assert.deepEqual(policies.map(row=>row.tablename).sort(), TABLES.map(([name])=>name).sort());
    observations.push({kind:'selected-existing-policies', value:policies});
    const baseline = new Map();
    for (const [table, column] of TABLES) {
      const rows = (await client.query(`SELECT id::text AS id,"${column}"::text AS tenant FROM public."${table}"
        WHERE "${column}" = $1::uuid OR "${column}" = $2::uuid ORDER BY id LIMIT 129`, [A,B])).rows;
      assert.ok(rows.length <= 128, `Synthetic table exceeded probe bound: ${table}`);
      assert.ok(rows.some(row=>row.tenant===A) && rows.some(row=>row.tenant===B),
        `Nonvacuous same/foreign witness required: ${table}`);
      baseline.set(table, rows); observations.push({kind:'owner-visible-two-sided-witness', table, rows});
    }
    await client.query('SET LOCAL ROLE "capiro_auth_http_20261013_4966f869fa_rls"');
    const role = (await client.query(`SELECT current_user AS "currentUser",session_user AS "sessionUser",
      r.rolsuper AS "superuser",r.rolbypassrls AS "bypassRls",r.rolcanlogin AS "canLogin"
      FROM pg_roles r WHERE r.rolname=current_user`)).rows;
    assert.equal(role.length,1); assert.equal(role[0].currentUser,TARGET.role);
    assert.equal(role[0].superuser,false); assert.equal(role[0].bypassRls,false); assert.equal(role[0].canLogin,false);
    observations.push({kind:'controlled-nonowner-role',value:role[0]});
    const ownership = (await client.query(`SELECT c.relname AS name,pg_has_role(current_user,c.relowner,'MEMBER') AS "ownerMembership",
      has_table_privilege(current_user,c.oid,'SELECT') AS "selectPrivilege"
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`)).rows;
    for (const row of ownership) {assert.equal(row.ownerMembership,false);assert.equal(row.selectPrivilege,true);}
    observations.push({kind:'nonowner-select-only-table-observations',value:ownership});
    await client.query("SELECT set_config('app.bypass_rls','off',true)");
    for (const tenant of [A,B]) {
      await client.query("SELECT set_config('app.current_tenant',$1,true)",[tenant]);
      for (const [table,column] of TABLES) {
        const visible = (await client.query(`SELECT id::text AS id,"${column}"::text AS tenant FROM public."${table}"
          WHERE "${column}" = $1::uuid OR "${column}" = $2::uuid ORDER BY id LIMIT 129`,[A,B])).rows;
        assert.deepEqual(visible,baseline.get(table).filter(row=>row.tenant===tenant));
        const other = tenant===A ? B : A;
        const denied = (await client.query(`SELECT id::text AS id FROM public."${table}" WHERE "${column}"=$1::uuid LIMIT 129`,[other])).rows;
        assert.deepEqual(denied,[]);
        cases.push({name:`${table}: tenant ${tenant===A?'A':'B'} positive and witnessed foreign denial`,passed:true,visible,foreign:denied});
      }
    }
    for (const setting of ['', 'invalid-fixture-tenant']) {
      await client.query("SELECT set_config('app.current_tenant',$1,true)",[setting]);
      for (const [table] of TABLES) {
        const rows=(await client.query(`SELECT id::text AS id FROM public."${table}" LIMIT 129`)).rows;
        assert.deepEqual(rows,[]);
        cases.push({name:`${table}: ${setting===''?'unset':'invalid'} tenant denies`,passed:true});
      }
    }
    // This intentionally records the source policy's explicit system bypass,
    // not an authorization grant and not proof a caller cannot set SQL GUCs.
    await client.query("SELECT set_config('app.bypass_rls','on',true)");
    for (const [table,column] of TABLES) {
      const rows=(await client.query(`SELECT id::text AS id,"${column}"::text AS tenant FROM public."${table}"
        WHERE "${column}"=$1::uuid OR "${column}"=$2::uuid ORDER BY id LIMIT 129`,[A,B])).rows;
      assert.deepEqual(rows,baseline.get(table));
      cases.push({name:`${table}: explicit SQL system bypass is observable`,passed:true});
    }
    await client.query('ROLLBACK'); transaction=false;
    const after=(await client.query(`SELECT current_user AS "currentUser",session_user AS "sessionUser",
      current_setting('app.current_tenant',true) AS tenant,current_setting('app.bypass_rls',true) AS bypass`)).rows;
    assert.equal(after[0].currentUser,originalRole);
    assert.ok(after[0].tenant===null || after[0].tenant==='');
    assert.ok(after[0].bypass===null || after[0].bypass==='');
    observations.push({kind:'after-read-only-rollback',value:after[0]});
    const receipt={source:SOURCE,target:TARGET,readOnlyTransaction:true,nativePostgres:true,actualHTTP:false,
      nativePrisma:false,productionRoleAcceptance:false,fullMigrations:false,DDL:false,permissionsChanged:false,
      rowsMutated:false,statementScope:'finite owned synthetic SELECTs plus transaction-local role/GUC settings and rollback',
      cases,total:cases.length,passed:cases.length,failed:0,observations,
      programSha256:sha(fs.readFileSync(__filename)),pgVersion:require(pathForPgPackage()).version};
    fs.writeFileSync(outputPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({result:'PASS',total:cases.length,output:outputPath}));
  } finally {
    if(transaction) await client.query('ROLLBACK').catch(()=>{});
    await client.end();
  }
}
function pathForPgPackage() {
  return Module.createRequire('/workspace/capirov2/apps/api/package.json').resolve('pg/package.json');
}
module.exports={TARGET,TABLES,A,B,loadConfig,main};
if(require.main===module) main(process.argv[2],process.argv[3]).catch(error=>{
  // Never emit the private configuration/connection URL or an error object
  // that could contain driver connection details.
  console.error(JSON.stringify({result:'FAIL',name:error.name,code:error.code??null,
    assertion:error instanceof assert.AssertionError ? error.message : 'owned probe failed; inspect controlled source'}));
  process.exitCode=1;
});
