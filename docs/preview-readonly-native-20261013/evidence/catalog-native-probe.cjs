'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const assert=require('node:assert/strict');
const Module=require('node:module');const cp=require('node:child_process');
const root=path.resolve(__dirname,'../../..');const e=__dirname;
const source='111f269d749cae0249c2141779bd6d7deb93f45c';
const engine='/tmp/capirov2-local-native-prerequisite-20261012/core-client/libquery_engine-debian-openssl-3.0.x.so.node';
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(engine)).digest('hex'),'35860a5c0fb2f79e7b38c40747c4d212318d97e1910ca528b133c802716de0b8');
const schema='/tmp/capirov2-local-native-prerequisite-20261012/core-client/schema.prisma';
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(schema)).digest('hex'),'215556bd82b97f0be84d7f97da7f19a5a25bace97dc54b1a550cab2039a740fb');
const actual=cp.execFileSync('git',['show',source+':apps/api/src/prisma/prisma.service.ts']);
assert(actual.equals(fs.readFileSync(path.join(root,'apps/api/src/prisma/prisma.service.ts'))));
const ts=require('/workspace/capirov2/node_modules/typescript');
const prior=Module._extensions['.ts'];
Module._extensions['.ts']=(mod,file)=>{
 if(!file.startsWith(root+'/apps/api/src/'))throw Error('Unbounded source import refused');
 mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true,emitDecoratorMetadata:true,esModuleInterop:true}}).outputText,file);
};
const resolve=Module._resolveFilename;
Module._resolveFilename=function(specifier,parent,...args){
 if(specifier.endsWith('.js')&&specifier.startsWith('.')){
  const candidate=path.resolve(path.dirname(parent.filename),specifier.slice(0,-3)+'.ts');
  if(candidate.startsWith(root+'/apps/api/src/')&&fs.existsSync(candidate))return candidate;
 }
 return resolve.call(this,specifier,parent,...args);
};
// JavaScript networking is bounded; strace separately records native connects.
const net=require('node:net');const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const x=Array.isArray(args[0])?args[0][0]:args[0];const o=typeof x==='object'?x:{port:x,host:args[1]};if(o.host!=='127.0.0.1'||Number(o.port)!==5432)throw Error('Network outside local native fixture refused');return connect.apply(this,args);};
global.fetch=()=>{throw Error('Provider access refused');};
const {PrismaService}=require(path.join(root,'apps/api/src/prisma/prisma.service.ts'));
const init=fs.readFileSync('/workspace/cloud-onboarding/postgres-init/01-extensions.sql','utf8');
const match=init.match(/CREATE ROLE\s+capiro_app[\s\S]*?PASSWORD\s+'([^']+)'/i);if(!match)throw Error('Existing local fixture auth unavailable');
const target=(role,password)=>`postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:5432/postgres?connection_limit=1`;
// The owner password is the documented local compose fixture, never production.
const reader=new PrismaService({log:[{level:'query',emit:'event'}],datasources:{db:{url:target('capiro_app',match[1])}}});
const owner=new PrismaService({log:[{level:'query',emit:'event'}],datasources:{db:{url:target('capiro','capiro')}}});
const rows=[];const queryEvents=[];
reader.$on('query',event=>queryEvents.push({client:'reader',query:event.query}));
owner.$on('query',event=>queryEvents.push({client:'owner',query:event.query}));
async function check(name,fn){await fn();rows.push({name,result:'PASS'});}
async function main(){
 await reader.$connect();await owner.$connect();
 const info=await reader.$queryRaw`SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port, current_setting('server_version') AS version`;
 assert.equal(info[0].database,'postgres');assert.equal(info[0].port,5432);assert.match(info[0].version,/^16\.15 /);
 const tenant='11111111-1111-4111-8111-111111111111';
 await check('existing reader with default writable session is refused before callback',async()=>{let entered=false;await assert.rejects(reader.withPreviewReadOnly(tenant,async()=>{entered=true;}),/reviewed read-only database role/);assert.equal(entered,false);});
 // Session-local settings only, no ALTER ROLE/database/security configuration.
 await reader.$executeRaw`SET default_transaction_read_only = on`;
 await owner.$executeRaw`SET default_transaction_read_only = on`;
 await check('existing owner/superuser remains refused even with default read-only',async()=>{let entered=false;await assert.rejects(owner.withPreviewReadOnly(tenant,async()=>{entered=true;}),/reviewed read-only database role/);assert.equal(entered,false);});
 await check('actual PostgreSQL read-only transaction admits catalog-only reader',async()=>{
  const info=await reader.withPreviewReadOnly(tenant,async(tx)=>tx.$queryRaw`SELECT current_user AS role, current_setting('transaction_read_only') AS transaction_read_only, current_setting('default_transaction_read_only') AS default_read_only, current_setting('app.current_tenant') AS tenant, current_setting('app.bypass_rls') AS bypass, pg_backend_pid() AS pid`);
  assert.equal(info[0].role,'capiro_app');assert.equal(info[0].transaction_read_only,'on');assert.equal(info[0].default_read_only,'on');assert.equal(info[0].tenant,tenant);assert.equal(info[0].bypass,'off');
 });
 await check('canonical withTenant uses the same native backend transaction',async()=>reader.withPreviewReadOnly(tenant,async(tx)=>{
  const first=await tx.$queryRaw`SELECT pg_backend_pid() AS pid, txid_current_if_assigned() AS xid`;
  const next=await reader.withTenant(tenant,inner=>inner.$queryRaw`SELECT pg_backend_pid() AS pid, txid_current_if_assigned() AS xid`);
  assert.deepEqual(first,next);
  await assert.rejects(reader.withTenant('33333333-3333-4333-8333-333333333333',async()=>undefined),/tenant mismatch/);
  await assert.rejects(reader.withSystem(async()=>undefined),/cannot open/);
 }));
 await check('commit removes tenant and bypass transaction GUCs',async()=>{const x=await reader.$queryRaw`SELECT nullif(current_setting('app.current_tenant',true),'') AS tenant, nullif(current_setting('app.bypass_rls',true),'') AS bypass`;assert.equal(x[0].tenant,null);assert.equal(x[0].bypass,null);});
 await check('callback failure rolls back and clears transaction GUCs',async()=>{await assert.rejects(reader.withPreviewReadOnly(tenant,async()=>{throw Error('synthetic rollback');}),/synthetic rollback/);const x=await reader.$queryRaw`SELECT nullif(current_setting('app.current_tenant',true),'') AS tenant`;assert.equal(x[0].tenant,null);});
 await reader.$executeRaw`SET default_transaction_read_only = off`;await owner.$executeRaw`SET default_transaction_read_only = off`;
 const transactions=[];
 for(let i=0;i<queryEvents.length;i++)if(queryEvents[i].query==='BEGIN'){
  const client=queryEvents[i].client;const steps=[];
  for(let j=i+1;j<queryEvents.length;j++){if(queryEvents[j].client!==client)continue;steps.push(queryEvents[j].query);if(['COMMIT','ROLLBACK'].includes(queryEvents[j].query))break;}
  const first=steps.find(query=>!query.startsWith('SET TRANSACTION ISOLATION LEVEL'));
  assert.equal(first,'SET TRANSACTION READ ONLY');transactions.push({client,firstUserStatement:first,completion:steps.at(-1)});
 }
 assert.equal(transactions.length,5);
 fs.writeFileSync(path.join(e,'catalog-native-query-events.json'),JSON.stringify({events:queryEvents,transactions,parameters_not_recorded:true},null,2)+'\n');
 fs.writeFileSync(path.join(e,'catalog-native-results.json'),JSON.stringify({source,engine_sha256:'35860a5c0fb2f79e7b38c40747c4d212318d97e1910ca528b133c802716de0b8',schema_sha256:'215556bd82b97f0be84d7f97da7f19a5a25bace97dc54b1a550cab2039a740fb',target:'existing authorized local capiro-postgres catalog only',database:'postgres',control_count:rows.length,controls:rows,objects_created:0,fixture_or_business_data_read:false,roles_grants_credentials_or_persistent_settings_changed:false,limits:['data volume zero writable bytes blocks owned fixture database','native client RLS and identity positive proof remain blocked','catalog-only read role proof does not qualify dedicated production reader grants']},null,2)+'\n');
 console.log(JSON.stringify({result:'PASS',controls:rows.length,objects_created:0,roles_or_grants_changed:false}));
}
main().catch(error=>{fs.writeFileSync(path.join(e,'catalog-native-failure.json'),JSON.stringify({result:'FAIL',name:error.name,code:error.code??null,message:'native catalog probe failed; no connection inputs emitted',passed_controls:rows},null,2)+'\n');console.error('Native catalog probe failed');process.exitCode=1;}).finally(async()=>{await Promise.allSettled([reader.$disconnect(),owner.$disconnect()]);Module._extensions['.ts']=prior;Module._resolveFilename=resolve;});
