'use strict';
// Owned local PostgreSQL only. Full fresh replay and a copy of the already
// qualified 449-migration local database. No cloud or shared-database access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const crypto=require('node:crypto'),cp=require('node:child_process');
const {createRequire}=require('node:module');
const repo='C:/dev/cap-meri-fixture-hardening';
const root='C:/dev/cap-meri-foundation-evidence/oct02-memory-kind-repair';
const baseline='C:/dev/cap-meri-foundation-evidence/file01-parallel-20260930';
const privateRoot='C:/dev/cap-meri-foundation-evidence/private';
const expectedData=baseline+'/local-pgvector/runtime-data';
const source=process.argv[2],mode=process.argv[3];
assert.match(source??'',/^[a-f0-9]{40}$/);
assert.ok(['fresh','upgrade'].includes(mode));
const database=mode==='fresh'?'meri_kind_fresh_20261002':'meri_kind_upgrade_20261002';
const attempt='forward-'+mode+'-'+source.slice(0,12);
const output=path.join(root,attempt+'.json');
assert.ok(!fs.existsSync(output));
const loadApi=createRequire(path.join(repo,'apps/api/package.json'));
const {Client}=loadApi('pg');
const norm=p=>fs.realpathSync.native(p).replaceAll('\\','/').toLowerCase();
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function git(...args){return cp.execFileSync('git',args,{cwd:repo,encoding:'utf8',windowsHide:true});}
const result={kind:'meri-memory-version-forward-migration-rehearsal',sourceSha:source,mode,
  startedAt:new Date().toISOString(),scope:'owned local loopback database only',
  sharedDatabaseTouched:false,manualMigrationLedgerEdits:false,database};
let admin,app,cfg;
async function history(client,expected){
 const rows=(await client.query('SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations ORDER BY migration_name')).rows;
 assert.equal(rows.length,expected.length);
 assert.deepEqual(rows.map(row=>row.migration_name),expected.map(item=>item.name));
 for(const row of rows){assert.equal(row.finished,true);assert.equal(row.rolled_back,false);assert.equal(expected.find(x=>x.name===row.migration_name)?.sha256,row.checksum);}
 return {count:rows.length,exactSourceChecksums:true,unfinished:0,unexpected:0};
}
(async()=>{
 assert.equal(git('rev-parse','HEAD').trim(),source);
 assert.equal(git('status','--porcelain=v1','--untracked-files=all').trim(),'');
 const files=fs.readdirSync(path.join(repo,'apps/api/prisma/migrations')).filter(n=>fs.existsSync(path.join(repo,'apps/api/prisma/migrations',n,'migration.sql'))).sort();
 assert.equal(files.length,450);assert.equal(files.at(-1),'20281005010000_memory_version_candidate_source_kinds');
 const expected=files.map(name=>({name,sha256:sha(fs.readFileSync(path.join(repo,'apps/api/prisma/migrations',name,'migration.sql')))}));
 result.migrationManifestSha256=sha(JSON.stringify(expected));result.newMigration=expected.at(-1);
 for(const item of expected){const sql=cp.execFileSync('git',['show',source+':apps/api/prisma/migrations/'+item.name+'/migration.sql'],{cwd:repo,windowsHide:true});assert.equal(sha(sql),item.sha256);}
 cfg=JSON.parse(fs.readFileSync(path.join(privateRoot,'local-pgvector-runtime.json'),'utf8'));
 assert.equal(cfg.scope,'owned isolated local File01 runtime; no AWS connection');
 assert.equal(cfg.host,'127.0.0.1');assert.equal(cfg.port,55435);assert.equal(norm(cfg.dataDirectory),norm(expectedData));
 const options=name=>({host:cfg.host,port:cfg.port,user:cfg.user,password:cfg.password,database:name,connectionTimeoutMillis:3000,statement_timeout:15000});
 admin=new Client(options('postgres'));await admin.connect();
 const identity=(await admin.query("SELECT current_user,host(inet_server_addr()) AS address,inet_server_port() AS port,current_setting('data_directory') AS directory")).rows[0];
 assert.equal(identity.current_user,cfg.user);assert.equal(identity.address,cfg.host);assert.equal(identity.port,cfg.port);assert.equal(norm(identity.directory),norm(expectedData));result.identityVerified=true;
 assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount,0);
 if(mode==='upgrade'){
   const oldReceipt=JSON.parse(fs.readFileSync(path.join(baseline,'local-full-migration-replay-attempt2.json'),'utf8'));
   assert.equal(oldReceipt.exitCode,0);assert.equal(oldReceipt.appliedCount,449);assert.equal(oldReceipt.expectedCount,449);
   assert.equal(sha(fs.readFileSync(path.join(baseline,'local-full-migration-replay-attempt2.log'))),oldReceipt.migrationLogSha256);
   app=new Client(options('capiro'));await app.connect();
   result.baselineHistory=await history(app,expected.slice(0,-1));await app.end();app=undefined;
   assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname='capiro'")).rows[0].n,0);
   await admin.query(`CREATE DATABASE "${database}" TEMPLATE "capiro"`);
   result.baselineReceiptSha256=sha(fs.readFileSync(path.join(baseline,'local-full-migration-replay-attempt2.json')));
 }else await admin.query(`CREATE DATABASE "${database}"`);
 result.databaseCreated=true;
 app=new Client(options(database));await app.connect();
 if(mode==='fresh'){
   result.prerequisites=[];
   for(const relative of ['scripts/ci/disposable-capiro-worker-prerequisite.sql','scripts/ci/research-portfolio-append-only-prerequisite.sql']){
     const sql=fs.readFileSync(path.join(repo,relative));await app.query(sql.toString('utf8'));result.prerequisites.push({file:relative,sha256:sha(sql)});
   }
 }
 await app.end();app=undefined;
 const url=`postgresql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@127.0.0.1:55435/${database}?schema=public`;
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(PG|DATABASE_URL|DIRECT_URL|AWS|CLERK|OPENAI|OPENROUTER|ANTHROPIC)/i.test(k)));
 Object.assign(env,{DATABASE_URL:url,PRISMA_HIDE_UPDATE_MESSAGE:'1',CHECKPOINT_DISABLE:'1',NODE_OPTIONS:'--max-old-space-size=4096'});
 result.stage='prisma migrate deploy';
 const run=cp.spawnSync(process.execPath,[loadApi.resolve('prisma'),'migrate','deploy','--schema','prisma/schema.prisma'],{cwd:path.join(repo,'apps/api'),env,windowsHide:true,encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024});
 const log=`${run.stdout??''}${run.stderr??''}`.replaceAll(cfg.password,'[REDACTED]').replaceAll(url,'[OWNED_LOCAL_DATABASE]');
 fs.writeFileSync(path.join(root,attempt+'.log'),log,{flag:'wx'});result.migrationExitCode=run.status;result.logSha256=sha(log);
 assert.equal(run.status,0);assert.equal(run.error,undefined);assert.ok(log.includes('All migrations have been successfully applied.'));
 app=new Client(options(database));await app.connect();result.history=await history(app,expected);
 result.constraints=(await app.query("SELECT conname AS name,convalidated AS validated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='memory_candidate'::regclass AND conname IN ('memory_candidate_source_kind_chk','memory_candidate_version_payload_check') ORDER BY conname")).rows;
 assert.equal(result.constraints.length,2);assert.ok(result.constraints.every(x=>x.validated));
 assert.match(result.constraints[0].definition,/memory_correction/);assert.match(result.constraints[0].definition,/memory_restore/);assert.match(result.constraints[0].definition,/memory_contradiction/);assert.match(result.constraints[1].definition,/IS TRUE/);
 result.retiredTablesAbsent=(await app.query("SELECT to_regclass('public.meri_agent_runs') IS NULL AND to_regclass('public.legiwatch_saved_view') IS NULL AS absent")).rows[0].absent;assert.equal(result.retiredTablesAbsent,true);
 result.stage='complete';result.exitCode=0;
})().catch(error=>{result.exitCode=1;result.errorClass=error?.constructor?.name??'unknown';result.code=/^[A-Z0-9_]{3,40}$/.test(error?.code??'')?error.code:'REHEARSAL_ASSERTION';process.exitCode=1;}).finally(async()=>{
 if(app)await app.end().catch(()=>{});if(admin)await admin.end().catch(()=>{});
 result.completedAt=new Date().toISOString();fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
});
