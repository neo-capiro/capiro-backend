// Synthetic compiled API seam only; run in the final image with --network none.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const core = require('@capiro/meriv2-core');
const { MeriToolsService } = require('./dist/meri/meri-tools.service.js');
const { withMeriToolRequestControl } = require('./dist/meri/meri-tool-request-control.js');
const sha = value => createHash('sha256').update(value).digest('hex');
const secret = 'offline-c2-memory-source-proof-secret';
process.env.INTERNAL_SERVICE_SECRET = secret;
const tenantId = randomUUID(), userId = randomUUID(), clientId = randomUUID(), memoryItemId = randomUUID();
const ctx = {tenantId,userId};
const text = 'Approved Aster offline source.', sourceVersion = 'candidate:'+randomUUID();
const record = {domain:'institutional_knowledge',recordId:memoryItemId,
  provenance:{source:'memory_items',recordId:memoryItemId,canonicalTenantId:tenantId,sourceVersion},
  payload:{clientId,sourceKind:'governed_memory',memoryItemId,value:text,contentStatus:'available',title:'Approved source'}};
const source = {domain:'institutional_knowledge',sourceStatus:'healthy',hasMore:false,truncated:false,paginationComplete:true,coverageComplete:true,nextCursor:null};
const tool = Object.create(MeriToolsService.prototype);
tool.contextPlane = {searchToolData:async()=>({records:[record],coverage:{complete:true,paginationComplete:true,sources:[source]}})};
const input = {query:'approved source',clientId,memoryItemId};
function request(header) {
  const req = new EventEmitter();req.params={name:'search_memory'};req.body=input;
  req.headers=header?{[core.MERI_MEMORY_CAPTURE_REQUEST_HEADER]:header}:{};
  req.res=new EventEmitter();req.res.writableEnded=true;return req;
}
(async()=>{
  for(const caseId of ['01','14']) {
    const issuedAt=Date.now(),captureRunId=randomUUID();
    const policy={caseId,captureRunId,tenantId,actorUserId:userId,clientId,policyId:randomUUID(),requestId:randomUUID(),traceId:randomUUID(),turnId:randomUUID(),conversationId:randomUUID(),issuedAt,expiresAt:issuedAt+60000,physicalMapSha256:'a'.repeat(64),fixtureVersion:'meri-live-v1-2026-09-26.1',
      semanticClock:{version:1,kind:'qualified_original_fixture_semantic_clock',instant:'2026-09-26T16:00:00.000Z',timeZone:'America/New_York',caseId,captureRunId,currentVerifySha256:'b'.repeat(64),observedAt:issuedAt}};
    const binding={callId:'offline-'+caseId,nonce:randomUUID(),inputSha256:sha(JSON.stringify(input))};
    const header=core.encodeMeriMemoryCaptureRequest(policy,binding,secret);
    const result=await withMeriToolRequestControl(request(header),()=>tool.searchMemory(ctx,input),policy);
    const verified=core.verifyMeriMemoryCaptureSources(policy,result.records,result.memoryCaptureSources,secret,binding);
    assert.equal(verified.length,1);assert.equal(verified[0].tenantId,tenantId);assert.equal(verified[0].clientId,clientId);
    assert.equal(verified[0].fullRead,true);assert.equal(verified[0].passageSha256,sha(text));
    assert.throws(()=>core.verifyMeriMemoryCaptureSources(policy,result.records,result.memoryCaptureSources,secret,{...binding,nonce:randomUUID()}));
    assert.throws(()=>core.decodeMeriMemoryCaptureRequest(policy,header,{...input,query:'changed'},secret));
    const actualOwner=record.provenance.canonicalTenantId;record.provenance.canonicalTenantId=randomUUID();
    await assert.rejects(()=>withMeriToolRequestControl(request(header),()=>tool.searchMemory(ctx,input),policy));
    record.provenance.canonicalTenantId=actualOwner;
  }
  const ordinary=await tool.searchMemory(ctx,input);
  assert.equal(Object.hasOwn(ordinary,'memoryCaptureSources'),false);
  assert.equal(Object.hasOwn(ordinary.records[0].provenance,'canonicalTenantId'),false);
  console.log('OFFLINE_PACKAGED_C2_CANONICAL_MEMORY_SOURCE_PASS');
})().catch(error=>{console.error(error);process.exitCode=1;});

