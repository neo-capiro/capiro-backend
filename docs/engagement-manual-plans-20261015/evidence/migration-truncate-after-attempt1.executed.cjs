// Executed evidence fixture. Never connects outside its explicitly owned local database.
// This models role grants only inside the disposable qualification cluster.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../../..');
const { Client } = require(path.join(root, 'implementation-runtime/workspace/apps/api/node_modules/pg'));
const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--') && x.includes('=')).map(x => x.slice(2).split(/=(.*)/s).slice(0, 2)));
assert.ok(['before', 'after'].includes(args.phase), '--phase=before|after required');
assert.match(args['expected-sha'] || '', /^[a-f0-9]{64}$/);
const phase = args.phase;
const evidence = __dirname;
const migrationPath = args.migration ? path.resolve(args.migration) : path.join(root, 'backend-plan-implementation/apps/api/prisma/migrations/20281015040000_engagement_plans/migration.sql');
const bytes = fs.readFileSync(migrationPath);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
assert.equal(sha(bytes), args['expected-sha'], 'Exact migration approval hash required');
const config = { host: '127.0.0.1', port: 60009, user: 'codex_engagement', database: 'engagement_truncate_regression', connectionTimeoutMillis: 5000 };
const tables = ['engagement_plans', 'engagement_plan_waves', 'engagement_plan_command_receipts', 'engagement_plan_revisions'];
const t='10000000-0000-4000-8000-000000000001', c='20000000-0000-4000-8000-000000000001', p='30000000-0000-4000-8000-000000000001', actor='40000000-0000-4000-8000-000000000001';
const report = { phase, database:config.database, migrationPath, migrationSha256:sha(bytes), scriptSha256:sha(fs.readFileSync(__filename)), serverVersion:null, checks:[], hardened:null, negativeControls:[], acceptedUnsafeProfiles:0, sourceFacts:[] };
let db;
const check = (name, condition, detail) => { report.checks.push({name,passed:!!condition,...(detail===undefined?{}:{detail})}); console.log(`${condition?'PASS':'FAIL'} ${name}`); };
async function identity() {
  const row=(await db.query('SELECT current_database() AS database,current_user AS actor,host(inet_server_addr()) AS host,inet_server_port() AS port')).rows[0];
  assert.deepEqual(row,{database:config.database,actor:config.user,host:config.host,port:config.port},'Refusing fixture activity outside owned loopback database');
}
async function baselineMembership() {
  await db.query('RESET ROLE; RESET SESSION AUTHORIZATION; REVOKE capiro_master FROM capiro_app; REVOKE engagement_truncate_parent FROM capiro_app; REVOKE capiro_app FROM capiro_master; GRANT capiro_app TO capiro_master');
}
async function setup(profile) {
  await identity(); await baselineMembership();
  await db.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION capiro_master; GRANT USAGE ON SCHEMA public TO capiro_app,engagement_truncate_parent');
  if (profile.kind==='owner') {
    await db.query('REVOKE capiro_app FROM capiro_master');
    await db.query(`GRANT capiro_master TO capiro_app WITH INHERIT ${profile.inherit?'TRUE':'FALSE'}, SET TRUE`);
  }
  if (profile.kind==='parent') await db.query(`GRANT engagement_truncate_parent TO capiro_app WITH INHERIT ${profile.inherit?'TRUE':'FALSE'}, SET TRUE`);
  await db.query('SET ROLE capiro_master');
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE capiro_master IN SCHEMA public GRANT ALL ON TABLES TO capiro_app;
    CREATE TABLE tenants(id uuid PRIMARY KEY);
    CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,UNIQUE(tenant_id,id));
    CREATE TABLE codex_default_acl_probe(id integer);
    CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.current_tenant',true),'')::uuid $$;
    CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.bypass_rls',true),'')='on' $$;`);
  if(profile.kind==='parent') await db.query('ALTER DEFAULT PRIVILEGES FOR ROLE capiro_master IN SCHEMA public GRANT TRUNCATE ON TABLES TO engagement_truncate_parent');
  await db.query('BEGIN');
  try { await db.query(bytes.toString('utf8')); await db.query('COMMIT'); }
  catch(error) { await db.query('ROLLBACK'); throw error; }
  await db.query('RESET ROLE');
  if(profile.kind==='public') await db.query(`GRANT TRUNCATE ON ${tables.join(',')} TO PUBLIC`);
  if(profile.kind!=='hardened') {
    // Isolate the inherited/PUBLIC route from the known direct-ACL defect.
    // This fixture-only revoke does not edit or pretend to repair migration source.
    await db.query(`REVOKE TRUNCATE ON ${tables.join(',')} FROM capiro_app`);
  }
  await db.query('INSERT INTO tenants VALUES($1)',[t]);
  await db.query('INSERT INTO clients VALUES($1,$2)',[c,t]);
  await db.query('INSERT INTO engagement_plans(id,tenant_id,client_id,title,created_by_user_id) VALUES($1,$2,$3,$4,$5)',[p,t,c,'Synthetic truncate regression',actor]);
  await db.query('INSERT INTO engagement_plan_waves(tenant_id,client_id,plan_id,title,position) VALUES($1,$2,$3,$4,0)',[t,c,p,'Synthetic child']);
  await db.query('INSERT INTO engagement_plan_command_receipts(tenant_id,client_id,plan_id,actor_user_id,command,request_id,request_hash,receipt) VALUES($1,$2,$3,$4,$5,gen_random_uuid(),$6,$7)',[t,c,p,actor,'create_plan','a'.repeat(64),'{}']);
  await db.query('INSERT INTO engagement_plan_revisions(tenant_id,client_id,plan_id,version,operation,actor_user_id,snapshot) VALUES($1,$2,$3,1,$4,$5,$6)',[t,c,p,'create_plan',actor,'{}']);
}
async function authority() {
  const roles=(await db.query(`SELECT r.rolname,r.rolsuper,r.rolcreaterole,r.rolbypassrls,
    pg_has_role('capiro_app',r.oid,'USAGE') AS inherited,pg_has_role('capiro_app',r.oid,'SET') AS settable
    FROM pg_roles r WHERE r.rolname IN ('capiro_app','capiro_master','engagement_truncate_parent') ORDER BY rolname`)).rows;
  const owners=(await db.query(`SELECT c.relname,pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS acl,
    has_table_privilege('capiro_app',c.oid,'TRUNCATE') AS app_truncate
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,[tables])).rows;
  const reachable=[];
  for(const role of roles.filter(r=>r.rolname!=='capiro_app'&&(r.inherited||r.settable))) {
    for(const table of tables) {
      const allowed=(await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed',[role.rolname,table,'TRUNCATE'])).rows[0].allowed;
      if(allowed||owners.some(o=>o.relname===table&&o.owner===role.rolname)) reachable.push({role:role.rolname,table,inherited:role.inherited,settable:role.settable,owner:owners.some(o=>o.relname===table&&o.owner===role.rolname),truncate:allowed});
    }
  }
  const accepted=owners.length===4&&owners.every(o=>o.owner==='capiro_master'&&!o.app_truncate)&&reachable.length===0&&roles.find(r=>r.rolname==='capiro_app')?.rolsuper===false;
  return {accepted,roles,owners,reachable};
}
async function counts(){const out={};for(const table of tables)out[table]=(await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;return out;}
async function appAttempt(sql,setRole) {
  const before=await counts(); let result={sql,setRole:setRole??null,success:false,code:null,identity:null,countsAfter:null};
  await db.query('BEGIN');
  try {
    await db.query('SET SESSION AUTHORIZATION capiro_app');
    if(setRole)await db.query(`SET ROLE ${setRole}`);
    result.identity=(await db.query('SELECT session_user,current_user')).rows[0];
    assert.equal(result.identity.session_user,'capiro_app','Admin-session SET ROLE is not an application qualification');
    await db.query(sql); result.success=true;
    await db.query('RESET ROLE; RESET SESSION AUTHORIZATION'); result.countsAfter=await counts();
  } catch(error){result.code=error.code;result.message=error.message;}
  finally {await db.query('ROLLBACK');await db.query('RESET ROLE; RESET SESSION AUTHORIZATION');}
  assert.deepEqual(await counts(),before,'Every destructive diagnostic must roll back');
  return result;
}
(async()=>{
  for(const file of ['scripts/sql/2026-07-19-rls-role-hardening.sql','docs/plans/2026-07-19-capiro-app-rls-bypass-remediation.md','scripts/legiwatch-phase7-upgrade.mjs','apps/api/src/prisma/prisma.service.ts']) {
    const full=path.join(root,'backend',file);report.sourceFacts.push({frozenSource:file,sha256:sha(fs.readFileSync(full))});
  }
  const admin=new Client({...config,database:'postgres'});await admin.connect();
  const exists=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[config.database])).rowCount;
  if(exists)assert.ok(process.argv.includes('--reset-owned'),'Explicit --reset-owned required');
  else await admin.query('CREATE DATABASE engagement_truncate_regression');
  await admin.end();db=new Client(config);await db.connect();await identity();
  report.serverVersion=(await db.query('SHOW server_version')).rows[0].server_version;
  if(exists){const marker=(await db.query("SELECT to_regclass('codex_fixture_guard.owner') AS relation")).rows[0].relation;assert.ok(marker,'Existing database lacks owned fixture marker');assert.equal((await db.query('SELECT name FROM codex_fixture_guard.owner')).rows[0]?.name,'engagement-truncate-regression');}
  else await db.query("CREATE SCHEMA codex_fixture_guard;CREATE TABLE codex_fixture_guard.owner(name text PRIMARY KEY);INSERT INTO codex_fixture_guard.owner VALUES('engagement-truncate-regression')");
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN CREATE ROLE capiro_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_master') THEN CREATE ROLE capiro_master NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='engagement_truncate_parent') THEN CREATE ROLE engagement_truncate_parent NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;END IF;
    END $$`);
  const profiles=[{name:'documented_hardened_full_default_acl',kind:'hardened'},
    {name:'unsafe_owner_inheritance',kind:'owner',inherit:true},{name:'unsafe_owner_set_only',kind:'owner',inherit:false},
    {name:'unsafe_parent_truncate_inheritance',kind:'parent',inherit:true},{name:'unsafe_parent_truncate_set_only',kind:'parent',inherit:false},
    {name:'unsafe_public_truncate',kind:'public'}];
  for(const profile of profiles){
    await setup(profile);const auth=await authority();
    if(profile.kind==='hardened'){
      const defaultAcl=(await db.query("SELECT defaclacl::text AS acl FROM pg_default_acl WHERE defaclrole='capiro_master'::regrole AND defaclnamespace='public'::regnamespace AND defaclobjtype='r'")).rows[0]?.acl;
      check('documented owner GRANT ALL default ACL includes app TRUNCATE',defaultAcl?.includes('capiro_app=arwdDxt'),defaultAcl);
      check('hardened full-default-ACL posture qualifies without inherited or SET-able D',auth.accepted,auth);
      const roleProof=await appAttempt('SET ROLE capiro_master');
      check('real app session cannot SET ROLE hardened owner',!roleProof.success&&roleProof.code==='42501',roleProof);
      for(const row of auth.owners)check('effective app TRUNCATE denied '+row.relname,!row.app_truncate,row);
      const forms=[['wave leaf','TRUNCATE engagement_plan_waves'],['receipt leaf','TRUNCATE engagement_plan_command_receipts'],['revision leaf','TRUNCATE engagement_plan_revisions'],
        ['plan cascade','TRUNCATE engagement_plans CASCADE'],['all four together',`TRUNCATE ${tables.join(',')}`],['client cascade','TRUNCATE clients CASCADE'],['tenant cascade','TRUNCATE tenants CASCADE'],
        ['wave cascade','TRUNCATE engagement_plan_waves CASCADE'],['receipt cascade','TRUNCATE engagement_plan_command_receipts CASCADE'],['revision cascade','TRUNCATE engagement_plan_revisions CASCADE']];
      const attempts=[];for(const [name,sql] of forms){const attempt=await appAttempt(sql);attempts.push(attempt);check('app denied '+name,!attempt.success&&attempt.code==='42501',attempt);}
      report.hardened={accepted:auth.accepted,authority:auth,attempts};
    }else{
      check(profile.name+' fails qualification precondition',!auth.accepted,auth);
      const target=(profile.kind==='owner'||profile.kind==='parent')&&!profile.inherit?(profile.kind==='owner'?'capiro_master':'engagement_truncate_parent'):undefined;
      const attempt=await appAttempt(`TRUNCATE ${tables.join(',')}`,target);
      check(profile.name+' native negative control proves direct REVOKE insufficient',attempt.success&&Object.values(attempt.countsAfter??{}).every(n=>n===0),attempt);
      report.negativeControls.push({name:profile.name,acceptedPosture:false,preconditionRefused:!auth.accepted,authority:auth,attempt});
    }
  }
  await baselineMembership();
  // Remove the final deliberately unsafe PUBLIC control before releasing the
  // shared disposable cluster. This changes fixture ACLs only, never source.
  await db.query(`REVOKE TRUNCATE ON ${tables.join(',')} FROM PUBLIC`);
  report.postNegativeCleanupAuthority=await authority();
  check('negative controls cleaned; supported authority posture restored',report.postNegativeCleanupAuthority.accepted,report.postNegativeCleanupAuthority);
})().catch(error=>{report.fatal={code:error.code,message:error.message,stack:error.stack};process.exitCode=1;}).finally(async()=>{
  if(db){try{await baselineMembership();await db.end();}catch(error){report.cleanupError=error.message;process.exitCode=1;}}
  report.totalChecks=report.checks.length;report.passedChecks=report.checks.filter(x=>x.passed).length;report.failedChecks=report.totalChecks-report.passedChecks;
  report.status=report.fatal?'fixture_error':report.failedChecks?'failed_qualification_invariants':'hardened_posture_qualified_negative_profiles_refused';
  const output=path.join(evidence,`migration-truncate-${phase}.json`);fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,phase,totalChecks:report.totalChecks,passedChecks:report.passedChecks,failedChecks:report.failedChecks,migrationSha256:report.migrationSha256,hardenedAccepted:report.hardened?.accepted,negativeControls:report.negativeControls.length,acceptedUnsafeProfiles:0,report:output}));
  if(report.failedChecks)process.exitCode=1;
});
