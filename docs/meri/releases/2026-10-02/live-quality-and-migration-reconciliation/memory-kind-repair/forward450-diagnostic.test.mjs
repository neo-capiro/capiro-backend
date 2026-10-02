import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {hash,validateInput,checkLedger,checkCatalog,readState,inspectState,classifyLedger} from './forward450-diagnostic.mjs';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')}}`;
const claims=['case01ExecutionSetup','case01ExecutionSetupRecovery','case01ExecutionSetupContinuation','case01ExecutionSetupPostApproval'];
const names=['memory_candidate_source_kind_chk','memory_candidate_version_payload_check'];
const input=()=>({version:1,sourceSha:'a'.repeat(40),manifestSha256:'b'.repeat(64),migrationSha256:'c'.repeat(64),
 beforeCheckSha256:Object.fromEntries(names.map(n=>[n,'d'.repeat(64)])),afterCheckSha256:Object.fromEntries(names.map(n=>[n,'e'.repeat(64)])),
 claimSha256:Object.fromEntries(claims.map(n=>[n,'f'.repeat(64)]))});
test('exact input excludes arbitrary commands, ledger actions, and missing fixed claims',()=>{
 assert.deepEqual(validateInput(input()),input());
 for(const change of [x=>x.command='reset',x=>delete x.claimSha256.case01ExecutionSetup,x=>x.sourceSha='UNSEALED',x=>x.beforeCheckSha256.other='f'.repeat(64)]){
  const x=input();change(x);assert.throws(()=>validateInput(x));
 }
});
test('ledger checksum/identity and timestamp metadata remain exact, including actual Date values',()=>{
 const m=[{name:'one',sha256:'a'.repeat(64)},{name:'two',sha256:'b'.repeat(64)}];
 const rows=m.map(x=>({migration_name:x.name,checksum:x.sha256,finished_at:new Date(0),rolled_back_at:null}));
 const before=checkLedger(rows,m),changed=structuredClone(rows);changed[0].finished_at=new Date(1);assert.notEqual(checkLedger(changed,m),before);
 for(const change of [x=>x[1].migration_name='one',x=>x[0].checksum='bad',x=>x[0].finished_at=null,x=>x[0].rolled_back_at=new Date(),x=>x.push(x[0])]){
  const x=structuredClone(rows);change(x);assert.throws(()=>checkLedger(x,m));
 }
});
test('both catalog hashes and validated flags must match',()=>{
 const rows=names.map(n=>({name:n,validated:true,definition:'CHECK (true)'})),pins=Object.fromEntries(names.map(n=>[n,hash('CHECK (true)')]));
 checkCatalog(rows,pins);rows[1].validated=false;assert.throws(()=>checkCatalog(rows,pins));rows[1].validated=true;rows[1].definition='CHECK (false)';assert.throws(()=>checkCatalog(rows,pins));
});
test('owned PostgreSQL preflight is READ ONLY, sees real locks and preserves original metadata through postcheck',async()=>{
 const req=createRequire('C:/dev/cap-meri-mail-deadline/apps/api/package.json'),{Client}=req('pg');
 const c=JSON.parse(readFileSync('C:/dev/cap-meri-foundation-evidence/private/local-postgres.json','utf8'));
 assert.equal(c.host,'127.0.0.1');assert.equal(c.port,55433);assert.equal(c.scope,'owned local disposable test cluster; no AWS connection');
 const options={host:c.host,port:c.port,user:c.user,password:c.password,database:c.database};
 const admin=new Client(options),reader=new Client(options),blocker=new Client(options);let made=false;
 const schema='forward450_test_'+randomUUID().replaceAll('-','');assert.match(schema,/^forward450_test_[a-f0-9]{32}$/u);
 try{
  await admin.connect();
  const id=(await admin.query("SELECT current_user=$1 AS owned,host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('data_directory') AS directory",[c.user])).rows[0];
  assert.equal(id.owned,true);assert.equal(id.host,c.host);assert.equal(id.port,c.port);assert.equal(id.directory.replaceAll('\\','/'),c.dataDirectory.replaceAll('\\','/'));
  await admin.query(`CREATE SCHEMA ${schema}`);made=true;
  await admin.query(`CREATE TABLE ${schema}._prisma_migrations(id text,migration_name text,checksum text,started_at timestamptz,finished_at timestamptz,rolled_back_at timestamptz,applied_steps_count int)`);
  await admin.query(`CREATE TABLE ${schema}.memory_candidate(source_kind text, CONSTRAINT memory_candidate_source_kind_chk CHECK(source_kind IN ('old')),CONSTRAINT memory_candidate_version_payload_check CHECK(source_kind IS NOT NULL))`);
  await admin.query(`CREATE TABLE ${schema}.tenants(id uuid,slug text,settings_jsonb jsonb)`);
  const fixture={fixtureNamespace:'meri-foundation-20260928',...Object.fromEntries(claims.map(n=>[n,{status:'STARTED',ownedTest:n}]))};
  await admin.query(`INSERT INTO ${schema}.tenants VALUES($1::uuid,$2,$3::jsonb)`,['f2d6cf8f-057c-479a-8110-62fe5086d43f','meri-foundation-20260928-t1',JSON.stringify({meriFoundationFixture:fixture})]);
  const manifest=[{name:'one',sha256:'a'.repeat(64)},{name:'two',sha256:'b'.repeat(64)},{name:'zzzforward',sha256:'c'.repeat(64)}];
  for(const m of manifest.slice(0,-1))await admin.query(`INSERT INTO ${schema}._prisma_migrations VALUES($1,$1,$2,now(),now(),NULL,1)`,[m.name,m.sha256]);
  await reader.connect();await blocker.connect();
  const adapt=sql=>sql.replaceAll('public._prisma_migrations',schema+'._prisma_migrations').replaceAll('public.memory_candidate',schema+'.memory_candidate').replace('FROM tenants','FROM '+schema+'.tenants');
  const facade={query:async(sql,args)=>{
   // This actual test runs every exported preflight SQL; only its isolated schema is substituted.
   if(sql.startsWith('SELECT id,migration_name'))assert.equal((await reader.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
   return reader.query(adapt(sql),args);
  }};
  const rows=(await reader.query(`SELECT conname AS name,convalidated AS validated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='${schema}.memory_candidate'::regclass ORDER BY conname`)).rows;
  const pins=Object.fromEntries(rows.map(r=>[r.name,hash(r.definition)]));
  const q={...input(),beforeCheckSha256:pins,afterCheckSha256:pins,claimSha256:Object.fromEntries(claims.map(n=>[n,hash(canonical(fixture[n]))]))};
  const before=await readState(facade,q,manifest,false);assert.equal(before.ledger.length,2);
  const diagnostic=await inspectState(facade,q,manifest);assert.equal(diagnostic.ledger.total,2);assert.equal(diagnostic.guards.fixtureClaimsMatch,true);assert.equal(diagnostic.guards.migrationOwnsTables,true);assert.equal(diagnostic.guards.noOtherRelationLocks,true);
  await blocker.query('BEGIN');await blocker.query(`SELECT 1 FROM ${schema}.memory_candidate`);
  await assert.rejects(readState(facade,q,manifest,false));await blocker.query('ROLLBACK');
  // Synthetic local ledger only: models Prisma's new successful row, never shared history.
  await admin.query(`INSERT INTO ${schema}._prisma_migrations VALUES('zzzforward','zzzforward',$1,now(),now(),NULL,1)`,[manifest[2].sha256]);
  manifest.sort((a,b)=>a.name.localeCompare(b.name));
  const after=await readState(facade,q,manifest,true);assert.equal(after.ledger.length,3);
  assert.deepEqual(after.ledger.slice(0,-1),before.ledger);
  await admin.query(`UPDATE ${schema}._prisma_migrations SET finished_at=finished_at+interval '1 microsecond' WHERE migration_name='one'`);
  const changed=await readState(facade,q,manifest,true);
  assert.notEqual(checkLedger(changed.ledger,manifest),checkLedger(after.ledger,manifest));
 }finally{
  await blocker.query('ROLLBACK').catch(()=>{});await blocker.end().catch(()=>{});await reader.end().catch(()=>{});
  if(made)await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
 }
});

test('shared historical topology is classified without rewriting it into fresh history',()=>{
 const manifest=Array.from({length:449},(_,i)=>({name:'migration_'+String(i).padStart(3,'0'),sha256:'a'.repeat(64)}));manifest.push({name:'zz_new',sha256:'b'.repeat(64)});
 const rows=manifest.slice(0,-1).map((m,i)=>({migration_name:m.name,checksum:(i<61?'c':'a').repeat(64),finished_at:'time',rolled_back_at:null}));
 rows.push(...Array.from({length:57},(_,i)=>({migration_name:'legacy_'+i,checksum:'d'.repeat(64),finished_at:'time',rolled_back_at:null})));
 rows.push(...Array.from({length:100},(_,i)=>({migration_name:'rollback_'+i,checksum:'e'.repeat(64),finished_at:null,rolled_back_at:'time'})));
 const before=JSON.stringify(rows),r=classifyLedger(rows,manifest);assert.equal(JSON.stringify(rows),before);
 assert.equal(r.total,606);assert.equal(r.activeFinished,506);assert.equal(r.rolledBack,100);assert.equal(r.unfinished,0);assert.equal(r.apiExact,388);assert.equal(r.apiHistorical,61);assert.equal(r.outsideApiActive.length,57);assert.deepEqual(r.missingApiNames,[]);
 rows.push({migration_name:'pending',checksum:'e'.repeat(64),finished_at:null,rolled_back_at:null});assert.equal(classifyLedger(rows,manifest).unfinished,1);
});
