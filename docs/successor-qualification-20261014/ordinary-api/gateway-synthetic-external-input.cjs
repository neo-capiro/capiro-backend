'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const path=require('node:path').posix;
const vm=require('node:vm');
const ts=require('/workspace/capiro-frontend/node_modules/typescript');
const zod=require('/workspace/capiro-frontend/node_modules/zod');
const payload=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
const files=new Map(payload.sources.map(s=>[s.path,s]));
for(const s of files.values()){
 const bytes=Buffer.from(s.text);
 assert.equal(crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex'),s.gitBlob,'exact Git bytes '+s.path);
 s.bytes=bytes.length;s.sha256=crypto.createHash('sha256').update(bytes).digest('hex');
}
globalThis.fetch=()=>{throw Error('Real fetch prohibited by this fixture');};
const cache=new Map(),loaded=[];
function load(name){
 if(cache.has(name))return cache.get(name).exports;
 const src=files.get(name);assert(src,'unselected import '+name);
 const result=ts.transpileModule(src.text,{fileName:name,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},reportDiagnostics:true});
 assert.equal(result.diagnostics.filter(d=>d.category===ts.DiagnosticCategory.Error).length,0,'transpile diagnostics '+name);
 const mod={exports:{}};cache.set(name,mod);loaded.push(name);
 const req=key=>{
  if(key==='zod')return zod;
  assert(key.startsWith('.'),'unselected external import '+key);
  const resolved=path.normalize(path.join(path.dirname(name),key)).replace(/\.js$/,'');
  return load(resolved.endsWith('.ts')?resolved:resolved+'.ts');
 };
 vm.runInThisContext('(function(require,module,exports){\n'+result.outputText+'\n})',{filename:payload.frontendRef+':'+name})(req,mod,mod.exports);
 return mod.exports;
}
const base='apps/web/src/shared/capiro/';
const {handleCapiroRequest}=load(base+'gateway.ts');
const {strategiesAgentOperations,strategyChangeSet}=load(base+'operations/strategies-agents.ts');
const {readCapiroConfig}=load(base+'config.ts');
const op=strategiesAgentOperations['strategies.proposals'];
assert.equal(op.service,'strategy');assert.equal(op.method,'GET');assert.equal(op.path,'/agents/change-sets');
const registry={'strategies.proposals':op};
const syntheticEnv={STRATEGY_API_BASE_URL:'https://synthetic-owner.invalid/strategy-api/',NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:'pk_test_c3ludGhldGlj',CLERK_SECRET_KEY:'sk_test_synthetic-fixture-only'};
const config=readCapiroConfig(syntheticEnv);
assert.equal(config.authConfigured,true);assert.deepEqual(config.issues,[]);assert.equal(config.services.strategy,'https://synthetic-owner.invalid/strategy-api');
const strategyId='10000000-0000-4000-8000-000000000001';
const row={id:'10000000-0000-4000-8000-000000000002',strategyId,summary:'Synthetic owner proposal',ops:[],risk:'low',status:'proposed',strategyVersionId:'10000000-0000-4000-8000-000000000003',appliedVersionId:null,createdAt:'2026-10-14T00:00:00.000Z',appliedAt:null,approvedAt:null};
assert.equal(strategyChangeSet.safeParse(row).success,true);
const cases=[];
async function test(name,run){
 const start=Date.now();
 try{await run();cases.push({name,pass:true,elapsedMs:Date.now()-start});}
 catch(e){cases.push({name,pass:false,error:{name:e.name,message:e.message,stack:e.stack}});}
}
async function call({response=()=>Response.json([]),token=async()=> 'synthetic-trusted-token',cfg=config,input={},headers={}}={}){
 let calls=0,tokenCalls=0,outbound;
 const url=new URL('https://synthetic-frontend.invalid/api/capiro/strategies.proposals');
 url.searchParams.set('input',JSON.stringify(input));
 const request=new Request(url,{method:'GET',headers});
 const result=await handleCapiroRequest(request,'strategies.proposals',registry,cfg,async mode=>{tokenCalls++;return token(mode);},async(url,init)=>{
  calls++;outbound={url:String(url),method:init.method,headers:Object.fromEntries(new Headers(init.headers)),cache:init.cache,credentials:init.credentials,redirect:init.redirect,body:init.body??null};
  return await response(url,init);
 });
 const json=await result.json();
 return{status:result.status,json,calls,tokenCalls,outbound,headers:Object.fromEntries(result.headers)};
}
const reachable='The service could not be reached. Please retry.';
(async()=>{
 await test('empty owner array 200 accepted',async()=>{
  const r=await call();assert.equal(r.status,200);assert.deepEqual(r.json,[]);assert.equal(r.calls,1);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['referrer-policy'],'no-referrer');
 });
 await test('valid owner row 200 with exact trusted bearer prefix and query',async()=>{
  const r=await call({response:()=>Response.json([row]),input:{query:{strategyId,status:'proposed'}},headers:{Authorization:'Bearer synthetic-browser-inert', 'X-Tenant-Id':'synthetic-other-inert'}});
  assert.equal(r.status,200);assert.deepEqual(r.json,[row]);assert.equal(r.outbound.url,'https://synthetic-owner.invalid/strategy-api/agents/change-sets?strategyId='+strategyId+'&status=proposed');
  assert.equal(r.outbound.method,'GET');assert.equal(r.outbound.headers.authorization,'Bearer synthetic-trusted-token');assert.equal(r.outbound.headers['x-tenant-id'],undefined);assert.equal(r.outbound.headers.accept,'application/json');assert.equal(r.outbound.cache,'no-store');assert.equal(r.outbound.credentials,'omit');assert.equal(r.outbound.redirect,'error');assert.equal(r.outbound.body,null);
 });
 for(const [status,message] of [[401,'Your session expired. Sign in again.'],[403,'You do not have access to this operation.'],[404,'The requested action or record is unavailable from the current service.'],[500,'The service is unavailable. Please retry.'],[502,'The service is unavailable. Please retry.']]){
  await test('owner '+status+' status and message preserved',async()=>{const r=await call({response:()=>new Response('private upstream diagnostic',{status})});assert.equal(r.status,status);assert.deepEqual(r.json,{message});});
 }
 await test('schema-invalid 200 classified unexpected response 502',async()=>{
  const r=await call({response:()=>Response.json({rows:[]})});assert.equal(r.status,502);assert.deepEqual(r.json,{message:'The service returned an unexpected response.'});
 });
 await test('row-invalid 200 classified unexpected response 502',async()=>{
  const r=await call({response:()=>Response.json([{...row,status:'unsupported'}])});assert.equal(r.status,502);assert.deepEqual(r.json,{message:'The service returned an unexpected response.'});
 });
 await test('JSON-invalid 200 classified reachability 502',async()=>{
  const r=await call({response:()=>new Response('not JSON',{status:200})});assert.equal(r.status,502);assert.deepEqual(r.json,{message:reachable});
 });
 await test('fetch rejection classified reachability 502',async()=>{
  const r=await call({response:()=>{throw Error('synthetic private fetch failure');}});assert.equal(r.status,502);assert.deepEqual(r.json,{message:reachable});
 });
 await test('body read rejection classified reachability 502',async()=>{
  const r=await call({response:()=>new Response(new ReadableStream({start(c){c.error(Error('synthetic private body failure'));}}),{status:200})});assert.equal(r.status,502);assert.deepEqual(r.json,{message:reachable});
 });
 await test('missing token remains ordinary 401 without dispatch',async()=>{
  const r=await call({token:async()=>null});assert.equal(r.status,401);assert.deepEqual(r.json,{message:'Sign in to continue.'});assert.equal(r.calls,0);
 });
 await test('rejected token remains ordinary 401 without dispatch',async()=>{
  const r=await call({token:async()=>{throw Error('synthetic session failure');}});assert.equal(r.status,401);assert.deepEqual(r.json,{message:'Your session could not be verified. Sign in again.'});assert.equal(r.calls,0);
 });
 await test('missing Strategy configuration remains 503 without token or dispatch',async()=>{
  const r=await call({cfg:{...config,services:{}}});assert.equal(r.status,503);assert.deepEqual(r.json,{message:'The requested service is not configured.'});assert.equal(r.calls,0);assert.equal(r.tokenCalls,0);
 });
 await test('missing strategy-api prefix is not inserted and owner 404 preserved',async()=>{
  const cfg=readCapiroConfig({...syntheticEnv,STRATEGY_API_BASE_URL:'https://synthetic-owner.invalid/'});
  const r=await call({cfg,response:(url)=>{assert.equal(String(url),'https://synthetic-owner.invalid/agents/change-sets');return new Response(null,{status:404});}});
  assert.equal(r.status,404);assert.deepEqual(r.json,{message:'The requested action or record is unavailable from the current service.'});
 });
 await test('unrecognized tenant query rejected without dispatch',async()=>{
  const r=await call({input:{query:{tenantId:'synthetic-other-inert'}}});assert.equal(r.status,400);assert.deepEqual(r.json,{message:'The request contains invalid fields.'});assert.equal(r.calls,0);
 });
 const sourceFingerprints=payload.sources.map(({key,path,gitBlob,bytes,sha256})=>({key,path,gitBlob,bytes,sha256}));
 const receipt={frontendRef:payload.frontendRef,backendRef:payload.backendRef,node:process.version,typescript:ts.version,zod:require('/workspace/capiro-frontend/node_modules/zod/package.json').version,scope:'Exact published frontend runtime source and complete runtime import closure, real Zod schemas, synthetic trusted token and fetch only. No live HTTP/provider/customer writes, app startup, backend DI/guards/native/database execution, source/ref edits or auth-layer changes.',cases,passed:cases.filter(c=>c.pass).length,failed:cases.filter(c=>!c.pass).length,skipped:0,loadedSources:loaded,sourceFingerprints,observedSuccessPath:'https://synthetic-owner.invalid/strategy-api/agents/change-sets?strategyId='+strategyId+'&status=proposed',messages:{schemaMismatch:'The service returned an unexpected response.',thrownFetchOrJsonOrBody:reachable,owner502:'The service is unavailable. Please retry.'}};
 console.log(JSON.stringify(receipt,null,2));
 if(receipt.failed)process.exitCode=1;
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
