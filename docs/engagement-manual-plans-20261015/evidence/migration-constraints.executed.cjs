const fs = require('node:fs');
const assert = require('node:assert/strict');
const { Client } = require('C:/Users/neoma/Documents/Codex/2026-10-15/task-3/implementation-runtime/workspace/apps/api/node_modules/pg');
const root = 'C:/Users/neoma/Documents/Codex/2026-10-15/task-3';
const config = { host: '127.0.0.1', port: 60009, user: 'codex_engagement', database: 'engagement_migration_candidate', connectionTimeoutMillis: 5000 };
const t1='10000000-0000-4000-8000-000000000001', t2='10000000-0000-4000-8000-000000000002';
const c1='20000000-0000-4000-8000-000000000001', c2='20000000-0000-4000-8000-000000000002', c3='20000000-0000-4000-8000-000000000003';
const p1='30000000-0000-4000-8000-000000000001', p2='30000000-0000-4000-8000-000000000002';
const actor='40000000-0000-4000-8000-000000000001', wave='50000000-0000-4000-8000-000000000001';
const target='60000000-0000-4000-8000-000000000001', revision='70000000-0000-4000-8000-000000000001', request='80000000-0000-4000-8000-000000000001';
let db; let checks=0;
const pass = (name) => { checks++; console.log(`PASS ${name}`); };
async function reject(name, sql, values=[], codes=['23514']) {
  let error;
  try { await db.query(sql, values); } catch (e) { error=e; }
  assert.ok(error, `${name} unexpectedly succeeded`);
  assert.ok(codes.includes(error.code), `${name}: expected ${codes}, got ${error.code}: ${error.message}`);
  pass(name);
}
async function populate(plan=p1, tenant=t1, client=c1) {
  await db.query('INSERT INTO engagement_plans(id,tenant_id,client_id,title,created_by_user_id) VALUES($1,$2,$3,$4,$5)',[plan,tenant,client,'Synthetic plan',actor]);
  await db.query('INSERT INTO engagement_plan_waves(tenant_id,client_id,plan_id,title,position) VALUES($1,$2,$3,$4,0)',[tenant,client,plan,'Synthetic wave']);
  await db.query('INSERT INTO engagement_plan_revisions(tenant_id,client_id,plan_id,version,operation,actor_user_id,snapshot) VALUES($1,$2,$3,1,$4,$5,$6)',[tenant,client,plan,'create_plan',actor,'{}']);
  await db.query('INSERT INTO engagement_plan_command_receipts(tenant_id,client_id,plan_id,actor_user_id,command,request_id,request_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[tenant,client,plan,actor,'create_plan',request,'a'.repeat(64),'{}']);
}
async function emptyChildren(name) {
  for(const table of ['engagement_plans','engagement_plan_waves','engagement_plan_revisions','engagement_plan_command_receipts']) {
    const result=await db.query(`SELECT count(*)::int n FROM ${table}`);
    assert.equal(result.rows[0].n,0,`${name}: ${table} retained rows`);
  }
  pass(name);
}
(async()=>{
  const admin=new Client({...config,database:'postgres'}); await admin.connect();
  const present=await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[config.database]);
  if (present.rowCount) assert.ok(process.argv.includes('--reset-owned'),'Dedicated candidate database already exists; explicit --reset-owned is required');
  else await admin.query('CREATE DATABASE engagement_migration_candidate');
  await admin.end();
  db=new Client(config); await db.connect();
  const identity=(await db.query('SELECT current_database() AS database,current_user AS actor,host(inet_server_addr()) AS host,inet_server_port() AS port')).rows[0];
  assert.deepEqual(identity,{database:'engagement_migration_candidate',actor:'codex_engagement',host:'127.0.0.1',port:60009},'Refusing fixture reset outside the explicitly owned loopback candidate database');
  if (present.rowCount) await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN CREATE ROLE capiro_app NOLOGIN; END IF; END $$;
    GRANT USAGE ON SCHEMA public TO capiro_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO capiro_app;
    CREATE TABLE tenants(id uuid PRIMARY KEY);
    CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,UNIQUE(tenant_id,id));
    CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.current_tenant',true),'')::uuid $$;
    CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.bypass_rls',true),'')='on' $$;`);
  assert.equal((await db.query("SELECT has_table_privilege('capiro_app','clients','DELETE') AS allowed")).rows[0].allowed,true); pass('actual Core default privileges seeded before new tables');
  await db.query(fs.readFileSync(root+'/contract-proposal/ENGAGEMENT-MIGRATION-CANDIDATE.sql','utf8')); pass('exact migration applies to native PostgreSQL');
  await db.query('INSERT INTO tenants VALUES($1),($2)',[t1,t2]);
  await db.query('INSERT INTO clients VALUES($1,$2),($3,$2),($4,$5)',[c1,t1,c2,c3,t2]);
  await populate(); await db.query('INSERT INTO engagement_plans(id,tenant_id,client_id,title,created_by_user_id) VALUES($1,$2,$3,$4,$5)',[p2,t1,c1,'Second plan',actor]);
  const defaults=(await db.query('SELECT lifecycle,version,office_references,objective_binding,reviewed_plan_version FROM engagement_plans WHERE id=$1',[p1])).rows[0];
  assert.deepEqual(defaults,{lifecycle:'draft',version:1,office_references:[],objective_binding:null,reviewed_plan_version:null}); pass('plan defaults');
  await reject('cross-tenant client FK','INSERT INTO engagement_plans(tenant_id,client_id,title,created_by_user_id) VALUES($1,$2,$3,$4)',[t2,c1,'Foreign client',actor],['23503']);
  await reject('cross-client child FK','INSERT INTO engagement_plan_waves(tenant_id,client_id,plan_id,title,position) VALUES($1,$2,$3,$4,0)',[t1,c2,p1,'Wrong parent'],['23503']);
  for(const [name,field,value] of [['blank title','title','  '],['unknown lifecycle','lifecycle','ready'],['zero version','version',0],['review newer than aggregate','reviewed_plan_version',2]]) {
    await reject(name,`UPDATE engagement_plans SET ${field}=$1 WHERE id=$2`,[value,p1]);
  }
  await reject('title storage bound','UPDATE engagement_plans SET title=$1 WHERE id=$2',['x'.repeat(201),p1],['22001']);
  const reviewValues=[1,'2001-01-01T00:00:00.000Z','2001-01-02T00:00:00.000Z',actor];
  for(let mask=1;mask<15;mask++) {
    await reject('partial review metadata '+mask,'UPDATE engagement_plans SET reviewed_plan_version=$1,reviewed_at=$2,review_due_at=$3,reviewed_by_user_id=$4 WHERE id=$5',[...reviewValues.map((value,i)=>(mask&(1<<i))?value:null),p1]);
  }
  for(const end of ['2001-01-01T00:00:00.000Z','2000-12-31T00:00:00.000Z']) {
    await reject('non-increasing review deadline '+end,'UPDATE engagement_plans SET reviewed_plan_version=$1,reviewed_at=$2,review_due_at=$3,reviewed_by_user_id=$4 WHERE id=$5',[1,reviewValues[1],end,actor,p1]);
  }
  await db.query('UPDATE engagement_plans SET reviewed_plan_version=$1,reviewed_at=$2,review_due_at=$3,reviewed_by_user_id=$4 WHERE id=$5',[...reviewValues,p1]);
  const expired=(await db.query('SELECT reviewed_plan_version,reviewed_at,review_due_at,reviewed_by_user_id FROM engagement_plans WHERE id=$1',[p1])).rows[0];
  assert.equal(expired.reviewed_plan_version,1); assert.equal(expired.reviewed_at.toISOString(),reviewValues[1]); assert.equal(expired.review_due_at.toISOString(),reviewValues[2]); assert.equal(expired.reviewed_by_user_id,actor); pass('complete expired review receipt retained without invented age cutoff');
  await db.query('UPDATE engagement_plans SET reviewed_plan_version=NULL,reviewed_at=NULL,review_due_at=NULL,reviewed_by_user_id=NULL WHERE id=$1',[p1]); pass('all-null review metadata accepted');
  const validOffice={targetId:target,officeKey:'directory:synthetic-member'};
  await db.query('UPDATE engagement_plans SET office_references=$1 WHERE id=$2',[JSON.stringify([validOffice]),p1]); pass('valid historical office snapshot');
  const malformedOffices=[null,{},[null],[{targetId:target}],[{...validOffice,extra:true}],[{...validOffice,targetId:'bad'}],[{...validOffice,officeKey:'name-only'}],[validOffice,validOffice],Array.from({length:201},(_,i)=>({targetId:`60000000-0000-4000-8000-${String(i).padStart(12,'0')}`,officeKey:'manual:synthetic'}))];
  for(let i=0;i<malformedOffices.length;i++) await reject('office snapshot shape '+i,'UPDATE engagement_plans SET office_references=$1 WHERE id=$2',[JSON.stringify(malformedOffices[i]),p1]);
  const binding={clientId:c1,objectiveId:target,objectiveVersion:1,objectiveRevisionId:revision};
  await db.query('UPDATE engagement_plans SET objective_binding=$1 WHERE id=$2',[JSON.stringify(binding),p1]); pass('exact Objective receipt snapshot without FK');
  for(const [i,value] of [null,{}, {...binding,clientId:c2},{...binding,objectiveVersion:0},{...binding,objectiveVersion:1.5},{...binding,objectiveVersion:2147483648},{...binding,extra:true}].entries()) {
    await reject('Objective binding shape '+i,'UPDATE engagement_plans SET objective_binding=$1 WHERE id=$2',[JSON.stringify(value),p1]);
  }
  await db.query('INSERT INTO engagement_plan_waves(id,tenant_id,client_id,plan_id,title,position,"window",office_target_ids) VALUES($1,$2,$3,$4,$5,0,$6,$7)',[wave,t1,c1,p1,'Dated wave',JSON.stringify({startDate:'2028-02-29',endDateExclusive:'2028-03-01',timeZone:'America/New_York'}),[target]]); pass('day precision and explicit timezone retained');
  for(const [i,value] of [null,{}, {startDate:'2026-02-30',endDateExclusive:'2026-03-03',timeZone:'UTC'},{startDate:'2026-03-02',endDateExclusive:'2026-03-01',timeZone:'UTC'},{startDate:'2026-03-01T00:00:00Z',endDateExclusive:'2026-03-03',timeZone:'UTC'},{startDate:'2026-03-01',endDateExclusive:'2026-03-03',timeZone:' '},{startDate:'2026-03-01',endDateExclusive:'2026-03-03',timeZone:'UTC',extra:true}].entries()) {
    await reject('window shape '+i,'UPDATE engagement_plan_waves SET "window"=$1 WHERE id=$2',[JSON.stringify(value),wave]);
  }
  await reject('negative position','UPDATE engagement_plan_waves SET position=-1 WHERE id=$1',[wave]);
  await reject('NULL office ID','UPDATE engagement_plan_waves SET office_target_ids=$1 WHERE id=$2',[[target,null],wave]);
  await reject('duplicate office ID','UPDATE engagement_plan_waves SET office_target_ids=$1 WHERE id=$2',[[target,target],wave]);
  await reject('office ID maximum','UPDATE engagement_plan_waves SET office_target_ids=$1 WHERE id=$2',[Array.from({length:201},(_,i)=>`60000000-0000-4000-8000-${String(i).padStart(12,'0')}`),wave]);
  await reject('office ID dimensions',`UPDATE engagement_plan_waves SET office_target_ids=ARRAY[ARRAY[$1::uuid],ARRAY[$1::uuid]] WHERE id=$2`,[target,wave]);
  await reject('office ID lower bound',`UPDATE engagement_plan_waves SET office_target_ids='[0:0]={${target}}'::uuid[] WHERE id=$1`,[wave]);
  await reject('plan parent immutable','UPDATE engagement_plans SET client_id=$1 WHERE id=$2',[c2,p1]);
  await reject('plan UUID immutable','UPDATE engagement_plans SET id=gen_random_uuid() WHERE id=$1',[p1]);
  await reject('plan creator immutable','UPDATE engagement_plans SET created_by_user_id=gen_random_uuid() WHERE id=$1',[p1]);
  await reject('wave parent immutable','UPDATE engagement_plan_waves SET plan_id=$1 WHERE id=$2',[p2,wave]);
  for(const table of ['engagement_plan_revisions','engagement_plan_command_receipts']) {
    await reject(table+' UPDATE immutable',`UPDATE ${table} SET created_at=now()`,[],['55000']);
    await reject(table+' direct DELETE immutable',`DELETE FROM ${table}`,[],['55000']);
  }
  await reject('duplicate revision version','INSERT INTO engagement_plan_revisions(tenant_id,client_id,plan_id,version,operation,actor_user_id,snapshot) VALUES($1,$2,$3,1,$4,$5,$6)',[t1,c1,p1,'edit_plan',actor,'{}'],['23505']);
  await reject('duplicate command request','INSERT INTO engagement_plan_command_receipts(tenant_id,client_id,plan_id,actor_user_id,command,request_id,request_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[t1,c1,p1,actor,'create_plan',request,'a'.repeat(64),'{}'],['23505']);
  await reject('unsupported command','INSERT INTO engagement_plan_command_receipts(tenant_id,client_id,plan_id,actor_user_id,command,request_id,request_hash,receipt) VALUES($1,$2,$3,$4,$5,gen_random_uuid(),$6,$7)',[t1,c1,p1,actor,'send_mail','a'.repeat(64),'{}']);
  await db.query('SET ROLE capiro_app');
  await db.query("SELECT set_config('app.current_tenant',$1,false)",[t2]);
  assert.equal((await db.query('SELECT count(*)::int n FROM engagement_plans')).rows[0].n,0); pass('tenant RLS hides foreign rows');
  await db.query("SELECT set_config('app.current_tenant',$1,false)",[t1]);
  assert.equal((await db.query('SELECT count(*)::int n FROM engagement_plans')).rows[0].n,2); pass('tenant RLS permits own rows');
  await reject('app role cannot delete plan','DELETE FROM engagement_plans WHERE id=$1',[p1],['42501']);
  await reject('app role cannot delete wave despite Core defaults','DELETE FROM engagement_plan_waves WHERE id=$1',[wave],['42501']);
  await reject('app role cannot rewrite receipt','UPDATE engagement_plan_command_receipts SET created_at=now()',[],['42501']);
  await db.query('RESET ROLE');
  await db.query('DELETE FROM engagement_plans'); await emptyChildren('plan FK cascade permits history cleanup');
  await populate(); await db.query('DELETE FROM clients WHERE id=$1',[c1]); await emptyChildren('client FK cascade permits history cleanup');
  await db.query('INSERT INTO clients VALUES($1,$2)',[c1,t1]); await populate();
  await db.query('DELETE FROM tenants WHERE id=$1',[t1]); await emptyChildren('tenant FK cascade permits history cleanup');
  console.log(JSON.stringify({status:'passed',checks,database:config.database,postgres:(await db.query('SHOW server_version')).rows[0].server_version,candidate:root+'/contract-proposal/ENGAGEMENT-MIGRATION-CANDIDATE.sql'}));
})().catch(e=>{ console.error(JSON.stringify({status:'failed',checks,code:e.code,message:e.message,stack:e.stack})); process.exitCode=1; }).finally(async()=>{if(db) await db.end();});
