/** Paired source test only: real Meri composer over a disposable loopback HTTP server.
 * Current execution, user credentials and business records are synthetic. */
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root=process.env.MERI_SOURCE_ROOT,origin=process.env.MERI_TEST_CORE_ORIGIN;
if(!root||!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin??''))throw Error('paired test configuration missing');
const load=path=>import(pathToFileURL(`${root}/${path}`).href);
const [id,personalRaw]=process.argv.slice(2),personal=personalRaw==='true';
const forward=(url,options)=>fetch(`${origin}${new URL(url).pathname}`,options);
if(id!=='memory.list_own_proposals'){
 const {CASES,secondaryScene}=await load('apps/runtime/test/reads-secondary-fixture.mjs');
 const {fixture}=await load('apps/runtime/test/reads-native-fixture.mjs');
 const family=CASES.find(([,operation])=>operation===id)?.[0];assert(family);
 const scene=secondaryScene(id,{personal});scene.transport.fetchImpl=forward;
 const f=await fixture(family,id,{scene}),response=await f.execute();
 console.log(JSON.stringify({status:response.status,body:await response.json()}));
}else{
 const {createControlReadsComposer}=await load('apps/runtime/reads-composer.mjs');
 const {createExecutionBinding}=await load('apps/control/conversations/execution-boundary.mjs');
 const {versions}=await load('apps/control/conversations/test/store-fixture.mjs');
 const {uuid}=await load('apps/runtime/test/reads-native-fixture.mjs');
 const {canonicalSha256:hash}=await load('packages/contracts/validate.mjs');
 const at=Date.parse('2026-10-25T00:00:00.000Z'),binding={tenantId:uuid('b'),actorId:uuid('c'),conversationId:uuid('3'),runId:uuid('4'),attemptId:uuid('5'),workerId:uuid('6'),writerFence:1};
 const clientId=personal?null:uuid('7'),policyRevision='a'.repeat(64),scopes=[{tenantId:binding.tenantId,kind:personal?'private-user':'client',resourceId:clientId??binding.actorId,policyRevision}],records=new Map();
 const {versions:ignored,...identity}=createExecutionBinding({binding,versions,plan:{synthetic:true},expiresAtMs:at+10000,runtimeSessionId:'synthetic-runtime-session-00000000001'});
 const operation={id,version:'0.2.0'},family='memory-proposals',approvedReads={schemaVersion:'meri-native-general-reads/1',enabled:true,operations:[operation],maxExecuteMs:5000,maxRequestBytes:4096,maxResponseBytes:1048576};
 const composer=await createControlReadsComposer({coreOrigin:'https://core.example.invalid',familyIds:[family],now:()=>at,newId:()=>binding.attemptId,
  nativeCredentials:{async nativeCredentialFor(){return {credential:'SYNTHETIC_NATIVE',expiresAtMs:identity.expiresAtMs};}},readSecret:async()=>Buffer.from('SYNTHETIC_SERVICE'),serviceSecretFile:'synthetic',
  capabilityPolicy:{async forRun(){return {generalReads:true,readFamilies:[family]};}},fetchImpl:forward,
  memoryContexts:{forTask(){return {async retain({record}){records.set(hash(record.key),structuredClone(record));return JSON.stringify({decision:'retained',keySha256:hash(record.key),previousSha256:record.previousSha256,checkedAtMs:at});},async loadPrevious({key}){return JSON.stringify({record:records.get(hash(key)),checkedAtMs:at});}};}}});
 const app=composer.createReadsRuntime({execution:{async authenticate(){return {execution:identity,state:'running',scopes,selectedClientId:clientId,policyRevision};}},binding,approvedReads});
 const request=(kind,body)=>new Request(`https://control.example.invalid/v1/runner/reads/${kind}`,{method:'POST',headers:{authorization:'Bearer SYNTHETIC_EXECUTION','content-type':'application/json'},body:JSON.stringify(body)});
 const available=await app.handle(request('availability',{schemaVersion:approvedReads.schemaVersion,binding}));assert.equal(available.status,200);
 const {installation}=await available.json();
 const execute=args=>app.handle(request('execute',{schemaVersion:approvedReads.schemaVersion,binding,operation,arguments:args,deliveryId:'synthetic',installationId:installation.installationId,executionCatalogSha256:installation.executionCatalogSha256}));
 const first=await execute({}),firstBody=await first.json();let next=null;
 if(first.status===200){const response=await execute({cursor:'paired-next'});next={status:response.status,body:await response.json()};}
 console.log(JSON.stringify({status:first.status,body:firstBody,next,retained:records.size}));
}
