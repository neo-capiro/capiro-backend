const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const repo='C:/dev/main/meri-c1-20261002';
const root='C:/dev/main/outputs/meri-c2-20261003/case14-source-proof-review-v2';
const ts=require(path.join(repo,'node_modules/typescript/lib/typescript.js'));
const nativeCore=require(path.join(repo,'packages/meriv2-core/dist/index.js'));
const loaded=[];
function compile(rel, replace={}) {
 const source=fs.readFileSync(path.join(root,'evidence',rel),'utf8');
 loaded.push({path:rel,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'evidence',rel))).digest('hex')});
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const m={exports:{}};
 new Function('require','module','exports',js)(s=>Object.hasOwn(replace,s)?replace[s]:require(s),m,m.exports);
 return m.exports;
}
const helper=compile('packages/meriv2-core/src/context/memory-capture-source.ts');
const api=compile('apps/api/src/meri/meri-tool-request-control.ts',{'@capiro/meriv2-core':{...nativeCore,...helper}});
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const id=n=>`${n}`.repeat(8)+'-'+`${n}`.repeat(4)+'-4'+`${n}`.repeat(3)+'-8'+`${n}`.repeat(3)+'-'+`${n}`.repeat(12);
const secret='synthetic-independent-source-proof-secret';
const p={caseId:'14',captureRunId:id(1),tenantId:id(2),clientId:id(3),policyId:id(4),requestId:'request',traceId:'trace',turnId:id(5),actorUserId:id(6),conversationId:id(7),issuedAt:Date.now()-1000,expiresAt:Date.now()+60000,physicalMapSha256:'a'.repeat(64),fixtureVersion:'meri-live-v1-2026-09-26.1',semanticClock:{caseId:'14',captureRunId:id(1)}};
const text='Exact canonical memory.', sourceVersion='candidate:'+id(8);
const record={domain:'institutional_knowledge',recordId:id(8),provenance:{source:'memory_items',recordId:id(8),canonicalTenantId:p.tenantId,sourceVersion},payload:{sourceKind:'governed_memory',memoryItemId:id(8),clientId:p.clientId,contentStatus:'available',value:text,content:{hash:hash(text+'\0'+sourceVersion),offset:0,endOffset:text.length,totalCharacters:text.length,truncated:false,nextRead:null}}};
const input={query:'recently approved memory',clientId:p.clientId};
const requestA={callId:'actual-call-A',nonce:id(9),inputSha256:hash(JSON.stringify(input))};
const header=helper.encodeMeriMemoryCaptureRequest(p,requestA,secret);
function req(body=input,value=header,name='search_memory') {
 return Object.assign(new EventEmitter(),{headers:{[helper.MERI_MEMORY_CAPTURE_REQUEST_HEADER]:value},params:{name},body,aborted:false,res:Object.assign(new EventEmitter(),{writableEnded:false,destroyed:false})});
}
const checks=[];
const originalSecret=process.env.INTERNAL_SERVICE_SECRET;
process.env.INTERNAL_SERVICE_SECRET=secret;
async function check(name,run){await run();checks.push({name,result:'PASS'});}
(async()=>{
 await check('Actual API request-control authenticates then exposes binding only inside ALS',async()=>{
  let count=0;
  await api.withMeriToolRequestControl(req(),async()=>{count++;assert.deepEqual(api.currentMeriMemoryCaptureRequest(),requestA);const proof=helper.signMeriMemoryCaptureSources(p,[record],secret,api.currentMeriMemoryCaptureRequest());assert.equal(helper.verifyMeriMemoryCaptureSources(p,[record],proof,secret,requestA)[0].tenantId,p.tenantId);},p);
  assert.equal(count,1);assert.equal(api.currentMeriMemoryCaptureRequest(),undefined);
 });
 for(const [name,request,policy] of [['missing header',req(input,undefined),p],['body drift',req({...input,query:'different'}),p],['policy turn drift',req(),{...p,turnId:id(8)}],['malformed header',req(input,'not-json'),p],['raw caller binding JSON',req({...input,memoryCaptureRequest:requestA},undefined),p]]) {
  // Explicitly remove undefined since req default arguments intentionally have a valid default.
  if(name==='missing header'||name==='raw caller binding JSON')delete request.headers[helper.MERI_MEMORY_CAPTURE_REQUEST_HEADER];
  await check('API refuses '+name+' before dispatch',async()=>{let count=0;await assert.rejects(api.withMeriToolRequestControl(request,async()=>{count++;},policy));assert.equal(count,0);assert.equal(api.currentMeriMemoryCaptureRequest(),undefined);});
 }
 await check('Ordinary non-capture API request ignores capture header and preserves normal flow',async()=>{let count=0;await api.withMeriToolRequestControl(req(input,'malformed'),async()=>{count++;assert.equal(api.currentMeriMemoryCaptureRequest(),undefined);});assert.equal(count,1);});
 await check('Capture non-memory request does not require memory binding',async()=>{let count=0;await api.withMeriToolRequestControl(req(input,'malformed','list_memory_proposals'),async()=>{count++;assert.equal(api.currentMeriMemoryCaptureRequest(),undefined);},p);assert.equal(count,1);});
 await check('Direct signer with no request refuses proof',async()=>assert.throws(()=>helper.signMeriMemoryCaptureSources(p,[record],secret,undefined)));
 const proof=helper.signMeriMemoryCaptureSources(p,[record],secret,requestA);
 for(const [key,value] of [['callId','actual-call-B'],['nonce',id(8)],['inputSha256','b'.repeat(64)]])await check('Response rejects same-policy '+key+' replay',async()=>assert.throws(()=>helper.verifyMeriMemoryCaptureSources(p,[record],proof,secret,{...requestA,[key]:value})));
 await check('API response verification requires caller expected request',async()=>assert.throws(()=>helper.verifyMeriMemoryCaptureSources(p,[record],proof,secret,undefined)));
 await check('Missing or foreign canonical owner fails signer',async()=>{const absent=structuredClone(record);delete absent.provenance.canonicalTenantId;assert.throws(()=>helper.signMeriMemoryCaptureSources(p,[absent],secret,requestA));const foreign=structuredClone(record);foreign.provenance.canonicalTenantId=id(9);assert.throws(()=>helper.signMeriMemoryCaptureSources(p,[foreign],secret,requestA));});
 await check('Partial page has false fullRead and passage-specific hash',async()=>{const part=structuredClone(record);part.payload.content.totalCharacters+=20;part.payload.content.truncated=true;part.payload.content.nextRead={contentCursor:'next'};const signed=helper.signMeriMemoryCaptureSources(p,[part],secret,requestA);const got=helper.verifyMeriMemoryCaptureSources(p,[part],signed,secret,requestA)[0];assert.equal(got.fullRead,false);assert.equal(got.passageSha256,hash(text));});
 await check('Canonical null client remains null rather than inferred from policy',async()=>{const global=structuredClone(record);global.payload.clientId=null;assert.equal(helper.signMeriMemoryCaptureSources(p,[global],secret,requestA).sources[0].clientId,null);});
 const result={finishedAt:new Date().toISOString(),result:'PASS',scope:'Offline frozen-source API request-control and core proof checks; no live API/database/provider/capture; real EventEmitter/ALS and crypto, native core cancellation helper',checks,loaded};
 fs.writeFileSync(path.join(root,'independent-request-control-checks.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({result:result.result,checks:checks.length}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{if(originalSecret===undefined)delete process.env.INTERNAL_SERVICE_SECRET;else process.env.INTERNAL_SERVICE_SECRET=originalSecret;});
