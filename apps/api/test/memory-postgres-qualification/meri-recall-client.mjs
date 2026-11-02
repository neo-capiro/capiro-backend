// Cross-repository test client: run the real Meri composer against the local
// Core/SQL fixture. Only authentication and the HTTPS network hop are synthetic.
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

let stdin='';
for await (const chunk of process.stdin) stdin+=chunk;
const input=JSON.parse(stdin);
if(!Number.isInteger(input.port)||input.port<1||input.port>65535||!process.env.MEMORY_MERI_SOURCE_ROOT)
  throw Error('Explicit local Core port and Meri checkout required');
const moduleAt=path=>import(pathToFileURL(resolve(process.env.MEMORY_MERI_SOURCE_ROOT,path)).href);
if(input.operation==='query_knowledge_graph') {
  // Graph source adapter qualification: execution/credential inputs are synthetic;
  // graph loading and destination authorization run against the ordinary SQL role.
  const {storedCase}=await moduleAt('apps/gateway/sources/client-knowledge-search/test/fixture.mjs');
  const {readContext}=await moduleAt('apps/gateway/sources/bill-text/test/fixture.mjs');
  const fixture=storedCase('query_knowledge_graph',{request:input.clientId?{clientId:input.clientId}:{}});
  const call=fixture.call();
  call.authority=readContext(fixture.authority);
  try {
    const resultJson=await fixture.handler({maxRequestMs:5000,fetchImpl:async(url,options)=>{
      const target=new URL(url);
      if(target.pathname!=='/api/clio/tools/query_knowledge_graph')throw Error('Unexpected graph route');
      return fetch(`http://127.0.0.1:${input.port}${target.pathname}`,options);
    }})(call);
    process.stdout.write(JSON.stringify({status:200,body:{resultJson}}));
  } catch(error) {
    process.stdout.write(JSON.stringify({status:503,body:{code:error.message}}));
  }
  process.exit(0);
}
const [{createControlReadsComposer},{createExecutionBinding},{versions}]=await Promise.all([
  moduleAt('apps/runtime/reads-composer.mjs'),
  moduleAt('apps/control/conversations/execution-boundary.mjs'),
  moduleAt('apps/control/conversations/test/store-fixture.mjs'),
]);
const binding={tenantId:input.tenantId,actorId:input.userId,
  conversationId:'43000000-0000-4000-8000-000000000001',
  runId:'43000000-0000-4000-8000-000000000002',
  attemptId:'43000000-0000-4000-8000-000000000003',
  workerId:'43000000-0000-4000-8000-000000000004',writerFence:1};
const {versions:ignored,...identity}=createExecutionBinding({binding,versions,plan:{synthetic:true},
  expiresAtMs:Date.now()+30000,runtimeSessionId:'synthetic-runtime-session-00000000001'});
const scopes=[{tenantId:input.tenantId,kind:input.clientId?'client':'private-user',
  resourceId:input.clientId??input.userId,policyRevision:'item01-rev-1'}];
const current={execution:identity,state:'running',scopes,selectedClientId:input.clientId,policyRevision:'item01-rev-1'};
const graph=input.operation==='query_knowledge_graph';
const operation={id:graph?'query_knowledge_graph':'search_memory',version:'0.2.0'},family=graph?'client-knowledge-search':'client-knowledge-memory';
const approvedReads={schemaVersion:'meri-native-general-reads/1',enabled:true,operations:[operation],
  maxExecuteMs:15000,maxRequestBytes:4096,maxResponseBytes:1048576};
const composer=await createControlReadsComposer({coreOrigin:'https://core.example.invalid',familyIds:[family],
  nativeCredentials:{async nativeCredentialFor(){return {credential:'SYNTHETIC_USER',expiresAtMs:identity.expiresAtMs};}},
  readSecret:async()=>Buffer.from('SYNTHETIC_SERVICE'),serviceSecretFile:'synthetic',now:Date.now,
  newId:()=>binding.attemptId,
  capabilityPolicy:{async forRun(){return {generalReads:true,readFamilies:[family],activeReadOperations:[operation]};}},
  fetchImpl:async(url,options)=>{
    const target=new URL(url);
    if(target.origin!=='https://core.example.invalid'||!['/api/clio/tools/search_memory','/api/clio/tools/search_memory_eligibility','/api/clio/tools/query_knowledge_graph'].includes(target.pathname))
      throw Error('Unexpected source route');
    return fetch(`http://127.0.0.1:${input.port}${target.pathname}`,options);
  },
});
if(composer.missing.length)throw Error('Meri composition incomplete');
const app=composer.createReadsRuntime({execution:{async authenticate(){return structuredClone(current);}},binding,approvedReads});
const request=(kind,body)=>new Request(`https://control.example.invalid/v1/runner/reads/${kind}`,{
  method:'POST',headers:{authorization:'Bearer SYNTHETIC_EXECUTION','content-type':'application/json'},body:JSON.stringify(body)});
const available=await app.handle(request('availability',{schemaVersion:approvedReads.schemaVersion,binding}));
if(available.status!==200)throw Error(`Availability failed: ${await available.text()}`);
const availability=await available.json();
const response=await app.handle(request('execute',{schemaVersion:approvedReads.schemaVersion,binding,operation,
  arguments:graph?(input.clientId?{clientId:input.clientId}:{}):{query:'qualification memory',clientId:input.clientId,k:3},deliveryId:'synthetic',
  installationId:availability.installation.installationId,executionCatalogSha256:availability.installation.executionCatalogSha256}));
process.stdout.write(JSON.stringify({status:response.status,body:await response.json()}));
